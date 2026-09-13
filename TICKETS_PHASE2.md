# Phase 2 — Interpreter (master: fdt-trading-61, maker: fdt-trading-92 on Opus)

Spec: INTERPRETER_ADDENDUM.md (all sections, including Decisions, Feedback loop, Model defaults). Phase 1 rules in TICKETS.md "Maker rules (ticket 0)" still apply. Maker is on a token budget: read only the files each ticket names, no exploratory reads, no refactors outside scope, one report per ticket in the same format as phase 1.

## Phase 2 decisions

- D17 Invalidation is structured so code can evaluate it: `{ kind: "S_below" | "H_below" | "u_falls_below" | "price_reverses" | "breadth_concentrates" | "cross_market", root, threshold: number | null, note: string }`. `feedback.ts` checks each condition against the snapshots that followed the proposal and reports `appearedBeforeStop: true | false | null` (null when not evaluable, e.g. cross_market or note-only).
- D18 Ledger modes: `"manual" | "paper" | "paperModel"`. `paper` stays the rules-only control. `paperModel` is the model-assisted ledger with its own key `fdt.v1.paperModel`. UI labels: "Manual journal", "Paper (rules)", "Paper (model)". Storage refuses a stored mode mismatch as before.
- D19 Interpreter config lives in modelConfig under `interpreter`: `{ provider: "anthropic", model: "claude-opus-5", effortDecision: "high", effortObservation: "high", promptVersion: "interp-0.1", nBars: 10, feedbackK: 20, lessonsN: 30, mayEnterBelowThreshold: true, candidateFloor: null, allowedModels: ["claude-opus-5", "claude-sonnet-5", "claude-fable-5-1"] }`. Frozen per campaign like the rest.
- D20 The function is the only network path. Browser → `/.netlify/functions/interpret` → Anthropic. The function never trusts the browser's model choice outside `allowedModels`. Key from `process.env.ANTHROPIC_API_KEY` only.
- D21 Fixture history: `src/fixtures/snapshotHistory.ts` derives 9 prior synthetic snapshots per market deterministically from the existing fixture snapshot (small drifts in Q, H, u), labeled synthetic in dataSource and inputSourceIds, so N = 10 requests can be built without feeds.
- D22 Interpreter runs only on explicit user action ("Ask model") in fixture mode. Paper (model) engine calls it on decision bars and observation bars only when the user has pressed "Run paper step" and the "model-assisted" toggle is on. No background calls.
- D23 Every call records usage (input, cached input, output tokens), model id, latency, and an estimated cost in mils computed from a small price table in config (labeled "estimate"). Shown in the Model reading panel and summed in Results details.

## Tickets

### P2.1 Contract + validation (pure, no network)
- `src/interpreter/types.ts`: InterpreterRequest (promptVersion, modelConfigVersion, mode, decisionBar | observation, markets: per root the last nBars snapshots in display form (strings) plus ticks side by side, position state, bounds {allowedCandidates, maxDTicks per root, minTicks, entriesPermitted, reason}, feedback: last K proposal outcomes, lessons: last N, digest | null), InterpreterResponse per addendum with D17 invalidation, Lesson, Digest.
- `src/interpreter/schema.ts`: JSON Schema objects for response, lesson, digest (used both for structured outputs and runtime validation). Hand-written validator `validateResponse(json, request)` returning `{ ok, value }` or `{ ok: false, reason }`; rejects unknown enum values, non-safe-integer ticks, roots not in request, inconsistent action/root/side/stop combinations (e.g. enter with root null), missing required fields. No new deps.
- `src/interpreter/buildRequest.ts`: builds the request from snapshot histories, ledger state, bounds and cfg. Display strings via ui/format helpers; ticks retained.
- Tests: schema acceptance of a full valid response; each rejection path; buildRequest on fixture data produces nBars per market and correct bounds (maxD from stops.stopDistance, entriesPermitted false when paused/active/stale).

### P2.2 Clamps + ledger events + config
- modelConfig `interpreter` block (D19), frozen with campaigns.
- `src/interpreter/clamp.ts`: clampProposal(response, request, cfg) returning { executable: ClampedProposal | null, events, reasons }. Rules per addendum "Risk engine clamps" plus Decisions 1–2: candidate set with discretion; stop clamp to [entry−maxD, entry−minTick] long / mirror short with both values logged; tighten only in ratchet direction; exit → CLOSE_REQUESTED; paused/stale/unavailable → logged not executed; observation calls may not produce enter.
- Ledger: event types INTERPRETER_REQUEST (requestHash, promptVersion, model, nBars, mode), INTERPRETER_RESPONSE (responseId, full JSON, usage, latencyMs, costEstimateMils), INTERPRETER_REJECTED (reason), INTERPRETER_CLAMPED (before/after), INTERPRETER_LESSON, INTERPRETER_DIGEST, INTERPRETER_MEMORY_RESET (epochId). Ids derived from bar end + model + promptVersion (idempotent). Reducer stores: latest response per bar, lessons list, digest, memory epoch, per-campaign `interpreterResponseId`. Mode `paperModel` (D18) with storage key and validation shape entries.
- Tests: each clamp rule with a failing input; idempotent duplicate response; campaign frozen record carries responseId; stored paperModel ledger round-trips.

