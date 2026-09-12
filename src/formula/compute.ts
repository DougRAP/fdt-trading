/**
 * Pure formula functions, model v0.1. See CLAUDE_BUILD_BRIEF.md "Exact research formula".
 * Every numeric result and trade eligibility decision comes from here; nothing else may
 * invent, overwrite or approve missing inputs.
 */
import { modelConfig, type IntervalId, type InstrumentRoot, type ModelConfig } from "../config/modelConfig";
import type { Ticks } from "../numerics/ticks";
import type {
  BreadthResult,
  DataQualityReason,
  DataQualityWarning,
  DataSourceLabel,
  DisplaySide,
  QualificationChecks,
  RawInputs,
  Side,
  SideEligibility,
  SignalSnapshot,
  SnapshotStatus,
} from "./types";

export type Result<T> = { ok: true; value: T } | { ok: false; reason: DataQualityReason };

const fail = <T>(code: DataQualityReason["code"], detail: string): Result<T> => ({
  ok: false,
  reason: { code, detail },
});
const ok = <T>(value: T): Result<T> => ({ ok: true, value });

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** Q_t = V_t / mean(V_{t-N..t-1}); uses the last N prior volumes. */
export function computeQ(
  volumeT: number | null,
  priorVolumes: readonly (number | null)[],
  window: number = modelConfig.volumeWindow,
): Result<{ Q: number; baselineMean: number; count: number }> {
  const prior = priorVolumes.slice(-window);
  const validPrior = prior.filter((v): v is number => isFiniteNumber(v) && v >= 0);
  if (prior.length < window || validPrior.length < window) {
    return fail("INSUFFICIENT_VOLUME_HISTORY", `${validPrior.length}/${window} valid prior volumes`);
  }
  if (!isFiniteNumber(volumeT) || volumeT < 0) {
    return fail("NONFINITE", "current volume is missing or not finite");
  }
  const baselineMean = validPrior.reduce((s, v) => s + v, 0) / window;
  if (baselineMean <= 0) return fail("NONFINITE", "volume baseline mean is zero");
  const Q = volumeT / baselineMean;
  if (!Number.isFinite(Q)) return fail("NONFINITE", "Q is not finite");
  return ok({ Q, baselineMean, count: window });
}

/** A_t from a breadth adapter result. */
export function computeA(breadth: BreadthResult): Result<number> {
  const first = breadth.reasons[0];
  if (first) return { ok: false, reason: first };
  if (!breadth.valid || !isFiniteNumber(breadth.A)) return fail("NONFINITE", "A is not available");
  return ok(breadth.A);
}

/** H_t from a breadth adapter result. */
export function computeH(breadth: BreadthResult): Result<number> {
  const first = breadth.reasons[0];
  if (first) return { ok: false, reason: first };
  if (!breadth.valid || !isFiniteNumber(breadth.H)) return fail("NONFINITE", "H is not available");
  return ok(breadth.H);
}

/** u_t = Q_t / A_t. A = 0 is UNAVAILABLE, never patched with an epsilon. */
export function computeU(Q: number, A: number): Result<number> {
  if (!isFiniteNumber(Q) || !isFiniteNumber(A)) return fail("NONFINITE", "Q or A is not finite");
  if (A === 0) return fail("A_ZERO", "activity breadth A is 0; u = Q/A is undefined");
  const u = Q / A;
  if (!Number.isFinite(u)) return fail("NONFINITE", "u is not finite");
  return ok(u);
}

/** delta_t = x_t - x_{t-1}. */
export function computeDelta(current: number, previous: number | null, name: string): Result<number> {
  if (!isFiniteNumber(previous)) return fail("NONFINITE", `previous ${name} is missing or not finite`);
  const d = current - previous;
  if (!Number.isFinite(d)) return fail("NONFINITE", `delta ${name} is not finite`);
  return ok(d);
}

/**
 * Sample standard deviation (ddof=1) of exactly `window` preceding changes.
 * Requires the last `window` entries to all be valid (D7); no fallback.
 */
