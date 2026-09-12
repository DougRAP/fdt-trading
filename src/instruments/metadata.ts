/**
 * Instrument metadata (fixture). Production requires verified metadata with exact dated
 * contracts, expiry, calendars, roll rules and supported order types (see brief).
 */
import type { InstrumentRoot } from "../config/modelConfig";
import { NotImplementedError, tickSize, type TickSize, type Ticks } from "../numerics/ticks";
import { mils, type Mils } from "../numerics/money";

export type QuoteFormat = "decimal" | "32nds";

export interface InstrumentMetadata {
  root: InstrumentRoot;
  name: string;
  /** Intended coverage in the research hypothesis; not a guarantee of behavior. */
  coverage: string;
  /** Dated contract in production; fixtures are labeled synthetic (D15). */
  contract: string;
  exchange: string;
  currency: "USD";
  tick: TickSize;
  /** Dollar value of one full point per contract. */
  multiplier: number;
  /** Dollar value of one tick per contract, in mils (exact). */
  tickValueMils: Mils;
  /** ISO date in production; null for synthetic fixtures. */
  expiry: string | null;
  calendar: string;
  quoteFormat: QuoteFormat;
  metadataSource: "fixture";
  metadataVersion: string;
}

const FIXTURE_VERSION = "fixture-0.1";
const CALENDAR = "Fixture calendar (not an exchange calendar)";

function make(
  root: InstrumentRoot,
  name: string,
  coverage: string,
  exchange: string,
  tick: TickSize,
  multiplier: number,
  tickValueMils: number,
  quoteFormat: QuoteFormat,
): InstrumentMetadata {
  return {
    root,
    name,
    coverage,
    contract: `${root} · SYNTHETIC`,
    exchange,
    currency: "USD",
    tick,
    multiplier,
    tickValueMils: mils(tickValueMils),
    expiry: null,
    calendar: CALENDAR,
    quoteFormat,
    metadataSource: "fixture",
    metadataVersion: FIXTURE_VERSION,
  };
}

export const INSTRUMENTS: Readonly<Record<InstrumentRoot, InstrumentMetadata>> = Object.freeze({
  NQ: make("NQ", "E-mini Nasdaq-100", "Growth and technology demand", "CME", tickSize(1, 4), 20, 5000, "decimal"),
  ES: make("ES", "E-mini S&P 500", "Broad corporate profits", "CME", tickSize(1, 4), 50, 12500, "decimal"),
  RTY: make("RTY", "E-mini Russell 2000", "Small-cap growth", "CME", tickSize(1, 10), 50, 5000, "decimal"),
  YM: make("YM", "E-mini Dow", "Established blue-chip businesses", "CBOT", tickSize(1, 1), 5, 5000, "decimal"),
  ZN: make("ZN", "10-year Treasury note", "Government debt / duration", "CBOT", tickSize(1, 64), 1000, 15625, "32nds"),
  GC: make("GC", "Gold", "Monetary / geopolitical demand", "COMEX", tickSize(1, 10), 100, 10000, "decimal"),
});

export const INSTRUMENT_LIST: readonly InstrumentMetadata[] = Object.freeze(
  (["NQ", "ES", "RTY", "YM", "ZN", "GC"] as const).map((r) => INSTRUMENTS[r]),
);

export function getInstrument(root: InstrumentRoot): InstrumentMetadata {
  return INSTRUMENTS[root];
}

/**
 * Treasury fractional quotation (e.g. 110'165 = 110 + 16.5/32). Label only in v1.
 * The parser/formatter is intentionally unimplemented; callers must not fall back to decimals silently.
 */
export function parse32nds(_text: string, _tick: TickSize): Ticks {
  throw new NotImplementedError("32nds quote parser not implemented (ZN label only in v1)");
}

export function format32nds(_t: Ticks, _tick: TickSize): string {
  throw new NotImplementedError("32nds quote formatter not implemented (ZN label only in v1)");
}
