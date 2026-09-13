/**
 * Model-assisted paper engine (D22, addendum Decisions 1-2 and "Feedback loop").
 *
 * It wraps the rules engine; it never replaces it. Stops are always tested by code first, sizing is
 * always computed by code from the clamped stop, and the risk engine clamps every proposal. The
 * interpreter is injected, so tests run with a fake and no network exists in this module.
 *
 * Nothing here runs on a timer: every entry point is called from an explicit user action (D22).
 * A repeated bar is a no-op and makes no second call: the ledger is checked for a stored response for
 * that bar and call kind first, and every event id is derived from the bar, model and prompt version.
 */
import { freezeModelConfig, modelConfig, type ModelConfig } from "../config/modelConfig";
import type {
  Campaign,
  CampaignQueuedEvent,
  CloseRequestedEvent,
  InterpreterDigestEvent,
  InterpreterLessonEvent,
  InterpreterRejectedEvent,
  InterpreterRequestEvent,
  InterpreterResponseEvent,
  LedgerEvent,
  Mode,
  StopSetEvent,
} from "../campaign/types";
import type { SignalSnapshot } from "../formula/types";
import { INSTRUMENTS } from "../instruments/metadata";
import type { Ledger } from "../ledger/ledger";
import { mils, type Mils } from "../numerics/money";
import { ticks, type Ticks } from "../numerics/ticks";
import { buildRequest } from "../interpreter/buildRequest";
import { clampProposal } from "../interpreter/clamp";
import type { InterpreterCallBody, InterpreterCallResult } from "../interpreter/client";
import { outcomesForLastK, type SnapshotsByBar } from "../interpreter/feedback";
import { buildDigestRequest, buildLessonRequest, digestNeeded, lessonsForRequest, lessonsToCompact } from "../interpreter/memory";
import { validateDigest, validateLesson, validateResponse } from "../interpreter/schema";
import {
  estimateCostMils,
  interpreterEventId,
  type CallKind,
  type ClampedProposal,
  type Digest,
  type InterpreterRequest,
  type InterpreterResponse,
  type InterpreterUsage,
  type Lesson,
} from "../interpreter/types";
import { modeledEntryFill, modeledStopExitFill, perContractRisk, positionSize } from "../sizing/sizing";
import { initialStop, stopDistance, type StopDistance, type StopState } from "../stops/stops";
import { onExecutableBar, onObservationBar, type EngineBar, type ObservationOutcome, type TrailInputs } from "./engine";

/** The injected interpreter: the browser client in the app, a fake in tests. */
export type InterpreterCall = (body: InterpreterCallBody) => Promise<InterpreterCallResult>;

export interface ModelEngineInput {
  interpreter: InterpreterCall;
  /** Oldest-first snapshots per root (D21 fixture history, or a replay later). */
  histories: Partial<Record<string, readonly SignalSnapshot[]>>;
  /** The same bars keyed by bar end, for the feedback loop. */
  snapshotsByBar: SnapshotsByBar;
  cfg?: ModelConfig;
}

export type DecisionResultKind =
  | "queued"
  | "not-executable"
  | "no-proposal"
  | "rejected"
  | "call-failed"
  | "already-answered"
  | "position-active"
  | "paused"
  /** Manual mode: recorded and shown, never executed. */
  | "advisory";

export interface ModelDecisionResult {
  kind: DecisionResultKind;
  events: LedgerEvent[];
  request: InterpreterRequest | null;
  response: InterpreterResponse | null;
  clamped: ClampedProposal | null;
  reasons: string[];
  campaignId: string | null;
  /** Set when a call happened. */
  usage: InterpreterUsage | null;
  costEstimateMils: Mils | null;
}

export interface ModelBarResult {
  /** What the rules engine did first; null when there was nothing to observe. */
  rules: ObservationOutcome | null;
  events: LedgerEvent[];
  response: InterpreterResponse | null;
  clamped: ClampedProposal | null;
  reasons: string[];
  applied: "tighten" | "exit" | null;
  lesson: Lesson | null;
  digest: Digest | null;
}

