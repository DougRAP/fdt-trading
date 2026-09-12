# FDT Trading — Phase 1 tickets (master: fdt-trading-84, maker: fdt-trading-67)

Source of truth: CLAUDE_BUILD_BRIEF.md, STRATEGY_EXPLANATION.md, campaign-mockup.html, plus decisions below.
Phase 1 = local dev, fixture data, empty ledgers, math correct + tested. No feeds, no git, no DB, no deploy.

## Decisions (resolved after brief)

- D1 Fixture depth: pure functions compute from full histories; a separate precomputed snapshot fixture (mockup values) drives the UI and acceptance check #2. Snapshot bypass lives only in fixtures/tests/demo.
- D2 ATR20 = mean of TR over bars t-19..t inclusive; first TR uses close t-20. SMA, not Wilder.
- D3 Trailing D recomputed each later completed signal bar from that bar's ATR20 and H. Entry uses decision snapshot D. Ratchet never widens. Missing inputs: keep last valid stop + DATA STALE alert. New stop effective only after its calc timestamp.
- D4 Cost fixture (synthetic, configurable per instrument): fee $2.50/contract/side ($5 round trip); spread 0 ticks; adverse adjustment 1 tick per fill (buy +1 tick, sell -1 tick vs reference; gap-through-stop uses open as reference). Per-contract risk = |modeled entry fill - modeled stop-exit fill| x multiplier + both-side fees. Entry adjustment counted once.
- D5 Paper equity start $1,000,000 (configurable). Budget 0.25% of current marked paper equity, recomputed before each new campaign. qty = floor(budget / perContractRisk); 0 => skip.
- D6 ZN/GC: show Q when computable; A/H/u/S UNAVAILABLE reason BREADTH_MODEL_UNDEFINED; excluded from selection and rank.
- D7 σ needs exactly 60 valid prior changes (ddof=1), else UNAVAILABLE with specific shortfall text. No fallback.
- D8 Unqualified display: H-aligned side's S (may be negative); rank valid unqualified by that S desc, below qualified. H=0 => Neutral, no rank, both S in details.
- D9 Margin/available-cash: NOT modeled in v1. Label "Margin constraint not modeled" wherever sizing is shown.
- D10 "Use selected market" example mode: build the control; under fixture data it shows unavailable with reason "synthetic snapshot has no timestamp or dated contract".
- D11 How-it-works content: markdown file (from "# How this strategy works" down) rendered at runtime with react-markdown + remark-math + rehype-katex, all npm-local.
- D12 Persistence: localStorage, separate keys per mode. Fixture ledgers start empty.
- D13 Stack: Vite + React 18 + TypeScript strict + Vitest. No UI lib. No CDN.
- D14 Numerics: prices as integer ticks (per-instrument tick size); money as integer mils (1/1000 USD) so ZN tick value 15.625 stays exact. Display rounds to cents. No floats in price/money/ledger paths. Statistical inputs (Q, A, H, u, σ, S) are plain numbers with finite checks.
- D15 Contracts in fixtures labeled e.g. "NQ · SYNTHETIC" (no dated contract). Production requires dated contracts.
- D16 All model params in one versioned modelConfig (v0.1). Every campaign stores a frozen copy.

## Maker rules (ticket 0)

- One ticket at a time. Touch only files the ticket names or the folders it creates.
- No deletes/renames outside ticket scope without asking master.
- No extras, no refactors of prior tickets, no proposing next steps.
- Report format: files created/changed, `npm test` output tail, anything you could not do. Nothing else.
- Preserve model's unvalidated status in every user-facing string: "score", never "probability"/"confidence".

## Tickets

### T1 Scaffold + numerics + config
- Vite React+TS in this folder (project root = this folder). Strict TS. Vitest configured (`npm test` runs once, non-watch).
- `src/config/modelConfig.ts`: version "0.1", volumeWindow 20, sigmaWindow 60, entryThreshold 1.00, breadthThreshold 0.40, atrWindow 20, stopBase 1.5, riskBudgetPct 0.0025, paperEquityStartMils, cost fixture per D4, aSmallWarn 0.10 (labeled research param), interval "daily", intervalOptions [daily(enabled), hourly(disabled), 5m(disabled)].
- `src/instruments/metadata.ts`: InstrumentMetadata per brief for NQ ES RTY YM ZN GC (tick, multiplier, tick value in mils, currency, exchange, quote format, metadataSource "fixture", contract label per D15). ZN quote format "32nds" with parser/formatter stub that throws NotImplemented (label only).
- `src/numerics/ticks.ts`, `src/numerics/money.ts`: types Ticks, Mils; toTicks/fromTicks with rounding mode (floor/ceil), ticks x multiplier -> Mils, format helpers. Tests.
- Acceptance: `npm run build` and `npm test` pass; runtime deps only react/react-dom.

