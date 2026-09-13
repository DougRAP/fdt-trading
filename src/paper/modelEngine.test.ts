import { describe, expect, it } from "vitest";
import { modelConfig, type InstrumentRoot } from "../config/modelConfig";
import { fixtureSnapshotHistory, fixtureSnapshotsByBar, HISTORY_BARS } from "../fixtures/snapshotHistory";
import { INSTRUMENTS } from "../instruments/metadata";
import { Ledger } from "../ledger/ledger";
import { MemoryStorage, loadLedger, saveLedger } from "../ledger/storage";
import { toTicks, type Ticks } from "../numerics/ticks";
import type { InterpreterCallBody, InterpreterCallResult } from "../interpreter/client";
import type { Digest, InterpreterResponse, Lesson, Proposal } from "../interpreter/types";
import type { EngineBar, TrailInputs } from "./engine";
import { askModel, hashRequest, onModelBar, onModelDecisionBar, type ModelEngineInput } from "./modelEngine";

const HISTORY = fixtureSnapshotHistory();
const BY_BAR = fixtureSnapshotsByBar();
const NQ_HISTORY = HISTORY.NQ;
const DECISION_BAR = NQ_HISTORY[NQ_HISTORY.length - 1]!.barEnd;
const px = (s: string): Ticks => toTicks(s, INSTRUMENTS.NQ.tick, "exact");
/** NQ decision close and the rules D for a long: 88000 ticks, ATR 100, H 0.60 → 210 ticks. */
const NQ_CLOSE = 88000;

function bar(day: number, o: string, h: string, l: string, c: string, root: InstrumentRoot = "NQ"): EngineBar {
  const d = String(day).padStart(2, "0");
  return { root, barEnd: `2026-01-${d}T21:00:00Z`, availableAt: `2026-01-${d}T21:05:00Z`, open: px(o), high: px(h), low: px(l), close: px(c) };
}
const TRAIL: TrailInputs = { atrTicks: 100, H: 0.6 };

function response(proposal: Partial<Proposal>, roots: readonly InstrumentRoot[] = ["NQ", "ES", "RTY", "YM", "ZN", "GC"]): InterpreterResponse {
  return {
    promptVersion: modelConfig.interpreter.promptVersion,
    readings: roots.map((root) => ({
      root,
      activity: "building" as const,
      breadth: "broadening" as const,
      priceResponse: "responding" as const,
      noiseFlag: false,
      evidence: [`${root} read from the request`],
    })),
    crossMarket: { summary: "NQ leads the equity complex.", supports: [], contradicts: [] },
    hypothesis: "Participation is building in NQ.",
    proposal: { action: "wait", root: null, side: null, entryZone: null, stopTicks: null, invalidation: [], rationale: "…", ...proposal },
    evidenceStrength: "moderate",
  };
}

const LESSON: Lesson = { campaignId: "", whatHeld: ["breadth held for two bars"], whatFailed: [], weighDifferently: [], evidenceToWatch: [] };
const DIGEST: Digest = { version: 1, lessonsCovered: 1, summary: "one campaign", whatHeld: [], whatFailed: [], weighDifferently: [], evidenceToWatch: [] };

interface Fake {
  interpreter: ModelEngineInput["interpreter"];
  calls: InterpreterCallBody[];
}

/** A fake interpreter: canned answers per call kind, recording every call it receives. */
function fake(answers: {
  interpret?: InterpreterResponse | ((body: InterpreterCallBody) => InterpreterResponse | InterpreterCallResult);
  lesson?: Lesson | ((body: InterpreterCallBody) => Lesson | InterpreterCallResult);
  digest?: Digest;
  fail?: InterpreterCallResult;
  throws?: Error;
}): Fake {
  const calls: InterpreterCallBody[] = [];
  const ok = (value: unknown, kind: InterpreterCallBody["kind"]): InterpreterCallResult => ({
    ok: true,
    kind,
    response: value,
    usage: { inputTokens: 5000, cachedInputTokens: 12_000, outputTokens: 800 },
    model: modelConfig.interpreter.model,
    latencyMs: 3300,
    costEstimateMils: 141_000,
    promptVersion: modelConfig.interpreter.promptVersion,
  });
  return {
    calls,
    interpreter: async (body) => {
      calls.push(body);
      if (answers.throws) throw answers.throws;
      if (answers.fail) return answers.fail;
      if (body.kind === "lesson") {
        const l = typeof answers.lesson === "function" ? answers.lesson(body) : (answers.lesson ?? { ...LESSON, campaignId: body.request.campaignSummary?.campaignId ?? "" });
        return "ok" in (l as object) ? (l as InterpreterCallResult) : ok(l, "lesson");
      }
      if (body.kind === "digest") return ok(answers.digest ?? DIGEST, "digest");
      const r = typeof answers.interpret === "function" ? answers.interpret(body) : (answers.interpret ?? response({}));
      return "ok" in (r as object) ? (r as InterpreterCallResult) : ok(r, "interpret");
    },
  };
}

