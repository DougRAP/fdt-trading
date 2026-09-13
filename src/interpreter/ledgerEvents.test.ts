import { describe, expect, it } from "vitest";
import { applyOverrides, overridesOf, saveConfig } from "../app/store";
import type { CampaignQueuedEvent, InterpreterResponseEvent, LedgerEvent } from "../campaign/types";
import { freezeModelConfig, modelConfig } from "../config/modelConfig";
import { fixtureSnapshots } from "../fixtures/snapshots";
import { INSTRUMENTS } from "../instruments/metadata";
import { Ledger } from "../ledger/ledger";
import { LEDGER_KEYS, MemoryStorage, loadLedger, saveLedger } from "../ledger/storage";
import { mils } from "../numerics/money";
import { toTicks, type Ticks } from "../numerics/ticks";
import { perContractRisk, positionSize } from "../sizing/sizing";
import { stopDistance } from "../stops/stops";
import { DEFAULT_INTERPRETER_CONFIG, INTERPRETER_PRICE_TABLE, estimateCostMils, interpreterEventId, type InterpreterResponse } from "./types";

const NQ = fixtureSnapshots().find((s) => s.root === "NQ")!;
const px = (s: string): Ticks => toTicks(s, INSTRUMENTS.NQ.tick, "exact");
const BAR = "2026-01-02T21:00:00Z";

const RESPONSE: InterpreterResponse = {
  promptVersion: "interp-0.1",
  readings: [{ root: "NQ", activity: "building", breadth: "broadening", priceResponse: "responding", noiseFlag: false, evidence: ["u rose to 3.00"] }],
  crossMarket: { summary: "NQ leads", supports: [], contradicts: [] },
  hypothesis: "Participation is building in NQ.",
  proposal: { action: "enter", root: "NQ", side: 1, entryZone: null, stopTicks: 87900, invalidation: [], rationale: "…" },
  evidenceStrength: "moderate",
};

function responseEvent(over: Partial<InterpreterResponseEvent> = {}): InterpreterResponseEvent {
  return {
    id: interpreterEventId({ mode: "paperModel", barEnd: BAR, callKind: "decision", model: "claude-opus-5", promptVersion: "interp-0.1", suffix: "response" }),
    type: "INTERPRETER_RESPONSE",
    timestamp: BAR,
    actual: false,
    responseId: "resp-1",
    barEnd: BAR,
    callKind: "decision",
    model: "claude-opus-5",
    promptVersion: "interp-0.1",
    response: RESPONSE,
    usage: { inputTokens: 9000, cachedInputTokens: 6000, outputTokens: 1200 },
    latencyMs: 4200,
    costEstimateMils: mils(234_000),
    ...over,
  };
}

function queuedEvent(mode: "paper" | "paperModel", over: Partial<CampaignQueuedEvent> = {}): CampaignQueuedEvent {
  const dist = stopDistance(NQ.raw.atr20Ticks, NQ.H, 1, modelConfig);
  if (!dist.ok) throw new Error(dist.reason.detail);
  const risk = perContractRisk({ entryFill: px("22000.25"), stopExitFill: px("21947.50"), tickValueMils: INSTRUMENTS.NQ.tickValueMils, cost: modelConfig.costs.NQ });
  const sizing = positionSize({ equityMils: mils(1_000_000_000), perContractRiskMils: risk.totalMils, cfg: modelConfig });
  return {
    id: `${mode}:NQ:${BAR}:queued`,
    type: "CAMPAIGN_QUEUED",
    timestamp: BAR,
    actual: false,
    campaignId: `${mode}:NQ:${BAR}`,
    mode,
    root: "NQ",
    contract: INSTRUMENTS.NQ.contract,
    side: 1,
    plan: { contracts: sizing.contracts, plannedEntry: px("22000.25"), plannedStop: px("21947.75"), riskBudgetMils: sizing.budgetMils, perContractRisk: risk, sizing },
    frozenConfig: freezeModelConfig(modelConfig),
    frozenSnapshot: NQ,
    decisionDistance: dist.value,
    ...over,
  };
}