### T2 Formula v0.1 + breadth adapter + ranking
- `src/formula/`: pure functions computeQ, computeA, computeH, computeU, deltas, sigma (ddof=1, requires exactly N valid), scoreBothSides, qualify, buildSignalSnapshot(histories) -> SignalSnapshot with every field in brief incl. dataQuality reasons.
- Unavailable reasons enum: INSUFFICIENT_VOLUME_HISTORY, INSUFFICIENT_SIGMA_HISTORY(n/60), ZERO_SIGMA, A_ZERO, COVERAGE_BELOW_95, STALE, NONFINITE, BREADTH_MODEL_UNDEFINED, INVALID_PRICE. Warn flag A_SMALL.
- `src/breadth/BreadthAdapter.ts` interface (source, definitionVersion, coverage, A, H, valid, reasons) + EquityConstituentAdapter (from constituent arrays) + UndefinedBreadthAdapter for ZN/GC.
- `src/ranking/rank.ts` per D8 + brief ordering; unavailable unranked; tie-break root alpha.
- Fixtures: `src/fixtures/snapshots.ts` = mockup values as precomputed SignalSnapshots (NQ ES RTY YM full; ZN GC with Q only). `src/fixtures/histories.ts` = small synthetic histories for pipeline tests.
- Tests: acceptance #2 exactly (u 3.0, v 2.4, p 2.2, S 2.2, long qualifies); short mirror from STRATEGY_EXPLANATION; H=0 neutral; each unavailable reason; ranking order; sigma shortfall 59/60 fails.

### T3 Stops + sizing
- `src/stops/`: trueRange, atr20 (D2), stopDistance D, initialStop with tick rounding (long floor, short ceil), trailStop ratchet (D3), effectiveAfter timestamp, closeRequired(stop vs current executable), frozen-stop-on-missing-input.
- `src/sizing/`: perContractRisk (D4), positionSize (D5), margin label (D9).
- Tests: D=52.5; long entry 22000.25 stop 21947.75 exit 21947.50 risk 1,060,000 mils; 2 contracts at $2,500; trailing 22034 then 22049 then no-loosen; short mirror 22052.25 / 21966; rounding never increases ratcheted distance; qty 0 skip; newly computed stop not applied to same bar's low/high.

### T4 Campaign state machine + paper engine + ledgers + persistence
- `src/campaign/`: Campaign, OrderEvent, AccountEquityPoint records per brief; state machine DRAFT->PENDING->OPEN->CLOSED with partial fills/exits reconciling remaining size and realized P&L; realized R vs frozen original risk; corrections via supersededEventId; idempotency by event id.
- `src/paper/engine.ts`: at completed decision bar while flat queue top qualifying+sizeable; fill at next executable bar with D4 adjustments; OHLC stop sim: gap past stop -> open + adverse tick; touched -> stop + adverse tick; same-bar ambiguity resolved conservatively; new close-based stops applied only afterward; pause flag stops entries not stop monitoring; stop-monitor health field.
- `src/ledger/`: separate manual/paper ledgers; localStorage persistence (D12) with versioned schema; equity series + max drawdown from marked equity vs running peak (incl. open); stats with sample counts; em-dash when no data.
- Tests: acceptance #7 (separation across mode switch + reload, repeated bar event no duplicate fill, partial exit reconciles), #8 (stale mark labels, missing inputs block new decision but keep stop), #9 (realized uses fills+fees, drawdown from equity series), gap/touch/same-bar cases.

### T5 Console UI (above the fold)
- Layout per brief + mockup: header (title, Manual journal / AI paper switch, interval select with disabled options, data timestamp+freshness, model v0.1, "ILLUSTRATIVE DATA · No market connection"), 50/50 columns 16px gap, left observer 6 cards, right ticket + results. 1440x900 and 1280x800 fit; <=760px stacks; no text shrinking.
- Cards: all fields in brief; compact labels; expand for definitions/raw inputs; click selects draft only; pinned ticket when open; unavailable = em dash + reason; agent status line (one line, no animation); WAIT when strongest fails.
- Ticket: empty/plan/open states per brief; planned vs actual separated; "Record entry fill" primary; deviation reason field; broker stop recorded vs proposed + discrepancy; flags DATA STALE / STOP UPDATE NEEDED / STOP BREACHED—VERIFY BROKER / CLOSE REQUIRED / EXIT RECORDED; % of equity; margin label D9.
- Results: summary row + 6-row table + details drawer (win rate w/ n, mean R, costs, exposure, deviations); period+mode label; em dashes.
- Drawers/dialogs: formula details, journal history, model settings with versioned save (never mutates running campaign).
- Paper mode: Start/Pause with status visible; "Run paper step" demo on fixture bars only, labeled synthetic.
- A11y: keyboard selection, aria-pressed, labels; side/qualification never color-only. light-dark theme tokens copied from mockup verbatim. Tabular nums.
- UI consumes snapshots/events from T2–T4 only; no ad hoc math in components.

### T6 How it works (below the fold)
- `src/content/how-it-works.md` = STRATEGY_EXPLANATION.md from "# How this strategy works" down, unchanged.
- Render per D11; header nav link "How it works" anchors to it; derivations + future research in details elements; every worked example labeled "Illustrative — synthetic inputs".
- "Use selected market" control per D10.

### T7 README + acceptance run
- README: setup, scripts, folder map, what is fixture vs real, list of missing live-data dependencies (feeds, dated contracts, membership history, ZN/GC breadth, stop-monitor feed, margin).
- Walk the 10 acceptance checks; report pass/fail per check with evidence (test name or manual step).
