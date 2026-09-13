/**
 * Interpreter contract (phase 2, INTERPRETER_ADDENDUM.md).
 *
 * The interpreter reads signal development and proposes; it never computes money, ticks, sizing or
 * P&L, and it never approves missing inputs. Every number it may emit is an integer tick count that
 * the risk engine clamps afterwards. Nothing here is a probability or a confidence: evidence
 * strength is a word.
 *
 * Request values are carried twice: the machine value (tick integers, plain numbers) and the display
 * string produced by ui/format, so the model never re-derives a number from a formatted one.
 */
import type { InstrumentRoot, IntervalId } from "../config/modelConfig";
import type { DisplaySide, Side, SnapshotStatus } from "../formula/types";
import type { Mils } from "../numerics/money";
import type { Ticks } from "../numerics/ticks";

/** Ledger modes (D18). `paper` is the rules-only control; `paperModel` is model-assisted. */
export type InterpreterMode = "manual" | "paper" | "paperModel";

/** Reasoning effort levels accepted by the provider. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** Decision bars allow every action; observations allow hold / tighten / exit only (Decision 1). */
export type CallKind = "decision" | "observation";

/** Interpreter block of modelConfig (D19). Frozen per campaign with the rest of the config. */
export interface InterpreterConfig {
  provider: "anthropic";
  model: string;
  effortDecision: EffortLevel;
  effortObservation: EffortLevel;
  promptVersion: string;
  /** Number of completed bars of history per market in a request. */
  nBars: number;
  /** Number of past proposal outcomes fed back into a request. */
  feedbackK: number;
  /** Number of lessons carried in a request before compaction into a digest. */
  lessonsN: number;
  /** Discretion (Decision 2): widens the candidate set beyond qualified markets. */
  mayEnterBelowThreshold: boolean;
  /** Optional S floor for the widened candidate set; null = no floor. */
  candidateFloor: number | null;
  /** The function refuses any model id outside this list (D20). */
  allowedModels: readonly string[];
}

/** D19 defaults. modelConfig re-exports these under `interpreter`; tests read them from here. */
export const DEFAULT_INTERPRETER_CONFIG: Readonly<InterpreterConfig> = Object.freeze({
  provider: "anthropic",
  model: "claude-opus-5",
  effortDecision: "high",
  effortObservation: "high",
  promptVersion: "interp-0.1",
  nBars: 10,
  feedbackK: 20,
  lessonsN: 30,
  mayEnterBelowThreshold: true,
  candidateFloor: null,
  allowedModels: ["claude-opus-5", "claude-sonnet-5", "claude-fable-5-1"],
} satisfies InterpreterConfig);

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** One market, one completed bar: machine values and their display strings side by side. */
export interface MarketBarView {
  barEnd: string;
  barEndText: string;
  availableAt: string;
  status: SnapshotStatus;
  displaySide: DisplaySide | null;
  /** Data provenance; fixtures say so (never presented as market data). */
  dataSource: { kind: string; label: string };
  interval: IntervalId;
  modelVersion: string;
  statistics: {
    Q: number | null;
    A: number | null;
    H: number | null;
    u: number | null;
    deltaU: number | null;
    deltaH: number | null;
    sigmaDeltaU: number | null;
    sigmaDeltaH: number | null;
    /** Activity component v = deltaU / sigmaDeltaU. */
    v: number | null;
    /** Directional components per side. */
    p: { long: number | null; short: number | null };
    /** S per side; the displayed score is S of displaySide. */
    S: { long: number | null; short: number | null };
    displayScore: number | null;
  };
  /** Same values as text, for the model to quote without re-deriving. */
  text: {
    Q: string;
    A: string;
    H: string;
    u: string;
    deltaU: string;
    deltaH: string;
    v: string;
    pLong: string;
    pShort: string;
    sLong: string;
    sShort: string;
    displayScore: string;
  };
  prices: {
    closeTicks: Ticks | null;
    closeText: string;
    closePrevTicks: Ticks | null;
    closePrevText: string;
    atr20Ticks: number | null;
    atr20Text: string;
  };
  qualification: {
    long: { S: number | null; qualifies: boolean; failed: string[] };
    short: { S: number | null; qualifies: boolean; failed: string[] };
  };
  /** Empty when the snapshot is available. */
  unavailableReasons: { code: string; detail: string }[];
  warnings: { code: string; detail: string }[];
  inputSourceIds: string[];
}

export interface MarketRequestView {
  root: InstrumentRoot;
  /** Oldest first; the last entry is the decision bar. Length <= nBars. */
  bars: MarketBarView[];
  /** Convenience copy of the newest bar's status so the model can scan quickly. */
  latestStatus: SnapshotStatus;
}

