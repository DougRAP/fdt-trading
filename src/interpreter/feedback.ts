/**
 * Outcome feedback (INTERPRETER_ADDENDUM.md "Feedback loop", D17).
 *
 * Every request carries what happened to the model's last K proposals. All of it is computed here
 * from the ledger and the snapshot history: executed or clamped or rejected, the fill, the exit
 * reason, realized R, bars held, and whether each invalidation condition the model named actually
 * appeared before the stop did. The model never reports its own results.
 */
import { realizedR } from "../campaign/pnl";
import type { Campaign, InterpreterClampedEvent, InterpreterRejectedEvent, InterpreterResponseEvent } from "../campaign/types";
import type { InstrumentRoot } from "../config/modelConfig";
import type { Side, SignalSnapshot } from "../formula/types";
import type { Ledger } from "../ledger/ledger";
import { EM_DASH, fmtNum, fmtPrice } from "../ui/format";
import type { Invalidation, InvalidationOutcome, ProposalOutcome } from "./types";

/** Completed snapshots for every root, keyed by bar end. */
export type SnapshotsByBar = Record<string, readonly SignalSnapshot[]>;

function sortedBarEnds(snapshotsByBar: SnapshotsByBar): string[] {
  // ISO timestamps sort lexicographically in chronological order.
  return Object.keys(snapshotsByBar).sort();
}

function snapshotFor(snapshotsByBar: SnapshotsByBar, barEnd: string, root: InstrumentRoot): SignalSnapshot | null {
  return snapshotsByBar[barEnd]?.find((s) => s.root === root) ?? null;
}

const THRESHOLD_KINDS = new Set<Invalidation["kind"]>(["S_below", "H_below", "u_falls_below", "breadth_concentrates"]);

/**
 * D17 evaluation. A condition is met on a later bar when:
 * S_below → displayScore < threshold; H_below → d x H < threshold; u_falls_below → u < threshold;
 * breadth_concentrates → A < threshold; price_reverses → d x (close - proposal bar close) < 0.
 * cross_market is never evaluable, nor is a threshold kind without a threshold.
 * `appearedBeforeStop` is true only when the first bar meeting the condition is strictly before the
 * exit bar; with no exit yet, any occurrence counts (nothing has stopped the campaign).
 */
export function evaluateInvalidation(input: {
  condition: Invalidation;
  proposalBarEnd: string;
  side: Side | null;
  snapshotsByBar: SnapshotsByBar;
  /** Bar end of the exit, or null while the campaign is open or was never entered. */
  exitBarEnd: string | null;
}): InvalidationOutcome {
  const { condition, proposalBarEnd, side, snapshotsByBar, exitBarEnd } = input;
  const notEvaluable = (note: string): InvalidationOutcome => ({ condition, appearedBeforeStop: null, note: `not evaluable: ${note}` });

  if (condition.kind === "cross_market") return notEvaluable("cross_market conditions are read by a person, not by code");
  if (THRESHOLD_KINDS.has(condition.kind) && condition.threshold === null) return notEvaluable("no threshold to compare against");
  if ((condition.kind === "H_below" || condition.kind === "price_reverses") && side === null) {
    return notEvaluable(`${condition.kind} needs the proposal's side`);
  }

  const later = sortedBarEnds(snapshotsByBar).filter((b) => b > proposalBarEnd && (exitBarEnd === null || b <= exitBarEnd));
  if (later.length === 0) return notEvaluable("no bars after the proposal");

  const proposalClose = snapshotFor(snapshotsByBar, proposalBarEnd, condition.root)?.raw.closeT ?? null;
  if (condition.kind === "price_reverses" && proposalClose === null) return notEvaluable(`${condition.root} has no close on the proposal bar`);

  const d = side ?? 1;
  let met: string | null = null;
  let missing = 0;
  for (const barEnd of later) {
    const s = snapshotFor(snapshotsByBar, barEnd, condition.root);
    if (!s) {
      missing++;
      continue;
    }
    const threshold = condition.threshold;
    let hit = false;
    switch (condition.kind) {
      case "S_below":
        hit = s.displayScore !== null && threshold !== null && s.displayScore < threshold;
        break;
      case "H_below":
        hit = s.H !== null && threshold !== null && d * s.H < threshold;
        break;
      case "u_falls_below":
        hit = s.u !== null && threshold !== null && s.u < threshold;
        break;
      case "breadth_concentrates":
        hit = s.A !== null && threshold !== null && s.A < threshold;
        break;
      case "price_reverses":
        hit = s.raw.closeT !== null && proposalClose !== null && d * (s.raw.closeT - proposalClose) < 0;
        break;
    }
    if (hit) {
      met = barEnd;
      break;
    }
  }

  if (met === null) {
    const through = later[later.length - 1]!;
    if (missing === later.length) return notEvaluable(`${condition.root} has no snapshot on any bar after the proposal`);
    return { condition, appearedBeforeStop: false, note: `not met through ${through}` };
  }
  if (exitBarEnd === null) return { condition, appearedBeforeStop: true, note: `first met at ${met}; the campaign has no exit bar yet` };
  const before = met < exitBarEnd;
  return {
    condition,
    appearedBeforeStop: before,
    note: before ? `first met at ${met}, before the exit bar ${exitBarEnd}` : `first met at ${met}, not before the exit bar ${exitBarEnd}`,
  };
}

