import { describe, expect, it } from "vitest";
import { freezeModelConfig, modelConfig } from "./modelConfig";

describe("modelConfig v0.1", () => {
  it("carries the ticketed parameters", () => {
    expect(modelConfig.version).toBe("0.1");
    expect(modelConfig.volumeWindow).toBe(20);
    expect(modelConfig.sigmaWindow).toBe(60);
    expect(modelConfig.entryThreshold).toBe(1.0);
    expect(modelConfig.breadthThreshold).toBe(0.4);
    expect(modelConfig.atrWindow).toBe(20);
    expect(modelConfig.stopBase).toBe(1.5);
    expect(modelConfig.riskBudgetPct).toBe(0.0025);
    expect(modelConfig.paperEquityStartMils).toBe(1_000_000_000);
    expect(modelConfig.aSmallWarn.value).toBe(0.1);
    expect(modelConfig.aSmallWarn.label).toMatch(/research parameter/i);
    expect(modelConfig.interval).toBe("daily");
  });

  it("cost fixture per D4 for every root", () => {
    for (const root of ["NQ", "ES", "RTY", "YM", "ZN", "GC"] as const) {
      const c = modelConfig.costs[root];
      expect(c.feePerContractPerSideMils).toBe(2500);
      expect(c.spreadTicks).toBe(0);
      expect(c.adverseTicksPerFill).toBe(1);
      expect(c.source).toBe("fixture");
    }
  });

  it("only daily interval is enabled; disabled options carry a reason", () => {
    const enabled = modelConfig.intervalOptions.filter((o) => o.enabled).map((o) => o.id);
    expect(enabled).toEqual(["daily"]);
    for (const o of modelConfig.intervalOptions.filter((o) => !o.enabled)) {
      expect(o.disabledReason).toBeTruthy();
    }
  });

  it("frozen copy is independent of the live config", () => {
    const frozen = freezeModelConfig();
    expect(frozen).toEqual(modelConfig);
    expect(frozen).not.toBe(modelConfig);
    expect(Object.isFrozen(frozen)).toBe(true);
  });
});
