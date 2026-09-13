import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AppProvider, useApp, type ModelReading } from "./app/store";
import { modelConfig } from "./config/modelConfig";
import type { ClampedProposal, InterpreterResponse } from "./interpreter/types";
import { ModelReading as ModelReadingPanel } from "./ui/ModelReading";
import { useState } from "react";
import { recordEntryFill } from "./campaign/manual";
import { fixtureSnapshots } from "./fixtures/snapshots";
import { INSTRUMENTS } from "./instruments/metadata";
import { Ledger } from "./ledger/ledger";
import { MemoryStorage, saveLedger } from "./ledger/storage";
import { mils } from "./numerics/money";
import { toTicks } from "./numerics/ticks";
import { Header } from "./ui/Header";
import { Observer } from "./ui/Observer";
import { TradeTicket } from "./ui/TradeTicket";
import { CampaignResults } from "./ui/CampaignResults";
import { HowItWorks } from "./ui/HowItWorks";

describe("smoke render (server)", () => {
  it("renders header, observer, ticket, results and the explanation section without throwing", () => {
    const html = renderToString(
      createElement(AppProvider, {
        storage: new MemoryStorage(),
        children: [
          createElement(Header, { key: "h" }),
          createElement(Observer, { key: "o" }),
          createElement(TradeTicket, { key: "t" }),
          createElement(CampaignResults, { key: "r" }),
          createElement(HowItWorks, { key: "w", selectedRoot: "NQ", defaultExample: true }),
        ],
      }),
    );
    expect(html).toContain('id="how-it-works"');
    expect(html).toContain('href="#how-it-works"');
    expect(html).toContain("Market observer");
    expect(html).toContain("Record entry fill");
    expect(html).toContain("Campaign results");
    expect(html).toContain("NQ");
    // acceptance #10: "score" only. Allowed negative phrasings from the UI and the strategy text:
    // "not a probability", "not calibrated probabilities", "No probability of profit".
    expect(html).not.toMatch(/confidence/i);
    const allowed = html.replace(/not a probability/gi, "").replace(/not calibrated probabilities/gi, "").replace(/No probability of profit/g, "");
    expect(allowed).not.toMatch(/probabilit/i);
    expect(html).toContain("aria-pressed=\"true\"");
    expect(html).toContain("ILLUSTRATIVE DATA");
  });

  it("open-state manual ticket: record buttons are disabled while their required input is empty", () => {
    const storage = new MemoryStorage();
    const ledger = new Ledger("manual");
    const snapshot = fixtureSnapshots().find((s) => s.root === "NQ")!;
    const px = (s: string) => toTicks(s, INSTRUMENTS.NQ.tick, "exact");
    ledger.appendAll(
      recordEntryFill({
        id: "m1",
        campaignId: "manual:NQ:1",
        root: "NQ",
        side: 1,
        snapshot,
        planned: { side: 1, entry: px("22000.25"), stop: px("21947.75"), contracts: 1 },
        fill: { price: px("22000.25"), quantity: 1, filledAt: "2026-01-05T14:31:00Z", timezone: "UTC", feesMils: mils(2500) },
        equityMils: mils(0),
        recordedAt: "2026-01-05T14:35:00Z",
      }),
    );
    saveLedger(storage, ledger);
    const html = renderToString(createElement(AppProvider, { storage, children: createElement(TradeTicket) }));
    expect(html).toContain("Open position (pinned");
    const button = (label: string) => new RegExp(`<button[^>]*>${label}</button>`).exec(html)?.[0] ?? "";
    expect(button("Record exit fill")).toContain("disabled");
    expect(button("Record mark")).toContain("disabled");
    expect(button("Record completed close")).toContain("disabled");
    expect(button("Record broker stop")).toContain("disabled");
    expect(button("Recalculate proposed stop")).not.toContain("disabled");
  });
});