export function computeSigma(
  priorChanges: readonly (number | null)[],
  window: number = modelConfig.sigmaWindow,
): Result<{ sigma: number; count: number }> {
  const tail = priorChanges.slice(-window);
  const valid = tail.filter((v): v is number => isFiniteNumber(v));
  if (tail.length < window || valid.length < window) {
    return fail("INSUFFICIENT_SIGMA_HISTORY", `${valid.length}/${window} valid prior changes`);
  }
  // Identical changes have zero sample SD by definition; test exactly rather than via float noise.
  if (Math.max(...valid) === Math.min(...valid)) {
    return fail("ZERO_SIGMA", `sample SD of the ${window} prior changes is 0 (all changes identical)`);
  }
  const mean = valid.reduce((s, v) => s + v, 0) / window;
  const ss = valid.reduce((s, v) => s + (v - mean) * (v - mean), 0);
  const sigma = Math.sqrt(ss / (window - 1));
  if (!Number.isFinite(sigma)) return fail("NONFINITE", "sigma is not finite");
  if (sigma === 0) return fail("ZERO_SIGMA", `sample SD of the ${window} prior changes is 0`);
  return ok({ sigma, count: window });
}

export interface BothSides {
  v: number;
  p: { long: number; short: number };
  S: { long: number; short: number };
}

/** v = deltaU/sigmaDeltaU; p_d = d x deltaH/sigmaDeltaH; S_d = min(v, p_d). */
export function scoreBothSides(deltaU: number, sigmaDeltaU: number, deltaH: number, sigmaDeltaH: number): Result<BothSides> {
  if (![deltaU, sigmaDeltaU, deltaH, sigmaDeltaH].every(isFiniteNumber)) {
    return fail("NONFINITE", "score inputs are not finite");
  }
  if (sigmaDeltaU === 0 || sigmaDeltaH === 0) return fail("ZERO_SIGMA", "sigma is 0");
  const v = deltaU / sigmaDeltaU;
  const pLong = deltaH / sigmaDeltaH;
  const pShort = -deltaH / sigmaDeltaH;
  const out: BothSides = {
    v,
    p: { long: pLong, short: pShort },
    S: { long: Math.min(v, pLong), short: Math.min(v, pShort) },
  };
  if (![v, pLong, pShort].every(Number.isFinite)) return fail("NONFINITE", "score is not finite");
  return ok(out);
}

export interface QualifyInput {
  side: Side;
  S: number | null;
  H: number | null;
  closeT: Ticks | null;
  closePrev: Ticks | null;
  inputsValid: boolean;
}

/** Entry qualification for one side. Null S/H/close => the check is null and fails. */
export function qualify(input: QualifyInput, cfg: ModelConfig = modelConfig): SideEligibility {
  const { side, S, H, closeT, closePrev } = input;
  const checks: QualificationChecks = {
    scoreAboveThreshold: isFiniteNumber(S) ? S > cfg.entryThreshold : null,
    breadthDirection: isFiniteNumber(H) ? side * H >= cfg.breadthThreshold : null,
    priceConfirmation:
      closeT !== null && closePrev !== null ? side * (closeT - closePrev) > 0 : null,
    inputsValid: input.inputsValid,
  };
  const failed = (Object.keys(checks) as (keyof QualificationChecks)[]).filter((k) => checks[k] !== true);
  return { side, S, checks, qualifies: failed.length === 0, failed };
}

/** Inputs to build a snapshot from histories (D1: pure functions compute from full histories). */
export interface SignalHistories {
  root: InstrumentRoot;
  barEnd: string;
  availableAt: string;
  interval: IntervalId;
  dataSource: DataSourceLabel;
  volumeT: number | null;
  /** Preceding volumes, oldest first; at least volumeWindow entries. */
  priorVolumes: readonly (number | null)[];
  closeT: Ticks | null;
  closePrev: Ticks | null;
  breadth: BreadthResult;
  /** Previous bar's derived values (from the prior snapshot). */
  uPrev: number | null;
  HPrev: number | null;
  /** Preceding changes, oldest first, excluding the current change; at least sigmaWindow entries. */
  priorDeltaU: readonly (number | null)[];
  priorDeltaH: readonly (number | null)[];
  /** Freshness verdict from the data adapter. */
  freshness: { fresh: boolean; detail?: string };
  /** ATR20 in ticks, computed by the stop module; passed through. */
  atr20Ticks?: Ticks | null;
  inputSourceIds: readonly string[];
}

