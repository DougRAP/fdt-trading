/**
 * Risk-engine clamps for interpreter proposals (INTERPRETER_ADDENDUM.md "Risk engine clamps",
 * Decisions 1-2).
 *
 * The interpreter proposes; this module decides what, if anything, may execute. It never widens a
 * limit: discretion (Decision 2) changes which markets may be proposed, not the stop bounds, the
 * one-position rule or the data-validity gates. Everything the model asked for that could not be
 * honoured is reported in `reasons` and logged as INTERPRETER_CLAMPED with before and after.
 *
 * Sizing is not done here: the engine sizes from the clamped stop.
 */
import type { InterpreterClampedEvent, LedgerEvent, Mode, ProposalRecord } from "../campaign/types";
import { modelConfig, type InstrumentRoot, type ModelConfig } from "../config/modelConfig";
import type { Side } from "../formula/types";
import { ticks, type Ticks } from "../numerics/ticks";
import {
  interpreterEventId,
  type ClampedProposal,
  type InterpreterRequest,
  type InterpreterResponse,
  type MarketRequestView,
} from "./types";

export interface ClampInput {
  response: InterpreterResponse;
  request: InterpreterRequest;
  cfg?: ModelConfig;
  /** Id of the stored response this proposal came from; recorded on the clamp event. */
  responseId?: string | null;
  /** Reference price for an entry; defaults to the proposed market's latest completed close. */
  entryReferenceTicks?: Ticks;
  /** Event timestamp; defaults to the request's bar end. */
  at?: string;
  /** Model id for the event id; defaults to the frozen config's interpreter model. */
  model?: string;
}

export interface ClampResult {
  /** Non-null only when the risk engine cleared the proposal for execution. */
  executable: ClampedProposal | null;
  /** INTERPRETER_CLAMPED when something was changed or blocked; empty when nothing was clamped. */
  events: LedgerEvent[];
  reasons: string[];
}

function latestBar(request: InterpreterRequest, root: InstrumentRoot): MarketRequestView["bars"][number] | null {
  const market = request.markets.find((m) => m.root === root);
  if (!market || market.bars.length === 0) return null;
  return market.bars[market.bars.length - 1]!;
}

function proposalRecord(response: InterpreterResponse): ProposalRecord {
  const p = response.proposal;
  return { action: p.action, root: p.root, side: p.side, stopTicks: p.stopTicks, entryZone: p.entryZone };
}

/**
 * Clamp a long stop into [reference - maxD, reference - minTicks] and a short stop into
 * [reference + minTicks, reference + maxD]. The wide bound rounds toward the reference so the
 * distance never exceeds maxD.
 */
export function clampStop(referenceTicks: number, proposedTicks: number, maxDTicks: number, minTicks: number, side: Side): { stop: number; lo: number; hi: number } | null {
  const lo = side === 1 ? Math.ceil(referenceTicks - maxDTicks) : referenceTicks + minTicks;
  const hi = side === 1 ? referenceTicks - minTicks : Math.floor(referenceTicks + maxDTicks);
  if (lo > hi || hi <= 0 || lo <= 0) return null;
  return { stop: Math.min(Math.max(proposedTicks, lo), hi), lo, hi };
}

/**
 * Apply every clamp to one proposal. Returns the executable form (or null) plus the reasons and the
 * audit event. Pure: no ledger writes, no clock, no network.
 */
