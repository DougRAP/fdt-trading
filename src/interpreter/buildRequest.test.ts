import { describe, expect, it } from "vitest";
import type { Campaign, LedgerState } from "../campaign/types";
import { modelConfig, type InstrumentRoot } from "../config/modelConfig";
import { fixtureSnapshots } from "../fixtures/snapshots";
import type { SignalSnapshot } from "../formula/types";
import { INSTRUMENTS } from "../instruments/metadata";
import { mils } from "../numerics/money";
import { toTicks, type Ticks } from "../numerics/ticks";
import { perContractRisk, positionSize } from "../sizing/sizing";
import { initialStop, stopDistance } from "../stops/stops";
import { buildRequest, MIN_STOP_TICKS } from "./buildRequest";
import { DEFAULT_INTERPRETER_CONFIG, type Digest, type Lesson, type ProposalOutcome } from "./types";

const SNAPS = fixtureSnapshots();
const px = (s: string): Ticks => toTicks(s, INSTRUMENTS.NQ.tick, "exact");

/** A synthetic 12-bar history per root: the fixture snapshot repeated with distinct bar ends. */
function histories(roots: readonly InstrumentRoot[] = ["NQ", "ES", "RTY", "YM", "ZN", "GC"], bars = 12) {
  const out: Partial<Record<InstrumentRoot, SignalSnapshot[]>> = {};
  for (const root of roots) {
    const base = SNAPS.find((s) => s.root === root);
    if (!base) continue;
    out[root] = Array.from({ length: bars }, (_, i) => {
      const clone = structuredClone(base);
      const day = String(i + 1).padStart(2, "0");
      clone.barEnd = `2026-02-${day}T21:00:00Z`;
      clone.availableAt = `2026-02-${day}T21:05:00Z`;
      return clone;
    });
  }
  return out;
}

function ledgerState(over: Partial<LedgerState> = {}): LedgerState {
  return {
    mode: "paper",
    campaigns: {},
    campaignOrder: [],
    activeCampaignId: null,
    marks: {},
    paused: false,
    stopMonitor: { healthy: true, lastCheckedAt: "2026-02-12T21:00:00Z", detail: "checked" },
    startingEquityMils: mils(1_000_000_000),
    cashMils: mils(1_000_000_000),
    externalCashFlowMils: mils(0),
    cumulativeNetRealizedMils: mils(0),
    equitySeries: [],
    appliedEventIds: [],
    supersededEventIds: [],
    ...over,
  };
}

/** A minimal OPEN campaign built from the real sizing and stop helpers. */
function openCampaign(): Campaign {
  const nq = SNAPS.find((s) => s.root === "NQ")!;
  const dist = stopDistance(nq.raw.atr20Ticks, nq.H, 1, modelConfig);
  if (!dist.ok) throw new Error(dist.reason.detail);
  const entry = px("22000.25");
  const stop = initialStop({ side: 1, entryFill: entry, distance: dist.value, calculatedAt: nq.availableAt });
  const risk = perContractRisk({ entryFill: entry, stopExitFill: px("21947.50"), tickValueMils: INSTRUMENTS.NQ.tickValueMils, cost: modelConfig.costs.NQ });
  const sizing = positionSize({ equityMils: mils(1_000_000_000), perContractRiskMils: risk.totalMils, cfg: modelConfig });
  return {
    id: "paper:NQ:2026-02-12T21:00:00Z",
    mode: "paper",
    root: "NQ",
    contract: INSTRUMENTS.NQ.contract,
    side: 1,
    state: "OPEN",
    frozenConfig: modelConfig,
    frozenSnapshot: nq,
    decisionDistance: dist.value,
    plan: { contracts: sizing.contracts, plannedEntry: entry, plannedStop: stop.stop, riskBudgetMils: sizing.budgetMils, perContractRisk: risk, sizing },
    fills: [],
    lots: [{ price: entry, remaining: 2 }],
    entryQuantity: 2,
    exitQuantity: 0,
    remaining: 2,
    entryBasisTicksQty: entry * 2,
    originalRiskMils: mils(2_120_000),
    grossRealizedMils: mils(0),
    feesMils: mils(5000),
    netRealizedMils: mils(-5000),
    proposedStop: stop,
    restingStop: stop,
    brokerStop: { price: px("21947.75"), status: "working", confirmedAt: "2026-02-12T21:10:00Z" },
    closeRequested: null,
    extremeClose: px("22040"),
    exposureBars: 3,
    deviationReasons: [],
    stopFrozenReason: null,
    queuedAt: "2026-02-12T21:05:00Z",
    openedAt: "2026-02-13T21:00:00Z",
    closedAt: null,
    cancelReason: null,
  };
}

