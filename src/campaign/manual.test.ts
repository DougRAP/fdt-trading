import { describe, expect, it } from "vitest";
import { fixtureSnapshots } from "../fixtures/snapshots";
import { INSTRUMENTS } from "../instruments/metadata";
import { Ledger } from "../ledger/ledger";
import { mils } from "../numerics/money";
import { toTicks, type Ticks } from "../numerics/ticks";
import { correctEvent, proposeTrailingStop, recordBrokerStop, recordCompletedClose, recordEntryFill, recordExitFill, recordMark } from "./manual";
import { LedgerError } from "./reduce";
import { campaignFlags, isStale, positionSummary, stopDiscrepancy } from "./pnl";
import type { ExitFillEvent } from "./types";

const px = (s: string): Ticks => toTicks(s, INSTRUMENTS.NQ.tick, "exact");
const NQ = fixtureSnapshots().find((s) => s.root === "NQ")!;
const EQUITY = mils(1_000_000_000);
const T = (d: number, h = 21) => `2026-01-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:10:00Z`;

function entryInput(over: Partial<Parameters<typeof recordEntryFill>[0]> = {}) {
  return {
    id: "m1",
    campaignId: "manual:NQ:1",
    root: "NQ" as const,
    side: 1 as const,
    snapshot: NQ,
    planned: { side: 1 as const, entry: px("22000.25"), stop: px("21947.75"), contracts: 2 },
    fill: { price: px("22000.25"), quantity: 2, filledAt: T(5, 14), timezone: "America/Chicago", feesMils: mils(5000) },
    equityMils: EQUITY,
    recordedAt: T(5, 15),
    ...over,
  };
}

