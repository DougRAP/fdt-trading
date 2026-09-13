import { describe, expect, it } from "vitest";
import { recordCashFlow, recordEntryFill, recordMark } from "../campaign/manual";
import { fixtureSnapshots } from "../fixtures/snapshots";
import { INSTRUMENTS } from "../instruments/metadata";
import { mils } from "../numerics/money";
import { toTicks, type Ticks } from "../numerics/ticks";
import { onDecisionBar, onExecutableBar } from "../paper/engine";
import { EM_DASH, Ledger, maxDrawdown } from "./ledger";
import { LEDGER_KEYS, MemoryStorage, SCHEMA_VERSION, loadLedger, saveLedger } from "./storage";

const px = (s: string): Ticks => toTicks(s, INSTRUMENTS.NQ.tick, "exact");
const NQ = fixtureSnapshots().find((s) => s.root === "NQ")!;

function manualWithEntry(): Ledger {
  const ledger = new Ledger("manual", { startingEquityMils: mils(250_000_000) });
  ledger.appendAll(
    recordEntryFill({
      id: "m1",
      campaignId: "manual:NQ:1",
      root: "NQ",
      side: 1,
      snapshot: NQ,
      planned: { side: 1, entry: px("22000.25"), stop: px("21947.75"), contracts: 1 },
      fill: { price: px("22000.25"), quantity: 1, filledAt: "2026-01-05T14:31:00Z", timezone: "America/Chicago", feesMils: mils(2500) },
      equityMils: mils(250_000_000),
      recordedAt: "2026-01-05T14:35:00Z",
    }),
  );
  return ledger;
}

