/**
 * Breadth adapters. A deterministic adapter owns A and H; nothing else may supply them.
 * ZN and GC have no researched breadth definition and return BREADTH_MODEL_UNDEFINED (D6).
 */
import type { BreadthResult, DataQualityReason } from "../formula/types";

export interface BreadthAdapter {
  readonly source: string;
  readonly definitionVersion: string;
  compute(input: BreadthInput): BreadthResult;
}

/** One point-in-time constituent's inputs for bar t. */
export interface ConstituentBar {
  id: string;
  /** Constituent volume on bar t; null when missing. */
  volumeT: number | null;
  /** Its own preceding volumes (excluding t); needs at least `volumeWindow` entries. */
  priorVolumes: readonly (number | null)[];
  closeT: number | null;
  closePrev: number | null;
}

export interface BreadthInput {
  /** Point-in-time membership size (survivor-bias-free). */
  universeCount: number;
  constituents: readonly ConstituentBar[];
  /** Preceding-volume window per constituent; default 20. */
  volumeWindow?: number;
  /** Required coverage of the point-in-time universe; default 0.95. */
  minCoverage?: number;
}

export const EQUITY_BREADTH_DEFINITION_VERSION = "equity-constituent-0.1";

function isFiniteNumber(x: number | null | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * A_t = (# valid constituents with volume_t > mean of their own preceding N volumes) / N_valid.
 * H_t = (# advancing - # declining) / N_valid; unchanged remain in the denominator.
 * Missing constituents are excluded and reported; they are never counted as unchanged.
 */
export class EquityConstituentAdapter implements BreadthAdapter {
  readonly source: string;
  readonly definitionVersion = EQUITY_BREADTH_DEFINITION_VERSION;

  constructor(source: string) {
    this.source = source;
  }

  compute(input: BreadthInput): BreadthResult {
    const window = input.volumeWindow ?? 20;
    const minCoverage = input.minCoverage ?? 0.95;
    const exclusions: { id: string; reason: string }[] = [];
    const reasons: DataQualityReason[] = [];

    let valid = 0;
    let aboveNormal = 0;
    let advancing = 0;
    let declining = 0;

    for (const c of input.constituents) {
      if (!isFiniteNumber(c.volumeT) || c.volumeT < 0) {
        exclusions.push({ id: c.id, reason: "missing or invalid current volume" });
        continue;
      }
      if (!isFiniteNumber(c.closeT) || !isFiniteNumber(c.closePrev) || c.closeT <= 0 || c.closePrev <= 0) {
        exclusions.push({ id: c.id, reason: "missing or invalid close prices" });
        continue;
      }
      const prior = c.priorVolumes.slice(-window);
      if (prior.length < window || !prior.every((v) => isFiniteNumber(v) && v >= 0)) {
        exclusions.push({ id: c.id, reason: `fewer than ${window} valid prior volumes` });
        continue;
      }
      const mean = (prior as number[]).reduce((s, v) => s + v, 0) / window;
      valid++;
      if (c.volumeT > mean) aboveNormal++;
      if (c.closeT > c.closePrev) advancing++;
      else if (c.closeT < c.closePrev) declining++;
    }

    const universe = input.universeCount;
    if (!Number.isInteger(universe) || universe <= 0) {
      reasons.push({ code: "COVERAGE_BELOW_95", detail: "point-in-time membership universe unknown" });
      return this.result(null, null, null, exclusions, null, null, reasons);
    }

    const coverage = valid / universe;
    if (coverage < minCoverage) {
      reasons.push({
        code: "COVERAGE_BELOW_95",
        detail: `coverage ${valid}/${universe} = ${(coverage * 100).toFixed(1)}% is below ${(minCoverage * 100).toFixed(0)}%`,
      });
      return this.result(coverage, valid, universe, exclusions, null, null, reasons);
    }

    const A = aboveNormal / valid;
    const H = (advancing - declining) / valid;
    if (!Number.isFinite(A) || !Number.isFinite(H)) {
      reasons.push({ code: "NONFINITE", detail: "breadth ratio is not finite" });
      return this.result(coverage, valid, universe, exclusions, null, null, reasons);
    }
    return this.result(coverage, valid, universe, exclusions, A, H, reasons);
  }

  private result(
    coverage: number | null,
    validCount: number | null,
    universeCount: number | null,
    exclusions: { id: string; reason: string }[],
    A: number | null,
    H: number | null,
    reasons: DataQualityReason[],
  ): BreadthResult {
    return {
      source: this.source,
      definitionVersion: this.definitionVersion,
      coverage,
      validCount,
      universeCount,
      exclusions,
      A,
      H,
      valid: reasons.length === 0 && A !== null && H !== null,
      reasons,
    };
  }
}

/** Placeholder for instruments without a researched breadth definition (ZN, GC). */
export class UndefinedBreadthAdapter implements BreadthAdapter {
  readonly source = "none";
  readonly definitionVersion = "undefined";

  constructor(private readonly root: string) {}

  compute(_input: BreadthInput): BreadthResult {
    return undefinedBreadth(this.root);
  }
}

export function undefinedBreadth(root: string): BreadthResult {
  return {
    source: "none",
    definitionVersion: "undefined",
    coverage: null,
    validCount: null,
    universeCount: null,
    exclusions: [],
    A: null,
    H: null,
    valid: false,
    reasons: [
      {
        code: "BREADTH_MODEL_UNDEFINED",
        detail: `No researched constituent breadth definition is configured for ${root}; A, H, u and S are not computed.`,
      },
    ],
  };
}
