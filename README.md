# Campaign — futures signal observer, manual journal, paper console

A single-page research console for the "campaign" hypothesis: rank six futures markets by a
volume/breadth pressure score (model v0.1), journal actual manual fills, and run a deterministic
paper-trading engine under the same rules.

**Status: research tool, model v0.1, unvalidated.** Every number on screen comes from synthetic
fixture data. Nothing here is a probability of profit, a performance estimate, or a validated
strategy. No broker connection, no orders, no live market data, no credentials.

## Setup

- Node 22 (developed on v22.13.0), npm 10.
- `npm install`
- `npm run dev` — Vite dev server (opens the console; localStorage persistence is per origin).
- `npm test` — Vitest, single run.
- `npm run build` — TypeScript strict typecheck, then Vite production build to `dist/`.
- `npm run check` — typecheck + test + build in one command.
- `npm run preview` — serve the production build.

## Folder map (`src/`)

- `config/` — `modelConfig.ts`: versioned model parameters v0.1 (windows, thresholds, stop base, risk budget, cost fixture, interval options).
- `instruments/` — fixture `InstrumentMetadata` for NQ ES RTY YM ZN GC (tick, multiplier, tick value in mils, synthetic contract labels; 32nds stub).
- `numerics/` — `Ticks` (integer price ticks) and `Mils` (integer 1/1000 USD) with exact conversion and display formatting; no floats in price/money paths.
- `formula/` — pure model functions: Q, A, H, u, deltas, sigma (ddof=1, exactly 60 prior changes), both-side scores, qualification, `buildSignalSnapshot`, data-quality reasons.
- `breadth/` — `BreadthAdapter` interface, `EquityConstituentAdapter` (A/H from constituents with coverage rules), `UndefinedBreadthAdapter` (ZN/GC → `BREADTH_MODEL_UNDEFINED`).
- `ranking/` — observer ordering (qualified by S, then unqualified by displayed S, then neutral, then unavailable; alphabetical tie-break) and `topQualified`.
- `stops/` — SMA ATR20, stop distance D, initial stop with tick rounding, trailing ratchet, `effectiveAfter` timing, `closeRequired`.
- `sizing/` — modeled entry/stop-exit fills under the cost fixture, per-contract risk, integer risk budget, position size (margin not modeled).
- `campaign/` — event types, append-only reducer (FIFO lots, idempotent ids, corrections), P&L/flags helpers, manual-journal event constructors.
- `paper/` — deterministic paper engine: decision bar → PENDING, executable bar fill, OHLC stop simulation (gap vs touch, no same-bar hindsight), trailing, pause, stop-monitor health.
- `ledger/` — `Ledger` (per-mode append-only log with derived state), equity series, max drawdown, stats; `storage.ts` persistence with schema refusal.
- `fixtures/` — precomputed mockup snapshots (D1 bypass), synthetic histories for pipeline tests, synthetic demo bars for the paper demo.
- `app/` — React store (mode, ledgers, selection, drawers, versioned settings) and `plan.ts` (draft ticket plan from a snapshot).
- `ui/` — components: header, observer cards, trade ticket, results, drawers (formula, journal, settings, results details), How-it-works section; `console.css` tokens copied from the mockup.
- `content/` — `how-it-works.md`, the strategy explanation rendered below the fold (unchanged copy of the source document).

## What is fixture and what is real

Everything is fixture in this release. The boundaries are explicit so nothing synthetic can pass as real later:

- **Data source labels.** Every `SignalSnapshot` carries `dataSource.kind` (`fixture` | `replay` | `delayed` | `realtime`) and a label; the header and cards print "synthetic". Only `fixture` exists today.
- **Snapshots.** `src/fixtures/snapshots.ts` builds the six cards from the mockup's precomputed Q/A/H/uPrev/HPrev values, bypassing the history pipeline (the pipeline itself is tested from full synthetic histories in `src/fixtures/histories.ts`). ZN and GC carry Q only; their breadth is undefined and they are excluded from ranking and selection.
- **Sigma constants.** σΔu = 0.25 and σΔH = 0.10 are synthetic constants in the fixture snapshots (`inputSourceIds` include `fixture:sigma-constants:synthetic`). Real snapshots must compute them from 60 prior changes.
- **Contracts.** Instruments are labeled `NQ · SYNTHETIC` etc. with `expiry: null`. Production requires exact dated contracts.
- **Demo bars.** Paper mode's "Run paper step" feeds `src/fixtures/paperBars.ts`: four deterministic bars derived from the fixture close and ATR. They are not market data and produce no evidence of expectancy.
- **Cost fixture.** Fee 2500 mils ($2.50) per contract per side, spread 0 ticks, 1 adverse tick per fill (spread, when nonzero, is applied as additional adverse ticks). Labeled `source: "fixture"`.
- **Paper equity.** Starts at 1,000,000,000 mils ($1,000,000) (`paperEquityStartMils`). Risk budget 0.25% of current marked paper equity, recomputed before each new campaign.
- **Manual equity.** Not assumed. The user enters it in Model settings; it is recorded as an external cash flow in the manual ledger. Until then, % of equity shows an em dash.
- **Liabilities.** Carried as 0 in every equity point (field present, not modeled).

