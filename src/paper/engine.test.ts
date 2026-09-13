import { describe, expect, it } from "vitest";
import { campaignFlags } from "../campaign/pnl";
import { fixtureSnapshots } from "../fixtures/snapshots";
import { INSTRUMENTS } from "../instruments/metadata";
import { modelConfig } from "../config/modelConfig";
import { Ledger, maxDrawdown } from "../ledger/ledger";
import { mils } from "../numerics/money";
import { toTicks, type Ticks } from "../numerics/ticks";
import { onDecisionBar, onExecutableBar, onObservationBar, pause, resume, stopMonitorStatus, type EngineBar } from "./engine";

const px = (s: string): Ticks => toTicks(s, INSTRUMENTS.NQ.tick, "exact");
const SNAPS = fixtureSnapshots();
const EQUITY = mils(1_000_000_000);
const TRAIL = { atrTicks: 100, H: 0.6 }; // D = 210 ticks (52.5 pts)

function bar(day: number, o: string, h: string, l: string, c: string, root: EngineBar["root"] = "NQ"): EngineBar {
  const d = String(day).padStart(2, "0");
  return { root, barEnd: `2026-01-${d}T21:00:00Z`, availableAt: `2026-01-${d}T21:05:00Z`, open: px(o), high: px(h), low: px(l), close: px(c) };
}

function queued(): Ledger {
  const ledger = new Ledger("paper");
  const d = onDecisionBar(ledger, SNAPS, EQUITY);
  expect(d).toEqual({ kind: "queued", campaignId: "paper:NQ:2026-01-02T21:00:00Z", root: "NQ", contracts: 2, skipped: [] });
  return ledger;
}

