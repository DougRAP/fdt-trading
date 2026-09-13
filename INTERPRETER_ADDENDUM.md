# Addendum to CLAUDE_BUILD_BRIEF.md — Interpreter layer

Status: agreed design, not yet ticketed. Supersedes the brief's sentence "an LLM may summarize but cannot invent, overwrite, or approve missing inputs" as follows: the model may **interpret and propose**; it still may not invent, overwrite, or approve inputs, and it never computes money, ticks, sizing, or P&L.

## Division of responsibility

| Layer | Owns | Never does |
|---|---|---|
| Calculator (built) | Q, A, H, u, σ, S, qualification, ATR, D, ranking | Interpret sequences or context |
| Interpreter (new) | Reading of signal development, cross-market context, campaign hypothesis, proposals, invalidation evidence | Arithmetic, sizing, approving missing data, numeric confidence |
| Risk engine (built, to extend) | Clamps every proposal: qty, stop bounds, one position per mode, data validity | Originate proposals |
| Human (manual) / paper engine (paper) | Executes, records fills | Trust a proposal that the risk engine rejected |

## Interpreter input

One structured request per decision bar, assembled by code:

- Last N completed `SignalSnapshot`s for all six markets (default N = 10; config param). Includes UNAVAILABLE markets with reasons.
- Current position state per mode: campaign summary, proposed vs recorded stop, flags, bars held, R multiple.
- Bounds from the risk engine: allowed candidates, max stop distance (D-based), min stop distance (tick), budget, whether entries are permitted (paused, flat, data valid).
- Model config version and interpreter prompt version.
- No prices or money as floats; the request carries display strings and ticks side by side so the model never re-derives numbers.

## Interpreter output (strict JSON, validated before use)

```
{
  "promptVersion": "interp-0.1",
  "readings": [{
    "root": "NQ",
    "activity": "building" | "isolated" | "fading" | "unclear",
    "breadth": "broadening" | "concentrating" | "stable" | "unclear",
    "priceResponse": "responding" | "unresponsive" | "diverging" | "unclear",
    "noiseFlag": true | false,
    "evidence": ["short factual sentences citing snapshot fields and bar times"]
  }],
  "crossMarket": { "summary": "…", "supports": ["ZN", "GC"], "contradicts": ["RTY"] },
  "hypothesis": "what appears to be happening, one paragraph",
  "proposal": {
    "action": "enter" | "wait" | "hold" | "tighten" | "exit",
    "root": "NQ" | null,
    "side": 1 | -1 | null,
    "entryZone": { "lowTicks": n, "highTicks": n } | null,
    "stopTicks": n | null,
    "invalidation": ["evidence that would falsify the hypothesis"],
    "rationale": "…"
  },
  "evidenceStrength": "weak" | "moderate" | "strong"
}
```

Rules:
- Any field outside the enum, any number that is not a safe integer tick, or any reference to a market not in the request → the whole response is rejected and logged as `INTERPRETER_REJECTED` with the reason. No partial use.
- `evidenceStrength` is qualitative. The UI never renders it as a percentage or the word "confidence".
- The model never sees or emits dollar sizing. Sizing is computed by code from the clamped stop.

## Risk engine clamps (extend `sizing`/`stops`)

- `enter` allowed only for markets in `allowedCandidates`. Default candidate set = qualified markets. A config flag `interpreterMayEnterBelowThreshold` (default false) widens it to WAIT markets with S above a floor (`interpreterCandidateFloor`, default 0.5). This flag is the core experiment and must be recorded in every campaign's frozen config.
- Proposed stop clamped to [entry − maxD, entry − minTick] for longs (mirror for shorts). Clamped value and original both logged.
- `tighten` may only move a stop in the ratchet direction. `exit` produces CLOSE_REQUESTED, not a fill.
- Paused engine, stale data, or UNAVAILABLE snapshot for the proposed root → proposal logged, not executed.

## Logging and audit

- New ledger events: `INTERPRETER_REQUEST` (hash of request, N, prompt version, model id), `INTERPRETER_RESPONSE` (full JSON), `INTERPRETER_REJECTED`, `INTERPRETER_CLAMPED` (before/after). All carry ids derived from bar end + model id so repeats are idempotent.
- Every campaign entered on a proposal stores the response id in its frozen record.
- Manual mode: proposal shown in the ticket as "Model reading"; user still records actual fills. Paper mode: engine executes the clamped proposal.

## Evaluation protocol

