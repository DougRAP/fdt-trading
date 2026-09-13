import { ledgerOf, useApp } from "../app/store";
import type { LedgerEvent } from "../campaign/types";
import type { InstrumentRoot } from "../config/modelConfig";
import { Drawer } from "./Drawer";
import { EM_DASH, fmtMoney, fmtPrice, fmtTime } from "./format";

function describe(e: LedgerEvent, root: (id: string) => InstrumentRoot): string {
  switch (e.type) {
    case "CAMPAIGN_QUEUED":
      return `${e.root} ${e.side === 1 ? "long" : "short"} · plan ${e.plan.contracts} @ ${fmtPrice(e.plan.plannedEntry, e.root)} stop ${fmtPrice(e.plan.plannedStop, e.root)} · config v${e.frozenConfig.version} frozen`;
    case "ENTRY_FILL": {
      const r = root(e.campaignId);
      return `entry ${e.side === 1 ? "long" : "short"} ${e.quantity} @ ${fmtPrice(e.price, r)} fees ${fmtMoney(e.feesMils)} · ${e.fillModel}${e.deviationReason ? ` · deviation: ${e.deviationReason}` : ""}`;
    }
    case "EXIT_FILL": {
      const r = root(e.campaignId);
      return `exit ${e.quantity} @ ${fmtPrice(e.price, r)} fees ${fmtMoney(e.feesMils)} · ${e.reason} · ${e.fillModel}${e.deviationReason ? ` · deviation: ${e.deviationReason}` : ""}`;
    }
    case "STOP_SET": {
      const r = root(e.campaignId);
      return `${e.kind} stop ${fmtPrice(e.stop.stop, r)} · ${e.stop.source} · effective after ${fmtTime(e.stop.effectiveAfter)}${e.stop.reason ? ` · ${e.stop.reason.code}` : ""}`;
    }
    case "BROKER_STOP_RECORDED": {
      const r = root(e.campaignId);
      return `broker stop ${e.price === null ? EM_DASH : fmtPrice(e.price, r)} · ${e.status} · confirmed ${fmtTime(e.confirmedAt)}`;
    }
    case "MARK":
      return `${e.root} mark ${fmtPrice(e.price, e.root)} observed ${fmtTime(e.observedAt)} · ${e.source}`;
    case "CASH_FLOW":
      return `cash flow ${fmtMoney(e.amountMils, true)} · ${e.note}`;
    case "PAPER_PAUSED":
      return "paper engine paused";
    case "PAPER_RESUMED":
      return "paper engine resumed";
    case "CAMPAIGN_CANCELLED":
      return `cancelled · ${e.reason}`;
    case "CLOSE_REQUESTED":
      return `close required · ${e.reason}`;
    case "STOP_MONITOR":
      return `${e.healthy ? "healthy" : "unhealthy"} · ${e.detail}`;
    case "INTERPRETER_REQUEST":
      return `request ${e.requestHash} · ${e.callKind} · ${e.model} · ${e.promptVersion} · ${e.nBars} bars`;
    case "INTERPRETER_RESPONSE":
      return `response ${e.responseId} · ${e.response.proposal.action}${e.response.proposal.root ? ` ${e.response.proposal.root}` : ""} · evidence ${e.response.evidenceStrength} · ${e.model} · ${e.latencyMs} ms · cost estimate ${fmtMoney(e.costEstimateMils)}`;
    case "INTERPRETER_REJECTED":
      return `rejected · ${e.reason}`;
    case "INTERPRETER_CLAMPED":
      return `clamped ${e.before.action}${e.before.root ? ` ${e.before.root}` : ""} · ${e.after ? `executable ${e.after.action}` : "not executed"} · ${e.reasons.join("; ")}`;
    case "INTERPRETER_LESSON":
      return `lesson for ${e.campaignId} · epoch ${e.epochId} · ${e.model} · ${e.promptVersion}`;
    case "INTERPRETER_DIGEST":
      return `digest v${e.digest.version} covering ${e.digest.lessonsCovered} lessons · epoch ${e.epochId}`;
    case "INTERPRETER_MEMORY_RESET":
      return `memory reset · ${e.previousEpochId} archived, now ${e.epochId} · ${e.reason}`;
  }
}

export function JournalHistory() {
  const { state, actions } = useApp();
  const ledger = ledgerOf(state);
  const st = ledger.state;
  const rootOf = (id: string) => st.campaigns[id]?.root ?? "NQ";
  const superseded = new Set(st.supersededEventIds);
  return (
    <Drawer open={state.drawer === "journal"} title={`Journal history · ${state.mode === "manual" ? "Manual journal" : "Paper only"} · All time · fixture session · USD`} onClose={() => actions.openDrawer(null)}>
      <h3>Campaigns</h3>
      {ledger.campaigns.length === 0 ? (
        <p className="cp-small">No campaigns recorded.</p>
      ) : (
        <div className="cp-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Id</th>
                <th scope="col">State</th>
                <th scope="col">Entered</th>
                <th scope="col">Remaining</th>
                <th scope="col">Net realized</th>
                <th scope="col">Fees</th>
                <th scope="col">Original risk</th>
              </tr>
            </thead>
            <tbody>
              {ledger.campaigns.map((c) => (
                <tr key={c.id}>
                  <td>{c.id} · {c.contract} · {c.side === 1 ? "long" : "short"}</td>
                  <td>{c.state}</td>
                  <td>{c.entryQuantity}</td>
                  <td>{c.remaining}</td>
                  <td>{fmtMoney(c.netRealizedMils, true)}</td>
                  <td>{fmtMoney(c.feesMils)}</td>
                  <td>{fmtMoney(c.originalRiskMils)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>Event log (append-only; corrections keep the superseded event)</h3>
      {ledger.events.length === 0 ? (
        <p className="cp-small">Ledger is empty.</p>
      ) : (
        <div className="cp-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Type</th>
                <th scope="col">Kind</th>
                <th scope="col">Detail</th>
                <th scope="col">Id</th>
              </tr>
            </thead>
            <tbody>
              {ledger.events.map((e) => (
                <tr key={e.id} style={superseded.has(e.id) ? { textDecoration: "line-through" } : undefined}>
                  <td style={{ textAlign: "left" }}>{fmtTime(e.timestamp)}</td>
                  <td style={{ textAlign: "left" }}>{e.type}</td>
                  <td style={{ textAlign: "left" }}>{e.actual ? "actual" : "simulated"}</td>
                  <td style={{ textAlign: "left" }}>{describe(e, rootOf)}{e.supersededEventId ? ` · supersedes ${e.supersededEventId}` : ""}</td>
                  <td style={{ textAlign: "left" }}>{e.id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Drawer>
  );
}
