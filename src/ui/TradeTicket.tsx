import { useState } from "react";
import { candidateSide, draftPlan } from "../app/plan";
import { ledgerOf, selectedSnapshot, useApp } from "../app/store";
import { newEventId } from "../app/ids";
import { proposeTrailingStop, recordBrokerStop, recordCompletedClose, recordEntryFill, recordExitFill, recordMark } from "../campaign/manual";
import { positionSummary, type PositionSummary } from "../campaign/pnl";
import { LedgerError } from "../campaign/reduce";
import type { BrokerStopStatus, Campaign } from "../campaign/types";
import type { Side, SignalSnapshot } from "../formula/types";
import { INSTRUMENTS } from "../instruments/metadata";
import { dollarsToMils, mils, type Mils } from "../numerics/money";
import { NumericError, toTicks, type Ticks } from "../numerics/ticks";
import { stopMonitorStatus } from "../paper/engine";
import { EM_DASH, fmtMoney, fmtNum, fmtPct, fmtPoints, fmtPrice, fmtTime, sideText } from "./format";
// fmtPoints is used for the title attribute of the distance cell.

const DAY_MS = 24 * 60 * 60 * 1000;

function toIso(local: string): string {
  const d = new Date(local);
  if (!Number.isFinite(d.getTime())) throw new NumericError("enter a valid date and time");
  return d.toISOString();
}

function localNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TradeTicket() {
  const { state } = useApp();
  const ledger = ledgerOf(state);
  const active = ledger.activeCampaign;
  const snapshot = active ? (state.snapshots.find((s) => s.root === active.root) ?? active.frozenSnapshot) : selectedSnapshot(state);
  const title = active ? `${active.contract} · ${active.state === "PENDING" ? "Pending paper fill" : "Position"}` : snapshot ? `${INSTRUMENTS[snapshot.root].contract} · Trade ticket` : "Trade ticket";
  const stage = active ? active.state : "PLAN";
  return (
    <section className="cp-panel" aria-labelledby="ticket-title">
      <div className="cp-row">
        <h2 id="ticket-title">{title}</h2>
        <span className="cp-status">{stage}</span>
      </div>
      {state.mode === "manual" ? <ManualTicket snapshot={snapshot} active={active} /> : <PaperTicket snapshot={snapshot} active={active} />}
    </section>
  );
}

function PlannedGroup({ snapshot, side, equityMils, contractsOverride }: { snapshot: SignalSnapshot; side: Side | null; equityMils: Mils | null; contractsOverride?: number }) {
  const { state } = useApp();
  const plan = draftPlan(snapshot, side, equityMils, state.cfg, contractsOverride);
  if (!plan.ok) {
    return (
      <div className="cp-group">
        <h3>Planned (model · USD)</h3>
        <p className="cp-small">{snapshot.status === "UNAVAILABLE" ? "Signal unavailable" : "No plan"} · {plan.reason}</p>
      </div>
    );
  }
  const root = snapshot.root;
  const note = `${plan.marginNote} · risk includes ${plan.perContractRisk.costConvention} · a planned loss, not a guaranteed maximum`;
  return (
    <div className="cp-group">
      <h3>Planned (model v{state.cfg.version} · synthetic inputs · USD)</h3>
      <div className="cp-fields">
        <div className="cp-field">Contract<span className="cp-v">{plan.instrument.contract}</span></div>
        <div className="cp-field">Side<span className="cp-v">{sideText(plan.side)}</span></div>
        <div className="cp-field">Contracts<span className="cp-v">{plan.sizing ? (plan.sizing.skip ? `0 · skip` : plan.sizing.contracts) : `${plan.contracts} (equity not entered)`}</span></div>
        <div className="cp-field">Planned entry<span className="cp-v">{fmtPrice(plan.plannedEntry, root)}</span></div>
        <div className="cp-field">Proposed initial stop<span className="cp-v">{fmtPrice(plan.plannedStop, root)}</span></div>
        <div className="cp-field">Distance<span className="cp-v cp-ellipsis" title={`${fmtPoints(plan.distanceTicks, root)} · ${fmtPct(plan.pctOfEntry)} of entry`}>{fmtPrice(plan.distanceTicks, root)} pts · {fmtPct(plan.pctOfEntry)}</span></div>
        <div className="cp-field">Planned risk<span className="cp-v cp-ellipsis" title={`${fmtMoney(plan.riskMils)} = ${plan.contracts} contracts × ${fmtMoney(plan.perContractRisk.totalMils)} per contract`}>{fmtMoney(plan.riskMils)} ({plan.contracts}×)</span></div>
        <div className="cp-field">% of account equity<span className="cp-v">{plan.pctOfEquity === null ? `${EM_DASH} · equity not entered` : fmtPct(plan.pctOfEquity)}</span></div>
      </div>
      <p className="cp-small cp-ellipsis" title={note}>{note} (full text in Formula drawer)</p>
    </div>
  );
}

