/**
 * Model reading panel (addendum Decision 4): the interpreter's reading sits above the ticket, before
 * the user picks a market. Collapsed by default to two lines so the console still fits above the fold.
 *
 * Everything here is display. Evidence strength is a word, never a percentage and never called
 * confidence. Numbers are the request's tick integers rendered through ui/format; nothing is
 * recomputed. What the risk engine changed or refused is shown next to the proposal, not hidden.
 */
import { useState } from "react";
import { ledgerOf, useApp, type ModelReading as ModelReadingState } from "../app/store";
import type { InstrumentRoot } from "../config/modelConfig";
import type { ClampedProposal, InterpreterResponse } from "../interpreter/types";
import { EM_DASH, fmtMoney, fmtNum, fmtPrice, fmtTime, sideText } from "./format";

function actionLine(response: InterpreterResponse | null): string {
  if (!response) return "no proposal yet";
  const p = response.proposal;
  const root = p.root ?? EM_DASH;
  const side = p.side === null ? "" : ` ${p.side === 1 ? "long" : "short"}`;
  return `${p.action.toUpperCase()} ${root}${side}`;
}

function clampedLine(clamped: ClampedProposal | null, reasons: string[]): string | null {
  if (clamped === null) {
    return reasons.length > 0 ? `Not executed: ${reasons.join("; ")}` : null;
  }
  if (clamped.action === "enter" && clamped.stopTicks !== clamped.originalStopTicks) {
    return `Stop clamped by the risk engine: ${clamped.originalStopTicks} → ${clamped.stopTicks} ticks. ${reasons.join("; ")}`;
  }
  return reasons.length > 0 ? reasons.join("; ") : null;
}

function priceOf(ticks: number | null, root: InstrumentRoot | null): string {
  if (ticks === null || root === null) return EM_DASH;
  return fmtPrice(ticks, root);
}

export interface ModelReadingProps {
  /** Tests render the expanded state directly; the app starts collapsed. */
  initiallyExpanded?: boolean;
}

