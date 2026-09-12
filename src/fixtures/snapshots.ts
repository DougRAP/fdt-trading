/**
 * Precomputed fixture snapshots (D1 snapshot bypass). Mockup values, synthetic only.
 * Sigma constants (0.25 / 0.10) are synthetic; nothing here is market evidence.
 * This bypass lives only in fixtures/tests/demo; the app pipeline uses buildSignalSnapshot.
 */
import { modelConfig, type InstrumentRoot, type ModelConfig } from "../config/modelConfig";
import { undefinedBreadth } from "../breadth/BreadthAdapter";
import { assemble, computeDelta, computeU, scoreBothSides, type BothSides } from "../formula/compute";
import type { BreadthResult, DataQualityReason, DataQualityWarning, DataSourceLabel, SignalSnapshot } from "../formula/types";
import { INSTRUMENTS } from "../instruments/metadata";
import { toTicks, type Ticks } from "../numerics/ticks";

export const FIXTURE_DATA_SOURCE: DataSourceLabel = {
  kind: "fixture",
  label: "ILLUSTRATIVE DATA · synthetic snapshot · No market connection",
};

export const FIXTURE_BAR_END = "2026-01-02T21:00:00Z";
export const FIXTURE_AVAILABLE_AT = "2026-01-02T21:05:00Z";
export const FIXTURE_SIGMA_DELTA_U = 0.25;
export const FIXTURE_SIGMA_DELTA_H = 0.1;
const FIXTURE_BREADTH_SOURCE = "fixture-constituents";

export interface FixtureSnapshotInput {
  root: InstrumentRoot;
  q: number;
  /** Null when breadth is undefined for this root (ZN, GC). */
  a: number | null;
  uPrev?: number;
  h?: number;
  hPrev?: number;
  /** Decimal price strings, converted exactly to ticks. */
  price: string;
  prevClose: string;
  /** ATR20 in points (decimal string), converted to ticks. */
  atr: string;
  sigmaDeltaU?: number;
  sigmaDeltaH?: number;
  cfg?: ModelConfig;
}

function fixtureBreadth(A: number, H: number): BreadthResult {
  return {
    source: FIXTURE_BREADTH_SOURCE,
    definitionVersion: "fixture-precomputed-0.1",
    coverage: 1,
    validCount: 100,
    universeCount: 100,
    exclusions: [],
    A,
    H,
    valid: true,
    reasons: [],
  };
}

/** Build a snapshot from precomputed Q/A/H/uPrev/HPrev and synthetic sigma constants. */
export function buildFixtureSnapshot(input: FixtureSnapshotInput): SignalSnapshot {
  const cfg = input.cfg ?? modelConfig;
  const inst = INSTRUMENTS[input.root];
  const closeT: Ticks = toTicks(input.price, inst.tick, "exact");
  const closePrev: Ticks = toTicks(input.prevClose, inst.tick, "exact");
  const atr20Ticks: Ticks = toTicks(input.atr, inst.tick, "exact");
  const sigmaDeltaU = input.sigmaDeltaU ?? FIXTURE_SIGMA_DELTA_U;
  const sigmaDeltaH = input.sigmaDeltaH ?? FIXTURE_SIGMA_DELTA_H;
  const reasons: DataQualityReason[] = [];
  const warnings: DataQualityWarning[] = [];

  let breadth: BreadthResult;
  let A: number | null = null;
  let H: number | null = null;
  let u: number | null = null;
  let deltaU: number | null = null;
  let deltaH: number | null = null;
  let scores: BothSides | null = null;

  if (input.a === null || input.h === undefined || input.hPrev === undefined || input.uPrev === undefined) {
    breadth = undefinedBreadth(input.root);
    reasons.push(...breadth.reasons);
  } else {
    breadth = fixtureBreadth(input.a, input.h);
    A = input.a;
    H = input.h;
    if (A > 0 && A < cfg.aSmallWarn.value) {
      warnings.push({ code: "A_SMALL", detail: `A = ${A.toFixed(3)} is below ${cfg.aSmallWarn.value}; u = Q/A may be unstable` });
    }
    const uRes = computeU(input.q, A);
    if (!uRes.ok) reasons.push(uRes.reason);
    else {
      u = uRes.value;
      const dU = computeDelta(u, input.uPrev, "u");
      const dH = computeDelta(H, input.hPrev, "H");
      if (!dU.ok) reasons.push(dU.reason);
      if (!dH.ok) reasons.push(dH.reason);
      if (dU.ok && dH.ok) {
        deltaU = dU.value;
        deltaH = dH.value;
        const sc = scoreBothSides(deltaU, sigmaDeltaU, deltaH, sigmaDeltaH);
        if (sc.ok) scores = sc.value;
        else reasons.push(sc.reason);
      }
    }
  }

  return assemble({
    root: input.root,
    barEnd: FIXTURE_BAR_END,
    availableAt: FIXTURE_AVAILABLE_AT,
    interval: cfg.interval,
    dataSource: FIXTURE_DATA_SOURCE,
    raw: {
      volumeT: null,
      volumeBaselineMean: null,
      volumeBaselineCount: 0,
      closeT,
      closePrev,
      uPrev: input.uPrev ?? null,
      HPrev: input.hPrev ?? null,
      sigmaDeltaUCount: A === null ? 0 : cfg.sigmaWindow,
      sigmaDeltaHCount: A === null ? 0 : cfg.sigmaWindow,
      atr20Ticks,
    },
    breadth,
    Q: input.q,
    A,
    H,
    u,
    deltaU,
    deltaH,
    sigmaDeltaU: A === null ? null : sigmaDeltaU,
    sigmaDeltaH: A === null ? null : sigmaDeltaH,
    scores,
    reasons,
    warnings,
    inputSourceIds: [`fixture:${input.root}:${FIXTURE_BAR_END}`, "fixture:sigma-constants:synthetic"],
    cfg,
  });
}

/** Mockup values. NQ/ES/YM are up-bars, RTY a down-bar; ZN/GC carry Q only (D6). */
export const FIXTURE_INPUTS: readonly FixtureSnapshotInput[] = [
  { root: "NQ", q: 1.8, a: 0.6, uPrev: 2.4, h: 0.6, hPrev: 0.38, price: "22000", prevClose: "21980", atr: "25" },
  { root: "ES", q: 1.5, a: 0.625, uPrev: 2, h: 0.48, hPrev: 0.31, price: "6000", prevClose: "5990", atr: "8" },
  { root: "RTY", q: 1.3, a: 0.65, uPrev: 1.8, h: -0.46, hPrev: -0.4, price: "2100", prevClose: "2110", atr: "7" },
  { root: "YM", q: 0.99, a: 0.66, uPrev: 1.45, h: 0.22, hPrev: 0.2, price: "42000", prevClose: "41900", atr: "90" },
  { root: "ZN", q: 1.4, a: null, price: "110.5", prevClose: "110.25", atr: "0.5" },
  { root: "GC", q: 1.2, a: null, price: "2650", prevClose: "2640", atr: "30" },
];

export function fixtureSnapshots(cfg: ModelConfig = modelConfig): SignalSnapshot[] {
  return FIXTURE_INPUTS.map((i) => buildFixtureSnapshot({ ...i, cfg }));
}
