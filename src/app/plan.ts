/**
 * Draft trade plan for the ticket, derived from a snapshot with the stop and sizing modules.
 * Pure; the UI renders this instead of doing its own math. A draft is not a fill.
 */
import { modelConfig, type ModelConfig } from "../config/modelConfig";
import type { Side, SignalSnapshot } from "../formula/types";
import { INSTRUMENTS, type InstrumentMetadata } from "../instruments/metadata";
import { mils, type Mils } from "../numerics/money";
import { ticks, type Ticks } from "../numerics/ticks";
import { MARGIN_NOTE, modeledEntryFill, modeledStopExitFill, perContractRisk, positionSize, type PerContractRisk, type PositionSize } from "../sizing/sizing";
import { initialStop, stopDistance, type StopDistance } from "../stops/stops";

export interface DraftPlan {
  ok: true;
  instrument: InstrumentMetadata;
  side: Side;
  /** Modeled entry from the decision close with the documented cost convention. */
  plannedEntry: Ticks;
  plannedStop: Ticks;
  distance: StopDistance;
  distanceTicks: Ticks;
  /** Stop distance as a fraction of the planned entry (display only). */
  pctOfEntry: number;
  perContractRisk: PerContractRisk;
  /** Null when account equity is not entered (manual) — shows an em dash. */
  sizing: PositionSize | null;
  contracts: number;
  riskMils: Mils;
  pctOfEquity: number | null;
  marginNote: typeof MARGIN_NOTE;
}

export interface DraftUnavailable {
  ok: false;
  instrument: InstrumentMetadata;
  reason: string;
}

export function draftPlan(
  snapshot: SignalSnapshot,
  side: Side | null,
  equityMils: Mils | null,
  cfg: ModelConfig = modelConfig,
  contractsOverride?: number,
): DraftPlan | DraftUnavailable {
  const instrument = INSTRUMENTS[snapshot.root];
  if (!snapshot.dataQuality.available) {
    const first = snapshot.dataQuality.reasons[0];
    return { ok: false, instrument, reason: first ? `${first.code}: ${first.detail}` : "signal unavailable" };
  }
  if (side === null) return { ok: false, instrument, reason: "neutral market: no candidate side" };
  if (snapshot.raw.closeT === null) return { ok: false, instrument, reason: "no decision close price" };
  const dist = stopDistance(snapshot.raw.atr20Ticks, snapshot.H, side, cfg);
  if (!dist.ok) return { ok: false, instrument, reason: `${dist.reason.code}: ${dist.reason.detail}` };
  const cost = cfg.costs[snapshot.root];
  const plannedEntry = modeledEntryFill(snapshot.raw.closeT, side, cost);
  const plannedStop = initialStop({ side, entryFill: plannedEntry, distance: dist.value, calculatedAt: snapshot.availableAt }).stop;
  const exit = modeledStopExitFill(plannedStop, side, cost).fill;
  const risk = perContractRisk({ entryFill: plannedEntry, stopExitFill: exit, tickValueMils: instrument.tickValueMils, cost });
  const sizing = equityMils !== null ? positionSize({ equityMils, perContractRiskMils: risk.totalMils, cfg }) : null;
  const contracts = contractsOverride ?? (sizing ? sizing.contracts : 1);
  const distanceTicks = ticks(Math.abs(plannedEntry - plannedStop));
  return {
    ok: true,
    instrument,
    side,
    plannedEntry,
    plannedStop,
    distance: dist.value,
    distanceTicks,
    pctOfEntry: distanceTicks / plannedEntry,
    perContractRisk: risk,
    sizing,
    contracts,
    riskMils: mils(risk.totalMils * contracts),
    pctOfEquity: equityMils !== null && equityMils > 0 ? (risk.totalMils * contracts) / equityMils : null,
    marginNote: MARGIN_NOTE,
  };
}

/** Candidate side for the ticket: qualified side, else H-aligned display side, else null. */
export function candidateSide(snapshot: SignalSnapshot): Side | null {
  if (snapshot.qualifiedSide !== null) return snapshot.qualifiedSide;
  if (snapshot.displaySide === "long") return 1;
  if (snapshot.displaySide === "short") return -1;
  return null;
}