function validPrice(t: Ticks | null): boolean {
  return t !== null && Number.isSafeInteger(t) && t > 0;
}

/** Build a complete SignalSnapshot. Never throws on bad data; reports reasons instead. */
export function buildSignalSnapshot(h: SignalHistories, cfg: ModelConfig = modelConfig): SignalSnapshot {
  const reasons: DataQualityReason[] = [];
  const warnings: DataQualityWarning[] = [];
  const addReason = (r: DataQualityReason) => {
    if (!reasons.some((x) => x.code === r.code && x.detail === r.detail)) reasons.push(r);
  };

  if (!h.freshness.fresh) addReason({ code: "STALE", detail: h.freshness.detail ?? "source data is stale or misaligned" });

  const priceOk = validPrice(h.closeT) && validPrice(h.closePrev);
  if (!priceOk) addReason({ code: "INVALID_PRICE", detail: "close_t or close_{t-1} is missing or not a positive tick count" });

  // Q is computed whenever volume history allows, even if breadth is undefined (D6).
  const qRes = computeQ(h.volumeT, h.priorVolumes, cfg.volumeWindow);
  if (!qRes.ok) addReason(qRes.reason);
  const Q = qRes.ok ? qRes.value.Q : null;

  const aRes = computeA(h.breadth);
  const hRes = computeH(h.breadth);
  if (!aRes.ok) addReason(aRes.reason);
  else if (!hRes.ok) addReason(hRes.reason);
  const A = aRes.ok ? aRes.value : null;
  const H = hRes.ok ? hRes.value : null;

  if (A !== null && A > 0 && A < cfg.aSmallWarn.value) {
    warnings.push({ code: "A_SMALL", detail: `A = ${A.toFixed(3)} is below ${cfg.aSmallWarn.value}; u = Q/A may be unstable` });
  }

  let u: number | null = null;
  if (Q !== null && A !== null) {
    const uRes = computeU(Q, A);
    if (uRes.ok) u = uRes.value;
    else addReason(uRes.reason);
  }

  let deltaU: number | null = null;
  if (u !== null) {
    const r = computeDelta(u, h.uPrev, "u");
    if (r.ok) deltaU = r.value;
    else addReason(r.reason);
  }
  let deltaH: number | null = null;
  if (H !== null) {
    const r = computeDelta(H, h.HPrev, "H");
    if (r.ok) deltaH = r.value;
    else addReason(r.reason);
  }

  const sigU = computeSigma(h.priorDeltaU, cfg.sigmaWindow);
  const sigH = computeSigma(h.priorDeltaH, cfg.sigmaWindow);
  // Sigma history problems are only decisive when breadth is defined; keep reasons specific.
  if (A !== null) {
    if (!sigU.ok) addReason({ ...sigU.reason, detail: `deltaU: ${sigU.reason.detail}` });
    if (!sigH.ok) addReason({ ...sigH.reason, detail: `deltaH: ${sigH.reason.detail}` });
  }
  const sigmaDeltaU = sigU.ok ? sigU.value.sigma : null;
  const sigmaDeltaH = sigH.ok ? sigH.value.sigma : null;

  let scores: BothSides | null = null;
  if (deltaU !== null && deltaH !== null && sigmaDeltaU !== null && sigmaDeltaH !== null) {
    const r = scoreBothSides(deltaU, sigmaDeltaU, deltaH, sigmaDeltaH);
    if (r.ok) scores = r.value;
    else addReason(r.reason);
  }

  const raw: RawInputs = {
    volumeT: h.volumeT,
    volumeBaselineMean: qRes.ok ? qRes.value.baselineMean : null,
    volumeBaselineCount: qRes.ok ? qRes.value.count : 0,
    closeT: h.closeT,
    closePrev: h.closePrev,
    uPrev: h.uPrev,
    HPrev: h.HPrev,
    sigmaDeltaUCount: sigU.ok ? sigU.value.count : 0,
    sigmaDeltaHCount: sigH.ok ? sigH.value.count : 0,
    atr20Ticks: h.atr20Ticks ?? null,
  };

  return assemble({
    root: h.root,
    barEnd: h.barEnd,
    availableAt: h.availableAt,
    interval: h.interval,
    dataSource: h.dataSource,
    raw,
    breadth: h.breadth,
    Q,
    A,
    H,
    u,
    deltaU,
    deltaH,
    sigmaDeltaU,
    sigmaDeltaH,
    scores,
    reasons,
    warnings,
    inputSourceIds: [...h.inputSourceIds],
    cfg,
  });
}