export function ModelReading({ initiallyExpanded = false }: ModelReadingProps) {
  const { state, actions } = useApp();
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const reading: ModelReadingState | null = state.modelReading;
  const response = reading?.response ?? null;
  const ledger = ledgerOf(state);
  const usage = ledger.state.interpreter.usage;
  const cfg = state.cfg.interpreter;
  const notice = clampedLine(reading?.clamped ?? null, reading?.reasons ?? []);
  const hypothesis = response?.hypothesis ?? "No model reading yet. Ask the model to read the current bar.";

  return (
    <section className="cp-panel cp-model" aria-labelledby="model-reading-title">
      <div className="cp-row">
        <h2 id="model-reading-title">Model reading</h2>
        <span className="cp-actions">
          <button type="button" onClick={() => void actions.askModel()} disabled={state.modelInFlight} aria-busy={state.modelInFlight}>
            {state.modelInFlight ? "Asking model…" : "Ask model"}
          </button>
          <button type="button" aria-expanded={expanded} aria-controls="model-reading-detail" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Collapse" : "Expand"}
          </button>
        </span>
      </div>
      <p className="cp-small cp-ellipsis" title={`${cfg.model} · ${cfg.promptVersion} · ${reading?.barEnd ?? "no bar"}`}>
        {cfg.model} · {cfg.promptVersion} · bar {reading?.barEnd ? fmtTime(reading.barEnd) : EM_DASH} · evidence{" "}
        {response ? response.evidenceStrength : EM_DASH} · {actionLine(response)}
        {reading && reading.kind !== "advisory" && reading.kind !== "queued" ? ` · ${reading.kind}` : ""}
      </p>
      <p className="cp-small cp-ellipsis" title={hypothesis}>
        {hypothesis}
      </p>
      {notice && (
        <p className="cp-flag cp-ellipsis" title={notice} role="status">
          {notice}
        </p>
      )}
      {state.modelError && (
        <p className="cp-error" role="alert">
          {state.modelError}
        </p>
      )}
      {expanded && (
        <div className="cp-expand" id="model-reading-detail">
          {response ? (
            <>
              <div className="cp-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Market</th>
                      <th scope="col">Activity</th>
                      <th scope="col">Breadth</th>
                      <th scope="col">Price response</th>
                      <th scope="col">Noise</th>
                      <th scope="col">Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {response.readings.map((r) => (
                      <tr key={r.root}>
                        <td style={{ textAlign: "left" }}>{r.root}</td>
                        <td style={{ textAlign: "left" }}>{r.activity}</td>
                        <td style={{ textAlign: "left" }}>{r.breadth}</td>
                        <td style={{ textAlign: "left" }}>{r.priceResponse}</td>
                        <td style={{ textAlign: "left" }}>{r.noiseFlag ? "noisy" : "clean"}</td>
                        <td style={{ textAlign: "left" }}>{r.evidence.join(" · ") || EM_DASH}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <dl>
                <dt>Cross-market</dt>
                <dd>
                  {response.crossMarket.summary} · supports {response.crossMarket.supports.join(", ") || EM_DASH} · contradicts{" "}
                  {response.crossMarket.contradicts.join(", ") || EM_DASH}
                </dd>
                <dt>Hypothesis</dt>
                <dd>{response.hypothesis}</dd>
                <dt>Proposal</dt>
                <dd>
                  {response.proposal.action} · {response.proposal.root ?? EM_DASH} · {sideText(response.proposal.side)} · entry zone{" "}
                  {response.proposal.entryZone
                    ? `${priceOf(response.proposal.entryZone.lowTicks, response.proposal.root)} to ${priceOf(response.proposal.entryZone.highTicks, response.proposal.root)}`
                    : EM_DASH}{" "}
                  · proposed stop {priceOf(response.proposal.stopTicks, response.proposal.root)}
                </dd>
                <dt>Rationale</dt>
                <dd>{response.proposal.rationale}</dd>
                <dt>Cleared by the risk engine</dt>
                <dd>
                  {reading?.clamped
                    ? `${reading.clamped.action}${reading.clamped.action !== "exit" ? ` · stop ${priceOf(reading.clamped.stopTicks, reading.clamped.root)}` : ""}${
                        reading.clamped.action === "enter" ? ` · reference ${priceOf(reading.clamped.entryReferenceTicks, reading.clamped.root)}` : ""
                      }`
                    : `nothing executable${reading?.reasons.length ? `: ${reading.reasons.join("; ")}` : ""}`}
                </dd>
                <dt>Invalidation</dt>
                <dd>
                  {response.proposal.invalidation.length === 0
                    ? EM_DASH
                    : response.proposal.invalidation
                        .map((i) => `${i.kind} ${i.root}${i.threshold === null ? "" : ` ${fmtNum(i.threshold)}`}: ${i.note}`)
                        .join(" · ")}
                </dd>
                <dt>Evidence strength</dt>
                <dd>{response.evidenceStrength} (a word about the evidence, not a probability)</dd>
              </dl>
            </>
          ) : (
            <p className="cp-small">Nothing recorded for this bar yet.</p>
          )}
          <p className="cp-small">
            Calls {usage.calls} · input {usage.inputTokens.toLocaleString("en-US")} · cached {usage.cachedInputTokens.toLocaleString("en-US")} · output{" "}
            {usage.outputTokens.toLocaleString("en-US")} tokens · cost estimate {fmtMoney(usage.costEstimateMils)} USD (estimate) · {state.mode} ledger
          </p>
          <p className="cp-small">
            The model interprets and proposes. A deterministic calculator owns every number and the risk engine clamps every proposal; nothing here is a
            broker order. Fixture data throughout.
          </p>
        </div>
      )}
    </section>
  );
}
