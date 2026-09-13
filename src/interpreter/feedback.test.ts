import { describe, expect, it } from "vitest";
import type { InterpreterResponseEvent, LedgerEvent } from "../campaign/types";
import { freezeModelConfig, modelConfig } from "../config/modelConfig";
import { fixtureSnapshots } from "../fixtures/snapshots";
import type { SignalSnapshot } from "../formula/types";
import { INSTRUMENTS } from "../instruments/metadata";
import { Ledger } from "../ledger/ledger";
import { mils } from "../numerics/money";
import { toTicks, type Ticks } from "../numerics/ticks";
import { perContractRisk, positionSize } from "../sizing/sizing";
import { stopDistance } from "../stops/stops";
import { evaluateInvalidation, outcomesForLastK, type SnapshotsByBar } from "./feedback";
import type { Invalidation, InterpreterResponse, Proposal } from "./types";

const NQ = fixtureSnapshots().find((s) => s.root === "NQ")!;
const ES = fixtureSnapshots().find((s) => s.root === "ES")!;
const px = (s: string): Ticks => toTicks(s, INSTRUMENTS.NQ.tick, "exact");
const B = (n: number) => `2026-03-0${n}T21:00:00Z`;

/**
 * Five NQ bars. B1 is the proposal bar; breadth falls to 0.30 on B3 and price turns down there too;
 * the displayed score only falls under 1.00 on B4, which is the exit bar.
 */
function nqBar(barEnd: string, over: { H?: number; u?: number; A?: number; displayScore?: number; close?: string }): SignalSnapshot {
  const s = structuredClone(NQ);
  s.barEnd = barEnd;
  s.availableAt = barEnd.replace("21:00", "21:05");
  if (over.H !== undefined) s.H = over.H;
  if (over.u !== undefined) s.u = over.u;
  if (over.A !== undefined) s.A = over.A;
  if (over.displayScore !== undefined) s.displayScore = over.displayScore;
  if (over.close !== undefined) s.raw.closeT = px(over.close);
  return s;
}

function snapshotsByBar(): SnapshotsByBar {
  const esAt = (barEnd: string) => {
    const e = structuredClone(ES);
    e.barEnd = barEnd;
    return e;
  };
  return {
    [B(1)]: [nqBar(B(1), { H: 0.6, u: 3.0, A: 0.6, displayScore: 2.2, close: "22000" }), esAt(B(1))],
    [B(2)]: [nqBar(B(2), { H: 0.6, u: 2.9, A: 0.6, displayScore: 2.0, close: "22025" }), esAt(B(2))],
    [B(3)]: [nqBar(B(3), { H: 0.3, u: 2.4, A: 0.6, displayScore: 1.5, close: "21975" }), esAt(B(3))],
    [B(4)]: [nqBar(B(4), { H: 0.2, u: 2.0, A: 0.6, displayScore: 0.5, close: "21947.50" }), esAt(B(4))],
    [B(5)]: [nqBar(B(5), { H: 0.1, u: 1.5, A: 0.2, displayScore: -1.0, close: "21900" }), esAt(B(5))],
  };
}

const INVALIDATION: Invalidation[] = [
  { kind: "H_below", root: "NQ", threshold: 0.4, note: "breadth falls back under the entry level" },
  { kind: "S_below", root: "NQ", threshold: 1.0, note: "score drops under the entry threshold" },
  { kind: "breadth_concentrates", root: "NQ", threshold: 0.3, note: "activity narrows" },
  { kind: "cross_market", root: "ES", threshold: null, note: "ES turns down while NQ holds" },
  { kind: "u_falls_below", root: "NQ", threshold: null, note: "u weakens (no level given)" },
];

function responseOf(proposal: Partial<Proposal>): InterpreterResponse {
  return {
    promptVersion: "interp-0.1",
    readings: [{ root: "NQ", activity: "building", breadth: "broadening", priceResponse: "responding", noiseFlag: false, evidence: ["u rose to 3.00"] }],
    crossMarket: { summary: "NQ leads", supports: ["ES"], contradicts: [] },
    hypothesis: "Participation is building in NQ.",
    proposal: { action: "wait", root: null, side: null, entryZone: null, stopTicks: null, invalidation: [], rationale: "…", ...proposal },
    evidenceStrength: "moderate",
  };
}

function responseEvent(id: string, responseId: string, barEnd: string, response: InterpreterResponse): InterpreterResponseEvent {
  return {
    id,
    type: "INTERPRETER_RESPONSE",
    timestamp: barEnd,
    actual: false,
    responseId,
    barEnd,
    callKind: "decision",
    model: "claude-opus-5",
    promptVersion: "interp-0.1",
    response,
    usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 },
    latencyMs: 1200,
    costEstimateMils: mils(22_500),
  };
}

