/**
 * Deterministic paper execution engine (brief "Paper execution and data", D3, D4, D5).
 * Decision bar while flat and not paused -> PENDING with the top qualifying, sizeable candidate.
 * Fill no earlier than the next executable bar. OHLC-only stop simulation: gap past a resting stop
 * exits at the open plus adverse slippage; a touched stop fills at stop plus adverse slippage.
 * Same-bar ambiguity resolves conservatively. Close-based stops apply only afterward.
 * Event ids derive from bar identity so a repeated bar event cannot duplicate fills.
 */
import { freezeModelConfig, modelConfig, type InstrumentRoot, type ModelConfig } from "../config/modelConfig";
import type { SignalSnapshot } from "../formula/types";
import { INSTRUMENTS } from "../instruments/metadata";
import { floorDivMils, formatMils, mulMilsInt, type Mils } from "../numerics/money";
import { ticks, type Ticks } from "../numerics/ticks";
import { rankSnapshots } from "../ranking/rank";
import { modeledEntryFill, modeledStopExitFill, perContractRisk, positionSize } from "../sizing/sizing";
import { closeRequired, initialStop, stopAppliesToBar, stopDistance, trailStop, type OhlcBar } from "../stops/stops";
import type { Campaign, LedgerEvent } from "../campaign/types";
import type { Ledger } from "../ledger/ledger";

export const PAPER_FILL_MODEL = "paper-model-0.1" as const;

export interface EngineBar extends OhlcBar {
  root: InstrumentRoot;
}

/** Per-bar signal inputs for trailing: the bar's SMA ATR20 and H; null when unavailable. */
export interface TrailInputs {
  atrTicks: number | null;
  H: number | null;
}

export interface SkippedCandidate {
  root: InstrumentRoot;
  reason: string;
}

export type DecisionOutcome =
  | { kind: "queued"; campaignId: string; root: InstrumentRoot; contracts: number; skipped: SkippedCandidate[] }
  | { kind: "paused" }
  | { kind: "position-active"; campaignId: string }
  | { kind: "no-qualifying" }
  /** Every qualifying candidate was skipped; root/reason are the last one, skipped lists all. */
  | { kind: "skip"; root: InstrumentRoot; reason: string; skipped: SkippedCandidate[] };

export interface ObservationOutcome {
  campaignId: string | null;
  exited: { reason: "stop-touched" | "gap-open" | "close-required"; price: Ticks } | null;
  stopChanged: boolean;
  stopFrozen: boolean;
  closeRequested: boolean;
  events: LedgerEvent[];
}

function campaignFor(ledger: Ledger, root: InstrumentRoot): Campaign | null {
  const c = ledger.activeCampaign;
  return c && c.root === root ? c : null;
}

/**
 * At a completed decision bar while flat: walk the qualifying candidates in rank order and queue
 * the first one that is sizeable under the risk budget; every skipped candidate is reported with its
 * reason. Never fills; fills happen on the next executable bar.
 */
export function onDecisionBar(ledger: Ledger, snapshots: readonly SignalSnapshot[], equityMils: Mils, cfg: ModelConfig = modelConfig): DecisionOutcome {
  const state = ledger.state;
  if (state.paused) return { kind: "paused" };
  if (state.activeCampaignId) return { kind: "position-active", campaignId: state.activeCampaignId };
  const qualified = rankSnapshots(snapshots).filter((e) => e.group === "qualified").map((e) => e.snapshot);
  if (qualified.length === 0) return { kind: "no-qualifying" };

  const skipped: SkippedCandidate[] = [];
  for (const top of qualified) {
    const root = top.root;
    const skip = (reason: string) => skipped.push({ root, reason });
    if (top.qualifiedSide === null) {
      skip("no qualified side");
      continue;
    }
    const side = top.qualifiedSide;
    const inst = INSTRUMENTS[root];
    const cost = cfg.costs[root];
    if (top.raw.closeT === null) {
      skip("decision snapshot has no close price");
      continue;
    }
    const dist = stopDistance(top.raw.atr20Ticks, top.H, side, cfg);
    if (!dist.ok) {
      skip(dist.reason.detail);
      continue;
    }
    const plannedEntry = modeledEntryFill(top.raw.closeT, side, cost);
    const plannedStop = initialStop({ side, entryFill: plannedEntry, distance: dist.value, calculatedAt: top.availableAt }).stop;
    const plannedExit = modeledStopExitFill(plannedStop, side, cost).fill;
    const risk = perContractRisk({ entryFill: plannedEntry, stopExitFill: plannedExit, tickValueMils: inst.tickValueMils, cost });
    const sizing = positionSize({ equityMils, perContractRiskMils: risk.totalMils, cfg });
    if (sizing.skip) {
      skip(sizing.skipReason ?? "size is zero");
      continue;
    }
    const campaignId = `paper:${root}:${top.barEnd}`;
    if (state.campaigns[campaignId]) {
      skip(`decision bar ${top.barEnd} already used for ${root}`);
      continue;
    }
    const r = ledger.append({
      id: `${campaignId}:queued`,
      type: "CAMPAIGN_QUEUED",
      timestamp: top.availableAt,
      actual: false,
      campaignId,
      mode: "paper",
      root,
      contract: inst.contract,
      side,
      plan: { contracts: sizing.contracts, plannedEntry, plannedStop, riskBudgetMils: sizing.budgetMils, perContractRisk: risk, sizing },
      frozenConfig: freezeModelConfig(cfg),
      frozenSnapshot: structuredClone(top),
      decisionDistance: dist.value,
    });
    if (!r.applied && r.reason !== "duplicate") {
      skip(r.reason ?? "ledger refused");
      continue;
    }
    return { kind: "queued", campaignId, root, contracts: sizing.contracts, skipped };
  }
  const last = skipped[skipped.length - 1]!;
  return { kind: "skip", root: last.root, reason: last.reason, skipped };
}

