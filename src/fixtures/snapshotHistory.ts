/**
 * Synthetic snapshot history (D21).
 *
 * The interpreter reads the last N completed bars per market. There is no feed yet, so this module
 * derives 9 prior bars per market from the existing fixture snapshot by walking backwards through its
 * own chain: each earlier bar's u and H are the next bar's uPrev and HPrev, and each earlier close is
 * the next bar's previous close. The newest bar is the existing fixture snapshot unchanged, so
 * acceptance check #2 still reads the same numbers.
 *
 * Everything here is arithmetic on fixed constants: no clock, no randomness, identical on every call.
 * The bars are labeled synthetic in dataSource and in inputSourceIds and must never be presented as
 * market data.
 */
import { modelConfig, type InstrumentRoot, type ModelConfig } from "../config/modelConfig";
import type { SignalSnapshot } from "../formula/types";
import { INSTRUMENTS } from "../instruments/metadata";
import { fromTicks, toTicks, type Ticks } from "../numerics/ticks";
import { buildFixtureSnapshot, FIXTURE_BAR_END, FIXTURE_INPUTS, type FixtureSnapshotInput } from "./snapshots";

/** Bars per market, matching the interpreter's default nBars. */
export const HISTORY_BARS = 10;

export const HISTORY_LABEL = "Synthetic prior bars derived from the fixture snapshot · not market data";

/** How fast the build tapers going backwards; 1 would repeat the same change on every bar. */
const TAPER = 0.6;
/** Close-to-close drift per bar, as a fraction of ATR. */
const DRIFT_OF_ATR = 0.3;

const round4 = (x: number): number => Number(x.toFixed(4));
const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);

/** Bar ends going back from the fixture bar, one per weekday, oldest first. */
export function historyBarEnds(bars: number = HISTORY_BARS, newest: string = FIXTURE_BAR_END): string[] {
  const out: string[] = [newest];
  const cursor = new Date(newest);
  while (out.length < bars) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const day = cursor.getUTCDay();
    if (day === 0 || day === 6) continue;
    out.push(cursor.toISOString().replace(".000Z", "Z"));
  }
  return out.reverse();
}

function availableAtFor(barEnd: string): string {
  return new Date(new Date(barEnd).getTime() + 5 * 60_000).toISOString().replace(".000Z", "Z");
}

/**
 * Inputs for one market, oldest first. The last entry is the untouched fixture input; earlier entries
 * are derived from it by stepping the chain backwards.
 */
export function historyInputsFor(input: FixtureSnapshotInput, bars: number = HISTORY_BARS): FixtureSnapshotInput[] {
  const inst = INSTRUMENTS[input.root];
  const baseClose = toTicks(input.price, inst.tick, "exact");
  const basePrev = toTicks(input.prevClose, inst.tick, "exact");
  const atrTicks = toTicks(input.atr, inst.tick, "exact");
  const driftTicks = Math.max(1, Math.round(atrTicks * DRIFT_OF_ATR));
  // Uptrend for a positive breadth story, downtrend for a negative one; breadth-less markets drift up.
  const sign = (input.h ?? 0) < 0 ? -1 : 1;

  const chain: FixtureSnapshotInput[] = [{ ...input }];
  let closeTicks: number = basePrev; // the next earlier bar closes where the newer bar's previous close was
  let h = input.h;
  let hPrev = input.hPrev;
  let u = input.a !== null && input.a !== undefined ? input.q / input.a : null;
  let uPrev = input.uPrev;
  let q = input.q;
  let step = 0;

  for (let j = 1; j < bars; j++) {
    const taper = TAPER ** (j - 1);
    const prevTicks = closeTicks - sign * driftTicks;
    const priceText = fromTicks(closeTicks as Ticks, inst.tick);
    const prevText = fromTicks(prevTicks as Ticks, inst.tick);

    if (input.a === null || input.a === undefined || h === undefined || hPrev === undefined || uPrev === undefined || u === null) {
      // Breadth-less market (ZN, GC): only relative flow and price move.
      q = round4(clamp(q * (1 - 0.03 * j), 0.05, 5));
      chain.push({ ...input, q, price: priceText, prevClose: prevText });
    } else {
      // Step the chain back one bar: this bar's u and H are the newer bar's uPrev and HPrev.
      const nextU = uPrev;
      const nextH = hPrev;
      const hStep = (h - hPrev) * taper;
      const uStep = (u - uPrev) * taper;
      u = nextU;
      h = round4(clamp(nextH, -0.95, 0.95));
      hPrev = round4(clamp(nextH - hStep, -0.95, 0.95));
      uPrev = round4(Math.max(nextU - uStep, 0.05));
      q = round4(Math.max(u * input.a, 0.01));
      step = hStep;
      chain.push({ ...input, q, h, hPrev, uPrev, price: priceText, prevClose: prevText });
    }
    closeTicks = prevTicks;
  }
  void step;
  return chain.reverse();
}

/** One market's history, oldest first; the newest entry equals the plain fixture snapshot. */
export function historyFor(root: InstrumentRoot, cfg: ModelConfig = modelConfig, bars: number = HISTORY_BARS): SignalSnapshot[] {
  const input = FIXTURE_INPUTS.find((i) => i.root === root);
  if (!input) return [];
  const inputs = historyInputsFor(input, bars);
  const barEnds = historyBarEnds(bars);
  return inputs.map((i, index) => {
    const snapshot = buildFixtureSnapshot({ ...i, cfg });
    const barEnd = barEnds[index]!;
    snapshot.barEnd = barEnd;
    snapshot.availableAt = availableAtFor(barEnd);
    snapshot.inputSourceIds = [`fixture:history:${root}:${barEnd}`, "fixture:sigma-constants:synthetic"];
    return snapshot;
  });
}

/** Every market's history, oldest first per root. */
export function fixtureSnapshotHistory(cfg: ModelConfig = modelConfig, bars: number = HISTORY_BARS): Record<InstrumentRoot, SignalSnapshot[]> {
  const out = {} as Record<InstrumentRoot, SignalSnapshot[]>;
  for (const input of FIXTURE_INPUTS) out[input.root] = historyFor(input.root, cfg, bars);
  return out;
}

/** The same history keyed by bar end, which is what the feedback loop scans. */
export function fixtureSnapshotsByBar(cfg: ModelConfig = modelConfig, bars: number = HISTORY_BARS): Record<string, SignalSnapshot[]> {
  const byRoot = fixtureSnapshotHistory(cfg, bars);
  const out: Record<string, SignalSnapshot[]> = {};
  for (const list of Object.values(byRoot)) {
    for (const s of list) {
      (out[s.barEnd] ??= []).push(s);
    }
  }
  return out;
}
