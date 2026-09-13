/**
 * Assembles the interpreter request from snapshot histories, ledger state and config.
 *
 * Everything here is code-computed: the model receives values and their display strings, never a
 * formula to re-run. Bounds come from the risk engine (stops.stopDistance for the maximum stop
 * distance, one tick for the minimum) so the model proposes inside limits that the clamp enforces
 * again afterwards.
 */
import { INSTRUMENT_ROOTS, modelConfig, type InstrumentRoot, type ModelConfig } from "../config/modelConfig";
import type { Campaign, LedgerState } from "../campaign/types";
import type { SignalSnapshot } from "../formula/types";
import { EM_DASH, fmtMoney, fmtNum, fmtPoints, fmtPrice, fmtTime, sideText } from "../ui/format";
import { stopDistance } from "../stops/stops";
import {
  DEFAULT_INTERPRETER_CONFIG,
  type CallKind,
  type Digest,
  type InterpreterConfig,
  type InterpreterMode,
  type InterpreterRequest,
  type Lesson,
  type MarketBarView,
  type MarketRequestView,
  type PositionStateView,
  type ProposalAction,
  type ProposalOutcome,
  type RequestBounds,
} from "./types";

/** Minimum stop distance: one tick of the instrument's grid. */
export const MIN_STOP_TICKS = 1;

const DECISION_ACTIONS: readonly ProposalAction[] = ["enter", "wait", "hold", "tighten", "exit"];
const OBSERVATION_ACTIONS: readonly ProposalAction[] = ["hold", "tighten", "exit"];

export interface BuildRequestInput {
  callKind: CallKind;
  mode: InterpreterMode;
  /** Oldest-first completed snapshots per root; trimmed to the last nBars here. */
  histories: Partial<Record<InstrumentRoot, readonly SignalSnapshot[]>>;
  ledger: LedgerState;
  cfg?: ModelConfig;
  interpreter?: InterpreterConfig;
  /** Bar end this request belongs to; defaults to the newest bar in the histories. */
  barEnd?: string;
  /** Past proposal outcomes, newest last; trimmed to feedbackK. */
  feedback?: readonly ProposalOutcome[];
  /** Lessons, newest last; trimmed to lessonsN. */
  lessons?: readonly Lesson[];
  digest?: Digest | null;
  memoryEpochId?: string | null;
  /** Display extras the risk engine already computed; never recomputed here. */
  positionExtras?: { flags?: readonly string[]; rMultiple?: number | null };
}

function lastOf<T>(list: readonly T[]): T | null {
  return list.length > 0 ? list[list.length - 1]! : null;
}

function barView(s: SignalSnapshot): MarketBarView {
  const root = s.root;
  return {
    barEnd: s.barEnd,
    barEndText: fmtTime(s.barEnd),
    availableAt: s.availableAt,
    status: s.status,
    displaySide: s.displaySide,
    dataSource: { kind: s.dataSource.kind, label: s.dataSource.label },
    interval: s.interval,
    modelVersion: s.modelVersion,
    statistics: {
      Q: s.Q,
      A: s.A,
      H: s.H,
      u: s.u,
      deltaU: s.deltaU,
      deltaH: s.deltaH,
      sigmaDeltaU: s.sigmaDeltaU,
      sigmaDeltaH: s.sigmaDeltaH,
      v: s.v,
      p: { long: s.p.long, short: s.p.short },
      S: { long: s.S.long, short: s.S.short },
      displayScore: s.displayScore,
    },
    text: {
      Q: fmtNum(s.Q),
      A: fmtNum(s.A),
      H: fmtNum(s.H),
      u: fmtNum(s.u),
      deltaU: fmtNum(s.deltaU, 4),
      deltaH: fmtNum(s.deltaH, 4),
      v: fmtNum(s.v),
      pLong: fmtNum(s.p.long),
      pShort: fmtNum(s.p.short),
      sLong: fmtNum(s.S.long),
      sShort: fmtNum(s.S.short),
      displayScore: fmtNum(s.displayScore),
    },
    prices: {
      closeTicks: s.raw.closeT,
      closeText: fmtPrice(s.raw.closeT, root),
      closePrevTicks: s.raw.closePrev,
      closePrevText: fmtPrice(s.raw.closePrev, root),
      atr20Ticks: s.raw.atr20Ticks,
      atr20Text: s.raw.atr20Ticks === null ? EM_DASH : fmtPoints(s.raw.atr20Ticks, root),
    },
    qualification: {
      long: { S: s.eligibility.long.S, qualifies: s.eligibility.long.qualifies, failed: [...s.eligibility.long.failed] },
      short: { S: s.eligibility.short.S, qualifies: s.eligibility.short.qualifies, failed: [...s.eligibility.short.failed] },
    },
    unavailableReasons: s.dataQuality.reasons.map((r) => ({ code: r.code, detail: r.detail })),
    warnings: s.dataQuality.warnings.map((w) => ({ code: w.code, detail: w.detail })),
    inputSourceIds: [...s.inputSourceIds],
  };
}

