/**
 * Manual journal event constructors. Nothing here sends an order. A draft is not a fill.
 * Each constructor returns events for the ledger; the caller supplies ids.
 */
import { freezeModelConfig, modelConfig, type InstrumentRoot, type ModelConfig } from "../config/modelConfig";
import type { Side, SignalSnapshot } from "../formula/types";
import { INSTRUMENTS } from "../instruments/metadata";
import { mils, type Mils } from "../numerics/money";
import type { Ticks } from "../numerics/ticks";
import { modeledEntryFill, modeledStopExitFill, perContractRisk, positionSize, riskBudget } from "../sizing/sizing";
import { initialStop, stopDistance, trailStop, type StopState } from "../stops/stops";
import { LedgerError } from "./reduce";
import type {
  BrokerStopRecordedEvent,
  BrokerStopStatus,
  CampaignQueuedEvent,
  CashFlowEvent,
  EntryFillEvent,
  ExitFillEvent,
  ExitReason,
  LedgerEvent,
  MarkEvent,
  StopSetEvent,
} from "./types";

export interface ManualEntryInput {
  id: string;
  campaignId: string;
  root: InstrumentRoot;
  /** Filled side (what the broker actually did). Differs from planned.side only as a recorded deviation. */
  side: Side;
  /** Decision snapshot to freeze with the campaign. */
  snapshot: SignalSnapshot;
  /** Planned values shown on the ticket, including the planned side. */
  planned: { side: Side; entry: Ticks; stop: Ticks; contracts: number };
  /** Actual broker fill. */
  fill: { price: Ticks; quantity: number; filledAt: string; timezone: string; feesMils: Mils };
  /** Required when the actual fill differs from the plan. */
  deviationReason?: string;
  /** Actual broker stop as recorded by the user; optional at entry. */
  brokerStop?: { price: Ticks | null; status: BrokerStopStatus; confirmedAt: string };
  /** Account equity used for the planned risk budget; manual accounts supply their own. */
  equityMils: Mils;
  recordedAt: string;
  cfg?: ModelConfig;
}

/**
 * Record an actual entry fill: queues the campaign with a frozen config/snapshot, applies the
 * fill, sets the proposed initial stop from the actual fill and the decision D, and records the
 * broker stop if given. Throws LedgerError when a deviation lacks a reason.
 */
export function recordEntryFill(input: ManualEntryInput): LedgerEvent[] {
  const cfg = input.cfg ?? modelConfig;
  const inst = INSTRUMENTS[input.root];
  const cost = cfg.costs[input.root];
  const { planned, fill } = input;
  const deviates = fill.price !== planned.entry || fill.quantity !== planned.contracts || input.side !== planned.side;
  if (deviates && !input.deviationReason) throw new LedgerError("deviationReason is required when the actual fill differs from the plan (price, contracts or side)");
  if (!Number.isInteger(fill.quantity) || fill.quantity <= 0) throw new LedgerError("fill quantity must be a positive integer");

  // Decision D for the planned side (plan) and for the filled side (actual stop); both from the decision snapshot.
  const plannedDist = stopDistance(input.snapshot.raw.atr20Ticks, input.snapshot.H, planned.side, cfg);
  const dist = stopDistance(input.snapshot.raw.atr20Ticks, input.snapshot.H, input.side, cfg);
  if (!plannedDist.ok) throw new LedgerError(`cannot record entry: ${plannedDist.reason.detail}`);
  if (!dist.ok) throw new LedgerError(`cannot record entry: ${dist.reason.detail}`);

  // Plan: per-contract risk from the planned entry and planned stop with the documented cost convention.
  const plannedExit = modeledStopExitFill(planned.stop, planned.side, cost).fill;
  const plannedRisk = perContractRisk({ entryFill: planned.entry, stopExitFill: plannedExit, tickValueMils: inst.tickValueMils, cost });
  const sizing = positionSize({ equityMils: input.equityMils, perContractRiskMils: plannedRisk.totalMils, cfg });

  // Actual: initial stop from the actual fill and the decision snapshot's D for the filled side; risk from the actual fill.
  const stop = initialStop({ side: input.side, entryFill: fill.price, distance: dist.value, calculatedAt: input.snapshot.availableAt });
  const actualExit = modeledStopExitFill(stop.stop, input.side, cost).fill;
  const actualRisk = perContractRisk({ entryFill: fill.price, stopExitFill: actualExit, tickValueMils: inst.tickValueMils, cost });

  const queued: CampaignQueuedEvent = {
    id: input.id,
    type: "CAMPAIGN_QUEUED",
    timestamp: input.recordedAt,
    actual: true,
    campaignId: input.campaignId,
    mode: "manual",
    root: input.root,
    contract: inst.contract,
    side: planned.side,
    plan: {
      contracts: planned.contracts,
      plannedEntry: planned.entry,
      plannedStop: planned.stop,
      riskBudgetMils: riskBudget(input.equityMils, cfg),
      perContractRisk: plannedRisk,
      sizing,
    },
    frozenConfig: freezeModelConfig(cfg),
    frozenSnapshot: structuredClone(input.snapshot),
    decisionDistance: plannedDist.value,
  };
  const entry: EntryFillEvent = {
    id: `${input.id}:fill`,
    type: "ENTRY_FILL",
    timestamp: input.recordedAt,
    actual: true,
    campaignId: input.campaignId,
    side: input.side,
    decisionDistance: input.side !== planned.side ? dist.value : undefined,
    quantity: fill.quantity,
    price: fill.price,
    feesMils: fill.feesMils,
    filledAt: fill.filledAt,
    timezone: fill.timezone,
    fillModel: "actual-broker",
    perContractRiskMils: actualRisk.totalMils,
    deviationReason: input.deviationReason,
  };
  const proposed: StopSetEvent = {
    id: `${input.id}:stop`,
    type: "STOP_SET",
    timestamp: input.recordedAt,
    actual: false,
    campaignId: input.campaignId,
    kind: "proposed",
    stop,
  };
  const events: LedgerEvent[] = [queued, entry, proposed];
  if (input.brokerStop) {
    events.push(recordBrokerStop({ id: `${input.id}:broker`, campaignId: input.campaignId, recordedAt: input.recordedAt, ...input.brokerStop }));
  }
  return events;
}