## Persistence

- localStorage keys: `fdt.v1.manual`, `fdt.v1.paper` (ledgers), `fdt.v1.config` (model settings).
- Ledger document: `{ schemaVersion: 1, mode, startingEquityMils, events: [...] }`. The log is append-only; state is derived by reducing events. Duplicate event ids are no-ops; corrections append a new event with `supersededEventId` and the original stays in the log.
- A stored ledger with an unknown `schemaVersion`, wrong mode, invalid JSON, or an invalid event is **refused with a reason**. The app shows a banner, runs with an empty in-memory ledger for that mode, and never overwrites or migrates the stored copy.
- Two tolerant reads (not migrations), applied in memory only; the stored document is left as is until the next save:
  - a stored `MARK` without `completedClose` is read as `true` when its source is `paper-observation-bar` (the engine's bar-close marks) and `false` otherwise (a mark of unknown kind never advances the trailing-stop reference);
  - a stored `ENTRY_FILL` without `side` takes the side of its campaign's `CAMPAIGN_QUEUED` event (old fills always matched the plan); if that queued event is absent the ledger is refused by event id.
- If localStorage is unavailable, an in-memory store is used and a banner says persistence is session-only.

## Model settings versioning

Editable in the Model settings drawer: entry threshold, directional-breadth threshold, stop base coefficient, risk budget fraction, A-small warning level. Saving writes a new label (`0.1+user1`, `0.1+user2`, …) to `fdt.v1.config`; windows (20/60/20) and the interval are fixed in v0.1. Every campaign stores a frozen copy of the config it was entered under; saving new settings never changes a running campaign.

## Phase 2: the interpreter layer

A model reads the calculator's output and proposes; it never computes a number and never executes.
`INTERPRETER_ADDENDUM.md` is the spec. Status is unchanged: research tool, fixture data, no broker.

**Division of responsibility.** The calculator owns Q, A, H, u, sigma, S, qualification, ATR, D and
ranking. The interpreter owns the reading of how a signal developed, cross-market context, a
hypothesis, a proposal and the evidence that would falsify it. The risk engine clamps every proposal.
A person (manual) or the deterministic paper engine executes. Sizing is always computed by code from
the clamped stop.

### The function is the only network path

- Browser → `/api/interpret` (`netlify/functions/interpret.ts`) → Anthropic. Nothing else calls out.
- `ANTHROPIC_API_KEY` is set on the Netlify site only, never in the repository and never in the
  browser. The SDK reads it from the environment; the code never passes it explicitly, logs it, or
  returns it. `npm run check:bundle` fails the build if the key prefix, the variable name or the SDK
  appears in `dist/`.
- The function refuses any model outside its allowed list (`claude-opus-5`, `claude-sonnet-5`,
  `claude-fable-5-1`), any effort outside `low | medium | high | xhigh | max`, any body over 512 KB and
  any method other than POST. It validates the model's JSON against the same schema the browser uses
  before returning it; a refusal, a truncated answer or a failed validation comes back as
  `{ ok: false, reason }` with status 422 and is logged as `INTERPRETER_REJECTED`.
- Defaults live in `modelConfig.interpreter`: model `claude-opus-5`, effort `high` for both decision
  and observation calls, prompt version `interp-0.1`, 10 bars of history, 20 proposal outcomes fed
  back, 30 lessons. Every campaign freezes a copy.

### Three ledgers

| Mode | Key | What it is |
|---|---|---|
| Manual journal | `fdt.v1.manual` | What you did at your broker. |
| Paper (rules) | `fdt.v1.paper` | The rules engine alone. **This is the control.** |
| Paper (model) | `fdt.v1.paperModel` | Model-assisted: the interpreter proposes, the risk engine clamps, the deterministic engine executes. |

They never mix. Comparing Paper (model) with Paper (rules) over the same bars is the only way the
interpreter's contribution can be measured, so the control is kept even when it looks redundant.

### Ask model vs a Paper (model) step (D22)

- **Ask model** is available in every mode and runs on that click only. It records
  `INTERPRETER_REQUEST` and `INTERPRETER_RESPONSE` (or `INTERPRETER_REJECTED`) in the active mode's
  ledger, shows the reading and the clamped proposal, and executes nothing. In manual mode the ticket
  then drafts from the proposal for that market; you still record your own fill.
- **Paper (model)** executes, and only on your click. "Start with a model reading" makes one decision
  call and queues the clamped entry; "Run paper step" runs the rules engine first (it owns the stop
  test), then asks whether to hold, tighten or exit. A tighten is written as a resting stop after the
  ratchet is re-checked; an exit becomes `CLOSE_REQUESTED`, never a fill. The **Model assist** toggle
  turns the calls off so the same ledger can run rules-only.
- Nothing runs on a timer. A repeated bar makes no second call: a stored response for that bar and
  call kind short-circuits it, and every event id is derived from bar, model and prompt version.

### Feedback loop and memory

Each request carries the last 20 proposals with outcomes computed from the ledger (executed, clamped,
rejected, fill, exit reason, realized R, bars held) and whether each invalidation condition the model
named appeared before the stop did. After a campaign closes the model writes a lesson
(`INTERPRETER_LESSON`); once more than 30 accumulate, older ones are compacted into an
`INTERPRETER_DIGEST`. Lessons and digests change only what the model reads: they cannot move a
threshold, a size, a stop bound or a candidate rule.

"Reset model memory" in the Model memory drawer **archives** the current epoch and starts a new one.
Nothing is deleted: every lesson stays in the append-only log under its epoch, and the reset itself is
an event (`INTERPRETER_MEMORY_RESET`).

### Cost estimates (D23)

Every call records input, cached-input and output tokens, the model id, latency and an estimated cost
in mils. The estimate uses a small price table in `src/interpreter/types.ts`
(`INTERPRETER_PRICE_TABLE`, per million tokens): Opus 5 15.00 input / 1.50 cached / 75.00 output;
Sonnet 5 3.00 / 0.30 / 15.00; Fable 5.1 30.00 / 3.00 / 150.00. Cache writes are counted as input and
only cache reads as cached input, so the figure is not understated. It is labeled **estimate**
everywhere it appears and is not billing data.

### What is still fixture in phase 2

- The 10-bar snapshot history (D21, `src/fixtures/snapshotHistory.ts`) is derived arithmetically from
  the existing fixture snapshot, labeled synthetic in `dataSource` and `inputSourceIds`. It is not
  market history.
- The paper demo bars (`src/fixtures/paperBars.ts`) are synthetic, as before.
- Sigma constants, cost fixture and synthetic contract labels are unchanged from phase 1.

### Local development

- `npm run dev` serves the console but **not** the function. "Ask model" then fails on the missing
  endpoint and records `INTERPRETER_REJECTED` with the transport reason; the rest of the console works.
- `netlify dev` serves both. It needs `ANTHROPIC_API_KEY` in your environment or a local `.env`
  (gitignored, never committed). No key is needed for anything except a live model call.
- `npm run check` runs typecheck, tests, build and the bundle check.


### Background job flow (P2.8)

Netlify synchronous functions stop at 60 seconds, which an Opus call with adaptive thinking can exceed. The interpreter therefore runs as a **background function**: `POST /api/interpret` validates the body, writes a job blob (`jobs/<jobId>`, Netlify Blobs store `interpreter`) with status `running`, returns `202` immediately, calls the provider, then writes `done` with the validated result or `failed` with a reason. The browser polls `GET /api/interpret/result?jobId=…` every 2 seconds (strong-consistency read) for up to 6 minutes and shows elapsed time. The `jobId` is the interpreter event id for that bar, call kind, model and prompt version, so a repeated request or a Netlify retry of a finished job never calls the model twice. The job blob never contains the request body, the key, or a raw exception.

## Missing before live data

Not built. Each item must exist and be verified before any real data source is connected:

1. Feed adapters: futures OHLCV per dated contract with a documented session cut-off; constituent volume and close series for A/H.
2. Dated contract metadata (tick, multiplier, expiry, exchange calendar, active-contract selection) and a versioned roll policy; continuous/back-adjusted series only with an explicit adjustment policy.
3. Point-in-time index membership history (survivor-bias-free) for NQ, ES, RTY, YM.
4. Researched breadth definitions and adapters for ZN and GC (today: `BREADTH_MODEL_UNDEFINED`).
5. Common signal cut-off and session calendar across all six markets; missing Treasury/gold data at the cut-off must invalidate comparison.
6. Stop-monitor feed at a finer interval than the signal interval, with a real health signal (today: healthy only when a demo bar was processed).
7. Margin and available-cash model (today: "Margin constraint not modeled").
8. Treasury 32nds quote parser/formatter (today: stubs that throw).
9. Real cost tables per instrument and broker (today: the synthetic cost fixture).
10. AI explanation layer. Not built. `explainSnapshot` in `src/ui/Observer.tsx` produces deterministic template text from the structured snapshot; no LLM is called and none can alter calculator outputs.
11. Real-data freshness rules (`STALE` reasons are wired but only fixture freshness exists).
12. Replayable signal history with outcomes. The interpreter reads 10 derived fixture bars today; any
    comparison of Paper (model) with Paper (rules) needs a real replay adapter over held-out periods.
13. A measured cost and latency record per model. The price table is an estimate from list prices; only
    invoices and a real call log can confirm it.
14. Evaluation of the feedback loop itself: the same sequences run with memory on and off, which needs
    the replay adapter above before any conclusion.
15. Provider retention and rate-limit posture for live use (the function retries a 429 once and maps
    every other error to a status; nothing is queued or resumed).

## Acceptance

See `ACCEPTANCE.md` for the brief's ten checks plus the phase-2 checks A11-A16, with test evidence.