function input(f: Fake): ModelEngineInput {
  return { interpreter: f.interpreter, histories: HISTORY, snapshotsByBar: BY_BAR };
}

describe("fixture snapshot history (D21)", () => {
  it("gives ten bars per market, oldest first, with the fixture snapshot newest", () => {
    for (const root of ["NQ", "ES", "RTY", "YM", "ZN", "GC"] as const) {
      const list = HISTORY[root];
      expect(list).toHaveLength(HISTORY_BARS);
      expect(list[0]!.barEnd < list[9]!.barEnd).toBe(true);
      expect(list[9]!.barEnd).toBe(DECISION_BAR);
      for (const s of list) {
        expect(s.dataSource.kind).toBe("fixture");
        expect(s.inputSourceIds.some((id) => id.startsWith("fixture:history:"))).toBe(true);
      }
    }
    // the newest NQ bar still carries the acceptance-check numbers
    const nq = NQ_HISTORY[9]!;
    expect(nq.u).toBeCloseTo(3.0, 12);
    expect(nq.S.long).toBeCloseTo(2.2, 10);
    expect(nq.raw.closeT).toBe(NQ_CLOSE);
    expect(nq.status).toBe("QUALIFIED");
  });

  it("is a continuous chain and reproduces exactly on every call", () => {
    const again = fixtureSnapshotHistory();
    expect(again).toEqual(HISTORY);
    for (let i = 1; i < NQ_HISTORY.length; i++) {
      // each bar's previous close is the bar before it
      expect(NQ_HISTORY[i]!.raw.closePrev).toBe(NQ_HISTORY[i - 1]!.raw.closeT);
      expect(NQ_HISTORY[i]!.raw.HPrev).toBeCloseTo(NQ_HISTORY[i - 1]!.H!, 4);
    }
    // breadth builds toward the decision bar
    expect(NQ_HISTORY[0]!.H!).toBeLessThan(NQ_HISTORY[9]!.H!);
    expect(Object.keys(BY_BAR)).toHaveLength(HISTORY_BARS);
    expect(BY_BAR[DECISION_BAR]).toHaveLength(6);
  });
});