function positionView(
  mode: InterpreterMode,
  ledger: LedgerState,
  campaign: Campaign | null,
  extras: BuildRequestInput["positionExtras"],
): PositionStateView {
  const flags = [...(extras?.flags ?? [])];
  const rMultiple = extras?.rMultiple ?? null;
  if (!campaign) {
    return {
      mode,
      hasPosition: false,
      campaignId: null,
      root: null,
      side: null,
      sideText: EM_DASH,
      state: null,
      contractsRemaining: null,
      averageEntryTicks: null,
      averageEntryText: EM_DASH,
      proposedStopTicks: null,
      proposedStopText: EM_DASH,
      recordedStopTicks: null,
      recordedStopText: EM_DASH,
      stopDiscrepancyTicks: null,
      extremeCloseTicks: null,
      extremeCloseText: EM_DASH,
      markTicks: null,
      markText: EM_DASH,
      markObservedAt: null,
      barsHeld: null,
      flags,
      rMultiple,
      rMultipleText: rMultiple === null ? EM_DASH : `${fmtNum(rMultiple)} R`,
      originalRiskMils: null,
      originalRiskText: EM_DASH,
      stopFrozenReason: null,
    };
  }
  const root = campaign.root;
  const averageEntryTicks = campaign.entryQuantity > 0 ? campaign.entryBasisTicksQty / campaign.entryQuantity : null;
  const proposed = campaign.proposedStop?.stop ?? campaign.restingStop?.stop ?? null;
  const recorded = campaign.mode === "manual" ? (campaign.brokerStop?.price ?? null) : (campaign.restingStop?.stop ?? null);
  const mark = ledger.marks[root] ?? null;
  return {
    mode,
    hasPosition: true,
    campaignId: campaign.id,
    root,
    side: campaign.side,
    sideText: sideText(campaign.side),
    state: campaign.state,
    contractsRemaining: campaign.remaining,
    averageEntryTicks,
    averageEntryText: averageEntryTicks === null ? EM_DASH : fmtPrice(averageEntryTicks, root),
    proposedStopTicks: proposed,
    proposedStopText: fmtPrice(proposed, root),
    recordedStopTicks: recorded,
    recordedStopText: fmtPrice(recorded, root),
    stopDiscrepancyTicks: proposed !== null && recorded !== null ? recorded - proposed : null,
    extremeCloseTicks: campaign.extremeClose,
    extremeCloseText: fmtPrice(campaign.extremeClose, root),
    markTicks: mark ? mark.price : null,
    markText: mark ? fmtPrice(mark.price, root) : EM_DASH,
    markObservedAt: mark ? mark.observedAt : null,
    barsHeld: campaign.exposureBars,
    flags,
    rMultiple,
    rMultipleText: rMultiple === null ? EM_DASH : `${fmtNum(rMultiple)} R`,
    originalRiskMils: campaign.originalRiskMils,
    originalRiskText: campaign.originalRiskMils === null ? EM_DASH : fmtMoney(campaign.originalRiskMils),
    stopFrozenReason: campaign.stopFrozenReason ? `${campaign.stopFrozenReason.code}: ${campaign.stopFrozenReason.detail}` : null,
  };
}