describe("model reading panel (P2.6)", () => {
  const nq = fixtureSnapshots().find((s) => s.root === "NQ")!;
  const response: InterpreterResponse = {
    promptVersion: modelConfig.interpreter.promptVersion,
    readings: [
      { root: "NQ", activity: "building", breadth: "broadening", priceResponse: "responding", noiseFlag: false, evidence: ["u rose from 2.40 to 3.00"] },
      { root: "ZN", activity: "unclear", breadth: "unclear", priceResponse: "unclear", noiseFlag: false, evidence: ["breadth model undefined"] },
    ],
    crossMarket: { summary: "Equity activity concentrated in NQ.", supports: ["NQ"], contradicts: ["ZN"] },
    hypothesis: "Participation is building in NQ while ZN stays unreadable.",
    proposal: {
      action: "enter",
      root: "NQ",
      side: 1,
      entryZone: { lowTicks: 88000, highTicks: 88004 },
      stopTicks: 87900,
      invalidation: [{ kind: "H_below", root: "NQ", threshold: 0.4, note: "breadth falls back under the entry level" }],
      rationale: "activity and breadth build together and price confirms",
    },
    evidenceStrength: "moderate",
  };
  const clamped: ClampedProposal = {
    action: "enter",
    root: "NQ",
    side: 1,
    entryReferenceTicks: nq.raw.closeT!,
    stopTicks: 87900 as never,
    originalStopTicks: 87000,
    reasons: ["stop 87000 clamped to 87900 ticks"],
  };

  function render(reading: ModelReading | null): string {
    const storage = new MemoryStorage();
    return renderToString(
      createElement(AppProvider, {
        storage,
        deps: { interpreter: async () => ({ ok: false as const, reason: "not called in this test", status: 0 }) },
        children: createElement(ModelReadingHarness, { reading }),
      }),
    );
  }

  it("renders the collapsed two-line summary with the model id, bar, evidence word and action", () => {
    const html = render({ mode: "manual", kind: "advisory", barEnd: nq.barEnd, response, clamped, reasons: clamped.reasons, at: nq.availableAt });
    expect(html).toContain("Model reading");
    expect(html).toContain("claude-opus-5");
    expect(html).toContain("interp-0.1");
    expect(html).toContain("evidence");
    expect(html).toContain("moderate");
    expect(html).toContain("ENTER NQ");
    expect(html).toContain("Participation is building in NQ");
    expect(html).toContain("Ask model");
    expect(html).toContain('aria-expanded="false"');
    // collapsed: the per-market table is not rendered
    expect(html).not.toContain("Price response");
    expect(html).toContain("stop 87000 clamped to 87900 ticks");
  });

  it("renders the expanded detail with readings, proposal prices, invalidation and a labeled cost estimate", () => {
    const html = render({ mode: "manual", kind: "advisory", barEnd: nq.barEnd, response, clamped, reasons: [], at: nq.availableAt });
    const expanded = renderToString(
      createElement(AppProvider, {
        storage: new MemoryStorage(),
        deps: { interpreter: async () => ({ ok: false as const, reason: "not called", status: 0 }) },
        children: createElement(ModelReadingHarness, { reading: { mode: "manual", kind: "advisory", barEnd: nq.barEnd, response, clamped, reasons: [], at: nq.availableAt }, expanded: true }),
      }),
    );
    void html;
    expect(expanded).toContain("Price response");
    expect(expanded).toContain("broadening");
    expect(expanded).toContain("Cross-market");
    expect(expanded).toContain("22000.00 to 22001.00");
    expect(expanded).toContain("21975.00");
    expect(expanded).toContain("H_below NQ 0.40");
    expect(expanded).toContain("cost estimate");
    expect(expanded).toContain("(estimate)");
    expect(expanded).toContain("not a probability");
  });

  it("says nothing recorded before a call and never uses the forbidden words", () => {
    const html = render(null);
    expect(html).toContain("No model reading yet");
    expect(html).not.toMatch(/confidence/i);
    const allowed = html.replace(/not a probability/gi, "");
    expect(allowed).not.toMatch(/probabilit/i);
  });
});


/**
 * The panel reads its reading from the store, which a server render cannot mutate. This harness
 * renders the panel with a seeded reading by wrapping it in a provider whose state it patches.
 */
function ModelReadingHarness(props: { reading: ModelReading | null; expanded?: boolean }) {
  const store = useApp();
  store.state.modelReading = props.reading;
  const [expanded] = useState(props.expanded ?? false);
  void expanded;
  return createElement(ModelReadingPanel, { initiallyExpanded: props.expanded ?? false });
}