describe("decision bar", () => {
  const enter = (over: Partial<Proposal> = {}) => response({ action: "enter", root: "NQ", side: 1, stopTicks: 87900, invalidation: [{ kind: "H_below", root: "NQ", threshold: 0.4, note: "breadth falls back" }], ...over });

  it("queues an entry from the clamped stop, sizes from it, and records the response id", async () => {
    const ledger = new Ledger("paperModel");
    const f = fake({ interpret: enter() });
    const result = await onModelDecisionBar(ledger, input(f));
    expect(result.kind).toBe("queued");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.kind).toBe("interpret");
    expect(f.calls[0]!.model).toBe("claude-opus-5");
    expect(f.calls[0]!.effort).toBe("high");
    expect(f.calls[0]!.request.callKind).toBe("decision");
    expect(f.calls[0]!.request.markets[0]!.bars).toHaveLength(HISTORY_BARS);

    const types = ledger.events.map((e) => e.type);
    expect(types).toEqual(["INTERPRETER_REQUEST", "INTERPRETER_RESPONSE", "CAMPAIGN_QUEUED"]);
    const c = ledger.activeCampaign!;
    expect(c.state).toBe("PENDING");
    expect(c.root).toBe("NQ");
    expect(c.side).toBe(1);
    expect(c.interpreterResponseId).toBe(ledger.state.interpreter.latestResponse!.responseId);
    // stop 87900 is inside [87790, 87999], so the model's 100-tick distance is kept
    expect(c.decisionDistance.dTicks).toBe(100);
    expect(c.plan.plannedEntry).toBe(px("22000.25"));
    expect(c.plan.plannedStop).toBe(px("21975.25"));
    // per-contract risk = 101 ticks x 5000 + 5000 fees; budget 2,500,000 → 4 contracts
    expect(c.plan.perContractRisk.totalMils).toBe(101 * 5000 + 5000);
    expect(c.plan.contracts).toBe(4);
    expect(ledger.state.interpreter.usage).toMatchObject({ calls: 1, inputTokens: 5000, cachedInputTokens: 12_000, outputTokens: 800, costEstimateMils: 141_000 });
  });

  it("clamps a stop wider than the rules maximum and sizes from the clamped value", async () => {
    const ledger = new Ledger("paperModel");
    const f = fake({ interpret: enter({ stopTicks: 80_000 }) });
    const result = await onModelDecisionBar(ledger, input(f));
    expect(result.kind).toBe("queued");
    expect(result.clamped).toMatchObject({ action: "enter", stopTicks: 87790, originalStopTicks: 80_000 });
    expect(ledger.events.map((e) => e.type)).toEqual(["INTERPRETER_REQUEST", "INTERPRETER_RESPONSE", "INTERPRETER_CLAMPED", "CAMPAIGN_QUEUED"]);
    const c = ledger.activeCampaign!;
    expect(c.decisionDistance.dTicks).toBe(210);
    expect(c.plan.plannedStop).toBe(px("21947.75"));
    expect(c.plan.perContractRisk.totalMils).toBe(1_060_000);
    expect(c.plan.contracts).toBe(2);
  });

  it("records a wait with no campaign and no clamp event", async () => {
    const ledger = new Ledger("paperModel");
    const result = await onModelDecisionBar(ledger, input(fake({ interpret: response({ action: "wait", root: "NQ" }) })));
    expect(result.kind).toBe("no-proposal");
    expect(result.clamped).toBeNull();
    expect(ledger.events.map((e) => e.type)).toEqual(["INTERPRETER_REQUEST", "INTERPRETER_RESPONSE"]);
    expect(ledger.activeCampaign).toBeNull();
  });

  it("logs a refused proposal without queueing anything", async () => {
    const ledger = new Ledger("paperModel");
    // ZN has no breadth model, so it is not a candidate
    const f = fake({ interpret: response({ action: "enter", root: "ZN", side: 1, stopTicks: 7000 }) });
    const result = await onModelDecisionBar(ledger, input(f));
    expect(result.kind).toBe("not-executable");
    expect(result.reasons[0]).toMatch(/ZN is not in the allowed candidate set/);
    expect(ledger.events.map((e) => e.type)).toEqual(["INTERPRETER_REQUEST", "INTERPRETER_RESPONSE", "INTERPRETER_CLAMPED"]);
    expect(ledger.activeCampaign).toBeNull();
  });

  it("appends only a rejection when the answer fails validation server-side or here", async () => {
    const serverRejected = new Ledger("paperModel");
    const f1 = fake({ fail: { ok: false, reason: "response.evidenceStrength must be one of weak | moderate | strong, got \"high\"", status: 422 } });
    const r1 = await onModelDecisionBar(serverRejected, input(f1));
    expect(r1.kind).toBe("rejected");
    expect(serverRejected.events.map((e) => e.type)).toEqual(["INTERPRETER_REQUEST", "INTERPRETER_REJECTED"]);
    expect(serverRejected.activeCampaign).toBeNull();

    // an answer that passes the wire but fails the client-side validator is also rejected
    const clientRejected = new Ledger("paperModel");
    const bad = { ...response({}), promptVersion: "interp-9.9" };
    const r2 = await onModelDecisionBar(clientRejected, input(fake({ interpret: bad as InterpreterResponse })));
    expect(r2.kind).toBe("rejected");
    expect(clientRejected.events.map((e) => e.type)).toEqual(["INTERPRETER_REQUEST", "INTERPRETER_REJECTED"]);
    const rejection = clientRejected.events.find((e) => e.type === "INTERPRETER_REJECTED");
    expect(rejection?.type === "INTERPRETER_REJECTED" && rejection.reason).toMatch(/promptVersion interp-9.9 does not match/);
  });

  it("records a network failure as a rejection and keeps the ledger otherwise untouched", async () => {
    const ledger = new Ledger("paperModel");
    const result = await onModelDecisionBar(ledger, input(fake({ fail: { ok: false, reason: "could not reach the interpreter function: offline", status: 0 } })));
    expect(result.kind).toBe("call-failed");
    expect(ledger.events.map((e) => e.type)).toEqual(["INTERPRETER_REQUEST", "INTERPRETER_REJECTED"]);
    expect(ledger.campaigns).toEqual([]);

    const thrown = new Ledger("paperModel");
    const t = await onModelDecisionBar(thrown, input(fake({ throws: new Error("boom") })));
    expect(t.kind).toBe("call-failed");
    expect(t.reasons[0]).toMatch(/interpreter call threw: boom/);
  });

  it("makes no second call for a bar that already has a stored response", async () => {
    const ledger = new Ledger("paperModel");
    const f = fake({ interpret: response({ action: "wait", root: "NQ" }) });
    await onModelDecisionBar(ledger, input(f));
    expect(f.calls).toHaveLength(1);
    const again = await onModelDecisionBar(ledger, input(f));
    expect(again.kind).toBe("already-answered");
    expect(f.calls).toHaveLength(1);
    expect(ledger.events).toHaveLength(2);
  });

  it("does not call while paused or while a campaign is active", async () => {
    const paused = new Ledger("paperModel");
    paused.append({ id: "p", type: "PAPER_PAUSED", timestamp: DECISION_BAR, actual: false });
    const f1 = fake({ interpret: enter() });
    expect((await onModelDecisionBar(paused, input(f1))).kind).toBe("paused");
    expect(f1.calls).toHaveLength(0);

    const active = new Ledger("paperModel");
    const f2 = fake({ interpret: enter() });
    await onModelDecisionBar(active, input(f2));
    const f3 = fake({ interpret: enter() });
    expect((await onModelDecisionBar(active, input(f3))).kind).toBe("position-active");
    expect(f3.calls).toHaveLength(0);
  });

  it("refuses to queue when the budget cannot fund one contract", async () => {
    const ledger = new Ledger("paperModel", { startingEquityMils: modelConfig.paperEquityStartMils });
    ledger.append({ id: "cf", type: "CASH_FLOW", timestamp: DECISION_BAR, actual: false, amountMils: -999_600_000 as never, note: "reduce equity for the test" });
    const f = fake({ interpret: enter({ stopTicks: 87790 }) });
    const result = await onModelDecisionBar(ledger, input(f));
    expect(result.kind).toBe("not-executable");
    expect(result.reasons.some((r) => r.includes("above the"))).toBe(true);
    expect(ledger.activeCampaign).toBeNull();
    expect(ledger.events.map((e) => e.type)).toContain("INTERPRETER_CLAMPED");
  });

  it("hashes the request deterministically and records the hash on the request event", async () => {
    const ledger = new Ledger("paperModel");
    const f = fake({ interpret: response({ action: "wait", root: "NQ" }) });
    const result = await onModelDecisionBar(ledger, input(f));
    const request = result.request!;
    const hash = hashRequest(request);
    expect(hash).toBe(hashRequest(request));
    expect(hash).toMatch(/^h[0-9a-f]{8}-\d+$/);
    const event = ledger.events.find((e) => e.type === "INTERPRETER_REQUEST");
    expect(event?.type === "INTERPRETER_REQUEST" && event.requestHash).toBe(hash);
    expect(event?.type === "INTERPRETER_REQUEST" && event.nBars).toBe(HISTORY_BARS);
    // a different bar hashes differently
    expect(hashRequest({ ...request, barEnd: "2026-02-02T21:00:00Z" })).not.toBe(hash);
  });
});

