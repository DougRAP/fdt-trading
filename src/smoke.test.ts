import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AppProvider } from "./app/store";
import { MemoryStorage } from "./ledger/storage";
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
});
