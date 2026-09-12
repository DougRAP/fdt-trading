/**
 * Modeled fills, per-contract stop risk and position sizing (brief, D4, D5, D9, D14).
 * Stops and risk budgets are planned losses, not guaranteed maximum losses.
 */
import { modelConfig, type CostFixture, type ModelConfig } from "../config/modelConfig";
import type { Side } from "../formula/types";
import { addMils, floorDivMils, mils, mulMilsInt, ticksToMils, type Mils } from "../numerics/money";
import { ticks, type Ticks } from "../numerics/ticks";

export const MARGIN_NOTE = "Margin constraint not modeled";

/**
 * Modeled entry fill: reference + side x (spread + adverse ticks). Buy pays up, sell gets less.
 * With the D4 fixture (spread 0, adverse 1) a long at reference 22000 fills at 22000.25.
 */
export function modeledEntryFill(reference: Ticks, side: Side, cost: CostFixture): Ticks {
  return ticks(reference + side * (cost.spreadTicks + cost.adverseTicksPerFill));
}

/**
 * Modeled stop-exit fill. Non-gapped: the resting stop is touched and fills one adverse tick
 * beyond it (long exit sells at stop - adverse, short exit buys at stop + adverse).
 * Gapped: the reference is the opening price beyond the stop, plus the adverse tick.
 */
export function modeledStopExitFill(
  stop: Ticks,
  side: Side,
  cost: CostFixture,
  gapOpen: Ticks | null = null,
): { fill: Ticks; model: "touched-stop" | "gap-open" } {
  const adverse = cost.spreadTicks + cost.adverseTicksPerFill;
  if (gapOpen !== null) return { fill: ticks(gapOpen - side * adverse), model: "gap-open" };
  return { fill: ticks(stop - side * adverse), model: "touched-stop" };
}

export interface PerContractRisk {
  entryFill: Ticks;
  stopExitFill: Ticks;
  distanceTicks: Ticks;
  priceRiskMils: Mils;
  /** Both sides' fees for one contract. */
  feesMils: Mils;
  totalMils: Mils;
  costConvention: string;
}

/**
 * Per-contract risk = |modeled entry fill - modeled stop-exit fill| x tick value + both-side fees.
 * The entry adverse adjustment is already inside entryFill and is counted once.
 */
export function perContractRisk(input: {
  entryFill: Ticks;
  stopExitFill: Ticks;
  tickValueMils: Mils;
  cost: CostFixture;
}): PerContractRisk {
  const distanceTicks = ticks(Math.abs(input.entryFill - input.stopExitFill));
  const priceRiskMils = ticksToMils(distanceTicks, input.tickValueMils);
  const feesMils = mulMilsInt(input.cost.feePerContractPerSideMils, 2);
  return {
    entryFill: input.entryFill,
    stopExitFill: input.stopExitFill,
    distanceTicks,
    priceRiskMils,
    feesMils,
    totalMils: addMils(priceRiskMils, feesMils),
    costConvention: `${input.cost.source}: fee ${input.cost.feePerContractPerSideMils} mils/contract/side, spread ${input.cost.spreadTicks} ticks, adverse ${input.cost.adverseTicksPerFill} tick per fill`,
  };
}

/** Planned loss budget = floor(equity x riskBudgetPct), computed with integer arithmetic. */
export function riskBudget(equityMils: Mils, cfg: ModelConfig = modelConfig): Mils {
  const pctMicro = Math.round(cfg.riskBudgetPct * 1_000_000);
  return mils(Math.floor((equityMils * pctMicro) / 1_000_000));
}

export interface PositionSize {
  contracts: number;
  budgetMils: Mils;
  perContractRiskMils: Mils;
  /** contracts x per-contract risk; zero when skipped. */
  plannedLossMils: Mils;
  /** Display-only fraction of equity (e.g. 0.00212). */
  plannedLossPctOfEquity: number;
  skip: boolean;
  skipReason: string | null;
  marginNote: typeof MARGIN_NOTE;
}

/** qty = floor(budget / perContractRisk); 0 => skip (D5). Margin is not modeled (D9). */
export function positionSize(input: {
  equityMils: Mils;
  perContractRiskMils: Mils;
  cfg?: ModelConfig;
}): PositionSize {
  const cfg = input.cfg ?? modelConfig;
  const budgetMils = riskBudget(input.equityMils, cfg);
  const perContract = input.perContractRiskMils;
  if (perContract <= 0) {
    return {
      contracts: 0,
      budgetMils,
      perContractRiskMils: perContract,
      plannedLossMils: mils(0),
      plannedLossPctOfEquity: 0,
      skip: true,
      skipReason: "per-contract risk is not positive",
      marginNote: MARGIN_NOTE,
    };
  }
  const contracts = floorDivMils(budgetMils, perContract);
  const plannedLossMils = mulMilsInt(perContract, contracts);
  const skip = contracts === 0;
  return {
    contracts,
    budgetMils,
    perContractRiskMils: perContract,
    plannedLossMils,
    plannedLossPctOfEquity: input.equityMils > 0 ? plannedLossMils / input.equityMils : 0,
    skip,
    skipReason: skip ? `one contract risks ${perContract} mils, above the ${budgetMils} mils budget` : null,
    marginNote: MARGIN_NOTE,
  };
}
