/**
 * Prices as integer ticks (D14). No floats in price paths.
 * A tick size is an exact rational (numerator/denominator points), e.g. 1/4, 1/10, 1/64.
 */

declare const ticksBrand: unique symbol;
/** Integer count of ticks. Branded to keep raw numbers out of price paths. */
export type Ticks = number & { readonly [ticksBrand]: true };

export interface TickSize {
  /** Points per tick, numerator. */
  readonly numerator: number;
  /** Points per tick, denominator. */
  readonly denominator: number;
}

export type RoundingMode = "floor" | "ceil" | "exact";

export class NumericError extends Error {
  override readonly name = "NumericError";
}

export class NotImplementedError extends Error {
  override readonly name = "NotImplementedError";
}

function assertSafeInt(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) throw new NumericError(`${what} must be a safe integer, got ${String(n)}`);
}

export function tickSize(numerator: number, denominator: number): TickSize {
  assertSafeInt(numerator, "tick numerator");
  assertSafeInt(denominator, "tick denominator");
  if (numerator <= 0 || denominator <= 0) throw new NumericError("tick size must be positive");
  return { numerator, denominator };
}

/** Brand an integer as Ticks. Throws on non-integers or nonfinite values. */
export function ticks(n: number): Ticks {
  assertSafeInt(n, "ticks");
  return n as Ticks;
}

export function addTicks(a: Ticks, b: Ticks): Ticks {
  return ticks(a + b);
}

export function subTicks(a: Ticks, b: Ticks): Ticks {
  return ticks(a - b);
}

export function absTicks(a: Ticks): Ticks {
  return ticks(Math.abs(a));
}

/** Parse a decimal string like "-2100.1" into an exact scaled integer. */
function parseDecimal(text: string): { unscaled: bigint; scale: number } {
  const m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new NumericError(`invalid decimal literal: ${JSON.stringify(text)}`);
  const sign = m[1] === "-" ? -1n : 1n;
  const intPart = m[2] ?? "0";
  const fracPart = m[3] ?? "";
  return { unscaled: sign * BigInt(intPart + fracPart), scale: fracPart.length };
}

function priceToText(price: number | string): string {
  if (typeof price === "string") return price;
  if (!Number.isFinite(price)) throw new NumericError(`price must be finite, got ${String(price)}`);
  // Shortest round-trip representation; realistic prices never use exponent notation.
  const text = price.toString();
  if (/e/i.test(text)) throw new NumericError(`price ${text} out of supported range`);
  return text;
}

/**
 * Convert a decimal price (string preferred; number accepted) to integer ticks.
 * "floor"/"ceil" round toward -inf/+inf on the tick grid; "exact" throws if off-grid.
 */
export function toTicks(price: number | string, tick: TickSize, mode: RoundingMode): Ticks {
  const { unscaled, scale } = parseDecimal(priceToText(price));
  // ticks = price / (num/den) = unscaled * den / (num * 10^scale)
  const numer = unscaled * BigInt(tick.denominator);
  const denom = BigInt(tick.numerator) * 10n ** BigInt(scale);
  let q = numer / denom; // truncates toward zero
  const r = numer % denom;
  if (r !== 0n) {
    if (mode === "exact") throw new NumericError(`price ${priceToText(price)} is not on the tick grid`);
    const negative = numer < 0n;
    if (mode === "floor" && negative) q -= 1n;
    if (mode === "ceil" && !negative) q += 1n;
  }
  const n = Number(q);
  assertSafeInt(n, "ticks");
  return n as Ticks;
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/** Number of decimal places needed to print a tick size exactly (e.g. 1/4 -> 2, 1/64 -> 6). */
export function decimalPlaces(tick: TickSize): number {
  // Reduce the fraction, then require the denominator to be of the form 2^a 5^b.
  const g = gcd(tick.numerator, tick.denominator);
  let d = tick.denominator / g;
  let twos = 0;
  let fives = 0;
  while (d % 2 === 0) {
    d /= 2;
    twos++;
  }
  while (d % 5 === 0) {
    d /= 5;
    fives++;
  }
  if (d !== 1) throw new NumericError(`tick ${tick.numerator}/${tick.denominator} has no finite decimal form`);
  return Math.max(twos, fives);
}

/** Exact decimal string for a tick count, e.g. 88001 ticks at 1/4 -> "22000.25". */
export function fromTicks(t: Ticks, tick: TickSize): string {
  const places = decimalPlaces(tick);
  const scale = 10n ** BigInt(places);
  // value = t * num / den, exact in `places` decimals by construction.
  const scaled = (BigInt(t) * BigInt(tick.numerator) * scale) / BigInt(tick.denominator);
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const intPart = abs / scale;
  const fracPart = abs % scale;
  const frac = places > 0 ? "." + fracPart.toString().padStart(places, "0") : "";
  return `${negative ? "-" : ""}${intPart.toString()}${frac}`;
}

/** Display-only conversion. Never feed the result back into price or money math. */
export function ticksToDisplayNumber(t: Ticks, tick: TickSize): number {
  return Number(fromTicks(t, tick));
}

/** Points represented by a tick count, as an exact decimal string. */
export function ticksToPoints(t: Ticks, tick: TickSize): string {
  return fromTicks(t, tick);
}
