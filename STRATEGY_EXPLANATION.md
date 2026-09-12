# Below-the-fold addition for Claude Code

Append a full-width educational section beneath the existing first-screen trading console. Keep the console's original desktop proportions. Use normal page scrolling; do not put the explanation inside either trading column. Label its navigation link “How it works.” The following is the content and display specification.

Use readable rendered math, a compact glossary, and worked examples. Explain the campaign first, then reveal the calculations. Keep the main explanation visible; place derivation details and future research questions in expandable sections. Label every worked example “Illustrative — synthetic inputs.” No stock photos, decorative market charts, fabricated performance, or explanatory AI chat stream.

An optional “Use selected market” example mode may substitute a complete valid snapshot, explicitly labeled with its timestamp and contract. Never blend synthetic numbers with actual market inputs. Switching examples must not alter the trade ticket, model configuration, or ledger. If required inputs are absent, show why the live example is unavailable.

The content below incorporates the formula clarifications supplied after the original brief. It does not introduce a new entry rule.

---

# How this strategy works

## The campaign

We look for a market where unusual trading activity accompanies strengthening directional participation and a confirming price move. We select a qualifying opportunity, establish a position with a planned stop, and follow the move while progressively defending it with a trailing stop.

The sequence is **observe → qualify → enter → hold → retreat**.

We monitor six destinations for capital: Nasdaq-100, S&P 500, Russell 2000, Dow, 10-year Treasury notes, and gold futures. These cover different growth and defensive preferences. Their labels suggest what demand might represent; the measured signal determines whether a trade qualifies. A defensive label does not automatically make a market a buy.

We can go long when upward participation strengthens or short when downward participation strengthens. We hold at most one position per mode. If no candidate qualifies and fits the risk budget, we remain in cash. A higher rank elsewhere does not by itself close an existing campaign.

**Research status:** this is a testable model, not a demonstrated trading edge. The current thresholds, daily interval, and stop coefficient remain provisional. No probability of profit or annual return is established by the score.

## The pipe analogy

For fluid passing through a pipe, volumetric flow rate Q, cross-sectional area A, and mean velocity u are related by:

\[
Q=A u,\qquad u=\frac{Q}{A}
\]

We borrow this relationship to construct a market activity measure. Our market Q and A are normalized proxies; u is therefore a dimensionless index, not a physical velocity.

| Symbol | Market interpretation | How it is measured |
|---|---|---|
| V | Trading activity | Futures contracts traded during the signal session |
| Q | Flow relative to normal | V divided by its preceding 20-bar average |
| A | Activity breadth, our pipe-width proxy | Fraction of valid index constituents with above-normal volume |
| u | Flow relative to activity breadth | Q divided by A |
| H | Directional breadth, our pressure proxy | Advancing fraction minus declining fraction |
| d | Trade direction | +1 for long; −1 for short |
| ATR20 | Recent price-range scale | Mean of the latest 20 completed true ranges |
| S | Entry score | The weaker of the two standardized change components |

H is our proposed herding proxy. It is not conventional stock beta, order-book pressure, or a direct measurement of investors' motives. Trading volume counts turnover; it does not prove net capital entered an asset. A and H use related constituent observations and are not statistically independent measurements.

Our breadth measures work as defined for equity indexes. Treasury and gold breadth still need their own researched definitions. Until then, those cards may show valid Q but cannot receive a complete signal or qualify for entry.

### Why pipe width matters

Suppose Q=1.50 and A=0.50. Then u=3.00. If flow rises to 1.80 while breadth widens to 0.60, u remains 3.00. More activity has spread across a wider market; the ratio has not accelerated.

If Q stays at 1.50 while A narrows to 0.40, u rises to 3.75. That rise reflects concentration of the activity proxy, even though Q did not increase.

This is a deliberate feature to test, not proof that narrow participation is favorable. The baseline checks increasing u. It does **not** separately require Q to increase. Requiring both ΔQ>0 and Δu>0 is a future comparison, not an existing rule.

The mathematical decomposition is:

\[
\frac{du}{dt}=\frac{1}{A}\frac{dQ}{dt}-\frac{Q}{A^2}\frac{dA}{dt}
\]

The implemented model uses discrete completed-bar changes instead of continuous derivatives. We borrow a fluid relationship to define a feature; no physical fluid law establishes that the feature predicts prices.

## From observations to a signal

For a completed signal bar t:

\[
Q_t=\frac{V_t}{\frac{1}{20}\sum_{j=t-20}^{t-1}V_j}
\]