function buildBounds(
  callKind: CallKind,
  markets: MarketRequestView[],
  latest: Map<InstrumentRoot, SignalSnapshot>,
  ledger: LedgerState,
  cfg: ModelConfig,
  interp: InterpreterConfig,
): RequestBounds {
  const maxDTicks: RequestBounds["maxDTicks"] = {};
  for (const m of markets) {
    const s = latest.get(m.root);
    if (!s) continue;
    const long = stopDistance(s.raw.atr20Ticks, s.H, 1, cfg);
    const short = stopDistance(s.raw.atr20Ticks, s.H, -1, cfg);
    maxDTicks[m.root] = { long: long.ok ? long.value.dTicks : null, short: short.ok ? short.value.dTicks : null };
  }

  // Candidate policy (Decision 2): discretion widens the set to every available market.
  const available = markets.filter((m) => latest.get(m.root)?.dataQuality.available === true);
  let candidates: InstrumentRoot[];
  if (interp.mayEnterBelowThreshold) {
    candidates = available
      .filter((m) => {
        if (interp.candidateFloor === null) return true;
        const score = latest.get(m.root)?.displayScore ?? null;
        return score !== null && score >= interp.candidateFloor;
      })
      .map((m) => m.root);
  } else {
    candidates = available.filter((m) => latest.get(m.root)?.status === "QUALIFIED").map((m) => m.root);
  }

  const blockers: string[] = [];
  if (callKind === "observation") blockers.push("observation calls may only hold, tighten or exit");
  if (ledger.paused) blockers.push("the engine is paused");
  if (ledger.activeCampaignId !== null) blockers.push(`campaign ${ledger.activeCampaignId} is already active (one position per mode)`);
  if (available.length === 0) blockers.push("no market has a valid, fresh snapshot at this bar");
  else if (candidates.length === 0) blockers.push("no market is in the candidate set under the current policy");

  const entriesPermitted = blockers.length === 0;
  return {
    allowedCandidates: entriesPermitted ? candidates : [],
    maxDTicks,
    minTicks: MIN_STOP_TICKS,
    entriesPermitted,
    reason: entriesPermitted
      ? `entries permitted; candidates: ${candidates.join(", ")}`
      : `entries not permitted: ${blockers.join("; ")}`,
    candidatePolicy: { mayEnterBelowThreshold: interp.mayEnterBelowThreshold, candidateFloor: interp.candidateFloor },
  };
}

/** Build one interpreter request. Pure: no clock, no network, no ledger writes. */
export function buildRequest(input: BuildRequestInput): InterpreterRequest {
  const cfg = input.cfg ?? modelConfig;
  const interp = input.interpreter ?? DEFAULT_INTERPRETER_CONFIG;
  const nBars = Math.max(1, Math.floor(interp.nBars));

  const markets: MarketRequestView[] = [];
  const latest = new Map<InstrumentRoot, SignalSnapshot>();
  for (const root of INSTRUMENT_ROOTS) {
    const history = input.histories[root];
    if (!history || history.length === 0) continue;
    const window = history.slice(-nBars);
    const newest = lastOf(window)!;
    latest.set(root, newest);
    markets.push({ root, bars: window.map(barView), latestStatus: newest.status });
  }

  const campaign = input.ledger.activeCampaignId ? (input.ledger.campaigns[input.ledger.activeCampaignId] ?? null) : null;
  const newestBarEnd = markets.reduce<string | null>((acc, m) => {
    const b = lastOf(m.bars);
    if (!b) return acc;
    return acc === null || b.barEnd > acc ? b.barEnd : acc;
  }, null);

  const dataKinds = new Set<string>();
  for (const s of latest.values()) dataKinds.add(s.dataSource.kind);

  return {
    promptVersion: interp.promptVersion,
    modelConfigVersion: cfg.version,
    mode: input.mode,
    callKind: input.callKind,
    barEnd: input.barEnd ?? newestBarEnd ?? "",
    allowedActions: [...(input.callKind === "decision" ? DECISION_ACTIONS : OBSERVATION_ACTIONS)],
    nBars,
    markets,
    position: positionView(input.mode, input.ledger, campaign, input.positionExtras),
    bounds: buildBounds(input.callKind, markets, latest, input.ledger, cfg, interp),
    feedback: [...(input.feedback ?? [])].slice(-interp.feedbackK),
    lessons: [...(input.lessons ?? [])].slice(-interp.lessonsN),
    digest: input.digest ?? null,
    memoryEpochId: input.memoryEpochId ?? null,
    dataSourceKind: dataKinds.size === 1 ? [...dataKinds][0]! : dataKinds.size === 0 ? "none" : "mixed",
  };
}