/** Deterministic, dependency-free hash of the request body for the audit trail. */
export function hashRequest(request: InterpreterRequest): string {
  const text = JSON.stringify(request);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `h${h.toString(16).padStart(8, "0")}-${text.length}`;
}

function idFor(mode: Mode, request: InterpreterRequest, model: string, suffix: string): string {
  return interpreterEventId({ mode, barEnd: request.barEnd, callKind: request.callKind, model, promptVersion: request.promptVersion, suffix });
}

/** True when this bar and call kind already have a stored response: no second network call. */
export function alreadyAnswered(ledger: Ledger, callKind: CallKind, barEnd: string): boolean {
  return ledger.state.interpreter.latestResponseByBar[`${callKind}:${barEnd}`] !== undefined;
}

function usageOf(result: Extract<InterpreterCallResult, { ok: true }>): InterpreterUsage {
  const u = result.usage;
  return { inputTokens: u.inputTokens, cachedInputTokens: u.cachedInputTokens, outputTokens: u.outputTokens };
}

function costOf(result: Extract<InterpreterCallResult, { ok: true }>, model: string): Mils {
  const reported = result.costEstimateMils;
  const value = Number.isSafeInteger(reported) && reported >= 0 ? reported : estimateCostMils(usageOf(result), model);
  return mils(value);
}

interface Appender {
  push: (e: LedgerEvent) => boolean;
  events: LedgerEvent[];
}

function appender(ledger: Ledger): Appender {
  const events: LedgerEvent[] = [];
  return {
    events,
    push(e) {
      const r = ledger.append(e);
      if (r.applied) events.push(e);
      return r.applied;
    },
  };
}

function requestEvent(mode: Mode, request: InterpreterRequest, model: string, nBars: number): InterpreterRequestEvent {
  return {
    id: idFor(mode, request, model, "request"),
    type: "INTERPRETER_REQUEST",
    timestamp: request.barEnd,
    actual: false,
    mode,
    callKind: request.callKind,
    barEnd: request.barEnd,
    requestHash: hashRequest(request),
    promptVersion: request.promptVersion,
    model,
    nBars,
  };
}

function rejectedEvent(mode: Mode, request: InterpreterRequest, model: string, reason: string, suffix = "rejected"): InterpreterRejectedEvent {
  return {
    id: idFor(mode, request, model, suffix),
    type: "INTERPRETER_REJECTED",
    timestamp: request.barEnd,
    actual: false,
    barEnd: request.barEnd,
    callKind: request.callKind,
    model,
    promptVersion: request.promptVersion,
    reason,
  };
}

function responseEvent(
  mode: Mode,
  request: InterpreterRequest,
  model: string,
  response: InterpreterResponse,
  usage: InterpreterUsage,
  latencyMs: number,
  costEstimateMils: Mils,
): InterpreterResponseEvent {
  const id = idFor(mode, request, model, "response");
  return {
    id,
    type: "INTERPRETER_RESPONSE",
    timestamp: request.barEnd,
    actual: false,
    // The event id doubles as the response id, so a campaign entered on it is traceable and idempotent.
    responseId: id,
    barEnd: request.barEnd,
    callKind: request.callKind,
    model,
    promptVersion: request.promptVersion,
    response,
    usage,
    latencyMs,
    costEstimateMils,
  };
}

/** Build the request for one call kind, with the feedback loop and memory attached. */
export function buildModelRequest(ledger: Ledger, input: ModelEngineInput, callKind: CallKind, barEnd?: string): InterpreterRequest {
  const cfg = input.cfg ?? modelConfig;
  const interp = cfg.interpreter;
  return buildRequest({
    callKind,
    mode: ledger.mode,
    histories: input.histories as Partial<Record<never, readonly SignalSnapshot[]>>,
    ledger: ledger.state,
    cfg,
    interpreter: interp,
    barEnd,
    feedback: outcomesForLastK(ledger, input.snapshotsByBar, interp.feedbackK),
    lessons: lessonsForRequest(ledger, interp.lessonsN),
    digest: ledger.state.interpreter.digest?.digest ?? null,
    memoryEpochId: ledger.state.interpreter.memoryEpochId,
  });
}

