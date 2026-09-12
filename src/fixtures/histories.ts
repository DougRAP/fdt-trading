/**
 * Small synthetic histories for pipeline tests (D1). Not market data.
 */
import type { BreadthInput, ConstituentBar } from "../breadth/BreadthAdapter";
import type { SignalHistories } from "../formula/compute";
import type { BreadthResult } from "../formula/types";
import type { InstrumentRoot } from "../config/modelConfig";
import { INSTRUMENTS } from "../instruments/metadata";
import { toTicks } from "../numerics/ticks";
import { FIXTURE_AVAILABLE_AT, FIXTURE_BAR_END, FIXTURE_DATA_SOURCE } from "./snapshots";

/**
 * n values with mean 0 and sample SD (ddof=1) exactly `sd`: alternating +x/-x with
 * x = sd * sqrt((n-1)/n). n must be even.
 */
export function seriesWithSampleSd(n: number, sd: number): number[] {
  if (n % 2 !== 0) throw new Error("seriesWithSampleSd requires even n");
  const x = sd * Math.sqrt((n - 1) / n);
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? x : -x));
}

export interface ConstituentSpec {
  count: number;
  /** How many have volume_t above their own prior mean. */
  aboveNormal: number;
  advancing: number;
  declining: number;
  /** Extra ids returned as missing (excluded), counted in universe. */
  missing?: number;
  volumeWindow?: number;
}

/** Constituents with exactly the requested activity/direction counts. */
export function makeConstituents(spec: ConstituentSpec): ConstituentBar[] {
  const window = spec.volumeWindow ?? 20;
  const prior = Array.from({ length: window }, () => 100);
  const out: ConstituentBar[] = [];
  for (let i = 0; i < spec.count; i++) {
    const above = i < spec.aboveNormal;
    const closePrev = 50;
    const closeT = i < spec.advancing ? 51 : i < spec.advancing + spec.declining ? 49 : 50;
    out.push({ id: `C${i}`, volumeT: above ? 150 : 80, priorVolumes: prior, closeT, closePrev });
  }
  for (let i = 0; i < (spec.missing ?? 0); i++) {
    out.push({ id: `M${i}`, volumeT: null, priorVolumes: prior, closeT: null, closePrev: null });
  }
  return out;
}

export function makeBreadthInput(spec: ConstituentSpec): BreadthInput {
  return {
    universeCount: spec.count + (spec.missing ?? 0),
    constituents: makeConstituents(spec),
    volumeWindow: spec.volumeWindow ?? 20,
  };
}

export interface HistorySpec {
  root?: InstrumentRoot;
  volumeT?: number;
  priorVolumes?: (number | null)[];
  price?: string;
  prevClose?: string;
  breadth: BreadthResult;
  uPrev?: number | null;
  HPrev?: number | null;
  priorDeltaU?: (number | null)[];
  priorDeltaH?: (number | null)[];
  fresh?: boolean;
  staleDetail?: string;
}

/**
 * Worked long example histories: V_t = 1800 over a flat 1000 baseline (Q = 1.8),
 * uPrev 2.4, HPrev 0.38, prior change series with sample SD 0.25 / 0.10, up-bar 21980 -> 22000.
 */
export function makeHistories(spec: HistorySpec): SignalHistories {
  const root = spec.root ?? "NQ";
  const inst = INSTRUMENTS[root];
  return {
    root,
    barEnd: FIXTURE_BAR_END,
    availableAt: FIXTURE_AVAILABLE_AT,
    interval: "daily",
    dataSource: FIXTURE_DATA_SOURCE,
    volumeT: spec.volumeT ?? 1800,
    priorVolumes: spec.priorVolumes ?? Array.from({ length: 20 }, () => 1000),
    closeT: toTicks(spec.price ?? "22000", inst.tick, "exact"),
    closePrev: toTicks(spec.prevClose ?? "21980", inst.tick, "exact"),
    breadth: spec.breadth,
    uPrev: spec.uPrev === undefined ? 2.4 : spec.uPrev,
    HPrev: spec.HPrev === undefined ? 0.38 : spec.HPrev,
    priorDeltaU: spec.priorDeltaU ?? seriesWithSampleSd(60, 0.25),
    priorDeltaH: spec.priorDeltaH ?? seriesWithSampleSd(60, 0.1),
    freshness: { fresh: spec.fresh ?? true, detail: spec.staleDetail },
    atr20Ticks: toTicks("25", inst.tick, "exact"),
    inputSourceIds: [`synthetic-history:${root}`],
  };
}