/**
 * First executable bar after a decision: fill PENDING at the open with the modeled adjustment,
 * re-size under the frozen budget if the opening gap changed per-contract risk (explicit policy:
 * recalculate quantity, skip when zero), set the initial resting stop, then observe the same bar
 * (a stop touch in the fill bar is assumed hit — conservative).
 */
export function onExecutableBar(ledger: Ledger, bar: EngineBar, trail: TrailInputs | null, cfg: ModelConfig = modelConfig): ObservationOutcome {
  const c = campaignFor(ledger, bar.root);
  const events: LedgerEvent[] = [];
  if (c && c.state === "PENDING") {
    const inst = INSTRUMENTS[c.root];
    const cost = c.frozenConfig.costs[c.root];
    const fill = modeledEntryFill(bar.open, c.side, cost);
    const stop = initialStop({ side: c.side, entryFill: fill, distance: c.decisionDistance, calculatedAt: c.frozenSnapshot.availableAt });
    const exit = modeledStopExitFill(stop.stop, c.side, cost).fill;
    const risk = perContractRisk({ entryFill: fill, stopExitFill: exit, tickValueMils: inst.tickValueMils, cost });
    const contracts = floorDivMils(c.plan.riskBudgetMils, risk.totalMils);
    if (contracts === 0) {
      const cancel: LedgerEvent = {
        id: `${c.id}:cancel:${bar.barEnd}`,
        type: "CAMPAIGN_CANCELLED",
        timestamp: bar.availableAt,
        actual: false,
        campaignId: c.id,
        reason: `opening gap: one contract risks ${formatMils(risk.totalMils)}, above the ${formatMils(c.plan.riskBudgetMils)} budget`,
      };
      if (ledger.append(cancel).applied) events.push(cancel);
      return { campaignId: c.id, exited: null, stopChanged: false, stopFrozen: false, closeRequested: false, events };
    }
    const fillEvent: LedgerEvent = {
      id: `${c.id}:fill:${bar.barEnd}`,
      type: "ENTRY_FILL",
      timestamp: bar.barEnd,
      actual: false,
      campaignId: c.id,
      side: c.side,
      quantity: contracts,
      price: fill,
      feesMils: mulMilsInt(cost.feePerContractPerSideMils, contracts),
      filledAt: bar.barEnd,
      fillModel: PAPER_FILL_MODEL,
      perContractRiskMils: risk.totalMils,
    };
    const stopEvent: LedgerEvent = {
      id: `${c.id}:stop:initial`,
      type: "STOP_SET",
      timestamp: bar.barEnd,
      actual: false,
      campaignId: c.id,
      kind: "resting",
      stop,
    };
    if (ledger.append(fillEvent).applied) events.push(fillEvent);
    if (ledger.append(stopEvent).applied) events.push(stopEvent);
  }
  const obs = onObservationBar(ledger, bar, trail, cfg);
  return { ...obs, events: [...events, ...obs.events] };
}

/**
 * Observation bar for an open paper position: close-required exit first, then resting-stop test
 * (only if the stop was effective before this bar), then trailing from this bar's close, then mark.
 * A running campaign is governed by its frozen config; the `cfg` argument is not used for it.
 */
