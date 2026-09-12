import { describe, expect, it } from "vitest";
import { EquityConstituentAdapter, undefinedBreadth } from "../breadth/BreadthAdapter";
import { makeBreadthInput, makeHistories, seriesWithSampleSd } from "../fixtures/histories";
import { ticks } from "../numerics/ticks";
import { buildSignalSnapshot, computeQ, computeSigma, computeU, qualify, scoreBothSides } from "./compute";

const adapter = new EquityConstituentAdapter("test");
const breadth = (aboveNormal: number, advancing: number, declining: number) =>
  adapter.compute(makeBreadthInput({ count: 100, aboveNormal, advancing, declining }));

describe("primitives", () => {
  it("computeQ uses the last 20 prior volumes", () => {
    const r = computeQ(1800, [5000, ...Array.from({ length: 20 }, () => 1000)]);
    expect(r.ok && r.value.Q).toBeCloseTo(1.8, 12);
    expect(r.ok && r.value.count).toBe(20);
  });

  it("computeQ reports INSUFFICIENT_VOLUME_HISTORY with counts", () => {
    const r = computeQ(1800, Array.from({ length: 19 }, () => 1000));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toEqual({ code: "INSUFFICIENT_VOLUME_HISTORY", detail: "19/20 valid prior volumes" });
    const withNull = computeQ(1800, [null, ...Array.from({ length: 19 }, () => 1000)]);
    expect(!withNull.ok && withNull.reason.detail).toBe("19/20 valid prior volumes");
  });

  it("computeQ rejects zero baseline and nonfinite current volume", () => {
    expect(computeQ(1800, Array.from({ length: 20 }, () => 0))).toMatchObject({ ok: false, reason: { code: "NONFINITE" } });
    expect(computeQ(Number.NaN, Array.from({ length: 20 }, () => 1000))).toMatchObject({ ok: false, reason: { code: "NONFINITE" } });
  });

  it("computeU: A = 0 is A_ZERO, no epsilon", () => {
    expect(computeU(1.8, 0)).toMatchObject({ ok: false, reason: { code: "A_ZERO" } });
    expect(computeU(1.8, 0.6)).toMatchObject({ ok: true, value: 3 });
  });

  it("computeSigma: ddof=1 over exactly 60 prior changes", () => {
    const r = computeSigma(seriesWithSampleSd(60, 0.25));
    expect(r.ok && r.value.sigma).toBeCloseTo(0.25, 12);
    expect(r.ok && r.value.count).toBe(60);
  });

  it("computeSigma: 59/60 fails with a specific shortfall", () => {
    const r = computeSigma(seriesWithSampleSd(60, 0.25).slice(1));
    expect(r).toEqual({ ok: false, reason: { code: "INSUFFICIENT_SIGMA_HISTORY", detail: "59/60 valid prior changes" } });
    const withHole = seriesWithSampleSd(60, 0.25).map((v, i) => (i === 10 ? null : v));
    expect(computeSigma(withHole)).toMatchObject({ ok: false, reason: { detail: "59/60 valid prior changes" } });
  });

  it("computeSigma: constant series is ZERO_SIGMA", () => {
    expect(computeSigma(Array.from({ length: 60 }, () => 0.3))).toMatchObject({ ok: false, reason: { code: "ZERO_SIGMA" } });
  });

  it("scoreBothSides mirrors p across sides", () => {
    const r = scoreBothSides(0.6, 0.25, 0.22, 0.1);
    expect(r.ok && r.value.v).toBeCloseTo(2.4, 12);
    expect(r.ok && r.value.p.long).toBeCloseTo(2.2, 12);
    expect(r.ok && r.value.p.short).toBeCloseTo(-2.2, 12);
    expect(r.ok && r.value.S.long).toBeCloseTo(2.2, 12);
    expect(r.ok && r.value.S.short).toBeCloseTo(-2.2, 12);
  });

  it("qualify lists failed checks", () => {
    const e = qualify({ side: 1, S: 0.9, H: 0.3, closeT: ticks(100), closePrev: ticks(101), inputsValid: true });
    expect(e.qualifies).toBe(false);
    expect(e.failed).toEqual(["scoreAboveThreshold", "breadthDirection", "priceConfirmation"]);
    const okE = qualify({ side: 1, S: 1.01, H: 0.4, closeT: ticks(101), closePrev: ticks(100), inputsValid: true });
    expect(okE.qualifies).toBe(true);
    const border = qualify({ side: 1, S: 1.0, H: 0.4, closeT: ticks(101), closePrev: ticks(100), inputsValid: true });
    expect(border.failed).toEqual(["scoreAboveThreshold"]);
  });
});

