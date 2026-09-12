import { describe, expect, it } from "vitest";
import { NotImplementedError, ticks, tickSize } from "../numerics/ticks";
import { INSTRUMENTS, INSTRUMENT_LIST, format32nds, getInstrument, parse32nds } from "./metadata";

describe("instrument metadata (fixture)", () => {
  it("lists all six roots in brief order with synthetic contract labels", () => {
    expect(INSTRUMENT_LIST.map((i) => i.root)).toEqual(["NQ", "ES", "RTY", "YM", "ZN", "GC"]);
    for (const i of INSTRUMENT_LIST) {
      expect(i.contract).toBe(`${i.root} · SYNTHETIC`);
      expect(i.metadataSource).toBe("fixture");
      expect(i.expiry).toBeNull();
      expect(i.currency).toBe("USD");
    }
  });

  it("has the expected tick sizes, multipliers and tick values", () => {
    expect(INSTRUMENTS.NQ.tick).toEqual({ numerator: 1, denominator: 4 });
    expect(INSTRUMENTS.NQ.multiplier).toBe(20);
    expect(INSTRUMENTS.NQ.tickValueMils).toBe(5000);
    expect(INSTRUMENTS.ES.tickValueMils).toBe(12500);
    expect(INSTRUMENTS.RTY.tick).toEqual({ numerator: 1, denominator: 10 });
    expect(INSTRUMENTS.RTY.tickValueMils).toBe(5000);
    expect(INSTRUMENTS.YM.tick).toEqual({ numerator: 1, denominator: 1 });
    expect(INSTRUMENTS.YM.tickValueMils).toBe(5000);
    expect(INSTRUMENTS.ZN.tick).toEqual({ numerator: 1, denominator: 64 });
    expect(INSTRUMENTS.ZN.multiplier).toBe(1000);
    expect(INSTRUMENTS.ZN.tickValueMils).toBe(15625);
    expect(INSTRUMENTS.GC.tick).toEqual({ numerator: 1, denominator: 10 });
    expect(INSTRUMENTS.GC.tickValueMils).toBe(10000);
    expect(getInstrument("ZN").quoteFormat).toBe("32nds");
  });

  it("32nds parser/formatter are labeled stubs that throw", () => {
    expect(() => parse32nds("110'165", tickSize(1, 64))).toThrow(NotImplementedError);
    expect(() => format32nds(ticks(7041), tickSize(1, 64))).toThrow(NotImplementedError);
  });
});
