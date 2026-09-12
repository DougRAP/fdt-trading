import { candidateSide, draftPlan } from "../app/plan";
import { selectedSnapshot, useApp } from "../app/store";
import { Drawer } from "./Drawer";
import { EM_DASH, fmtNum, fmtPrice } from "./format";

export function FormulaDetails() {
  const { state, actions } = useApp();
  const s = selectedSnapshot(state);
  const plan = s ? draftPlan(s, candidateSide(s), null, state.cfg) : null;
  return (
    <Drawer open={state.drawer === "formula"} title="Formula definitions & selected inputs (model v0.1, unvalidated)" onClose={() => actions.openDrawer(null)}>
      <div className="cp-equation">
        Q_t = V_t / mean(V_t−20 … V_t−1). A_t = valid constituents with volume above their own preceding 20-bar mean / valid count (≥95% coverage required). H_t = (advancing − declining) / valid count, unchanged stay in the denominator. u_t = Q_t / A_t. Δu_t = u_t − u_t−1; ΔH_t = H_t − H_t−1. σ = sample SD (ddof=1) of the 60 preceding changes, excluding the current one. S_d,t = min(Δu_t/σΔu, d·ΔH_t/σΔH). Qualifies if S &gt; {state.cfg.entryThreshold.toFixed(2)}, d·H ≥ {state.cfg.breadthThreshold.toFixed(2)}, d·(close_t − close_t−1) &gt; 0, inputs valid and fresh. Stop: SMA ATR20 (mean of TR over t−19..t), D = ATR20 × [{state.cfg.stopBase.toFixed(1)} + max(0, d·H)]; long stop = E − D rounded down, short = E + D rounded up; ratchet from highest/lowest completed close, never loosens. Sizing: floor(equity × {(state.cfg.riskBudgetPct * 100).toFixed(2)}% / per-contract risk incl. modeled costs). Score is not a probability.
      </div>
      {s ? (
        <dl className="cp-expand" style={{ borderTop: "none" }}>
          <dt>Selected</dt>
          <dd>{s.root} · {s.dataSource.label} · bar {s.barEnd} · available {s.availableAt}</dd>
          <dt>Q, A, H, u</dt>
          <dd>{fmtNum(s.Q)}, {fmtNum(s.A)}, {fmtNum(s.H)}, {fmtNum(s.u)}</dd>
          <dt>Previous u, H</dt>
          <dd>{fmtNum(s.raw.uPrev)}, {fmtNum(s.raw.HPrev)}</dd>
          <dt>Δu / σΔu</dt>
          <dd>{fmtNum(s.deltaU, 4)} / {fmtNum(s.sigmaDeltaU, 4)} = {fmtNum(s.v)} (σ from {s.raw.sigmaDeltaUCount} prior changes{s.dataSource.kind === "fixture" ? ", synthetic constant" : ""})</dd>
          <dt>ΔH / σΔH</dt>
          <dd>{fmtNum(s.deltaH, 4)} / {fmtNum(s.sigmaDeltaH, 4)} → p long {fmtNum(s.p.long)}, p short {fmtNum(s.p.short)}</dd>
          <dt>S long, S short</dt>
          <dd>{fmtNum(s.S.long)}, {fmtNum(s.S.short)} · status {s.status}</dd>
          <dt>Checks (long)</dt>
          <dd>{Object.entries(s.eligibility.long.checks).map(([k, v]) => `${k}: ${v === null ? EM_DASH : v ? "pass" : "fail"}`).join(" · ")}</dd>
          <dt>Checks (short)</dt>
          <dd>{Object.entries(s.eligibility.short.checks).map(([k, v]) => `${k}: ${v === null ? EM_DASH : v ? "pass" : "fail"}`).join(" · ")}</dd>
          <dt>ATR20, D</dt>
          <dd>{fmtPrice(s.raw.atr20Ticks, s.root)} pts · {plan && plan.ok ? `coefficient ${fmtNum(plan.distance.coefficient)} → D ${fmtPrice(Math.round(plan.distance.dTicks), s.root)} pts` : EM_DASH}</dd>
          <dt>Breadth adapter</dt>
          <dd>{s.breadth.source} · {s.breadth.definitionVersion} · valid {s.breadth.validCount ?? EM_DASH}/{s.breadth.universeCount ?? EM_DASH} · {s.breadth.reasons.map((r) => r.detail).join("; ") || "valid"}</dd>
          <dt>Data quality</dt>
          <dd>{s.dataQuality.reasons.map((r) => `${r.code}: ${r.detail}`).join("; ") || "no problems"} {s.dataQuality.warnings.map((w) => `· ${w.code}: ${w.detail}`).join(" ")}</dd>
        </dl>
      ) : (
        <p className="cp-small">Select a market to see its inputs.</p>
      )}
    </Drawer>
  );
}
