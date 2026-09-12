import { useRef, useState, type KeyboardEvent } from "react";
import { ledgerOf, useApp } from "../app/store";
import type { QualificationChecks, SignalSnapshot } from "../formula/types";
import { INSTRUMENTS } from "../instruments/metadata";
import { rankSnapshots, type RankedEntry } from "../ranking/rank";
import { EM_DASH, fmtNum, fmtPrice, fmtTime } from "./format";

const CHECK_TEXT: Record<keyof QualificationChecks, (entry: number, breadth: number) => string> = {
  scoreAboveThreshold: (entry) => `S ≤ ${entry.toFixed(2)}`,
  breadthDirection: (_e, breadth) => `d·H < ${breadth.toFixed(2)}`,
  priceConfirmation: () => "price unconfirmed",
  inputsValid: () => "inputs stale",
};

const REASON_SHORT: Record<string, string> = {
  BREADTH_MODEL_UNDEFINED: "breadth undefined",
  INSUFFICIENT_VOLUME_HISTORY: "volume history",
  INSUFFICIENT_SIGMA_HISTORY: "sigma history",
  ZERO_SIGMA: "zero sigma",
  A_ZERO: "A = 0",
  COVERAGE_BELOW_95: "coverage < 95%",
  STALE: "stale",
  NONFINITE: "nonfinite input",
  INVALID_PRICE: "invalid price",
};

/** Deterministic, factual explanation from the structured snapshot. Never alters any value. */
export function explainSnapshot(s: SignalSnapshot, entryThreshold: number, breadthThreshold: number): string {
  if (s.status === "UNAVAILABLE") {
    const r = s.dataQuality.reasons[0];
    return r ? `${r.code}: ${r.detail}` : "unavailable";
  }
  if (s.status === "NEUTRAL") return "H = 0: no candidate side; both component scores in details.";
  const side = s.displaySide === "long" ? s.eligibility.long : s.eligibility.short;
  const parts: string[] = [];
  parts.push(side.checks.scoreAboveThreshold ? `score passes ${entryThreshold.toFixed(2)}` : `score ${fmtNum(side.S)} does not exceed ${entryThreshold.toFixed(2)}`);
  parts.push(side.checks.breadthDirection ? `directional breadth ${fmtNum(s.H)} passes ${breadthThreshold.toFixed(2)}` : `directional breadth ${fmtNum(s.H)} is below ${breadthThreshold.toFixed(2)}`);
  parts.push(side.checks.priceConfirmation ? "price confirms" : "price does not confirm");
  return parts.join("; ") + ".";
}

function statusText(e: RankedEntry, entry: number, breadth: number): string {
  const s = e.snapshot;
  switch (s.status) {
    case "QUALIFIED":
      return "QUALIFIED";
    case "WAIT": {
      const side = s.displaySide === "long" ? s.eligibility.long : s.eligibility.short;
      const why = side.failed.map((k) => CHECK_TEXT[k](entry, breadth)).join(" · ");
      return `WAIT · ${why}`;
    }
    case "NEUTRAL":
      return "NEUTRAL · H = 0";
    case "UNAVAILABLE": {
      const r = s.dataQuality.reasons[0];
      return `UNAVAILABLE · ${r ? (REASON_SHORT[r.code] ?? r.code) : "no reason"}`;
    }
  }
}

function sideLabel(s: SignalSnapshot): string {
  if (s.displaySide === "long") return "LONG";
  if (s.displaySide === "short") return "SHORT";
  if (s.displaySide === "neutral") return "NEUTRAL";
  return EM_DASH;
}