describe("buildRequest — markets and history window", () => {
  const req = buildRequest({ callKind: "decision", mode: "paperModel", histories: histories(), ledger: ledgerState() });

  it("carries nBars bars per market, oldest first, all six roots in configured order", () => {
    expect(req.nBars).toBe(DEFAULT_INTERPRETER_CONFIG.nBars);
    expect(req.markets.map((m) => m.root)).toEqual(["NQ", "ES", "RTY", "YM", "ZN", "GC"]);
    for (const m of req.markets) {
      expect(m.bars).toHaveLength(10);
      expect(m.bars[0]!.barEnd).toBe("2026-02-03T21:00:00Z");
      expect(m.bars[9]!.barEnd).toBe("2026-02-12T21:00:00Z");
      expect(m.latestStatus).toBe(m.bars[9]!.status);
    }
    expect(req.barEnd).toBe("2026-02-12T21:00:00Z");
    expect(req.promptVersion).toBe("interp-0.1");
    expect(req.modelConfigVersion).toBe(modelConfig.version);
    expect(req.mode).toBe("paperModel");
    expect(req.dataSourceKind).toBe("fixture");
  });

  it("carries each value with its display string and never a re-derived number", () => {
    const nq = req.markets.find((m) => m.root === "NQ")!.bars[9]!;
    expect(nq.statistics.Q).toBeCloseTo(1.8, 12);
    expect(nq.text.Q).toBe("1.80");
    expect(nq.statistics.u).toBeCloseTo(3.0, 12);
    expect(nq.text.u).toBe("3.00");
    expect(nq.text.sLong).toBe("2.20");
    expect(nq.text.sShort).toBe("-2.20");
    expect(nq.prices.closeTicks).toBe(88000);
    expect(nq.prices.closeText).toBe("22000.00");
    expect(nq.prices.atr20Ticks).toBe(100);
    expect(nq.prices.atr20Text).toBe("25.00 pts (100 ticks)");
    expect(nq.status).toBe("QUALIFIED");
    expect(nq.displaySide).toBe("long");
    expect(nq.qualification.long.qualifies).toBe(true);
    expect(nq.dataSource.label).toMatch(/ILLUSTRATIVE/);
    expect(nq.inputSourceIds).toContain("fixture:sigma-constants:synthetic");
  });

  it("keeps unavailable markets with their reasons and blank statistics", () => {
    const zn = req.markets.find((m) => m.root === "ZN")!.bars[9]!;
    expect(zn.status).toBe("UNAVAILABLE");
    expect(zn.statistics.A).toBeNull();
    expect(zn.statistics.S.long).toBeNull();
    expect(zn.text.A).toBe("—");
    expect(zn.unavailableReasons[0]?.code).toBe("BREADTH_MODEL_UNDEFINED");
    expect(zn.statistics.Q).toBeCloseTo(1.4, 12);
  });

  it("uses a shorter history when fewer bars exist", () => {
    const short = buildRequest({ callKind: "decision", mode: "paper", histories: histories(["NQ"], 3), ledger: ledgerState() });
    expect(short.markets).toHaveLength(1);
    expect(short.markets[0]!.bars).toHaveLength(3);
  });
});

