import { describe, expect, it } from "vitest";
import { recordEntryFill } from "../campaign/manual";
import { modelConfig } from "../config/modelConfig";
import { fixtureSnapshots } from "../fixtures/snapshots";
import { INSTRUMENTS } from "../instruments/metadata";
import { Ledger } from "../ledger/ledger";
import { MemoryStorage } from "../ledger/storage";
import { mils } from "../numerics/money";
import { toTicks } from "../numerics/ticks";
import { fixtureSnapshotHistory, fixtureSnapshotsByBar } from "../fixtures/snapshotHistory";
import type { InterpreterResponse } from "../interpreter/types";
import { askModel } from "../paper/modelEngine";
import { CONFIG_KEY, MODE_LABELS, MODE_NOTICES, applyOverrides, loadConfig, modelReadingFrom, noticeForModelResult, overridesOf, saveConfig } from "./store";

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

describe("model store mappers and askModel through a fake interpreter", () => {
  const nq = fixtureSnapshots().find((s) => s.root === "NQ")!;
  const history = fixtureSnapshotHistory();
  const response: InterpreterResponse = {
    promptVersion: modelConfig.interpreter.promptVersion,
    readings: (["NQ", "ES", "RTY", "YM", "ZN", "GC"] as const).map((root) => ({
      root,
      activity: "building" as const,
      breadth: "broadening" as const,
      priceResponse: "responding" as const,
      noiseFlag: false,
      evidence: [`${root} read`],
    })),
    crossMarket: { summary: "NQ leads.", supports: [], contradicts: [] },
    hypothesis: "Participation is building in NQ.",
    proposal: { action: "enter", root: "NQ", side: 1, entryZone: null, stopTicks: 87900, invalidation: [], rationale: "builds" },
    evidenceStrength: "moderate",
  };

  /** The store's async actions need a React renderer; the engine call they wrap is exercised here. */
  it("askModel records the reading in the manual ledger and the mappers describe it without executing", async () => {
    const ledger = new Ledger("manual");
    const calls: string[] = [];
    const result = await askModel(ledger, {
      interpreter: async (body) => {
        calls.push(body.kind);
        return {
          ok: true,
          kind: body.kind,
          response,
          usage: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 20 },
          model: modelConfig.interpreter.model,
          latencyMs: 900,
          costEstimateMils: 3000,
          promptVersion: modelConfig.interpreter.promptVersion,
        };
      },
      histories: history,
      snapshotsByBar: fixtureSnapshotsByBar(),
    });
    expect(calls).toEqual(["interpret"]);
    expect(result.kind).toBe("advisory");
    expect(ledger.campaigns).toEqual([]);
    expect(ledger.events.map((e) => e.type)).toEqual(["INTERPRETER_REQUEST", "INTERPRETER_RESPONSE"]);

    const reading = modelReadingFrom("manual", result, "2026-01-02T21:10:00Z");
    expect(reading).toMatchObject({ mode: "manual", kind: "advisory", barEnd: nq.barEnd, at: "2026-01-02T21:10:00Z" });
    expect(reading.response?.proposal.action).toBe("enter");
    expect(reading.clamped).toMatchObject({ action: "enter", root: "NQ", stopTicks: 87900 });
    expect(noticeForModelResult(result)).toBe("Model reading recorded in this ledger. Nothing was executed; record your own fills.");
  });

  it("every result kind has a notice that never claims an unexecuted proposal was acted on", () => {
    const base = { events: [], request: null, response: null, clamped: null, reasons: ["no stop distance available"], campaignId: "paperModel:NQ:1", usage: null, costEstimateMils: null };
    const kinds = ["queued", "advisory", "no-proposal", "not-executable", "rejected", "call-failed", "already-answered", "position-active", "paused"] as const;
    for (const kind of kinds) {
      const text = noticeForModelResult({ ...base, kind });
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/confidence|probabilit/i);
      if (kind === "not-executable" || kind === "rejected") expect(text).toMatch(/not executed|refused/);
    }
    expect(MODE_LABELS).toEqual({ manual: "Manual journal", paper: "Paper (rules)", paperModel: "Paper (model)" });
    expect(MODE_NOTICES.paperModel).toMatch(/risk engine clamps/);
  });
});
