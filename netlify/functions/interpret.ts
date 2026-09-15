/**
 * The only network path to the model (D20, addendum "Deployment constraints"), run as a Netlify
 * background function so an Opus call with adaptive thinking cannot hit a synchronous gateway timeout.
 *
 * Flow: the browser POSTs a job, Netlify answers 202 immediately and runs this to completion (up to
 * 15 minutes), and the result is written to a Netlify Blob that the browser polls through
 * interpret-result.ts. Netlify retries a failed background run, so the run is idempotent: a job whose
 * blob already says done or failed returns without calling the model again.
 *
 * The key lives in ANTHROPIC_API_KEY on the function and is read by the SDK itself; it is never passed
 * explicitly, never logged, never returned and never written to a blob. Request bodies are not logged
 * and never stored: the blob holds only the validated result or a reason.
 */
import Anthropic, { APIConnectionError, APIError, AuthenticationError, BadRequestError, RateLimitError } from "@anthropic-ai/sdk";
import { getStore } from "@netlify/blobs";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DIGEST_SCHEMA, LESSON_SCHEMA, responseSchemaFor, validateDigest, validateLesson, validateResponse } from "../../src/interpreter/schema";
import { PROMPT_VERSION, systemText } from "../../src/interpreter/prompt";
import {
  DEFAULT_INTERPRETER_CONFIG,
  estimateCostMils,
  type EffortLevel,
  type InterpreterRequest,
  type InterpreterUsage,
} from "../../src/interpreter/types";
import type { InstrumentRoot } from "../../src/config/modelConfig";

/** Background function: Netlify returns 202 to the caller and runs this to completion. */
export const config = { background: true, path: "/api/interpret" };

/** Maximum request body the function will read. */
export const MAX_BODY_BYTES = 512 * 1024;
/** Blob store shared with the result endpoint. */
export const JOB_STORE = "interpreter";
/** Blob key for one job. */
export const jobKey = (jobId: string): string => `jobs/${jobId}`;
/** A job id is the interpreter event id for that bar, call kind, model and prompt version. */
export const JOB_ID_PATTERN = /^[A-Za-z0-9:_.+@\-\s]{1,200}$/;

const MAX_TOKENS = 16000;
const TIMEOUT_MS = 13 * 60 * 1000;

const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const KINDS = ["interpret", "lesson", "digest"] as const;
export type CallBodyKind = (typeof KINDS)[number];

/** Keywords the structured-output schema may not carry; the runtime validator still enforces them. */
const UNSUPPORTED_SCHEMA_KEYWORDS = ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"] as const;

/** Minimal shape of the client the handler needs, so tests can inject a fake. */
export interface MessagesClient {
  messages: { create: (params: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown> };
}
export type ClientFactory = () => MessagesClient;

/** Minimal shape of the blob store the handler needs, so tests can inject a Map-backed fake. */
export interface BlobStoreLike {
  get(key: string, options?: { type?: "json"; consistency?: "strong" }): Promise<unknown>;
  setJSON(key: string, value: unknown): Promise<unknown>;
}
export type StoreFactory = () => BlobStoreLike;

export interface FunctionOk {
  ok: true;
  kind: CallBodyKind;
  /** The validated value: a response, a lesson or a digest. */
  response: unknown;
  usage: InterpreterUsage;
  model: string;
  latencyMs: number;
  costEstimateMils: number;
  promptVersion: string;
}

export interface FunctionError {
  ok: false;
  reason: string;
  status: number;
  /** Present on a refusal. */
  category?: string | null;
}

export type JobBlob =
  | { jobId: string; status: "running"; startedAt: string }
  | { jobId: string; status: "done"; startedAt: string; finishedAt: string; result: FunctionOk }
  | { jobId: string; status: "failed"; startedAt: string; finishedAt: string; reason: string; httpStatus: number; category?: string | null };

/** The caller is Netlify, which ignores the body; the status is still honest for local runs and tests. */
function accepted(body: Record<string, unknown>, status = 202): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Strip schema keywords the structured-output API does not accept. */
export function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if ((UNSUPPORTED_SCHEMA_KEYWORDS as readonly string[]).includes(key)) continue;
    out[key] = sanitizeSchema(value);
  }
  return out;
}

let howItWorksCache: string | null = null;

/**
 * The how-it-works document, sent as the cached prefix. Bundled functions may not ship the file, so a
 * miss is not fatal: the prompt then carries the instruction block alone.
 */