describe("decision bar", () => {
  it("queues the top qualifying sizeable candidate as PENDING; no fill yet", () => {
    const ledger = queued();
    const c = ledger.activeCampaign!;
    expect(c.state).toBe("PENDING");
    expect(c.side).toBe(1);
    expect(c.plan.contracts).toBe(2);
    expect(c.plan.plannedEntry).toBe(px("22000.25"));
    expect(c.plan.plannedStop).toBe(px("21947.75"));
    expect(c.plan.perContractRisk.totalMils).toBe(1_060_000);
    expect(c.plan.riskBudgetMils).toBe(2_500_000);
    expect(c.plan.sizing.marginNote).toBe("Margin constraint not modeled");
    expect(c.fills).toHaveLength(0);
    expect(c.frozenSnapshot.root).toBe("NQ");
    expect(Object.isFrozen(c.frozenConfig)).toBe(true);
  });

  it("highest rank below threshold => no automatic paper trade (acceptance #3)", () => {
    const ledger = new Ledger("paper");
    const noneQualify = SNAPS.filter((s) => s.status !== "QUALIFIED");
    expect(onDecisionBar(ledger, noneQualify, EQUITY)).toEqual({ kind: "no-qualifying" });
    expect(ledger.events).toHaveLength(0);
  });

  it("unsizeable top candidate falls through to the next sizeable one, with the skip recorded", () => {
    // budget 1,000,000 mils: NQ needs 1,060,000 per contract => skipped; ES needs 817,500 => 1 contract
    const small = new Ledger("paper", { startingEquityMils: mils(400_000_000) });
    const out = onDecisionBar(small, SNAPS, mils(400_000_000));
    expect(out).toEqual({
      kind: "queued",
      campaignId: "paper:ES:2026-01-02T21:00:00Z",
      root: "ES",
      contracts: 1,
      skipped: [{ root: "NQ", reason: "one contract risks 1,060.00, above the 1,000.00 budget" }],
    });
    const es = small.activeCampaign!;
    expect(es.root).toBe("ES");
    expect(es.plan.contracts).toBe(1);
    expect(es.plan.perContractRisk.totalMils).toBe(817_500);
    expect(es.plan.plannedEntry).toBe(toTicks("6000.25", INSTRUMENTS.ES.tick, "exact"));
    expect(es.plan.plannedStop).toBe(toTicks("5984.25", INSTRUMENTS.ES.tick, "exact"));
  });

  it("all qualifying candidates unsizeable => skip with every reason listed", () => {
    const tiny = new Ledger("paper", { startingEquityMils: mils(100_000_000) }); // budget 250,000
    const out = onDecisionBar(tiny, SNAPS, mils(100_000_000));
    expect(out.kind).toBe("skip");
    if (out.kind !== "skip") throw new Error("expected skip");
    expect(out.skipped.map((s) => s.root)).toEqual(["NQ", "ES"]);
    expect(out.root).toBe("ES");
    expect(tiny.events).toHaveLength(0);
  });

  it("paused => no entries; active position => no new decision", () => {
    const ledger = queued();
    expect(onDecisionBar(ledger, SNAPS, EQUITY)).toEqual({ kind: "position-active", campaignId: "paper:NQ:2026-01-02T21:00:00Z" });
    const paused = new Ledger("paper");
    pause(paused, "2026-01-02T21:06:00Z");
    expect(onDecisionBar(paused, SNAPS, EQUITY)).toEqual({ kind: "paused" });
    resume(paused, "2026-01-02T21:07:00Z");
    expect(onDecisionBar(paused, SNAPS, EQUITY).kind).toBe("queued");
  });

  it("repeating the same decision bar does not duplicate the queue", () => {
    const ledger = queued();
    const events = ledger.events.length;
    // a second identical decision sees the active campaign
    expect(onDecisionBar(ledger, SNAPS, EQUITY).kind).toBe("position-active");
    expect(ledger.events).toHaveLength(events);
  });

  it("a repeated decision-bar callback never opens a second campaign: after NQ closes, the same bar is skipped outright", () => {
    const ledger = queued();
    onExecutableBar(ledger, bar(5, "22000", "22010", "21940", "21990"), TRAIL); // stop hit in the fill bar => CLOSED
    expect(ledger.activeCampaign).toBeNull();
    const n = ledger.events.length;
    const out = onDecisionBar(ledger, SNAPS, EQUITY);
    expect(out).toEqual({ kind: "skip", root: "NQ", reason: "decision bar 2026-01-02T21:00:00Z already used", skipped: [] });
    expect(ledger.events).toHaveLength(n);
    expect(ledger.campaigns).toHaveLength(1);
    // the guard is per bar, not per root: ES on the same bar is not considered either
    expect(onDecisionBar(ledger, SNAPS.filter((s) => s.root !== "NQ"), EQUITY)).toMatchObject({ kind: "skip", reason: "decision bar 2026-01-02T21:00:00Z already used" });
    expect(ledger.campaigns).toHaveLength(1);
  });

  it("a running campaign is governed by its frozen config, not the cfg passed to later bars", () => {
    const ledger = queued();
    onExecutableBar(ledger, bar(5, "22000", "22050", "21980", "22040"), TRAIL);
    const loosened = { ...modelConfig, stopBase: 0.5 }; // would give D = 100 x 1.1 = 110 ticks => 22062.50
    const out = onObservationBar(ledger, bar(6, "22040", "22100", "21995", "22090"), TRAIL, loosened);
    expect(out.exited).toBeNull();
    expect(ledger.activeCampaign!.restingStop?.stop).toBe(px("22037.50"));
    expect(ledger.activeCampaign!.restingStop?.stop).not.toBe(px("22062.50"));
    expect(ledger.activeCampaign!.frozenConfig.stopBase).toBe(1.5);
  });

  it("DATA STALE clears when valid inputs return, even if the stop does not move", () => {
    const ledger = queued();
    onExecutableBar(ledger, bar(5, "22000", "22050", "21980", "22040"), TRAIL); // stop 21987.50
    onObservationBar(ledger, bar(6, "22040", "22060", "22000", "22035"), null); // frozen; highest close stays 22040
    expect(ledger.activeCampaign!.stopFrozenReason?.code).toBe("DATA_STALE");
    expect(ledger.activeCampaign!.extremeClose).toBe(px("22040"));
    // highest close 22040 - 52.5 = 21987.50 = current stop => unchanged, but re-issued as a valid trail stop
    const out = onObservationBar(ledger, bar(7, "22035", "22050", "22000", "22020"), TRAIL);
    expect(out.stopChanged).toBe(false);
    expect(out.stopFrozen).toBe(false);
    const c = ledger.activeCampaign!;
    expect(c.restingStop?.stop).toBe(px("21987.50"));
    expect(c.restingStop?.source).toBe("trail");
    expect(c.stopFrozenReason).toBeNull();
    expect(campaignFlags(c, ledger.state.marks.NQ!, false)).toEqual([]);
  });
});