interface CallOutcome {
  ok: boolean;
  response: InterpreterResponse | null;
  usage: InterpreterUsage | null;
  cost: Mils | null;
  reason: string | null;
  /** True when the failure was the model's output, not the transport. */
  outputProblem: boolean;
}

/**
 * Send one interpret call and validate the answer again on this side. The function already validated
 * it; re-running the validator here is defence in depth, and a failure is logged, never used.
 */
async function callInterpret(
  ledger: Ledger,
  input: ModelEngineInput,
  request: InterpreterRequest,
  model: string,
  effort: ModelConfig["interpreter"]["effortDecision"],
  out: Appender,
): Promise<CallOutcome> {
  const mode = ledger.mode;
  let result: InterpreterCallResult;
  try {
    result = await input.interpreter({ kind: "interpret", request, model, effort });
  } catch (err) {
    const reason = `interpreter call threw: ${err instanceof Error ? err.message : String(err)}`;
    out.push(rejectedEvent(mode, request, model, reason));
    return { ok: false, response: null, usage: null, cost: null, reason, outputProblem: false };
  }
  if (!result.ok) {
    const reason = `${result.reason}${result.category ? ` (${result.category})` : ""}`;
    out.push(rejectedEvent(mode, request, model, reason));
    return { ok: false, response: null, usage: null, cost: null, reason, outputProblem: result.status === 422 };
  }
  const validated = validateResponse(result.response, request);
  if (!validated.ok) {
    out.push(rejectedEvent(mode, request, model, validated.reason));
    return { ok: false, response: null, usage: usageOf(result), cost: costOf(result, model), reason: validated.reason, outputProblem: true };
  }
  const usage = usageOf(result);
  const cost = costOf(result, model);
  out.push(responseEvent(mode, request, model, validated.value, usage, result.latencyMs, cost));
  return { ok: true, response: validated.value, usage, cost, reason: null, outputProblem: false };
}

/**
 * A decision bar in the model-assisted ledger: ask the interpreter, clamp what it proposes, and queue
 * the clamped entry with a size computed from the clamped stop. Never fills.
 */
