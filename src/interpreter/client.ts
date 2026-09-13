/**
 * Browser client for the interpreter function. The browser never holds a key and never talks to the
 * provider: it posts to the function and gets back a validated result or a reason.
 * One retry, only on 429, after the server's Retry-After.
 */
import type { EffortLevel, InterpreterRequest, InterpreterUsage } from "./types";

export const INTERPRETER_PATH = "/api/interpret";

export type InterpreterCallKind = "interpret" | "lesson" | "digest";

export interface InterpreterCallBody {
  kind: InterpreterCallKind;
  request: InterpreterRequest;
  model: string;
  effort: EffortLevel;
}

export interface InterpreterCallOk {
  ok: true;
  kind: InterpreterCallKind;
  /** Validated response, lesson or digest, already checked server-side. */
  response: unknown;
  usage: InterpreterUsage;
  model: string;
  latencyMs: number;
  costEstimateMils: number;
  promptVersion: string;
}

export interface InterpreterCallError {
  ok: false;
  reason: string;
  status: number;
  category?: string | null;
}

export type InterpreterCallResult = InterpreterCallOk | InterpreterCallError;

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface CallOptions {
  path?: string;
  /** Injected in tests; the default waits with setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Upper bound on the Retry-After wait, in ms. */
  maxRetryWaitMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(header: string | null, cap: number): number {
  if (header === null) return 0;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.min(seconds * 1000, cap);
}

async function once(body: InterpreterCallBody, fetchImpl: FetchLike, path: string): Promise<{ result: InterpreterCallResult; retryAfter: string | null }> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (err) {
    return { result: { ok: false, reason: `could not reach the interpreter function: ${err instanceof Error ? err.message : String(err)}`, status: 0 }, retryAfter: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await res.text());
  } catch {
    return { result: { ok: false, reason: `interpreter function returned a non-JSON body (status ${res.status})`, status: res.status }, retryAfter: res.headers.get("retry-after") };
  }
  const retryAfter = res.headers.get("retry-after");
  if (typeof parsed === "object" && parsed !== null && (parsed as { ok?: unknown }).ok === true) {
    return { result: parsed as InterpreterCallOk, retryAfter };
  }
  const err = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Partial<InterpreterCallError>;
  return {
    result: {
      ok: false,
      reason: typeof err.reason === "string" ? err.reason : `interpreter function failed (status ${res.status})`,
      status: typeof err.status === "number" ? err.status : res.status,
      category: err.category ?? null,
    },
    retryAfter,
  };
}

/** Call the interpreter function. Retries once on 429, never on anything else. */
export async function callInterpreter(
  body: InterpreterCallBody,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  options: CallOptions = {},
): Promise<InterpreterCallResult> {
  const path = options.path ?? INTERPRETER_PATH;
  const sleep = options.sleep ?? defaultSleep;
  const cap = options.maxRetryWaitMs ?? 10_000;
  const first = await once(body, fetchImpl, path);
  if (first.result.ok || first.result.status !== 429) return first.result;
  await sleep(retryAfterMs(first.retryAfter, cap));
  const second = await once(body, fetchImpl, path);
  return second.result;
}
