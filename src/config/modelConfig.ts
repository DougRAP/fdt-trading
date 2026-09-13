/**
 * Versioned model configuration, v0.1.
 * Every campaign stores a frozen copy of the config it was entered under (D16).
 * The model is an unvalidated research hypothesis; nothing here is optimized.
 */
import type { Mils } from "../numerics/money";
import { mils } from "../numerics/money";

export type IntervalId = "daily" | "hourly" | "5m";

export interface IntervalOption {
  id: IntervalId;
  label: string;
  enabled: boolean;
  /** Why the option is disabled; shown verbatim in the UI. */
  disabledReason?: string;
}

/** Synthetic execution-cost fixture (D4). Configurable per instrument root. */
export interface CostFixture {
  /** Fee per contract per side, in mils. $2.50 => 2500. */
  feePerContractPerSideMils: Mils;
  /** Modeled bid/ask spread in ticks. */
  spreadTicks: number;
  /** Adverse adjustment per fill in ticks (buy +1 tick, sell -1 tick vs reference). */
  adverseTicksPerFill: number;
  /** Provenance label; fixtures must never masquerade as measured costs. */
  source: "fixture";
}

export interface ResearchParam<T> {
  value: T;
  /** Human-readable status; every research param carries one. */
  label: string;
}

export type InstrumentRoot = "NQ" | "ES" | "RTY" | "YM" | "ZN" | "GC";

export const INSTRUMENT_ROOTS: readonly InstrumentRoot[] = ["NQ", "ES", "RTY", "YM", "ZN", "GC"];

export interface ModelConfig {
  /** "0.1" is the model version. A user settings revision is appended as "+userN" (e.g. "0.1+user2"); the formula does not change. */
  version: string;
  /** Q baseline: mean of the preceding N volumes (excludes bar t). */
  volumeWindow: 20;
  /** Sigma estimation: sample SD of the preceding N changes (excludes current change), ddof=1. */
  sigmaWindow: 60;
  /** Candidate qualifies if S_d,t > entryThreshold. */
  entryThreshold: number;
  /** Candidate qualifies if d x H_t >= breadthThreshold. */
  breadthThreshold: number;
  /** ATR20 window (SMA of true ranges, inclusive of bar t). */
  atrWindow: 20;
  /** D_t = ATR20 x [stopBase + max(0, d x H_t)]. Provisional coefficient. */
  stopBase: number;
  /** Planned per-trade loss budget as a fraction of current marked paper equity. */
  riskBudgetPct: number;
  /** Paper account starting equity in mils (D5). */
  paperEquityStartMils: Mils;
  /** Per-root execution-cost fixtures (D4). */
  costs: Record<InstrumentRoot, CostFixture>;
  /** Warn when A is below this; research parameter, not an exclusion threshold. */
  aSmallWarn: ResearchParam<number>;
  /** Active signal interval. Only "daily" is supported. */
  interval: IntervalId;
  intervalOptions: readonly IntervalOption[];
}

const defaultCost: CostFixture = {
  feePerContractPerSideMils: mils(2500),
  spreadTicks: 0,
  adverseTicksPerFill: 1,
  source: "fixture",
};

export const modelConfig: Readonly<ModelConfig> = Object.freeze({
  version: "0.1",
  volumeWindow: 20,
  sigmaWindow: 60,
  entryThreshold: 1.0,
  breadthThreshold: 0.4,
  atrWindow: 20,
  stopBase: 1.5,
  riskBudgetPct: 0.0025,
  paperEquityStartMils: mils(1_000_000_000),
  costs: {
    NQ: { ...defaultCost },
    ES: { ...defaultCost },
    RTY: { ...defaultCost },
    YM: { ...defaultCost },
    ZN: { ...defaultCost },
    GC: { ...defaultCost },
  },
  aSmallWarn: {
    value: 0.1,
    label:
      "Research parameter (unvalidated): warn when A < 0.10 because u = Q/A may be unstable. Not an exclusion threshold.",
  },
  interval: "daily",
  intervalOptions: [
    { id: "daily", label: "Daily", enabled: true },
    {
      id: "hourly",
      label: "Hourly",
      enabled: false,
      disabledReason: "Requires complete, aligned hourly datasets and re-estimated histories; not supported.",
    },
    {
      id: "5m",
      label: "5 minute",
      enabled: false,
      disabledReason:
        "Requires complete, aligned 5-minute datasets and same-time-of-session volume baselines; not supported.",
    },
  ],
} satisfies ModelConfig);

/** Deep-frozen independent copy for storing with a campaign (D16). */
export function freezeModelConfig(cfg: ModelConfig = modelConfig): Readonly<ModelConfig> {
  return Object.freeze(structuredClone(cfg));
}