describe("buildRequest — bounds", () => {
  it("maxDTicks per root and side comes from stops.stopDistance", () => {
    const req = buildRequest({ callKind: "decision", mode: "paperModel", histories: histories(), ledger: ledgerState() });
    const nq = SNAPS.find((s) => s.root === "NQ")!;
    const long = stopDistance(nq.raw.atr20Ticks, nq.H, 1, modelConfig);
    const short = stopDistance(nq.raw.atr20Ticks, nq.H, -1, modelConfig);
    expect(long.ok && short.ok).toBe(true);
    if (!long.ok || !short.ok) throw new Error("expected a stop distance");
    expect(req.bounds.maxDTicks.NQ).toEqual({ long: long.value.dTicks, short: short.value.dTicks });
    expect(req.bounds.maxDTicks.NQ).toEqual({ long: 210, short: 150 });
    // ZN has no breadth, so no D can be computed for either side
    expect(req.bounds.maxDTicks.ZN).toEqual({ long: null, short: null });
    expect(req.bounds.minTicks).toBe(MIN_STOP_TICKS);
    expect(req.bounds.minTicks).toBe(1);
  });

  it("discretion on (default) makes every available market a candidate", () => {
    const req = buildRequest({ callKind: "decision", mode: "paperModel", histories: histories(), ledger: ledgerState() });
    expect(req.bounds.entriesPermitted).toBe(true);
    expect(req.bounds.allowedCandidates).toEqual(["NQ", "ES", "RTY", "YM"]);
    expect(req.bounds.candidatePolicy).toEqual({ mayEnterBelowThreshold: true, candidateFloor: null });
    expect(req.bounds.reason).toBe("entries permitted; candidates: NQ, ES, RTY, YM");
  });

  it("a candidate floor narrows the set; discretion off falls back to qualified markets", () => {
    const floored = buildRequest({
      callKind: "decision",
      mode: "paperModel",
      histories: histories(),
      ledger: ledgerState(),
      interpreter: { ...DEFAULT_INTERPRETER_CONFIG, candidateFloor: 1.0 },
    });
    expect(floored.bounds.allowedCandidates).toEqual(["NQ", "ES"]);
    const strict = buildRequest({
      callKind: "decision",
      mode: "paperModel",
      histories: histories(),
      ledger: ledgerState(),
      interpreter: { ...DEFAULT_INTERPRETER_CONFIG, mayEnterBelowThreshold: false },
    });
    expect(strict.bounds.allowedCandidates).toEqual(["NQ", "ES"]);
    expect(strict.bounds.candidatePolicy.mayEnterBelowThreshold).toBe(false);
  });

  it("entries are not permitted when paused, when a campaign is active, or when data is stale", () => {
    const paused = buildRequest({ callKind: "decision", mode: "paperModel", histories: histories(), ledger: ledgerState({ paused: true }) });
    expect(paused.bounds.entriesPermitted).toBe(false);
    expect(paused.bounds.allowedCandidates).toEqual([]);
    expect(paused.bounds.reason).toBe("entries not permitted: the engine is paused");

    const active = buildRequest({
      callKind: "decision",
      mode: "paperModel",
      histories: histories(),
      ledger: ledgerState({ activeCampaignId: "paper:NQ:1" }),
    });
    expect(active.bounds.entriesPermitted).toBe(false);
    expect(active.bounds.reason).toBe("entries not permitted: campaign paper:NQ:1 is already active (one position per mode)");

    // every market unavailable (ZN/GC have no breadth model) stands in for stale data
    const stale = buildRequest({ callKind: "decision", mode: "paperModel", histories: histories(["ZN", "GC"]), ledger: ledgerState() });
    expect(stale.bounds.entriesPermitted).toBe(false);
    expect(stale.bounds.reason).toBe("entries not permitted: no market has a valid, fresh snapshot at this bar");

    const everything = buildRequest({
      callKind: "decision",
      mode: "paperModel",
      histories: histories(["ZN"]),
      ledger: ledgerState({ paused: true, activeCampaignId: "paper:NQ:1" }),
    });
    expect(everything.bounds.reason).toBe(
      "entries not permitted: the engine is paused; campaign paper:NQ:1 is already active (one position per mode); no market has a valid, fresh snapshot at this bar",
    );
  });

  it("observation calls allow only hold, tighten and exit", () => {
    const obs = buildRequest({ callKind: "observation", mode: "paperModel", histories: histories(), ledger: ledgerState() });
    expect(obs.allowedActions).toEqual(["hold", "tighten", "exit"]);
    expect(obs.bounds.entriesPermitted).toBe(false);
    expect(obs.bounds.reason).toBe("entries not permitted: observation calls may only hold, tighten or exit");
    const dec = buildRequest({ callKind: "decision", mode: "paperModel", histories: histories(), ledger: ledgerState() });
    expect(dec.allowedActions).toEqual(["enter", "wait", "hold", "tighten", "exit"]);
  });
});

