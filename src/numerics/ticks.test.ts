import { describe, expect, it } from "vitest";
import {
  NumericError,
  absTicks,
  addTicks,
  decimalPlaces,
  fromTicks,
  subTicks,
  tickSize,
  ticks,
  ticksToDisplayNumber,
  toTicks,
} from "./ticks";

const QUARTER = tickSize(1, 4);
const TENTH = tickSize(1, 10);
const ONE = tickSize(1, 1);
const SIXTY_FOURTH = tickSize(1, 64);

describe("toTicks", () => {
  it("converts on-grid prices exactly", () => {
    expect(toTicks("22000.25", QUARTER, "exact")).toBe(88001);
    expect(toTicks(22000.25, QUARTER, "exact")).toBe(88001);
    expect(toTicks("2100.1", TENTH, "exact")).toBe(21001);
    expect(toTicks(2100.1, TENTH, "exact")).toBe(21001);
    expect(toTicks("42000", ONE, "exact")).toBe(42000);
    expect(toTicks("110.015625", SIXTY_FOURTH, "exact")).toBe(110 * 64 + 1);
  });

  it("floors and ceils off-grid prices on the tick grid", () => {
    expect(toTicks("21947.6", QUARTER, "floor")).toBe(21947.5 * 4);
    expect(toTicks("21947.6", QUARTER, "ceil")).toBe(21947.75 * 4);
    expect(toTicks("2100.16", TENTH, "floor")).toBe(21001);
    expect(toTicks("2100.16", TENTH, "ceil")).toBe(21002);
  });

  it("floor/ceil on negative values round toward -inf / +inf", () => {
    expect(toTicks("-0.3", QUARTER, "floor")).toBe(-2);
    expect(toTicks("-0.3", QUARTER, "ceil")).toBe(-1);
  });

  it("does not alter on-grid values under floor/ceil", () => {
    expect(toTicks("21947.5", QUARTER, "floor")).toBe(87790);
    expect(toTicks("21947.5", QUARTER, "ceil")).toBe(87790);
  });

  it("rejects off-grid prices in exact mode and invalid input", () => {
    expect(() => toTicks("22000.3", QUARTER, "exact")).toThrow(NumericError);
    expect(() => toTicks(Number.NaN, QUARTER, "floor")).toThrow(NumericError);
    expect(() => toTicks(Number.POSITIVE_INFINITY, QUARTER, "floor")).toThrow(NumericError);
    expect(() => toTicks("abc", QUARTER, "floor")).toThrow(NumericError);
  });
});

describe("fromTicks", () => {
  it("prints exact decimals", () => {
    expect(fromTicks(ticks(88001), QUARTER)).toBe("22000.25");
    expect(fromTicks(ticks(87790), QUARTER)).toBe("21947.50");
    expect(fromTicks(ticks(21001), TENTH)).toBe("2100.1");
    expect(fromTicks(ticks(42000), ONE)).toBe("42000");
    expect(fromTicks(ticks(110 * 64 + 1), SIXTY_FOURTH)).toBe("110.015625");
    expect(fromTicks(ticks(-2), QUARTER)).toBe("-0.50");
  });

  it("round-trips through toTicks exact", () => {
    for (const t of [0, 1, 87790, 88001, -3]) {
      expect(toTicks(fromTicks(ticks(t), QUARTER), QUARTER, "exact")).toBe(t);
      expect(toTicks(fromTicks(ticks(t), SIXTY_FOURTH), SIXTY_FOURTH, "exact")).toBe(t);
    }
  });

  it("computes decimal places from tick size", () => {
    expect(decimalPlaces(QUARTER)).toBe(2);
    expect(decimalPlaces(TENTH)).toBe(1);
    expect(decimalPlaces(ONE)).toBe(0);
    expect(decimalPlaces(SIXTY_FOURTH)).toBe(6);
    expect(() => decimalPlaces(tickSize(1, 3))).toThrow(NumericError);
  });

  it("display number is for display only", () => {
    expect(ticksToDisplayNumber(ticks(88001), QUARTER)).toBe(22000.25);
  });
});

describe("tick arithmetic", () => {
  it("adds, subtracts, abs as integers", () => {
    expect(addTicks(ticks(5), ticks(-7))).toBe(-2);
    expect(subTicks(ticks(88001), ticks(87791))).toBe(210);
    expect(absTicks(ticks(-210))).toBe(210);
  });

  it("rejects non-integers", () => {
    expect(() => ticks(1.5)).toThrow(NumericError);
    expect(() => ticks(Number.NaN)).toThrow(NumericError);
    expect(() => tickSize(0, 4)).toThrow(NumericError);
  });
});