export async function onModelDecisionBar(ledger: Ledger, input: ModelEngineInput): Promise<ModelDecisionResult> {
  const cfg = input.cfg ?? modelConfig;
  const model = cfg.interpreter.model;
  const state = ledger.state;
  const empty = (kind: DecisionResultKind, reasons: string[] = []): ModelDecisionResult => ({
    kind,
    events: [],
    request: null,
    response: null,
    clamped: null,
    reasons,
    campaignId: null,
    usage: null,
    costEstimateMils: null,
  });
  if (state.paused) return empty("paused", ["the engine is paused; no decision call was made"]);
  if (state.activeCampaignId !== null) return empty("position-active", [`campaign ${state.activeCampaignId} is already active`]);

  const request = buildModelRequest(ledger, input, "decision");
  if (alreadyAnswered(ledger, "decision", request.barEnd)) {
    return { ...empty("already-answered", [`decision bar ${request.barEnd} already has a stored response`]), request };
  }

  const out = appender(ledger);
  out.push(requestEvent(ledger.mode, request, model, request.nBars));
  const call = await callInterpret(ledger, input, request, model, cfg.interpreter.effortDecision, out);
  if (!call.ok || !call.response) {
    return {
      kind: call.outputProblem ? "rejected" : "call-failed",
      events: out.events,
      request,
      response: null,
      clamped: null,
      reasons: call.reason ? [call.reason] : [],
      campaignId: null,
      usage: call.usage,
      costEstimateMils: call.cost,
    };
  }
  const responseId = idFor(ledger.mode, request, model, "response");
  const clamp = clampProposal({ response: call.response, request, cfg, responseId, model });
  for (const e of clamp.events) out.push(e);

  const base = {
    events: out.events,
    request,
    response: call.response,
    clamped: clamp.executable,
    reasons: clamp.reasons,
    usage: call.usage,
    costEstimateMils: call.cost,
  };
  if (!clamp.executable) {
    const kind: DecisionResultKind = call.response.proposal.action === "wait" || call.response.proposal.action === "hold" ? "no-proposal" : "not-executable";
    return { ...base, kind, campaignId: null };
  }
  if (clamp.executable.action !== "enter") {
    // hold/tighten/exit from a decision bar with no position: the clamp already refused those.
    return { ...base, kind: "not-executable", campaignId: null, reasons: [...clamp.reasons, `${clamp.executable.action} needs an open position`] };
  }

  const queued = queueFromProposal(ledger, input, request, clamp.executable, responseId, cfg);
  if (!queued.ok) {
    out.push(rejectedEventForSizing(ledger.mode, request, model, queued.reason, clamp.executable));
    return { ...base, kind: "not-executable", campaignId: null, reasons: [...clamp.reasons, queued.reason] };
  }
  out.push(queued.event);
  return { ...base, kind: "queued", campaignId: queued.event.campaignId };
}

function rejectedEventForSizing(mode: Mode, request: InterpreterRequest, model: string, reason: string, executable: ClampedProposal): LedgerEvent {
  return {
    id: idFor(mode, request, model, "clamped:sizing"),
    type: "INTERPRETER_CLAMPED",
    timestamp: request.barEnd,
    actual: false,
    responseId: idFor(mode, request, model, "response"),
    barEnd: request.barEnd,
    callKind: request.callKind,
    before: {
      action: executable.action,
      root: executable.root,
      side: executable.action === "enter" ? executable.side : null,
      stopTicks: executable.action === "enter" || executable.action === "tighten" ? executable.stopTicks : null,
      entryZone: null,
    },
    after: null,
    reasons: [reason],
  };
}

/**
 * Turn a cleared entry proposal into a queued campaign. The model's clamped distance is carried as the
 * campaign's decision distance, so when the rules engine fills at the next bar's open it prices the
 * stop that distance away from the actual fill instead of discarding the model's stop.
 */