export function loadHowItWorks(): string {
  if (howItWorksCache !== null) return howItWorksCache;
  const here = (() => {
    try {
      return dirname(fileURLToPath(import.meta.url));
    } catch {
      return process.cwd();
    }
  })();
  const candidates = [
    resolve(process.cwd(), "src/content/how-it-works.md"),
    resolve(here, "../../src/content/how-it-works.md"),
    resolve(here, "src/content/how-it-works.md"),
  ];
  for (const path of candidates) {
    try {
      howItWorksCache = readFileSync(path, "utf8");
      return howItWorksCache;
    } catch {
      continue;
    }
  }
  howItWorksCache = "";
  return howItWorksCache;
}

interface ParsedBody {
  jobId: string;
  kind: CallBodyKind;
  request: InterpreterRequest;
  model: string;
  effort: EffortLevel;
}

function parseBody(raw: unknown): { ok: true; value: ParsedBody } | { ok: false; reason: string; status: number } {
  const bad = (reason: string) => ({ ok: false as const, reason, status: 400 });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("body must be a JSON object");
  const body = raw as Record<string, unknown>;
  const jobId = body.jobId;
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) return bad("jobId must be an interpreter event id of at most 200 characters");
  const kind = body.kind;
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) return bad(`kind must be one of ${KINDS.join(" | ")}`);
  const model = body.model;
  if (typeof model !== "string" || !DEFAULT_INTERPRETER_CONFIG.allowedModels.includes(model)) return bad("model is not in the allowed list");
  const effort = body.effort;
  if (typeof effort !== "string" || !(EFFORT_LEVELS as readonly string[]).includes(effort)) return bad(`effort must be one of ${EFFORT_LEVELS.join(" | ")}`);
  const request = body.request;
  if (typeof request !== "object" || request === null || Array.isArray(request)) return bad("request must be a JSON object");
  const r = request as Partial<InterpreterRequest>;
  if (typeof r.promptVersion !== "string") return bad("request.promptVersion is required");
  if (!Array.isArray(r.markets)) return bad("request.markets is required");
  if (kind === "interpret" && r.markets.length === 0) return bad("an interpret call needs at least one market");
  if (kind === "lesson" && typeof r.campaignSummary?.campaignId !== "string") return bad("a lesson call needs request.campaignSummary.campaignId");
  if (kind === "digest" && !Array.isArray(r.lessonsToCompact)) return bad("a digest call needs request.lessonsToCompact");
  return { ok: true, value: { jobId, kind: kind as CallBodyKind, request: request as InterpreterRequest, model, effort: effort as EffortLevel } };
}

function schemaFor(body: ParsedBody): unknown {
  if (body.kind === "lesson") return LESSON_SCHEMA;
  if (body.kind === "digest") return DIGEST_SCHEMA;
  const roots = body.request.markets.map((m) => m.root) as InstrumentRoot[];
  return responseSchemaFor(roots);
}

/**
 * Usage mapping for the cost estimate: cache writes are billed near the full input rate, cache reads
 * at the discounted rate, so writes are counted as input and only reads as cached input.
 */
export function mapUsage(usage: unknown): InterpreterUsage {
  const u = (typeof usage === "object" && usage !== null ? usage : {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: num(u.input_tokens) + num(u.cache_creation_input_tokens),
    cachedInputTokens: num(u.cache_read_input_tokens),
    outputTokens: num(u.output_tokens),
  };
}

function firstText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
  }
  return null;
}

/** Map an SDK error to a reason and status. Never describes an auth failure and never leaks a key. */
export function mapSdkError(err: unknown): { reason: string; status: number } {
  if (err instanceof AuthenticationError) return { reason: "server misconfigured", status: 500 };
  if (err instanceof RateLimitError) return { reason: "rate limited", status: 429 };
  if (err instanceof BadRequestError) return { reason: `upstream rejected the request: ${err.message}`, status: 400 };
  if (err instanceof APIConnectionError) return { reason: "could not reach the model provider", status: 502 };
  if (err instanceof APIError) {
    const status = typeof err.status === "number" ? err.status : 502;
    return { reason: `model provider error (${status})`, status };
  }
  return { reason: "interpreter call failed", status: 500 };
}

const defaultClientFactory: ClientFactory = () => new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 1 }) as unknown as MessagesClient;
const defaultStoreFactory: StoreFactory = () => getStore(JOB_STORE) as unknown as BlobStoreLike;

