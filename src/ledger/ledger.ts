/**
 * Append-only ledger per mode (D12). State is derived by reducing events; duplicate ids are
 * no-ops; corrections append with supersededEventId and the superseded event stays in the log.
 * Equity series, max drawdown and stats live here (brief "Campaign results").
 */
import { modelConfig, type InstrumentRoot, type ModelConfig } from "../config/modelConfig";
import { addMils, mils, type Mils } from "../numerics/money";
import { LedgerError, reduceEvents } from "../campaign/reduce";
import { realizedR } from "../campaign/pnl";
import type { AccountEquityPoint, Campaign, LedgerEvent, LedgerState, Mode } from "../campaign/types";

export interface AppendResult {
  applied: boolean;
  /** "duplicate" when the id was already in the log; otherwise the LedgerError message. */
  reason: string | null;
}

export interface LedgerOptions {
  startingEquityMils?: Mils;
  cfg?: ModelConfig;
}

export class Ledger {
  readonly mode: Mode;
  readonly startingEquityMils: Mils;
  private readonly log: LedgerEvent[] = [];
  private cached: LedgerState | null = null;

  constructor(mode: Mode, options: LedgerOptions = {}) {
    const cfg = options.cfg ?? modelConfig;
    this.mode = mode;
    this.startingEquityMils = options.startingEquityMils ?? (mode === "paper" ? cfg.paperEquityStartMils : mils(0));
  }

  /** Rebuild from a stored log; throws LedgerError if any event is invalid. */
  static fromEvents(mode: Mode, events: readonly LedgerEvent[], options: LedgerOptions = {}): Ledger {
    const ledger = new Ledger(mode, options);
    for (const e of events) {
      const r = ledger.append(e);
      if (!r.applied && r.reason !== "duplicate") throw new LedgerError(`event ${e.id}: ${r.reason}`);
    }
    return ledger;
  }

  get events(): readonly LedgerEvent[] {
    return this.log;
  }

  get state(): LedgerState {
    if (!this.cached) this.cached = reduceEvents(this.mode, this.startingEquityMils, this.log);
    return this.cached;
  }

  /** Append one event. Duplicate ids and invalid transitions are refused without mutating the log. */
  append(e: LedgerEvent): AppendResult {
    if (this.log.some((x) => x.id === e.id)) return { applied: false, reason: "duplicate" };
    try {
      reduceEvents(this.mode, this.startingEquityMils, [...this.log, e]);
    } catch (err) {
      if (err instanceof LedgerError) return { applied: false, reason: err.message };
      throw err;
    }
    this.log.push(e);
    this.cached = null;
    return { applied: true, reason: null };
  }

  appendAll(events: readonly LedgerEvent[]): AppendResult[] {
    return events.map((e) => this.append(e));
  }

  get activeCampaign(): Campaign | null {
    const id = this.state.activeCampaignId;
    return id ? (this.state.campaigns[id] ?? null) : null;
  }

  get campaigns(): Campaign[] {
    const s = this.state;
    return s.campaignOrder.map((id) => s.campaigns[id]!);
  }

  get equitySeries(): readonly AccountEquityPoint[] {
    return this.state.equitySeries;
  }

  /** Current marked equity: last series point, or starting equity before any event. */
  get equityMils(): Mils {
    const last = this.state.equitySeries[this.state.equitySeries.length - 1];
    return last ? last.equityMils : this.state.cashMils;
  }

  maxDrawdown(): Drawdown | null {
    return maxDrawdown(this.state.equitySeries, this.startingEquityMils);
  }

  stats(): LedgerStats {
    return computeStats(this.campaigns, this.mode);
  }

  statsByRoot(): Record<InstrumentRoot, RootStats> {
    const out = {} as Record<InstrumentRoot, RootStats>;
    for (const root of ["NQ", "ES", "RTY", "YM", "ZN", "GC"] as const) {
      out[root] = computeRootStats(this.campaigns.filter((c) => c.root === root));
    }
    return out;
  }
}

export interface Drawdown {
  /** Fraction of peak, e.g. 0.0021. */
  value: number;
  peakMils: Mils;
  troughMils: Mils;
  at: string;
  points: number;
}

/**
 * Max over the series of (peak - equity) / peak using marked equity (including open positions).
 * External cash flows shift the peak basis so deposits/withdrawals are not read as P&L.
 * Unavailable (null) when fewer than 2 scannable points exist, or when no account equity base exists
 * at the first scanned point (startingEquity + cumulative external cash flow <= 0, e.g. a manual
 * journal whose equity was never entered). Points with freshness "no-mark" are excluded from the
 * scan because they carry unrealized 0 silently.
 */
export function maxDrawdown(series: readonly AccountEquityPoint[], startingEquityMils: Mils): Drawdown | null {
  let cumulativeFlow = 0;
  const scanned: { point: AccountEquityPoint; base: number }[] = [];
  for (const p of series) {
    cumulativeFlow += p.externalCashFlowMils;
    if (p.freshness === "no-mark") continue;
    scanned.push({ point: p, base: startingEquityMils + cumulativeFlow });
  }
  if (scanned.length < 2) return null;
  if (scanned[0]!.base <= 0) return null;
  let peak: number | null = null;
  const first = scanned[0]!.point;
  let best: Drawdown = { value: 0, peakMils: first.equityMils, troughMils: first.equityMils, at: first.timestamp, points: scanned.length };
  for (const { point: p } of scanned) {
    if (peak === null) peak = p.equityMils;
    else peak = Math.max(peak + p.externalCashFlowMils, p.equityMils);
    if (peak <= 0) continue;
    const dd = (peak - p.equityMils) / peak;
    if (dd > best.value) best = { value: dd, peakMils: mils(peak), troughMils: p.equityMils, at: p.timestamp, points: scanned.length };
  }
  return best;
}

export interface RootStats {
  closedCount: number;
  netRealizedMils: Mils;
  /** Closed campaigns with positive net realized / closed count; null when n = 0. */
  winRate: { value: number; n: number } | null;
  meanR: { value: number; n: number } | null;
  totalFeesMils: Mils;
  exposureBars: number;
  deviationCount: number;
}

export interface LedgerStats extends RootStats {
  mode: Mode;
  openCount: number;
  pendingCount: number;
}

export function computeRootStats(campaigns: readonly Campaign[]): RootStats {
  const closed = campaigns.filter((c) => c.state === "CLOSED");
  const rs = closed.map(realizedR).filter((r): r is number => r !== null);
  let net = mils(0);
  let fees = mils(0);
  let exposure = 0;
  let deviations = 0;
  for (const c of campaigns) {
    if (c.state === "CANCELLED") continue;
    net = addMils(net, c.netRealizedMils);
    fees = addMils(fees, c.feesMils);
    exposure += c.exposureBars;
    deviations += c.deviationReasons.length;
  }
  return {
    closedCount: closed.length,
    netRealizedMils: net,
    winRate: closed.length ? { value: closed.filter((c) => c.netRealizedMils > 0).length / closed.length, n: closed.length } : null,
    meanR: rs.length ? { value: rs.reduce((s, r) => s + r, 0) / rs.length, n: rs.length } : null,
    totalFeesMils: fees,
    exposureBars: exposure,
    deviationCount: deviations,
  };
}

export function computeStats(campaigns: readonly Campaign[], mode: Mode): LedgerStats {
  return {
    mode,
    ...computeRootStats(campaigns),
    openCount: campaigns.filter((c) => c.state === "OPEN").length,
    pendingCount: campaigns.filter((c) => c.state === "PENDING").length,
  };
}

/** Em dash for statistics with no qualifying data. */
export const EM_DASH = "—";
