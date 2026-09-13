import { describe, expect, it } from "vitest";
import { INITIAL_MEMORY_EPOCH, type Campaign, type LedgerState } from "../campaign/types";
import { modelConfig, type InstrumentRoot } from "../config/modelConfig";
import { fixtureSnapshots } from "../fixtures/snapshots";
import type { SignalSnapshot } from "../formula/types";
import { INSTRUMENTS } from "../instruments/metadata";
import { mils } from "../numerics/money";
import { toTicks, type Ticks } from "../numerics/ticks";
import { perContractRisk, positionSize } from "../sizing/sizing";
import { initialStop, stopDistance } from "../stops/stops";
import { buildRequest } from "./buildRequest";
import { clampProposal, clampStop } from "./clamp";
import type { InterpreterRequest, InterpreterResponse, Proposal } from "./types";

const SNAPS = fixtureSnapshots();
const px = (s: string): Ticks => toTicks(s, INSTRUMENTS.NQ.tick, "exact");
/** NQ fixture: close 88000 ticks, ATR 100 ticks, H 0.60 → D long 210, D short 150. */
const NQ_CLOSE = 88000;

function histories(roots: readonly InstrumentRoot[] = ["NQ", "ES", "RTY", "YM", "ZN", "GC"]) {
  const out: Partial<Record<InstrumentRoot, SignalSnapshot[]>> = {};
  for (const root of roots) {
    const base = SNAPS.find((s) => s.root === root);
    if (base) out[root] = [structuredClone(base)];
  }
  return out;
}

function ledgerState(over: Partial<LedgerState> = {}): LedgerState {
  return {
    mode: "paperModel",
    campaigns: {},
    campaignOrder: [],
    activeCampaignId: null,
    marks: {},
    paused: false,
    stopMonitor: { healthy: true, lastCheckedAt: null, detail: "checked" },
    startingEquityMils: mils(1_000_000_000),
    cashMils: mils(1_000_000_000),
    externalCashFlowMils: mils(0),
    cumulativeNetRealizedMils: mils(0),
    equitySeries: [],
    appliedEventIds: [],
    supersededEventIds: [],
    interpreter: {
      latestResponseByBar: {},
      latestResponse: null,
      lessons: [],
      digest: null,
      memoryEpochId: INITIAL_MEMORY_EPOCH,
      archivedEpochIds: [],
      usage: { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costEstimateMils: mils(0), latencyMsTotal: 0 },
    },
    ...over,
  };
}

function openCampaign(side: 1 | -1 = 1, stop = px("21947.75")): Campaign {
  const nq = SNAPS.find((s) => s.root === "NQ")!;
  const dist = stopDistance(nq.raw.atr20Ticks, nq.H, side, modelConfig);
  if (!dist.ok) throw new Error(dist.reason.detail);
  const entry = px("22000.25");
  const state = initialStop({ side, entryFill: entry, distance: dist.value, calculatedAt: nq.availableAt });
  const risk = perContractRisk({ entryFill: entry, stopExitFill: px("21947.50"), tickValueMils: INSTRUMENTS.NQ.tickValueMils, cost: modelConfig.costs.NQ });
  const sizing = positionSize({ equityMils: mils(1_000_000_000), perContractRiskMils: risk.totalMils, cfg: modelConfig });
  return {
    id: "paperModel:NQ:1",
    mode: "paperModel",
    root: "NQ",
    contract: INSTRUMENTS.NQ.contract,
    side,
    state: "OPEN",
    frozenConfig: modelConfig,
    frozenSnapshot: nq,
    decisionDistance: dist.value,
    plan: { contracts: sizing.contracts, plannedEntry: entry, plannedStop: state.stop, riskBudgetMils: sizing.budgetMils, perContractRisk: risk, sizing },
    fills: [],
    lots: [{ price: entry, remaining: 1 }],
    entryQuantity: 1,
    exitQuantity: 0,
    remaining: 1,
    entryBasisTicksQty: entry,
    originalRiskMils: mils(1_060_000),
    grossRealizedMils: mils(0),
    feesMils: mils(2500),
    netRealizedMils: mils(-2500),
    proposedStop: { ...state, stop },
    restingStop: { ...state, stop },
    brokerStop: null,
    closeRequested: null,
    extremeClose: px("22040"),
    exposureBars: 2,
    deviationReasons: [],
    stopFrozenReason: null,
    queuedAt: "2026-02-01T21:05:00Z",
    openedAt: "2026-02-02T21:00:00Z",
    closedAt: null,
    cancelReason: null,
    interpreterResponseId: "resp-1",
  };
}

