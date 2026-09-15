import { describe, expect, it } from "vitest";
import { RateLimitError, AuthenticationError, BadRequestError, APIConnectionError, APIError } from "@anthropic-ai/sdk";
import { createHandler, jobKey, mapUsage, sanitizeSchema, type BlobStoreLike, type JobBlob, type MessagesClient } from "../../netlify/functions/interpret";
import { createResultHandler } from "../../netlify/functions/interpret-result";
import type { LedgerState } from "../campaign/types";
import { INITIAL_MEMORY_EPOCH } from "../campaign/types";
import { modelConfig, type InstrumentRoot } from "../config/modelConfig";
import { fixtureSnapshots } from "../fixtures/snapshots";
import type { SignalSnapshot } from "../formula/types";
import { mils } from "../numerics/money";
import { buildRequest } from "./buildRequest";
import { callInterpreter, type CallProgress, type FetchLike } from "./client";
import { PROMPT_VERSION, SYSTEM_PROMPT } from "./prompt";
import type { Digest, InterpreterRequest, InterpreterResponse, Lesson } from "./types";

const SNAPS = fixtureSnapshots();
const JOB_ID = "interp:paperModel:2026-01-02T21:00:00Z:decision:claude-opus-5:interp-0.1:response";

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

/** A Map-backed stand-in for the Netlify blob store, with only the two methods the handler uses. */
function fakeStore(seed: Record<string, unknown> = {}): { store: BlobStoreLike; blobs: Map<string, unknown>; writes: string[] } {
  const blobs = new Map<string, unknown>(Object.entries(seed));
  const writes: string[] = [];
  return {
    blobs,
    writes,
    store: {
      async get(key) {
        return blobs.has(key) ? structuredClone(blobs.get(key)) : null;
      },
      async setJSON(key, value) {
        writes.push(`${key}:${(value as { status?: string }).status ?? "?"}`);
        blobs.set(key, structuredClone(value));
        return { etag: "fake" };
      },
    },
  };
}

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

function jobBody(request: InterpreterRequest, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { jobId: JOB_ID, kind: "interpret", request, model: "claude-opus-5", effort: "high", ...over };
}