function queueFromProposal(
  ledger: Ledger,
  input: ModelEngineInput,
  request: InterpreterRequest,
  executable: Extract<ClampedProposal, { action: "enter" }>,
  responseId: string,
  cfg: ModelConfig,
): { ok: true; event: CampaignQueuedEvent } | { ok: false; reason: string } {
  const root = executable.root;
  const inst = INSTRUMENTS[root];
  const cost = cfg.costs[root];
  const history = input.histories[root] ?? [];
  const snapshot = history.length > 0 ? history[history.length - 1]! : null;
  if (!snapshot) return { ok: false, reason: `${root} has no snapshot to freeze with the campaign` };

  const distanceTicks = Math.abs(executable.entryReferenceTicks - executable.stopTicks);
  if (distanceTicks <= 0) return { ok: false, reason: "clamped stop distance is zero" };
  const rulesDistance = stopDistance(snapshot.raw.atr20Ticks, snapshot.H, executable.side, cfg);
  if (!rulesDistance.ok) return { ok: false, reason: `no stop distance available: ${rulesDistance.reason.detail}` };
  // Same record shape as the rules engine's D, with the model's clamped distance in place of ATR x coefficient.
  const decisionDistance: StopDistance = {
    dTicks: distanceTicks,
    coefficient: rulesDistance.value.atrTicks > 0 ? distanceTicks / rulesDistance.value.atrTicks : rulesDistance.value.coefficient,
    atrTicks: rulesDistance.value.atrTicks,
    H: rulesDistance.value.H,
    side: executable.side,
  };

  const plannedEntry = modeledEntryFill(executable.entryReferenceTicks, executable.side, cost);
  const plannedStop = initialStop({ side: executable.side, entryFill: plannedEntry, distance: decisionDistance, calculatedAt: snapshot.availableAt }).stop;
  const exitFill = modeledStopExitFill(plannedStop, executable.side, cost).fill;
  const risk = perContractRisk({ entryFill: plannedEntry, stopExitFill: exitFill, tickValueMils: inst.tickValueMils, cost });
  const sizing = positionSize({ equityMils: ledger.equityMils, perContractRiskMils: risk.totalMils, cfg });
  if (sizing.skip) return { ok: false, reason: sizing.skipReason ?? "position size is zero" };

  const campaignId = `${ledger.mode}:${root}:${request.barEnd}`;
  if (ledger.state.campaigns[campaignId]) return { ok: false, reason: `decision bar ${request.barEnd} already used for ${root}` };
  return {
    ok: true,
    event: {
      id: `${campaignId}:queued`,
      type: "CAMPAIGN_QUEUED",
      timestamp: snapshot.availableAt,
      actual: false,
      campaignId,
      mode: ledger.mode,
      root,
      contract: inst.contract,
      side: executable.side,
      plan: { contracts: sizing.contracts, plannedEntry, plannedStop, riskBudgetMils: sizing.budgetMils, perContractRisk: risk, sizing },
      frozenConfig: freezeModelConfig(cfg),
      frozenSnapshot: structuredClone(snapshot),
      decisionDistance,
      interpreterResponseId: responseId,
    },
  };
}

function tightenStopState(campaign: Campaign, bar: EngineBar, trail: TrailInputs | null, stop: Ticks): StopState {
  return {
    side: campaign.side,
    stop,
    // A stop decided from this bar's close only applies to later bars, exactly like the rules ratchet.
    effectiveAfter: bar.availableAt,
    calculatedAt: bar.availableAt,
    source: "trail",
    basis: {
      referenceClose: bar.close,
      dTicks: Math.abs(bar.close - stop),
      atrTicks: trail?.atrTicks ?? null,
      H: trail?.H ?? null,
    },
  };
}

/**
 * One bar in the model-assisted ledger. The rules engine runs first and owns the stop test; only then
 * is the interpreter asked whether to hold, tighten or exit. A closed campaign earns a lesson.
 */
