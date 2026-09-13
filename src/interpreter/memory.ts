/**
 * Bounded, auditable model memory (INTERPRETER_ADDENDUM.md "Feedback loop").
 *
 * Lessons and digests change only what the model reads. They cannot move a threshold, a size, a stop
 * bound or a candidate rule: the risk engine clamps every proposal exactly as before, and the
 * rules-only paper ledger stays the control. A reset archives an epoch, it never deletes a lesson.
 */
import type { Campaign, InterpreterMemoryResetEvent, Mode } from "../campaign/types";
import { modelConfig, type ModelConfig } from "../config/modelConfig";
import type { Ledger } from "../ledger/ledger";
import { EM_DASH, fmtMoney, fmtNum, fmtPrice, sideText } from "../ui/format";
import { realizedR } from "../campaign/pnl";
import { buildRequest } from "./buildRequest";
import { evaluateInvalidation, type SnapshotsByBar } from "./feedback";
import {
  interpreterEventId,
  type CampaignSummary,
  type Digest,
  type InterpreterConfig,
  type InterpreterRequest,
  type InvalidationOutcome,
  type Lesson,
  type ProposalOutcome,
} from "./types";

/** The lessons a request carries: the current epoch's last N, oldest first. */
export function lessonsForRequest(ledger: Ledger, N: number = modelConfig.interpreter.lessonsN): Lesson[] {
  const lessons = ledger.state.interpreter.lessons;
  return (N > 0 ? lessons.slice(-N) : []).map((l) => l.lesson);
}

/** True when the current epoch holds more lessons than a request may carry, so they need compacting. */
export function digestNeeded(ledger: Ledger, N: number = modelConfig.interpreter.lessonsN): boolean {
  return ledger.state.interpreter.lessons.length > N;
}

/** The lessons that fall outside the window and should be compacted into the next digest. */
export function lessonsToCompact(ledger: Ledger, N: number = modelConfig.interpreter.lessonsN): Lesson[] {
  const lessons = ledger.state.interpreter.lessons;
  if (lessons.length <= N) return [];
  return lessons.slice(0, lessons.length - N).map((l) => l.lesson);
}

export interface SummaryInput {
  campaign: Campaign;
  /** Needed only to evaluate the proposal's invalidation conditions; omit to leave them unevaluated. */
  snapshotsByBar?: SnapshotsByBar;
  /** Outcome already computed by feedback.ts, when the caller has it. */
  outcome?: ProposalOutcome | null;
}

/** Facts about a closed campaign, all taken from the ledger. */
export function campaignSummary(input: SummaryInput): CampaignSummary {
  const c = input.campaign;
  const root = c.root;
  const exits = c.fills.filter((f) => f.kind === "exit");
  const lastExit = exits[exits.length - 1];
  const r = realizedR(c);
  // Invalidation outcomes come from feedback.ts when the caller already computed them.
  const invalidation: InvalidationOutcome[] = input.outcome ? [...input.outcome.invalidation] : [];
  const finalStop = c.proposedStop?.stop ?? c.restingStop?.stop ?? null;
  return {
    campaignId: c.id,
    mode: c.mode,
    root,
    contract: c.contract,
    side: c.side,
    sideText: sideText(c.side),
    state: c.state,
    interpreterResponseId: c.interpreterResponseId,
    decisionBarEnd: c.frozenSnapshot.barEnd,
    openedAt: c.openedAt,
    closedAt: c.closedAt,
    entryFills: c.fills
      .filter((f) => f.kind === "entry")
      .map((f) => ({ priceTicks: f.price, priceText: fmtPrice(f.price, root), quantity: f.quantity, at: f.filledAt })),
    exitFills: exits.map((f) => ({ priceTicks: f.price, priceText: fmtPrice(f.price, root), quantity: f.quantity, at: f.filledAt, reason: f.reason ?? "manual" })),
    exitReason: lastExit?.reason ?? (c.cancelReason ? `cancelled: ${c.cancelReason}` : null),
    plannedEntryTicks: c.plan.plannedEntry,
    plannedEntryText: fmtPrice(c.plan.plannedEntry, root),
    plannedStopTicks: c.plan.plannedStop,
    plannedStopText: fmtPrice(c.plan.plannedStop, root),
    finalStopTicks: finalStop,
    finalStopText: fmtPrice(finalStop, root),
    originalRiskMils: c.originalRiskMils,
    originalRiskText: c.originalRiskMils === null ? EM_DASH : fmtMoney(c.originalRiskMils),
    netRealizedMils: c.netRealizedMils,
    netRealizedText: fmtMoney(c.netRealizedMils, true),
    feesMils: c.feesMils,
    feesText: fmtMoney(c.feesMils),
    realizedR: r,
    realizedRText: r === null ? EM_DASH : `${fmtNum(r)} R`,
    barsHeld: c.exposureBars,
    deviationReasons: [...c.deviationReasons],
    invalidation,
    proposal: null,
  };
}