describe("buildSignalSnapshot — acceptance check #2 (synthetic inputs)", () => {
  it("NQ long: u 3.0, v 2.4, p 2.2, S 2.2, long qualifies", () => {
    const s = buildSignalSnapshot(makeHistories({ breadth: breadth(60, 80, 20) }));
    expect(s.dataQuality.available).toBe(true);
    expect(s.Q).toBeCloseTo(1.8, 12);
    expect(s.A).toBeCloseTo(0.6, 12);
    expect(s.H).toBeCloseTo(0.6, 12);
    expect(s.u).toBeCloseTo(3.0, 12);
    expect(s.deltaU).toBeCloseTo(0.6, 12);
    expect(s.deltaH).toBeCloseTo(0.22, 12);
    expect(s.sigmaDeltaU).toBeCloseTo(0.25, 12);
    expect(s.sigmaDeltaH).toBeCloseTo(0.1, 12);
    expect(s.v).toBeCloseTo(2.4, 10);
    expect(s.p.long).toBeCloseTo(2.2, 10);
    expect(s.S.long).toBeCloseTo(2.2, 10);
    expect(s.S.short).toBeCloseTo(-2.2, 10);
    expect(s.qualifiedSide).toBe(1);
    expect(s.status).toBe("QUALIFIED");
    expect(s.displaySide).toBe("long");
    expect(s.displayScore).toBeCloseTo(2.2, 10);
    expect(s.eligibility.long.qualifies).toBe(true);
    expect(s.eligibility.short.qualifies).toBe(false);
    expect(s.modelVersion).toBe("0.1");
    expect(s.interval).toBe("daily");
    expect(s.raw.atr20Ticks).toBe(100);
    expect(s.inputSourceIds).toEqual(["synthetic-history:NQ"]);
    expect(s.dataSource.kind).toBe("fixture");
  });

  it("short mirror: H -0.60 / prev -0.38, down-bar => S 2.2, short qualifies", () => {
    const s = buildSignalSnapshot(
      makeHistories({ breadth: breadth(60, 20, 80), HPrev: -0.38, price: "21980", prevClose: "22000" }),
    );
    expect(s.H).toBeCloseTo(-0.6, 12);
    expect(s.p.short).toBeCloseTo(2.2, 10);
    expect(s.S.short).toBeCloseTo(2.2, 10);
    expect(s.S.long).toBeCloseTo(-2.2, 10);
    expect(s.qualifiedSide).toBe(-1);
    expect(s.displaySide).toBe("short");
    expect(s.status).toBe("QUALIFIED");
  });

  it("price confirmation failing leaves an otherwise strong long as WAIT", () => {
    const s = buildSignalSnapshot(makeHistories({ breadth: breadth(60, 80, 20), price: "21980", prevClose: "22000" }));
    expect(s.status).toBe("WAIT");
    expect(s.displaySide).toBe("long");
    expect(s.eligibility.long.failed).toEqual(["priceConfirmation"]);
  });

  it("H = 0 => NEUTRAL, no display score, both S in details", () => {
    const s = buildSignalSnapshot(makeHistories({ breadth: breadth(60, 40, 40), HPrev: 0 }));
    expect(s.dataQuality.available).toBe(true);
    expect(s.status).toBe("NEUTRAL");
    expect(s.displaySide).toBe("neutral");
    expect(s.displayScore).toBeNull();
    expect(s.S.long).toBeCloseTo(0, 12);
    expect(s.S.short).toBeCloseTo(0, 12);
  });

  it("weak unqualified long shows H-aligned side with possibly negative S", () => {
    // u drops: Q 0.9 => u 1.5 vs uPrev 2.4 => deltaU -0.9 => v -3.6
    const s = buildSignalSnapshot(makeHistories({ breadth: breadth(60, 80, 20), volumeT: 900 }));
    expect(s.status).toBe("WAIT");
    expect(s.displaySide).toBe("long");
    expect(s.displayScore).toBeCloseTo(-3.6, 10);
  });
});