export function Observer() {
  const { state, actions } = useApp();
  const ranked = rankSnapshots(state.snapshots);
  const [expanded, setExpanded] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const active = ledgerOf(state).activeCampaign;

  const qualified = ranked.filter((e) => e.group === "qualified").length;
  const waiting = ranked.filter((e) => e.group === "unqualified" || e.group === "neutral").length;
  const unavailable = ranked.filter((e) => e.group === "unavailable");
  // Group unavailable roots by short reason: "GC, ZN: breadth undefined"
  const byReason = new Map<string, string[]>();
  for (const e of unavailable) {
    const code = e.snapshot.dataQuality.reasons[0]?.code ?? "unavailable";
    const key = REASON_SHORT[code] ?? code;
    byReason.set(key, [...(byReason.get(key) ?? []), e.root]);
  }
  const problems = [...byReason.entries()].map(([why, roots]) => `${roots.join(", ")}: ${why}`).join("; ");
  const warnings = ranked.flatMap((e) => e.snapshot.dataQuality.warnings.map((w) => `${e.root}: ${w.code}`));
  const barEnd = state.snapshots[0]?.barEnd ?? null;

  function onKeyDown(ev: KeyboardEvent<HTMLDivElement>) {
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button.cp-market") ?? []);
    const i = buttons.findIndex((b) => b === document.activeElement);
    if (i < 0) return;
    ev.preventDefault();
    const next = buttons[(i + (ev.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length];
    next?.focus();
  }

  return (
    <section className="cp-panel" aria-labelledby="observer-title">
      <div className="cp-row">
        <h2 id="observer-title">Market observer</h2>
        <span className="cp-small">Entry threshold S &gt; {state.cfg.entryThreshold.toFixed(2)} · d·H ≥ {state.cfg.breadthThreshold.toFixed(2)}</span>
      </div>
      <p className="cp-agent cp-ellipsis" aria-live="polite" title={`Snapshot ${barEnd ?? ""} · ${ranked.length} evaluated · ${qualified} qualify · ${waiting} wait · ${unavailable.length} unavailable${problems ? ` (${problems})` : ""}${warnings.length ? ` · warnings: ${warnings.join(", ")}` : ""}`}>
        <strong>Snapshot ready</strong> · {barEnd ? fmtTime(barEnd) : EM_DASH} · {ranked.length} evaluated · {qualified} qualify · {waiting} wait · {unavailable.length} unavailable
        {problems ? ` (${problems})` : ""}
        {warnings.length ? ` · warnings: ${warnings.join(", ")}` : ""}
      </p>
      <div className="cp-stack" ref={listRef} onKeyDown={onKeyDown} role="list" aria-label="Markets ranked by score">
        {ranked.map((e) => {
          const s = e.snapshot;
          const selected = state.selectedRoot === e.root;
          const isExpanded = expanded === e.root;
          const pinned = active !== null && active.root !== e.root;
          return (
            <div key={e.root} role="listitem">
              <button
                type="button"
                className="cp-market"
                aria-pressed={selected}
                aria-label={`${e.root} ${sideLabel(s)} ${s.status} score ${s.displayScore === null ? "unavailable" : fmtNum(s.displayScore)}`}
                onClick={() => {
                  actions.select(e.root);
                  if (pinned) {
                    setExpanded(e.root);
                    actions.setNotice(`Position in ${active.root} stays pinned. ${e.root} details opened; selecting never records a position.`);
                  }
                }}
              >
                <span className="cp-row">
                  <span>
                    <span className="cp-rank">{e.rank === null ? EM_DASH : String(e.rank).padStart(2, "0")}</span>
                    <span className="cp-symbol">{e.root}</span>
                    <span className="cp-name">{sideLabel(s)} · {INSTRUMENTS[s.root].name}</span>
                  </span>
                  <span className="cp-score" aria-label="score">{s.displayScore === null ? EM_DASH : fmtNum(s.displayScore)}</span>
                </span>
                <span className="cp-row cp-line">
                  <span className="cp-math cp-ellipsis">
                    Q {fmtNum(s.Q)} · A {fmtNum(s.A)} · u {fmtNum(s.u)} · H {fmtNum(s.H)} · Δu/σ {fmtNum(s.v)} · dΔH/σ {fmtNum(s.displaySide === "short" ? s.p.short : s.p.long)}
                  </span>
                  <span className="cp-status cp-ellipsis" title={statusText(e, state.cfg.entryThreshold, state.cfg.breadthThreshold)}>{statusText(e, state.cfg.entryThreshold, state.cfg.breadthThreshold)}</span>
                </span>
                <span className="cp-math cp-ellipsis">bar {fmtTime(s.barEnd)} · {s.dataSource.kind === "fixture" ? "synthetic · freshness n/a" : "fresh"}</span>
              </button>
              <div className="cp-row" style={{ justifyContent: "flex-end" }}>
                <button type="button" className="cp-small cp-details-toggle" aria-expanded={isExpanded} aria-controls={`details-${e.root}`} onClick={() => setExpanded(isExpanded ? null : e.root)}>
                  {isExpanded ? "Hide details" : "Details"}
                </button>
              </div>
              {isExpanded && <CardDetails snapshot={s} entryThreshold={state.cfg.entryThreshold} breadthThreshold={state.cfg.breadthThreshold} />}
            </div>
          );
        })}
      </div>
      <p className="cp-small cp-footer">Rank compares scores. A score is not a probability of profit. Selecting a card drafts a ticket; it never records a position.</p>
    </section>
  );
}

function CardDetails({ snapshot: s, entryThreshold, breadthThreshold }: { snapshot: SignalSnapshot; entryThreshold: number; breadthThreshold: number }) {
  return (
    <div className="cp-expand" id={`details-${s.root}`}>
      <div>{explainSnapshot(s, entryThreshold, breadthThreshold)}</div>
      <dl>
        <dt>S long / S short</dt>
        <dd>{fmtNum(s.S.long)} / {fmtNum(s.S.short)}</dd>
        <dt>Δu, σΔu ({s.raw.sigmaDeltaUCount})</dt>
        <dd>{fmtNum(s.deltaU, 4)}, {fmtNum(s.sigmaDeltaU, 4)}</dd>
        <dt>ΔH, σΔH ({s.raw.sigmaDeltaHCount})</dt>
        <dd>{fmtNum(s.deltaH, 4)}, {fmtNum(s.sigmaDeltaH, 4)}</dd>
        <dt>Previous u, H</dt>
        <dd>{fmtNum(s.raw.uPrev)}, {fmtNum(s.raw.HPrev)}</dd>
        <dt>Close t, t−1</dt>
        <dd>{fmtPrice(s.raw.closeT, s.root)}, {fmtPrice(s.raw.closePrev, s.root)}</dd>
        <dt>ATR20 (SMA)</dt>
        <dd>{fmtPrice(s.raw.atr20Ticks, s.root)} pts</dd>
        <dt>Breadth</dt>
        <dd>{s.breadth.source} · {s.breadth.definitionVersion} · coverage {s.breadth.coverage === null ? EM_DASH : `${(s.breadth.coverage * 100).toFixed(0)}%`}</dd>
        <dt>Data quality</dt>
        <dd>{s.dataQuality.reasons.length ? s.dataQuality.reasons.map((r) => `${r.code}: ${r.detail}`).join("; ") : "no problems"}{s.dataQuality.warnings.length ? ` · warnings: ${s.dataQuality.warnings.map((w) => w.detail).join("; ")}` : ""}</dd>
        <dt>Sources</dt>
        <dd>{s.inputSourceIds.join(", ")} · {s.dataSource.label}</dd>
      </dl>
      <div>Definitions: Q = V_t / mean(V_t−20..t−1). A = share of constituents above their own 20-bar volume mean. H = (advancing − declining) / valid. u = Q/A. S_d = min(Δu/σΔu, d·ΔH/σΔH). Score, not probability.</div>
    </div>
  );
}