describe("buildRequest — position, feedback and memory", () => {
  it("reports no position when the ledger is flat", () => {
    const req = buildRequest({ callKind: "decision", mode: "manual", histories: histories(), ledger: ledgerState() });
    expect(req.position.hasPosition).toBe(false);
    expect(req.position.root).toBeNull();
    expect(req.position.proposedStopText).toBe("—");
    expect(req.position.rMultipleText).toBe("—");
    expect(req.position.flags).toEqual([]);
  });

  it("summarises an open campaign with both ticks and display strings", () => {
    const c = openCampaign();
    const ledger = ledgerState({
      campaigns: { [c.id]: c },
      campaignOrder: [c.id],
      activeCampaignId: c.id,
      marks: { NQ: { root: "NQ", price: px("22010.25"), observedAt: "2026-02-12T21:00:00Z", source: "paper-observation-bar" } },
    });
    const req = buildRequest({
      callKind: "observation",
      mode: "paperModel",
      histories: histories(),
      ledger,
      positionExtras: { flags: ["DATA STALE"], rMultiple: 0.19 },
    });
    const p = req.position;
    expect(p.hasPosition).toBe(true);
    expect(p.campaignId).toBe(c.id);
    expect(p.root).toBe("NQ");
    expect(p.side).toBe(1);
    expect(p.sideText).toBe("Buy / long");
    expect(p.state).toBe("OPEN");
    expect(p.contractsRemaining).toBe(2);
    expect(p.averageEntryTicks).toBe(88001);
    expect(p.averageEntryText).toBe("22000.25");
    expect(p.proposedStopTicks).toBe(px("21947.75"));
    expect(p.proposedStopText).toBe("21947.75");
    expect(p.recordedStopTicks).toBe(px("21947.75"));
    expect(p.stopDiscrepancyTicks).toBe(0);
    expect(p.extremeCloseText).toBe("22040.00");
    expect(p.markTicks).toBe(px("22010.25"));
    expect(p.markObservedAt).toBe("2026-02-12T21:00:00Z");
    expect(p.barsHeld).toBe(3);
    expect(p.flags).toEqual(["DATA STALE"]);
    expect(p.rMultipleText).toBe("0.19 R");
    expect(p.originalRiskText).toBe("2,120.00");
    expect(p.stopFrozenReason).toBeNull();
  });

  it("trims feedback to K and lessons to N, keeping the newest, and passes the digest through", () => {
    const feedback: ProposalOutcome[] = Array.from({ length: 25 }, (_, i) => ({
      responseId: `r${i}`,
      barEnd: `2026-02-${String(i + 1).padStart(2, "0")}T21:00:00Z`,
      action: "wait",
      root: null,
      side: null,
      disposition: "not-executed",
      fill: null,
      exitReason: null,
      realizedR: null,
      barsHeld: null,
      invalidation: [],
    }));
    const lessons: Lesson[] = Array.from({ length: 35 }, (_, i) => ({
      campaignId: `c${i}`,
      whatHeld: [],
      whatFailed: [],
      weighDifferently: [],
      evidenceToWatch: [],
    }));
    const digest: Digest = { version: 1, lessonsCovered: 5, summary: "s", whatHeld: [], whatFailed: [], weighDifferently: [], evidenceToWatch: [] };
    const req = buildRequest({
      callKind: "decision",
      mode: "paperModel",
      histories: histories(),
      ledger: ledgerState(),
      feedback,
      lessons,
      digest,
      memoryEpochId: "epoch-1",
    });
    expect(req.feedback).toHaveLength(DEFAULT_INTERPRETER_CONFIG.feedbackK);
    expect(req.feedback[req.feedback.length - 1]!.responseId).toBe("r24");
    expect(req.feedback[0]!.responseId).toBe("r5");
    expect(req.lessons).toHaveLength(DEFAULT_INTERPRETER_CONFIG.lessonsN);
    expect(req.lessons[req.lessons.length - 1]!.campaignId).toBe("c34");
    expect(req.digest).toEqual(digest);
    expect(req.memoryEpochId).toBe("epoch-1");
  });

  it("empty histories produce no markets and no candidates", () => {
    const req = buildRequest({ callKind: "decision", mode: "paper", histories: {}, ledger: ledgerState() });
    expect(req.markets).toEqual([]);
    expect(req.bounds.allowedCandidates).toEqual([]);
    expect(req.bounds.entriesPermitted).toBe(false);
    expect(req.barEnd).toBe("");
    expect(req.dataSourceKind).toBe("none");
  });
});