describe("executable bar fill and OHLC stop simulation (acceptance #7, #9)", () => {
  it("fills at next bar open + 1 tick with 2 contracts, sets resting stop, trails after the close", () => {
    const ledger = queued();
    const out = onExecutableBar(ledger, bar(5, "22000", "22050", "21980", "22040"), TRAIL);
    const c = ledger.activeCampaign!;
    expect(c.state).toBe("OPEN");
    expect(c.fills[0]).toMatchObject({ kind: "entry", price: px("22000.25"), quantity: 2, feesMils: 5000, actual: false, fillModel: "paper-model-0.1" });
    expect(c.originalRiskMils).toBe(2_120_000);
    expect(out.exited).toBeNull();
    expect(out.stopChanged).toBe(true);
    expect(c.restingStop?.stop).toBe(px("21987.50")); // 22040 - 52.5
    expect(c.restingStop?.effectiveAfter).toBe("2026-01-05T21:05:00Z");
    expect(c.extremeClose).toBe(px("22040"));
    expect(c.exposureBars).toBe(1);
    expect(ledger.state.marks.NQ?.price).toBe(px("22040"));
    expect(ledger.equityMils).toBe(1_000_000_000 - 5000 + 159 * 5000 * 2);
    expect(ledger.state.stopMonitor.healthy).toBe(true);
  });

  it("touched resting stop fills at stop - 1 tick; realized uses fills + fees", () => {
    const ledger = queued();
    onExecutableBar(ledger, bar(5, "22000", "22050", "21980", "22040"), TRAIL);
    const out = onObservationBar(ledger, bar(6, "22030", "22060", "21985", "22000"), TRAIL);
    expect(out.exited).toEqual({ reason: "stop-touched", price: px("21987.25") });
    const c = ledger.campaigns[0]!;
    expect(c.state).toBe("CLOSED");
    expect(c.grossRealizedMils).toBe(-52 * 5000 * 2);
    expect(c.feesMils).toBe(10_000);
    expect(c.netRealizedMils).toBe(-530_000);
    expect(ledger.activeCampaign).toBeNull();
    expect(ledger.equityMils).toBe(1_000_000_000 - 530_000);
    const stats = ledger.stats();
    expect(stats.closedCount).toBe(1);
    expect(stats.winRate).toEqual({ value: 0, n: 1 });
    expect(stats.meanR?.value).toBeCloseTo(-530_000 / 2_120_000, 12);
  });

  it("initial stop hit in the fill bar exits at the planned loss (2,120,000 mils)", () => {
    const ledger = queued();
    const out = onExecutableBar(ledger, bar(5, "22000", "22010", "21940", "21990"), TRAIL);
    expect(out.exited).toEqual({ reason: "stop-touched", price: px("21947.50") });
    const c = ledger.campaigns[0]!;
    expect(c.state).toBe("CLOSED");
    expect(c.netRealizedMils).toBe(-2_120_000);
    expect(c.plan.sizing.plannedLossMils).toBe(2_120_000);
  });

  it("opening gap past the stop exits at the open - 1 tick, never at the stop price", () => {
    const ledger = queued();
    onExecutableBar(ledger, bar(5, "22000", "22050", "21980", "22040", "NQ"), TRAIL);
    const out = onObservationBar(ledger, bar(6, "21900", "21950", "21880", "21920"), TRAIL);
    expect(out.exited).toEqual({ reason: "gap-open", price: px("21899.75") });
    expect(ledger.campaigns[0]!.fills[1]?.reason).toBe("gap-open");
  });

  it("a stop computed from bar t's close is not tested against bar t's own low (no same-bar hindsight)", () => {
    const ledger = queued();
    onExecutableBar(ledger, bar(5, "22000", "22050", "21980", "22040"), TRAIL);
    // effective stop 21987.50; low 21995 does not touch it; the new stop from close 22090 is 22037.50 > low, but must not apply
    const out = onObservationBar(ledger, bar(6, "22040", "22100", "21995", "22090"), TRAIL);
    expect(out.exited).toBeNull();
    const c = ledger.activeCampaign!;
    expect(c.state).toBe("OPEN");
    expect(c.restingStop?.stop).toBe(px("22037.50"));
    expect(c.restingStop?.effectiveAfter).toBe("2026-01-06T21:05:00Z");
    // next bar gaps below the new stop => gap-open exit
    const next = onObservationBar(ledger, bar(7, "22030", "22080", "22020", "22070"), TRAIL);
    expect(next.exited).toEqual({ reason: "gap-open", price: px("22029.75") });
  });

  it("close required when the new stop is beyond the close; exits at the next bar open", () => {
    const ledger = queued();
    onExecutableBar(ledger, bar(5, "22000", "22050", "21980", "22040"), TRAIL);
    onObservationBar(ledger, bar(6, "22040", "22100", "21995", "22090"), TRAIL); // stop 22037.50
    // close 22000 stays above the effective stop's touch? low 21990 > 22037.5? No: use a bar whose low stays above 22037.50
    const out = onObservationBar(ledger, bar(7, "22075", "22095", "22045", "22050"), TRAIL);
    // extreme close 22090 -> stop stays 22037.50; close 22050 > stop => no close required
    expect(out.closeRequested).toBe(false);
    // now a bar whose close drops under the (unchanged) stop without the low touching it is impossible for a long,
    // so drive the ratchet: highest close rises to 22300 (stop 22247.50) while the close ends at 22300, then a bar
    // opens above the stop, never trades down to it, but closes... a long close below its stop implies a touch.
    // Close-required therefore arises from a tighter recalculated D: H rises to 0.9 -> D = 240; with an ATR drop to 50
    // ticks, D = 120 -> stop = 22300 - 30 = 22270 > close 22260 with low 22255 > old stop 22247.50.
    onObservationBar(ledger, bar(8, "22100", "22310", "22090", "22300"), TRAIL); // stop 22247.50
    const cr = onObservationBar(ledger, bar(9, "22290", "22300", "22255", "22260"), { atrTicks: 50, H: 0.9 });
    expect(cr.exited).toBeNull();
    expect(cr.closeRequested).toBe(true);
    const c = ledger.activeCampaign!;
    expect(c.restingStop?.stop).toBe(px("22270"));
    expect(campaignFlags(c, ledger.state.marks.NQ!, false)).toEqual(["CLOSE REQUIRED"]);
    const exit = onObservationBar(ledger, bar(10, "22265", "22280", "22240", "22250"), TRAIL);
    expect(exit.exited).toEqual({ reason: "close-required", price: px("22264.75") });
    expect(ledger.campaigns[0]!.state).toBe("CLOSED");
  });

  it("repeated bar events cannot duplicate fills or exits", () => {
    const ledger = queued();
    const b5 = bar(5, "22000", "22050", "21980", "22040");
    const first = onExecutableBar(ledger, b5, TRAIL);
    expect(first.events.length).toBeGreaterThan(0);
    const n = ledger.events.length;
    const again = onExecutableBar(ledger, b5, TRAIL);
    expect(again.events).toHaveLength(0);
    expect(ledger.events).toHaveLength(n);
    expect(ledger.activeCampaign!.fills).toHaveLength(1);
    const b6 = bar(6, "22030", "22060", "21985", "22000");
    onObservationBar(ledger, b6, TRAIL);
    const m = ledger.events.length;
    const dup = onObservationBar(ledger, b6, TRAIL);
    expect(dup.events).toHaveLength(0);
    expect(ledger.events).toHaveLength(m);
    expect(ledger.campaigns[0]!.fills).toHaveLength(2);
  });

  it("missing signal inputs freeze the resting stop (DATA STALE) but keep monitoring it", () => {
    const ledger = queued();
    onExecutableBar(ledger, bar(5, "22000", "22050", "21980", "22040"), TRAIL);
    const frozen = onObservationBar(ledger, bar(6, "22040", "22100", "21995", "22090"), null);
    expect(frozen.exited).toBeNull();
    expect(frozen.stopFrozen).toBe(true);
    expect(frozen.stopChanged).toBe(false);
    const c = ledger.activeCampaign!;
    expect(c.restingStop?.stop).toBe(px("21987.50"));
    expect(c.stopFrozenReason?.code).toBe("DATA_STALE");
    expect(campaignFlags(c, ledger.state.marks.NQ!, false)).toEqual(["DATA STALE"]);
    // no new decision while blocked, and the frozen stop still exits on a touch
    expect(onDecisionBar(ledger, SNAPS.map((s) => ({ ...s, status: "UNAVAILABLE" as const, qualifiedSide: null })), EQUITY).kind).toBe("position-active");
    const hit = onObservationBar(ledger, bar(7, "22000", "22010", "21980", "21990"), null);
    expect(hit.exited).toEqual({ reason: "stop-touched", price: px("21987.25") });
  });

  it("paused: no new entries, but existing stops are still monitored and exit", () => {
    const ledger = queued();
    onExecutableBar(ledger, bar(5, "22000", "22050", "21980", "22040"), TRAIL);
    pause(ledger, "2026-01-05T22:00:00Z");
    expect(ledger.state.paused).toBe(true);
    const out = onObservationBar(ledger, bar(6, "22030", "22060", "21985", "22000"), TRAIL);
    expect(out.exited?.reason).toBe("stop-touched");
    expect(onDecisionBar(ledger, SNAPS, ledger.equityMils)).toEqual({ kind: "paused" });
  });

  it("a pending campaign whose frozen budget is below one contract's risk at fill time is cancelled, not filled", () => {
    const ledger = new Ledger("paper");
    onDecisionBar(ledger, SNAPS, EQUITY);
    const c = ledger.activeCampaign!;
    // rebuild a ledger whose plan budget is below one contract's risk
    const tight = new Ledger("paper");
    const q = ledger.events[0]!;
    if (q.type !== "CAMPAIGN_QUEUED") throw new Error("expected queued event");
    tight.append({ ...q, plan: { ...q.plan, riskBudgetMils: mils(1_000_000) } });
    const out = onExecutableBar(tight, bar(5, "22000", "22050", "21980", "22040"), TRAIL);
    expect(out.events[0]?.type).toBe("CAMPAIGN_CANCELLED");
    expect(tight.campaigns[0]!.state).toBe("CANCELLED");
    expect(tight.campaigns[0]!.cancelReason).toMatch(/opening gap/);
    expect(tight.activeCampaign).toBeNull();
    expect(c.id).toBe(tight.campaigns[0]!.id);
  });

  it("stop monitor health reflects the last check age", () => {
    const ledger = queued();
    expect(stopMonitorStatus(ledger, "2026-01-05T21:00:00Z", 60_000).healthy).toBe(false);
    onExecutableBar(ledger, bar(5, "22000", "22050", "21980", "22040"), TRAIL);
    expect(stopMonitorStatus(ledger, "2026-01-05T21:00:30Z", 60_000)).toMatchObject({ healthy: true, lastCheckedAt: "2026-01-05T21:00:00Z" });
    expect(stopMonitorStatus(ledger, "2026-01-06T21:00:00Z", 60_000).healthy).toBe(false);
  });
});

