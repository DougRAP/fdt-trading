/**
 * Stop model v0.1 (brief "Stop model", D2, D3, D14).
 * - SMA ATR20: arithmetic mean of the 20 true ranges t-19..t inclusive; the first TR uses close t-20.
 *   Explicitly NOT Wilder smoothing.
 * - D_t = ATR20_t x [stopBase + max(0, d x H_t)]; provisional coefficient.
 * - Long stop rounds down, short stop rounds up, to the tick grid; the ratchet never widens.
 * - A stop is effective only after its calculation timestamp.
 * Prices are integer Ticks. D is a distance in ticks derived from a float coefficient; it is
 * quantized to 1e-6 tick (round to nearest) before grid rounding so that binary float noise
 * at the 1e-14 level cannot move a stop by a tick. That is a stated precision policy, not an
 * epsilon in a denominator.
 */
import { modelConfig, type ModelConfig } from "../config/modelConfig";
import type { Side } from "../formula/types";
import { ticks, type Ticks } from "../numerics/ticks";

export type StopReasonCode = "DATA_STALE" | "INSUFFICIENT_ATR_HISTORY" | "NONFINITE" | "INVALID_PRICE";

export interface StopReason {
  code: StopReasonCode;
  detail: string;
}

export type StopResult<T> = { ok: true; value: T } | { ok: false; reason: StopReason };

const fail = <T>(code: StopReasonCode, detail: string): StopResult<T> => ({ ok: false, reason: { code, detail } });
const ok = <T>(value: T): StopResult<T> => ({ ok: true, value });

/** Completed OHLC bar. availableAt is when its close was known to the decision process. */
export interface OhlcBar {
  barEnd: string;
  availableAt: string;
  open: Ticks;
  high: Ticks;
  low: Ticks;
  close: Ticks;
}

const MICRO = 1_000_000;

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function validTicks(t: Ticks | null | undefined): t is Ticks {
  return t !== null && t !== undefined && Number.isSafeInteger(t);
}

/** TR = max(high - low, |high - prevClose|, |low - prevClose|), in ticks. */
export function trueRange(high: Ticks, low: Ticks, prevClose: Ticks): Ticks {
  return ticks(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
}

export interface SmaAtr {
  /** ATR in ticks; may be fractional (mean of integers). */
  atrTicks: number;
  /** Sum of the window's true ranges, exact. */
  sumTrTicks: Ticks;
  window: number;
  method: "SMA";
}

/**
 * SMA ATR over the last `window` bars of `bars` (oldest first). Needs window + 1 bars because
 * the first true range uses the close of the bar before the window (D2).
 */
export function smaAtr(bars: readonly OhlcBar[], window: number = modelConfig.atrWindow): StopResult<SmaAtr> {
  if (bars.length < window + 1) {
    return fail("INSUFFICIENT_ATR_HISTORY", `${bars.length}/${window + 1} bars available for SMA ATR${window}`);
  }
  const slice = bars.slice(-(window + 1));
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    const bar = slice[i]!;
    const prev = slice[i - 1]!;
    if (![bar.high, bar.low, bar.close, prev.close].every(validTicks) || bar.high < bar.low) {
      return fail("INVALID_PRICE", `bar ending ${bar.barEnd} has invalid high/low/close`);
    }
    sum += trueRange(bar.high, bar.low, prev.close);
  }
  return ok({ atrTicks: sum / window, sumTrTicks: ticks(sum), window, method: "SMA" });
}

export interface StopDistance {
  /** D in ticks, quantized to 1e-6 tick. */
  dTicks: number;
  /** stopBase + max(0, d x H). */
  coefficient: number;
  atrTicks: number;
  H: number;
  side: Side;
}

/** D_t = ATR20_t x [stopBase + max(0, d x H_t)]. Missing ATR or H => DATA_STALE. */
export function stopDistance(
  atrTicks: number | null,
  H: number | null,
  side: Side,
  cfg: ModelConfig = modelConfig,
): StopResult<StopDistance> {
  if (!isFiniteNumber(atrTicks)) return fail("DATA_STALE", "ATR20 is missing or not finite");
  if (!isFiniteNumber(H)) return fail("DATA_STALE", "current directional breadth H is missing or not finite");
  if (atrTicks < 0) return fail("NONFINITE", "ATR20 is negative");
  const coefficient = cfg.stopBase + Math.max(0, side * H);
  const dMicro = Math.round(atrTicks * coefficient * MICRO);
  if (!Number.isSafeInteger(dMicro)) return fail("NONFINITE", "stop distance is not finite");
  return ok({ dTicks: dMicro / MICRO, coefficient, atrTicks, H, side });
}

/** Long: floor(reference - D). Short: ceil(reference + D). Exact via micro-tick integers. */
function roundedStop(reference: Ticks, dTicks: number, side: Side): Ticks {
  const dMicro = Math.round(dTicks * MICRO);
  const refMicro = reference * MICRO;
  if (side === 1) return ticks(Math.floor((refMicro - dMicro) / MICRO));
  return ticks(Math.ceil((refMicro + dMicro) / MICRO));
}