export function onObservationBar(ledger: Ledger, bar: EngineBar, trail: TrailInputs | null, _cfg: ModelConfig = modelConfig): ObservationOutcome {
  const c = campaignFor(ledger, bar.root);
  const events: LedgerEvent[] = [];
  const push = (e: LedgerEvent) => {
    if (ledger.append(e).applied) events.push(e);
  };
  const out: ObservationOutcome = { campaignId: c?.id ?? null, exited: null, stopChanged: false, stopFrozen: false, closeRequested: false, events };
  if (!c || c.state !== "OPEN") return out;
  const cost = c.frozenConfig.costs[c.root];
  const exitAll = (price: Ticks, reason: "stop-touched" | "gap-open" | "close-required") => {
    push({
      id: `${c.id}:exit:${bar.barEnd}`,
      type: "EXIT_FILL",
      timestamp: bar.barEnd,
      actual: false,
      campaignId: c.id,
      quantity: c.remaining,
      price,
      feesMils: mulMilsInt(cost.feePerContractPerSideMils, c.remaining),
      filledAt: bar.barEnd,
      fillModel: PAPER_FILL_MODEL,
      reason,
    });
    out.exited = { reason, price };
  };

  if (c.closeRequested) {
    exitAll(modeledStopExitFill(bar.open, c.side, cost, bar.open).fill, "close-required");
  } else if (c.restingStop && stopAppliesToBar(c.restingStop, bar)) {
    const stop = c.restingStop.stop;
    const gapped = c.side === 1 ? bar.open <= stop : bar.open >= stop;
    const touched = c.side === 1 ? bar.low <= stop : bar.high >= stop;
    if (gapped) exitAll(modeledStopExitFill(stop, c.side, cost, bar.open).fill, "gap-open");
    else if (touched) exitAll(modeledStopExitFill(stop, c.side, cost).fill, "stop-touched");
  }

  if (!out.exited && c.restingStop) {
    const prevExtreme = c.extremeClose;
    const extreme: Ticks =
      prevExtreme === null ? bar.close : c.side === 1 ? ticks(Math.max(prevExtreme, bar.close)) : ticks(Math.min(prevExtreme, bar.close));
    const t = trailStop({ previous: c.restingStop, extremeClose: extreme, atrTicks: trail?.atrTicks ?? null, H: trail?.H ?? null, calculatedAt: bar.availableAt, cfg: c.frozenConfig });
    out.stopChanged = t.changed;
    out.stopFrozen = t.state.source === "frozen";
    // A stop that was frozen and now has valid inputs is re-issued even if unchanged, so DATA STALE clears.
    const recovered = c.restingStop.source === "frozen" && !out.stopFrozen;
    if (t.changed || out.stopFrozen || recovered) {
      push({ id: `${c.id}:stop:${bar.barEnd}`, type: "STOP_SET", timestamp: bar.availableAt, actual: false, campaignId: c.id, kind: "resting", stop: t.state });
    }
    const cr = closeRequired(t.state, { bid: bar.close, ask: bar.close, observedAt: bar.barEnd });
    if (cr.required) {
      push({ id: `${c.id}:close-required:${bar.barEnd}`, type: "CLOSE_REQUESTED", timestamp: bar.availableAt, actual: false, campaignId: c.id, reason: cr.detail });
      out.closeRequested = true;
    }
  }

  push({ id: `${c.id}:mark:${bar.barEnd}`, type: "MARK", timestamp: bar.barEnd, actual: false, root: bar.root, price: bar.close, observedAt: bar.barEnd, source: "paper-observation-bar", completedClose: true });
  push({ id: `${c.id}:monitor:${bar.barEnd}`, type: "STOP_MONITOR", timestamp: bar.barEnd, actual: false, healthy: true, checkedAt: bar.barEnd, detail: `resting stop checked against bar ending ${bar.barEnd}` });
  return out;
}

export function pause(ledger: Ledger, at: string, id = `paper:pause:${at}`): boolean {
  return ledger.append({ id, type: "PAPER_PAUSED", timestamp: at, actual: false }).applied;
}

export function resume(ledger: Ledger, at: string, id = `paper:resume:${at}`): boolean {
  return ledger.append({ id, type: "PAPER_RESUMED", timestamp: at, actual: false }).applied;
}

/** Stop-monitor health: unhealthy when it never ran or its last check is older than maxAgeMs. */
export function stopMonitorStatus(ledger: Ledger, now: string, maxAgeMs: number): { healthy: boolean; lastCheckedAt: string | null; detail: string } {
  const m = ledger.state.stopMonitor;
  if (!m.lastCheckedAt) return { healthy: false, lastCheckedAt: null, detail: m.detail };
  const age = Date.parse(now) - Date.parse(m.lastCheckedAt);
  if (!Number.isFinite(age) || age > maxAgeMs) return { healthy: false, lastCheckedAt: m.lastCheckedAt, detail: `last stop check ${m.lastCheckedAt} is older than ${maxAgeMs} ms; monitoring not guaranteed` };
  return { healthy: m.healthy, lastCheckedAt: m.lastCheckedAt, detail: m.detail };
}
