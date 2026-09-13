import { describe, expect, it } from "vitest";
import {
  DIGEST_SCHEMA,
  LESSON_SCHEMA,
  RESPONSE_SCHEMA,
  responseSchemaFor,
  validateDigest,
  validateLesson,
  validateResponse,
  type ResponseValidationContext,
} from "./schema";
import type { InterpreterResponse } from "./types";

const CTX: ResponseValidationContext = { promptVersion: "interp-0.1", roots: ["NQ", "ES", "ZN"] };

/** A complete, valid response over the context's markets. */
function validResponse(): Record<string, unknown> {
  return {
    promptVersion: "interp-0.1",
    readings: [
      {
        root: "NQ",
        activity: "building",
        breadth: "broadening",
        priceResponse: "responding",
        noiseFlag: false,
        evidence: ["u rose from 2.40 to 3.00 on the bar ending 2026-01-02 21:00Z", "H 0.60 with price confirming"],
      },
      {
        root: "ES",
        activity: "isolated",
        breadth: "stable",
        priceResponse: "unclear",
        noiseFlag: true,
        evidence: ["S 1.60 with breadth flat across the last three bars"],
      },
      {
        root: "ZN",
        activity: "unclear",
        breadth: "unclear",
        priceResponse: "unclear",
        noiseFlag: false,
        evidence: ["breadth model undefined; no A, H, u or S"],
      },
    ],
    crossMarket: { summary: "Equity activity concentrated in NQ; ZN carries no breadth reading.", supports: ["ES"], contradicts: ["ZN"] },
    hypothesis: "Participation is building in NQ while ES lags and ZN is unreadable.",
    proposal: {
      action: "enter",
      root: "NQ",
      side: 1,
      entryZone: { lowTicks: 88000, highTicks: 88004 },
      stopTicks: 87791,
      invalidation: [
        { kind: "H_below", root: "NQ", threshold: 0.4, note: "directional breadth falls back under the entry level" },
        { kind: "cross_market", root: "ES", threshold: null, note: "ES turns down while NQ holds" },
      ],
      rationale: "Activity and breadth both build on the decision bar and price confirms.",
    },
    evidenceStrength: "moderate",
  };
}

/** Mutate a copy of the valid response and return the rejection reason. */
function reject(mutate: (r: Record<string, unknown>) => void, ctx: ResponseValidationContext = CTX): string {
  const r = validResponse();
  mutate(r);
  const result = validateResponse(r, ctx);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.reason;
}

