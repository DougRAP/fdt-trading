import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { HowItWorks, ILLUSTRATIVE_LABEL, LIVE_EXAMPLE_UNAVAILABLE, normalizeMath, splitSections } from "./HowItWorks";
import raw from "../content/how-it-works.md?raw";

describe("How it works section", () => {
  const html = renderToString(createElement(HowItWorks, { selectedRoot: "NQ", defaultExample: true }));

  it("keeps the markdown file unchanged from the strategy document", () => {
    expect(raw.startsWith("# How this strategy works")).toBe(true);
    expect(raw).toContain("## What we still need to learn");
    expect(raw).toContain(ILLUSTRATIVE_LABEL);
  });

  it("first heading is the document title, shifted to h2", () => {
    const first = /<h[1-6][^>]*>(.*?)<\/h[1-6]>/.exec(html);
    expect(first?.[1]).toBe("How this strategy works");
    expect(first?.[0]).toMatch(/^<h2/);
    expect(html).toContain('id="how-it-works"');
  });

  it("shows the D10 unavailable message when the control is used", () => {
    expect(html).toContain(LIVE_EXAMPLE_UNAVAILABLE);
    expect(html).toContain("Use selected market<!-- --> (NQ)");
  });

  it("renders math, tables in scroll containers, details, and labeled examples", () => {
    expect(html).toContain("katex-display");
    expect(html).toContain('<div class="cp-scroll"><table>');
    expect((html.match(/<details>/g) ?? []).length).toBe(2);
    expect(html).toContain("Derivation: how u changes with Q and A");
    expect(html).toContain("What we still need to learn (future research questions)");
    expect((html.match(/cp-illustrative/g) ?? []).length).toBe(2);
    // dollar amounts in prose are not parsed as inline math
    expect(html).toContain("$20 per point");
    // right-aligned value columns (md `---:`) carry an alignment marker the CSS targets; text columns do not
    const rightMarks = html.match(/<t[hd][^>]*(align="right"|text-align:\s*right)[^>]*>/g) ?? [];
    expect(rightMarks.length).toBeGreaterThan(0);
    expect(html).toMatch(/<th>Symbol<\/th>/);
  });

  it("normalizeMath converts display delimiters and splitSections isolates the two passages", () => {
    const md = normalizeMath(raw);
    expect(md).not.toMatch(/^\\\[$/m);
    const segs = splitSections(md);
    expect(segs.map((s) => s.kind)).toEqual(["md", "details", "md", "details"]);
    expect(segs[1]?.text.startsWith("The mathematical decomposition is:")).toBe(true);
    expect(segs[1]?.text.trim().endsWith("$$")).toBe(true);
    expect(segs[3]?.text.startsWith("## What we still need to learn")).toBe(true);
  });
});