export function clampProposal(input: ClampInput): ClampResult {
  const { response, request } = input;
  const cfg = input.cfg ?? modelConfig;
  const proposal = response.proposal;
  const reasons: string[] = [];
  const model = input.model ?? cfg.interpreter.model;
  const at = input.at ?? request.barEnd;

  const done = (executable: ClampedProposal | null, clamped: boolean): ClampResult => {
    const events: LedgerEvent[] = [];
    if (clamped) {
      const event: InterpreterClampedEvent = {
        id: interpreterEventId({
          mode: request.mode,
          barEnd: request.barEnd,
          callKind: request.callKind,
          model,
          promptVersion: request.promptVersion,
          suffix: "clamped",
        }),
        type: "INTERPRETER_CLAMPED",
        timestamp: at,
        actual: false,
        responseId: input.responseId ?? null,
        barEnd: request.barEnd,
        callKind: request.callKind,
        before: proposalRecord(response),
        after: executable,
        reasons: [...reasons],
      };
      events.push(event);
    }
    return { executable, events, reasons };
  };

  // Nothing to execute; no clamp event, because nothing was changed or blocked.
  if (proposal.action === "wait" || proposal.action === "hold") {
    reasons.push(`no executable action: ${proposal.action}`);
    return done(null, false);
  }

  const position = request.position;

  if (proposal.action === "enter") {
    if (request.callKind !== "decision") {
      reasons.push(
        request.callKind === "observation"
          ? "entries are never proposed from an observation call"
          : `entries are never proposed from a ${request.callKind} call`,
      );
      return done(null, true);
    }
    if (!request.bounds.entriesPermitted) {
      reasons.push(request.bounds.reason);
      return done(null, true);
    }
    const root = proposal.root;
    const side = proposal.side;
    if (root === null || side === null || proposal.stopTicks === null) {
      reasons.push("enter proposal is missing a root, side or stop");
      return done(null, true);
    }
    if (!request.bounds.allowedCandidates.includes(root)) {
      reasons.push(`${root} is not in the allowed candidate set (${request.bounds.allowedCandidates.join(", ") || "empty"})`);
      return done(null, true);
    }
    const bar = latestBar(request, root);
    if (!bar) {
      reasons.push(`${root} has no bar in the request`);
      return done(null, true);
    }
    if (bar.status === "UNAVAILABLE") {
      reasons.push(`${root} snapshot is unavailable: ${bar.unavailableReasons.map((r) => r.code).join(", ") || "no reason given"}`);
      return done(null, true);
    }
    const reference = input.entryReferenceTicks ?? bar.prices.closeTicks;
    if (reference === null) {
      reasons.push(`${root} has no completed close to price the stop against`);
      return done(null, true);
    }
    const maxD = request.bounds.maxDTicks[root]?.[side === 1 ? "long" : "short"] ?? null;
    if (maxD === null) {
      reasons.push(`${root} has no stop distance for this side; ATR or breadth is unavailable`);
      return done(null, true);
    }
    const bounded = clampStop(reference, proposal.stopTicks, maxD, request.bounds.minTicks, side);
    if (!bounded) {
      reasons.push(`${root} stop bounds are empty: max distance ${maxD} ticks is below the ${request.bounds.minTicks} tick minimum`);
      return done(null, true);
    }
    const changed = bounded.stop !== proposal.stopTicks;
    if (changed) {
      reasons.push(
        `stop ${proposal.stopTicks} clamped to ${bounded.stop} ticks, inside [${bounded.lo}, ${bounded.hi}] around reference ${reference} (max distance ${maxD}, min ${request.bounds.minTicks})`,
      );
    }
    const executable: ClampedProposal = {
      action: "enter",
      root,
      side,
      entryReferenceTicks: ticks(reference),
      stopTicks: ticks(bounded.stop),
      originalStopTicks: proposal.stopTicks,
      reasons: [...reasons],
    };
    return done(executable, changed);
  }

  // tighten and exit act on an open position only.
  if (!position.hasPosition || position.root === null) {
    reasons.push(`${proposal.action} proposed with no open position`);
    return done(null, true);
  }
  if (proposal.root !== position.root) {
    reasons.push(`${proposal.action} names ${proposal.root ?? "no market"} but the open position is ${position.root}`);
    return done(null, true);
  }
  const bar = latestBar(request, position.root);
  if (!bar || bar.status === "UNAVAILABLE") {
    reasons.push(`${position.root} snapshot is unavailable; the proposal is logged, not executed`);
    return done(null, true);
  }

  if (proposal.action === "exit") {
    // An exit is a close request, never a fill: the engine exits at the next executable observation.
    // Pausing stops new entries; it never blocks closing an open position.
    return done({ action: "exit", root: position.root }, false);
  }

  // tighten: a stop change is a new instruction, so the pause gate applies to it.
  if (request.bounds.paused) {
    reasons.push("the engine is paused; the stop change is logged, not applied (existing protective stops keep running)");
    return done(null, true);
  }
  const current = position.proposedStopTicks ?? position.recordedStopTicks;
  if (current === null) {
    reasons.push("tighten proposed with no current stop to move");
    return done(null, true);
  }
  if (proposal.stopTicks === null) {
    reasons.push("tighten proposal is missing a stop");
    return done(null, true);
  }
  const side: Side = position.side ?? 1;
  const ratchets = side === 1 ? proposal.stopTicks > current : proposal.stopTicks < current;
  if (!ratchets) {
    reasons.push(
      `tighten must move the stop in the ratchet direction: ${side === 1 ? "above" : "below"} the current ${current} ticks, got ${proposal.stopTicks}`,
    );
    return done(null, true);
  }
  return done({ action: "tighten", root: position.root, stopTicks: ticks(proposal.stopTicks) }, false);
}

/** Convenience for callers that only need the mode-typed event id prefix. */
export function clampEventId(request: InterpreterRequest, model: string, mode: Mode = request.mode as Mode): string {
  return interpreterEventId({ mode, barEnd: request.barEnd, callKind: request.callKind, model, promptVersion: request.promptVersion, suffix: "clamped" });
}