describe("validateResponse — acceptance", () => {
  it("accepts a full valid response and returns the typed value", () => {
    const result = validateResponse(validResponse(), CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    const value: InterpreterResponse = result.value;
    expect(value.readings.map((r) => r.root)).toEqual(["NQ", "ES", "ZN"]);
    expect(value.proposal.action).toBe("enter");
    expect(value.proposal.stopTicks).toBe(87791);
    expect(value.proposal.invalidation[0]).toEqual({ kind: "H_below", root: "NQ", threshold: 0.4, note: "directional breadth falls back under the entry level" });
    expect(value.proposal.invalidation[1]?.threshold).toBeNull();
    expect(value.evidenceStrength).toBe("moderate");
    expect(value.crossMarket.supports).toEqual(["ES"]);
  });

  it("accepts every action in its consistent shape", () => {
    const shapes = [
      { action: "wait", root: "NQ", side: null, entryZone: null, stopTicks: null },
      { action: "wait", root: null, side: null, entryZone: null, stopTicks: null },
      { action: "hold", root: "NQ", side: 1, entryZone: null, stopTicks: null },
      { action: "tighten", root: "NQ", side: 1, entryZone: null, stopTicks: 87900 },
      { action: "exit", root: "NQ", side: 1, entryZone: null, stopTicks: null },
    ];
    for (const shape of shapes) {
      const r = validResponse();
      r.proposal = { ...(r.proposal as Record<string, unknown>), ...shape };
      const result = validateResponse(r, CTX);
      expect(result.ok, `${shape.action} should be accepted: ${result.ok ? "" : result.reason}`).toBe(true);
    }
  });

  it("accepts an empty invalidation list and an empty evidence list", () => {
    const r = validResponse();
    (r.proposal as Record<string, unknown>).invalidation = [];
    (r.readings as Record<string, unknown>[])[0]!.evidence = [];
    expect(validateResponse(r, CTX).ok).toBe(true);
  });
});

describe("validateResponse — rejection paths", () => {
  it("rejects non-objects", () => {
    expect(validateResponse(null, CTX)).toEqual({ ok: false, reason: "response must be a JSON object" });
    expect(validateResponse([], CTX)).toEqual({ ok: false, reason: "response must be a JSON object" });
    expect(validateResponse("{}", CTX)).toEqual({ ok: false, reason: "response must be a JSON object" });
  });

  it("rejects unknown fields at every level", () => {
    expect(reject((r) => void (r.extra = 1))).toBe("response has unknown field extra");
    expect(reject((r) => void ((r.readings as Record<string, unknown>[])[0]!.score = 1))).toBe("readings[0] has unknown field score");
    expect(reject((r) => void ((r.proposal as Record<string, unknown>).qty = 2))).toBe("proposal has unknown field qty");
    expect(reject((r) => void ((r.crossMarket as Record<string, unknown>).weight = 1))).toBe("crossMarket has unknown field weight");
  });

  it("rejects a prompt version that does not match the request", () => {
    expect(reject((r) => void (r.promptVersion = "interp-0.2"))).toBe("response.promptVersion interp-0.2 does not match the request's interp-0.1");
  });

  it("rejects missing required fields", () => {
    expect(reject((r) => void delete r.hypothesis)).toBe("response.hypothesis must be a string");
    expect(reject((r) => void delete r.proposal)).toBe("proposal must be an object");
    expect(reject((r) => void delete (r.proposal as Record<string, unknown>).rationale)).toBe("proposal.rationale must be a string");
    expect(reject((r) => void delete (r.readings as Record<string, unknown>[])[0]!.noiseFlag)).toBe("readings[0].noiseFlag must be a boolean");
    expect(reject((r) => void (r.hypothesis = ""))).toBe("response.hypothesis must not be empty");
  });

  it("rejects unknown enum values", () => {
    expect(reject((r) => void ((r.readings as Record<string, unknown>[])[0]!.activity = "surging"))).toMatch(/^readings\[0\].activity must be one of building \| isolated \| fading \| unclear/);
    expect(reject((r) => void ((r.readings as Record<string, unknown>[])[0]!.breadth = "wide"))).toMatch(/^readings\[0\].breadth must be one of/);
    expect(reject((r) => void ((r.readings as Record<string, unknown>[])[0]!.priceResponse = "lagging"))).toMatch(/^readings\[0\].priceResponse must be one of/);
    expect(reject((r) => void (r.evidenceStrength = "high"))).toMatch(/^response.evidenceStrength must be one of weak \| moderate \| strong/);
    expect(reject((r) => void ((r.proposal as Record<string, unknown>).action = "scale"))).toMatch(/^proposal.action must be one of/);
    expect(reject((r) => void (((r.proposal as Record<string, unknown>).invalidation as Record<string, unknown>[])[0]!.kind = "vibes"))).toMatch(/^proposal.invalidation\[0\].kind must be one of/);
  });

  it("rejects a percentage or confidence value in evidenceStrength", () => {
    expect(reject((r) => void (r.evidenceStrength = 0.8))).toMatch(/evidenceStrength must be one of/);
    expect(reject((r) => void (r.evidenceStrength = "confidence"))).toMatch(/evidenceStrength must be one of/);
  });

  it("rejects markets that are not in the request", () => {
    expect(reject((r) => void ((r.readings as Record<string, unknown>[])[0]!.root = "RTY"))).toBe('readings[0].root "RTY" is not a market in the request');
    expect(reject((r) => void ((r.proposal as Record<string, unknown>).root = "GC"))).toBe('proposal.root "GC" is not a market in the request');
    expect(reject((r) => void ((r.crossMarket as Record<string, unknown>).supports = ["YM"]))).toBe('crossMarket.supports[0] "YM" is not a market in the request');
    expect(reject((r) => void (((r.proposal as Record<string, unknown>).invalidation as Record<string, unknown>[])[0]!.root = "RTY"))).toBe('proposal.invalidation[0].root "RTY" is not a market in the request');
  });

  it("rejects duplicate and contradictory market lists", () => {
    expect(reject((r) => void ((r.readings as Record<string, unknown>[])[1]!.root = "NQ"))).toBe("readings[1].root NQ appears twice in readings");
    expect(reject((r) => void ((r.crossMarket as Record<string, unknown>).supports = ["ES", "ES"]))).toBe("crossMarket.supports lists ES twice");
    expect(reject((r) => void ((r.crossMarket as Record<string, unknown>).contradicts = ["ES"]))).toBe("crossMarket lists ES as both supporting and contradicting");
  });

  it("rejects tick values that are not positive safe integers", () => {
    expect(reject((r) => void ((r.proposal as Record<string, unknown>).stopTicks = 87791.5))).toBe("proposal.stopTicks must be a safe integer tick count, got 87791.5");
    expect(reject((r) => void ((r.proposal as Record<string, unknown>).stopTicks = Number.MAX_SAFE_INTEGER + 2))).toMatch(/must be a safe integer tick count/);
    expect(reject((r) => void ((r.proposal as Record<string, unknown>).stopTicks = 0))).toBe("proposal.stopTicks must be a positive tick count");
    expect(reject((r) => void ((r.proposal as Record<string, unknown>).stopTicks = -87791))).toBe("proposal.stopTicks must be a positive tick count");
    expect(reject((r) => void ((r.proposal as Record<string, unknown>).stopTicks = "87791"))).toMatch(/must be a safe integer tick count/);
    expect(reject((r) => void ((r.proposal as Record<string, unknown>).entryZone = { lowTicks: 88000.25, highTicks: 88004 }))).toMatch(/entryZone.lowTicks must be a safe integer/);
    expect(reject((r) => void ((r.proposal as Record<string, unknown>).entryZone = { lowTicks: 88010, highTicks: 88004 }))).toBe("proposal.entryZone.lowTicks must not exceed highTicks");
    expect(reject((r) => void ((r.proposal as Record<string, unknown>).stopTicks = 200_000_000))).toBe("proposal.stopTicks exceeds the tick sanity bound");
  });

  it("rejects a non-finite invalidation threshold", () => {
    expect(reject((r) => void (((r.proposal as Record<string, unknown>).invalidation as Record<string, unknown>[])[0]!.threshold = "0.4"))).toBe("proposal.invalidation[0].threshold must be a finite number or null");
    expect(reject((r) => void (((r.proposal as Record<string, unknown>).invalidation as Record<string, unknown>[])[0]!.threshold = Number.NaN))).toBe("proposal.invalidation[0].threshold must be a finite number or null");
  });

  it("rejects inconsistent action / root / side / stop combinations", () => {
    const proposal = (over: Record<string, unknown>) => (r: Record<string, unknown>) => {
      r.proposal = { ...(r.proposal as Record<string, unknown>), ...over };
    };
    expect(reject(proposal({ root: null }))).toBe("proposal.action enter requires a root");
    expect(reject(proposal({ side: null }))).toBe("proposal.action enter requires a side");
    expect(reject(proposal({ stopTicks: null }))).toBe("proposal.action enter requires stopTicks");
    expect(reject(proposal({ action: "wait", side: 1, stopTicks: null, entryZone: null }))).toBe("proposal.action wait must not carry a side");
    expect(reject(proposal({ action: "wait", side: null, entryZone: null }))).toBe("proposal.action wait must not carry stopTicks");
    expect(reject(proposal({ action: "wait", side: null, stopTicks: null }))).toBe("proposal.action wait must not carry an entryZone");
    expect(reject(proposal({ action: "hold", root: null, side: 1, stopTicks: null, entryZone: null }))).toBe("proposal.action hold requires the root of the open position");
    expect(reject(proposal({ action: "hold", stopTicks: null }))).toBe("proposal.action hold must not carry an entryZone");
    expect(reject(proposal({ action: "hold", entryZone: null }))).toBe("proposal.action hold must not carry stopTicks");
    expect(reject(proposal({ action: "exit", entryZone: null }))).toBe("proposal.action exit must not carry stopTicks");
    expect(reject(proposal({ action: "tighten", stopTicks: null, entryZone: null }))).toBe("proposal.action tighten requires stopTicks");
    expect(reject((r) => void ((r.proposal as Record<string, unknown>).side = 0))).toBe("proposal.side must be 1, -1 or null, got 0");
  });

  it("rejects malformed lists and oversized text", () => {
    expect(reject((r) => void (r.readings = []))).toBe("readings must not be empty");
    expect(reject((r) => void (r.readings = {}))).toBe("readings must be an array");
    expect(reject((r) => void ((r.readings as Record<string, unknown>[])[0]!.evidence = [1]))).toBe("readings[0].evidence[0] must be a string");
    expect(reject((r) => void ((r.readings as Record<string, unknown>[])[0]!.evidence = [""]))).toBe("readings[0].evidence[0] must not be empty");
    expect(reject((r) => void (r.hypothesis = "x".repeat(4001)))).toBe("response.hypothesis exceeds 4000 characters");
    expect(reject((r) => void ((r.readings as Record<string, unknown>[])[0]!.evidence = Array.from({ length: 21 }, () => "e")))).toBe("readings[0].evidence exceeds 20 items");
  });

  it("rejects a response whose readings outnumber the request's markets", () => {
    const oneMarket: ResponseValidationContext = { promptVersion: "interp-0.1", roots: ["NQ"] };
    expect(reject(() => undefined, oneMarket)).toBe("readings has more entries (3) than markets in the request (1)");
  });

  it("rejects when the request carries no markets", () => {
    const empty: ResponseValidationContext = { promptVersion: "interp-0.1", roots: [] };
    expect(validateResponse(validResponse(), empty)).toEqual({ ok: false, reason: "request carries no markets, so no response can reference one" });
  });
});

describe("JSON schemas", () => {
  it("response schema is restricted to the request's markets and required fields", () => {
    const schema = responseSchemaFor(["NQ", "ES"]) as Record<string, any>;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["promptVersion", "readings", "crossMarket", "hypothesis", "proposal", "evidenceStrength"]);
    expect(schema.properties.readings.items.properties.root.enum).toEqual(["NQ", "ES"]);
    expect(schema.properties.proposal.properties.action.enum).toEqual(["enter", "wait", "hold", "tighten", "exit"]);
    expect(schema.properties.evidenceStrength.enum).toEqual(["weak", "moderate", "strong"]);
    expect(schema.properties.proposal.properties.invalidation.items.properties.kind.enum).toEqual([
      "S_below",
      "H_below",
      "u_falls_below",
      "price_reverses",
      "breadth_concentrates",
      "cross_market",
    ]);
    const all = RESPONSE_SCHEMA as Record<string, any>;
    expect(all.properties.readings.items.properties.root.enum).toEqual(["NQ", "ES", "RTY", "YM", "ZN", "GC"]);
  });

  it("lesson and digest schemas match their validators' required fields", () => {
    expect((LESSON_SCHEMA as Record<string, any>).required).toEqual(["campaignId", "whatHeld", "whatFailed", "weighDifferently", "evidenceToWatch"]);
    expect((DIGEST_SCHEMA as Record<string, any>).additionalProperties).toBe(false);
    expect((DIGEST_SCHEMA as Record<string, any>).required).toContain("lessonsCovered");
  });
});