Let N be the valid constituent count after applying the data-coverage rules. A stock has above-normal volume when its current volume exceeds its own preceding 20-bar average.

\[
A_t=\frac{N_{\text{above-normal volume}}}{N}
\]

\[
H_t=\frac{N_{\text{advancing}}-N_{\text{declining}}}{N},
\qquad u_t=\frac{Q_t}{A_t}
\]

Unchanged constituents remain in N. Advancing and declining refer to close-to-close price changes. We require at least 95% coverage of the point-in-time index membership and report exclusions. Missing stocks are not counted as unchanged.

We then measure the changes:

\[
\Delta u_t=u_t-u_{t-1},\qquad \Delta H_t=H_t-H_{t-1}
\]

For each change series, σ is its sample standard deviation over the **60 preceding changes**, excluding the current change. It scales the current change by its recent variability; we do not subtract the historical mean in this version. These components are not calibrated probabilities or conventional mean-centered z-scores.

\[
v_t=\frac{\Delta u_t}{\sigma_{\Delta u,t}},
\qquad p_{d,t}=\frac{d\,\Delta H_t}{\sigma_{\Delta H,t}}
\]

\[
\boxed{S_{d,t}=\min(v_t,p_{d,t})}
\]

Using the minimum makes the weaker component control the score. A very large activity component cannot compensate for weak directional confirmation.

A candidate qualifies only when all of the following hold:

1. S > 1.00.
2. d × H ≥ 0.40.
3. The completed futures close-to-close move has the same direction as the trade: d × (C_t−C_{t−1}) > 0.
4. Required inputs are complete, valid, and fresh, and position sizing permits a trade.

Missing histories, zero dispersion, A=0, or an undefined breadth model make the signal unavailable. A score of 2.2 does not mean a 2.2-to-1 payoff or a particular chance of success. The highest score can still fail another entry condition.

When no side qualifies, a nonzero H supplies the displayed candidate direction and its S, which may be negative. Valid unqualified scores rank below qualified scores. At H=0 the market is neutral and has no directional rank.

## Worked long example

**Illustrative — synthetic inputs.** Assume the current futures close is higher than the previous close and all data checks pass.

| Input | Value |
|---|---:|
| Relative flow Q | 1.80 |
| Activity breadth A | 0.60 |
| Previous u | 2.40 |
| Current H | +0.60 |
| Previous H | +0.38 |
| Prior change dispersion σΔu | 0.25 |
| Prior change dispersion σΔH | 0.10 |

\[
u=1.80/0.60=3.00
\]

\[
v=(3.00-2.40)/0.25=2.40
\]

For a long, d=+1:

\[
p=(0.60-0.38)/0.10=2.20
\]

\[
S=\min(2.40,2.20)=2.20
\]

S exceeds 1.00, directional breadth +0.60 exceeds +0.40, and price confirms upward movement. The long candidate qualifies. It can be selected if it outranks the other eligible, sizeable candidates and the account is flat.

## Establishing the stop and trade size

True range captures both the intrabar range and gaps relative to the prior close:

\[
TR_t=\max(High_t-Low_t,\ |High_t-C_{t-1}|,\ |Low_t-C_{t-1}|)
\]

\[
ATR_{20,t}=\frac{1}{20}\sum_{j=t-19}^{t}TR_j
\]

The proposed stop distance is:

\[
\boxed{D_t=ATR_{20,t}[1.5+\max(0,dH_t)]}
\]

This provisional coefficient gives more room when directional participation is stronger and less room when it weakens, for a given ATR. Whether that improves results must be tested against a simpler fixed-ATR stop.

Continue the long example with ATR20=25 points:

\[
D=25(1.5+0.60)=52.50\text{ points}
\]

Use an illustrative next executable reference price of 22,000.00, a tick of 0.25, and a multiplier of $20 per point. Apply one tick of adverse entry adjustment:

\[
E=22{,}000.25
\]

\[
Stop=E-D=21{,}947.75
\]

The stop is approximately 0.239% below entry. Round a long stop downward and a short stop upward to a valid instrument tick before calculating risk.

For this fixture, budget one additional adverse tick at a nongapped stop exit and $5 in total entry-plus-exit fees per contract. The stop-exit fill would be 21,947.50:

\[
Risk_{contract}=(22{,}000.25-21{,}947.50)\times\$20+\$5=\$1{,}060
\]

With $1,000,000 in paper equity and a 0.25% risk budget:

\[
Budget=\$1{,}000{,}000\times0.0025=\$2{,}500
\]

\[
Contracts=\left\lfloor\frac{\$2{,}500}{\$1{,}060}\right\rfloor=2
\]