describe("interpret background function — the happy path", () => {
  it("writes running then done with the validated result, and answers 202", async () => {
    const request = interpretRequest();
    const response = validResponse(request);
    const { client, calls } = fakeClient(() => textMessage(response));
    const { store, blobs, writes } = fakeStore();
    const res = await createHandler(() => client, () => store)(post(jobBody(request)));
    expect(res.status).toBe(202);
    expect(JSON.parse(await res.text())).toMatchObject({ ok: true, jobId: JOB_ID, status: "done" });
    expect(writes).toEqual([`${jobKey(JOB_ID)}:running`, `${jobKey(JOB_ID)}:done`]);
    const blob = blobs.get(jobKey(JOB_ID)) as JobBlob;
    expect(blob.status).toBe("done");
    if (blob.status !== "done") throw new Error("expected a done job");
    expect(blob.result.response).toEqual(response);
    expect(blob.result.usage).toEqual({ inputTokens: 4200, cachedInputTokens: 9000, outputTokens: 900 });
    expect(blob.result.costEstimateMils).toBeGreaterThan(0);
    expect(blob.result.promptVersion).toBe(PROMPT_VERSION);
    expect(blob.startedAt <= blob.finishedAt).toBe(true);
    // the blob never carries the request, a key or a raw exception
    const serialized = JSON.stringify(blob);
    expect(serialized).not.toContain("sk-ant");
    expect(serialized).not.toContain("markets");
    expect(calls).toHaveLength(1);
  });

  it("sends the documented request: cached system prefix, adaptive thinking, effort, schema, no prefill", async () => {
    const request = interpretRequest();
    const { client, calls } = fakeClient(() => textMessage(validResponse(request)));
    await createHandler(() => client, () => fakeStore().store)(post(jobBody(request, { model: "claude-sonnet-5", effort: "max" })));
    const params = calls[0]!;
    expect(params.model).toBe("claude-sonnet-5");
    expect(params.max_tokens).toBe(16000);
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params).not.toHaveProperty("tool_choice");
    expect(params).not.toHaveProperty("tools");
    const messages = params.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!.content)).toEqual(request);
    const system = params.system as { text: string; cache_control: unknown }[];
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(system[0]!.text.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(system[0]!.text).toContain("# How this strategy works");
    const output = params.output_config as { effort: string; format: { type: string; schema: Record<string, unknown> } };
    expect(output.effort).toBe("max");
    expect(output.format.type).toBe("json_schema");
    const serialized = JSON.stringify(output.format.schema);
    for (const keyword of ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"]) {
      expect(serialized, `${keyword} must not be sent`).not.toContain(keyword);
    }
    expect((output.format.schema as any).properties.readings.items.properties.root.enum).toEqual(["NQ", "ES"]);
  });

  it("validates a lesson against its campaign and a digest, each with its own schema", async () => {
    const request = interpretRequest();
    const lessonRequest: InterpreterRequest = {
      ...request,
      callKind: "lesson",
      campaignSummary: { campaignId: "paperModel:NQ:1" } as unknown as NonNullable<InterpreterRequest["campaignSummary"]>,
    };
    const lesson: Lesson = { campaignId: "paperModel:NQ:1", whatHeld: ["breadth held"], whatFailed: [], weighDifferently: [], evidenceToWatch: [] };
    const lessonStore = fakeStore();
    await createHandler(() => fakeClient(() => textMessage(lesson)).client, () => lessonStore.store)(
      post(jobBody(lessonRequest, { kind: "lesson", jobId: `${JOB_ID}:lesson` })),
    );
    const lessonBlob = lessonStore.blobs.get(jobKey(`${JOB_ID}:lesson`)) as JobBlob;
    expect(lessonBlob.status).toBe("done");
    if (lessonBlob.status !== "done") throw new Error("expected a done job");
    expect(lessonBlob.result.response).toEqual(lesson);

    const digest: Digest = { version: 1, lessonsCovered: 4, summary: "four campaigns", whatHeld: [], whatFailed: [], weighDifferently: [], evidenceToWatch: [] };
    const digestRequest: InterpreterRequest = { ...request, callKind: "digest", lessonsToCompact: [lesson] };
    const digestStore = fakeStore();
    await createHandler(() => fakeClient(() => textMessage(digest)).client, () => digestStore.store)(
      post(jobBody(digestRequest, { kind: "digest", jobId: `${JOB_ID}:digest` })),
    );
    const digestBlob = digestStore.blobs.get(jobKey(`${JOB_ID}:digest`)) as JobBlob;
    if (digestBlob.status !== "done") throw new Error("expected a done job");
    expect(digestBlob.result.response).toEqual(digest);
  });
});