describe("interpreter config (D19)", () => {
  it("modelConfig carries the interpreter block with the ticketed defaults", () => {
    expect(modelConfig.interpreter).toEqual(DEFAULT_INTERPRETER_CONFIG);
    expect(modelConfig.interpreter.provider).toBe("anthropic");
    expect(modelConfig.interpreter.model).toBe("claude-opus-5");
    expect(modelConfig.interpreter.effortDecision).toBe("high");
    expect(modelConfig.interpreter.effortObservation).toBe("high");
    expect(modelConfig.interpreter.promptVersion).toBe("interp-0.1");
    expect(modelConfig.interpreter.nBars).toBe(10);
    expect(modelConfig.interpreter.feedbackK).toBe(20);
    expect(modelConfig.interpreter.lessonsN).toBe(30);
    expect(modelConfig.interpreter.mayEnterBelowThreshold).toBe(true);
    expect(modelConfig.interpreter.candidateFloor).toBeNull();
    expect(modelConfig.interpreter.allowedModels).toEqual(["claude-opus-5", "claude-sonnet-5", "claude-fable-5-1"]);
  });

  it("saved settings and frozen copies carry the interpreter block", () => {
    const storage = new MemoryStorage();
    const saved = saveConfig(storage, { ...overridesOf(modelConfig), entryThreshold: 1.2 }, modelConfig.version);
    expect(saved.cfg.interpreter).toEqual(DEFAULT_INTERPRETER_CONFIG);
    expect(applyOverrides(overridesOf(modelConfig)).interpreter).toEqual(DEFAULT_INTERPRETER_CONFIG);
    const frozen = freezeModelConfig(saved.cfg);
    expect(frozen.interpreter).toEqual(DEFAULT_INTERPRETER_CONFIG);
    expect(Object.isFrozen(frozen)).toBe(true);
    const ledger = new Ledger("paperModel");
    ledger.append(queuedEvent("paperModel", { frozenConfig: frozen }));
    expect(ledger.activeCampaign?.frozenConfig.interpreter.promptVersion).toBe("interp-0.1");
  });

  it("estimates a cost in mils from the price table and returns 0 for an unknown model", () => {
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 };
    expect(estimateCostMils(usage, "claude-opus-5")).toBe(INTERPRETER_PRICE_TABLE["claude-opus-5"]!.inputPerMTokenMils);
    expect(estimateCostMils({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, "claude-opus-5")).toBe(0);
    expect(estimateCostMils(usage, "some-other-model")).toBe(0);
    // rounded up so an estimate is never understated
    expect(estimateCostMils({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 }, "claude-opus-5")).toBe(15);
  });
});

