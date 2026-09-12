# Campaign — Claude Code build brief

Build a single-page futures signal observer, manual trade journal, and automated paper-trading console. Use the accompanying `campaign-mockup.html` as an interactive layout reference. It contains synthetic data and a short demonstration sequence, not a trading engine or backtest. No current quotes, historical performance, probabilities, or optimized parameters are supplied.

## Product intent

The user works in campaigns: observe, hypothesize, select, enter, hold, retreat. Identify increasing participation and directional pressure across destinations for growth and defensive demand. Rank six markets, require an absolute entry threshold, and maintain at most one open position per mode. People execute their own real trades and record fills. In paper mode, software applies the exact same signal rules to simulated execution.

The fluid analogy is a research hypothesis. Its market inputs are proxies, not physical pressure measurements or evidence of conserved capital flow. The proposed formula and stops are not validated. Do not advertise a 20% return, low drawdown, calibrated confidence, or safe trade classification. Defer interval optimization until data and tests exist.

## Layout

Desktop target: 1440 × 900, also verify 1280 × 800. A compact header plus a two-column workspace should fit above the fold in the default state. No sidebar, marketing hero, chat transcript, or secondary navigation page. Equal 50% columns with a 16px gap. Left: one full-height observer panel containing six stacked selectable market cards. Right: two approximately equal-height panels: trade ticket/position above, campaign results below. On narrow screens, stack observer, position, results; never shrink text to preserve the desktop arrangement. Formula details and journal history can open a drawer/dialog. They need not fit above the fold when opened.

Use restrained product styling, readable tabular numbers, subtle surfaces, one accent for selection, and explicitly labeled states. Color alone must not communicate side, qualification, or urgency. A dark or light theme should remain legible. Follow the reference's spacing and hierarchy; its exact typography is not mandatory.

Header: Campaign title; Manual journal / AI paper mode switch; signal interval; data timestamp and freshness; model version. Daily is provisional. Other interval choices may be visible but must be disabled until supported by complete, aligned datasets. Do not imply changing a dropdown optimizes the strategy.

## Universe

| Root | Instrument | Intended coverage |
|---|---|---|
| NQ | E-mini Nasdaq-100 | Growth and technology demand |
| ES | E-mini S&P 500 | Broad corporate profits |
| RTY | E-mini Russell 2000 | Small-cap growth |
| YM | E-mini Dow | Established blue-chip businesses |
| ZN | 10-year Treasury note | Government debt / duration |
| GC | Gold | Monetary / geopolitical demand |

YM remains equity exposure; ZN and GC do not guarantee safety. Show all six even when inputs are missing. In production, use verified instrument metadata and exact dated contracts, not roots alone: multiplier, tick size/value, quote convention, currency, expiry, exchange calendar, active-contract selection, roll rules, and supported order types. Treasury fractional quotations need a parser/formatter. The mockup's decimal examples are not a complete contract specification. No broker orders or credentials in v1.

## Observer: left half

Every stacked card shows rank, symbol/name, candidate side, qualification, numeric signal S, normalized volume Q, breadth A, velocity proxy u, directional breadth H, velocity-change component, pressure-change component, and snapshot timestamp/freshness. Compact labels are always visible; definition and raw-input details are available on selection or expansion. Clicking selects a draft; it never creates a position. When a position is open, keep its ticket pinned; inspecting other markets should use details rather than silently changing the active position.

Default ordering: qualified first by descending S, then valid but unqualified by descending S, then unavailable. Tie-break by root alphabetically. Preserve selection while new snapshots arrive. Unavailable markets show an em dash and a specific reason; they are not assigned numerical ranks. No forced trading: the strongest signal may still be WAIT. Score is not a probability.

The agent status is one compact line: latest completed calculation, markets evaluated, qualified count, and data problems. Avoid an endlessly animating 'AI thinking' display. AI commentary must reference the structured snapshot and give short factual explanations such as 'Volume acceleration passes; directional breadth is below threshold.' A deterministic calculator owns every numeric result and trade decision; an LLM may summarize but cannot invent, overwrite, or approve missing inputs.

## Exact research formula, version 0.1