describe("equity series and drawdown (acceptance #9)", () => {
  it("drawdown uses marked equity including the open position, not closed P&L alone", () => {
    const ledger = queued();
    onExecutableBar(ledger, bar(5, "22000", "22050", "21980", "22040"), TRAIL);
    onObservationBar(ledger, bar(6, "22030", "22060", "21985", "22000"), TRAIL);
    const series = ledger.equitySeries;
    expect(series.map((p) => p.freshness)).toEqual(["no-mark", "marked", "flat", "flat"]);
    expect(series.map((p) => p.equityMils)).toEqual([999_995_000, 1_001_585_000, 999_470_000, 999_470_000]);
    const dd = maxDrawdown(series, ledger.startingEquityMils)!;
    expect(dd.peakMils).toBe(1_001_585_000);
    expect(dd.troughMils).toBe(999_470_000);
    expect(dd.value).toBeCloseTo(2_115_000 / 1_001_585_000, 12);
    // closed-trade P&L alone would imply 530,000 / 1,000,000,000 = 0.00053; the marked series shows more
    expect(dd.value).toBeGreaterThan(530_000 / 1_000_000_000);
  });

  it("fewer than 2 scannable equity points => drawdown null; fresh paper ledger equity is the starting equity", () => {
    const ledger = new Ledger("paper");
    expect(ledger.maxDrawdown()).toBeNull();
    expect(ledger.equityMils).toBe(1_000_000_000);
  });
});