describe("interpreter ledger events", () => {
  it("stores the latest response per bar, accumulates usage, and is idempotent on a repeated id", () => {
    const ledger = new Ledger("paperModel");
    expect(ledger.append(responseEvent()).applied).toBe(true);
    const again = ledger.append(responseEvent());
    expect(again).toEqual({ applied: false, reason: "duplicate" });
    const i = ledger.state.interpreter;
    expect(i.latestResponse?.responseId).toBe("resp-1");
    expect(i.latestResponseByBar[`decision:${BAR}`]?.response.proposal.action).toBe("enter");
    expect(i.usage).toEqual({ calls: 1, inputTokens: 9000, cachedInputTokens: 6000, outputTokens: 1200, costEstimateMils: 234_000, latencyMsTotal: 4200 });
    expect(ledger.events).toHaveLength(1);

    // a second bar adds a second entry and sums the usage
    const next = responseEvent({
      id: interpreterEventId({ mode: "paperModel", barEnd: "2026-01-05T21:00:00Z", callKind: "observation", model: "claude-opus-5", promptVersion: "interp-0.1", suffix: "response" }),
      responseId: "resp-2",
      barEnd: "2026-01-05T21:00:00Z",
      callKind: "observation",
      usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 },
      latencyMs: 800,
      costEstimateMils: mils(22_500),
    });
    ledger.append(next);
    const j = ledger.state.interpreter;
    expect(Object.keys(j.latestResponseByBar).sort()).toEqual([`decision:${BAR}`, "observation:2026-01-05T21:00:00Z"]);
    expect(j.latestResponse?.responseId).toBe("resp-2");
    expect(j.usage).toEqual({ calls: 2, inputTokens: 10_000, cachedInputTokens: 6000, outputTokens: 1300, costEstimateMils: 256_500, latencyMsTotal: 5000 });
  });

  it("accepts interpreter events in every mode and changes no campaign state", () => {
    for (const mode of ["manual", "paper", "paperModel"] as const) {
      const ledger = new Ledger(mode);
      const events: LedgerEvent[] = [
        { id: `${mode}:req`, type: "INTERPRETER_REQUEST", timestamp: BAR, actual: false, mode, callKind: "decision", barEnd: BAR, requestHash: "h1", promptVersion: "interp-0.1", model: "claude-opus-5", nBars: 10 },
        responseEvent({ id: `${mode}:resp` }),
        { id: `${mode}:rej`, type: "INTERPRETER_REJECTED", timestamp: BAR, actual: false, barEnd: BAR, callKind: "decision", model: "claude-opus-5", promptVersion: "interp-0.1", reason: "proposal.action enter requires a root" },
        {
          id: `${mode}:clamp`,
          type: "INTERPRETER_CLAMPED",
          timestamp: BAR,
          actual: false,
          responseId: "resp-1",
          barEnd: BAR,
          callKind: "decision",
          before: { action: "enter", root: "NQ", side: 1, stopTicks: 87000, entryZone: null },
          after: null,
          reasons: ["NQ is not in the allowed candidate set (ES)"],
        },
      ];
      expect(ledger.appendAll(events).every((r) => r.applied)).toBe(true);
      expect(ledger.campaigns).toEqual([]);
      expect(ledger.state.activeCampaignId).toBeNull();
      expect(ledger.state.cashMils).toBe(ledger.startingEquityMils);
      expect(ledger.equitySeries).toEqual([]);
      expect(ledger.state.interpreter.latestResponse?.responseId).toBe("resp-1");
    }
  });

  it("stores the response id on a campaign entered from a proposal, and null otherwise", () => {
    const withId = new Ledger("paperModel");
    withId.append(responseEvent());
    withId.append(queuedEvent("paperModel", { interpreterResponseId: "resp-1" }));
    expect(withId.activeCampaign?.interpreterResponseId).toBe("resp-1");
    const without = new Ledger("paper");
    without.append(queuedEvent("paper"));
    expect(without.activeCampaign?.interpreterResponseId).toBeNull();
  });

  it("keeps lessons and the digest inside the current memory epoch and archives on reset", () => {
    const ledger = new Ledger("paperModel");
    const lesson = (id: string, campaignId: string, epochId: string): LedgerEvent => ({
      id,
      type: "INTERPRETER_LESSON",
      timestamp: BAR,
      actual: false,
      campaignId,
      epochId,
      model: "claude-opus-5",
      promptVersion: "interp-0.1",
      lesson: { campaignId, whatHeld: ["breadth held"], whatFailed: [], weighDifferently: [], evidenceToWatch: [] },
    });
    ledger.append(lesson("l1", "c1", "epoch-1"));
    ledger.append(lesson("l2", "c2", "epoch-1"));
    ledger.append({
      id: "d1",
      type: "INTERPRETER_DIGEST",
      timestamp: BAR,
      actual: false,
      epochId: "epoch-1",
      model: "claude-opus-5",
      promptVersion: "interp-0.1",
      digest: { version: 1, lessonsCovered: 2, summary: "two campaigns", whatHeld: [], whatFailed: [], weighDifferently: [], evidenceToWatch: [] },
    });
    expect(ledger.state.interpreter.lessons.map((l) => l.campaignId)).toEqual(["c1", "c2"]);
    expect(ledger.state.interpreter.digest?.digest.version).toBe(1);
    expect(ledger.state.interpreter.memoryEpochId).toBe("epoch-1");

    ledger.append({ id: "reset-1", type: "INTERPRETER_MEMORY_RESET", timestamp: BAR, actual: false, epochId: "epoch-2", previousEpochId: "epoch-1", reason: "user reset" });
    const i = ledger.state.interpreter;
    expect(i.memoryEpochId).toBe("epoch-2");
    expect(i.archivedEpochIds).toEqual(["epoch-1"]);
    expect(i.lessons).toEqual([]);
    expect(i.digest).toBeNull();
    // the archived lessons stay in the append-only log
    expect(ledger.events.filter((e) => e.type === "INTERPRETER_LESSON")).toHaveLength(2);

    // a late lesson carrying the old epoch is logged but not read back into requests
    ledger.append(lesson("l3", "c3", "epoch-1"));
    expect(ledger.state.interpreter.lessons).toEqual([]);
    ledger.append(lesson("l4", "c4", "epoch-2"));
    expect(ledger.state.interpreter.lessons.map((l) => l.campaignId)).toEqual(["c4"]);

    // a reset that does not name the current epoch is refused
    expect(ledger.append({ id: "reset-bad", type: "INTERPRETER_MEMORY_RESET", timestamp: BAR, actual: false, epochId: "epoch-3", previousEpochId: "epoch-1", reason: "stale" })).toEqual({
      applied: false,
      reason: "memory reset expects the current epoch epoch-2, got epoch-1",
    });
  });
});