export async function onModelBar(ledger: Ledger, bar: EngineBar, trail: TrailInputs | null, input: ModelEngineInput): Promise<ModelBarResult> {
  const cfg = input.cfg ?? modelConfig;
  const model = cfg.interpreter.model;
  const out = appender(ledger);
  const before = ledger.activeCampaign;

  let rules: ObservationOutcome | null = null;
  if (before?.state === "PENDING") rules = onExecutableBar(ledger, bar, trail, cfg);
  else if (before?.state === "OPEN") rules = onObservationBar(ledger, bar, trail, cfg);
  if (rules) out.events.push(...rules.events);

  const result: ModelBarResult = { rules, events: out.events, response: null, clamped: null, reasons: [], applied: null, lesson: null, digest: null };

  const campaignId = before?.id ?? null;
  const after = campaignId ? (ledger.state.campaigns[campaignId] ?? null) : null;
  if (after && (after.state === "CLOSED" || after.state === "CANCELLED")) {
    const memory = await runMemory(ledger, input, after);
    out.events.push(...memory.events);
    result.lesson = memory.lesson;
    result.digest = memory.digest;
    return result;
  }
  if (!after || after.state !== "OPEN") return result;

  const request = buildModelRequest(ledger, input, "observation", bar.barEnd);
  if (alreadyAnswered(ledger, "observation", request.barEnd)) {
    result.reasons.push(`observation bar ${request.barEnd} already has a stored response`);
    return result;
  }
  out.push(requestEvent(ledger.mode, request, model, request.nBars));
  const call = await callInterpret(ledger, input, request, model, cfg.interpreter.effortObservation, out);
  if (!call.ok || !call.response) {
    if (call.reason) result.reasons.push(call.reason);
    return result;
  }
  result.response = call.response;
  const responseId = idFor(ledger.mode, request, model, "response");
  const clamp = clampProposal({ response: call.response, request, cfg, responseId, model });
  for (const e of clamp.events) out.push(e);
  result.clamped = clamp.executable;
  result.reasons.push(...clamp.reasons);
  if (!clamp.executable) return result;

  if (clamp.executable.action === "tighten") {
    const current = after.restingStop?.stop ?? after.proposedStop?.stop ?? null;
    const proposed = clamp.executable.stopTicks;
    // The clamp guarantees the ratchet direction; assert it again before writing a stop.
    const ratchets = current === null || (after.side === 1 ? proposed > current : proposed < current);
    if (!ratchets) {
      result.reasons.push(`refused to write a stop that would loosen the ratchet: current ${current}, proposed ${proposed}`);
      return result;
    }
    const event: StopSetEvent = {
      id: idFor(ledger.mode, request, model, "stop"),
      type: "STOP_SET",
      timestamp: bar.availableAt,
      actual: false,
      campaignId: after.id,
      kind: "resting",
      stop: tightenStopState(after, bar, trail, ticks(proposed)),
    };
    if (out.push(event)) result.applied = "tighten";
    return result;
  }

  if (clamp.executable.action === "exit") {
    const event: CloseRequestedEvent = {
      id: idFor(ledger.mode, request, model, "close"),
      type: "CLOSE_REQUESTED",
      timestamp: bar.availableAt,
      actual: false,
      campaignId: after.id,
      reason: `model exit proposal (${responseId}): ${call.response.proposal.rationale}`,
    };
    if (out.push(event)) result.applied = "exit";
  }
  return result;
}

interface MemoryOutcome {
  events: LedgerEvent[];
  lesson: Lesson | null;
  digest: Digest | null;
}

/**
 * After a campaign closes: ask for a lesson, and compact older lessons into a digest when the window
 * is exceeded. Both are memory only; neither can change a threshold, a size or a stop bound.
 */
