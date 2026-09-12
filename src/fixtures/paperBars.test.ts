import { describe, expect, it } from "vitest";
import { Ledger } from "../ledger/ledger";
import { mils } from "../numerics/money";
import { onDecisionBar, onExecutableBar, onObservationBar } from "../paper/engine";
import { demoBarsFor, demoTrailInputs } from "./paperBars";
import { fixtureSnapshots } from "./snapshots";

describe("synthetic demo bars", () => {
  const snaps = fixtureSnapshots();
  const nq = snaps.find((s) => s.root === "NQ")!;

  it("produces 4 tick-aligned bars with the executable bar first", () => {
    const bars = demoBarsFor(nq, 1);
    expect(bars).toHaveLength(4);
    for (const b of bars) {
      expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
      expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
      expect(b.barEnd < b.availableAt).toBe(true);
    }
    expect(bars[0]!.open).toBeGreaterThan(nq.raw.closeT!);
    expect(bars[0]!.barEnd > nq.barEnd).toBe(true);
  });

  it("drives the engine to a stopped exit on the last bar, and repeating a bar is a no-op", () => {
    const ledger = new Ledger("paper");
    expect(onDecisionBar(ledger, snaps, mils(1_000_000_000)).kind).toBe("queued");
    const bars = demoBarsFor(nq, 1);
    const trail = demoTrailInputs(nq);
    const first = onExecutableBar(ledger, bars[0]!, trail);
    expect(first.exited).toBeNull();
    expect(ledger.activeCampaign?.state).toBe("OPEN");
    onObservationBar(ledger, bars[1]!, trail);
    onObservationBar(ledger, bars[2]!, trail);
    expect(ledger.activeCampaign?.state).toBe("OPEN");
    const n = ledger.events.length;
    onObservationBar(ledger, bars[2]!, trail);
    expect(ledger.events).toHaveLength(n);
    const last = onObservationBar(ledger, bars[3]!, trail);
    expect(last.exited?.reason).toBe("stop-touched");
    expect(ledger.campaigns[0]!.state).toBe("CLOSED");
    expect(ledger.campaigns[0]!.fills.every((f) => !f.actual)).toBe(true);
  });

  it("short orientation mirrors and ZN/GC have no bars", () => {
    const rty = snaps.find((s) => s.root === "RTY")!;
    const bars = demoBarsFor(rty, -1);
    expect(bars[0]!.open).toBeLessThan(rty.raw.closeT!);
    expect(bars[2]!.close).toBeLessThan(bars[1]!.close);
    expect(bars[3]!.high).toBeGreaterThan(bars[2]!.close);
    const zn = snaps.find((s) => s.root === "ZN")!;
    expect(demoBarsFor(zn, 1)).toHaveLength(4); // has close + ATR, but never selected: breadth undefined
  });
});