function request(over: { callKind?: "decision" | "observation"; ledger?: LedgerState; roots?: readonly InstrumentRoot[] } = {}): InterpreterRequest {
  return buildRequest({
    callKind: over.callKind ?? "decision",
    mode: "paperModel",
    histories: histories(over.roots),
    ledger: over.ledger ?? ledgerState(),
  });
}

function response(proposal: Partial<Proposal>): InterpreterResponse {
  return {
    promptVersion: "interp-0.1",
    readings: [{ root: "NQ", activity: "building", breadth: "broadening", priceResponse: "responding", noiseFlag: false, evidence: ["u rose"] }],
    crossMarket: { summary: "NQ leads", supports: [], contradicts: [] },
    hypothesis: "Participation is building in NQ.",
    proposal: { action: "wait", root: null, side: null, entryZone: null, stopTicks: null, invalidation: [], rationale: "…", ...proposal },
    evidenceStrength: "moderate",
  };
}

describe("clampStop", () => {
  it("keeps a stop inside the long and short bounds", () => {
    expect(clampStop(88000, 87900, 210, 1, 1)).toEqual({ stop: 87900, lo: 87790, hi: 87999 });
    expect(clampStop(88000, 88100, 150, 1, -1)).toEqual({ stop: 88100, lo: 88001, hi: 88150 });
  });

  it("pulls a too-wide stop to the maximum distance and a too-near stop to one tick", () => {
    expect(clampStop(88000, 87000, 210, 1, 1)!.stop).toBe(87790);
    expect(clampStop(88000, 88500, 210, 1, 1)!.stop).toBe(87999);
    expect(clampStop(88000, 99000, 150, 1, -1)!.stop).toBe(88150);
    expect(clampStop(88000, 87000, 150, 1, -1)!.stop).toBe(88001);
  });

  it("rounds the wide bound toward the reference so the distance never exceeds maxD", () => {
    // maxD 210.4 ticks: the widest long stop is ceil(88000 - 210.4) = 87790, exactly 210 ticks away
    expect(clampStop(88000, 1, 210.4, 1, 1)!.stop).toBe(87790);
    expect(clampStop(88000, 999_999, 210.4, 1, -1)!.stop).toBe(88210);
  });

  it("returns null when the bounds are empty", () => {
    expect(clampStop(88000, 87999, 0.5, 1, 1)).toBeNull();
    expect(clampStop(5, 1, 210, 1, 1)).toBeNull();
  });
});