describe("observation bars", () => {
  async function opened(answers: Parameters<typeof fake>[0] = {}): Promise<{ ledger: Ledger; f: Fake }> {
    const ledger = new Ledger("paperModel");
    const f = fake({ interpret: response({ action: "enter", root: "NQ", side: 1, stopTicks: 87790 }), ...answers });
    await onModelDecisionBar(ledger, input(f));
    // fill at the next bar's open; the rules engine owns the fill and the stop test
    await onModelBar(ledger, bar(5, "22000", "22050", "21980", "22040"), TRAIL, input(f));
    return { ledger, f };
  }

  it("fills through the rules engine, then asks the interpreter and applies a tighten as a resting stop", async () => {
    const ledger = new Ledger("paperModel");
    const entryFake = fake({ interpret: response({ action: "enter", root: "NQ", side: 1, stopTicks: 87790 }) });
    await onModelDecisionBar(ledger, input(entryFake));
    const tightenFake = fake({ interpret: response({ action: "tighten", root: "NQ", side: 1, stopTicks: 87995 }) });
    const out = await onModelBar(ledger, bar(5, "22000", "22050", "21980", "22040"), TRAIL, input(tightenFake));
    const c = ledger.activeCampaign!;
    expect(c.state).toBe("OPEN");
    expect(out.rules).not.toBeNull();
    expect(out.applied).toBe("tighten");
    expect(c.restingStop?.stop).toBe(87995);
    expect(c.restingStop?.source).toBe("trail");
    expect(c.restingStop?.effectiveAfter).toBe("2026-01-05T21:05:00Z");
    expect(tightenFake.calls[0]!.request.callKind).toBe("observation");
    expect(tightenFake.calls[0]!.effort).toBe("high");
    expect(ledger.events.filter((e) => e.type === "STOP_SET").length).toBeGreaterThanOrEqual(2);
  });

  it("refuses a tighten that would loosen the ratchet, even if it reached the engine", async () => {
    const { ledger } = await opened();
    const current = ledger.activeCampaign!.restingStop!.stop;
    const loosen = fake({ interpret: response({ action: "tighten", root: "NQ", side: 1, stopTicks: current - 50 }) });
    const out = await onModelBar(ledger, bar(6, "22040", "22100", "22020", "22090"), TRAIL, input(loosen));
    expect(out.applied).toBeNull();
    expect(out.reasons.some((r) => r.includes("ratchet direction"))).toBe(true);
    expect(ledger.activeCampaign!.restingStop!.stop).toBeGreaterThanOrEqual(current);
  });

  it("turns an exit proposal into a close request, never a fill", async () => {
    const { ledger } = await opened();
    const exit = fake({ interpret: response({ action: "exit", root: "NQ", side: 1 }) });
    const out = await onModelBar(ledger, bar(6, "22040", "22100", "22020", "22090"), TRAIL, input(exit));
    expect(out.applied).toBe("exit");
    const c = ledger.activeCampaign!;
    expect(c.state).toBe("OPEN");
    expect(c.closeRequested?.reason).toMatch(/^model exit proposal/);
    expect(ledger.events.some((e) => e.type === "EXIT_FILL")).toBe(false);
  });

  it("applies nothing for a hold and makes no second call on a repeated bar", async () => {
    const { ledger } = await opened();
    const hold = fake({ interpret: response({ action: "hold", root: "NQ", side: 1 }) });
    const b = bar(6, "22040", "22100", "22020", "22090");
    const first = await onModelBar(ledger, b, TRAIL, input(hold));
    expect(first.applied).toBeNull();
    expect(hold.calls).toHaveLength(1);
    const count = ledger.events.length;
    const second = await onModelBar(ledger, b, TRAIL, input(hold));
    expect(hold.calls).toHaveLength(1);
    expect(second.reasons.some((r) => r.includes("already has a stored response"))).toBe(true);
    expect(ledger.events).toHaveLength(count);
  });

  it("asks for a lesson when the campaign closes, and a digest once the window is exceeded", async () => {
    const { ledger, f } = await opened();
    const stopped = await onModelBar(ledger, bar(6, "22030", "22060", "21900", "21950"), TRAIL, input(f));
    const closed = ledger.campaigns[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(stopped.lesson).not.toBeNull();
    expect(stopped.lesson?.campaignId).toBe(closed.id);
    expect(ledger.state.interpreter.lessons.map((l) => l.campaignId)).toEqual([closed.id]);
    const lessonCall = f.calls.find((c) => c.kind === "lesson")!;
    expect(lessonCall.request.callKind).toBe("lesson");
    expect(lessonCall.request.campaignSummary?.campaignId).toBe(closed.id);
    expect(lessonCall.request.campaignSummary?.realizedRText).toMatch(/R$/);
    // no digest while the window is not exceeded
    expect(stopped.digest).toBeNull();
    expect(f.calls.filter((c) => c.kind === "digest")).toHaveLength(0);

    // a lesson for the same campaign is not requested twice
    const again = await onModelBar(ledger, bar(7, "21950", "21960", "21900", "21910"), TRAIL, input(f));
    expect(again.lesson).toBeNull();
  });

  it("requests a digest at N+1 lessons", async () => {
    const { ledger, f } = await opened({ digest: { ...DIGEST, lessonsCovered: 1 } });
    // fill the memory window so the closing campaign's lesson tips it over
    for (let i = 1; i <= modelConfig.interpreter.lessonsN; i++) {
      ledger.append({
        id: `filler-${i}`,
        type: "INTERPRETER_LESSON",
        timestamp: DECISION_BAR,
        actual: false,
        campaignId: `old-${i}`,
        epochId: ledger.state.interpreter.memoryEpochId,
        model: modelConfig.interpreter.model,
        promptVersion: modelConfig.interpreter.promptVersion,
        lesson: { campaignId: `old-${i}`, whatHeld: [], whatFailed: [], weighDifferently: [], evidenceToWatch: [] },
      });
    }
    expect(ledger.state.interpreter.lessons).toHaveLength(modelConfig.interpreter.lessonsN);
    const out = await onModelBar(ledger, bar(6, "22030", "22060", "21900", "21950"), TRAIL, input(f));
    expect(out.lesson).not.toBeNull();
    expect(out.digest).toEqual({ ...DIGEST, lessonsCovered: 1 });
    expect(ledger.state.interpreter.digest?.digest.version).toBe(1);
    const digestCall = f.calls.find((c) => c.kind === "digest")!;
    expect(digestCall.request.lessonsToCompact).toHaveLength(1);
    expect(digestCall.request.lessonsToCompact![0]!.campaignId).toBe("old-1");
  });

  it("survives a save and reload with the response id and memory intact", async () => {
    const { ledger } = await opened();
    const storage = new MemoryStorage();
    saveLedger(storage, ledger);
    const back = loadLedger(storage, "paperModel");
    expect(back.ok).toBe(true);
    if (!back.ok) throw new Error(back.reason);
    expect(back.ledger.activeCampaign?.interpreterResponseId).toBe(ledger.activeCampaign?.interpreterResponseId);
    expect(back.ledger.state.interpreter.usage.calls).toBe(ledger.state.interpreter.usage.calls);
    expect(back.ledger.state).toEqual(ledger.state);
  });
});

describe("manual Ask model", () => {
  it("records the request and response in the manual ledger and executes nothing", async () => {
    const ledger = new Ledger("manual");
    const f = fake({ interpret: response({ action: "enter", root: "NQ", side: 1, stopTicks: 87900 }) });
    const result = await askModel(ledger, input(f));
    expect(result.kind).toBe("advisory");
    expect(result.clamped).toMatchObject({ action: "enter", root: "NQ", stopTicks: 87900 });
    expect(ledger.events.map((e) => e.type)).toEqual(["INTERPRETER_REQUEST", "INTERPRETER_RESPONSE"]);
    expect(ledger.campaigns).toEqual([]);
    expect(ledger.state.activeCampaignId).toBeNull();
    expect(ledger.events.some((e) => e.type === "INTERPRETER_CLAMPED")).toBe(false);
    expect(ledger.state.interpreter.usage.calls).toBe(1);
  });

  it("re-uses the stored response for the same bar instead of calling again", async () => {
    const ledger = new Ledger("manual");
    const f = fake({ interpret: response({ action: "enter", root: "NQ", side: 1, stopTicks: 87900 }) });
    await askModel(ledger, input(f));
    const again = await askModel(ledger, input(f));
    expect(again.kind).toBe("already-answered");
    expect(again.clamped).toMatchObject({ action: "enter" });
    expect(f.calls).toHaveLength(1);
  });

  it("records a rejection in the manual ledger without a proposal", async () => {
    const ledger = new Ledger("manual");
    const f = fake({ fail: { ok: false, reason: "refusal", status: 422, category: "general_harms" } });
    const result = await askModel(ledger, input(f));
    expect(result.kind).toBe("rejected");
    expect(result.response).toBeNull();
    expect(ledger.events.map((e) => e.type)).toEqual(["INTERPRETER_REQUEST", "INTERPRETER_REJECTED"]);
    const rejection = ledger.events.find((e) => e.type === "INTERPRETER_REJECTED");
    expect(rejection?.type === "INTERPRETER_REJECTED" && rejection.reason).toBe("refusal (general_harms)");
  });
});