export interface PositionStateView {
  mode: InterpreterMode;
  hasPosition: boolean;
  campaignId: string | null;
  root: InstrumentRoot | null;
  side: Side | null;
  sideText: string;
  state: string | null;
  contractsRemaining: number | null;
  averageEntryTicks: number | null;
  averageEntryText: string;
  proposedStopTicks: Ticks | null;
  proposedStopText: string;
  recordedStopTicks: Ticks | null;
  recordedStopText: string;
  /** recorded - proposed, in ticks; null when either is missing. */
  stopDiscrepancyTicks: number | null;
  /** Highest (long) or lowest (short) completed close since entry. */
  extremeCloseTicks: Ticks | null;
  extremeCloseText: string;
  markTicks: Ticks | null;
  markText: string;
  markObservedAt: string | null;
  barsHeld: number | null;
  /** Supplied by the caller (risk engine / summary), never computed here. */
  flags: string[];
  rMultiple: number | null;
  rMultipleText: string;
  /** Frozen original risk, for context only; the model never sizes. */
  originalRiskMils: Mils | null;
  originalRiskText: string;
  stopFrozenReason: string | null;
}

export interface RequestBounds {
  /** Roots the model may propose `enter` for. Empty when entries are not permitted. */
  allowedCandidates: InstrumentRoot[];
  /** Maximum stop distance in ticks per root and side, from stops.stopDistance. Null when unavailable. */
  maxDTicks: Partial<Record<InstrumentRoot, { long: number | null; short: number | null }>>;
  /** Minimum stop distance in ticks (one tick). */
  minTicks: number;
  entriesPermitted: boolean;
  /** Why entries are or are not permitted, in plain words. */
  reason: string;
  /** Engine gate the clamp re-checks for every discretionary action, not just entries. */
  paused: boolean;
  /** Candidate policy in force, echoed for the audit trail. */
  candidatePolicy: { mayEnterBelowThreshold: boolean; candidateFloor: number | null };
}

/** One past proposal and what the ledger says happened (computed by code, never self-reported). */
export interface ProposalOutcome {
  responseId: string;
  barEnd: string;
  action: ProposalAction;
  root: InstrumentRoot | null;
  side: Side | null;
  disposition: "executed" | "clamped" | "rejected" | "not-executed";
  fill: { priceTicks: Ticks | null; priceText: string; quantity: number } | null;
  exitReason: string | null;
  realizedR: number | null;
  barsHeld: number | null;
  invalidation: InvalidationOutcome[];
}

/** D17: whether the named invalidation condition appeared before the stop did. */
export interface InvalidationOutcome {
  condition: Invalidation;
  /** Null when not evaluable (cross_market, note-only, or missing snapshots). */
  appearedBeforeStop: boolean | null;
  note: string;
}

