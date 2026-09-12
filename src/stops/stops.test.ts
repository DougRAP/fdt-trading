import { describe, expect, it } from "vitest";
import { INSTRUMENTS } from "../instruments/metadata";
import { toTicks, ticks, type Ticks } from "../numerics/ticks";
import {
  closeRequired,
  initialStop,
  smaAtr,
  stopAppliesToBar,
  stopDistance,
  trailStop,
  trueRange,
  type OhlcBar,
  type StopState,
} from "./stops";

const NQ = INSTRUMENTS.NQ.tick;
const px = (s: string): Ticks => toTicks(s, NQ, "exact");
const T0 = "2026-01-02T21:05:00Z";
const T1 = "2026-01-05T21:05:00Z";
const T2 = "2026-01-06T21:05:00Z";

function bar(i: number, open: string, high: string, low: string, close: string): OhlcBar {
  const day = String(i + 1).padStart(2, "0");
  return { barEnd: `2026-02-${day}T21:00:00Z`, availableAt: `2026-02-${day}T21:05:00Z`, open: px(open), high: px(high), low: px(low), close: px(close) };
}

describe("trueRange / SMA ATR20 (D2)", () => {
  it("TR takes the max of range and gaps", () => {
    expect(trueRange(px("22010"), px("21990"), px("22000"))).toBe(80);
    expect(trueRange(px("22050"), px("22040"), px("22000"))).toBe(200);
    expect(trueRange(px("21960"), px("21950"), px("22000"))).toBe(200);
  });

  it("21 bars with 25-point ranges give ATR 100 ticks; first TR uses close t-20", () => {
    const bars = Array.from({ length: 21 }, (_, i) => bar(i, "22000", "22012.5", "21987.5", "22000"));
    const r = smaAtr(bars);
    expect(r.ok && r.value).toEqual({ atrTicks: 100, sumTrTicks: 2000, window: 20, method: "SMA" });
  });

  it("gap on the first window bar vs close t-20 is included", () => {
    const bars = Array.from({ length: 21 }, (_, i) => bar(i, "22000", "22012.5", "21987.5", "22000"));
    bars[0] = bar(0, "21900", "21910", "21890", "21900"); // close t-20 = 21900 => TR of bar 1 = 22012.5 - 21900 = 450 ticks
    const r = smaAtr(bars);
    expect(r.ok && r.value.sumTrTicks).toBe(450 + 19 * 100);
  });

  it("fewer than 21 bars is INSUFFICIENT_ATR_HISTORY", () => {
    const bars = Array.from({ length: 20 }, (_, i) => bar(i, "22000", "22012.5", "21987.5", "22000"));
    expect(smaAtr(bars)).toMatchObject({ ok: false, reason: { code: "INSUFFICIENT_ATR_HISTORY", detail: "20/21 bars available for SMA ATR20" } });
  });
});

describe("stopDistance D = ATR x [1.5 + max(0, dH)]", () => {
  it("ATR 25 pts (100 ticks), H .6, long => 52.5 pts = 210 ticks", () => {
    const r = stopDistance(100, 0.6, 1);
    expect(r.ok && r.value.dTicks).toBe(210);
    expect(r.ok && r.value.coefficient).toBeCloseTo(2.1, 12);
  });

  it("short uses -H: H -.6 => same 210; H +.6 short => 150", () => {
    expect(stopDistance(100, -0.6, -1)).toMatchObject({ ok: true, value: { dTicks: 210 } });
    expect(stopDistance(100, 0.6, -1)).toMatchObject({ ok: true, value: { dTicks: 150 } });
  });

  it("missing ATR or H => DATA_STALE", () => {
    expect(stopDistance(null, 0.6, 1)).toMatchObject({ ok: false, reason: { code: "DATA_STALE" } });
    expect(stopDistance(100, null, 1)).toMatchObject({ ok: false, reason: { code: "DATA_STALE" } });
    expect(stopDistance(Number.NaN, 0.6, 1)).toMatchObject({ ok: false, reason: { code: "DATA_STALE" } });
  });
});