describe("validateLesson / validateDigest", () => {
  const lesson = () => ({
    campaignId: "paper:NQ:2026-01-02T21:00:00Z",
    whatHeld: ["breadth stayed above the entry level for three bars"],
    whatFailed: ["activity faded before price did"],
    weighDifferently: ["treat an isolated activity reading as weaker evidence"],
    evidenceToWatch: ["H falling under 0.40 while u still rises"],
  });

  it("accepts a valid lesson for the expected campaign", () => {
    const r = validateLesson(lesson(), "paper:NQ:2026-01-02T21:00:00Z");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.whatHeld).toHaveLength(1);
  });

  it("rejects a lesson for another campaign, unknown fields, and malformed lists", () => {
    expect(validateLesson(lesson(), "paper:ES:2026-01-02T21:00:00Z")).toEqual({
      ok: false,
      reason: "lesson.campaignId paper:NQ:2026-01-02T21:00:00Z does not match paper:ES:2026-01-02T21:00:00Z",
    });
    expect(validateLesson({ ...lesson(), grade: "A" }, "paper:NQ:2026-01-02T21:00:00Z")).toEqual({ ok: false, reason: "lesson has unknown field grade" });
    expect(validateLesson({ ...lesson(), whatHeld: "held" }, "paper:NQ:2026-01-02T21:00:00Z")).toEqual({ ok: false, reason: "lesson.whatHeld must be an array" });
    expect(validateLesson(null, "x")).toEqual({ ok: false, reason: "lesson must be a JSON object" });
  });

  it("accepts a valid digest and rejects a bad version or count", () => {
    const digest = { version: 2, lessonsCovered: 30, summary: "Thirty campaigns compacted.", whatHeld: ["a"], whatFailed: ["b"], weighDifferently: ["c"], evidenceToWatch: ["d"] };
    const r = validateDigest(digest);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.version).toBe(2);
    expect(validateDigest({ ...digest, version: 0 })).toEqual({ ok: false, reason: "digest.version must be a positive integer" });
    expect(validateDigest({ ...digest, lessonsCovered: -1 })).toEqual({ ok: false, reason: "digest.lessonsCovered must be a nonnegative integer" });
    expect(validateDigest({ ...digest, extra: true })).toEqual({ ok: false, reason: "digest has unknown field extra" });
  });
});