export interface InterpreterRequest {
  promptVersion: string;
  /** Model config version label the request was built under (frozen per campaign). */
  modelConfigVersion: string;
  mode: InterpreterMode;
  callKind: CallKind;
  /** Bar end of the decision or observation this request belongs to. */
  barEnd: string;
  /** Entry actions are only available on decision calls. */
  allowedActions: ProposalAction[];
  nBars: number;
  markets: MarketRequestView[];
  position: PositionStateView;
  bounds: RequestBounds;
  /** Last K proposal outcomes, newest last. */
  feedback: ProposalOutcome[];
  /** Last N lessons, newest last. */
  lessons: Lesson[];
  digest: Digest | null;
  /** Memory epoch the lessons and digest belong to. */
  memoryEpochId: string | null;
  /** Fixture, replay, delayed or realtime; fixtures are labeled as such throughout. */
  dataSourceKind: string;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export type Activity = "building" | "isolated" | "fading" | "unclear";
export type BreadthReading = "broadening" | "concentrating" | "stable" | "unclear";
export type PriceResponse = "responding" | "unresponsive" | "diverging" | "unclear";
export type EvidenceStrength = "weak" | "moderate" | "strong";
export type ProposalAction = "enter" | "wait" | "hold" | "tighten" | "exit";

export const ACTIVITY_VALUES: readonly Activity[] = ["building", "isolated", "fading", "unclear"];
export const BREADTH_VALUES: readonly BreadthReading[] = ["broadening", "concentrating", "stable", "unclear"];
export const PRICE_RESPONSE_VALUES: readonly PriceResponse[] = ["responding", "unresponsive", "diverging", "unclear"];
export const EVIDENCE_STRENGTH_VALUES: readonly EvidenceStrength[] = ["weak", "moderate", "strong"];
export const PROPOSAL_ACTIONS: readonly ProposalAction[] = ["enter", "wait", "hold", "tighten", "exit"];

export type InvalidationKind =
  | "S_below"
  | "H_below"
  | "u_falls_below"
  | "price_reverses"
  | "breadth_concentrates"
  | "cross_market";

export const INVALIDATION_KINDS: readonly InvalidationKind[] = [
  "S_below",
  "H_below",
  "u_falls_below",
  "price_reverses",
  "breadth_concentrates",
  "cross_market",
];

/** D17: structured so feedback.ts can evaluate the condition against later snapshots. */
export interface Invalidation {
  kind: InvalidationKind;
  root: InstrumentRoot;
  /** Comparison level for the threshold kinds; null for price_reverses / cross_market / note-only. */
  threshold: number | null;
  note: string;
}

export interface Reading {
  root: InstrumentRoot;
  activity: Activity;
  breadth: BreadthReading;
  priceResponse: PriceResponse;
  noiseFlag: boolean;
  /** Short factual sentences citing snapshot fields and bar times. */
  evidence: string[];
}

export interface CrossMarket {
  summary: string;
  supports: InstrumentRoot[];
  contradicts: InstrumentRoot[];
}

export interface Proposal {
  action: ProposalAction;
  root: InstrumentRoot | null;
  side: Side | null;
  entryZone: { lowTicks: number; highTicks: number } | null;
  stopTicks: number | null;
  invalidation: Invalidation[];
  rationale: string;
}

export interface InterpreterResponse {
  promptVersion: string;
  readings: Reading[];
  crossMarket: CrossMarket;
  hypothesis: string;
  proposal: Proposal;
  /** Qualitative only. Never rendered as a percentage and never called confidence. */
  evidenceStrength: EvidenceStrength;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/** Written after a closed campaign (or on demand); stored as INTERPRETER_LESSON. */
export interface Lesson {
  campaignId: string;
  whatHeld: string[];
  whatFailed: string[];
  weighDifferently: string[];
  evidenceToWatch: string[];
}

/** Compaction of older lessons, stored as INTERPRETER_DIGEST. Originals stay in the log. */
export interface Digest {
  /** Digest revision, incremented each time a new digest is written. */
  version: number;
  /** How many lessons this digest compacts. */
  lessonsCovered: number;
  summary: string;
  whatHeld: string[];
  whatFailed: string[];
  weighDifferently: string[];
  evidenceToWatch: string[];
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Usage, cost and clamped proposals
// ---------------------------------------------------------------------------

/** Token usage reported by the provider for one call (D23). */
export interface InterpreterUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export const ZERO_USAGE: Readonly<InterpreterUsage> = Object.freeze({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });

/** Price per million tokens in mils. An estimate: published list prices, not an invoice. */
export interface ModelPrices {
  inputPerMTokenMils: number;
  cachedInputPerMTokenMils: number;
  outputPerMTokenMils: number;
}

/**
 * Estimate-only price table (D23). Labeled an estimate everywhere it is shown; it is not billing
 * data and it is not part of the frozen model contract.
 */
export const INTERPRETER_PRICE_TABLE: Readonly<Record<string, ModelPrices>> = Object.freeze({
  "claude-opus-5": { inputPerMTokenMils: 15_000_000, cachedInputPerMTokenMils: 1_500_000, outputPerMTokenMils: 75_000_000 },
  "claude-sonnet-5": { inputPerMTokenMils: 3_000_000, cachedInputPerMTokenMils: 300_000, outputPerMTokenMils: 15_000_000 },
  "claude-fable-5-1": { inputPerMTokenMils: 30_000_000, cachedInputPerMTokenMils: 3_000_000, outputPerMTokenMils: 150_000_000 },
});

export const COST_ESTIMATE_LABEL = "estimate";

/**
 * Estimated cost of one call in whole mils, rounded up so an estimate is never understated.
 * Returns 0 for an unknown model id (the caller shows the estimate as unavailable).
 */
export function estimateCostMils(usage: InterpreterUsage, model: string, table: Record<string, ModelPrices> = INTERPRETER_PRICE_TABLE): number {
  const prices = table[model];
  if (!prices) return 0;
  const total =
    (usage.inputTokens * prices.inputPerMTokenMils +
      usage.cachedInputTokens * prices.cachedInputPerMTokenMils +
      usage.outputTokens * prices.outputPerMTokenMils) /
    1_000_000;
  return Number.isFinite(total) ? Math.ceil(total) : 0;
}

/**
 * A proposal the risk engine has cleared for execution. The paper engine consumes this directly;
 * everything the model asked for that could not be honoured is in `reasons` and in the
 * INTERPRETER_CLAMPED event.
 */
export type ClampedProposal =
  | {
      action: "enter";
      root: InstrumentRoot;
      side: Side;
      /** Reference price the stop was clamped against (the decision bar close). */
      entryReferenceTicks: Ticks;
      /** Stop after clamping into [reference - maxD, reference - minTick] (mirrored for shorts). */
      stopTicks: Ticks;
      /** What the model proposed before clamping. */
      originalStopTicks: number;
      reasons: string[];
    }
  | { action: "tighten"; root: InstrumentRoot; stopTicks: Ticks }
  | { action: "exit"; root: InstrumentRoot };

/**
 * Ledger event id for every interpreter event:
 * `interp:<mode>:<barEnd>:<callKind>:<model>:<promptVersion>:<suffix>`.
 * Repeating a bar with the same model and prompt version produces the same id, so the ledger's
 * duplicate-id rule makes the write idempotent.
 */
export function interpreterEventId(parts: {
  mode: InterpreterMode;
  barEnd: string;
  callKind: CallKind;
  model: string;
  promptVersion: string;
  suffix: string;
}): string {
  return `interp:${parts.mode}:${parts.barEnd}:${parts.callKind}:${parts.model}:${parts.promptVersion}:${parts.suffix}`;
}
