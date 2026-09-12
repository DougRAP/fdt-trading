/**
 * Synthetic demo bars for the paper-mode demonstration. Deterministic, derived from the fixture
 * snapshot's close and ATR. Bar 1 is the executable bar (open gaps slightly in the trade's favor),
 * bars 2–3 rise (or fall for a short), the final bar touches the resting stop.
 * These are not market data and not evidence of strategy performance.
 */
import type { SignalSnapshot } from "../formula/types";
import { INSTRUMENTS } from "../instruments/metadata";
import { fromTicks, toTicks, type Ticks } from "../numerics/ticks";
import type { EngineBar, TrailInputs } from "../paper/engine";

export const DEMO_BARS_LABEL = "Synthetic demo bars · not market data";

interface Shape {
  o: number;
  h: number;
  l: number;
  c: number;
}

/** Per-bar moves in ATR units relative to the previous close, long orientation. */
const SHAPES: readonly Shape[] = [
  { o: 0.2, h: 1.6, l: -0.4, c: 1.2 },
  { o: 0.2, h: 2.0, l: -0.4, c: 1.6 },
  { o: 0.2, h: 2.0, l: -0.4, c: 1.6 },
  { o: -0.4, h: -0.2, l: -3.0, c: -2.5 },
];

function dayIso(index: number, time: string): string {
  const day = 5 + index; // weekdays after the 2026-01-02 fixture bar
  return `2026-01-${String(day).padStart(2, "0")}T${time}`;
}

/** Bars for one snapshot; empty when the snapshot has no close or ATR. */
export function demoBarsFor(snapshot: SignalSnapshot, side: 1 | -1): EngineBar[] {
  const closeT = snapshot.raw.closeT;
  const atr = snapshot.raw.atr20Ticks;
  if (closeT === null || atr === null) return [];
  const inst = INSTRUMENTS[snapshot.root];
  const grid = (x: number): Ticks => toTicks(fromTicks(Math.round(x) as Ticks, inst.tick), inst.tick, "exact");
  let prevClose: number = closeT;
  return SHAPES.map((s, i) => {
    const o = prevClose + side * s.o * atr;
    const c = prevClose + side * s.c * atr;
    const hi = prevClose + side * (side === 1 ? s.h : s.l) * atr;
    const lo = prevClose + side * (side === 1 ? s.l : s.h) * atr;
    const bar: EngineBar = {
      root: snapshot.root,
      barEnd: dayIso(i, "21:00:00Z"),
      availableAt: dayIso(i, "21:05:00Z"),
      open: grid(o),
      high: grid(Math.max(hi, lo, o, c)),
      low: grid(Math.min(hi, lo, o, c)),
      close: grid(c),
    };
    prevClose = bar.close;
    return bar;
  });
}

/** Trailing inputs for the demo: the fixture snapshot's ATR and H held constant (synthetic). */
export function demoTrailInputs(snapshot: SignalSnapshot): TrailInputs {
  return { atrTicks: snapshot.raw.atr20Ticks, H: snapshot.H };
}
