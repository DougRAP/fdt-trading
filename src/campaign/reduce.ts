/**
 * Event reducer: derives LedgerState from an append-only event log.
 * Duplicate ids are no-ops; superseded events are skipped but retained by the caller.
 * Invalid transitions throw LedgerError so the ledger can refuse the append.
 */
import { INSTRUMENTS } from "../instruments/metadata";
import { addMils, mils, subMils, ticksToMils, type Mils } from "../numerics/money";
import { ticks, type Ticks } from "../numerics/ticks";
import type {
  AccountEquityPoint,
  Campaign,
  CampaignQueuedEvent,
  EntryFillEvent,
  ExitFillEvent,
  LedgerEvent,
  LedgerState,
  Mode,
} from "./types";

export class LedgerError extends Error {
  override readonly name = "LedgerError";
}

export function initialState(mode: Mode, startingEquityMils: Mils): LedgerState {
  return {
    mode,
    campaigns: {},
    campaignOrder: [],
    activeCampaignId: null,
    marks: {},
    paused: false,
    stopMonitor: { healthy: false, lastCheckedAt: null, detail: "stop monitor has not run" },
    startingEquityMils,
    cashMils: startingEquityMils,
    externalCashFlowMils: mils(0),
    cumulativeNetRealizedMils: mils(0),
    equitySeries: [],
    appliedEventIds: [],
    supersededEventIds: [],
  };
}

function getCampaign(state: LedgerState, id: string): Campaign {
  const c = state.campaigns[id];
  if (!c) throw new LedgerError(`unknown campaign ${id}`);
  return c;
}

function tickValue(root: Campaign["root"]): Mils {
  return INSTRUMENTS[root].tickValueMils;
}

/** Unrealized P&L of remaining lots at a mark. */
export function unrealizedAt(c: Campaign, mark: Ticks): Mils {
  let total = 0;
  for (const lot of c.lots) {
    if (lot.remaining <= 0) continue;
    total += ticksToMils(ticks(c.side * (mark - lot.price)), tickValue(c.root), lot.remaining);
  }
  return mils(total);
}

function openCampaigns(state: LedgerState): Campaign[] {
  return state.campaignOrder.map((id) => state.campaigns[id]!).filter((c) => c.state === "OPEN");
}

function pushEquityPoint(state: LedgerState, timestamp: string, externalCashFlowMils: Mils): void {
  let unrealized = 0;
  let freshness: AccountEquityPoint["freshness"] = "flat";
  const open = openCampaigns(state);
  if (open.length > 0) freshness = "marked";
  for (const c of open) {
    const mark = state.marks[c.root];
    if (!mark) {
      freshness = "no-mark";
      continue;
    }
    unrealized += unrealizedAt(c, mark.price);
  }
  const unrealizedMils = mils(unrealized);
  const liabilitiesMils = mils(0);
  state.equitySeries.push({
    mode: state.mode,
    timestamp,
    cashMils: state.cashMils,
    realizedMils: state.cumulativeNetRealizedMils,
    unrealizedMils,
    liabilitiesMils,
    externalCashFlowMils,
    equityMils: subMils(addMils(state.cashMils, unrealizedMils), liabilitiesMils),
    freshness,
  });
}

function applyQueued(state: LedgerState, e: CampaignQueuedEvent): void {
  if (state.campaigns[e.campaignId]) throw new LedgerError(`campaign ${e.campaignId} already exists`);
  if (e.mode !== state.mode) throw new LedgerError(`event mode ${e.mode} does not match ledger mode ${state.mode}`);
  if (state.activeCampaignId) throw new LedgerError(`campaign ${state.activeCampaignId} is still active; one position per mode`);
  if (!Number.isInteger(e.plan.contracts) || e.plan.contracts <= 0) throw new LedgerError("plan contracts must be a positive integer");
  const c: Campaign = {
    id: e.campaignId,
    mode: e.mode,
    root: e.root,
    contract: e.contract,
    side: e.side,
    state: "PENDING",
    frozenConfig: e.frozenConfig,
    frozenSnapshot: e.frozenSnapshot,
    decisionDistance: e.decisionDistance,
    plan: e.plan,
    fills: [],
    lots: [],
    entryQuantity: 0,
    exitQuantity: 0,
    remaining: 0,
    entryBasisTicksQty: 0,
    originalRiskMils: null,
    grossRealizedMils: mils(0),
    feesMils: mils(0),
    netRealizedMils: mils(0),
    proposedStop: null,
    restingStop: null,
    brokerStop: null,
    closeRequested: null,
    extremeClose: null,
    exposureBars: 0,
    deviationReasons: [],
    stopFrozenReason: null,
    queuedAt: e.timestamp,
    openedAt: null,
    closedAt: null,
    cancelReason: null,
  };
  state.campaigns[c.id] = c;
  state.campaignOrder.push(c.id);
  state.activeCampaignId = c.id;
}

