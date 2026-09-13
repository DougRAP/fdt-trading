import { describe, expect, it } from "vitest";
import { recordEntryFill } from "../campaign/manual";
import { modelConfig } from "../config/modelConfig";
import { fixtureSnapshots } from "../fixtures/snapshots";
import { INSTRUMENTS } from "../instruments/metadata";
import { Ledger } from "../ledger/ledger";
import { MemoryStorage } from "../ledger/storage";
import { mils } from "../numerics/money";
import { toTicks } from "../numerics/ticks";
import { CONFIG_KEY, applyOverrides, loadConfig, overridesOf, saveConfig } from "./store";

describe("versioned model settings (labels travel with the frozen config)", () => {
  it("saving twice yields 0.1+user2 and the label is the config version; the base model version stays 0.1", () => {
    const storage = new MemoryStorage();
    const first = saveConfig(storage, { ...overridesOf(modelConfig), entryThreshold: 1.1 }, modelConfig.version);
    expect(first.label).toBe("0.1+user1");
    expect(first.cfg.version).toBe("0.1+user1");
    const second = saveConfig(storage, { ...overridesOf(modelConfig), entryThreshold: 1.2 }, first.label);
    expect(second.label).toBe("0.1+user2");
    expect(second.cfg.version).toBe("0.1+user2");
    expect(second.cfg.entryThreshold).toBe(1.2);
    expect(modelConfig.version).toBe("0.1");
    expect(applyOverrides(overridesOf(modelConfig)).version).toBe("0.1");
    const reloaded = loadConfig(storage);
    expect(reloaded.error).toBeNull();
    expect(reloaded.label).toBe("0.1+user2");
    expect(reloaded.cfg.version).toBe("0.1+user2");
    expect(reloaded.cfg.entryThreshold).toBe(1.2);
    expect(storage.getItem(CONFIG_KEY)).toContain('"label":"0.1+user2"');
  });

  it("a campaign entered under saved settings freezes the full label", () => {
    const storage = new MemoryStorage();
    saveConfig(storage, overridesOf(modelConfig), modelConfig.version);
    const { cfg } = saveConfig(storage, overridesOf(modelConfig), "0.1+user1");
    const snapshot = fixtureSnapshots(cfg).find((s) => s.root === "NQ")!;
    const ledger = new Ledger("manual");
    const px = (s: string) => toTicks(s, INSTRUMENTS.NQ.tick, "exact");
    ledger.appendAll(
      recordEntryFill({
        id: "m1",
        campaignId: "manual:NQ:1",
        root: "NQ",
        side: 1,
        snapshot,
        planned: { side: 1, entry: px("22000.25"), stop: px("21947.75"), contracts: 1 },
        fill: { price: px("22000.25"), quantity: 1, filledAt: "2026-01-05T14:31:00Z", timezone: "UTC", feesMils: mils(2500) },
        equityMils: mils(0),
        recordedAt: "2026-01-05T14:35:00Z",
        cfg,
      }),
    );
    expect(ledger.activeCampaign?.frozenConfig.version).toBe("0.1+user2");
    expect(ledger.activeCampaign?.frozenSnapshot.modelVersion).toBe("0.1+user2");
  });

  it("corrupt stored settings fall back to defaults with an error message", () => {
    const storage = new MemoryStorage();
    storage.setItem(CONFIG_KEY, "{nope");
    const r = loadConfig(storage);
    expect(r.cfg).toBe(modelConfig);
    expect(r.error).toMatch(/not valid JSON/);
  });
});