describe("interpret background function — idempotency and failures", () => {
  const request = interpretRequest();

  it("does not call the model again for a job that already finished", async () => {
    for (const status of ["done", "failed"] as const) {
      const seedBlob =
        status === "done"
          ? { jobId: JOB_ID, status, startedAt: "t0", finishedAt: "t1", result: { ok: true, kind: "interpret", response: validResponse(request), usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, model: "claude-opus-5", latencyMs: 5, costEstimateMils: 1, promptVersion: PROMPT_VERSION } }
          : { jobId: JOB_ID, status, startedAt: "t0", finishedAt: "t1", reason: "refusal", httpStatus: 422, category: null };
      const { store, blobs, writes } = fakeStore({ [jobKey(JOB_ID)]: seedBlob });
      const { client, calls } = fakeClient(() => textMessage(validResponse(request)));
      const res = await createHandler(() => client, () => store)(post(jobBody(request)));
      expect(res.status).toBe(202);
      expect(JSON.parse(await res.text())).toMatchObject({ status, note: "already finished; the model was not called again" });
      expect(calls).toHaveLength(0);
      expect(writes).toEqual([]);
      expect(blobs.get(jobKey(JOB_ID))).toEqual(seedBlob);
    }
  });

  it("re-runs a job that was left running, which is how a Netlify retry recovers", async () => {
    const { store, writes } = fakeStore({ [jobKey(JOB_ID)]: { jobId: JOB_ID, status: "running", startedAt: "t0" } });
    const { client, calls } = fakeClient(() => textMessage(validResponse(request)));
    await createHandler(() => client, () => store)(post(jobBody(request)));
    expect(calls).toHaveLength(1);
    expect(writes).toEqual([`${jobKey(JOB_ID)}:running`, `${jobKey(JOB_ID)}:done`]);
  });

  it("records a validation failure as a failed blob with the validator's reason", async () => {
    const bad = { ...validResponse(request), evidenceStrength: "high" };
    const { store, blobs } = fakeStore();
    const res = await createHandler(() => fakeClient(() => textMessage(bad)).client, () => store)(post(jobBody(request)));
    expect(res.status).toBe(202);
    const blob = blobs.get(jobKey(JOB_ID)) as JobBlob;
    if (blob.status !== "failed") throw new Error("expected a failed job");
    expect(blob.httpStatus).toBe(422);
    expect(blob.reason).toMatch(/^response.evidenceStrength must be one of weak \| moderate \| strong/);
  });

  it("records a bad body as a failed blob, and a bad job id directly", async () => {
    const cases: { body: Record<string, unknown>; reason: string | RegExp }[] = [
      { body: jobBody(request, { model: "gpt-tiny" }), reason: "model is not in the allowed list" },
      { body: jobBody(request, { effort: "maximum" }), reason: /^effort must be one of/ },
      { body: jobBody(request, { kind: "chat" }), reason: /^kind must be one of/ },
      { body: jobBody(request, { request: { promptVersion: "interp-0.1" } }), reason: "request.markets is required" },
      { body: jobBody(request, { kind: "lesson" }), reason: "a lesson call needs request.campaignSummary.campaignId" },
    ];
    for (const c of cases) {
      const { store, blobs } = fakeStore();
      const { calls } = fakeClient(() => textMessage(validResponse(request)));
      await createHandler(() => fakeClient(() => textMessage(validResponse(request))).client, () => store)(post(c.body));
      const blob = blobs.get(jobKey(JOB_ID)) as JobBlob;
      if (blob.status !== "failed") throw new Error(`expected a failed job for ${JSON.stringify(c.reason)}`);
      if (typeof c.reason === "string") expect(blob.reason).toBe(c.reason);
      else expect(blob.reason).toMatch(c.reason);
      expect(blob.httpStatus).toBe(400);
      expect(calls).toHaveLength(0);
    }
    // no usable job id: answered directly, nothing written
    const { store, writes } = fakeStore();
    const res = await createHandler(() => fakeClient(() => textMessage(validResponse(request))).client, () => store)(post({ kind: "interpret", request, model: "claude-opus-5", effort: "high" }));
    expect(res.status).toBe(400);
    expect(JSON.parse(await res.text()).reason).toMatch(/^jobId must be an interpreter event id/);
    expect(writes).toEqual([]);
  });

  it("refuses a non-POST method and an oversized body before touching the store", async () => {
    const { store, writes } = fakeStore();
    const handler = createHandler(() => fakeClient(() => textMessage(validResponse(request))).client, () => store);
    const get = new Request("https://example.test/api/interpret", { method: "GET" });
    expect((await handler(get)).status).toBe(405);
    const big = await handler(post(jobBody(request), { "content-length": String(600 * 1024) }));
    expect(big.status).toBe(413);
    expect(writes).toEqual([]);
  });

  it("records a refusal, a truncation and unusable output as failed blobs", async () => {
    const cases: { message: Record<string, unknown>; reason: string; status: number; category?: string }[] = [
      {
        message: textMessage(null, { stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms" }, content: [] }),
        reason: "refusal",
        status: 422,
        category: "general_harms",
      },
      { message: textMessage(validResponse(request), { stop_reason: "max_tokens" }), reason: "max_tokens", status: 422 },
      { message: { stop_reason: "end_turn", content: [{ type: "text", text: "not json" }], usage: USAGE }, reason: "model output is not valid JSON", status: 422 },
      { message: { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "…" }], usage: USAGE }, reason: "model returned no text block", status: 422 },
    ];
    for (const c of cases) {
      const { store, blobs } = fakeStore();
      await createHandler(() => fakeClient(() => c.message).client, () => store)(post(jobBody(request)));
      const blob = blobs.get(jobKey(JOB_ID)) as JobBlob;
      if (blob.status !== "failed") throw new Error(`expected a failed job for ${c.reason}`);
      expect(blob.reason).toBe(c.reason);
      expect(blob.httpStatus).toBe(c.status);
      if (c.category) expect(blob.category).toBe(c.category);
    }
  });

  it("maps SDK errors into failed blobs without leaking anything", async () => {
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
      const { store, blobs } = fakeStore();
      await createHandler(() => fakeClient(() => c.err).client, () => store)(post(jobBody(request)));
      const blob = blobs.get(jobKey(JOB_ID)) as JobBlob;
      if (blob.status !== "failed") throw new Error(`expected a failed job for ${c.err.constructor.name}`);
      expect(blob.httpStatus).toBe(c.status);
      if (typeof c.reason === "string") expect(blob.reason).toBe(c.reason);
      else expect(blob.reason).toMatch(c.reason);
      expect(JSON.stringify(blob)).not.toContain("sk-ant");
    }
  });
});

