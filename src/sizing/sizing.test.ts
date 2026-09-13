import { describe, expect, it } from "vitest";
import { modelConfig } from "../config/modelConfig";
import { INSTRUMENTS } from "../instruments/metadata";
import { mils } from "../numerics/money";
import { toTicks, type Ticks } from "../numerics/ticks";
import { initialStop, stopDistance } from "../stops/stops";
import { MARGIN_NOTE, modeledEntryFill, modeledStopExitFill, perContractRisk, positionSize, riskBudget } from "./sizing";

const NQ = INSTRUMENTS.NQ;
const px = (s: string): Ticks => toTicks(s, NQ.tick, "exact");
const cost = modelConfig.costs.NQ;
const T0 = "2026-01-02T21:05:00Z";

function d(atr: number, H: number, side: 1 | -1) {
  const r = stopDistance(atr, H, side);
  if (!r.ok) throw new Error(r.reason.detail);
  return r.value;
}

describe("worked long example (synthetic inputs)", () => {
  const entry = modeledEntryFill(px("22000"), 1, cost);
  const stop = initialStop({ side: 1, entryFill: entry, distance: d(100, 0.6, 1), calculatedAt: T0 });
  const exit = modeledStopExitFill(stop.stop, 1, cost);
  const risk = perContractRisk({ entryFill: entry, stopExitFill: exit.fill, tickValueMils: NQ.tickValueMils, cost });

  it("entry 22000.25, stop 21947.75, exit 21947.50", () => {
    expect(entry).toBe(px("22000.25"));
    expect(stop.stop).toBe(px("21947.75"));
    expect(exit).toEqual({ fill: px("21947.50"), model: "touched-stop" });
  });

  it("per-contract risk 1,060,000 mils (211 ticks x 5000 + 2 x 2500)", () => {
    expect(risk.distanceTicks).toBe(211);
    expect(risk.priceRiskMils).toBe(1_055_000);
    expect(risk.feesMils).toBe(5000);
    expect(risk.totalMils).toBe(1_060_000);
    expect(risk.costConvention).toBe("fixture: fee 2.50 per contract per side, spread 0 ticks, adverse 1 tick per fill");
  });

  it("budget 2,500,000 mils => 2 contracts, planned loss 2,120,000 = 0.212% of equity", () => {
    const equity = modelConfig.paperEquityStartMils;
    expect(riskBudget(equity)).toBe(2_500_000);
    const size = positionSize({ equityMils: equity, perContractRiskMils: risk.totalMils });
    expect(size.contracts).toBe(2);
    expect(size.budgetMils).toBe(2_500_000);
    expect(size.plannedLossMils).toBe(2_120_000);
    expect(size.plannedLossPctOfEquity).toBeCloseTo(0.00212, 12);
    expect(size.skip).toBe(false);
    expect(size.skipReason).toBeNull();
    expect(size.marginNote).toBe("Margin constraint not modeled");
    expect(MARGIN_NOTE).toBe("Margin constraint not modeled");
  });

  it("gap-open exit fill uses the open as reference plus the adverse tick", () => {
    expect(modeledStopExitFill(stop.stop, 1, cost, px("21900"))).toEqual({ fill: px("21899.75"), model: "gap-open" });
  });
});

describe("short mirror (synthetic inputs)", () => {
  it("entry 21999.75, stop 22052.25, exit 22052.50, risk 1,060,000 mils", () => {
    const entry = modeledEntryFill(px("22000"), -1, cost);
    expect(entry).toBe(px("21999.75"));
    const stop = initialStop({ side: -1, entryFill: entry, distance: d(100, -0.6, -1), calculatedAt: T0 });
    expect(stop.stop).toBe(px("22052.25"));
    const exit = modeledStopExitFill(stop.stop, -1, cost);
    expect(exit.fill).toBe(px("22052.50"));
    const risk = perContractRisk({ entryFill: entry, stopExitFill: exit.fill, tickValueMils: NQ.tickValueMils, cost });
    expect(risk.totalMils).toBe(1_060_000);
    expect(modeledStopExitFill(stop.stop, -1, cost, px("22100"))).toEqual({ fill: px("22100.25"), model: "gap-open" });
  });
});

describe("positionSize edge cases", () => {
  it("qty 0 => skip with reason", () => {
    const size = positionSize({ equityMils: mils(400_000_000), perContractRiskMils: mils(1_060_000) });
    expect(size.budgetMils).toBe(1_000_000);
    expect(size.contracts).toBe(0);
    expect(size.skip).toBe(true);
    expect(size.skipReason).toBe("one contract risks 1,060.00, above the 1,000.00 budget");
    expect(size.plannedLossMils).toBe(0);
    expect(size.marginNote).toBe(MARGIN_NOTE);
  });

  it("non-positive per-contract risk is skipped, never divided", () => {
    const size = positionSize({ equityMils: mils(1_000_000_000), perContractRiskMils: mils(0) });
    expect(size.skip).toBe(true);
    expect(size.contracts).toBe(0);
  });

  it("budget uses integer arithmetic (no float drift)", () => {
    expect(riskBudget(mils(1_000_000_000))).toBe(2_500_000);
    expect(riskBudget(mils(999_999))).toBe(2_499); // floor(999999 x 0.0025 = 2499.9975)
    expect(riskBudget(mils(0))).toBe(0);
  });

  it("ZN tick value stays exact in risk: 211 ticks x 15625 + 5000", () => {
    const risk = perContractRisk({ entryFill: toTicks("110.5", INSTRUMENTS.ZN.tick, "exact"), stopExitFill: toTicks("110.5", INSTRUMENTS.ZN.tick, "exact") + 211 as Ticks, tickValueMils: INSTRUMENTS.ZN.tickValueMils, cost: modelConfig.costs.ZN });
    expect(risk.priceRiskMils).toBe(211 * 15625);
    expect(risk.totalMils).toBe(211 * 15625 + 5000);
  });
});