- Two paper ledgers per model under test: `rules-only` (existing engine) and `model-assisted`, run over the identical bar sequence with identical costs.
- Compare net realized, max drawdown, exposure, proposal rejection rate, and how often invalidation evidence appeared before the stop did.
- Requires replayable signal history with outcomes → data feeds and replay adapter come before any model comparison. Interface can be built on fixtures now; conclusions wait for data.
- Model selection deferred. Interface is model-agnostic (provider, model id, prompt version are config). Compare candidates on the same sequences; cost and latency recorded per request.

## Deployment constraints

- Provider key lives in a Netlify function environment variable. Browser calls the function; function calls the provider. No key, prompt, or provider response is cached in the browser beyond the ledger event.
- Function validates the JSON schema server-side before returning.

## Decisions (user, 2026-09-12)

1. **Cadence:** interpreter runs on every decision bar (all actions) and on every stop-monitor observation for `hold` / `tighten` / `exit` only. Entries are never proposed from an observation.
2. **Discretion:** on. `interpreterMayEnterBelowThreshold` defaults to true and `interpreterCandidateFloor` defaults to null (no S floor). Candidate set = every market with an available snapshot. The formula is a lens the model reads, not a gate. Product intent restated: this is a recommendation console that uses a formulaic measurement layer so the model can analyze quickly and recommend; the trade ticket exists to record what the human did, not to be the product.
3. **History:** N = 10 bars, aggregate A/H only. Constituent detail stays in the data layer.
4. **Manual UX:** the model reading is shown before market selection, as a panel above the ticket. Selecting a market drafts the ticket from the model's proposal when one exists for that market, else from the calculator plan.

Consequences for the risk engine: clamps in the "Risk engine clamps" section still apply in full. Discretion widens which markets may be proposed; it does not loosen stop bounds, sizing, one-position rule, or data-validity gates. Rules-only paper ledger is still kept as the control for evaluation.

## Feedback loop (user, 2026-09-13: "constantly learning, top tier AI")

The model does not retrain. "Learning" is implemented as a bounded, auditable feedback loop from the ledger into every request.

- **Outcome feedback.** Every request carries the model's last K proposals (default K = 20) with their outcomes from the ledger: executed or clamped or rejected, fill, exit reason, realized R, bars held, and whether the invalidation evidence it named appeared before the stop was hit. Computed by code, never self-reported.
- **Lessons record.** After each closed campaign (and on demand) the model writes a structured note: `{ campaignId, whatHeld: [], whatFailed: [], weighDifferently: [], evidenceToWatch: [] }`. Stored as ledger event `INTERPRETER_LESSON` (idempotent id from campaign id + model id + prompt version). The last N lessons (default N = 30) are included in the next request. Older lessons are compacted by the model into a single `INTERPRETER_DIGEST` event when N is exceeded; the digest is versioned and the originals stay in the log.
- **Hard boundary.** Lessons and digests change only what the model reads. They cannot modify thresholds, sizing, stop bounds, candidate rules, or config. The risk engine clamps every proposal exactly as before. The rules-only paper ledger remains the control.
- **Audit.** Lessons and digests are shown in the Journal drawer and in a "Model memory" panel, with the prompt version and model id that produced them. A "Reset model memory" action archives (never deletes) the current lessons and starts a new memory epoch, recorded as an event.
- **Evaluation.** Model-assisted results are compared with and without the feedback loop (memory epoch on/off) on identical sequences, so the loop's contribution is measured, not assumed.

## Model defaults (user, 2026-09-13, revised for cost)

- Decision interpreter and observation monitor: `claude-opus-5`, adaptive thinking (on by default), `output_config.effort` "high"; structured outputs for the JSON contract; no prefill, no forced tool choice.
- Evaluation comparison candidate: `claude-sonnet-5` (same feature set, about 40% of the cost). `claude-fable-5-1` only if evaluation shows Opus 5 missing something (about 2x Opus cost; requires 30-day data retention on the org).
- Not used: Haiku 4.5 (no adaptive thinking, no effort control).
- Model id, effort, and prompt version are config, frozen per campaign.
- Cost order of magnitude at daily cadence, before prompt-cache savings: Opus 5 about 0.15 USD per decision bar and 0.05 per observation tick (about 4.50 USD/month); Sonnet 5 about 0.06 / 0.02 (about 1.80 USD/month). Intraday cadence multiplies these by the bar count, which is the real reason to keep the model configurable.
