import { describe, expect, it } from "vitest";
import type { LedgerEvent } from "../campaign/types";
import { freezeModelConfig, modelConfig } from "../config/modelConfig";
import { fixtureSnapshots } from "../fixtures/snapshots";
import { INSTRUMENTS } from "../instruments/metadata";
import { Ledger } from "../ledger/ledger";
import { MemoryStorage, loadLedger, saveLedger } from "../ledger/storage";
import { mils } from "../numerics/money";
import { toTicks, type Ticks } from "../numerics/ticks";
import { perContractRisk, positionSize } from "../sizing/sizing";
import { stopDistance } from "../stops/stops";
import { outcomesForLastK, type SnapshotsByBar } from "./feedback";
import {
  buildDigestRequest,
  buildLessonRequest,
  campaignSummary,
  digestNeeded,
  lessonsForRequest,
  lessonsToCompact,
  nextEpochId,
  resetMemory,
} from "./memory";
import type { Digest, Invalidation, InterpreterResponse, Lesson } from "./types";

const NQ = fixtureSnapshots().find((s) => s.root === "NQ")!;
const px = (s: string): Ticks => toTicks(s, INSTRUMENTS.NQ.tick, "exact");
const B = (n: number) => `2026-03-0${n}T21:00:00Z`;

const INVALIDATION: Invalidation[] = [{ kind: "H_below", root: "NQ", threshold: 0.4, note: "breadth falls back" }];

const RESPONSE: InterpreterResponse = {
  promptVersion: "interp-0.1",
  readings: [{ root: "NQ", activity: "building", breadth: "broadening", priceResponse: "responding", noiseFlag: false, evidence: ["u rose to 3.00"] }],
  crossMarket: { summary: "NQ leads", supports: [], contradicts: [] },
  hypothesis: "Participation is building in NQ.",
  proposal: { action: "enter", root: "NQ", side: 1, entryZone: null, stopTicks: 87791, invalidation: INVALIDATION, rationale: "activity and breadth build" },
  evidenceStrength: "moderate",
};

function lessonEvent(id: string, campaignId: string, epochId: string): LedgerEvent {
  return {
    id,
    type: "INTERPRETER_LESSON",
    timestamp: B(1),
    actual: false,
    campaignId,
    epochId,
    model: "claude-opus-5",
    promptVersion: "interp-0.1",
    lesson: { campaignId, whatHeld: [`held ${campaignId}`], whatFailed: [], weighDifferently: [], evidenceToWatch: [] },
  };
}

function snapshotsByBar(): SnapshotsByBar {
  const bar = (barEnd: string, H: number, close: string) => {
    const s = structuredClone(NQ);
    s.barEnd = barEnd;
    s.H = H;
    s.raw.closeT = px(close);
    return s;
  };
  return {
    [B(1)]: [bar(B(1), 0.6, "22000")],
    [B(2)]: [bar(B(2), 0.6, "22025")],
    [B(3)]: [bar(B(3), 0.3, "21975")],
    [B(4)]: [bar(B(4), 0.2, "21947.50")],
  };
}

/** paperModel ledger with one closed, model-originated campaign. */
function closedLedger(): Ledger {
  const ledger = new Ledger("paperModel");
  const dist = stopDistance(NQ.raw.atr20Ticks, NQ.H, 1, modelConfig);
  if (!dist.ok) throw new Error(dist.reason.detail);
  const risk = perContractRisk({ entryFill: px("22000.25"), stopExitFill: px("21947.50"), tickValueMils: INSTRUMENTS.NQ.tickValueMils, cost: modelConfig.costs.NQ });
  const sizing = positionSize({ equityMils: mils(1_000_000_000), perContractRiskMils: risk.totalMils, cfg: modelConfig });
  const frozenSnapshot = structuredClone(NQ);
  frozenSnapshot.barEnd = B(1);
  const events: LedgerEvent[] = [
    {
      id: "resp-e1",
      type: "INTERPRETER_RESPONSE",
      timestamp: B(1),
      actual: false,
      responseId: "resp-1",
      barEnd: B(1),
      callKind: "decision",
      model: "claude-opus-5",
      promptVersion: "interp-0.1",
      response: RESPONSE,
      usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 },
      latencyMs: 1100,
      costEstimateMils: mils(22_500),
    },
    {
      id: "queued-1",
      type: "CAMPAIGN_QUEUED",
      timestamp: B(1),
      actual: false,
      campaignId: "paperModel:NQ:1",
      mode: "paperModel",
      root: "NQ",
      contract: INSTRUMENTS.NQ.contract,
      side: 1,
      plan: { contracts: 1, plannedEntry: px("22000.25"), plannedStop: px("21947.75"), riskBudgetMils: sizing.budgetMils, perContractRisk: risk, sizing },
      frozenConfig: freezeModelConfig(modelConfig),
      frozenSnapshot,
      decisionDistance: dist.value,
      interpreterResponseId: "resp-1",
    },
    {
      id: "fill-1",
      type: "ENTRY_FILL",
      timestamp: B(2),
      actual: false,
      campaignId: "paperModel:NQ:1",
      side: 1,
      quantity: 1,
      price: px("22000.25"),
      feesMils: mils(2500),
      filledAt: B(2),
      fillModel: "paper-model-0.1",
      perContractRiskMils: mils(1_060_000),
    },
    {
      id: "exit-1",
      type: "EXIT_FILL",
      timestamp: B(4),
      actual: false,
      campaignId: "paperModel:NQ:1",
      quantity: 1,
      price: px("21947.50"),
      feesMils: mils(2500),
      filledAt: B(4),
      fillModel: "paper-model-0.1",
      reason: "stop-touched",
    },
  ];
  expect(ledger.appendAll(events).every((r) => r.applied)).toBe(true);
  return ledger;
}