Planned stop loss including the modeled costs is $2,120, or 0.212% of paper equity, subject also to margin and available-cash limits. If the budget permits zero contracts, skip the trade.

These fees and execution adjustments are synthetic assumptions. A gap or worse execution can produce a larger loss. The budget is not a guaranteed maximum loss.

## Holding territory: the trailing stop

Recompute D at each later completed signal bar using its ATR20 and H. For a long:

\[
Stop_t=\max(Stop_{t-1},\ HighestClose_{since\ entry}-D_t)
\]

For a short:

\[
Stop_t=\min(Stop_{t-1},\ LowestClose_{since\ entry}+D_t)
\]

The reference is the highest or lowest **completed close**, not the intrabar high or low. Preserve the ratchet after tick rounding. A recalculated stop only becomes active after its calculation time.

Suppose the long campaign's highest completed close reaches 22,100, ATR20 becomes 30, and H strengthens to +0.70:

\[
D=30(1.5+0.70)=66
\]

\[
Stop=\max(21{,}947.75,22{,}100-66)=22{,}034
\]

If H later weakens to +0.20 while ATR and the highest close stay unchanged, D becomes 51 and the proposed stop tightens to 22,049. If ATR instead rises enough to put the calculated candidate below the existing long stop, the existing stop remains in place. We never loosen it through recalculation.

If inputs are unavailable, retain the last valid stop and flag the missing data. If a newly calculated stop is already beyond the current executable market, request an exit at the next executable observation; do not claim a favorable fill at a price already passed.

Daily signals still require stop monitoring between daily updates. A weakening entry score alone does not trigger an undocumented exit rule.

## The same method for a short

**Illustrative — synthetic inputs.** Keep the long example's u values and dispersions, but set H=−0.60 and previous H=−0.38. Assume price has fallen.

For d=−1:

\[
p=\frac{(-1)(-0.60+0.38)}{0.10}=2.20
\]

The activity component is still 2.40, so S=2.20. Directional breadth in the proposed trade's direction is dH=+0.60. The short qualifies.

At a reference price of 22,000, one adverse tick gives a short entry of 21,999.75. With ATR20=25 and D=52.50, its initial stop is above entry at 22,052.25. A nongapped buy-to-cover fill one adverse tick beyond that stop is 22,052.50. The modeled per-contract loss including $5 fees is again $1,060.

If the lowest completed close later reaches 21,900, ATR20=30, and H=−0.70, D=66:

\[
Stop=\min(22{,}052.25,21{,}900+66)=21{,}966
\]

The short stop moves downward as the campaign advances. It cannot move upward through recalculation.

Increasing total volume has no buy/sell sign. H and price confirmation determine direction. Falling volume is not automatically sell pressure.

## What the operator does

**Manual journal:** review the signal, place the trade at the broker, then record its actual fills. The screen distinguishes a proposed stop from the stop recorded as active at the broker. An alert is not an executed exit; record the actual closing fill. This interface does not place real orders.

**AI paper:** start the paper engine to apply the same numerical rules to simulated trades. The calculator determines scores, eligibility, size, and stops; AI explains the evidence. Paper fills occur no earlier than the next executable observation and include the configured costs. Manual and paper results stay separate.

A proposed price stop is not an option backstop. Options and multi-leg hedges are outside the current version and would require their own quote data, cost model, and tests.

## Measuring the campaign

For a fully closed position with quantity n and dollar multiplier M:

\[
NetPnL=d\,(Exit-Entry)\,nM-TotalFees
\]

Compute partial-fill positions from the actual fill ledger. Show estimated versus actual costs explicitly.

\[
Realized\ R=\frac{NetPnL}{Original\ planned\ dollar\ risk}
\]

Original risk stays frozen at entry, including the chosen modeled execution costs. Moving the stop does not rewrite the denominator to make the campaign's R appear larger.

Account return is measured against account equity, not futures margin. Drawdown measures decline from a prior marked account-equity peak and includes open positions. Without a sufficient equity history, drawdown is unavailable rather than assumed to be zero.

## What we still need to learn

The first question is whether qualifying observations lead to better net outcomes than comparable observations that do not qualify. Next, compare fixed versus pressure-dependent ATR stops, rising-u versus rising-u-and-Q entries, and several measurement intervals.

Use unseen test periods, point-in-time constituent membership, documented futures rolls, and realistic costs. Increasing S is not assumed to make trades safer: that claim requires evidence about subsequent losses, gaps, reversals, and drawdowns.

The interface makes the hypothesis observable and testable. Performance comes from the results, not from the fluid analogy.
