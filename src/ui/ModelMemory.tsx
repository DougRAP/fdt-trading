/**
 * Model memory drawer (addendum "Feedback loop" → Audit).
 *
 * Lessons and the digest are what the model reads back; they cannot change a threshold, a size, a
 * stop bound or a candidate rule. A reset archives the current epoch and starts a new one: nothing is
 * ever deleted, and the archived lessons stay in the event log.
 */
import { useState } from "react";
import { ledgerOf, useApp } from "../app/store";
import { resetMemory } from "../interpreter/memory";
import { Drawer } from "./Drawer";
import { EM_DASH, fmtTime } from "./format";

export function ModelMemory() {
  const { state, actions } = useApp();
  const [confirming, setConfirming] = useState(false);
  const ledger = ledgerOf(state);
  const memory = ledger.state.interpreter;
  const lessons = [...memory.lessons].reverse();
  const modeLabel = state.mode === "manual" ? "Manual journal" : state.mode === "paper" ? "Paper (rules)" : "Paper (model)";

  function doReset() {
    const event = resetMemory(ledger, new Date().toISOString(), { reason: "user reset model memory", mode: state.mode });
    const error = actions.append(state.mode, [event]);
    setConfirming(false);
    actions.setNotice(
      error ?? `Model memory archived as ${event.previousEpochId}; new epoch ${event.epochId}. Nothing was deleted: the lessons stay in the event log.`,
    );
  }

  return (
    <Drawer open={state.drawer === "memory"} title={`Model memory · ${modeLabel} · epoch ${memory.memoryEpochId}`} onClose={() => actions.openDrawer(null)}>
      <p className="cp-small">
        What the model reads back into each request: the last {state.cfg.interpreter.lessonsN} lessons of this epoch and the digest that compacts older
        ones. Memory changes what the model reads, never a threshold, a size, a stop bound or a candidate rule. The rules-only paper ledger stays the
        control.
      </p>
      <h3>Lessons (newest first)</h3>
      {lessons.length === 0 ? (
        <p className="cp-small">No lessons in this epoch.</p>
      ) : (
        <div className="cp-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Campaign</th>
                <th scope="col">Epoch</th>
                <th scope="col">Recorded</th>
                <th scope="col">What held</th>
                <th scope="col">What failed</th>
                <th scope="col">Weigh differently</th>
                <th scope="col">Evidence to watch</th>
                <th scope="col">Model</th>
              </tr>
            </thead>
            <tbody>
              {lessons.map((l) => (
                <tr key={l.eventId}>
                  <td style={{ textAlign: "left" }}>{l.campaignId}</td>
                  <td style={{ textAlign: "left" }}>{l.epochId}</td>
                  <td style={{ textAlign: "left" }}>{fmtTime(l.at)}</td>
                  <td style={{ textAlign: "left" }}>{l.lesson.whatHeld.join(" · ") || EM_DASH}</td>
                  <td style={{ textAlign: "left" }}>{l.lesson.whatFailed.join(" · ") || EM_DASH}</td>
                  <td style={{ textAlign: "left" }}>{l.lesson.weighDifferently.join(" · ") || EM_DASH}</td>
                  <td style={{ textAlign: "left" }}>{l.lesson.evidenceToWatch.join(" · ") || EM_DASH}</td>
                  <td style={{ textAlign: "left" }}>{l.model} · {l.promptVersion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>Digest</h3>
      {memory.digest ? (
        <dl className="cp-expand" style={{ borderTop: "none" }}>
          <dt>Version</dt>
          <dd>
            v{memory.digest.digest.version} · covers {memory.digest.digest.lessonsCovered} lessons · {memory.digest.model} · {memory.digest.promptVersion} ·
            recorded {fmtTime(memory.digest.at)}
          </dd>
          <dt>Summary</dt>
          <dd>{memory.digest.digest.summary}</dd>
          <dt>What held</dt>
          <dd>{memory.digest.digest.whatHeld.join(" · ") || EM_DASH}</dd>
          <dt>What failed</dt>
          <dd>{memory.digest.digest.whatFailed.join(" · ") || EM_DASH}</dd>
          <dt>Weigh differently</dt>
          <dd>{memory.digest.digest.weighDifferently.join(" · ") || EM_DASH}</dd>
          <dt>Evidence to watch</dt>
          <dd>{memory.digest.digest.evidenceToWatch.join(" · ") || EM_DASH}</dd>
        </dl>
      ) : (
        <p className="cp-small">No digest in this epoch.</p>
      )}
      <div className="cp-group">
        <h3>Epochs</h3>
        <p className="cp-small">
          Current epoch {memory.memoryEpochId} · archived {memory.archivedEpochIds.join(", ") || EM_DASH}
        </p>
        {confirming ? (
          <div className="cp-actions">
            <span className="cp-small">
              Reset archives epoch {memory.memoryEpochId} and starts a new one. Nothing is deleted: every lesson stays in the event log under its epoch,
              and the next request carries no lessons until new ones are written.
            </span>
            <button type="button" className="cp-main" onClick={doReset}>
              Archive and start a new epoch
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirming(true)} disabled={state.modelInFlight}>
            Reset model memory
          </button>
        )}
      </div>
    </Drawer>
  );
}
