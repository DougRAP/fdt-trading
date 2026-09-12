import { describe, expect, it } from "vitest";
import { EquityConstituentAdapter, UndefinedBreadthAdapter, undefinedBreadth } from "./BreadthAdapter";
import { makeBreadthInput } from "../fixtures/histories";

const adapter = new EquityConstituentAdapter("test-constituents");

describe("EquityConstituentAdapter", () => {
  it("computes A = 0.6 and H = 0.6 from 100 constituents (60 above-normal, 80 up, 20 down)", () => {
    const r = adapter.compute(makeBreadthInput({ count: 100, aboveNormal: 60, advancing: 80, declining: 20 }));
    expect(r.valid).toBe(true);
    expect(r.A).toBeCloseTo(0.6, 12);
    expect(r.H).toBeCloseTo(0.6, 12);
    expect(r.coverage).toBe(1);
    expect(r.validCount).toBe(100);
    expect(r.source).toBe("test-constituents");
    expect(r.definitionVersion).toBe("equity-constituent-0.1");
  });

  it("keeps unchanged constituents in the denominator", () => {
    const r = adapter.compute(makeBreadthInput({ count: 100, aboveNormal: 10, advancing: 30, declining: 20 }));
    expect(r.H).toBeCloseTo(0.1, 12);
  });

  it("excludes missing constituents and reports them; coverage still >= 95% passes", () => {
    const r = adapter.compute(makeBreadthInput({ count: 96, aboveNormal: 48, advancing: 48, declining: 48, missing: 4 }));
    expect(r.valid).toBe(true);
    expect(r.coverage).toBe(0.96);
    expect(r.exclusions).toHaveLength(4);
    expect(r.exclusions[0]?.reason).toMatch(/missing/);
    expect(r.H).toBe(0);
  });

  it("fails with COVERAGE_BELOW_95 when too many are missing", () => {
    const r = adapter.compute(makeBreadthInput({ count: 94, aboveNormal: 10, advancing: 10, declining: 10, missing: 6 }));
    expect(r.valid).toBe(false);
    expect(r.A).toBeNull();
    expect(r.H).toBeNull();
    expect(r.reasons[0]?.code).toBe("COVERAGE_BELOW_95");
    expect(r.reasons[0]?.detail).toMatch(/94\/100/);
  });

  it("excludes constituents with short volume history", () => {
    const input = makeBreadthInput({ count: 100, aboveNormal: 50, advancing: 50, declining: 50 });
    const short = { ...input.constituents[0]!, priorVolumes: input.constituents[0]!.priorVolumes.slice(0, 19) };
    const r = adapter.compute({ ...input, constituents: [short, ...input.constituents.slice(1)] });
    expect(r.validCount).toBe(99);
    expect(r.exclusions[0]?.reason).toMatch(/prior volumes/);
  });

  it("unknown universe is a coverage failure", () => {
    const input = makeBreadthInput({ count: 10, aboveNormal: 5, advancing: 5, declining: 5 });
    const r = adapter.compute({ ...input, universeCount: 0 });
    expect(r.valid).toBe(false);
    expect(r.reasons[0]?.code).toBe("COVERAGE_BELOW_95");
  });

  it("A = 0 is a valid breadth result (u handles the zero)", () => {
    const r = adapter.compute(makeBreadthInput({ count: 100, aboveNormal: 0, advancing: 50, declining: 50 }));
    expect(r.valid).toBe(true);
    expect(r.A).toBe(0);
  });
});

describe("UndefinedBreadthAdapter", () => {
  it("returns BREADTH_MODEL_UNDEFINED with blank A/H", () => {
    const r = new UndefinedBreadthAdapter("ZN").compute({ universeCount: 0, constituents: [] });
    expect(r.valid).toBe(false);
    expect(r.A).toBeNull();
    expect(r.H).toBeNull();
    expect(r.reasons).toEqual([expect.objectContaining({ code: "BREADTH_MODEL_UNDEFINED" })]);
    expect(r.reasons[0]?.detail).toMatch(/ZN/);
    expect(undefinedBreadth("GC").reasons[0]?.detail).toMatch(/GC/);
  });
});
