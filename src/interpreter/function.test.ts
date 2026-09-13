import { describe, expect, it } from "vitest";
import { RateLimitError, AuthenticationError, BadRequestError, APIConnectionError, APIError } from "@anthropic-ai/sdk";
import { createHandler, loadHowItWorks, mapUsage, sanitizeSchema, type MessagesClient } from "../../netlify/functions/interpret";
import type { LedgerState } from "../campaign/types";
import { INITIAL_MEMORY_EPOCH } from "../campaign/types";
import { modelConfig, type InstrumentRoot } from "../config/modelConfig";
import { fixtureSnapshots } from "../fixtures/snapshots";
import type { SignalSnapshot } from "../formula/types";
import { mils } from "../numerics/money";
import { buildRequest } from "./buildRequest";
import { callInterpreter, type FetchLike } from "./client";
import { PROMPT_VERSION, SYSTEM_PROMPT } from "./prompt";
import type { Digest, InterpreterRequest, InterpreterResponse, Lesson } from "./types";

const SNAPS = fixtureSnapshots();

function ledgerState(): LedgerState {
  return {
    mode: "paperModel",
    campaigns: {},
    campaignOrder: [],
    activeCampaignId: null,
    marks: {},
    paused: false,
    stopMonitor: { healthy: true, lastCheckedAt: null, detail: "checked" },
    startingEquityMils: mils(1_000_000_000),
    cashMils: mils(1_000_000_000),
    externalCashFlowMils: mils(0),
    cumulativeNetRealizedMils: mils(0),
    equitySeries: [],
    appliedEventIds: [],
    supersededEventIds: [],
    interpreter: {
      latestResponseByBar: {},
      latestResponse: null,
      lessons: [],
      digest: null,
      memoryEpochId: INITIAL_MEMORY_EPOCH,
      archivedEpochIds: [],
      usage: { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costEstimateMils: mils(0), latencyMsTotal: 0 },
    },
  };
}

function interpretRequest(roots: readonly InstrumentRoot[] = ["NQ", "ES"]): InterpreterRequest {
  const histories: Partial<Record<InstrumentRoot, SignalSnapshot[]>> = {};
  for (const root of roots) {
    const base = SNAPS.find((s) => s.root === root);
    if (base) histories[root] = [structuredClone(base)];
  }
  return buildRequest({ callKind: "decision", mode: "paperModel", histories, ledger: ledgerState() });
}

function validResponse(request: InterpreterRequest): InterpreterResponse {
  return {
    promptVersion: request.promptVersion,
    readings: request.markets.map((m) => ({
      root: m.root,
      activity: "building" as const,
      breadth: "broadening" as const,
      priceResponse: "responding" as const,
      noiseFlag: false,
      evidence: [`${m.root} activity built on the bar ending ${m.bars[m.bars.length - 1]!.barEndText}`],
    })),
    crossMarket: { summary: "Equity activity concentrated in NQ.", supports: [], contradicts: [] },
    hypothesis: "Participation is building in NQ.",
    proposal: {
      action: "enter",
      root: "NQ",
      side: 1,
      entryZone: null,
      stopTicks: 87900,
      invalidation: [{ kind: "H_below", root: "NQ", threshold: 0.4, note: "breadth falls back" }],
      rationale: "activity and breadth build together and price confirms",
    },
    evidenceStrength: "moderate",
  };
}

const USAGE = { input_tokens: 3000, cache_creation_input_tokens: 1200, cache_read_input_tokens: 9000, output_tokens: 900 };

