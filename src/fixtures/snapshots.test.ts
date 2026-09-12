import { describe, expect, it } from "vitest";
import { FIXTURE_INPUTS, fixtureSnapshots } from "./snapshots";

describe("fixture snapshots (mockup values, synthetic)", () => {
  const byRoot = Object.fromEntries(fixtureSnapshots().map((s) => [s.root, s]));

  it("covers all six roots and is labeled fixture", () => {
    expect(FIXTURE_INPUTS.map((i) => i.root)).toEqual(["NQ", "ES", "RTY", "YM", "ZN", "GC"]);
    for (const s of Object.values(byRoot)) {
      expect(s.dataSource.kind).toBe("fixture");
      expect(s.dataSource.label).toMatch(/ILLUSTRATIVE/);
      expect(s.modelVersion).toBe("0.1");
      expect(s.inputSourceIds).toContain("fixture:sigma-constants:synthetic");
    }
  });

  it("NQ matches acceptance check #2: u 3.0, v 2.4, p 2.2, S 2.2, long qualifies, ATR 25 pts = 100 ticks", () => {
    const nq = byRoot.NQ!;
    expect(nq.u).toBeCloseTo(3.0, 12);
    expect(nq.v).toBeCloseTo(2.4, 12);
    expect(nq.p.long).toBeCloseTo(2.2, 12);
    expect(nq.S.long).toBeCloseTo(2.2, 12);
    expect(nq.status).toBe("QUALIFIED");
    expect(nq.qualifiedSide).toBe(1);
    expect(nq.raw.atr20Ticks).toBe(100);
    expect(nq.raw.closeT).toBe(88000);
    expect(nq.raw.closePrev).toBe(87920);
  });

  it("ES qualifies long with S 1.6", () => {
    const es = byRoot.ES!;
    expect(es.u).toBeCloseTo(2.4, 12);
    expect(es.S.long).toBeCloseTo(1.6, 12);
    expect(es.status).toBe("QUALIFIED");
  });

  it("RTY is a down-bar short candidate below threshold (WAIT, S 0.6)", () => {
    const rty = byRoot.RTY!;
    expect(rty.u).toBeCloseTo(2.0, 12);
    expect(rty.displaySide).toBe("short");
    expect(rty.displayScore).toBeCloseTo(0.6, 12);
    expect(rty.status).toBe("WAIT");
    expect(rty.eligibility.short.checks.priceConfirmation).toBe(true);
    expect(rty.eligibility.short.failed).toEqual(["scoreAboveThreshold"]);
  });

  it("YM is WAIT with S 0.2 and breadth below 0.40", () => {
    const ym = byRoot.YM!;
    expect(ym.u).toBeCloseTo(1.5, 12);
    expect(ym.displayScore).toBeCloseTo(0.2, 10);
    expect(ym.status).toBe("WAIT");
    expect(ym.eligibility.long.failed).toEqual(["scoreAboveThreshold", "breadthDirection"]);
  });

  it("ZN and GC carry Q only; A/H/u/S blank; BREADTH_MODEL_UNDEFINED; excluded from selection", () => {
    for (const root of ["ZN", "GC"] as const) {
      const s = byRoot[root]!;
      expect(s.Q).toBe(root === "ZN" ? 1.4 : 1.2);
      expect(s.A).toBeNull();
      expect(s.H).toBeNull();
      expect(s.u).toBeNull();
      expect(s.S).toEqual({ long: null, short: null });
      expect(s.status).toBe("UNAVAILABLE");
      expect(s.qualifiedSide).toBeNull();
      expect(s.displaySide).toBeNull();
      expect(s.dataQuality.reasons).toEqual([expect.objectContaining({ code: "BREADTH_MODEL_UNDEFINED" })]);
    }
  });

  it("price-confirmation direction: NQ/ES/YM up-bars, RTY down-bar", () => {
    expect(byRoot.NQ!.raw.closeT! > byRoot.NQ!.raw.closePrev!).toBe(true);
    expect(byRoot.ES!.raw.closeT! > byRoot.ES!.raw.closePrev!).toBe(true);
    expect(byRoot.YM!.raw.closeT! > byRoot.YM!.raw.closePrev!).toBe(true);
    expect(byRoot.RTY!.raw.closeT! < byRoot.RTY!.raw.closePrev!).toBe(true);
  });
});