export type StopSource = "initial" | "trail" | "frozen";

/** A stop level with the timestamp after which it is effective. */
export interface StopState {
  side: Side;
  stop: Ticks;
  /** ISO timestamp; the stop applies only to observations after this instant. */
  effectiveAfter: string;
  calculatedAt: string;
  source: StopSource;
  basis: {
    referenceClose: Ticks;
    dTicks: number | null;
    atrTicks: number | null;
    H: number | null;
  };
  /** Present when the stop was frozen because inputs were missing. */
  reason?: StopReason;
}

/** Initial stop at entry fill E using the decision snapshot's D: long E - D, short E + D. */
export function initialStop(input: {
  side: Side;
  entryFill: Ticks;
  distance: StopDistance;
  /** Decision snapshot availableAt; the entry stop is effective from the fill onward. */
  calculatedAt: string;
}): StopState {
  const stop = roundedStop(input.entryFill, input.distance.dTicks, input.side);
  return {
    side: input.side,
    stop,
    effectiveAfter: input.calculatedAt,
    calculatedAt: input.calculatedAt,
    source: "initial",
    basis: {
      referenceClose: input.entryFill,
      dTicks: input.distance.dTicks,
      atrTicks: input.distance.atrTicks,
      H: input.distance.H,
    },
  };
}

export interface TrailInput {
  previous: StopState;
  /** Highest completed close since entry (long) or lowest (short). */
  extremeClose: Ticks;
  /** Current bar's SMA ATR20 in ticks; null when unavailable. */
  atrTicks: number | null;
  /** Current bar's H; null when breadth is unavailable. */
  H: number | null;
  /** availableAt of the bar whose close produced this recalculation. */
  calculatedAt: string;
  cfg?: ModelConfig;
}

export interface TrailOutput {
  state: StopState;
  /** True when the stop moved (tightened). */
  changed: boolean;
  /** Unrounded candidate before ratchet, for details display. */
  candidate: Ticks | null;
}

/**
 * Trailing ratchet (D3): long = max(old, highestClose - D); short = min(old, lowestClose + D).
 * Rounding happens before the ratchet comparison, so it can never widen a ratcheted stop.
 * Missing ATR or H => previous stop kept unchanged with reason DATA_STALE.
 */
export function trailStop(input: TrailInput): TrailOutput {
  const { previous, extremeClose, calculatedAt } = input;
  const side = previous.side;
  const dist = stopDistance(input.atrTicks, input.H, side, input.cfg);
  if (!dist.ok) {
    return {
      state: {
        ...previous,
        source: "frozen",
        calculatedAt,
        basis: { referenceClose: extremeClose, dTicks: null, atrTicks: input.atrTicks, H: input.H },
        reason: dist.reason,
      },
      changed: false,
      candidate: null,
    };
  }
  const candidate = roundedStop(extremeClose, dist.value.dTicks, side);
  const stop = side === 1 ? ticks(Math.max(previous.stop, candidate)) : ticks(Math.min(previous.stop, candidate));
  const changed = stop !== previous.stop;
  return {
    state: {
      side,
      stop,
      effectiveAfter: changed ? calculatedAt : previous.effectiveAfter,
      calculatedAt,
      source: changed ? "trail" : previous.source === "frozen" ? "trail" : previous.source,
      basis: { referenceClose: extremeClose, dTicks: dist.value.dTicks, atrTicks: dist.value.atrTicks, H: dist.value.H },
    },
    changed,
    candidate,
  };
}

function instant(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new Error(`invalid ISO timestamp: ${iso}`);
  return t;
}

/**
 * A stop applies to a bar only if the bar completed strictly after the stop's effectiveAfter.
 * A stop computed from bar t's close (effectiveAfter = bar t availableAt) is therefore never
 * tested against bar t's own low/high.
 */
export function stopAppliesToBar(stop: StopState, bar: Pick<OhlcBar, "barEnd">): boolean {
  return instant(bar.barEnd) > instant(stop.effectiveAfter);
}

export interface ExecutableQuote {
  bid: Ticks;
  ask: Ticks;
  observedAt: string;
}

/**
 * True when the proposed stop is already beyond the executable market: long stop >= bid,
 * short stop <= ask. The caller must exit at the next executable observation and must not
 * claim a fill at the obsolete stop price.
 */
export function closeRequired(stop: StopState, quote: ExecutableQuote): { required: boolean; detail: string } {
  if (stop.side === 1) {
    const required = stop.stop >= quote.bid;
    return { required, detail: required ? `long stop ${stop.stop} >= bid ${quote.bid}` : "long stop below bid" };
  }
  const required = stop.stop <= quote.ask;
  return { required, detail: required ? `short stop ${stop.stop} <= ask ${quote.ask}` : "short stop above ask" };
}