describe("buildSignalSnapshot — unavailable reasons", () => {
  const base = () => makeHistories({ breadth: breadth(60, 80, 20) });

  it("INSUFFICIENT_VOLUME_HISTORY", () => {
    const s = buildSignalSnapshot({ ...base(), priorVolumes: Array.from({ length: 19 }, () => 1000) });
    expect(s.status).toBe("UNAVAILABLE");
    expect(s.Q).toBeNull();
    expect(s.dataQuality.reasons).toContainEqual({ code: "INSUFFICIENT_VOLUME_HISTORY", detail: "19/20 valid prior volumes" });
  });

  it("INSUFFICIENT_SIGMA_HISTORY (59/60)", () => {
    const s = buildSignalSnapshot({ ...base(), priorDeltaU: seriesWithSampleSd(60, 0.25).slice(1) });
    expect(s.status).toBe("UNAVAILABLE");
    expect(s.S.long).toBeNull();
    expect(s.dataQuality.reasons).toContainEqual({ code: "INSUFFICIENT_SIGMA_HISTORY", detail: "deltaU: 59/60 valid prior changes" });
  });

  it("ZERO_SIGMA", () => {
    const s = buildSignalSnapshot({ ...base(), priorDeltaH: Array.from({ length: 60 }, () => 0.01) });
    expect(s.status).toBe("UNAVAILABLE");
    expect(s.dataQuality.reasons.map((r) => r.code)).toContain("ZERO_SIGMA");
  });

  it("A_ZERO", () => {
    const s = buildSignalSnapshot(makeHistories({ breadth: breadth(0, 80, 20) }));
    expect(s.status).toBe("UNAVAILABLE");
    expect(s.A).toBe(0);
    expect(s.u).toBeNull();
    expect(s.dataQuality.reasons.map((r) => r.code)).toContain("A_ZERO");
  });

  it("COVERAGE_BELOW_95", () => {
    const b = adapter.compute(makeBreadthInput({ count: 90, aboveNormal: 50, advancing: 50, declining: 20, missing: 10 }));
    const s = buildSignalSnapshot(makeHistories({ breadth: b }));
    expect(s.status).toBe("UNAVAILABLE");
    expect(s.A).toBeNull();
    expect(s.Q).toBeCloseTo(1.8, 12);
    expect(s.dataQuality.reasons.map((r) => r.code)).toContain("COVERAGE_BELOW_95");
  });

  it("STALE", () => {
    const s = buildSignalSnapshot(makeHistories({ breadth: breadth(60, 80, 20), fresh: false, staleDetail: "bar older than cut-off" }));
    expect(s.status).toBe("UNAVAILABLE");
    expect(s.dataQuality.reasons).toContainEqual({ code: "STALE", detail: "bar older than cut-off" });
    // components still computed; only eligibility is blocked
    expect(s.S.long).toBeCloseTo(2.2, 10);
    expect(s.eligibility.long.qualifies).toBe(false);
    expect(s.eligibility.long.failed).toEqual(["inputsValid"]);
  });

  it("NONFINITE (missing previous u)", () => {
    const s = buildSignalSnapshot(makeHistories({ breadth: breadth(60, 80, 20), uPrev: null }));
    expect(s.status).toBe("UNAVAILABLE");
    expect(s.dataQuality.reasons.map((r) => r.code)).toContain("NONFINITE");
  });

  it("BREADTH_MODEL_UNDEFINED keeps Q, blanks A/H/u/S", () => {
    const s = buildSignalSnapshot(makeHistories({ root: "ZN", price: "110.5", prevClose: "110.25", breadth: undefinedBreadth("ZN") }));
    expect(s.status).toBe("UNAVAILABLE");
    expect(s.Q).toBeCloseTo(1.8, 12);
    expect(s.A).toBeNull();
    expect(s.H).toBeNull();
    expect(s.u).toBeNull();
    expect(s.S).toEqual({ long: null, short: null });
    expect(s.dataQuality.reasons).toEqual([expect.objectContaining({ code: "BREADTH_MODEL_UNDEFINED" })]);
  });

  it("INVALID_PRICE", () => {
    const s = buildSignalSnapshot({ ...base(), closePrev: null });
    expect(s.status).toBe("UNAVAILABLE");
    expect(s.dataQuality.reasons.map((r) => r.code)).toContain("INVALID_PRICE");
  });

  it("A_SMALL is a warning, not an exclusion", () => {
    const s = buildSignalSnapshot(makeHistories({ breadth: breadth(5, 80, 20), uPrev: 35 }));
    expect(s.dataQuality.available).toBe(true);
    expect(s.dataQuality.warnings.map((w) => w.code)).toEqual(["A_SMALL"]);
    expect(s.A).toBeCloseTo(0.05, 12);
  });
});