describe("clampProposal — enter", () => {
  const enter = (over: Partial<Proposal> = {}) => response({ action: "enter", root: "NQ", side: 1, stopTicks: 87900, ...over });

  it("passes a proposal that is already inside the bounds, with no clamp event", () => {
    const r = clampProposal({ response: enter(), request: request(), responseId: "resp-1" });
    expect(r.executable).toEqual({
      action: "enter",
      root: "NQ",
      side: 1,
      entryReferenceTicks: NQ_CLOSE,
      stopTicks: 87900,
      originalStopTicks: 87900,
      reasons: [],
    });
    expect(r.events).toEqual([]);
    expect(r.reasons).toEqual([]);
  });

  it("clamps a stop wider than maxD and logs before and after", () => {
    const r = clampProposal({ response: enter({ stopTicks: 87000 }), request: request(), responseId: "resp-1" });
    expect(r.executable).toMatchObject({ action: "enter", stopTicks: 87790, originalStopTicks: 87000 });
    expect(r.reasons[0]).toBe("stop 87000 clamped to 87790 ticks, inside [87790, 87999] around reference 88000 (max distance 210, min 1)");
    expect(r.events).toHaveLength(1);
    const event = r.events[0]!;
    expect(event.type).toBe("INTERPRETER_CLAMPED");
    if (event.type !== "INTERPRETER_CLAMPED") throw new Error("expected a clamp event");
    expect(event.before).toEqual({ action: "enter", root: "NQ", side: 1, stopTicks: 87000, entryZone: null });
    expect(event.after).toMatchObject({ stopTicks: 87790 });
    expect(event.responseId).toBe("resp-1");
    expect(event.id).toBe("interp:paperModel:2026-01-02T21:00:00Z:decision:claude-opus-5:interp-0.1:clamped");
  });

  it("clamps a long stop proposed above the reference to one tick below it", () => {
    const r = clampProposal({ response: enter({ stopTicks: 88500 }), request: request() });
    expect(r.executable).toMatchObject({ stopTicks: 87999 });
    expect(r.events).toHaveLength(1);
  });

  it("mirrors the bounds for a short", () => {
    const rty = buildRequest({ callKind: "decision", mode: "paperModel", histories: histories(["RTY"]), ledger: ledgerState() });
    const short = response({ action: "enter", root: "RTY", side: -1, stopTicks: 99_999 });
    const r = clampProposal({ response: short, request: rty });
    // RTY close 21000 ticks, ATR 70 ticks, H -0.46 → D short = 70 x (1.5 + 0.46) = 137.2 → floor(21000 + 137.2)
    expect(r.executable).toMatchObject({ action: "enter", side: -1, stopTicks: 21137, originalStopTicks: 99_999 });
    expect(r.reasons[0]).toMatch(/^stop 99999 clamped to 21137 ticks/);
  });

  it("refuses an entry on an observation call", () => {
    const r = clampProposal({ response: enter(), request: request({ callKind: "observation" }) });
    expect(r.executable).toBeNull();
    expect(r.reasons).toEqual(["entries are never proposed from an observation call"]);
    expect(r.events).toHaveLength(1);
  });

  it("refuses an entry when entries are not permitted (paused, active position, stale data)", () => {
    const paused = clampProposal({ response: enter(), request: request({ ledger: ledgerState({ paused: true }) }) });
    expect(paused.executable).toBeNull();
    expect(paused.reasons).toEqual(["entries not permitted: the engine is paused"]);

    const c = openCampaign();
    const active = clampProposal({
      response: enter(),
      request: request({ ledger: ledgerState({ campaigns: { [c.id]: c }, campaignOrder: [c.id], activeCampaignId: c.id }) }),
    });
    expect(active.executable).toBeNull();
    expect(active.reasons[0]).toMatch(/is already active \(one position per mode\)/);

    const stale = clampProposal({ response: response({ action: "enter", root: "ZN", side: 1, stopTicks: 7000 }), request: request({ roots: ["ZN"] }) });
    expect(stale.executable).toBeNull();
    expect(stale.reasons).toEqual(["entries not permitted: no market has a valid, fresh snapshot at this bar"]);
  });

  it("refuses an entry for a market outside the candidate set", () => {
    const narrowed = request();
    narrowed.bounds.allowedCandidates = ["ES"];
    const r = clampProposal({ response: enter(), request: narrowed });
    expect(r.executable).toBeNull();
    expect(r.reasons).toEqual(["NQ is not in the allowed candidate set (ES)"]);
    expect(r.events).toHaveLength(1);
  });

  it("refuses an entry for an unavailable snapshot even if the candidate list names it", () => {
    const req = request();
    req.bounds.allowedCandidates = ["ZN"];
    const r = clampProposal({ response: response({ action: "enter", root: "ZN", side: 1, stopTicks: 7000 }), request: req });
    expect(r.executable).toBeNull();
    expect(r.reasons).toEqual(["ZN snapshot is unavailable: BREADTH_MODEL_UNDEFINED"]);
  });

  it("refuses an entry with no stop distance for the proposed side", () => {
    const req = request();
    req.bounds.maxDTicks.NQ = { long: null, short: 150 };
    const r = clampProposal({ response: enter(), request: req });
    expect(r.executable).toBeNull();
    expect(r.reasons).toEqual(["NQ has no stop distance for this side; ATR or breadth is unavailable"]);
  });

  it("refuses an entry when the bounds are empty or the reference is missing", () => {
    const tight = request();
    tight.bounds.maxDTicks.NQ = { long: 0.5, short: 150 };
    expect(clampProposal({ response: enter(), request: tight }).reasons).toEqual([
      "NQ stop bounds are empty: max distance 0.5 ticks is below the 1 tick minimum",
    ]);
    const noClose = request();
    noClose.markets.find((m) => m.root === "NQ")!.bars[0]!.prices.closeTicks = null;
    expect(clampProposal({ response: enter(), request: noClose }).reasons).toEqual(["NQ has no completed close to price the stop against"]);
  });
});