function applyEntryFill(state: LedgerState, e: EntryFillEvent): void {
  const c = getCampaign(state, e.campaignId);
  if (c.state !== "PENDING" && c.state !== "OPEN") throw new LedgerError(`cannot fill entry on ${c.state} campaign ${c.id}`);
  if (!Number.isInteger(e.quantity) || e.quantity <= 0) throw new LedgerError("entry quantity must be a positive integer");
  if (!Number.isSafeInteger(e.price) || e.price <= 0) throw new LedgerError("entry price must be a positive tick count");
  if (!Number.isSafeInteger(e.feesMils) || e.feesMils < 0) throw new LedgerError("entry fees must be nonnegative mils");
  const deviates = e.price !== c.plan.plannedEntry || e.quantity !== c.plan.contracts;
  if (deviates && e.fillModel === "actual-broker" && !e.deviationReason) {
    throw new LedgerError("deviationReason is required when an actual fill differs from the plan");
  }
  c.fills.push({
    eventId: e.id,
    kind: "entry",
    quantity: e.quantity,
    price: e.price,
    feesMils: e.feesMils,
    filledAt: e.filledAt,
    timezone: e.timezone,
    fillModel: e.fillModel,
    actual: e.actual,
    deviationReason: e.deviationReason,
  });
  c.lots.push({ price: e.price, remaining: e.quantity });
  c.entryQuantity += e.quantity;
  c.remaining += e.quantity;
  c.entryBasisTicksQty += e.price * e.quantity;
  c.feesMils = addMils(c.feesMils, e.feesMils);
  c.netRealizedMils = subMils(c.grossRealizedMils, c.feesMils);
  if (e.deviationReason) c.deviationReasons.push(e.deviationReason);
  if (!Number.isSafeInteger(e.perContractRiskMils) || e.perContractRiskMils < 0) throw new LedgerError("perContractRiskMils must be nonnegative mils");
  // Frozen original risk: per-contract risk from the actual fill x contracts actually entered.
  const riskAdded = mils(e.perContractRiskMils * e.quantity);
  if (c.state === "PENDING") {
    c.state = "OPEN";
    c.openedAt = e.filledAt;
    c.originalRiskMils = riskAdded;
  } else {
    c.originalRiskMils = addMils(c.originalRiskMils ?? mils(0), riskAdded);
  }
  state.cashMils = subMils(state.cashMils, e.feesMils);
  state.cumulativeNetRealizedMils = subMils(state.cumulativeNetRealizedMils, e.feesMils);
  pushEquityPoint(state, e.filledAt, mils(0));
}

function applyExitFill(state: LedgerState, e: ExitFillEvent): void {
  const c = getCampaign(state, e.campaignId);
  if (c.state !== "OPEN") throw new LedgerError(`cannot fill exit on ${c.state} campaign ${c.id}`);
  if (!Number.isInteger(e.quantity) || e.quantity <= 0) throw new LedgerError("exit quantity must be a positive integer");
  if (e.quantity > c.remaining) throw new LedgerError(`exit quantity ${e.quantity} exceeds remaining ${c.remaining}`);
  if (!Number.isSafeInteger(e.price) || e.price <= 0) throw new LedgerError("exit price must be a positive tick count");
  if (!Number.isSafeInteger(e.feesMils) || e.feesMils < 0) throw new LedgerError("exit fees must be nonnegative mils");
  let left = e.quantity;
  let gross = 0;
  for (const lot of c.lots) {
    if (left === 0) break;
    if (lot.remaining <= 0) continue;
    const matched = Math.min(lot.remaining, left);
    gross += ticksToMils(ticks(c.side * (e.price - lot.price)), tickValue(c.root), matched);
    lot.remaining -= matched;
    left -= matched;
  }
  const grossMils = mils(gross);
  c.fills.push({
    eventId: e.id,
    kind: "exit",
    quantity: e.quantity,
    price: e.price,
    feesMils: e.feesMils,
    filledAt: e.filledAt,
    timezone: e.timezone,
    fillModel: e.fillModel,
    actual: e.actual,
    reason: e.reason,
    deviationReason: e.deviationReason,
  });
  c.exitQuantity += e.quantity;
  c.remaining -= e.quantity;
  c.grossRealizedMils = addMils(c.grossRealizedMils, grossMils);
  c.feesMils = addMils(c.feesMils, e.feesMils);
  c.netRealizedMils = subMils(c.grossRealizedMils, c.feesMils);
  if (e.deviationReason) c.deviationReasons.push(e.deviationReason);
  const cashDelta = subMils(grossMils, e.feesMils);
  state.cashMils = addMils(state.cashMils, cashDelta);
  state.cumulativeNetRealizedMils = addMils(state.cumulativeNetRealizedMils, cashDelta);
  if (c.remaining === 0) {
    c.state = "CLOSED";
    c.closedAt = e.filledAt;
    c.closeRequested = null;
    state.activeCampaignId = null;
  }
  pushEquityPoint(state, e.filledAt, mils(0));
}