export interface AssembleInput {
  root: InstrumentRoot;
  barEnd: string;
  availableAt: string;
  interval: IntervalId;
  dataSource: DataSourceLabel;
  raw: RawInputs;
  breadth: BreadthResult;
  Q: number | null;
  A: number | null;
  H: number | null;
  u: number | null;
  deltaU: number | null;
  deltaH: number | null;
  sigmaDeltaU: number | null;
  sigmaDeltaH: number | null;
  scores: BothSides | null;
  reasons: DataQualityReason[];
  warnings: DataQualityWarning[];
  inputSourceIds: string[];
  cfg: ModelConfig;
}

/**
 * Final assembly shared by the history pipeline and the fixture snapshot bypass (D1):
 * eligibility for both sides, displayed side (D8), status and data quality.
 */
export function assemble(a: AssembleInput): SignalSnapshot {
  const available = a.reasons.length === 0 && a.scores !== null;
  const inputsValid = available;
  const S = a.scores ? a.scores.S : { long: null, short: null };
  const p = a.scores ? a.scores.p : { long: null, short: null };

  const long = qualify(
    { side: 1, S: S.long, H: a.H, closeT: a.raw.closeT, closePrev: a.raw.closePrev, inputsValid },
    a.cfg,
  );
  const short = qualify(
    { side: -1, S: S.short, H: a.H, closeT: a.raw.closeT, closePrev: a.raw.closePrev, inputsValid },
    a.cfg,
  );

  let qualifiedSide: Side | null = null;
  if (long.qualifies) qualifiedSide = 1;
  else if (short.qualifies) qualifiedSide = -1;

  let displaySide: DisplaySide | null = null;
  let displayScore: number | null = null;
  let status: SnapshotStatus;
  if (!available) {
    status = "UNAVAILABLE";
  } else if (qualifiedSide === 1) {
    status = "QUALIFIED";
    displaySide = "long";
    displayScore = S.long;
  } else if (qualifiedSide === -1) {
    status = "QUALIFIED";
    displaySide = "short";
    displayScore = S.short;
  } else if (a.H !== null && a.H > 0) {
    status = "WAIT";
    displaySide = "long";
    displayScore = S.long;
  } else if (a.H !== null && a.H < 0) {
    status = "WAIT";
    displaySide = "short";
    displayScore = S.short;
  } else {
    status = "NEUTRAL";
    displaySide = "neutral";
    displayScore = null;
  }

  return {
    root: a.root,
    barEnd: a.barEnd,
    availableAt: a.availableAt,
    interval: a.interval,
    modelVersion: a.cfg.version,
    dataSource: a.dataSource,
    raw: a.raw,
    breadth: a.breadth,
    Q: a.Q,
    A: a.A,
    H: a.H,
    u: a.u,
    deltaU: a.deltaU,
    deltaH: a.deltaH,
    sigmaDeltaU: a.sigmaDeltaU,
    sigmaDeltaH: a.sigmaDeltaH,
    v: a.scores ? a.scores.v : null,
    p,
    S,
    displaySide,
    displayScore,
    eligibility: { long, short },
    qualifiedSide,
    status,
    dataQuality: { available, reasons: a.reasons, warnings: a.warnings },
    inputSourceIds: a.inputSourceIds,
  };
}