describe("lessons window and digest trigger", () => {
  function withLessons(n: number): Ledger {
    const ledger = new Ledger("paperModel");
    for (let i = 1; i <= n; i++) ledger.append(lessonEvent(`l${i}`, `c${i}`, "epoch-1"));
    return ledger;
  }

  it("carries the last N lessons, oldest first", () => {
    const ledger = withLessons(5);
    expect(lessonsForRequest(ledger, 3).map((l) => l.campaignId)).toEqual(["c3", "c4", "c5"]);
    expect(lessonsForRequest(ledger, 10).map((l) => l.campaignId)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    expect(lessonsForRequest(ledger, 0)).toEqual([]);
  });

  it("asks for a digest only once the window is exceeded, at N+1", () => {
    expect(digestNeeded(withLessons(3), 3)).toBe(false);
    expect(digestNeeded(withLessons(4), 3)).toBe(true);
    expect(lessonsToCompact(withLessons(3), 3)).toEqual([]);
    expect(lessonsToCompact(withLessons(5), 3).map((l) => l.campaignId)).toEqual(["c1", "c2"]);
  });

  it("uses the configured lessonsN by default", () => {
    expect(modelConfig.interpreter.lessonsN).toBe(30);
    expect(digestNeeded(withLessons(30))).toBe(false);
    expect(digestNeeded(withLessons(31))).toBe(true);
    expect(lessonsForRequest(withLessons(31))).toHaveLength(30);
  });
});

describe("campaignSummary and the lesson request", () => {
  const ledger = closedLedger();
  const campaign = ledger.campaigns[0]!;
  const outcome = outcomesForLastK(ledger, snapshotsByBar(), 20)[0]!;

  it("summarises the closed campaign from the ledger", () => {
    const s = campaignSummary({ campaign, outcome });
    expect(s.campaignId).toBe("paperModel:NQ:1");
    expect(s.mode).toBe("paperModel");
    expect(s.root).toBe("NQ");
    expect(s.sideText).toBe("Buy / long");
    expect(s.state).toBe("CLOSED");
    expect(s.interpreterResponseId).toBe("resp-1");
    expect(s.decisionBarEnd).toBe(B(1));
    expect(s.entryFills).toEqual([{ priceTicks: px("22000.25"), priceText: "22000.25", quantity: 1, at: B(2) }]);
    expect(s.exitFills).toEqual([{ priceTicks: px("21947.50"), priceText: "21947.50", quantity: 1, at: B(4), reason: "stop-touched" }]);
    expect(s.exitReason).toBe("stop-touched");
    expect(s.netRealizedText).toBe("-1,060.00");
    expect(s.originalRiskText).toBe("1,060.00");
    expect(s.realizedRText).toBe("-1.00 R");
    expect(s.barsHeld).toBe(campaign.exposureBars);
    expect(s.invalidation.map((i) => i.condition.kind)).toEqual(["H_below"]);
    expect(s.invalidation[0]!.appearedBeforeStop).toBe(true);
  });

  it("builds a lesson request that carries the summary, the memory and no market bars", () => {
    const req = buildLessonRequest(campaign, ledger, { snapshotsByBar: snapshotsByBar(), outcome, feedback: [outcome] });
    expect(req.callKind).toBe("lesson");
    expect(req.allowedActions).toEqual([]);
    expect(req.markets).toEqual([]);
    expect(req.mode).toBe("paperModel");
    expect(req.promptVersion).toBe("interp-0.1");
    expect(req.modelConfigVersion).toBe(modelConfig.version);
    expect(req.barEnd).toBe(B(4));
    expect(req.bounds.entriesPermitted).toBe(false);
    expect(req.bounds.reason).toContain("lesson calls produce memory notes, not proposals");
    expect(req.bounds.allowedCandidates).toEqual([]);
    expect(req.campaignSummary?.campaignId).toBe("paperModel:NQ:1");
    expect(req.campaignSummary?.proposal?.action).toBe("enter");
    expect(req.campaignSummary?.invalidation[0]?.appearedBeforeStop).toBe(true);
    expect(req.lessonsToCompact).toBeNull();
    expect(req.feedback).toHaveLength(1);
    expect(req.memoryEpochId).toBe("epoch-1");
    expect(req.dataSourceKind).toBe("none");
  });

  it("evaluates the proposal's invalidation itself when the caller passes only the bars", () => {
    const req = buildLessonRequest(campaign, ledger, { snapshotsByBar: snapshotsByBar() });
    expect(req.campaignSummary?.invalidation).toHaveLength(1);
    expect(req.campaignSummary?.invalidation[0]).toMatchObject({ appearedBeforeStop: true });
  });

  it("builds a digest request carrying the lessons to compact", () => {
    const withLessons = closedLedger();
    withLessons.append(lessonEvent("l1", "c1", "epoch-1"));
    withLessons.append(lessonEvent("l2", "c2", "epoch-1"));
    const lessons: Lesson[] = lessonsToCompact(withLessons, 1);
    expect(lessons.map((l) => l.campaignId)).toEqual(["c1"]);
    const req = buildDigestRequest(lessons, withLessons, { at: B(4) });
    expect(req.callKind).toBe("digest");
    expect(req.allowedActions).toEqual([]);
    expect(req.campaignSummary).toBeNull();
    expect(req.lessonsToCompact?.map((l) => l.campaignId)).toEqual(["c1"]);
    expect(req.lessons.map((l) => l.campaignId)).toEqual(["c1", "c2"]);
  });
});

describe("memory reset", () => {
  it("archives the epoch, clears the active memory and keeps every lesson in the log", () => {
    const ledger = new Ledger("paperModel");
    ledger.append(lessonEvent("l1", "c1", "epoch-1"));
    ledger.append(lessonEvent("l2", "c2", "epoch-1"));
    const digest: Digest = { version: 1, lessonsCovered: 2, summary: "two campaigns", whatHeld: [], whatFailed: [], weighDifferently: [], evidenceToWatch: [] };
    ledger.append({ id: "d1", type: "INTERPRETER_DIGEST", timestamp: B(1), actual: false, epochId: "epoch-1", model: "claude-opus-5", promptVersion: "interp-0.1", digest });
    expect(lessonsForRequest(ledger, 30)).toHaveLength(2);

    const event = resetMemory(ledger, B(2), { reason: "comparing with the loop off" });
    expect(event.type).toBe("INTERPRETER_MEMORY_RESET");
    expect(event.previousEpochId).toBe("epoch-1");
    expect(event.epochId).toBe("epoch-2");
    expect(event.reason).toBe("comparing with the loop off");
    expect(event.id).toBe(`interp:paperModel:${B(2)}:decision:claude-opus-5:interp-0.1:memory-reset:epoch-2`);
    expect(ledger.append(event).applied).toBe(true);

    const i = ledger.state.interpreter;
    expect(i.memoryEpochId).toBe("epoch-2");
    expect(i.archivedEpochIds).toEqual(["epoch-1"]);
    expect(i.lessons).toEqual([]);
    expect(i.digest).toBeNull();
    expect(lessonsForRequest(ledger, 30)).toEqual([]);
    // nothing was deleted: both lessons and the digest are still in the append-only log, tagged epoch-1
    const logged = ledger.events.filter((e) => e.type === "INTERPRETER_LESSON");
    expect(logged).toHaveLength(2);
    expect(logged.every((e) => e.type === "INTERPRETER_LESSON" && e.epochId === "epoch-1")).toBe(true);
    expect(ledger.events.some((e) => e.type === "INTERPRETER_DIGEST" && e.epochId === "epoch-1")).toBe(true);

    // and the archive survives a save and reload
    const storage = new MemoryStorage();
    saveLedger(storage, ledger);
    const back = loadLedger(storage, "paperModel");
    expect(back.ok).toBe(true);
    if (!back.ok) throw new Error(back.reason);
    expect(back.ledger.state.interpreter.memoryEpochId).toBe("epoch-2");
    expect(back.ledger.state.interpreter.archivedEpochIds).toEqual(["epoch-1"]);
    expect(back.ledger.events.filter((e) => e.type === "INTERPRETER_LESSON")).toHaveLength(2);

    // a second reset moves to epoch-3 and archives epoch-2
    const second = resetMemory(ledger, B(3));
    expect(second.epochId).toBe("epoch-3");
    expect(ledger.append(second).applied).toBe(true);
    expect(ledger.state.interpreter.archivedEpochIds).toEqual(["epoch-1", "epoch-2"]);
  });

  it("derives the next epoch id from the current one", () => {
    expect(nextEpochId("epoch-1")).toBe("epoch-2");
    expect(nextEpochId("epoch-9")).toBe("epoch-10");
    expect(nextEpochId("baseline")).toBe("baseline-2");
  });

  it("lessons recorded after a reset belong to the new epoch only", () => {
    const ledger = new Ledger("paperModel");
    ledger.append(lessonEvent("l1", "c1", "epoch-1"));
    ledger.append(resetMemory(ledger, B(2)));
    ledger.append(lessonEvent("l2", "c2", "epoch-1"));
    expect(lessonsForRequest(ledger, 30)).toEqual([]);
    ledger.append(lessonEvent("l3", "c3", "epoch-2"));
    expect(lessonsForRequest(ledger, 30).map((l) => l.campaignId)).toEqual(["c3"]);
    expect(ledger.events.filter((e) => e.type === "INTERPRETER_LESSON")).toHaveLength(3);
  });
});