function dist(atrTicks: number, H: number, side: 1 | -1) {
  const r = stopDistance(atrTicks, H, side);
  if (!r.ok) throw new Error(r.reason.detail);
  return r.value;
}

describe("initialStop", () => {
  it("long: entry 22000.25, D 52.5 => 21947.75", () => {
    const s = initialStop({ side: 1, entryFill: px("22000.25"), distance: dist(100, 0.6, 1), calculatedAt: T0 });
    expect(s.stop).toBe(px("21947.75"));
    expect(s.effectiveAfter).toBe(T0);
    expect(s.source).toBe("initial");
  });

  it("short: entry 21999.75, D 52.5 => 22052.25", () => {
    const s = initialStop({ side: -1, entryFill: px("21999.75"), distance: dist(100, -0.6, -1), calculatedAt: T0 });
    expect(s.stop).toBe(px("22052.25"));
  });

  it("rounds long down and short up to the tick grid", () => {
    // D = 100 x (1.5 + 0.55) = 205 ticks... use H .553 => 205.3 ticks
    const long = initialStop({ side: 1, entryFill: px("22000.25"), distance: dist(100, 0.553, 1), calculatedAt: T0 });
    expect(long.stop).toBe(88001 - 206); // floor(88001 - 205.3) = 87795
    const short = initialStop({ side: -1, entryFill: px("21999.75"), distance: dist(100, -0.553, -1), calculatedAt: T0 });
    expect(short.stop).toBe(87999 + 206); // ceil(87999 + 205.3) = 88205
  });
});

describe("trailStop ratchet (D3)", () => {
  const longInitial = (): StopState =>
    initialStop({ side: 1, entryFill: px("22000.25"), distance: dist(100, 0.6, 1), calculatedAt: T0 });

  it("long: highest close 22100, ATR 30, H .7 => D 66 => 22034; then H .2 => D 51 => 22049; then ATR up => stays 22049", () => {
    const s1 = trailStop({ previous: longInitial(), extremeClose: px("22100"), atrTicks: 120, H: 0.7, calculatedAt: T1 });
    expect(s1.state.stop).toBe(px("22034"));
    expect(s1.changed).toBe(true);
    expect(s1.state.effectiveAfter).toBe(T1);
    expect(s1.state.source).toBe("trail");

    const s2 = trailStop({ previous: s1.state, extremeClose: px("22100"), atrTicks: 120, H: 0.2, calculatedAt: T2 });
    expect(s2.state.stop).toBe(px("22049"));
    expect(s2.changed).toBe(true);

    // ATR 40 pts => D = 160 x 1.7 = 272 ticks => candidate 22032 < 22049 => no loosening
    const s3 = trailStop({ previous: s2.state, extremeClose: px("22100"), atrTicks: 160, H: 0.2, calculatedAt: "2026-01-07T21:05:00Z" });
    expect(s3.state.stop).toBe(px("22049"));
    expect(s3.changed).toBe(false);
    expect(s3.candidate).toBe(px("22032"));
    expect(s3.state.effectiveAfter).toBe(T2);
  });

  it("short: lowest close 21900, ATR 30, H -.7 => D 66 => 21966; never moves up", () => {
    const init = initialStop({ side: -1, entryFill: px("21999.75"), distance: dist(100, -0.6, -1), calculatedAt: T0 });
    const s1 = trailStop({ previous: init, extremeClose: px("21900"), atrTicks: 120, H: -0.7, calculatedAt: T1 });
    expect(s1.state.stop).toBe(px("21966"));
    const s2 = trailStop({ previous: s1.state, extremeClose: px("21900"), atrTicks: 160, H: -0.2, calculatedAt: T2 });
    expect(s2.state.stop).toBe(px("21966"));
    expect(s2.changed).toBe(false);
  });

  it("rounding never increases a previously ratcheted distance", () => {
    const prev: StopState = { ...longInitial(), stop: px("22049"), effectiveAfter: T1, calculatedAt: T1, source: "trail" };
    // ATR 135.5 ticks, H 0 => D 203.25 => candidate 88400 - 203.25 = 88196.75 => floor 88196 = prev => unchanged
    const r = trailStop({ previous: prev, extremeClose: px("22100"), atrTicks: 135.5, H: 0.0, calculatedAt: T2 });
    expect(r.candidate).toBe(88196);
    expect(r.state.stop).toBe(px("22049"));
    expect(r.changed).toBe(false);
    // ATR 135 => D 202.5 => 88197.5 => floor 88197: tightens by whole ticks only
    const r2 = trailStop({ previous: prev, extremeClose: px("22100"), atrTicks: 135, H: 0.0, calculatedAt: T2 });
    expect(r2.candidate).toBe(88197);
    expect(r2.state.stop).toBe(88197);
    expect(r2.changed).toBe(true);
  });

  it("missing ATR or H freezes the previous stop with DATA_STALE and keeps it effective", () => {
    const prev = longInitial();
    const r = trailStop({ previous: prev, extremeClose: px("22100"), atrTicks: null, H: 0.7, calculatedAt: T1 });
    expect(r.state.stop).toBe(prev.stop);
    expect(r.state.source).toBe("frozen");
    expect(r.state.reason).toEqual({ code: "DATA_STALE", detail: "ATR20 is missing or not finite" });
    expect(r.state.effectiveAfter).toBe(T0);
    expect(r.changed).toBe(false);
    const r2 = trailStop({ previous: prev, extremeClose: px("22100"), atrTicks: 120, H: null, calculatedAt: T1 });
    expect(r2.state.reason?.code).toBe("DATA_STALE");
    expect(r2.state.stop).toBe(prev.stop);
  });
});

