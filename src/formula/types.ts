/**
 * Signal snapshot types, model v0.1.
 * Statistical values (Q, A, H, u, deltas, sigmas, S) are plain finite numbers.
 * Prices are integer Ticks. Nothing here is a probability or a confidence.
 */
import type { IntervalId, InstrumentRoot } from "../config/modelConfig";
import type { Ticks } from "../numerics/ticks";

export type Side = 1 | -1;
export type DisplaySide = "long" | "short" | "neutral";

export type UnavailableReasonCode =
  | "INSUFFICIENT_VOLUME_HISTORY"
  | "INSUFFICIENT_SIGMA_HISTORY"
  | "ZERO_SIGMA"
  | "A_ZERO"
  | "COVERAGE_BELOW_95"
  | "STALE"
  | "NONFINITE"
  | "BREADTH_MODEL_UNDEFINED"
  | "INVALID_PRICE";

export type WarningCode = "A_SMALL";

export interface DataQualityReason<C extends string = UnavailableReasonCode> {
  code: C;
  /** Specific, human-readable detail, e.g. "59/60 valid prior changes". */
  detail: string;
}

export type DataQualityWarning = DataQualityReason<WarningCode>;

export interface DataQuality {
  /** False when any UNAVAILABLE reason is present. */
  available: boolean;
  reasons: DataQualityReason[];
  warnings: DataQualityWarning[];
}

export type DataSourceKind = "fixture" | "replay" | "delayed" | "realtime";

export interface DataSourceLabel {
  kind: DataSourceKind;
  /** Shown verbatim to the user; fixtures must say so. */
  label: string;
}

/** Breadth adapter output carried inside the snapshot. */
export interface BreadthResult {
  source: string;
  definitionVersion: string;
  /** validCount / universeCount, or null when unknown. */
  coverage: number | null;
  validCount: number | null;
  universeCount: number | null;
  /** Constituent ids excluded from the valid set, with reasons. */
  exclusions: { id: string; reason: string }[];
  /** Unsigned activity breadth in [0, 1], or null. */
  A: number | null;
  /** Directional breadth in [-1, +1], or null. */
  H: number | null;
  valid: boolean;
  reasons: DataQualityReason[];
}

export interface RawInputs {
  /** V_t in contracts. */
  volumeT: number | null;
  /** mean(V_{t-20..t-1}). */
  volumeBaselineMean: number | null;
  /** Number of prior volumes used for the baseline. */
  volumeBaselineCount: number;
  closeT: Ticks | null;
  closePrev: Ticks | null;
  /** Previous bar's u and H (from the prior snapshot). */
  uPrev: number | null;
  HPrev: number | null;
  /** Count of valid prior changes used for each sigma. */
  sigmaDeltaUCount: number;
  sigmaDeltaHCount: number;
  /** ATR20 in ticks, passed through for the stop model (computed elsewhere). */
  atr20Ticks: Ticks | null;
}

export interface QualificationChecks {
  /** S_d,t > entryThreshold. */
  scoreAboveThreshold: boolean | null;
  /** d x H_t >= breadthThreshold. */
  breadthDirection: boolean | null;
  /** d x (close_t - close_{t-1}) > 0. */
  priceConfirmation: boolean | null;
  /** All required inputs valid and fresh. */
  inputsValid: boolean;
}

export interface SideEligibility {
  side: Side;
  S: number | null;
  checks: QualificationChecks;
  qualifies: boolean;
  /** Names of failed checks, in evaluation order. */
  failed: (keyof QualificationChecks)[];
}

export type SnapshotStatus = "QUALIFIED" | "WAIT" | "NEUTRAL" | "UNAVAILABLE";

export interface SignalSnapshot {
  root: InstrumentRoot;
  /** ISO timestamp of the completed signal bar's end. */
  barEnd: string;
  /** ISO timestamp when all inputs were available for the decision. */
  availableAt: string;
  interval: IntervalId;
  modelVersion: string;
  dataSource: DataSourceLabel;
  raw: RawInputs;
  breadth: BreadthResult;
  Q: number | null;
  A: number | null;
  H: number | null;
  u: number | null;
  deltaU: number | null;
  deltaH: number | null;
  /** Sample SD (ddof=1) of the 60 preceding changes, excluding the current change. */
  sigmaDeltaU: number | null;
  sigmaDeltaH: number | null;
  /** v_t = deltaU / sigmaDeltaU (unsigned activity component). */
  v: number | null;
  /** p_{d,t} = d x deltaH / sigmaDeltaH. */
  p: { long: number | null; short: number | null };
  /** S_{d,t} = min(v, p_d) for both sides. */
  S: { long: number | null; short: number | null };
  /** Side shown on the card: qualified side, else H-aligned side, else neutral. Null when unavailable. */
  displaySide: DisplaySide | null;
  /** S of the displayed side (may be negative); null when neutral or unavailable. */
  displayScore: number | null;
  eligibility: { long: SideEligibility; short: SideEligibility };
  qualifiedSide: Side | null;
  status: SnapshotStatus;
  dataQuality: DataQuality;
  /** Identifiers of source bars / input histories used for this snapshot. */
  inputSourceIds: string[];
}
