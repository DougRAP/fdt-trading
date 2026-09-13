import { ledgerOf, useApp } from "../app/store";
import { EM_DASH, fmtMoney, fmtNum, fmtPct } from "./format";

export function CampaignResults() {
  const { state, actions } = useApp();
  const ledger = ledgerOf(state);
  const stats = ledger.stats();
  const byRoot = ledger.statsByRoot();
  const dd = ledger.maxDrawdown();
  const modeLabel = state.mode === "manual" ? "Manual journal" : "Paper only";
  return (
    <section className="cp-panel" aria-labelledby="results-title">
      <div className="cp-row">
        <h2 id="results-title">Campaign results</h2>
        <span className="cp-small">All time · fixture session · {modeLabel} · USD</span>
      </div>
      <div className="cp-results">
        <div>
          <span className="cp-small">Net realized</span>
          <span className="cp-value">{fmtMoney(stats.netRealizedMils, true)}</span>
        </div>
        <div>
          <span className="cp-small">Closed trades</span>
          <span className="cp-value">{stats.closedCount}</span>
        </div>
        <div>
          <span className="cp-small">Max account drawdown (marked)</span>
          <span className="cp-value" title={dd ? undefined : state.mode === "manual" && !ledger.events.some((e) => e.type === "CASH_FLOW") ? "account equity not entered" : "needs at least two marked equity points"}>{dd ? fmtPct(dd.value, 2) : EM_DASH}</span>
        </div>
        <div>
          <span className="cp-small">Marked equity</span>
          <span className="cp-value">{state.mode === "manual" && !ledger.events.some((e) => e.type === "CASH_FLOW") ? EM_DASH : fmtMoney(ledger.equityMils)}</span>
        </div>
      </div>
      <div className="cp-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col">Score S</th>
              <th scope="col">Closed</th>
              <th scope="col">Net P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {state.snapshots.map((s) => {
              const r = byRoot[s.root];
              const any = ledger.campaigns.some((c) => c.root === s.root && c.state !== "CANCELLED");
              return (
                <tr key={s.root}>
                  <td>{s.root}</td>
                  <td>{s.displayScore === null ? EM_DASH : fmtNum(s.displayScore)}</td>
                  <td>{any ? r.closedCount : EM_DASH}</td>
                  <td>{any ? fmtMoney(r.netRealizedMils, true) : EM_DASH}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="cp-row cp-footer">
        <span className="cp-small">Separate ledgers by mode · Results start empty · Drawdown is account-level, not per market</span>
        <button type="button" onClick={() => actions.openDrawer("results")}>Details</button>
      </div>
    </section>
  );
}