function firstEntryFill(c: Campaign): ProposalOutcome["fill"] {
  const fill = c.fills.find((f) => f.kind === "entry");
  if (!fill) return null;
  return { priceTicks: fill.price, priceText: fmtPrice(fill.price, c.root), quantity: fill.quantity };
}

function exitReasonOf(c: Campaign): string | null {
  const exits = c.fills.filter((f) => f.kind === "exit");
  const last = exits[exits.length - 1];
  if (last?.reason) return last.reason;
  if (c.cancelReason) return `cancelled: ${c.cancelReason}`;
  if (c.closeRequested) return `close requested: ${c.closeRequested.reason}`;
  return null;
}

/** Bar end the campaign exited on: the last exit fill's time, else null while it is still open. */
function exitBarEndOf(c: Campaign | null): string | null {
  if (!c) return null;
  const exits = c.fills.filter((f) => f.kind === "exit");
  const last = exits[exits.length - 1];
  if (last) return last.filledAt;
  return c.state === "CLOSED" || c.state === "CANCELLED" ? c.closedAt : null;
}

/**
 * The model's last K proposals with their outcomes, oldest first. Rejected responses are included
 * (with a null action) so the model can see that its output was refused and why.
 */
export function outcomesForLastK(ledger: Ledger, snapshotsByBar: SnapshotsByBar, K: number): ProposalOutcome[] {
  const events = ledger.events;
  const clampsByResponse = new Map<string, InterpreterClampedEvent>();
  const campaignsByResponse = new Map<string, Campaign>();
  for (const e of events) {
    if (e.type === "INTERPRETER_CLAMPED" && e.responseId !== null) clampsByResponse.set(e.responseId, e);
  }
  for (const c of ledger.campaigns) {
    if (c.interpreterResponseId) campaignsByResponse.set(c.interpreterResponseId, c);
  }

  const ordered = events.filter(
    (e): e is InterpreterResponseEvent | InterpreterRejectedEvent => e.type === "INTERPRETER_RESPONSE" || e.type === "INTERPRETER_REJECTED",
  );
  const window = K > 0 ? ordered.slice(-K) : [];

  return window.map((e) => {
    if (e.type === "INTERPRETER_REJECTED") {
      return {
        responseId: e.id,
        barEnd: e.barEnd,
        action: null,
        root: null,
        side: null,
        disposition: "rejected" as const,
        rejectionReason: e.reason,
        clampReasons: [],
        fill: null,
        exitReason: null,
        realizedR: null,
        realizedRText: EM_DASH,
        barsHeld: null,
        invalidation: [],
      };
    }
    const proposal = e.response.proposal;
    const clamp = clampsByResponse.get(e.responseId) ?? null;
    const campaign = campaignsByResponse.get(e.responseId) ?? null;
    // Precedence: a campaign carrying the response id executed; otherwise a clamp event means the
    // proposal was changed or blocked; otherwise nothing was due to execute (wait, hold).
    const disposition: ProposalOutcome["disposition"] = campaign ? "executed" : clamp ? "clamped" : "not-executed";
    const exitBarEnd = exitBarEndOf(campaign);
    const r = campaign ? realizedR(campaign) : null;
    return {
      responseId: e.responseId,
      barEnd: e.barEnd,
      action: proposal.action,
      root: proposal.root,
      side: proposal.side,
      disposition,
      rejectionReason: null,
      clampReasons: clamp ? [...clamp.reasons] : [],
      fill: campaign ? firstEntryFill(campaign) : null,
      exitReason: campaign ? exitReasonOf(campaign) : null,
      realizedR: r,
      realizedRText: r === null ? EM_DASH : `${fmtNum(r)} R`,
      barsHeld: campaign ? campaign.exposureBars : null,
      invalidation: proposal.invalidation.map((condition) =>
        evaluateInvalidation({ condition, proposalBarEnd: e.barEnd, side: proposal.side, snapshotsByBar, exitBarEnd }),
      ),
    };
  });
}