Use only completed, synchronized bars and data available at decision time. Retain the source bar and input-history identifiers. Subscript t means the current completed bar. Prior windows exclude t.

For each equity index:

- V_t: actual traded contracts during the defined signal session, using the versioned roll-aware volume policy.
- Q_t = V_t / mean(V_{t-20}, ..., V_{t-1}).
- A_t: count of valid point-in-time constituents with volume greater than their own preceding 20-bar mean, divided by valid constituent count. Require >=95% coverage of the point-in-time membership universe. Report coverage and exclusions. A is unsigned activity breadth.
- H_t = (count of constituents with positive close-to-close returns − count with negative returns) / valid constituent count. Unchanged constituents remain in the denominator. H ranges from -1 to +1. This is the proposed herding proxy; standard regression beta is not H.
- u_t = Q_t / A_t.
- Δu_t = u_t − u_{t-1}; ΔH_t = H_t − H_{t-1}.
- σΔu,t and σΔH,t: sample standard deviations of the preceding 60 respective changes, excluding the current change; use ddof=1.
- For d = +1 (long) or -1 (short), S_d,t = min(Δu_t / σΔu,t, d × ΔH_t / σΔH,t).
- Candidate qualifies if S_d,t > 1.00, d × H_t >= 0.40, and d × (close_t − close_{t-1}) > 0, with all inputs valid and fresh.
- Evaluate both directions. At most one can pass directional breadth. For display when neither qualifies, choose the side aligned with nonzero H; if H=0, show neutral/unqualified and both component scores in details.

No logarithmic transforms or 0–100 score conversion without a new model version. Daily differences above are per-bar changes. If interval changes later, re-estimate histories on that interval and use same-time-of-session volume baselines intraday; daily thresholds are not automatically portable.

Missing/zero denominators, insufficient history, A=0, stale/misaligned source data, unknown membership, and invalid prices produce UNAVAILABLE with an explicit reason. Reject nonfinite values; do not plug in an arbitrary epsilon, forward-fill unlimited gaps, or silently count missing constituents as unchanged. Warn when A is unusually small because the ratio can become unstable; any additional exclusion threshold is a future research parameter, not silently inserted.

ZN and GC: the constituent breadth formula is currently undefined for these assets. Implement a `BreadthAdapter` interface with source, definition version, coverage, A, H, and validity fields. Until a researched adapter is explicitly configured, return `BREADTH_MODEL_UNDEFINED`, leave A/H/u/S blank, and exclude from selection. Build and display all six cards now; do not manufacture Treasury/gold scores to make the UI look complete. Cross-asset score comparability is a hypothesis requiring validation even after adapters exist.

Baseline windows and thresholds are editable in model settings with a versioned save action. Never silently change a running campaign's parameters. Store a frozen snapshot with every entry.

## Position ticket: upper right

Empty state: highest qualifying candidate preselected while flat, but no automatic manual entry. If none qualify, show 'No qualifying trade'. User may inspect another market. Show instrument and dated contract, side (buy/long or sell/short), contracts, planned entry, proposed initial stop, point/tick distance, percent of entry, dollar risk, and percentage of account equity. Allow actual manual fills to be recorded even if they differ from the model, with an explicit deviation reason. Do not block truthful journaling of an existing trade merely because it violated a strategy threshold.

Separate planned values from actual fills. Primary manual action is 'Record entry fill', never 'Buy now' or 'Execute'. Capture exact contract, side, quantity, actual fill price/time/timezone, entry fees, and actual broker stop status/price. A draft is not a fill. Do not mark a trade closed when a stop is merely touched or an alert is acknowledged. Partial fills/exits must be modeled in production even if the first screen uses a single average fill entry.

Open state: pinned position, current mark and its timestamp, average entry, original risk, unrealized P&L, realized P&L, total fees, current R multiple, proposed trailing stop, recorded broker stop, and their discrepancy. If the feed is stale, label the mark/P&L stale. The mockup has no mark feed and therefore does not invent changing live P&L for manual entries.

Stop model:

- ATR20 = arithmetic mean of preceding 20 completed true ranges including signal bar t; TR = max(high-low, abs(high-prevClose), abs(low-prevClose)). Name this SMA ATR explicitly rather than silently using Wilder smoothing.
- D_t = ATR20_t × [1.5 + max(0, d × H_t)]. This coefficient is provisional.
- At entry fill E: long stop E−D_t; short stop E+D_t, using the decision snapshot's D.
- At each later signal close: long proposed stop = max(old stop, highest completed close since entry − D_t); short = min(old stop, lowest completed close since entry + D_t).
- Round long stops downward and short stops upward to the valid tick, preserving the monotonic ratchet. Use the rounded stop for risk calculations.
- A new stop becomes effective only after its calculation timestamp. Intrabar lows/highs cannot trigger a stop calculated later from the same bar's close.
- If the new proposed stop is already beyond the current executable market, issue CLOSE / paper market exit at the next executable observation; do not claim a fill at the favorable obsolete stop price.
- Manual mode: changing the suggested stop does not update the actual broker stop. User records their broker update and confirmation. Paper mode can update its simulated resting stop automatically.
- Missing current breadth freezes the last valid trailing stop and raises an alert; it does not delete the stop or create a new invented stop.

Dollar stop risk = abs(entry−rounded stop) × contracts × dollar multiplier, plus estimated costs. Initial risk R is frozen at entry and includes the selected documented cost convention. P&L = direction × price change × quantity × multiplier, minus actual/estimated fees as labeled. Do not calculate futures returns as percent of margin. Account return uses net account equity, including collateral cash and liabilities.

Starting paper sizing hypothesis: planned per-trade loss budget 0.25% of paper account equity; quantity=floor(risk budget / per-contract stop risk including estimated execution costs). Respect additional margin/available-cash constraints. If quantity=0, skip. Micro execution can be added later with explicit signal-to-execution mapping; do not silently substitute contracts. Stops and risk budgets are planned losses, not guaranteed maximum losses.

Flags should be actionable: DATA STALE, STOP UPDATE NEEDED, STOP BREACHED—VERIFY BROKER, CLOSE REQUIRED, EXIT RECORDED. HOLD / tightening suggestion can be lower priority. Loss of entry qualification is informational; the baseline exits through its stop, not an undocumented new discretionary rule. A higher-ranked market does not force switching from an existing position.

## Campaign results: lower right

This panel answers how actual recorded or simulated campaigns have performed. Avoid duplicating the observer's detailed calculations. One summary row: net realized P&L, closed trades, max account drawdown; optionally include total marked equity change when a reliable mark series is available. Show all six rows with current S, closed trades, and net P&L. A details drawer can add win rate, mean R, costs, exposure time, and strategy deviations. Use em dashes for statistics with no qualifying data, not synthetic sample performance.

Separate manual and paper ledgers and histories. Every view has a period and mode label. Win rate uses closed campaigns only and shows sample count. Account max drawdown uses a time series of total marked equity relative to running peaks, including open positions; never infer it from final closed-trade P&L alone. Account contributions/withdrawals need cash-flow adjustment. Do not assign the aggregate account drawdown to each instrument as though it were that instrument's independent result.

The included mockup intentionally starts both ledgers empty. The small paper demo generates one synthetic stopped trade only after user interaction. It is not market evidence or an estimate of strategy expectancy.

## Paper execution and data

Production paper mode may operate unattended only when explicitly started, with pause status visible. Use the deterministic engine, not an LLM placing improvised trades. Persist all pending and open positions. Pausing stops new entries while existing protective stops continue to be monitored. Keep an explicit stop-monitor health indicator; disconnected software cannot guarantee monitoring.

At a completed decision bar while flat, queue the highest qualifying and sizeable candidate. Fill no earlier than the next executable bar/quote. Include spread, side-dependent slippage, fees, and instrument tick rules. If the opening gap materially changes planned risk, recalculate quantity or skip under an explicit policy. If quotes are unavailable, label the fill model and its limitations.

The signal interval and stop-monitor interval are separate. Daily signals do not mean stops are checked only daily. Historical replay should use finer observations when available. For OHLC-only stop simulation: an opening gap past a resting stop exits at that opening price plus adverse slippage; otherwise a touched resting stop fills at stop plus adverse slippage. Resolve ambiguous same-bar ordering conservatively, never with favorable hindsight. Apply newly computed close-based stops only afterward.