describe("paperModel ledger persistence (D18)", () => {
  it("round-trips under its own key, separately from the rules-only paper ledger", () => {
    const storage = new MemoryStorage();
    const model = new Ledger("paperModel");
    model.append(responseEvent());
    model.append(queuedEvent("paperModel", { interpreterResponseId: "resp-1" }));
    const rules = new Ledger("paper");
    rules.append(queuedEvent("paper"));
    saveLedger(storage, model);
    saveLedger(storage, rules);
    expect(storage.keys().sort()).toEqual(["fdt.v1.paper", "fdt.v1.paperModel"]);
    expect(LEDGER_KEYS.paperModel).toBe("fdt.v1.paperModel");

    const loaded = loadLedger(storage, "paperModel");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.reason);
    expect(loaded.ledger.mode).toBe("paperModel");
    expect(loaded.ledger.startingEquityMils).toBe(modelConfig.paperEquityStartMils);
    expect(loaded.ledger.activeCampaign?.interpreterResponseId).toBe("resp-1");
    expect(loaded.ledger.state.interpreter.latestResponse?.response.proposal.stopTicks).toBe(87900);
    expect(loaded.ledger.state.interpreter.usage.calls).toBe(1);
    expect(loaded.ledger.state).toEqual(model.state);

    const rulesBack = loadLedger(storage, "paper");
    expect(rulesBack.ok && rulesBack.ledger.state.interpreter.latestResponse).toBeNull();
    expect(rulesBack.ok && rulesBack.ledger.campaigns).toHaveLength(1);

    // a paperModel document is refused by the paper key, as any other mode mismatch is
    storage.setItem(LEDGER_KEYS.paper, storage.getItem(LEDGER_KEYS.paperModel)!);
    expect(loadLedger(storage, "paper")).toMatchObject({ ok: false, reason: "stored ledger mode paperModel does not match paper" });
  });

  it("refuses a stored interpreter event that is missing a required field", () => {
    const storage = new MemoryStorage();
    const doc = (events: unknown[]) => JSON.stringify({ schemaVersion: 1, mode: "paperModel", startingEquityMils: 1_000_000_000, events });
    storage.setItem(LEDGER_KEYS.paperModel, doc([{ ...responseEvent(), usage: undefined }]));
    expect(loadLedger(storage, "paperModel")).toMatchObject({
      ok: false,
      reason: `stored ledger refused: event ${responseEvent().id} (INTERPRETER_RESPONSE) is missing required field usage`,
    });
    storage.setItem(LEDGER_KEYS.paperModel, doc([{ id: "x", type: "INTERPRETER_LESSON", timestamp: BAR, actual: false, campaignId: "c1", model: "m", promptVersion: "p", lesson: {} }]));
    expect(loadLedger(storage, "paperModel")).toMatchObject({
      ok: false,
      reason: "stored ledger refused: event x (INTERPRETER_LESSON) is missing required field epochId",
    });
  });
});