describe("manual journal: entry, partial exits, close (acceptance #7, #9)", () => {
  it("records an entry fill without any order; campaign OPEN with frozen config/snapshot and original risk", () => {
    const ledger = new Ledger("manual");
    const results = ledger.appendAll(recordEntryFill(entryInput()));
    expect(results.every((r) => r.applied)).toBe(true);
    const c = ledger.activeCampaign!;
    expect(c.state).toBe("OPEN");
    expect(c.mode).toBe("manual");
    expect(c.contract).toBe("NQ · SYNTHETIC");
    expect(c.remaining).toBe(2);
    expect(c.frozenConfig.version).toBe("0.1");
    expect(Object.isFrozen(c.frozenConfig)).toBe(true);
    expect(c.frozenSnapshot.S.long).toBeCloseTo(2.2, 10);
    expect(c.originalRiskMils).toBe(2_120_000);
    expect(c.proposedStop?.stop).toBe(px("21947.75"));
    expect(c.brokerStop).toBeNull();
    expect(c.fills[0]?.actual).toBe(true);
    expect(c.fills[0]?.fillModel).toBe("actual-broker");
    expect(c.netRealizedMils).toBe(-5000);
  });

  it("requires a deviation reason when the actual fill differs from the plan", () => {
    const deviating = entryInput({ fill: { price: px("22000.75"), quantity: 2, filledAt: T(5, 14), timezone: "America/Chicago", feesMils: mils(5000) } });
    expect(() => recordEntryFill(deviating)).toThrow(LedgerError);
    const ledger = new Ledger("manual");
    const events = recordEntryFill({ ...deviating, deviationReason: "filled 2 ticks above plan at broker" });
    expect(ledger.appendAll(events).every((r) => r.applied)).toBe(true);
    const c = ledger.activeCampaign!;
    expect(c.deviationReasons).toEqual(["filled 2 ticks above plan at broker"]);
    // original risk uses the actual fill: stop 22000.75 - 52.5 = 21948.25, exit 21948.00, 211 ticks
    expect(c.proposedStop?.stop).toBe(px("21948.25"));
    expect(c.originalRiskMils).toBe(2_120_000);
    expect(c.plan.plannedEntry).toBe(px("22000.25"));
  });

  it("partial exits reconcile remaining size and realized P&L (FIFO, exact mils); full exit closes", () => {
    const ledger = new Ledger("manual");
    ledger.appendAll(recordEntryFill(entryInput()));
    const r1 = ledger.append(recordExitFill({ id: "x1", campaignId: "manual:NQ:1", price: px("22025.75"), quantity: 1, filledAt: T(6, 10), timezone: "America/Chicago", feesMils: mils(2500), recordedAt: T(6, 10) }));
    expect(r1.applied).toBe(true);
    let c = ledger.activeCampaign!;
    expect(c.state).toBe("OPEN");
    expect(c.remaining).toBe(1);
    expect(c.grossRealizedMils).toBe(102 * 5000);
    expect(c.feesMils).toBe(7500);
    expect(c.netRealizedMils).toBe(102 * 5000 - 7500);
    // cannot exit more than remaining
    const tooMany = ledger.append(recordExitFill({ id: "x-bad", campaignId: "manual:NQ:1", price: px("22000"), quantity: 2, filledAt: T(6, 11), timezone: "UTC", feesMils: mils(0), recordedAt: T(6, 11) }));
    expect(tooMany).toEqual({ applied: false, reason: "exit quantity 2 exceeds remaining 1" });
    expect(ledger.events).toHaveLength(4);
    ledger.append(recordExitFill({ id: "x2", campaignId: "manual:NQ:1", price: px("21988.25"), quantity: 1, filledAt: T(7, 10), timezone: "America/Chicago", feesMils: mils(2500), recordedAt: T(7, 10) }));
    c = ledger.campaigns[0]!;
    expect(c.state).toBe("CLOSED");
    expect(c.remaining).toBe(0);
    // second exit 21988.25 is 48 ticks below the 22000.25 entry
    expect(c.grossRealizedMils).toBe(102 * 5000 - 48 * 5000);
    expect(c.feesMils).toBe(10_000);
    expect(c.netRealizedMils).toBe(260_000);
    expect(ledger.activeCampaign).toBeNull();
    expect(ledger.state.cashMils).toBe(260_000); // manual starting equity 0 + net realized
    const stats = ledger.stats();
    expect(stats.closedCount).toBe(1);
    expect(stats.netRealizedMils).toBe(260_000);
    expect(stats.winRate).toEqual({ value: 1, n: 1 });
    expect(stats.meanR?.n).toBe(1);
    expect(stats.meanR?.value).toBeCloseTo(260_000 / 2_120_000, 12);
    expect(stats.totalFeesMils).toBe(10_000);
    expect(campaignFlags(c, null, false)).toEqual(["EXIT RECORDED"]);
  });

  it("side deviation: filling short against a long plan needs a reason; the campaign takes the filled side", () => {
    const shortFill = entryInput({ side: -1 as const });
    expect(() => recordEntryFill(shortFill)).toThrow(LedgerError);
    // reducer-level guard too: an ENTRY_FILL whose side differs without a reason is refused
    const ledger = new Ledger("manual");
    const events = recordEntryFill({ ...shortFill, deviationReason: "broker filled the opposite side" });
    const noReason = events.map((e) => (e.type === "ENTRY_FILL" ? { ...e, deviationReason: undefined } : e));
    const refused = ledger.appendAll(noReason);
    expect(refused[1]?.applied).toBe(false);
    expect(refused[1]?.reason).toMatch(/deviationReason is required/);
    const fresh = new Ledger("manual");
    expect(fresh.appendAll(events).every((r) => r.applied)).toBe(true);
    const c = fresh.activeCampaign!;
    expect(c.side).toBe(-1);
    expect(c.deviationReasons).toHaveLength(1);
    expect(fresh.stats().deviationCount).toBe(1);
    expect(c.plan.plannedEntry).toBe(px("22000.25"));
    expect(c.fills[0]?.side).toBe(-1);
    // Stop for the filled side uses the decision snapshot's D for that side:
    // D_short = ATR 25 x [1.5 + max(0, -1 x 0.60)] = 37.50 pts => 22000.25 + 37.50 = 22037.75 (rounded up to the tick).
    expect(c.proposedStop?.stop).toBe(px("22037.75"));
    expect(c.originalRiskMils).toBe((151 * 5000 + 5000) * 2);
  });

  it("two partial exits with identical fill times but different ids both apply", () => {
    const ledger = new Ledger("manual");
    ledger.appendAll(recordEntryFill(entryInput()));
    const at = T(6, 10);
    const a = ledger.append(recordExitFill({ id: "exit-a", campaignId: "manual:NQ:1", price: px("22025.75"), quantity: 1, filledAt: at, timezone: "UTC", feesMils: mils(2500), recordedAt: at }));
    const b = ledger.append(recordExitFill({ id: "exit-b", campaignId: "manual:NQ:1", price: px("22030.75"), quantity: 1, filledAt: at, timezone: "UTC", feesMils: mils(2500), recordedAt: at }));
    expect(a.applied && b.applied).toBe(true);
    const c = ledger.campaigns[0]!;
    expect(c.remaining).toBe(0);
    expect(c.state).toBe("CLOSED");
    expect(c.grossRealizedMils).toBe(102 * 5000 + 122 * 5000);
  });

  it("one open position per mode; a second entry is refused while one is active", () => {
    const ledger = new Ledger("manual");
    ledger.appendAll(recordEntryFill(entryInput()));
    const second = recordEntryFill(entryInput({ id: "m2", campaignId: "manual:NQ:2" }));
    const results = ledger.appendAll(second);
    expect(results[0]).toEqual({ applied: false, reason: "campaign manual:NQ:1 is still active; one position per mode" });
    expect(ledger.campaigns).toHaveLength(1);
  });

  it("duplicate event ids are no-ops", () => {
    const ledger = new Ledger("manual");
    const events = recordEntryFill(entryInput());
    ledger.appendAll(events);
    const again = ledger.appendAll(events);
    expect(again.every((r) => !r.applied && r.reason === "duplicate")).toBe(true);
    expect(ledger.activeCampaign?.remaining).toBe(2);
    expect(ledger.activeCampaign?.fills).toHaveLength(1);
  });

  it("corrections supersede the original event but keep it in the log", () => {
    const ledger = new Ledger("manual");
    ledger.appendAll(recordEntryFill(entryInput()));
    const wrong: ExitFillEvent = recordExitFill({ id: "x1", campaignId: "manual:NQ:1", price: px("22025.75"), quantity: 1, filledAt: T(6, 10), timezone: "America/Chicago", feesMils: mils(2500), recordedAt: T(6, 10) });
    ledger.append(wrong);
    expect(ledger.activeCampaign?.grossRealizedMils).toBe(102 * 5000);
    const fixed = correctEvent(wrong, { ...wrong, price: px("22020.75") }, "x1-corrected");
    expect(ledger.append(fixed).applied).toBe(true);
    expect(ledger.activeCampaign?.grossRealizedMils).toBe(82 * 5000);
    expect(ledger.activeCampaign?.remaining).toBe(1);
    expect(ledger.events.map((e) => e.id)).toContain("x1");
    expect(ledger.state.supersededEventIds).toEqual(["x1"]);
    expect(ledger.state.appliedEventIds).not.toContain("x1");
  });
});