function OpenState({ summary, c }: { summary: PositionSummary; c: Campaign }) {
  const root = c.root;
  return (
    <div className="cp-group">
      <h3>Open position (pinned · USD)</h3>
      <div className="cp-flags" aria-live="polite">
        {summary.flags.length ? summary.flags.map((f) => <span key={f} className="cp-flag">{f}</span>) : <span className="cp-small">No flags · HOLD</span>}
      </div>
      <div className="cp-fields">
        <div className="cp-field">Mark<span className="cp-value">{summary.mark ? `${fmtPrice(summary.mark.price, root)} · ${fmtTime(summary.mark.observedAt)}${summary.markStale ? " · STALE" : ""}` : `${EM_DASH} · no mark feed`}</span></div>
        <div className="cp-field">Average entry<span className="cp-value">{summary.averageEntryTicks === null ? EM_DASH : fmtPrice(summary.averageEntryTicks, root)} · {c.remaining}/{c.entryQuantity}</span></div>
        <div className="cp-field">Original risk (frozen)<span className="cp-value">{fmtMoney(summary.originalRiskMils)}</span></div>
        <div className="cp-field">Unrealized P&amp;L{summary.markStale && summary.mark ? " (stale)" : ""}<span className="cp-value">{summary.unrealizedMils === null ? `${EM_DASH} · no mark feed` : fmtMoney(summary.unrealizedMils, true)}</span></div>
        <div className="cp-field">Realized P&amp;L (net of fees)<span className="cp-value">{fmtMoney(summary.realizedMils, true)}</span></div>
        <div className="cp-field">Total fees<span className="cp-value">{fmtMoney(summary.feesMils)}</span></div>
        <div className="cp-field">Current R multiple<span className="cp-value">{summary.rMultiple === null ? EM_DASH : `${fmtNum(summary.rMultiple)} R${summary.markStale ? " (stale)" : ""}`}</span></div>
        <div className="cp-field">Proposed trailing stop<span className="cp-value">{fmtPrice(summary.proposedStop ?? summary.restingStop, root)}{c.stopFrozenReason ? " · frozen" : ""}</span></div>
        <div className="cp-field">{c.mode === "paper" ? "Simulated resting stop" : "Recorded broker stop"}<span className="cp-value">{c.mode === "paper" ? fmtPrice(summary.restingStop, root) : summary.brokerStop === null ? `${EM_DASH} · not recorded` : `${fmtPrice(summary.brokerStop, root)} · ${c.brokerStop?.status}`}</span></div>
        {c.mode === "manual" && (
          <div className="cp-field">Discrepancy<span className="cp-value">{summary.discrepancy.diffTicks === null ? EM_DASH : summary.discrepancy.matches ? "none" : `${summary.discrepancy.diffTicks} ticks`}</span></div>
        )}
        {c.closeRequested && <div className="cp-field">Close required<span className="cp-value">{c.closeRequested.reason}</span></div>}
      </div>
    </div>
  );
}