describe("ledger separation and persistence (acceptance #7)", () => {
  it("manual and paper ledgers are separate and survive save/load under different keys", () => {
    const storage = new MemoryStorage();
    const manual = manualWithEntry();
    const paper = new Ledger("paper");
    onDecisionBar(paper, fixtureSnapshots(), paper.equityMils);
    onExecutableBar(paper, { root: "NQ", barEnd: "2026-01-05T21:00:00Z", availableAt: "2026-01-05T21:05:00Z", open: px("22000"), high: px("22050"), low: px("21980"), close: px("22040") }, { atrTicks: 100, H: 0.6 });
    saveLedger(storage, manual);
    saveLedger(storage, paper);
    expect(storage.keys().sort()).toEqual(["fdt.v1.manual", "fdt.v1.paper"]);
    expect(LEDGER_KEYS.manual).not.toBe(LEDGER_KEYS.paper);

    const m2 = loadLedger(storage, "manual");
    const p2 = loadLedger(storage, "paper");
    expect(m2.ok && m2.source).toBe("stored");
    expect(p2.ok && p2.source).toBe("stored");
    if (!m2.ok || !p2.ok) throw new Error("load failed");
    expect(m2.ledger.mode).toBe("manual");
    expect(p2.ledger.mode).toBe("paper");
    expect(m2.ledger.activeCampaign?.id).toBe("manual:NQ:1");
    expect(m2.ledger.activeCampaign?.fills[0]?.actual).toBe(true);
    expect(p2.ledger.activeCampaign?.id).toBe("paper:NQ:2026-01-02T21:00:00Z");
    expect(p2.ledger.activeCampaign?.fills[0]?.actual).toBe(false);
    expect(m2.ledger.startingEquityMils).toBe(250_000_000);
    expect(p2.ledger.startingEquityMils).toBe(1_000_000_000);
    expect(m2.ledger.events).toHaveLength(manual.events.length);
    expect(p2.ledger.events).toHaveLength(paper.events.length);
    expect(p2.ledger.state).toEqual(paper.state);
    expect(m2.ledger.activeCampaign?.frozenSnapshot.S.long).toBeCloseTo(2.2, 10);
  });

  it("missing key loads an empty ledger; unknown schemaVersion is refused, never migrated", () => {
    const storage = new MemoryStorage();
    const empty = loadLedger(storage, "manual");
    expect(empty.ok && empty.source).toBe("empty");
    expect(empty.ok && empty.ledger.events.length).toBe(0);
    storage.setItem(LEDGER_KEYS.paper, JSON.stringify({ schemaVersion: 2, mode: "paper", startingEquityMils: 1, events: [] }));
    const r = loadLedger(storage, "paper");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/unknown ledger schemaVersion 2 \(expected 1\)/);
    storage.setItem(LEDGER_KEYS.paper, "{not json");
    expect(loadLedger(storage, "paper")).toMatchObject({ ok: false, reason: "stored ledger is not valid JSON" });
    storage.setItem(LEDGER_KEYS.paper, JSON.stringify({ schemaVersion: SCHEMA_VERSION, mode: "manual", startingEquityMils: 0, events: [] }));
    expect(loadLedger(storage, "paper")).toMatchObject({ ok: false, reason: "stored ledger mode manual does not match paper" });
  });

  it("a stored log with an invalid event is refused with the event id", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      LEDGER_KEYS.manual,
      JSON.stringify({ schemaVersion: 1, mode: "manual", startingEquityMils: 0, events: [{ id: "bad", type: "EXIT_FILL", timestamp: "2026-01-01T00:00:00Z", actual: true, campaignId: "nope", quantity: 1, price: 1, feesMils: 0, filledAt: "2026-01-01T00:00:00Z", fillModel: "actual-broker", reason: "manual" }] }),
    );
    const r = loadLedger(storage, "manual");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/event bad: unknown campaign nope/);
  });

  it("unknown event types and missing required fields are refused by name; nothing escapes loadLedger", () => {
    const storage = new MemoryStorage();
    const doc = (events: unknown[]) => JSON.stringify({ schemaVersion: 1, mode: "manual", startingEquityMils: 0, events });
    storage.setItem(LEDGER_KEYS.manual, doc([{ id: "e1", type: "BOGUS_EVENT", timestamp: "2026-01-01T00:00:00Z", actual: true }]));
    expect(loadLedger(storage, "manual")).toMatchObject({ ok: false, reason: "stored ledger refused: event e1 has unknown event type BOGUS_EVENT" });
    storage.setItem(LEDGER_KEYS.manual, doc([{ id: "q1", type: "CAMPAIGN_QUEUED", timestamp: "2026-01-01T00:00:00Z", actual: true, campaignId: "c", mode: "manual", root: "NQ", contract: "NQ · SYNTHETIC", side: 1, frozenConfig: {}, frozenSnapshot: {}, decisionDistance: {} }]));
    const missing = loadLedger(storage, "manual");
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.reason).toBe("stored ledger refused: event q1 (CAMPAIGN_QUEUED) is missing required field plan");
    // plan present but not an object: caught by the nested shape check, by name
    storage.setItem(LEDGER_KEYS.manual, doc([{ id: "q2", type: "CAMPAIGN_QUEUED", timestamp: "2026-01-01T00:00:00Z", actual: true, campaignId: "c", mode: "manual", root: "NQ", contract: "NQ · SYNTHETIC", side: 1, plan: null, frozenConfig: { version: "0.1", costs: { NQ: {} } }, frozenSnapshot: { root: "NQ" }, decisionDistance: { dTicks: 210 } }]));
    expect(loadLedger(storage, "manual")).toMatchObject({ ok: false, reason: "stored ledger refused: event q2 (CAMPAIGN_QUEUED) plan.contracts must be an integer" });
    // shape passes but the reducer throws a non-LedgerError (STOP_SET with stop: null): still a refusal, never an exception
    const good = manualWithEntry();
    saveLedger(storage, good);
    const withNullStop = JSON.parse(storage.getItem(LEDGER_KEYS.manual)!) as { events: unknown[] };
    withNullStop.events.push({ id: "s-null", type: "STOP_SET", timestamp: "2026-01-06T00:00:00Z", actual: false, campaignId: "manual:NQ:1", kind: "proposed", stop: null });
    storage.setItem(LEDGER_KEYS.manual, JSON.stringify(withNullStop));
    const thrown = loadLedger(storage, "manual");
    expect(thrown.ok).toBe(false);
    expect(!thrown.ok && thrown.reason).toMatch(/^stored ledger failed validation: event s-null: TypeError/);
    storage.setItem(LEDGER_KEYS.manual, doc([null, 5]));
    expect(loadLedger(storage, "manual")).toMatchObject({ ok: false, reason: "stored ledger refused: event #0 is not an object" });
    storage.setItem(LEDGER_KEYS.manual, doc([{ type: "MARK" }]));
    expect(loadLedger(storage, "manual")).toMatchObject({ ok: false, reason: "stored ledger refused: event #0 has no string id" });
  });

  it("a stored MARK without completedClose loads: paper bar-close marks as completed, anything else as a plain mark", () => {
    const storage = new MemoryStorage();
    const manual = manualWithEntry();
    saveLedger(storage, manual);
    const stored = JSON.parse(storage.getItem(LEDGER_KEYS.manual)!) as { events: Record<string, unknown>[] };
    stored.events.push({ id: "old-mark", type: "MARK", timestamp: "2026-01-06T21:00:00Z", actual: true, root: "NQ", price: px("22300"), observedAt: "2026-01-06T21:00:00Z", source: "pre-field-mark" });
    storage.setItem(LEDGER_KEYS.manual, JSON.stringify(stored));
    const r = loadLedger(storage, "manual");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    const mark = r.ledger.events.find((e) => e.id === "old-mark");
    expect(mark?.type === "MARK" && mark.completedClose).toBe(false);
    expect(r.ledger.state.marks.NQ?.price).toBe(px("22300"));
    expect(r.ledger.activeCampaign?.extremeClose).toBeNull();
    // the stored document itself is untouched by the read
    expect(storage.getItem(LEDGER_KEYS.manual)).toBe(JSON.stringify(stored));

    // paper: an engine bar-close mark stored before the field existed is a completed close
    const paper = new Ledger("paper");
    onDecisionBar(paper, fixtureSnapshots(), paper.equityMils);
    onExecutableBar(paper, { root: "NQ", barEnd: "2026-01-05T21:00:00Z", availableAt: "2026-01-05T21:05:00Z", open: px("22000"), high: px("22050"), low: px("21980"), close: px("22040") }, { atrTicks: 100, H: 0.6 });
    saveLedger(storage, paper);
    const pdoc = JSON.parse(storage.getItem(LEDGER_KEYS.paper)!) as { events: Record<string, unknown>[] };
    for (const e of pdoc.events) if (e.type === "MARK") delete e.completedClose;
    pdoc.events.push({ id: "old-paper-mark", type: "MARK", timestamp: "2026-01-06T21:00:00Z", actual: false, root: "NQ", price: px("22090"), observedAt: "2026-01-06T21:00:00Z", source: "paper-observation-bar" });
    storage.setItem(LEDGER_KEYS.paper, JSON.stringify(pdoc));
    const p = loadLedger(storage, "paper");
    expect(p.ok).toBe(true);
    if (!p.ok) throw new Error(p.reason);
    expect(p.ledger.activeCampaign?.extremeClose).toBe(px("22090"));
  });

  it("a stored ENTRY_FILL without side takes the campaign's planned side; refused when the queued event is missing", () => {
    const storage = new MemoryStorage();
    const manual = manualWithEntry();
    saveLedger(storage, manual);
    const stored = JSON.parse(storage.getItem(LEDGER_KEYS.manual)!) as { events: Record<string, unknown>[] };
    for (const e of stored.events) if (e.type === "ENTRY_FILL") delete e.side;
    const text = JSON.stringify(stored);
    storage.setItem(LEDGER_KEYS.manual, text);
    const r = loadLedger(storage, "manual");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.ledger.activeCampaign?.side).toBe(1);
    expect(r.ledger.activeCampaign?.fills[0]?.side).toBe(1);
    expect(r.ledger.activeCampaign?.deviationReasons).toEqual([]);
    expect(storage.getItem(LEDGER_KEYS.manual)).toBe(text);
    // without the queued event there is no planned side to borrow
    const orphan = { ...stored, events: stored.events.filter((e) => e.type !== "CAMPAIGN_QUEUED") };
    storage.setItem(LEDGER_KEYS.manual, JSON.stringify(orphan));
    const o = loadLedger(storage, "manual");
    expect(o.ok).toBe(false);
    expect(!o.ok && o.reason).toBe("stored ledger refused: event m1:fill (ENTRY_FILL) has no side and no CAMPAIGN_QUEUED event for campaign manual:NQ:1");
  });

  it("nested shape: CAMPAIGN_QUEUED with an empty frozenConfig is refused by name", () => {
    const storage = new MemoryStorage();
    const manual = manualWithEntry();
    saveLedger(storage, manual);
    const stored = JSON.parse(storage.getItem(LEDGER_KEYS.manual)!) as { events: Record<string, unknown>[] };
    const q = stored.events.find((e) => e.type === "CAMPAIGN_QUEUED")!;
    q.frozenConfig = {};
    storage.setItem(LEDGER_KEYS.manual, JSON.stringify(stored));
    expect(loadLedger(storage, "manual")).toMatchObject({ ok: false, reason: "stored ledger refused: event m1 (CAMPAIGN_QUEUED) frozenConfig.version must be a string" });
    q.frozenConfig = { version: "0.1", costs: {} };
    storage.setItem(LEDGER_KEYS.manual, JSON.stringify(stored));
    expect(loadLedger(storage, "manual")).toMatchObject({ ok: false, reason: "stored ledger refused: event m1 (CAMPAIGN_QUEUED) frozenConfig.costs must contain root NQ" });
    q.frozenConfig = (manual.events[0] as { frozenConfig: unknown }).frozenConfig;
    q.decisionDistance = { side: 1 };
    storage.setItem(LEDGER_KEYS.manual, JSON.stringify(stored));
    expect(loadLedger(storage, "manual")).toMatchObject({ ok: false, reason: "stored ledger refused: event m1 (CAMPAIGN_QUEUED) decisionDistance.dTicks must be a number" });
  });

  it("reloading and re-appending the same events is idempotent", () => {
    const storage = new MemoryStorage();
    const manual = manualWithEntry();
    saveLedger(storage, manual);
    const loaded = loadLedger(storage, "manual");
    if (!loaded.ok) throw new Error(loaded.reason);
    const results = loaded.ledger.appendAll(manual.events);
    expect(results.every((r) => r.reason === "duplicate")).toBe(true);
    expect(loaded.ledger.activeCampaign?.fills).toHaveLength(1);
  });
});