describe("open state: marks, staleness, stop discrepancy, flags (acceptance #8)", () => {
  it("isStale uses observedAt against now", () => {
    expect(isStale({ observedAt: T(5, 14) }, T(5, 15), 60 * 60 * 1000)).toBe(false);
    expect(isStale({ observedAt: T(5, 14) }, T(5, 16), 60 * 60 * 1000)).toBe(true);
    expect(isStale(null, T(5, 16), 1000)).toBe(true);
  });

  it("position summary labels P&L stale without a fresh mark and computes R from marks", () => {
    const ledger = new Ledger("manual");
    ledger.appendAll(recordEntryFill(entryInput({ brokerStop: { price: px("21947.75"), status: "working", confirmedAt: T(5, 14) } })));
    const c = ledger.activeCampaign!;
    let s = positionSummary(c, null, T(5, 16), 3_600_000);
    expect(s.markStale).toBe(true);
    expect(s.unrealizedMils).toBeNull();
    expect(s.rMultiple).toBeNull();
    expect(s.flags).toEqual(["DATA STALE"]);
    expect(s.discrepancy).toEqual({ proposed: px("21947.75"), broker: px("21947.75"), diffTicks: 0, matches: true });

    ledger.append(recordMark({ id: "mk1", root: "NQ", price: px("22010.25"), observedAt: T(5, 16), source: "manual-quote" }));
    const mark = ledger.state.marks.NQ!;
    s = positionSummary(ledger.activeCampaign!, mark, T(5, 16), 3_600_000);
    expect(s.markStale).toBe(false);
    expect(s.unrealizedMils).toBe(40 * 5000 * 2);
    expect(s.rMultiple).toBeCloseTo((400_000 - 5000) / 2_120_000, 12);
    expect(s.averageEntryTicks).toBe(px("22000.25"));
    expect(s.flags).toEqual([]);
  });

  it("proposed vs broker stop discrepancy raises STOP UPDATE NEEDED; breach raises VERIFY BROKER", () => {
    const ledger = new Ledger("manual");
    ledger.appendAll(recordEntryFill(entryInput({ brokerStop: { price: px("21947.75"), status: "working", confirmedAt: T(5, 14) } })));
    let c = ledger.activeCampaign!;
    const trail = proposeTrailingStop({ id: "t1", campaignId: c.id, previous: c.proposedStop!, extremeClose: px("22100"), atrTicks: 120, H: 0.7, calculatedAt: T(6) });
    expect(trail.changed).toBe(true);
    ledger.append(trail.event);
    c = ledger.activeCampaign!;
    expect(c.proposedStop?.stop).toBe(px("22034"));
    expect(c.brokerStop?.price).toBe(px("21947.75")); // suggestion never moves the broker stop
    expect(stopDiscrepancy(c)).toEqual({ proposed: px("22034"), broker: px("21947.75"), diffTicks: -345, matches: false });
    ledger.append(recordMark({ id: "mk", root: "NQ", price: px("22050"), observedAt: T(6), source: "manual-quote" }));
    expect(campaignFlags(ledger.activeCampaign!, ledger.state.marks.NQ!, false)).toEqual(["STOP UPDATE NEEDED"]);
    ledger.append(recordBrokerStop({ id: "b2", campaignId: c.id, price: px("22034"), status: "working", confirmedAt: T(6), recordedAt: T(6) }));
    expect(campaignFlags(ledger.activeCampaign!, ledger.state.marks.NQ!, false)).toEqual([]);
    ledger.append(recordMark({ id: "mk2", root: "NQ", price: px("22030"), observedAt: T(7), source: "manual-quote" }));
    expect(campaignFlags(ledger.activeCampaign!, ledger.state.marks.NQ!, false)).toEqual(["STOP BREACHED—VERIFY BROKER"]);
    expect(ledger.activeCampaign!.state).toBe("OPEN"); // a touched/breached stop does not close the trade
  });

  it("only a completed close advances the ratchet reference; a plain mark does not", () => {
    const ledger = new Ledger("manual");
    ledger.appendAll(recordEntryFill(entryInput()));
    const recalc = (id: string) => {
      const c = ledger.activeCampaign!;
      const extreme = c.extremeClose ?? NQ.raw.closeT!;
      const r = proposeTrailingStop({ id, campaignId: c.id, previous: c.proposedStop!, extremeClose: extreme, atrTicks: NQ.raw.atr20Ticks, H: NQ.H, calculatedAt: T(6), cfg: c.frozenConfig });
      ledger.append(r.event);
      return ledger.activeCampaign!.proposedStop!.stop;
    };
    ledger.append(recordMark({ id: "mk", root: "NQ", price: px("22300"), observedAt: T(6), source: "manual-entered" }));
    expect(ledger.activeCampaign!.extremeClose).toBeNull();
    expect(recalc("p1")).toBe(px("21947.75"));
    ledger.append(recordCompletedClose({ id: "cc", root: "NQ", price: px("22300"), barEnd: T(6) }));
    expect(ledger.activeCampaign!.extremeClose).toBe(px("22300"));
    expect(recalc("p2")).toBe(px("22247.50")); // 22300 - 52.5
  });

  it("missing inputs freeze the proposed stop and flag DATA STALE without deleting it", () => {
    const ledger = new Ledger("manual");
    ledger.appendAll(recordEntryFill(entryInput()));
    const c = ledger.activeCampaign!;
    const frozen = proposeTrailingStop({ id: "t1", campaignId: c.id, previous: c.proposedStop!, extremeClose: px("22100"), atrTicks: null, H: 0.7, calculatedAt: T(6) });
    expect(frozen.changed).toBe(false);
    ledger.append(frozen.event);
    const after = ledger.activeCampaign!;
    expect(after.proposedStop?.stop).toBe(px("21947.75"));
    expect(after.stopFrozenReason?.code).toBe("DATA_STALE");
    expect(campaignFlags(after, null, false)).toEqual(["DATA STALE", "STOP UPDATE NEEDED"]);
  });
});
