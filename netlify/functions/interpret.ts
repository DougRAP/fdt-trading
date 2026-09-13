/**
 * The only network path to the model (D20, addendum "Deployment constraints").
 *
 * Browser -> /api/interpret -> Anthropic. The key lives in ANTHROPIC_API_KEY on the function and is
 * read by the SDK itself; it is never passed explicitly, never logged, never returned, and never
 * reaches the browser. The browser's model choice is refused unless it is in the allowed list, and
 * the model's answer is validated here with the same validator the browser uses before anything is
 * returned. Request bodies are not logged.
 */
import Anthropic, { APIConnectionError, APIError, AuthenticationError, BadRequestError, RateLimitError } from "@anthropic-ai/sdk";
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

export const config = { path: "/api/interpret" };

/** Maximum request body the function will read. */
export const MAX_BODY_BYTES = 512 * 1024;
const MAX_TOKENS = 16000;
const TIMEOUT_MS = 60_000;

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

function json(body: FunctionOk | FunctionError, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fail(reason: string, status: number, extra: Partial<FunctionError> = {}): Response {
  return json({ ok: false, reason, status, ...extra }, status);
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
  kind: CallBodyKind;
  request: InterpreterRequest;
  model: string;
  effort: EffortLevel;
}

function parseBody(raw: unknown): { ok: true; value: ParsedBody } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "body must be a JSON object" };
  const body = raw as Record<string, unknown>;
  const kind = body.kind;
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: `kind must be one of ${KINDS.join(" | ")}` };
  }
  const model = body.model;
  if (typeof model !== "string" || !DEFAULT_INTERPRETER_CONFIG.allowedModels.includes(model)) {
    return { ok: false, reason: "model is not in the allowed list" };
  }
  const effort = body.effort;
  if (typeof effort !== "string" || !(EFFORT_LEVELS as readonly string[]).includes(effort)) {
    return { ok: false, reason: `effort must be one of ${EFFORT_LEVELS.join(" | ")}` };
  }
  const request = body.request;
  if (typeof request !== "object" || request === null || Array.isArray(request)) return { ok: false, reason: "request must be a JSON object" };
  const r = request as Partial<InterpreterRequest>;
  if (typeof r.promptVersion !== "string") return { ok: false, reason: "request.promptVersion is required" };
  if (!Array.isArray(r.markets)) return { ok: false, reason: "request.markets is required" };
  if (kind === "interpret" && r.markets.length === 0) return { ok: false, reason: "an interpret call needs at least one market" };
  if (kind === "lesson" && typeof r.campaignSummary?.campaignId !== "string") {
    return { ok: false, reason: "a lesson call needs request.campaignSummary.campaignId" };
  }
  if (kind === "digest" && !Array.isArray(r.lessonsToCompact)) return { ok: false, reason: "a digest call needs request.lessonsToCompact" };
  return { ok: true, value: { kind: kind as CallBodyKind, request: request as InterpreterRequest, model, effort: effort as EffortLevel } };
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

function mapSdkError(err: unknown): Response {
  // Most specific first. An auth failure is a server misconfiguration and must never be described.
  if (err instanceof AuthenticationError) return fail("server misconfigured", 500);
  if (err instanceof RateLimitError) return fail("rate limited", 429);
  if (err instanceof BadRequestError) return fail(`upstream rejected the request: ${err.message}`, 400);
  if (err instanceof APIConnectionError) return fail("could not reach the model provider", 502);
  if (err instanceof APIError) {
    const status = typeof err.status === "number" ? err.status : 502;
    return fail(`model provider error (${status})`, status);
  }
  return fail("interpreter call failed", 500);
}

const defaultClientFactory: ClientFactory = () => new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 1 }) as unknown as MessagesClient;

/** Build the handler over an injectable client factory; the default export uses the real SDK. */
export function createHandler(clientFactory: ClientFactory = defaultClientFactory) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return fail("POST only", 405);
    const declared = req.headers.get("content-length");
    if (declared !== null && Number(declared) > MAX_BODY_BYTES) return fail("request body too large", 413);

    let text: string;
    try {
      text = await req.text();
    } catch {
      return fail("could not read the request body", 400);
    }
    if (text.length > MAX_BODY_BYTES) return fail("request body too large", 413);

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return fail("body is not valid JSON", 400);
    }
    const parsed = parseBody(raw);
    if (!parsed.ok) return fail(parsed.reason, 400);
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
      return mapSdkError(err);
    }
    const latencyMs = Date.now() - started;

    const m = (typeof message === "object" && message !== null ? message : {}) as Record<string, unknown>;
    const usage = mapUsage(m.usage);
    const costEstimateMils = estimateCostMils(usage, body.model);
    const stopReason = typeof m.stop_reason === "string" ? m.stop_reason : null;

    if (stopReason === "refusal") {
      const details = (typeof m.stop_details === "object" && m.stop_details !== null ? m.stop_details : {}) as Record<string, unknown>;
      const category = typeof details.category === "string" ? details.category : null;
      return json({ ok: false, reason: "refusal", status: 422, category }, 422);
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

    const ok: FunctionOk = {
      ok: true,
      kind: body.kind,
      response: validated.value,
      usage,
      model: body.model,
      latencyMs,
      costEstimateMils,
      promptVersion: PROMPT_VERSION,
    };
    return json(ok, 200);
  };
}

export default createHandler();