describe("clampProposal — tighten, exit, wait and hold", () => {
  const withPosition = (side: 1 | -1 = 1, stop = px("21947.75")) => {
    const c = openCampaign(side, stop);
    return request({ callKind: "observation", ledger: ledgerState({ campaigns: { [c.id]: c }, campaignOrder: [c.id], activeCampaignId: c.id }) });
  };

  it("accepts a tighten that moves the stop in the ratchet direction", () => {
    const r = clampProposal({ response: response({ action: "tighten", root: "NQ", side: 1, stopTicks: 87950 }), request: withPosition() });
    expect(r.executable).toEqual({ action: "tighten", root: "NQ", stopTicks: 87950 });
    expect(r.events).toEqual([]);
  });

  it("refuses a tighten that would loosen the stop, in both directions", () => {
    const long = clampProposal({ response: response({ action: "tighten", root: "NQ", side: 1, stopTicks: 87700 }), request: withPosition() });
    expect(long.executable).toBeNull();
    expect(long.reasons).toEqual(["tighten must move the stop in the ratchet direction: above the current 87791 ticks, got 87700"]);
    expect(long.events).toHaveLength(1);

    const short = clampProposal({
      response: response({ action: "tighten", root: "NQ", side: -1, stopTicks: 88300 }),
      request: withPosition(-1, px("22052.25")),
    });
    expect(short.executable).toBeNull();
    expect(short.reasons[0]).toBe("tighten must move the stop in the ratchet direction: below the current 88209 ticks, got 88300");
  });

  it("refuses a tighten or exit with no open position or the wrong market", () => {
    const flat = clampProposal({ response: response({ action: "tighten", root: "NQ", side: 1, stopTicks: 87950 }), request: request({ callKind: "observation" }) });
    expect(flat.executable).toBeNull();
    expect(flat.reasons).toEqual(["tighten proposed with no open position"]);

    const wrong = clampProposal({ response: response({ action: "exit", root: "ES", side: 1 }), request: withPosition() });
    expect(wrong.executable).toBeNull();
    expect(wrong.reasons).toEqual(["exit names ES but the open position is NQ"]);
  });

  it("refuses a tighten or exit while the engine is paused", () => {
    const c = openCampaign();
    const paused = request({
      callKind: "observation",
      ledger: ledgerState({ campaigns: { [c.id]: c }, campaignOrder: [c.id], activeCampaignId: c.id, paused: true }),
    });
    const r = clampProposal({ response: response({ action: "exit", root: "NQ", side: 1 }), request: paused });
    expect(r.executable).toBeNull();
    expect(r.reasons).toEqual(["the engine is paused; the proposal is logged, not executed"]);
    expect(r.events).toHaveLength(1);
  });

  it("turns exit into a close request, never a fill", () => {
    const r = clampProposal({ response: response({ action: "exit", root: "NQ", side: 1 }), request: withPosition() });
    expect(r.executable).toEqual({ action: "exit", root: "NQ" });
    expect(r.events).toEqual([]);
  });

  it("returns nothing executable for wait and hold, and logs no clamp", () => {
    for (const action of ["wait", "hold"] as const) {
      const r = clampProposal({ response: response({ action, root: action === "hold" ? "NQ" : null }), request: withPosition() });
      expect(r.executable).toBeNull();
      expect(r.events).toEqual([]);
      expect(r.reasons).toEqual([`no executable action: ${action}`]);
    }
  });
});
