import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AppProvider } from "./app/store";
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