Version the futures roll policy. Use actual dated contracts for positions and execution/P&L. Continuous/back-adjusted series can support indicators only with an explicit adjustment policy. Never book adjustment jumps as profit; handle roll costs and volume migration. Use point-in-time equity membership to avoid survivor bias. Define the common signal cut-off and session calendar explicitly; missing Treasury/gold data at that cut-off invalidates comparison rather than mixing asynchronous settlements.

Do not add an interval optimizer now. Make interval/session/window configuration explicit and preserve enough data to compare 5-minute, hourly, and daily methods later with held-out tests and execution costs.

## Engineering boundaries

Use the existing project stack if one exists. Otherwise React + TypeScript is a reasonable implementation choice; use decimal/tick-safe arithmetic for prices and money. Split data adapters, pure formula functions, ranking, position state machine, paper execution, ledger persistence, and AI explanation. The UI consumes snapshots and events, not parallel ad hoc calculations.

Suggested records:
- InstrumentMetadata: root, exact contract, exchange, currency, tick, multiplier, expiry, calendar, quote format, metadata source/version.
- SignalSnapshot: root, barEnd, availableAt, interval, modelVersion, raw inputs, Q/A/H/u, changes, lagged dispersions, both S values, side, eligibility, data quality/reasons, input-source IDs.
- Campaign: id, mode, root/contract, direction, frozen entry snapshot, risk budget, original dollar risk, fill events, remaining size, stops, fees, lifecycle state.
- OrderEvent: id, campaignId, timestamp, event type, actual/simulated, fill model/version, quantity, price, cost, reason, superseded event ID if corrected.
- AccountEquityPoint: mode, timestamp, cash, realized/unrealized P&L, liabilities, external cash flow, equity, freshness.

Persist separate manual and paper data durably. Use event IDs/idempotency to prevent duplicate entries when a data callback repeats or the app reloads. Corrections must retain audit history. No broker order endpoint in this release. No secret storage in the browser. Mock, historical replay, delayed, and real-time data sources must be labeled honestly. Synthetic fixtures must never blend into a real ledger.

## Acceptance checks

1. All six cards and both right panels fit default desktop targets; mobile has no horizontal clipping. Keyboard selection and labeled controls work.
2. For the NQ fixture: Q=1.8, A=.6 => u=3.0; previous u=2.4 and lagged σΔu=.25 =>2.4. H=.60, previous H=.38, lagged σΔH=.10 =>2.2; S=2.2. Long qualifies. ATR=25 => D=52.5. These are synthetic inputs only.
3. Highest rank below threshold produces no automatic paper trade. Missing ZN/GC breadth cannot be substituted with an attractive number.
4. Selecting a market does not record a position. Opening manual mode never sends an order. Actual fill recording and broker stop confirmation are distinct.
5. Long and short stops ratchet in the correct direction; rounding does not increase a previously ratcheted distance. Same-bar hindsight and gap fills have explicit tests.
6. Position sizing respects tick-rounded stop distance, multiplier, costs, risk budget, and integer contracts; zero size skips. Threshold changes are versioned.
7. Manual and paper ledgers remain separate across mode changes and reloads. Repeated bar events cannot duplicate fills. Recorded partial exits reconcile remaining size and realized P&L.
8. Stale prices label P&L stale. Missing signal inputs block new decisions without deleting existing protective stops.
9. Realized results use actual fills and fees; drawdown uses marked account equity. No-data statistics show em dashes.
10. AI text cannot modify calculator outputs or promote an invalid signal. The UI says 'score', not 'probability' or 'confidence', unless a separately validated probability model is introduced.

## Implementation sequence

First implement this UI with deterministic fixture data and empty ledgers. Then add persistence and lifecycle behavior, pure math and risk/execution tests, and explicit input adapters. Connect a real data source only after access, completeness, calendars, contracts, and breadth coverage are verified. Add the short AI explanations last. Preserve the model's unvalidated status throughout. Deliver a runnable project with setup instructions and a clear list of live-data dependencies still missing.
