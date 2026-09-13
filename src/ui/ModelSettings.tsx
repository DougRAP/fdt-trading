import { useState } from "react";
import { overridesOf, useApp, type ConfigOverrides } from "../app/store";
import { recordCashFlow } from "../campaign/manual";
import { NumericError } from "../numerics/ticks";
import { dollarsToMils, subMils } from "../numerics/money";
import { Drawer } from "./Drawer";
import { fmtMoney } from "./format";

export function ModelSettings() {
  const { state, actions } = useApp();
  const [draft, setDraft] = useState<ConfigOverrides>(() => overridesOf(state.cfg));
  const [equityText, setEquityText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const manual = state.ledgers.manual;
  const seeded = manual.events.some((e) => e.type === "CASH_FLOW");
  const running = state.ledgers.manual.activeCampaign ?? state.ledgers.paper.activeCampaign;

  function field(key: keyof ConfigOverrides, label: string, step: string) {
    return (
      <label>
        {label}
        <input type="number" step={step} value={draft[key]} onChange={(ev) => setDraft({ ...draft, [key]: Number(ev.target.value) })} />
      </label>
    );
  }

  function save() {
    const values = Object.values(draft);
    if (!values.every((v) => Number.isFinite(v))) {
      setError("All settings must be finite numbers.");
      return;
    }
    setError(null);
    actions.saveSettings(draft);
  }

  function setEquity() {
    try {
      const target = dollarsToMils(equityText.trim());
      const current = manual.equityMils;
      const delta = subMils(target, current);
      const at = new Date().toISOString();
      const err = actions.append("manual", [recordCashFlow({ id: `manual:cash:${at}`, amountMils: delta, note: seeded ? "manual account equity adjusted (user-entered)" : "manual account equity seed (user-entered)", at })]);
      setError(err);
      if (!err) setEquityText("");
    } catch (e) {
      setError(e instanceof NumericError ? e.message : String(e));
    }
  }

  return (
    <Drawer open={state.drawer === "settings"} title={`Model settings · current ${state.configLabel} · USD`} onClose={() => actions.openDrawer(null)}>
      <p className="cp-small">Saving creates a new settings version label. Running campaigns keep the frozen config they were entered under; nothing is changed silently. Windows (20 / 60 / 20) and the interval are fixed in v0.1. Parameters are research hypotheses, not optimized values.</p>
      <div className="cp-fields">
        {field("entryThreshold", "Entry threshold (S >)", "0.01")}
        {field("breadthThreshold", "Directional breadth (d·H ≥)", "0.01")}
        {field("stopBase", "Stop base coefficient", "0.1")}
        {field("riskBudgetPct", "Risk budget (fraction of equity)", "0.0005")}
        {field("aSmallWarn", "A small warning (research param)", "0.01")}
      </div>
      <div className="cp-actions">
        <button type="button" className="cp-main" onClick={save}>Save as new version</button>
        <span className="cp-small">{running ? `Running campaign ${running.id} keeps config v${running.frozenConfig.version}.` : "No running campaign."}</span>
      </div>
      <div className="cp-group">
        <h3>Manual account equity (user-entered)</h3>
        <p className="cp-small">Used for the manual ticket's risk budget and % of equity. Recorded as an external cash flow in the manual ledger. Current: {seeded ? fmtMoney(manual.equityMils) : "not entered"}.</p>
        <div className="cp-actions">
          <input aria-label="Manual account equity in USD" placeholder="e.g. 250000" value={equityText} onChange={(ev) => setEquityText(ev.target.value)} style={{ maxWidth: 200 }} />
          <button type="button" onClick={setEquity}>Record equity</button>
        </div>
      </div>
      {error && <p className="cp-error" role="alert">{error}</p>}
    </Drawer>
  );
}
