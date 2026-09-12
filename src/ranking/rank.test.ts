import { describe, expect, it } from "vitest";
import { buildFixtureSnapshot, fixtureSnapshots } from "../fixtures/snapshots";
import { rankSnapshots, topQualified } from "./rank";

describe("rankSnapshots on fixture snapshots", () => {
  it("orders qualified by S desc, then unqualified by displayed S desc, then unavailable unranked", () => {
    const ranked = rankSnapshots(fixtureSnapshots());
    expect(ranked.map((e) => e.root)).toEqual(["NQ", "ES", "RTY", "YM", "GC", "ZN"]);
    expect(ranked.map((e) => e.group)).toEqual([
      "qualified",
      "qualified",
      "unqualified",
      "unqualified",
      "unavailable",
      "unavailable",
    ]);
    expect(ranked.map((e) => e.rank)).toEqual([1, 2, 3, 4, null, null]);
    expect(ranked[0]?.score).toBeCloseTo(2.2, 10);
    expect(ranked[1]?.score).toBeCloseTo(1.6, 10);
    expect(ranked[2]?.score).toBeCloseTo(0.6, 10);
    expect(ranked[3]?.score).toBeCloseTo(0.2, 10);
  });

  it("topQualified returns NQ; none => null (no forced trading)", () => {
    expect(topQualified(fixtureSnapshots())?.root).toBe("NQ");
    const weak = fixtureSnapshots().filter((s) => s.status !== "QUALIFIED");
    expect(topQualified(weak)).toBeNull();
  });

  it("neutral sorts after unqualified, before unavailable, unranked", () => {
    const neutral = buildFixtureSnapshot({ root: "ES", q: 1.5, a: 0.625, uPrev: 2, h: 0, hPrev: 0, price: "6000", prevClose: "5990", atr: "8" });
    const others = fixtureSnapshots().filter((s) => s.root !== "ES");
    const ranked = rankSnapshots([neutral, ...others]);
    expect(ranked.map((e) => e.root)).toEqual(["NQ", "RTY", "YM", "ES", "GC", "ZN"]);
    expect(ranked[3]?.group).toBe("neutral");
    expect(ranked[3]?.rank).toBeNull();
  });

  it("ties break alphabetically by root", () => {
    const a = buildFixtureSnapshot({ root: "YM", q: 1.8, a: 0.6, uPrev: 2.4, h: 0.6, hPrev: 0.38, price: "42000", prevClose: "41900", atr: "90" });
    const b = buildFixtureSnapshot({ root: "ES", q: 1.8, a: 0.6, uPrev: 2.4, h: 0.6, hPrev: 0.38, price: "6000", prevClose: "5990", atr: "8" });
    expect(rankSnapshots([a, b]).map((e) => e.root)).toEqual(["ES", "YM"]);
  });

  it("a qualified score below an unqualified score still ranks first", () => {
    // ES: u 2.4, uPrev 2.1 => v 1.2; p 1.8 => S 1.2, H 0.48 => qualifies
    const q = buildFixtureSnapshot({ root: "ES", q: 1.5, a: 0.625, uPrev: 2.1, h: 0.48, hPrev: 0.3, price: "6000", prevClose: "5990", atr: "8" });
    expect(q.status).toBe("QUALIFIED");
    expect(q.displayScore).toBeCloseTo(1.2, 10);
    // YM: u 4, uPrev 1 => v 12; p 2.0 => S 2.0, but H 0.3 < 0.40 => WAIT
    const weakBreadth = buildFixtureSnapshot({ root: "YM", q: 2, a: 0.5, uPrev: 1, h: 0.3, hPrev: 0.1, price: "42000", prevClose: "41900", atr: "90" });
    expect(weakBreadth.status).toBe("WAIT");
    expect(weakBreadth.displayScore).toBeCloseTo(2.0, 10);
    const ranked = rankSnapshots([weakBreadth, q]);
    expect(ranked.map((e) => e.root)).toEqual(["ES", "YM"]);
    expect(ranked.map((e) => e.rank)).toEqual([1, 2]);
  });
});
