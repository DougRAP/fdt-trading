import { MODE_LABELS, useApp } from "../app/store";
import { fmtTime } from "./format";

export function Header() {
  const { state, actions } = useApp();
  const snap = state.snapshots[0];
  return (
    <header className="cp-top">
      <div className="cp-title">
        <h1>Campaign</h1>
        <span className="cp-small cp-subtitle">Observe pressure. Choose a position. Defend the gain.</span>
        <span className="cp-small">ILLUSTRATIVE DATA · No market connection</span>
      </div>
      <div className="cp-top-controls">
        <div className="cp-mode" role="group" aria-label="Trading mode">
          {(["manual", "paper", "paperModel"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={state.mode === m} onClick={() => actions.setMode(m)}>
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
        <div className="cp-meta">
          <label aria-hidden="true" className="cp-interval">
            <select aria-label="Signal interval" value={state.cfg.interval} onChange={() => undefined} title="Signal interval. Daily is provisional; other intervals need complete, aligned datasets. Changing the interval does not optimize the strategy.">
              {state.cfg.intervalOptions.map((o) => (
                <option key={o.id} value={o.id} disabled={!o.enabled} title={o.disabledReason}>
                  {o.label}
                  {o.enabled ? " (provisional)" : " (disabled)"}
                </option>
              ))}
            </select>
          </label>
          <span title="Synthetic fixture snapshot; freshness not applicable">Data {snap ? fmtTime(snap.barEnd) : "—"} · synthetic</span>
          <span title="Model v0.1 is an unvalidated research hypothesis; +userN marks a saved settings revision">v{state.cfg.version} unvalidated</span>
          <span>{state.storageKind}</span>
        </div>
        <div className="cp-actions">
          <button type="button" className="cp-drawer-btn" onClick={() => actions.openDrawer("formula")}>Formula</button>
          <button type="button" className="cp-drawer-btn" onClick={() => actions.openDrawer("journal")}>Journal</button>
          <button type="button" className="cp-drawer-btn" onClick={() => actions.openDrawer("settings")}>Settings</button>
          <button type="button" className="cp-drawer-btn" onClick={() => actions.openDrawer("memory")}>Model memory</button>
          <a className="cp-drawer-btn cp-link" href="#how-it-works">How it works</a>
        </div>
      </div>
    </header>
  );
}