### P2.3 Feedback loop
- `src/interpreter/feedback.ts`: outcomesForLastK(ledger, snapshotsByBar, K) → per proposal {responseId, action, root, side, executed|clamped|rejected, fill, exitReason, realizedR, barsHeld, invalidation: [{condition, appearedBeforeStop}]}; D17 evaluation against subsequent snapshots.
- `src/interpreter/memory.ts`: lessonsForRequest(ledger, N), digestNeeded(ledger, N), buildLessonRequest(campaign, ledger), buildDigestRequest(lessons), resetMemory(ledger, at) (archives current epoch, new epochId).
- Tests: outcome computation on a synthetic closed campaign; invalidation evaluable and non-evaluable; digest trigger at N+1; reset keeps prior lessons in the log with the old epoch.

### P2.4 Netlify Function
- `netlify/functions/interpret.ts` (TypeScript, `@anthropic-ai/sdk`): POST body { kind: "interpret" | "lesson" | "digest", request, model, effort }. Validates body shape; model must be in allowedModels (server-side copy); builds messages with a versioned system prompt from `src/interpreter/prompt.ts` (shared with tests) plus the how-it-works markdown as cached prefix (`cache_control` ephemeral on the system block); user turn = JSON request; `output_config.format` = JSON schema from P2.1; adaptive thinking; `output_config.effort` from body; `max_tokens` 16000; timeout 60s. Server-side validateResponse before returning. Returns { ok: true, response, usage, model, latencyMs } or { ok: false, reason, status }. Errors: typed SDK errors mapped to status + message; never returns the key or raw exception. Refusal stop_reason → { ok: false, reason: "refusal", category }.
- `netlify.toml`: functions directory + node bundler esbuild. package.json: add `@anthropic-ai/sdk` and `@netlify/functions` types.
- `src/interpreter/client.ts`: browser client `callInterpreter(body)` returning a typed result, with an injectable fetch for tests.
- Tests: handler with an injected fake Anthropic client (constructor param or module factory): valid path, invalid model, malformed body, refusal, SDK RateLimitError → 429 mapping. No real network in tests.

### P2.5 Paper (model) engine + fixture history
- D21 fixture history module + test.
- `src/paper/modelEngine.ts`: wraps engine.ts: on decision bar, build request → call interpreter (injected) → validate → clamp → if executable enter, queue with the clamped stop (size from clamped stop via sizing) and store responseId; on observation bar, after the rules stop test, call interpreter with observation mode → hold/tighten/exit → apply via existing STOP_SET (ratchet-only) or CLOSE_REQUESTED. After a campaign closes, request a lesson and append INTERPRETER_LESSON. Rules-only `paper` engine untouched.
- Store: paperModel ledger loaded/saved; "Ask model" action for manual mode (request from current snapshot history, records events in the manual ledger, no execution); model-assisted toggle for paper steps (D22); usage/cost accumulation (D23).
- Tests with a fake interpreter returning canned responses: enter path with clamp, tighten path, exit path, rejected path leaves ledger unchanged except REJECTED event, lesson appended on close, idempotent on repeated bar.

### P2.6 UI
- Header mode switch: three modes per D18.
- `src/ui/ModelReading.tsx` above the ticket (Decision 4): per-market readings (activity/breadth/priceResponse/noise plus evidence), cross-market, hypothesis, proposal (action, root, side, entry zone, stop, invalidation list), evidence strength as a word, model id + prompt version + usage + cost estimate, "Ask model" button (disabled while a call is in flight, shows elapsed time), rejected/clamped notices with reasons. Ticket drafts from the proposal when one exists for the selected market (Decision 4).
- `src/ui/ModelMemory.tsx` drawer: lessons (newest first), digest, epoch id, "Reset model memory" (archive, confirm dialog). Journal drawer lists interpreter events (request hash, response id, clamped before/after, rejected reasons). Results details: interpreter usage totals and cost estimate for the period.
- Strings: never "confidence"/"probability" (evidence strength words only); everything from fixtures labeled synthetic; smoke test extended.
- Layout: the console must still fit at 1440×900 and 1280×800 with the panel collapsed to a two-line summary by default (expand for detail); master verifies in Chromium.

### P2.7 Docs + verification
- README: phase 2 section (function, env var, modes, memory, costs, what is still fixture). ACCEPTANCE.md: new checks A11–A16 (schema rejection, clamps, idempotency, memory boundary, key never in browser bundle: grep dist for "sk-ant" must be empty, no background calls). `npm run check` green. Master runs the live function once against the deployed site and records the result.