/** Apply one event in place. Throws LedgerError on invalid transitions. */
export function applyEvent(state: LedgerState, e: LedgerEvent): void {
  switch (e.type) {
    case "CAMPAIGN_QUEUED":
      applyQueued(state, e);
      break;
    case "ENTRY_FILL":
      applyEntryFill(state, e);
      break;
    case "EXIT_FILL":
      applyExitFill(state, e);
      break;
    case "STOP_SET": {
      const c = getCampaign(state, e.campaignId);
      if (c.state !== "OPEN" && c.state !== "PENDING") throw new LedgerError(`cannot set stop on ${c.state} campaign ${c.id}`);
      if (e.stop.side !== c.side) throw new LedgerError("stop side does not match campaign side");
      if (e.kind === "resting") c.restingStop = e.stop;
      else c.proposedStop = e.stop;
      c.stopFrozenReason = e.stop.source === "frozen" ? (e.stop.reason ?? null) : null;
      c.extremeClose = e.stop.source === "initial" ? c.extremeClose : e.stop.basis.referenceClose;
      break;
    }
    case "BROKER_STOP_RECORDED": {
      const c = getCampaign(state, e.campaignId);
      c.brokerStop = { price: e.price, status: e.status, confirmedAt: e.confirmedAt };
      break;
    }
    case "MARK": {
      if (!Number.isSafeInteger(e.price) || e.price <= 0) throw new LedgerError("mark price must be a positive tick count");
      state.marks[e.root] = { root: e.root, price: e.price, observedAt: e.observedAt, source: e.source };
      for (const c of openCampaigns(state)) {
        if (c.root === e.root) {
          c.exposureBars += 1;
          c.extremeClose =
            c.extremeClose === null
              ? e.price
              : c.side === 1
                ? ticks(Math.max(c.extremeClose, e.price))
                : ticks(Math.min(c.extremeClose, e.price));
        }
      }
      pushEquityPoint(state, e.observedAt, mils(0));
      break;
    }
    case "CASH_FLOW": {
      if (!Number.isSafeInteger(e.amountMils)) throw new LedgerError("cash flow must be integer mils");
      state.cashMils = addMils(state.cashMils, e.amountMils);
      state.externalCashFlowMils = addMils(state.externalCashFlowMils, e.amountMils);
      pushEquityPoint(state, e.timestamp, e.amountMils);
      break;
    }
    case "PAPER_PAUSED":
      state.paused = true;
      break;
    case "PAPER_RESUMED":
      state.paused = false;
      break;
    case "CAMPAIGN_CANCELLED": {
      const c = getCampaign(state, e.campaignId);
      if (c.state !== "PENDING") throw new LedgerError(`only PENDING campaigns can be cancelled (${c.id} is ${c.state})`);
      c.state = "CANCELLED";
      c.cancelReason = e.reason;
      c.closedAt = e.timestamp;
      if (state.activeCampaignId === c.id) state.activeCampaignId = null;
      break;
    }
    case "CLOSE_REQUESTED": {
      const c = getCampaign(state, e.campaignId);
      if (c.state !== "OPEN") throw new LedgerError(`cannot request close on ${c.state} campaign ${c.id}`);
      c.closeRequested = { reason: e.reason, at: e.timestamp };
      break;
    }
    case "STOP_MONITOR":
      state.stopMonitor = { healthy: e.healthy, lastCheckedAt: e.checkedAt, detail: e.detail };
      break;
  }
}

/**
 * Reduce a full log. Duplicate ids are skipped; events superseded by a later correction are
 * skipped but reported in supersededEventIds. Throws LedgerError on the first invalid event.
 */
export function reduceEvents(mode: Mode, startingEquityMils: Mils, events: readonly LedgerEvent[]): LedgerState {
  const state = initialState(mode, startingEquityMils);
  const seen = new Set<string>();
  const superseded = new Set<string>();
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    if (e.supersededEventId) superseded.add(e.supersededEventId);
  }
  const applied = new Set<string>();
  for (const e of events) {
    if (applied.has(e.id)) continue;
    if (superseded.has(e.id)) continue;
    applyEvent(state, e);
    applied.add(e.id);
  }
  state.appliedEventIds = [...applied];
  state.supersededEventIds = [...superseded];
  return state;
}