describe("effectiveAfter (same-bar hindsight)", () => {
  it("a stop computed from bar t's close does not apply to bar t, only to later bars", () => {
    const barT: OhlcBar = { barEnd: "2026-01-05T21:00:00Z", availableAt: T1, open: px("22090"), high: px("22110"), low: px("22000"), close: px("22100") };
    const barNext: OhlcBar = { barEnd: "2026-01-06T21:00:00Z", availableAt: T2, open: px("22100"), high: px("22120"), low: px("22030"), close: px("22050") };
    const prev = initialStop({ side: 1, entryFill: px("22000.25"), distance: dist(100, 0.6, 1), calculatedAt: T0 });
    const trailed = trailStop({ previous: prev, extremeClose: barT.close, atrTicks: 120, H: 0.7, calculatedAt: barT.availableAt }).state;
    expect(trailed.stop).toBe(px("22034"));
    // bar t's low 22000 is below the new stop 22034, but the stop is not effective for bar t
    expect(stopAppliesToBar(trailed, barT)).toBe(false);
    expect(stopAppliesToBar(trailed, barNext)).toBe(true);
    // the previous stop was effective for bar t
    expect(stopAppliesToBar(prev, barT)).toBe(true);
  });
});

describe("closeRequired", () => {
  it("long stop at or above bid requires a close; below bid does not", () => {
    const stop: StopState = { side: 1, stop: px("22049"), effectiveAfter: T2, calculatedAt: T2, source: "trail", basis: { referenceClose: px("22100"), dTicks: 204, atrTicks: 120, H: 0.2 } };
    expect(closeRequired(stop, { bid: px("22040"), ask: px("22040.25"), observedAt: T2 }).required).toBe(true);
    expect(closeRequired(stop, { bid: px("22049"), ask: px("22049.25"), observedAt: T2 }).required).toBe(true);
    expect(closeRequired(stop, { bid: px("22060"), ask: px("22060.25"), observedAt: T2 }).required).toBe(false);
  });

  it("short stop at or below ask requires a close", () => {
    const stop: StopState = { side: -1, stop: px("21966"), effectiveAfter: T2, calculatedAt: T2, source: "trail", basis: { referenceClose: px("21900"), dTicks: 264, atrTicks: 120, H: -0.7 } };
    expect(closeRequired(stop, { bid: px("21969.75"), ask: px("21970"), observedAt: T2 }).required).toBe(true);
    expect(closeRequired(stop, { bid: px("21960"), ask: px("21960.25"), observedAt: T2 }).required).toBe(false);
  });

  it("ticks helper sanity", () => {
    expect(ticks(5)).toBe(5);
  });
});