describe("interpret-result endpoint", () => {
  const request = interpretRequest();
  const doneBlob: JobBlob = {
    jobId: JOB_ID,
    status: "done",
    startedAt: "2026-01-02T21:00:00Z",
    finishedAt: "2026-01-02T21:03:00Z",
    result: {
      ok: true,
      kind: "interpret",
      response: validResponse(request),
      usage: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2 },
      model: "claude-opus-5",
      latencyMs: 180_000,
      costEstimateMils: 1000,
      promptVersion: PROMPT_VERSION,
    },
  };
  const get = (query: string) => new Request(`https://example.test/api/interpret/result${query}`, { method: "GET" });

  it("returns the job blob unchanged", async () => {
    const { store } = fakeStore({ [jobKey(JOB_ID)]: doneBlob });
    const res = await createResultHandler(() => store)(get(`?jobId=${encodeURIComponent(JOB_ID)}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(await res.text())).toEqual(doneBlob);
  });

  it("404 when the job has not been written yet", async () => {
    const { store } = fakeStore();
    const res = await createResultHandler(() => store)(get(`?jobId=${encodeURIComponent(JOB_ID)}`));
    expect(res.status).toBe(404);
    expect(JSON.parse(await res.text()).reason).toBe("no such job yet");
  });

  it("400 on a missing or malformed job id, 405 on a non-GET", async () => {
    const { store } = fakeStore({ [jobKey(JOB_ID)]: doneBlob });
    const handler = createResultHandler(() => store);
    expect((await handler(get(""))).status).toBe(400);
    expect((await handler(get("?jobId="))).status).toBe(400);
    expect((await handler(get(`?jobId=${encodeURIComponent("a".repeat(201))}`))).status).toBe(400);
    expect((await handler(get("?jobId=" + encodeURIComponent("../../etc/passwd")))).status).toBe(400);
    const post = new Request("https://example.test/api/interpret/result?jobId=x", { method: "POST" });
    expect((await handler(post)).status).toBe(405);
  });

  it("502 when the store cannot be read", async () => {
    const broken: BlobStoreLike = {
      async get() {
        throw new Error("blob store unavailable");
      },
      async setJSON() {
        return {};
      },
    };
    const res = await createResultHandler(() => broken)(get(`?jobId=${encodeURIComponent(JOB_ID)}`));
    expect(res.status).toBe(502);
    expect(JSON.parse(await res.text()).reason).toBe("could not read the job store");
  });
});

describe("browser client — post then poll", () => {
  const request = interpretRequest();
  const body = { kind: "interpret" as const, request, model: "claude-opus-5", effort: "high" as const, jobId: JOB_ID };
  const okResult = {
    ok: true,
    kind: "interpret",
    response: validResponse(request),
    usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
    model: "claude-opus-5",
    latencyMs: 5,
    costEstimateMils: 10,
    promptVersion: PROMPT_VERSION,
  };

  /** Scripted transport: one reply per call, the last one repeating. */
  function transport(replies: { status: number; body?: unknown; retryAfter?: string }[]): { fetchImpl: FetchLike; seen: string[] } {
    const seen: string[] = [];
    let i = 0;
    const fetchImpl: FetchLike = async (path, init) => {
      const reply = replies[Math.min(i, replies.length - 1)]!;
      i += 1;
      seen.push(`${init?.method ?? "GET"} ${path}`);
      return {
        ok: reply.status < 400,
        status: reply.status,
        headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? (reply.retryAfter ?? null) : null) },
        text: async () => (reply.body === undefined ? "" : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body)),
      };
    };
    return { fetchImpl, seen };
  }

  const fastClock = () => {
    let t = 0;
    return { sleep: async (ms: number) => void (t += ms), now: () => t };
  };

  it("posts a job, polls past a 404 and a running blob, and returns the done result", async () => {
    const clock = fastClock();
    const progress: CallProgress[] = [];
    const { fetchImpl, seen } = transport([
      { status: 202, body: { ok: true, jobId: JOB_ID, status: "running" } },
      { status: 404, body: { ok: false, reason: "no such job yet", status: 404 } },
      { status: 200, body: { jobId: JOB_ID, status: "running", startedAt: "t0" } },
      { status: 200, body: { jobId: JOB_ID, status: "done", startedAt: "t0", finishedAt: "t1", result: okResult } },
    ]);
    const result = await callInterpreter(body, fetchImpl, { ...clock, onProgress: (p) => progress.push(p) });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.response).toEqual(okResult.response);
    expect(seen[0]).toBe("POST /api/interpret");
    expect(seen[1]).toBe(`GET /api/interpret/result?jobId=${encodeURIComponent(JOB_ID)}`);
    expect(seen).toHaveLength(4);
    // progress is reported: posted, then one per poll before the answer
    expect(progress[0]).toMatchObject({ status: "posted", elapsedMs: 0 });
    expect(progress.map((p) => p.status)).toEqual(["posted", "waiting", "running"]);
    expect(progress[progress.length - 1]!.elapsedMs).toBe(4000);
  });

  it("maps a failed job to the typed error shape, including a refusal category", async () => {
    const clock = fastClock();
    const { fetchImpl } = transport([
      { status: 202, body: { ok: true, status: "running" } },
      { status: 200, body: { jobId: JOB_ID, status: "failed", startedAt: "t0", finishedAt: "t1", reason: "refusal", httpStatus: 422, category: "general_harms" } },
    ]);
    expect(await callInterpreter(body, fetchImpl, clock)).toEqual({ ok: false, reason: "refusal", status: 422, category: "general_harms" });
  });

  it("gives up after the timeout and says the job may still finish", async () => {
    const clock = fastClock();
    const { fetchImpl } = transport([
      { status: 202, body: { ok: true, status: "running" } },
      { status: 200, body: { jobId: JOB_ID, status: "running", startedAt: "t0" } },
    ]);
    const result = await callInterpreter(body, fetchImpl, { ...clock, timeoutMs: 10_000, pollIntervalMs: 2000 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a timeout");
    expect(result.status).toBe(504);
    expect(result.reason).toMatch(/did not answer within 10 s; the job may still finish/);
  });

  it("retries the POST once on 429 and not on other statuses", async () => {
    const clock = fastClock();
    const waits: number[] = [];
    const { fetchImpl, seen } = transport([
      { status: 429, body: { ok: false, reason: "rate limited", status: 429 }, retryAfter: "2" },
      { status: 202, body: { ok: true, status: "running" } },
      { status: 200, body: { jobId: JOB_ID, status: "done", startedAt: "t0", finishedAt: "t1", result: okResult } },
    ]);
    const result = await callInterpreter(body, fetchImpl, { ...clock, sleep: async (ms) => void waits.push(ms) });
    expect(result.ok).toBe(true);
    expect(seen.filter((s) => s.startsWith("POST"))).toHaveLength(2);
    expect(waits[0]).toBe(2000);

    const server = transport([{ status: 500, body: { ok: false, reason: "server misconfigured", status: 500 } }]);
    expect(await callInterpreter(body, server.fetchImpl, clock)).toEqual({ ok: false, reason: "server misconfigured", status: 500, category: null });
    expect(server.seen.filter((s) => s.startsWith("POST"))).toHaveLength(1);
  });

  it("accepts a synchronous 200 answer (local dev) without polling", async () => {
    const clock = fastClock();
    const { fetchImpl, seen } = transport([{ status: 200, body: okResult }]);
    const result = await callInterpreter(body, fetchImpl, clock);
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["POST /api/interpret"]);
  });

  it("reports a network failure and refuses to run without a job id", async () => {
    const thrown: FetchLike = async () => {
      throw new Error("offline");
    };
    const netFail = await callInterpreter(body, thrown, fastClock());
    expect(netFail).toMatchObject({ ok: false, status: 0 });
    expect(netFail.ok === false && netFail.reason).toMatch(/could not reach the interpreter function: offline/);

    const noJob = await callInterpreter({ ...body, jobId: undefined }, thrown, fastClock());
    expect(noJob).toMatchObject({ ok: false, status: 400 });
    expect(noJob.ok === false && noJob.reason).toMatch(/needs a jobId/);
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

  it("the system prompt states the boundaries and never invites a probability", () => {
    expect(SYSTEM_PROMPT).toContain("deterministic calculator owns every number");
    expect(SYSTEM_PROMPT).toContain("integer tick count");
    expect(SYSTEM_PROMPT).toContain("not a probability");
    expect(SYSTEM_PROMPT).toContain("weak, moderate, strong");
    expect(SYSTEM_PROMPT).toContain(PROMPT_VERSION);
  });
});