function ManualTicket({ snapshot, active }: { snapshot: SignalSnapshot | null; active: Campaign | null }) {
  const { state } = useApp();
  const ledger = state.ledgers.manual;
  const seeded = ledger.events.some((e) => e.type === "CASH_FLOW");
  const equity = seeded ? ledger.equityMils : null;
  const now = new Date().toISOString();

  if (active) {
    const summary = positionSummary(active, ledger.state.marks[active.root] ?? null, now, DAY_MS);
    return (
      <>
        <p className="cp-small">Manual journal · fills and stops below are what you recorded at your broker. No order is sent from here.</p>
        <OpenState summary={summary} c={active} />
        <ManualOpenActions c={active} snapshot={snapshot} />
      </>
    );
  }
  if (!snapshot) return <p className="cp-small">Select a market.</p>;
  const side = candidateSide(snapshot);
  const anyQualified = state.snapshots.some((s) => s.status === "QUALIFIED");
  return (
    <>
      <p className="cp-small">
        {snapshot.status === "QUALIFIED" ? `${snapshot.root} qualifies (${snapshot.displaySide}). ` : anyQualified ? `${snapshot.root} does not qualify; inspecting a non-qualifying market. ` : "No qualifying trade. "}
        Recording is journaling only; a draft is not a fill.
      </p>
      <PlannedGroup snapshot={snapshot} side={side} equityMils={equity} />
      <ManualEntryForm key={`${snapshot.root}:${state.configLabel}:${equity ?? "none"}`} snapshot={snapshot} side={side} equityMils={equity} />
    </>
  );
}

