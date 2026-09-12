/** Display formatting only. Never feed results back into price/money math. */
import type { InstrumentRoot } from "../config/modelConfig";
import { INSTRUMENTS } from "../instruments/metadata";
import { EM_DASH } from "../ledger/ledger";
import { formatMils, type Mils } from "../numerics/money";
import { fromTicks, type Ticks } from "../numerics/ticks";

export { EM_DASH };

export function fmtPrice(t: Ticks | number | null | undefined, root: InstrumentRoot): string {
  if (t === null || t === undefined || !Number.isFinite(t)) return EM_DASH;
  if (!Number.isSafeInteger(t)) return Number(fromTicks(Math.round(t) as Ticks, INSTRUMENTS[root].tick)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  return fromTicks(t as Ticks, INSTRUMENTS[root].tick);
}

export function fmtPoints(ticks: Ticks | null, root: InstrumentRoot): string {
  if (ticks === null) return EM_DASH;
  return `${fromTicks(ticks, INSTRUMENTS[root].tick)} pts (${ticks} ticks)`;
}

export function fmtMoney(m: Mils | null | undefined, signed = false): string {
  if (m === null || m === undefined) return EM_DASH;
  return formatMils(m, { signed });
}

export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return EM_DASH;
  return n.toFixed(digits);
}

export function fmtPct(fraction: number | null | undefined, digits = 3): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return EM_DASH;
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  return iso.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, "Z");
}

export function sideText(side: 1 | -1 | null | undefined): string {
  return side === 1 ? "Buy / long" : side === -1 ? "Sell / short" : EM_DASH;
}