/** A paperModel ledger holding one proposal that entered, trailed and stopped out at B4. */
function closedCampaignLedger(): Ledger {
  const ledger = new Ledger("paperModel");
  const dist = stopDistance(NQ.raw.atr20Ticks, NQ.H, 1, modelConfig);
  if (!dist.ok) throw new Error(dist.reason.detail);
  const risk = perContractRisk({ entryFill: px("22000.25"), stopExitFill: px("21947.50"), tickValueMils: INSTRUMENTS.NQ.tickValueMils, cost: modelConfig.costs.NQ });
  const sizing = positionSize({ equityMils: mils(1_000_000_000), perContractRiskMils: risk.totalMils, cfg: modelConfig });
  const frozenSnapshot = nqBar(B(1), { close: "22000" });
  const events: LedgerEvent[] = [
    responseEvent("e-resp-1", "resp-1", B(1), responseOf({ action: "enter", root: "NQ", side: 1, stopTicks: 87791, invalidation: INVALIDATION })),
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

describe("outcomesForLastK on a closed campaign", () => {
  const ledger = closedCampaignLedger();
  const outcomes = outcomesForLastK(ledger, snapshotsByBar(), 20);

  it("reports the executed proposal with its fill, exit reason, realized R and bars held", () => {
    expect(outcomes).toHaveLength(1);
    const o = outcomes[0]!;
    expect(o.responseId).toBe("resp-1");
    expect(o.barEnd).toBe(B(1));
    expect(o.action).toBe("enter");
    expect(o.root).toBe("NQ");
    expect(o.side).toBe(1);
    expect(o.disposition).toBe("executed");
    expect(o.rejectionReason).toBeNull();
    expect(o.clampReasons).toEqual([]);
    expect(o.fill).toEqual({ priceTicks: px("22000.25"), priceText: "22000.25", quantity: 1 });
    expect(o.exitReason).toBe("stop-touched");
    // net realized -1,060,000 mils against a frozen risk of 1,060,000 mils
    expect(o.realizedR).toBeCloseTo(-1, 12);
    expect(o.realizedRText).toBe("-1.00 R");
    expect(ledger.campaigns[0]!.state).toBe("CLOSED");
  });

  it("evaluates each invalidation condition the model named, and says when it cannot", () => {
    const byKind = new Map(outcomesForLastK(ledger, snapshotsByBar(), 20)[0]!.invalidation.map((i) => [i.condition.kind, i]));
    // breadth fell to 0.30 on bar 3, before the bar-4 exit
    expect(byKind.get("H_below")).toMatchObject({ appearedBeforeStop: true, note: `first met at ${B(3)}, before the exit bar ${B(4)}` });
    // the score only fell under 1.00 on the exit bar itself, which is not "before"
    expect(byKind.get("S_below")).toMatchObject({ appearedBeforeStop: false, note: `first met at ${B(4)}, not before the exit bar ${B(4)}` });
    // A stayed at 0.60 through the exit
    expect(byKind.get("breadth_concentrates")).toMatchObject({ appearedBeforeStop: false, note: `not met through ${B(4)}` });
    // cross_market and a missing threshold are not evaluable
    expect(byKind.get("cross_market")).toMatchObject({ appearedBeforeStop: null });
    expect(byKind.get("cross_market")!.note).toMatch(/^not evaluable: cross_market/);
    expect(byKind.get("u_falls_below")).toMatchObject({ appearedBeforeStop: null, note: "not evaluable: no threshold to compare against" });
  });

  it("includes rejected responses with a null action and the reason", () => {
    const l = closedCampaignLedger();
    l.append({
      id: "rej-1",
      type: "INTERPRETER_REJECTED",
      timestamp: B(5),
      actual: false,
      barEnd: B(5),
      callKind: "decision",
      model: "claude-opus-5",
      promptVersion: "interp-0.1",
      reason: "proposal.action enter requires a root",
    });
    const out = outcomesForLastK(l, snapshotsByBar(), 20);
    expect(out).toHaveLength(2);
    const rejected = out[1]!;
    expect(rejected.disposition).toBe("rejected");
    expect(rejected.action).toBeNull();
    expect(rejected.root).toBeNull();
    expect(rejected.rejectionReason).toBe("proposal.action enter requires a root");
    expect(rejected.realizedRText).toBe("—");
    expect(rejected.invalidation).toEqual([]);
  });

  it("reports a clamped proposal that never opened a campaign", () => {
    const l = new Ledger("paperModel");
    l.append(responseEvent("e-2", "resp-2", B(2), responseOf({ action: "enter", root: "NQ", side: 1, stopTicks: 87000, invalidation: [] })));
    l.append({
      id: "clamp-2",
      type: "INTERPRETER_CLAMPED",
      timestamp: B(2),
      actual: false,
      responseId: "resp-2",
      barEnd: B(2),
      callKind: "decision",
      before: { action: "enter", root: "NQ", side: 1, stopTicks: 87000, entryZone: null },
      after: null,
      reasons: ["NQ is not in the allowed candidate set (ES)"],
    });
    const o = outcomesForLastK(l, snapshotsByBar(), 20)[0]!;
    expect(o.disposition).toBe("clamped");
    expect(o.clampReasons).toEqual(["NQ is not in the allowed candidate set (ES)"]);
    expect(o.fill).toBeNull();
    expect(o.barsHeld).toBeNull();
  });

  it("reports wait proposals as not executed and trims to the last K", () => {
    const l = new Ledger("paperModel");
    for (let i = 1; i <= 5; i++) {
      l.append(responseEvent(`e-${i}`, `resp-${i}`, B(i), responseOf({ action: "wait", root: "NQ" })));
    }
    const all = outcomesForLastK(l, snapshotsByBar(), 20);
    expect(all).toHaveLength(5);
    expect(all.every((o) => o.disposition === "not-executed")).toBe(true);
    const last2 = outcomesForLastK(l, snapshotsByBar(), 2);
    expect(last2.map((o) => o.responseId)).toEqual(["resp-4", "resp-5"]);
    expect(outcomesForLastK(l, snapshotsByBar(), 0)).toEqual([]);
  });
});

describe("evaluateInvalidation", () => {
  const bars = snapshotsByBar();
  const evaluate = (condition: Invalidation, over: { side?: 1 | -1 | null; exitBarEnd?: string | null; proposalBarEnd?: string } = {}) =>
    evaluateInvalidation({
      condition,
      proposalBarEnd: over.proposalBarEnd ?? B(1),
      side: over.side === undefined ? 1 : over.side,
      snapshotsByBar: bars,
      exitBarEnd: over.exitBarEnd === undefined ? B(4) : over.exitBarEnd,
    });

  it("price_reverses compares later closes with the proposal bar close, by side", () => {
    const condition: Invalidation = { kind: "price_reverses", root: "NQ", threshold: null, note: "price turns against the trade" };
    // long: close falls under 22000 on bar 3
    expect(evaluate(condition)).toMatchObject({ appearedBeforeStop: true, note: `first met at ${B(3)}, before the exit bar ${B(4)}` });
    // short: closes above 22000 count instead, and bar 2 is the first
    expect(evaluate(condition, { side: -1 })).toMatchObject({ appearedBeforeStop: true, note: `first met at ${B(2)}, before the exit bar ${B(4)}` });
    // without a side there is nothing to compare
    expect(evaluate(condition, { side: null })).toMatchObject({ appearedBeforeStop: null, note: "not evaluable: price_reverses needs the proposal's side" });
  });

  it("scans past the exit bar only when the campaign is still open", () => {
    const condition: Invalidation = { kind: "S_below", root: "NQ", threshold: 1.0, note: "score drops" };
    expect(evaluate(condition, { exitBarEnd: B(3) })).toMatchObject({ appearedBeforeStop: false, note: `not met through ${B(3)}` });
    expect(evaluate(condition, { exitBarEnd: null })).toMatchObject({
      appearedBeforeStop: true,
      note: `first met at ${B(4)}; the campaign has no exit bar yet`,
    });
  });

  it("is not evaluable without bars after the proposal or without snapshots for the market", () => {
    const condition: Invalidation = { kind: "S_below", root: "NQ", threshold: 1.0, note: "score drops" };
    expect(evaluate(condition, { proposalBarEnd: B(5), exitBarEnd: null })).toMatchObject({
      appearedBeforeStop: null,
      note: "not evaluable: no bars after the proposal",
    });
    const rtyOnly: Invalidation = { kind: "S_below", root: "RTY", threshold: 1.0, note: "RTY score drops" };
    expect(evaluateInvalidation({ condition: rtyOnly, proposalBarEnd: B(1), side: 1, snapshotsByBar: bars, exitBarEnd: B(4) })).toMatchObject({
      appearedBeforeStop: null,
      note: "not evaluable: RTY has no snapshot on any bar after the proposal",
    });
  });

  it("H_below uses the proposal side and needs one", () => {
    const condition: Invalidation = { kind: "H_below", root: "NQ", threshold: 0.4, note: "breadth weakens" };
    expect(evaluate(condition)).toMatchObject({ appearedBeforeStop: true });
    // for a short, d x H = -0.60 is already under 0.40 on the first later bar
    expect(evaluate(condition, { side: -1 })).toMatchObject({ appearedBeforeStop: true, note: `first met at ${B(2)}, before the exit bar ${B(4)}` });
    expect(evaluate(condition, { side: null })).toMatchObject({ appearedBeforeStop: null, note: "not evaluable: H_below needs the proposal's side" });
  });
});