export async function runMemory(ledger: Ledger, input: ModelEngineInput, campaign: Campaign): Promise<MemoryOutcome> {
  const cfg = input.cfg ?? modelConfig;
  const model = cfg.interpreter.model;
  const out = appender(ledger);
  const epochId = ledger.state.interpreter.memoryEpochId;
  const result: MemoryOutcome = { events: out.events, lesson: null, digest: null };

  const already = ledger.events.some((e) => e.type === "INTERPRETER_LESSON" && e.campaignId === campaign.id && e.epochId === epochId);
  if (!already) {
    const outcome = outcomesForLastK(ledger, input.snapshotsByBar, cfg.interpreter.feedbackK).find(
      (o) => o.responseId === campaign.interpreterResponseId,
    );
    const request = buildLessonRequest(campaign, ledger, { cfg, snapshotsByBar: input.snapshotsByBar, outcome: outcome ?? null });
    out.push(requestEvent(ledger.mode, request, model, request.nBars));
    let call: InterpreterCallResult;
    try {
      call = await input.interpreter({ kind: "lesson", request, model, effort: cfg.interpreter.effortObservation });
    } catch (err) {
      out.push(rejectedEvent(ledger.mode, request, model, `lesson call threw: ${err instanceof Error ? err.message : String(err)}`));
      return result;
    }
    if (!call.ok) {
      out.push(rejectedEvent(ledger.mode, request, model, call.reason));
      return result;
    }
    const validated = validateLesson(call.response, campaign.id);
    if (!validated.ok) {
      out.push(rejectedEvent(ledger.mode, request, model, validated.reason));
      return result;
    }
    const event: InterpreterLessonEvent = {
      id: idFor(ledger.mode, request, model, `lesson:${campaign.id}`),
      type: "INTERPRETER_LESSON",
      timestamp: campaign.closedAt ?? request.barEnd,
      actual: false,
      campaignId: campaign.id,
      epochId,
      model,
      promptVersion: request.promptVersion,
      lesson: validated.value,
    };
    if (out.push(event)) result.lesson = validated.value;
  }

  if (digestNeeded(ledger, cfg.interpreter.lessonsN)) {
    const toCompact = lessonsToCompact(ledger, cfg.interpreter.lessonsN);
    const request = buildDigestRequest(toCompact, ledger, { cfg, at: campaign.closedAt ?? undefined });
    out.push(requestEvent(ledger.mode, request, model, request.nBars));
    let call: InterpreterCallResult;
    try {
      call = await input.interpreter({ kind: "digest", request, model, effort: cfg.interpreter.effortObservation });
    } catch (err) {
      out.push(rejectedEvent(ledger.mode, request, model, `digest call threw: ${err instanceof Error ? err.message : String(err)}`, "rejected:digest"));
      return result;
    }
    if (!call.ok) {
      out.push(rejectedEvent(ledger.mode, request, model, call.reason, "rejected:digest"));
      return result;
    }
    const validated = validateDigest(call.response);
    if (!validated.ok) {
      out.push(rejectedEvent(ledger.mode, request, model, validated.reason, "rejected:digest"));
      return result;
    }
    const event: InterpreterDigestEvent = {
      id: idFor(ledger.mode, request, model, `digest:${validated.value.version}`),
      type: "INTERPRETER_DIGEST",
      timestamp: campaign.closedAt ?? request.barEnd,
      actual: false,
      epochId,
      model,
      promptVersion: request.promptVersion,
      digest: validated.value,
    };
    if (out.push(event)) result.digest = validated.value;
  }
  return result;
}

/**
 * Manual mode "Ask model": records the request, the response or the rejection in the manual ledger and
 * returns the clamped proposal for display. It never executes anything and never writes a clamp event.
 */
export async function askModel(ledger: Ledger, input: ModelEngineInput): Promise<ModelDecisionResult> {
  const cfg = input.cfg ?? modelConfig;
  const model = cfg.interpreter.model;
  const request = buildModelRequest(ledger, input, "decision");
  const out = appender(ledger);
  const base: ModelDecisionResult = {
    kind: "no-proposal",
    events: out.events,
    request,
    response: null,
    clamped: null,
    reasons: [],
    campaignId: null,
    usage: null,
    costEstimateMils: null,
  };
  if (alreadyAnswered(ledger, "decision", request.barEnd)) {
    const stored = ledger.state.interpreter.latestResponseByBar[`decision:${request.barEnd}`]!;
    const clamp = clampProposal({ response: stored.response, request, cfg, responseId: stored.responseId, model });
    return { ...base, kind: "already-answered", response: stored.response, clamped: clamp.executable, reasons: clamp.reasons };
  }
  out.push(requestEvent(ledger.mode, request, model, request.nBars));
  const call = await callInterpret(ledger, input, request, model, cfg.interpreter.effortDecision, out);
  if (!call.ok || !call.response) {
    return { ...base, kind: call.outputProblem ? "rejected" : "call-failed", reasons: call.reason ? [call.reason] : [], usage: call.usage, costEstimateMils: call.cost };
  }
  // The clamp runs for display only: the manual ledger records fills the user made, not proposals.
  const clamp = clampProposal({ response: call.response, request, cfg, responseId: idFor(ledger.mode, request, model, "response"), model });
  return {
    ...base,
    kind: "advisory",
    response: call.response,
    clamped: clamp.executable,
    reasons: clamp.reasons,
    usage: call.usage,
    costEstimateMils: call.cost,
  };
}
