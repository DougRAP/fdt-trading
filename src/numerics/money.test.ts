import { describe, expect, it } from "vitest";
import { NumericError, ticks } from "./ticks";
import {
  addMils,
  compareMils,
  dollarsToMils,
  floorDivMils,
  formatMils,
  mils,
  milsToCents,
  milsToDollarsExact,
  mulMilsInt,
  subMils,
  sumMils,
  ticksToMils,
} from "./money";
import { INSTRUMENTS } from "../instruments/metadata";

describe("dollarsToMils", () => {
  it("parses exact dollars", () => {
    expect(dollarsToMils("2.50")).toBe(2500);
    expect(dollarsToMils(2.5)).toBe(2500);
    expect(dollarsToMils("15.625")).toBe(15625);
    expect(dollarsToMils("-1060")).toBe(-1_060_000);
    expect(dollarsToMils(1_000_000)).toBe(1_000_000_000);
  });

  it("rejects sub-mil precision and invalid values", () => {
    expect(() => dollarsToMils("0.0001")).toThrow(NumericError);
    expect(() => dollarsToMils(Number.NaN)).toThrow(NumericError);
    expect(() => dollarsToMils("$5")).toThrow(NumericError);
  });
});

describe("ticksToMils", () => {
  it("NQ: 210 ticks (52.5 pts) x $5/tick = $1,050", () => {
    expect(ticksToMils(ticks(210), INSTRUMENTS.NQ.tickValueMils)).toBe(1_050_000);
  });

  it("NQ: 211 ticks (52.75 pts) x $5/tick x 2 contracts = $2,110", () => {
    expect(ticksToMils(ticks(211), INSTRUMENTS.NQ.tickValueMils, 2)).toBe(2_110_000);
  });

  it("ZN: 1 tick = $15.625 exactly, 3 ticks = $46.875", () => {
    expect(ticksToMils(ticks(1), INSTRUMENTS.ZN.tickValueMils)).toBe(15625);
    expect(ticksToMils(ticks(3), INSTRUMENTS.ZN.tickValueMils)).toBe(46875);
  });

  it("keeps sign of tick distance", () => {
    expect(ticksToMils(ticks(-4), INSTRUMENTS.ES.tickValueMils)).toBe(-50000);
  });

  it("tick value equals multiplier x tick size for every instrument", () => {
    for (const inst of Object.values(INSTRUMENTS)) {
      const expected = (inst.multiplier * inst.tick.numerator * 1000) / inst.tick.denominator;
      expect(Number.isInteger(expected)).toBe(true);
      expect(inst.tickValueMils).toBe(expected);
    }
  });
});

describe("mils arithmetic", () => {
  it("adds, subtracts, multiplies by integers, sums, compares", () => {
    expect(addMils(mils(2500), mils(2500))).toBe(5000);
    expect(subMils(mils(1000), mils(2500))).toBe(-1500);
    expect(mulMilsInt(mils(2500), 2)).toBe(5000);
    expect(sumMils([mils(1), mils(2), mils(3)])).toBe(6);
    expect(compareMils(mils(1), mils(2))).toBe(-1);
    expect(compareMils(mils(2), mils(2))).toBe(0);
  });

  it("rejects non-integer mils", () => {
    expect(() => mils(0.5)).toThrow(NumericError);
    expect(() => mulMilsInt(mils(10), 1.5)).toThrow(NumericError);
  });

  it("floorDivMils gives integer contract counts", () => {
    expect(floorDivMils(mils(2_500_000), mils(1_060_000))).toBe(2);
    expect(floorDivMils(mils(1_000_000), mils(1_060_000))).toBe(0);
    expect(() => floorDivMils(mils(1), mils(0))).toThrow(NumericError);
  });
});

describe("formatting", () => {
  it("rounds to cents half away from zero", () => {
    expect(milsToCents(mils(15625))).toBe(1563);
    expect(milsToCents(mils(15624))).toBe(1562);
    expect(milsToCents(mils(-15625))).toBe(-1563);
    expect(milsToCents(mils(-15624))).toBe(-1562);
  });

  it("exact dollars string keeps 3 places", () => {
    expect(milsToDollarsExact(mils(15625))).toBe("15.625");
    expect(milsToDollarsExact(mils(-5000))).toBe("-5.000");
  });

  it("formats with thousands separators and cents", () => {
    expect(formatMils(mils(1_060_000))).toBe("1,060.00");
    expect(formatMils(mils(-5000))).toBe("-5.00");
    expect(formatMils(mils(0))).toBe("0.00");
    expect(formatMils(mils(15625))).toBe("15.63");
    expect(formatMils(mils(1_000_000_000))).toBe("1,000,000.00");
    expect(formatMils(mils(2500), { signed: true })).toBe("+2.50");
    expect(formatMils(mils(2_070_000), { signed: true })).toBe("+2,070.00");
    expect(formatMils(mils(0), { signed: true })).toBe("0.00");
    expect(formatMils(mils(1_060_000))).not.toContain("$");
  });
});