/** A fake client whose messages.create records the params it was given. */
function fakeClient(reply: (params: Record<string, unknown>) => unknown): { client: MessagesClient; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const client: MessagesClient = {
    messages: {
      create: async (params) => {
        calls.push(params);
        const r = reply(params);
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
  return { client, calls };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/api/interpret", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function textMessage(value: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(value) }], usage: USAGE, ...over };
}

describe("interpret function — valid paths", () => {
  it("returns the validated response with usage, cost estimate and latency", async () => {
    const request = interpretRequest();
    const response = validResponse(request);
    const { client, calls } = fakeClient(() => textMessage(response));
    const handler = createHandler(() => client);
    const res = await handler(post({ kind: "interpret", request, model: "claude-opus-5", effort: "high" }));
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.ok).toBe(true);
    expect(body.kind).toBe("interpret");
    expect(body.response).toEqual(response);
    expect(body.model).toBe("claude-opus-5");
    expect(body.promptVersion).toBe(PROMPT_VERSION);
    // cache writes count as input, cache reads as cached input
    expect(body.usage).toEqual({ inputTokens: 4200, cachedInputTokens: 9000, outputTokens: 900 });
    expect(body.costEstimateMils).toBeGreaterThan(0);
    expect(typeof body.latencyMs).toBe("number");
    expect(JSON.stringify(body)).not.toContain("sk-ant");
    expect(calls).toHaveLength(1);
  });

  it("sends the documented request: cached system prefix, adaptive thinking, effort, schema, no prefill", async () => {
    const request = interpretRequest();
    const { client, calls } = fakeClient(() => textMessage(validResponse(request)));
    await createHandler(() => client)(post({ kind: "interpret", request, model: "claude-sonnet-5", effort: "max" }));
    const params = calls[0]!;
    expect(params.model).toBe("claude-sonnet-5");
    expect(params.max_tokens).toBe(16000);
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params).not.toHaveProperty("tool_choice");
    expect(params).not.toHaveProperty("tools");
    const messages = params.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(JSON.parse(messages[0]!.content)).toEqual(request);
    const system = params.system as { type: string; text: string; cache_control: unknown }[];
    expect(system).toHaveLength(1);
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(system[0]!.text.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(system[0]!.text).toContain("# How this strategy works");
    const output = params.output_config as { effort: string; format: { type: string; schema: Record<string, unknown> } };
    expect(output.effort).toBe("max");
    expect(output.format.type).toBe("json_schema");
    // the schema is restricted to the markets in the request
    const readingRoot = (output.format.schema as any).properties.readings.items.properties.root.enum;
    expect(readingRoot).toEqual(["NQ", "ES"]);
  });

  it("sends no schema keyword the structured-output API rejects", async () => {
    const request = interpretRequest();
    const { client, calls } = fakeClient(() => textMessage(validResponse(request)));
    await createHandler(() => client)(post({ kind: "interpret", request, model: "claude-opus-5", effort: "high" }));
    const schema = (calls[0]!.output_config as { format: { schema: unknown } }).format.schema;
    const serialized = JSON.stringify(schema);
    for (const keyword of ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"]) {
      expect(serialized, `${keyword} must not be sent`).not.toContain(keyword);
    }
    // and the supported keywords survive
    expect(serialized).toContain('"additionalProperties":false');
    expect(serialized).toContain('"required"');
    expect(serialized).toContain('"enum"');
    expect(serialized).toContain('"anyOf"');
  });

  it("validates a lesson against the campaign it was asked about, and a digest", async () => {
    const request = interpretRequest();
    const lessonRequest: InterpreterRequest = {
      ...request,
      callKind: "lesson",
      campaignSummary: { campaignId: "paperModel:NQ:1" } as unknown as NonNullable<InterpreterRequest["campaignSummary"]>,
    };
    const lesson: Lesson = { campaignId: "paperModel:NQ:1", whatHeld: ["breadth held"], whatFailed: [], weighDifferently: [], evidenceToWatch: [] };
    const lessonClient = fakeClient(() => textMessage(lesson));
    const lessonRes = await createHandler(() => lessonClient.client)(post({ kind: "lesson", request: lessonRequest, model: "claude-opus-5", effort: "high" }));
    expect(lessonRes.status).toBe(200);
    expect(JSON.parse(await lessonRes.text()).response).toEqual(lesson);
    expect((lessonClient.calls[0]!.output_config as { format: { schema: any } }).format.schema.properties.campaignId).toBeDefined();

    const digest: Digest = { version: 1, lessonsCovered: 4, summary: "four campaigns", whatHeld: [], whatFailed: [], weighDifferently: [], evidenceToWatch: [] };
    const digestRequest: InterpreterRequest = { ...request, callKind: "digest", lessonsToCompact: [lesson] };
    const digestClient = fakeClient(() => textMessage(digest));
    const digestRes = await createHandler(() => digestClient.client)(post({ kind: "digest", request: digestRequest, model: "claude-opus-5", effort: "low" }));
    expect(digestRes.status).toBe(200);
    expect(JSON.parse(await digestRes.text()).response).toEqual(digest);
  });
});

describe("interpret function — refusals, bad input and upstream errors", () => {
  const request = interpretRequest();
  const handlerWith = (reply: (params: Record<string, unknown>) => unknown) => createHandler(() => fakeClient(reply).client);

  it("refuses a model outside the allowed list", async () => {
    const res = await handlerWith(() => textMessage(validResponse(request)))(
      post({ kind: "interpret", request, model: "gpt-tiny", effort: "high" }),
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(await res.text())).toEqual({ ok: false, reason: "model is not in the allowed list", status: 400 });
  });

  it("refuses a malformed body, a bad kind, a bad effort and a non-POST method", async () => {
    const handler = handlerWith(() => textMessage(validResponse(request)));
    expect((await handler(post("{not json"))).status).toBe(400);
    expect(JSON.parse(await (await handler(post("{not json"))).text()).reason).toBe("body is not valid JSON");
    expect(JSON.parse(await (await handler(post([1, 2]))).text()).reason).toBe("body must be a JSON object");
    expect(JSON.parse(await (await handler(post({ kind: "chat", request, model: "claude-opus-5", effort: "high" }))).text()).reason).toMatch(/^kind must be one of/);
    expect(JSON.parse(await (await handler(post({ kind: "interpret", request, model: "claude-opus-5", effort: "maximum" }))).text()).reason).toMatch(/^effort must be one of/);
    expect(JSON.parse(await (await handler(post({ kind: "interpret", request: { promptVersion: "interp-0.1" }, model: "claude-opus-5", effort: "high" }))).text()).reason).toBe(
      "request.markets is required",
    );
    expect(JSON.parse(await (await handler(post({ kind: "lesson", request, model: "claude-opus-5", effort: "high" }))).text()).reason).toBe(
      "a lesson call needs request.campaignSummary.campaignId",
    );
    const get = new Request("https://example.test/api/interpret", { method: "GET" });
    const res = await handler(get);
    expect(res.status).toBe(405);
    expect(JSON.parse(await res.text()).reason).toBe("POST only");
  });

  it("refuses an oversized body before calling the model", async () => {
    const { client, calls } = fakeClient(() => textMessage(validResponse(request)));
    const handler = createHandler(() => client);
    const res = await handler(post({ kind: "interpret", request, model: "claude-opus-5", effort: "high" }, { "content-length": String(600 * 1024) }));
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("reports a refusal with its category and never as an ok result", async () => {
    const res = await handlerWith(() =>
      textMessage(null, { stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms", explanation: "…" }, content: [] }),
    )(post({ kind: "interpret", request, model: "claude-opus-5", effort: "high" }));
    expect(res.status).toBe(422);
    expect(JSON.parse(await res.text())).toEqual({ ok: false, reason: "refusal", status: 422, category: "general_harms" });
  });

  it("reports a truncated answer, a non-JSON answer and a missing text block", async () => {
    const truncated = await handlerWith(() => textMessage(validResponse(request), { stop_reason: "max_tokens" }))(
      post({ kind: "interpret", request, model: "claude-opus-5", effort: "high" }),
    );
    expect(JSON.parse(await truncated.text())).toEqual({ ok: false, reason: "max_tokens", status: 422 });
    const garbage = await handlerWith(() => ({ stop_reason: "end_turn", content: [{ type: "text", text: "not json" }], usage: USAGE }))(
      post({ kind: "interpret", request, model: "claude-opus-5", effort: "high" }),
    );
    expect(JSON.parse(await garbage.text()).reason).toBe("model output is not valid JSON");
    const noText = await handlerWith(() => ({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "…" }], usage: USAGE }))(
      post({ kind: "interpret", request, model: "claude-opus-5", effort: "high" }),
    );
    expect(JSON.parse(await noText.text()).reason).toBe("model returned no text block");
  });

  it("rejects a response that fails validation, with the validator's reason and status 422", async () => {
    const bad = { ...validResponse(request), evidenceStrength: "high" };
    const res = await handlerWith(() => textMessage(bad))(post({ kind: "interpret", request, model: "claude-opus-5", effort: "high" }));
    expect(res.status).toBe(422);
    const body = JSON.parse(await res.text());
    expect(body.ok).toBe(false);
    expect(body.reason).toMatch(/^response.evidenceStrength must be one of weak \| moderate \| strong/);
  });

  it("rejects a response naming a market outside the request", async () => {
    const bad = validResponse(request);
    bad.proposal.root = "RTY";
    const res = await handlerWith(() => textMessage(bad))(post({ kind: "interpret", request, model: "claude-opus-5", effort: "high" }));
    expect(res.status).toBe(422);
    expect(JSON.parse(await res.text()).reason).toBe('proposal.root "RTY" is not a market in the request');
  });

  it("maps SDK errors to statuses without leaking anything", async () => {
    const headers = new Headers();
    const cases: { err: Error; status: number; reason: string | RegExp }[] = [
      { err: new AuthenticationError(401, { type: "error" }, "bad key sk-ant-secret", headers), status: 500, reason: "server misconfigured" },
      { err: new RateLimitError(429, { type: "error" }, "slow down", headers), status: 429, reason: "rate limited" },
      { err: new BadRequestError(400, { type: "error" }, "schema not supported", headers), status: 400, reason: /^upstream rejected the request/ },
      { err: new APIConnectionError({ message: "socket hang up" }), status: 502, reason: "could not reach the model provider" },
      { err: new APIError(503, { type: "error" }, "overloaded", headers), status: 503, reason: "model provider error (503)" },
      { err: new Error("something else"), status: 500, reason: "interpreter call failed" },
    ];
    for (const c of cases) {
      const res = await handlerWith(() => c.err)(post({ kind: "interpret", request, model: "claude-opus-5", effort: "high" }));
      expect(res.status, c.err.constructor.name).toBe(c.status);
      const body = JSON.parse(await res.text());
      expect(body.ok).toBe(false);
      if (typeof c.reason === "string") expect(body.reason).toBe(c.reason);
      else expect(body.reason).toMatch(c.reason);
      expect(JSON.stringify(body)).not.toContain("sk-ant");
    }
  });
});

describe("helpers", () => {
  it("sanitizeSchema strips only the unsupported keywords", () => {
    const cleaned = sanitizeSchema({
      type: "object",
      additionalProperties: false,
      required: ["a"],
      properties: { a: { type: "string", maxLength: 10 }, b: { type: "array", maxItems: 3, items: { type: "integer", minimum: 1, maximum: 5 } } },
    }) as any;
    expect(cleaned.properties.a).toEqual({ type: "string" });
    expect(cleaned.properties.b).toEqual({ type: "array", items: { type: "integer" } });
    expect(cleaned.additionalProperties).toBe(false);
    expect(cleaned.required).toEqual(["a"]);
  });

  it("mapUsage tolerates missing fields", () => {
    expect(mapUsage(undefined)).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    expect(mapUsage({ input_tokens: 10, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens: 2 })).toEqual({
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 2,
    });
  });

  it("loads the how-it-works document for the cached prefix", () => {
    expect(loadHowItWorks().startsWith("# How this strategy works")).toBe(true);
  });

  it("the system prompt states the boundaries and never invites a probability", () => {
    expect(SYSTEM_PROMPT).toContain("deterministic calculator owns every number");
    expect(SYSTEM_PROMPT).toContain("integer tick count");
    expect(SYSTEM_PROMPT).toContain("not a probability");
    expect(SYSTEM_PROMPT).toContain("weak, moderate, strong");
    expect(SYSTEM_PROMPT).toContain(PROMPT_VERSION);
  });
});

describe("browser client", () => {
  const request = interpretRequest();
  const okBody = { ok: true, kind: "interpret", response: validResponse(request), usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, model: "claude-opus-5", latencyMs: 5, costEstimateMils: 10, promptVersion: PROMPT_VERSION };

  function fetchStub(replies: { status: number; body: unknown; retryAfter?: string }[]): { fetchImpl: FetchLike; seen: number } {
    const state = { seen: 0 };
    const fetchImpl: FetchLike = async () => {
      const reply = replies[Math.min(state.seen, replies.length - 1)]!;
      state.seen += 1;
      return {
        ok: reply.status < 400,
        status: reply.status,
        headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? (reply.retryAfter ?? null) : null) },
        text: async () => (typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body)),
      };
    };
    return { fetchImpl, get seen() { return state.seen; } } as { fetchImpl: FetchLike; seen: number };
  }

  it("returns the ok result and posts to the function path", async () => {
    let seenPath = "";
    const fetchImpl: FetchLike = async (path, init) => {
      seenPath = path;
      expect(init?.method).toBe("POST");
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(okBody) };
    };
    const result = await callInterpreter({ kind: "interpret", request, model: "claude-opus-5", effort: "high" }, fetchImpl);
    expect(result.ok).toBe(true);
    expect(seenPath).toBe("/api/interpret");
  });

  it("retries once on 429 after Retry-After, and not on other statuses", async () => {
    const waits: number[] = [];
    const rate = fetchStub([
      { status: 429, body: { ok: false, reason: "rate limited", status: 429 }, retryAfter: "2" },
      { status: 200, body: okBody },
    ]);
    const result = await callInterpreter({ kind: "interpret", request, model: "claude-opus-5", effort: "high" }, rate.fetchImpl, {
      sleep: async (ms) => void waits.push(ms),
    });
    expect(result.ok).toBe(true);
    expect(waits).toEqual([2000]);

    const server = fetchStub([{ status: 500, body: { ok: false, reason: "server misconfigured", status: 500 } }]);
    const failed = await callInterpreter({ kind: "interpret", request, model: "claude-opus-5", effort: "high" }, server.fetchImpl, { sleep: async () => undefined });
    expect(failed).toEqual({ ok: false, reason: "server misconfigured", status: 500, category: null });
  });

  it("reports a network failure and a non-JSON body as errors, never as ok", async () => {
    const thrown: FetchLike = async () => {
      throw new Error("offline");
    };
    const netFail = await callInterpreter({ kind: "interpret", request, model: "claude-opus-5", effort: "high" }, thrown);
    expect(netFail).toMatchObject({ ok: false, status: 0 });
    expect(netFail.ok === false && netFail.reason).toMatch(/could not reach the interpreter function: offline/);

    const html: FetchLike = async () => ({ ok: false, status: 502, headers: { get: () => null }, text: async () => "<html>bad gateway</html>" });
    const bad = await callInterpreter({ kind: "interpret", request, model: "claude-opus-5", effort: "high" }, html);
    expect(bad).toMatchObject({ ok: false, status: 502 });
  });
});
