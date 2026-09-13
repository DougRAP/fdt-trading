import { ledgerOf, useApp } from "../app/store";
import type { RootStats } from "../ledger/ledger";
import { Drawer } from "./Drawer";
import { EM_DASH, fmtMoney, fmtNum, fmtPct } from "./format";

function rate(v: { value: number; n: number } | null, digits = 0): string {
  return v ? `${(v.value * 100).toFixed(digits)}% (n=${v.n})` : EM_DASH;
}
function meanR(v: { value: number; n: number } | null): string {
  return v ? `${fmtNum(v.value)} R (n=${v.n})` : EM_DASH;
}

export function ResultsDetails() {
  const { state, actions } = useApp();
  const ledger = ledgerOf(state);
  const stats = ledger.stats();
  const byRoot = ledger.statsByRoot();
  const dd = ledger.maxDrawdown();
  const interpreter = ledger.state.interpreter;
  const usage = interpreter.usage;
  const rows: [string, RootStats][] = [["All", stats], ...(Object.entries(byRoot) as [string, RootStats][])];
  return (
    <Drawer open={state.drawer === "results"} title={`Results details · ${state.mode === "manual" ? "Manual journal" : "Paper only"} · All time · fixture session · USD`} onClose={() => actions.openDrawer(null)}>
      <div className="cp-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Scope</th>
              <th scope="col">Closed</th>
              <th scope="col">Net realized</th>
              <th scope="col">Win rate</th>
              <th scope="col">Mean R</th>
              <th scope="col">Costs</th>
              <th scope="col">Exposure (bars)</th>
              <th scope="col">Deviations</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, r]) => (
              <tr key={name}>
                <td>{name}</td>
                <td>{r.closedCount || EM_DASH}</td>
                <td>{r.closedCount || r.netRealizedMils !== 0 ? fmtMoney(r.netRealizedMils, true) : EM_DASH}</td>
                <td>{rate(r.winRate)}</td>
                <td>{meanR(r.meanR)}</td>
                <td>{r.totalFeesMils ? fmtMoney(r.totalFeesMils) : EM_DASH}</td>
                <td>{r.exposureBars || EM_DASH}</td>
                <td>{r.deviationCount || EM_DASH}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="cp-small">
        Max account drawdown (marked equity vs running peak, open positions included, cash flows adjust the peak basis): {dd ? `${fmtPct(dd.value, 3)} · peak ${fmtMoney(dd.peakMils)} · trough ${fmtMoney(dd.troughMils)} · ${dd.points} points` : EM_DASH}. Win rate uses closed campaigns only. Liabilities: not modeled (0). Realized results use recorded fills and fees.
      </p>
      <h3>Interpreter usage for this ledger</h3>
      <div className="cp-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Calls</th>
              <th scope="col">Input tokens</th>
              <th scope="col">Cached input</th>
              <th scope="col">Output tokens</th>
              <th scope="col">Cost estimate</th>
              <th scope="col">Total latency</th>
              <th scope="col">Memory epoch</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{usage.calls || EM_DASH}</td>
              <td>{usage.calls ? usage.inputTokens.toLocaleString("en-US") : EM_DASH}</td>
              <td>{usage.calls ? usage.cachedInputTokens.toLocaleString("en-US") : EM_DASH}</td>
              <td>{usage.calls ? usage.outputTokens.toLocaleString("en-US") : EM_DASH}</td>
              <td>{usage.calls ? fmtMoney(usage.costEstimateMils) : EM_DASH}</td>
              <td>{usage.calls ? `${usage.latencyMsTotal.toLocaleString("en-US")} ms` : EM_DASH}</td>
              <td>{interpreter.memoryEpochId}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="cp-small">
        Cost is an estimate from the configured price table in USD, not an invoice. Lessons in this epoch: {interpreter.lessons.length}; digest{" "}
        {interpreter.digest ? `v${interpreter.digest.digest.version}` : EM_DASH}.
      </p>
    </Drawer>
  );
}
