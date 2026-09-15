/**
 * Browser client for the interpreter function. The browser never holds a key and never talks to the
 * provider: it posts a job to the background function and polls the result blob until the job
 * finishes, fails or the cap is reached.
 *
 * The POST is retried once, only on 429. Polling is not a retry: it is how a background job is read.
 */
import type { EffortLevel, InterpreterRequest, InterpreterUsage } from "./types";

export const INTERPRETER_PATH = "/api/interpret";
export const INTERPRETER_RESULT_PATH = "/api/interpret/result";

export type InterpreterCallKind = "interpret" | "lesson" | "digest";

export interface InterpreterCallBody {
  kind: InterpreterCallKind;
  request: InterpreterRequest;
  model: string;
  effort: EffortLevel;
  /** Idempotent job id: the interpreter event id for this bar, call kind, model and prompt version. */
  jobId?: string;
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

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface CallProgress {
  /** Milliseconds since the job was posted. */
  elapsedMs: number;
  /** What the job blob says right now, or "waiting" before the first blob exists. */
  status: "posted" | "waiting" | "running";
  polls: number;
}

export interface CallOptions {
  path?: string;
  resultPath?: string;
  /** Injected in tests; the default waits with setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Upper bound on the Retry-After wait for the POST, in ms. */
  maxRetryWaitMs?: number;
  /** Gap between result polls; default 2 s. */
  pollIntervalMs?: number;
  /** Give up after this long; default 6 minutes. */
  timeoutMs?: number;
  /** Called on every poll so the UI can show elapsed time. */
  onProgress?: (progress: CallProgress) => void;
  /** Injected in tests; the default reads the wall clock. */
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(header: string | null, cap: number): number {
  if (header === null) return 0;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.min(seconds * 1000, cap);
}

interface PostOutcome {
  /** Set when the POST itself failed in a way the caller must see. */
  error: InterpreterCallError | null;
  /** Set when a synchronous run answered with the finished job (local dev, tests). */
  finished: InterpreterCallResult | null;
  status: number;
  retryAfter: string | null;
}

async function postJob(body: InterpreterCallBody, fetchImpl: FetchLike, path: string): Promise<PostOutcome> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (err) {
    return {
      error: { ok: false, reason: `could not reach the interpreter function: ${err instanceof Error ? err.message : String(err)}`, status: 0 },
      finished: null,
      status: 0,
      retryAfter: null,
    };
  }
  const retryAfter = res.headers.get("retry-after");
  const raw = await res.text();
  let parsed: unknown = null;
  try {
    parsed = raw.length > 0 ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const asObject = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;

  // 202 is the normal answer: the job runs in the background and the result is polled.
  if (res.status === 202) return { error: null, finished: null, status: res.status, retryAfter };
  if (res.status === 200) {
    // A synchronous run (local dev or a test double) may answer with the finished payload itself.
    if (asObject.ok === true && "response" in asObject) return { error: null, finished: parsed as InterpreterCallOk, status: 200, retryAfter };
    return { error: null, finished: null, status: 200, retryAfter };
  }
  const reason = typeof asObject.reason === "string" ? asObject.reason : `interpreter function failed (status ${res.status})`;
  const status = typeof asObject.status === "number" ? asObject.status : res.status;
  return { error: { ok: false, reason, status, category: (asObject.category as string | null | undefined) ?? null }, finished: null, status: res.status, retryAfter };
}

interface JobView {
  status?: unknown;
  result?: unknown;
  reason?: unknown;
  httpStatus?: unknown;
  category?: unknown;
}

/**
 * Poll the result endpoint until the job finishes. A 404 means the blob does not exist yet, which is
 * normal for the first second or two.
 */
async function pollResult(jobId: string, fetchImpl: FetchLike, options: Required<Pick<CallOptions, "resultPath" | "pollIntervalMs" | "timeoutMs">> & CallOptions): Promise<InterpreterCallResult> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  let polls = 0;
  for (;;) {
    const elapsedMs = now() - startedAt;
    if (elapsedMs > options.timeoutMs) {
      return {
        ok: false,
        reason: `the model did not answer within ${Math.round(options.timeoutMs / 1000)} s; the job may still finish and can be read again`,
        status: 504,
      };
    }
    await sleep(options.pollIntervalMs);
    polls += 1;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(`${options.resultPath}?jobId=${encodeURIComponent(jobId)}`, { method: "GET" });
    } catch (err) {
      return { ok: false, reason: `could not reach the interpreter result endpoint: ${err instanceof Error ? err.message : String(err)}`, status: 0 };
    }
    if (res.status === 404) {
      options.onProgress?.({ elapsedMs: now() - startedAt, status: "waiting", polls });
      continue;
    }
    let blob: JobView;
    try {
      blob = JSON.parse(await res.text()) as JobView;
    } catch {
      return { ok: false, reason: `interpreter result endpoint returned a non-JSON body (status ${res.status})`, status: res.status };
    }
    if (res.status >= 400 && blob.status !== "failed") {
      const reason = typeof blob.reason === "string" ? blob.reason : `interpreter result endpoint failed (status ${res.status})`;
      return { ok: false, reason, status: typeof blob.httpStatus === "number" ? blob.httpStatus : res.status };
    }
    if (blob.status === "done") {
      const result = blob.result;
      if (typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === true) return result as InterpreterCallOk;
      return { ok: false, reason: "the job finished without a usable result", status: 502 };
    }
    if (blob.status === "failed") {
      return {
        ok: false,
        reason: typeof blob.reason === "string" ? blob.reason : "the interpreter job failed",
        status: typeof blob.httpStatus === "number" ? blob.httpStatus : 500,
        category: (blob.category as string | null | undefined) ?? null,
      };
    }
    options.onProgress?.({ elapsedMs: now() - startedAt, status: "running", polls });
  }
}

/**
 * Post one interpreter job and wait for its result. Retries the POST once on 429, then polls.
 * `body.jobId` makes the whole thing idempotent: re-posting a finished job never calls the model again.
 */
export async function callInterpreter(
  body: InterpreterCallBody,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  options: CallOptions = {},
): Promise<InterpreterCallResult> {
  const path = options.path ?? INTERPRETER_PATH;
  const resultPath = options.resultPath ?? INTERPRETER_RESULT_PATH;
  const sleep = options.sleep ?? defaultSleep;
  const cap = options.maxRetryWaitMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 6 * 60 * 1000;
  const jobId = body.jobId;
  if (typeof jobId !== "string" || jobId.length === 0) {
    return { ok: false, reason: "callInterpreter needs a jobId so the background job can be polled idempotently", status: 400 };
  }

  let post = await postJob(body, fetchImpl, path);
  if (post.error && post.error.status === 429) {
    await sleep(retryAfterMs(post.retryAfter, cap));
    post = await postJob(body, fetchImpl, path);
  }
  if (post.error) return post.error;
  if (post.finished) return post.finished;
  options.onProgress?.({ elapsedMs: 0, status: "posted", polls: 0 });
  return pollResult(jobId, fetchImpl, { ...options, resultPath, pollIntervalMs, timeoutMs });
}