function ManualEntryForm({ snapshot, side, equityMils }: { snapshot: SignalSnapshot; side: Side | null; equityMils: Mils | null }) {
  const { state, actions } = useApp();
  const inst = INSTRUMENTS[snapshot.root];
  const plan = draftPlan(snapshot, side, equityMils, state.cfg);
  const plannedPriceText = plan.ok ? fmtPrice(plan.plannedEntry, snapshot.root) : "";
  const plannedStopText = plan.ok ? fmtPrice(plan.plannedStop, snapshot.root) : "";
  const tickText = fmtPrice(1, snapshot.root);
  // Prefilled with the planned values as real controlled values: recording a fill at plan is one click.
  const [qty, setQty] = useState(() => (plan.ok ? String(Math.max(1, plan.contracts)) : "1"));
  const [price, setPrice] = useState(plannedPriceText);
  const [time, setTime] = useState(localNow);
  const [tz, setTz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [fees, setFees] = useState("0");
  const [brokerStatus, setBrokerStatus] = useState<"none" | "working" | "confirmed">("none");
  const [brokerPrice, setBrokerPrice] = useState(plannedStopText);
  const [deviation, setDeviation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<"qty" | "price" | "time" | "fees" | "brokerPrice" | "deviation", string>>>({});
  const [chosenSide, setChosenSide] = useState<Side>(side ?? 1);

  const canRecord = plan.ok;
  const priceDiffers = price.trim() !== "" && Number(price) !== Number(plannedPriceText);
  const qtyDiffers = qty.trim() !== "" && plan.ok && Number(qty) !== plan.contracts;
  const sideDiffers = plan.ok && chosenSide !== plan.side;
  const deviates = priceDiffers || qtyDiffers || sideDiffers;

  /** Human, field-level validation. Returns parsed values or the map of messages. */
  function validate(): { ok: true; fillPrice: Ticks; quantity: number; filledAt: string; feesMils: Mils; brokerPriceTicks: Ticks | null } | { ok: false; errors: typeof fieldErrors } {
    const errors: typeof fieldErrors = {};
    let fillPrice: Ticks | null = null;
    let brokerPriceTicks: Ticks | null = null;
    let filledAt = "";
    let feesMils: Mils | null = null;
    const quantity = Number(qty);
    if (qty.trim() === "" || !Number.isInteger(quantity) || quantity < 1) errors.qty = "Contracts must be a whole number ≥ 1";
    if (price.trim() === "") errors.price = "Fill price is required";
    else {
      try {
        fillPrice = toTicks(price.trim(), inst.tick, "exact");
      } catch {
        errors.price = `Fill price must be on the ${tickText} tick grid`;
      }
    }
    try {
      filledAt = toIso(time);
    } catch {
      errors.time = "Fill time must be a valid date and time";
    }
    try {
      feesMils = dollarsToMils(fees.trim() || "0");
      if (feesMils < 0) errors.fees = "Entry fees must be 0.00 or more";
    } catch {
      errors.fees = "Entry fees must be a USD amount with at most 3 decimals";
    }
    if (brokerStatus !== "none" && brokerPrice.trim() !== "") {
      try {
        brokerPriceTicks = toTicks(brokerPrice.trim(), inst.tick, "exact");
      } catch {
        errors.brokerPrice = `Broker stop price must be on the ${tickText} tick grid`;
      }
    }
    if (deviates && deviation.trim() === "") errors.deviation = "Deviation reason is required: fill differs from plan";
    if (Object.keys(errors).length > 0 || fillPrice === null || feesMils === null) return { ok: false, errors };
    return { ok: true, fillPrice, quantity, filledAt, feesMils, brokerPriceTicks };
  }

  function humanize(message: string): string {
    if (/still active; one position per mode/.test(message)) return "A manual position is already open. Record its exit before entering another.";
    if (/deviationReason is required/.test(message)) return "Deviation reason is required: fill differs from plan (price, contracts or side)";
    if (/cannot record entry/.test(message)) return `Cannot record entry: ${message.replace(/^cannot record entry: /, "")}`;
    return message;
  }

  function submit() {
    if (!plan.ok) return;
    const v = validate();
    if (!v.ok) {
      setFieldErrors(v.errors);
      setError(Object.values(v.errors)[0] ?? null);
      return;
    }
    setFieldErrors({});
    try {
      const plannedContracts = plan.sizing ? plan.sizing.contracts : plan.contracts;
      const id = newEventId(`manual:${snapshot.root}`);
      const brokerStop =
        brokerStatus === "none"
          ? undefined
          : { price: v.brokerPriceTicks, status: (brokerStatus === "confirmed" ? "working" : "unknown") as BrokerStopStatus, confirmedAt: brokerStatus === "confirmed" ? new Date().toISOString() : v.filledAt };
      const events = recordEntryFill({
        id,
        campaignId: id,
        root: snapshot.root,
        side: chosenSide,
        snapshot,
        planned: { side: plan.side, entry: plan.plannedEntry, stop: plan.plannedStop, contracts: plannedContracts },
        fill: { price: v.fillPrice, quantity: v.quantity, filledAt: v.filledAt, timezone: tz, feesMils: v.feesMils },
        deviationReason: deviation.trim() || undefined,
        brokerStop,
        equityMils: equityMils ?? mils(0),
        recordedAt: new Date().toISOString(),
        cfg: state.cfg,
      });
      const err = actions.append("manual", events);
      setError(err ? humanize(err) : null);
      if (!err) actions.setNotice("Entry fill recorded in the manual journal. No order was sent. Record your broker stop confirmation separately.");
    } catch (e) {
      setError(e instanceof LedgerError || e instanceof NumericError ? humanize(e.message) : String(e));
    }
  }

  const fieldError = (key: keyof typeof fieldErrors) => (fieldErrors[key] ? <span className="cp-error" role="alert">{fieldErrors[key]}</span> : null);

  return (
    <div className="cp-group">
      <h3>Actual fill (recorded at your broker · USD)</h3>
      <div className="cp-fields">
        <div className="cp-field">Contract<span className="cp-v">{inst.contract}</span></div>
        <label>
          Side
          <select value={chosenSide} onChange={(ev) => setChosenSide(Number(ev.target.value) as Side)}>
            <option value={1}>Buy / long</option>
            <option value={-1}>Sell / short</option>
          </select>
        </label>
        <label>Contracts<input type="number" min={1} step={1} value={qty} onChange={(ev) => setQty(ev.target.value)} aria-invalid={!!fieldErrors.qty} />{fieldError("qty")}</label>
        <label>Fill price<input inputMode="decimal" value={price} onChange={(ev) => setPrice(ev.target.value)} aria-invalid={!!fieldErrors.price} />{fieldError("price")}</label>
        <label>Fill time<input type="datetime-local" value={time} onChange={(ev) => setTime(ev.target.value)} aria-invalid={!!fieldErrors.time} />{fieldError("time")}</label>
        <label>Timezone<input value={tz} onChange={(ev) => setTz(ev.target.value)} /></label>
        <label>Entry fees<input inputMode="decimal" value={fees} onChange={(ev) => setFees(ev.target.value)} aria-invalid={!!fieldErrors.fees} />{fieldError("fees")}</label>
        <div className="cp-field">
          <span>Broker stop status · price</span>
          <span className="cp-pair">
            <select aria-label="Broker stop status" value={brokerStatus} onChange={(ev) => setBrokerStatus(ev.target.value as "none" | "working" | "confirmed")}>
              <option value="none">none</option>
              <option value="working">working (unconfirmed)</option>
              <option value="confirmed">working (confirmed)</option>
            </select>
            <input aria-label="Broker stop price" inputMode="decimal" value={brokerPrice} onChange={(ev) => setBrokerPrice(ev.target.value)} disabled={brokerStatus === "none"} aria-invalid={!!fieldErrors.brokerPrice} />
          </span>
          {fieldError("brokerPrice")}
        </div>
        {deviates && (
          <label style={{ gridColumn: "1 / -1" }}>Deviation reason (required: {[priceDiffers ? "price" : "", qtyDiffers ? "contracts" : "", sideDiffers ? "side" : ""].filter(Boolean).join(", ")} differ from plan)<input value={deviation} onChange={(ev) => setDeviation(ev.target.value)} aria-invalid={!!fieldErrors.deviation} />{fieldError("deviation")}</label>
        )}
      </div>
      {error && <p className="cp-error" role="alert">{error}</p>}
      <div className="cp-actions">
        <button type="button" className="cp-main" onClick={submit} disabled={!canRecord}>Record entry fill</button>
        <span className="cp-small">{canRecord ? "Journals an existing broker fill. Never sends an order." : "Signal unavailable for this market; nothing to plan. You may still journal via another market card."}</span>
      </div>
    </div>
  );
}

function ManualOpenActions({ c, snapshot }: { c: Campaign; snapshot: SignalSnapshot | null }) {
  const { state, actions } = useApp();
  const inst = INSTRUMENTS[c.root];
  const [exitPrice, setExitPrice] = useState("");
  const [exitQty, setExitQty] = useState(String(c.remaining));
  const [exitTime, setExitTime] = useState(localNow);
  const [exitFees, setExitFees] = useState("0");
  const [exitDeviation, setExitDeviation] = useState("");
  const [markPrice, setMarkPrice] = useState("");
  const [markTime, setMarkTime] = useState(localNow);
  const [closePrice, setClosePrice] = useState("");
  const [closeTime, setCloseTime] = useState(localNow);
  const [brokerPrice, setBrokerPrice] = useState("");
  const [brokerStatus, setBrokerStatus] = useState<BrokerStopStatus>("working");
  const [error, setError] = useState<string | null>(null);

  /** Runs a write; on success clears the form via onSuccess so a second click cannot re-submit the same input. */
  function guard(fn: () => string | null, onSuccess?: () => void) {
    try {
      const err = fn();
      setError(err);
      if (!err) onSuccess?.();
    } catch (e) {
      setError(e instanceof LedgerError || e instanceof NumericError ? e.message : String(e));
    }
  }

  return (
    <div className="cp-group">
      <h3>Record (actual · USD)</h3>
      <div className="cp-fields">
        <label>Exit price<input inputMode="decimal" value={exitPrice} onChange={(ev) => setExitPrice(ev.target.value)} /></label>
        <label>Exit contracts<input type="number" min={1} max={c.remaining} step={1} value={exitQty} onChange={(ev) => setExitQty(ev.target.value)} /></label>
        <label>Exit time<input type="datetime-local" value={exitTime} onChange={(ev) => setExitTime(ev.target.value)} /></label>
        <label>Exit fees<input inputMode="decimal" value={exitFees} onChange={(ev) => setExitFees(ev.target.value)} /></label>
        <label style={{ gridColumn: "span 3" }}>Deviation reason (optional)<input value={exitDeviation} onChange={(ev) => setExitDeviation(ev.target.value)} /></label>
        <div className="cp-field">
          <span>&nbsp;</span>
          <button
            type="button"
            className="cp-main"
            disabled={exitPrice.trim() === "" || exitQty.trim() === ""}
            onClick={() =>
              guard(
                () => {
                  const filledAt = toIso(exitTime);
                  return actions.append("manual", [
                    recordExitFill({ id: newEventId(`${c.id}:exit`), campaignId: c.id, price: toTicks(exitPrice.trim(), inst.tick, "exact"), quantity: Number(exitQty), filledAt, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, feesMils: dollarsToMils(exitFees.trim() || "0"), deviationReason: exitDeviation.trim() || undefined, recordedAt: new Date().toISOString() }),
                  ]);
                },
                () => {
                  setExitPrice("");
                  setExitDeviation("");
                  setExitFees("0");
                },
              )
            }
          >
            Record exit fill
          </button>
        </div>
      </div>
      <div className="cp-fields">
        <label>Mark price<input inputMode="decimal" value={markPrice} onChange={(ev) => setMarkPrice(ev.target.value)} /></label>
        <label>Mark time<input type="datetime-local" value={markTime} onChange={(ev) => setMarkTime(ev.target.value)} /></label>
        <div className="cp-field">
          <span>&nbsp;</span>
          <button
            type="button"
            disabled={markPrice.trim() === ""}
            onClick={() =>
              guard(
                () => {
                  const observedAt = toIso(markTime);
                  return actions.append("manual", [recordMark({ id: newEventId(`${c.id}:mark`), root: c.root, price: toTicks(markPrice.trim(), inst.tick, "exact"), observedAt, source: "manual-entered" })]);
                },
                () => setMarkPrice(""),
              )
            }
            title="A mark updates P&L and equity only; it never moves the trailing-stop reference."
          >
            Record mark
          </button>
        </div>
        <label>Completed close<input inputMode="decimal" value={closePrice} onChange={(ev) => setClosePrice(ev.target.value)} /></label>
        <label>Bar end<input type="datetime-local" value={closeTime} onChange={(ev) => setCloseTime(ev.target.value)} /></label>
        <div className="cp-field">
          <span>&nbsp;</span>
          <button
            type="button"
            disabled={closePrice.trim() === ""}
            onClick={() =>
              guard(
                () => {
                  const barEnd = toIso(closeTime);
                  const err = actions.append("manual", [recordCompletedClose({ id: newEventId(`${c.id}:close`), root: c.root, price: toTicks(closePrice.trim(), inst.tick, "exact"), barEnd })]);
                  if (!err) actions.setNotice("Completed close recorded. Recalculate the proposed stop to apply it; only completed closes move the ratchet reference.");
                  return err;
                },
                () => setClosePrice(""),
              )
            }
            title="Only a completed bar close advances the highest/lowest close used by the trailing stop."
          >
            Record completed close
          </button>
        </div>
        <div className="cp-field">
          <span>&nbsp;</span>
          <button
            type="button"
            onClick={() =>
              guard(() => {
                const previous = c.proposedStop;
                if (!previous || !snapshot) return "no proposed stop or snapshot to recalculate from";
                const extreme = c.extremeClose ?? snapshot.raw.closeT;
                if (extreme === null) return "no completed close available";
                // A running campaign is governed by the config frozen at entry, never the live settings.
                const r = proposeTrailingStop({ id: newEventId(`${c.id}:propose`), campaignId: c.id, previous, extremeClose: extreme, atrTicks: snapshot.raw.atr20Ticks, H: snapshot.H, calculatedAt: new Date().toISOString(), cfg: c.frozenConfig });
                const err = actions.append("manual", [r.event]);
                if (!err) actions.setNotice(r.changed ? "Proposed stop tightened. Your broker stop is unchanged until you record it." : "Proposed stop unchanged (ratchet never loosens).");
                return err;
              })
            }
          >
            Recalculate proposed stop
          </button>
        </div>
      </div>
      <div className="cp-fields">
        <label>Broker stop price<input inputMode="decimal" value={brokerPrice} onChange={(ev) => setBrokerPrice(ev.target.value)} /></label>
        <label>
          Broker stop status
          <select value={brokerStatus} onChange={(ev) => setBrokerStatus(ev.target.value as BrokerStopStatus)}>
            <option value="working">working (confirmed)</option>
            <option value="unknown">unknown</option>
            <option value="cancelled">cancelled</option>
            <option value="filled">filled (record the exit separately)</option>
          </select>
        </label>
        <div className="cp-field">
          <span>&nbsp;</span>
          <button
            type="button"
            disabled={brokerPrice.trim() === "" && brokerStatus === "working"}
            onClick={() =>
              guard(
                () => {
                  const at = new Date().toISOString();
                  return actions.append("manual", [recordBrokerStop({ id: newEventId(`${c.id}:broker`), campaignId: c.id, price: brokerPrice.trim() ? toTicks(brokerPrice.trim(), inst.tick, "exact") : null, status: brokerStatus, confirmedAt: at, recordedAt: at })]);
                },
                () => setBrokerPrice(""),
              )
            }
          >
            Record broker stop
          </button>
        </div>
      </div>
      {error && <p className="cp-error" role="alert">{error}</p>}
      <p className="cp-small">A touched stop or acknowledged alert does not close the campaign; only a recorded exit fill does. Partial exits reconcile remaining size.</p>
    </div>
  );
}

function PaperTicket({ snapshot, active }: { snapshot: SignalSnapshot | null; active: Campaign | null }) {
  const { state, actions } = useApp();
  const ledger = state.ledgers.paper;
  const paused = ledger.state.paused;
  const clock = ledger.state.stopMonitor.lastCheckedAt ?? new Date().toISOString();
  const monitor = stopMonitorStatus(ledger, clock, 2 * DAY_MS);
  const demo = state.demo;
  const stepsLeft = active ? (demo.campaignId === active.id ? Math.max(0, (demo.total || 4) - demo.next) : 4) : 0;
  const equity = ledger.equityMils;

  function start() {
    const o = actions.paperStart();
    if (!o) {
      actions.setNotice("Paper engine error; see the banner above. Nothing was queued.");
      return;
    }
    const skippedText = (list: { root: string; reason: string }[]) => list.map((s) => `${s.root}: ${s.reason}`).join("; ");
    actions.setNotice(
      o.kind === "queued"
        ? `Paper engine queued ${o.root} (${o.contracts} contracts) as PENDING. Fill occurs on the next synthetic demo bar.${o.skipped.length ? ` Skipped before it: ${skippedText(o.skipped)}.` : ""}`
        : o.kind === "no-qualifying"
          ? "No qualifying trade. The engine queued nothing."
          : o.kind === "skip"
            ? o.skipped.length
              ? `Nothing queued. Skipped: ${skippedText(o.skipped)}.`
              : `Nothing queued: ${o.reason}.`
            : o.kind === "paused"
              ? "Paper engine is paused; no new entries."
              : "A paper position is already active.",
    );
  }

  function step() {
    const out = actions.paperStep();
    if (!out) {
      actions.setNotice("No demo bar to run. Start the engine while flat, or the demo sequence is complete.");
      return;
    }
    actions.setNotice(
      out.exited
        ? `Synthetic demo bar: ${out.exited.reason} exit at ${fmtPrice(out.exited.price, active?.root ?? "NQ")} including modeled adverse tick and fees. Not market evidence.`
        : out.closeRequested
          ? "Synthetic demo bar: CLOSE REQUIRED — the recalculated stop is beyond the executable market; exit at the next observation."
          : out.stopFrozen
            ? "Synthetic demo bar: inputs missing, resting stop frozen (DATA STALE)."
            : `Synthetic demo bar processed${out.stopChanged ? "; resting stop tightened" : ""}. Marks are synthetic.`,
    );
  }

  return (
    <>
      <p className="cp-small">
        PAPER ONLY · deterministic engine · {paused ? "PAUSED (no new entries; stops still monitored)" : "running"} · stop monitor {monitor.healthy ? "healthy" : "not healthy"} ({monitor.lastCheckedAt ? `last check ${fmtTime(monitor.lastCheckedAt)}` : "never ran"}) · equity {fmtMoney(equity)} USD · Synthetic demo bars, not market data
      </p>
      {active ? (
        <>
          {active.state === "OPEN" && <OpenState summary={positionSummary(active, ledger.state.marks[active.root] ?? null, clock, 2 * DAY_MS)} c={active} />}
          <div className="cp-group">
            <h3>{active.state === "PENDING" ? "Pending (queued at decision bar; not filled · USD)" : "Plan at decision (USD)"}</h3>
            <div className="cp-fields">
              <div className="cp-field">Contract<span className="cp-v">{active.contract}</span></div>
              <div className="cp-field">Side<span className="cp-v">{sideText(active.side)}</span></div>
              <div className="cp-field">Contracts<span className="cp-v">{active.plan.contracts}</span></div>
              <div className="cp-field">Planned entry / stop<span className="cp-v">{fmtPrice(active.plan.plannedEntry, active.root)} / {fmtPrice(active.plan.plannedStop, active.root)}</span></div>
              <div className="cp-field">Budget<span className="cp-v">{fmtMoney(active.plan.riskBudgetMils)} ({fmtPct(active.frozenConfig.riskBudgetPct, 2)} of equity at decision)</span></div>
              <div className="cp-field">Per-contract risk<span className="cp-v">{fmtMoney(active.plan.perContractRisk.totalMils)}</span></div>
              <div className="cp-field">Planned loss<span className="cp-v">{fmtMoney(active.plan.sizing.plannedLossMils)} · {fmtPct(active.plan.sizing.plannedLossPctOfEquity)} of equity</span></div>
              <div className="cp-field">Frozen config<span className="cp-v">v{active.frozenConfig.version}</span></div>
            </div>
            <p className="cp-small cp-ellipsis" title={active.plan.sizing.marginNote}>{active.plan.sizing.marginNote}</p>
          </div>
        </>
      ) : snapshot ? (
        <>
          <p className="cp-small">{state.snapshots.some((s) => s.status === "QUALIFIED") ? "Flat. Start the engine to queue the highest qualifying, sizeable candidate." : "No qualifying trade. Starting the engine queues nothing."}</p>
          <PlannedGroup snapshot={snapshot} side={candidateSide(snapshot)} equityMils={equity} />
        </>
      ) : (
        <p className="cp-small">Select a market.</p>
      )}
      <div className="cp-actions cp-footer">
        <button type="button" className="cp-main" onClick={start} disabled={!!active || paused}>Start paper engine</button>
        <button type="button" onClick={step} disabled={!active || stepsLeft === 0}>Run paper step{active ? ` (${stepsLeft} synthetic bars left)` : ""}</button>
        {paused ? (
          <button type="button" onClick={() => actions.paperResume()}>Resume</button>
        ) : (
          <button type="button" onClick={() => actions.paperPause()}>Pause</button>
        )}
      </div>
    </>
  );
}