export interface MemoryRequestOptions {
  cfg?: ModelConfig;
  interpreter?: InterpreterConfig;
  snapshotsByBar?: SnapshotsByBar;
  feedback?: readonly ProposalOutcome[];
  /** Outcome for this campaign's own proposal, when feedback.ts already computed it. */
  outcome?: ProposalOutcome | null;
  at?: string;
}

function memoryBase(ledger: Ledger, callKind: "lesson" | "digest", barEnd: string, options: MemoryRequestOptions): InterpreterRequest {
  const cfg = options.cfg ?? modelConfig;
  const interp = options.interpreter ?? cfg.interpreter;
  return buildRequest({
    callKind,
    mode: ledger.mode,
    // Memory calls carry no market bars: the campaign summary or the lessons are the whole input.
    histories: {},
    ledger: ledger.state,
    cfg,
    interpreter: interp,
    barEnd,
    feedback: options.feedback ?? [],
    lessons: lessonsForRequest(ledger, interp.lessonsN),
    digest: ledger.state.interpreter.digest?.digest ?? null,
    memoryEpochId: ledger.state.interpreter.memoryEpochId,
  });
}

/**
 * Request payload for the lesson a closed campaign earns. The model writes what held, what failed,
 * what to weigh differently and what evidence to watch; it changes nothing else.
 */
export function buildLessonRequest(campaign: Campaign, ledger: Ledger, options: MemoryRequestOptions = {}): InterpreterRequest {
  const summary = campaignSummary({ campaign, snapshotsByBar: options.snapshotsByBar, outcome: options.outcome ?? null });
  const proposal = campaign.interpreterResponseId
    ? (Object.values(ledger.state.interpreter.latestResponseByBar).find((r) => r.responseId === campaign.interpreterResponseId)?.response.proposal ?? null)
    : null;
  if (proposal && options.snapshotsByBar && summary.invalidation.length === 0) {
    summary.invalidation = proposal.invalidation.map((condition) =>
      evaluateInvalidation({
        condition,
        proposalBarEnd: campaign.frozenSnapshot.barEnd,
        side: proposal.side,
        snapshotsByBar: options.snapshotsByBar!,
        exitBarEnd: campaign.closedAt,
      }),
    );
  }
  summary.proposal = proposal;
  const base = memoryBase(ledger, "lesson", campaign.closedAt ?? campaign.frozenSnapshot.barEnd, options);
  return { ...base, campaignSummary: summary, lessonsToCompact: null };
}

/** Request payload that compacts older lessons into one digest. */
export function buildDigestRequest(lessons: readonly Lesson[], ledger: Ledger, options: MemoryRequestOptions = {}): InterpreterRequest {
  const at = options.at ?? ledger.state.interpreter.latestResponse?.barEnd ?? "";
  const base = memoryBase(ledger, "digest", at, options);
  return { ...base, campaignSummary: null, lessonsToCompact: [...lessons] };
}

/** Next epoch id: epoch-1 -> epoch-2; anything else gets a numeric suffix. */
export function nextEpochId(current: string): string {
  const m = /^(.*?)(\d+)$/.exec(current);
  if (!m) return `${current}-2`;
  return `${m[1]}${Number(m[2]) + 1}`;
}

/**
 * Archive the current memory epoch and start a new one. Returns the event for the caller to append;
 * the reducer clears the active lessons and digest while the log keeps every archived lesson.
 */
export function resetMemory(
  ledger: Ledger,
  at: string,
  options: { reason?: string; epochId?: string; model?: string; promptVersion?: string; mode?: Mode } = {},
): InterpreterMemoryResetEvent {
  const current = ledger.state.interpreter.memoryEpochId;
  const epochId = options.epochId ?? nextEpochId(current);
  const model = options.model ?? modelConfig.interpreter.model;
  const promptVersion = options.promptVersion ?? modelConfig.interpreter.promptVersion;
  return {
    id: interpreterEventId({ mode: options.mode ?? ledger.mode, barEnd: at, callKind: "decision", model, promptVersion, suffix: `memory-reset:${epochId}` }),
    type: "INTERPRETER_MEMORY_RESET",
    timestamp: at,
    actual: false,
    epochId,
    previousEpochId: current,
    reason: options.reason ?? "user reset model memory",
  };
}

/** The digest a request should carry, or null when the current epoch has none. */
export function digestForRequest(ledger: Ledger): Digest | null {
  return ledger.state.interpreter.digest?.digest ?? null;
}
