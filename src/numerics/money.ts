/**
 * Money as integer mils (1/1000 USD) (D14). $1.00 = 1000 mils.
 * ZN tick value $15.625 = 15625 mils stays exact.
 */
import { NumericError, type Ticks } from "./ticks";

declare const milsBrand: unique symbol;
export type Mils = number & { readonly [milsBrand]: true };

function assertSafeInt(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) throw new NumericError(`${what} must be a safe integer, got ${String(n)}`);
}

/** Brand an integer as Mils. */
export function mils(n: number): Mils {
  assertSafeInt(n, "mils");
  return n as Mils;
}

export const ZERO_MILS: Mils = 0 as Mils;

export function addMils(a: Mils, b: Mils): Mils {
  return mils(a + b);
}

export function subMils(a: Mils, b: Mils): Mils {
  return mils(a - b);
}

export function negMils(a: Mils): Mils {
  return mils(-a);
}

export function absMils(a: Mils): Mils {
  return mils(Math.abs(a));
}

/** Multiply money by an integer count (contracts, sides). */
export function mulMilsInt(a: Mils, count: number): Mils {
  assertSafeInt(count, "count");
  return mils(a * count);
}

export function sumMils(values: readonly Mils[]): Mils {
  let total = 0;
  for (const v of values) total += v;
  return mils(total);
}

export function compareMils(a: Mils, b: Mils): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dollarsToText(n: number): string {
  if (!Number.isFinite(n)) throw new NumericError(`dollar amount must be finite, got ${String(n)}`);
  const text = n.toString();
  if (/e/i.test(text)) throw new NumericError(`dollar amount ${text} out of supported range`);
  return text;
}

/**
 * Parse a dollar amount ("2.50", "-1060", 12.5) into mils exactly.
 * More than 3 decimal places is rejected rather than rounded.
 */
export function dollarsToMils(dollars: number | string): Mils {
  const text = typeof dollars === "string" ? dollars.trim() : dollarsToText(dollars);
  const m = /^([+-])?(\d+)(?:\.(\d{0,3}))?$/.exec(text);
  if (!m) throw new NumericError(`invalid dollar amount: ${JSON.stringify(text)}`);
  const sign = m[1] === "-" ? -1 : 1;
  const intPart = Number(m[2] ?? "0");
  const frac = (m[3] ?? "").padEnd(3, "0");
  return mils(sign * (intPart * 1000 + Number(frac)));
}

/**
 * Convert a signed tick distance into money: ticks x tick value (mils) x contracts.
 * The instrument's tick value in mils already embeds the dollar multiplier.
 */
export function ticksToMils(t: Ticks, tickValueMils: Mils, contracts = 1): Mils {
  assertSafeInt(contracts, "contracts");
  return mils(t * tickValueMils * contracts);
}

/** Integer floor division of nonnegative money; used for sizing: floor(budget / perContractRisk). */
export function floorDivMils(numerator: Mils, denominator: Mils): number {
  if (denominator <= 0) throw new NumericError("floorDivMils: denominator must be positive");
  if (numerator < 0) throw new NumericError("floorDivMils: numerator must be nonnegative");
  return Math.floor(numerator / denominator);
}

/** Round mils to whole cents, half away from zero. Display only. */
export function milsToCents(m: Mils): number {
  const sign = m < 0 ? -1 : 1;
  const abs = Math.abs(m);
  return sign * Math.floor((abs + 5) / 10);
}

/** Exact decimal dollars string with 3 places, e.g. 15625 -> "15.625". */
export function milsToDollarsExact(m: Mils): string {
  const sign = m < 0 ? "-" : "";
  const abs = Math.abs(m);
  const intPart = Math.floor(abs / 1000);
  const frac = String(abs % 1000).padStart(3, "0");
  return `${sign}${intPart}.${frac}`;
}

/** Display string rounded to cents: 1060000 -> "$1,060.00"; -5000 -> "-$5.00". */
export function formatMils(m: Mils, options: { signed?: boolean } = {}): string {
  const cents = milsToCents(m);
  const sign = cents < 0 ? "-" : options.signed && cents > 0 ? "+" : "";
  const abs = Math.abs(cents);
  const intPart = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}$${intPart}.${frac}`;
}