export interface ManualExitInput {
  id: string;
  campaignId: string;
  price: Ticks;
  quantity: number;
  filledAt: string;
  timezone: string;
  feesMils: Mils;
  reason?: ExitReason;
  deviationReason?: string;
  recordedAt: string;
}

/** Record an actual exit fill; partial exits are allowed and reconcile remaining size. */
export function recordExitFill(input: ManualExitInput): ExitFillEvent {
  return {
    id: input.id,
    type: "EXIT_FILL",
    timestamp: input.recordedAt,
    actual: true,
    campaignId: input.campaignId,
    quantity: input.quantity,
    price: input.price,
    feesMils: input.feesMils,
    filledAt: input.filledAt,
    timezone: input.timezone,
    fillModel: "actual-broker",
    reason: input.reason ?? "manual",
    deviationReason: input.deviationReason,
  };
}

export function recordBrokerStop(input: {
  id: string;
  campaignId: string;
  price: Ticks | null;
  status: BrokerStopStatus;
  confirmedAt: string;
  recordedAt: string;
}): BrokerStopRecordedEvent {
  return {
    id: input.id,
    type: "BROKER_STOP_RECORDED",
    timestamp: input.recordedAt,
    actual: true,
    campaignId: input.campaignId,
    price: input.price,
    status: input.status,
    confirmedAt: input.confirmedAt,
  };
}

/** An intraday/quote mark: updates P&L and equity, never the trailing-stop reference. */
export function recordMark(input: { id: string; root: InstrumentRoot; price: Ticks; observedAt: string; source: string; recordedAt?: string }): MarkEvent {
  return {
    id: input.id,
    type: "MARK",
    timestamp: input.recordedAt ?? input.observedAt,
    actual: true,
    root: input.root,
    price: input.price,
    observedAt: input.observedAt,
    source: input.source,
    completedClose: false,
  };
}

/** A completed bar close: the only manual path that advances the highest/lowest completed close. */
export function recordCompletedClose(input: { id: string; root: InstrumentRoot; price: Ticks; barEnd: string; recordedAt?: string }): MarkEvent {
  return {
    id: input.id,
    type: "MARK",
    timestamp: input.recordedAt ?? input.barEnd,
    actual: true,
    root: input.root,
    price: input.price,
    observedAt: input.barEnd,
    source: "manual-completed-close",
    completedClose: true,
  };
}

export function recordCashFlow(input: { id: string; amountMils: Mils; note: string; at: string }): CashFlowEvent {
  return { id: input.id, type: "CASH_FLOW", timestamp: input.at, actual: true, amountMils: input.amountMils, note: input.note };
}

/**
 * Propose a trailing stop for a manual campaign from the latest completed signal bar.
 * Changing the suggestion never changes the broker stop; the user records that separately.
 */
export function proposeTrailingStop(input: {
  id: string;
  campaignId: string;
  previous: StopState;
  extremeClose: Ticks;
  atrTicks: number | null;
  H: number | null;
  calculatedAt: string;
  cfg?: ModelConfig;
}): { event: StopSetEvent; changed: boolean } {
  const r = trailStop({ previous: input.previous, extremeClose: input.extremeClose, atrTicks: input.atrTicks, H: input.H, calculatedAt: input.calculatedAt, cfg: input.cfg });
  return {
    event: { id: input.id, type: "STOP_SET", timestamp: input.calculatedAt, actual: false, campaignId: input.campaignId, kind: "proposed", stop: r.state },
    changed: r.changed,
  };
}

/** A correction re-issues an event under a new id, marking the old one superseded; both stay in the log. */
export function correctEvent<E extends LedgerEvent>(original: E, replacement: Omit<E, "id" | "supersededEventId" | "type">, newId: string): E {
  return { ...original, ...replacement, id: newId, supersededEventId: original.id } as E;
}

/** Planned-ticket helper for manual mode: modeled entry from a reference, for display only. */
export function plannedEntryFromReference(reference: Ticks, side: Side, root: InstrumentRoot, cfg: ModelConfig = modelConfig): Ticks {
  return modeledEntryFill(reference, side, cfg.costs[root]);
}

export const ZERO: Mils = mils(0);