describe("stats and drawdown (acceptance #9)", () => {
  it("empty ledger: em dashes for statistics with no qualifying data", () => {
    const ledger = new Ledger("manual");
    const s = ledger.stats();
    expect(s.closedCount).toBe(0);
    expect(s.winRate).toBeNull();
    expect(s.meanR).toBeNull();
    expect(s.netRealizedMils).toBe(0);
    expect(ledger.maxDrawdown()).toBeNull();
    const byRoot = ledger.statsByRoot();
    expect(Object.keys(byRoot)).toEqual(["NQ", "ES", "RTY", "YM", "ZN", "GC"]);
    expect(byRoot.ZN.winRate).toBeNull();
    const show = (v: { value: number; n: number } | null) => (v ? `${(v.value * 100).toFixed(0)}% (n=${v.n})` : EM_DASH);
    expect(show(s.winRate)).toBe("—");
  });

  it("per-root stats separate instruments; the account drawdown is not assigned per root", () => {
    const ledger = manualWithEntry();
    const byRoot = ledger.statsByRoot();
    expect(byRoot.NQ.totalFeesMils).toBe(2500);
    expect(byRoot.NQ.netRealizedMils).toBe(-2500);
    expect(byRoot.ES.netRealizedMils).toBe(0);
    expect("maxDrawdown" in byRoot.NQ).toBe(false);
  });

  it("manual drawdown is unavailable until account equity is entered; no-mark points are not scanned", () => {
    const ledger = new Ledger("manual"); // starting equity 0, no CASH_FLOW
    ledger.appendAll(
      recordEntryFill({
        id: "m1",
        campaignId: "manual:NQ:1",
        root: "NQ",
        side: 1,
        snapshot: NQ,
        planned: { side: 1, entry: px("22000.25"), stop: px("21947.75"), contracts: 1 },
        fill: { price: px("22000.25"), quantity: 1, filledAt: "2026-01-05T14:31:00Z", timezone: "America/Chicago", feesMils: mils(2500) },
        equityMils: mils(0),
        recordedAt: "2026-01-05T14:35:00Z",
      }),
    );
    ledger.append(recordMark({ id: "k1", root: "NQ", price: px("22100.25"), observedAt: "2026-01-06T21:00:00Z", source: "quote" }));
    ledger.append(recordMark({ id: "k2", root: "NQ", price: px("22050.25"), observedAt: "2026-01-07T21:00:00Z", source: "quote" }));
    expect(ledger.equitySeries).toHaveLength(3);
    expect(ledger.equitySeries[0]?.freshness).toBe("no-mark");
    expect(ledger.maxDrawdown()).toBeNull();
    // seeding equity afterwards gives a base: scanning starts at the seed point (equity 250,997,500)
    ledger.append(recordCashFlow({ id: "cf", amountMils: mils(250_000_000), note: "seed", at: "2026-01-08T00:00:00Z" }));
    expect(ledger.equityMils).toBe(250_997_500);
    // a 602-tick drop = 3,010,000 mils => ~1.2% swing from the seeded equity
    ledger.append(recordMark({ id: "k3", root: "NQ", price: px("21899.75"), observedAt: "2026-01-09T21:00:00Z", source: "quote" }));
    const dd = ledger.maxDrawdown()!;
    expect(dd.peakMils).toBe(250_997_500);
    expect(dd.troughMils).toBe(247_987_500);
    expect(dd.value).toBeCloseTo(0.012, 3);
    expect(dd.points).toBe(2);
  });

  it("external cash flows shift the peak basis instead of counting as P&L", () => {
    const ledger = manualWithEntry();
    ledger.append(recordMark({ id: "k1", root: "NQ", price: px("22100.25"), observedAt: "2026-01-06T21:00:00Z", source: "quote" })); // +400 ticks = +2,000,000
    ledger.append(recordMark({ id: "k2", root: "NQ", price: px("22050.25"), observedAt: "2026-01-07T21:00:00Z", source: "quote" })); // +200 ticks = +1,000,000
    const before = maxDrawdown(ledger.equitySeries, ledger.startingEquityMils)!;
    expect(before.peakMils).toBe(250_000_000 - 2500 + 2_000_000);
    expect(before.troughMils).toBe(250_000_000 - 2500 + 1_000_000);
    expect(before.value).toBeCloseTo(1_000_000 / 251_997_500, 12);
    ledger.append(recordCashFlow({ id: "cf1", amountMils: mils(100_000_000), note: "deposit", at: "2026-01-08T00:00:00Z" }));
    const after = maxDrawdown(ledger.equitySeries, ledger.startingEquityMils)!;
    expect(after.value).toBeCloseTo(before.value, 12);
    expect(ledger.equityMils).toBe(350_997_500);
    ledger.append(recordCashFlow({ id: "cf2", amountMils: mils(-100_000_000), note: "withdrawal", at: "2026-01-09T00:00:00Z" }));
    expect(maxDrawdown(ledger.equitySeries, ledger.startingEquityMils)!.value).toBeCloseTo(before.value, 12);
    expect(ledger.state.externalCashFlowMils).toBe(0);
  });
});
