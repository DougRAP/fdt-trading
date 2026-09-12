/**
 * Position summary helpers for the open state (brief "Open state:"), mark staleness,
 * stop discrepancy and actionable flags. Computed, never stored.
 */
import { INSTRUMENTS } from "../instruments/metadata";
import { addMils, mils, type Mils } from "../numerics/money";
import { ticks, type Ticks } from "../numerics/ticks";
import { unrealizedAt } from "./reduce";
import type { Campaign, Mark } from "./types";

/** A mark is stale when observedAt is older than maxAgeMs relative to now. */
export function isStale(mark: Pick<Mark, "observedAt"> | null, now: string, maxAgeMs: number): boolean {
  if (!mark) return true;
  const observed = Date.parse(mark.observedAt);
  const current = Date.parse(now);
  if (!Number.isFinite(observed) || !Number.isFinite(current)) return true;
  return current - observed > maxAgeMs;
}

export type Flag = "DATA STALE" | "STOP UPDATE NEEDED" | "STOP BREACHED—VERIFY BROKER" | "CLOSE REQUIRED" | "EXIT RECORDED";

export interface StopDiscrepancy {
  proposed: Ticks | null;
  broker: Ticks | null;
  /** broker - proposed, in ticks; null when either side is missing. */
  diffTicks: Ticks | null;
  matches: boolean;
}

export function stopDiscrepancy(c: Campaign): StopDiscrepancy {
  const proposed = c.proposedStop?.stop ?? c.restingStop?.stop ?? null;
  const broker = c.brokerStop?.status === "working" ? c.brokerStop.price : null;
  const diffTicks = proposed !== null && broker !== null ? ticks(broker - proposed) : null;
  return { proposed, broker, diffTicks, matches: diffTicks === 0 };
}

export interface PositionSummary {
  campaignId: string;
  state: Campaign["state"];
  mark: Mark | null;
  markStale: boolean;
  /** Display-only average entry in ticks (may be fractional). */
  averageEntryTicks: number | null;
  originalRiskMils: Mils | null;
  unrealizedMils: Mils | null;
  realizedMils: Mils;
  feesMils: Mils;
  /** (net realized + unrealized) / original risk; null without mark or risk. */
  rMultiple: number | null;
  proposedStop: Ticks | null;
  restingStop: Ticks | null;
  brokerStop: Ticks | null;
  discrepancy: StopDiscrepancy;
  remaining: number;
  flags: Flag[];
}

/** Flags in priority order (brief "Flags should be actionable"). */
export function campaignFlags(c: Campaign, mark: Mark | null, markStale: boolean): Flag[] {
  const flags: Flag[] = [];
  if (c.state === "CLOSED") return ["EXIT RECORDED"];
  if (c.state !== "OPEN") return flags;
  if (markStale || c.stopFrozenReason) flags.push("DATA STALE");
  if (c.closeRequested) flags.push("CLOSE REQUIRED");
  if (c.mode === "manual" && mark && c.brokerStop?.status === "working" && c.brokerStop.price !== null) {
    const breached = c.side === 1 ? mark.price <= c.brokerStop.price : mark.price >= c.brokerStop.price;
    if (breached) flags.push("STOP BREACHED—VERIFY BROKER");
  }
  if (c.mode === "manual") {
    const d = stopDiscrepancy(c);
    if (d.proposed !== null && (d.broker === null || d.diffTicks !== 0)) flags.push("STOP UPDATE NEEDED");
  }
  return flags;
}

export function positionSummary(c: Campaign, mark: Mark | null, now: string, maxAgeMs: number): PositionSummary {
  const markForRoot = mark && mark.root === c.root ? mark : null;
  const markStale = c.state === "OPEN" ? isStale(markForRoot, now, maxAgeMs) : false;
  const unrealizedMils = c.state === "OPEN" && markForRoot ? unrealizedAt(c, markForRoot.price) : c.state === "OPEN" ? null : mils(0);
  const rMultiple =
    c.originalRiskMils !== null && c.originalRiskMils > 0 && unrealizedMils !== null
      ? addMils(c.netRealizedMils, unrealizedMils) / c.originalRiskMils
      : null;
  return {
    campaignId: c.id,
    state: c.state,
    mark: markForRoot,
    markStale,
    averageEntryTicks: c.entryQuantity > 0 ? c.entryBasisTicksQty / c.entryQuantity : null,
    originalRiskMils: c.originalRiskMils,
    unrealizedMils,
    realizedMils: c.netRealizedMils,
    feesMils: c.feesMils,
    rMultiple,
    proposedStop: c.proposedStop?.stop ?? null,
    restingStop: c.restingStop?.stop ?? null,
    brokerStop: c.brokerStop?.price ?? null,
    discrepancy: stopDiscrepancy(c),
    remaining: c.remaining,
    flags: campaignFlags(c, markForRoot, markStale),
  };
}

/** Realized R for a closed campaign: net realized / original risk. */
export function realizedR(c: Campaign): number | null {
  if (c.state !== "CLOSED" || c.originalRiskMils === null || c.originalRiskMils <= 0) return null;
  return c.netRealizedMils / c.originalRiskMils;
}

export function tickValueOf(c: Campaign): Mils {
  return INSTRUMENTS[c.root].tickValueMils;
}