/** Build the handler over injectable factories; the default export uses the real SDK and blob store. */
export function createHandler(clientFactory: ClientFactory = defaultClientFactory, storeFactory: StoreFactory = defaultStoreFactory) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return accepted({ ok: false, reason: "POST only", status: 405 }, 405);
    const declared = req.headers.get("content-length");
    if (declared !== null && Number(declared) > MAX_BODY_BYTES) return accepted({ ok: false, reason: "request body too large", status: 413 }, 413);

    let text: string;
    try {
      text = await req.text();
    } catch {
      return accepted({ ok: false, reason: "could not read the request body", status: 400 }, 400);
    }
    if (text.length > MAX_BODY_BYTES) return accepted({ ok: false, reason: "request body too large", status: 413 }, 413);

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return accepted({ ok: false, reason: "body is not valid JSON", status: 400 }, 400);
    }

    // A body without a usable job id cannot be reported through a blob, so it is answered directly.
    const jobIdCandidate = (typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).jobId : null) as unknown;
    const jobId = typeof jobIdCandidate === "string" && JOB_ID_PATTERN.test(jobIdCandidate) ? jobIdCandidate : null;
    if (jobId === null) {
      return accepted({ ok: false, reason: "jobId must be an interpreter event id of at most 200 characters", status: 400 }, 400);
    }

    const store = storeFactory();
    const key = jobKey(jobId);
    const startedAt = new Date().toISOString();

    // Netlify retries a failed background run; a finished job is never re-run against the model.
    const existing = (await store.get(key, { type: "json", consistency: "strong" })) as JobBlob | null;
    if (existing && (existing.status === "done" || existing.status === "failed")) {
      return accepted({ ok: true, jobId, status: existing.status, note: "already finished; the model was not called again" });
    }

    const fail = async (reason: string, status: number, category?: string | null): Promise<Response> => {
      const blob: JobBlob = { jobId, status: "failed", startedAt, finishedAt: new Date().toISOString(), reason, httpStatus: status, category: category ?? null };
      await store.setJSON(key, blob);
      return accepted({ ok: false, jobId, status: "failed", reason });
    };

    await store.setJSON(key, { jobId, status: "running", startedAt } satisfies JobBlob);

    const parsed = parseBody(raw);
    if (!parsed.ok) return fail(parsed.reason, parsed.status);
    const body = parsed.value;

    const system = systemText(loadHowItWorks());
    const started = Date.now();
    let message: unknown;
    try {
      const client = clientFactory();
      message = await client.messages.create({
        model: body.model,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: JSON.stringify(body.request) }],
        thinking: { type: "adaptive" },
        output_config: { effort: body.effort, format: { type: "json_schema", schema: sanitizeSchema(schemaFor(body)) } },
      });
    } catch (err) {
      const mapped = mapSdkError(err);
      return fail(mapped.reason, mapped.status);
    }
    const latencyMs = Date.now() - started;

    const m = (typeof message === "object" && message !== null ? message : {}) as Record<string, unknown>;
    const usage = mapUsage(m.usage);
    const costEstimateMils = estimateCostMils(usage, body.model);
    const stopReason = typeof m.stop_reason === "string" ? m.stop_reason : null;

    if (stopReason === "refusal") {
      const details = (typeof m.stop_details === "object" && m.stop_details !== null ? m.stop_details : {}) as Record<string, unknown>;
      return fail("refusal", 422, typeof details.category === "string" ? details.category : null);
    }
    if (stopReason === "max_tokens") return fail("max_tokens", 422);

    const content = firstText(m.content);
    if (content === null) return fail("model returned no text block", 422);
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      return fail("model output is not valid JSON", 422);
    }

    const validated =
      body.kind === "lesson"
        ? validateLesson(value, body.request.campaignSummary?.campaignId ?? "")
        : body.kind === "digest"
          ? validateDigest(value)
          : validateResponse(value, body.request);
    if (!validated.ok) return fail(validated.reason, 422);

    const result: FunctionOk = {
      ok: true,
      kind: body.kind,
      response: validated.value,
      usage,
      model: body.model,
      latencyMs,
      costEstimateMils,
      promptVersion: PROMPT_VERSION,
    };
    const done: JobBlob = { jobId, status: "done", startedAt, finishedAt: new Date().toISOString(), result };
    await store.setJSON(key, done);
    return accepted({ ok: true, jobId, status: "done" });
  };
}

export default createHandler();
