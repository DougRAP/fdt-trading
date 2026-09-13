/**
 * Single app store: mode, fixture snapshots, manual + paper ledgers (persisted after every append),
 * selection, drawers, versioned model config. No component does its own math; everything numeric
 * comes from snapshots, ledgers, plan.ts and the engine.
 */
import { createContext, createElement, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { LedgerEvent, Mode } from "../campaign/types";
import { modelConfig, type InstrumentRoot, type ModelConfig } from "../config/modelConfig";
import type { SignalSnapshot } from "../formula/types";
import { demoBarsFor, demoTrailInputs } from "../fixtures/paperBars";
import { fixtureSnapshots } from "../fixtures/snapshots";
import { fixtureSnapshotHistory, fixtureSnapshotsByBar } from "../fixtures/snapshotHistory";
import { callInterpreter } from "../interpreter/client";
import type { ClampedProposal, InterpreterResponse } from "../interpreter/types";
import { askModel as askModelEngine, onModelBar, onModelDecisionBar, type InterpreterCall, type ModelBarResult, type ModelDecisionResult, type ModelEngineInput } from "../paper/modelEngine";
import { Ledger } from "../ledger/ledger";
import { MemoryStorage, loadLedger, saveLedger, type StorageLike } from "../ledger/storage";
import { onDecisionBar, onExecutableBar, onObservationBar, pause as enginePause, resume as engineResume, type DecisionOutcome, type ObservationOutcome } from "../paper/engine";
import { candidateSide } from "./plan";

export type DrawerId = "formula" | "journal" | "settings" | "results" | "memory" | null;

/** Mode labels (D18). */
export const MODE_LABELS: Record<Mode, string> = { manual: "Manual journal", paper: "Paper (rules)", paperModel: "Paper (model)" };

export const CONFIG_KEY = "fdt.v1.config";

export interface ConfigOverrides {
  entryThreshold: number;
  breadthThreshold: number;
  stopBase: number;
  riskBudgetPct: number;
  aSmallWarn: number;
}

interface StoredConfig {
  schemaVersion: 1;
  label: string;
  overrides: ConfigOverrides;
}

export function overridesOf(cfg: ModelConfig): ConfigOverrides {
  return { entryThreshold: cfg.entryThreshold, breadthThreshold: cfg.breadthThreshold, stopBase: cfg.stopBase, riskBudgetPct: cfg.riskBudgetPct, aSmallWarn: cfg.aSmallWarn.value };
}

/**
 * Build the live config from saved overrides. `version` carries the settings label
 * ("0.1+user2": "0.1" is the model version, "+userN" the user's settings revision) so a campaign's
 * frozen config records exactly which settings it was entered under.
 */
export function applyOverrides(o: ConfigOverrides, label: string = modelConfig.version): ModelConfig {
  return Object.freeze({
    ...modelConfig,
    version: label,
    entryThreshold: o.entryThreshold,
    breadthThreshold: o.breadthThreshold,
    stopBase: o.stopBase,
    riskBudgetPct: o.riskBudgetPct,
    aSmallWarn: { ...modelConfig.aSmallWarn, value: o.aSmallWarn },
  });
}

export function loadConfig(storage: StorageLike): { cfg: ModelConfig; label: string; error: string | null } {
  const raw = storage.getItem(CONFIG_KEY);
  if (raw === null) return { cfg: modelConfig, label: modelConfig.version, error: null };
  try {
    const doc = JSON.parse(raw) as Partial<StoredConfig>;
    if (doc.schemaVersion !== 1 || !doc.overrides || typeof doc.label !== "string") {
      return { cfg: modelConfig, label: modelConfig.version, error: `stored model settings have an unknown schema; using v${modelConfig.version} defaults` };
    }
    const o = doc.overrides;
    const values = [o.entryThreshold, o.breadthThreshold, o.stopBase, o.riskBudgetPct, o.aSmallWarn];
    if (!values.every((v) => typeof v === "number" && Number.isFinite(v))) {
      return { cfg: modelConfig, label: modelConfig.version, error: "stored model settings contain non-finite values; using defaults" };
    }
    return { cfg: applyOverrides(o, doc.label), label: doc.label, error: null };
  } catch {
    return { cfg: modelConfig, label: modelConfig.version, error: "stored model settings are not valid JSON; using defaults" };
  }
}

/** Versioned save: label bumps "0.1" -> "0.1+user1" -> "0.1+user2"... Never touches running campaigns. */
export function saveConfig(storage: StorageLike, overrides: ConfigOverrides, previousLabel: string): { cfg: ModelConfig; label: string } {
  const m = /\+user(\d+)$/.exec(previousLabel);
  const n = m ? Number(m[1]) + 1 : 1;
  const label = `${modelConfig.version}+user${n}`;
  const doc: StoredConfig = { schemaVersion: 1, label, overrides };
  storage.setItem(CONFIG_KEY, JSON.stringify(doc));
  return { cfg: applyOverrides(overrides, label), label };
}

export function browserStorage(): StorageLike {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const probe = "fdt.probe";
      window.localStorage.setItem(probe, "1");
      window.localStorage.removeItem(probe);
      return window.localStorage;
    }
  } catch {
    /* fall through */
  }
  return new MemoryStorage();
}

export interface DemoProgress {
  campaignId: string | null;
  next: number;
  total: number;
}

export interface AppState {
  mode: Mode;
  snapshots: SignalSnapshot[];
  cfg: ModelConfig;
  configLabel: string;
  ledgers: Record<Mode, Ledger>;
  loadErrors: Record<Mode, string | null>;
  configError: string | null;
  /** Last error thrown by the paper engine on a user action; shown in the banner, never thrown into render. */
  engineError: string | null;
  selectedRoot: InstrumentRoot | null;
  drawer: DrawerId;
  demo: DemoProgress;
  notice: string | null;
  /** Bumped after every ledger mutation so consumers re-render. */
  ledgerVersion: number;
  storageKind: "localStorage" | "memory";
  /** Paper (model): consult the interpreter on a step, or run the rules alone (D22). */
  modelAssist: boolean;
  /** True while an interpreter call is in flight; every call is user-initiated. */
  modelInFlight: boolean;
  modelError: string | null;
  /** The latest reading for display, with what the risk engine cleared. */
  modelReading: ModelReading | null;
}

export interface ModelReading {
  mode: Mode;
  kind: ModelDecisionResult["kind"] | "observation";
  barEnd: string | null;
  response: InterpreterResponse | null;
  clamped: ClampedProposal | null;
  reasons: string[];
  at: string;
}

export interface AppActions {
  setMode(mode: Mode): void;
  select(root: InstrumentRoot): void;
  openDrawer(id: DrawerId): void;
  /** Append events to a ledger, persist, and return the first refusal reason if any. A duplicate id on a user write is an error. */
  append(mode: Mode, events: LedgerEvent[]): string | null;
  saveSettings(overrides: ConfigOverrides): void;
  /** Null when the engine threw; the message is in state.engineError. */
  paperStart(): DecisionOutcome | null;
  paperStep(): ObservationOutcome | null;
  paperPause(): void;
  paperResume(): void;
  /** Paper (model) decision bar: one interpreter call, then the clamped proposal is queued. */
  paperModelStart(): Promise<ModelDecisionResult | null>;
  /** Paper (model) step: the rules engine first, then the interpreter when model assist is on. */
  paperModelStep(): Promise<ModelBarResult | null>;
  /** Manual mode: ask the model for a reading. Records events; executes nothing. */
  askModel(): Promise<ModelDecisionResult | null>;
  setModelAssist(on: boolean): void;
  setNotice(text: string | null): void;
}

export interface AppStore {
  state: AppState;
  actions: AppActions;
  storage: StorageLike;
}

const Ctx = createContext<AppStore | null>(null);

function initialState(storage: StorageLike): AppState {
  const config = loadConfig(storage);
  const snapshots = fixtureSnapshots(config.cfg);
  const manual = loadLedger(storage, "manual", { cfg: config.cfg });
  const paper = loadLedger(storage, "paper", { cfg: config.cfg });
  const paperModel = loadLedger(storage, "paperModel", { cfg: config.cfg });
  const ledgers: Record<Mode, Ledger> = {
    manual: manual.ok ? manual.ledger : new Ledger("manual", { cfg: config.cfg }),
    paper: paper.ok ? paper.ledger : new Ledger("paper", { cfg: config.cfg }),
    paperModel: paperModel.ok ? paperModel.ledger : new Ledger("paperModel", { cfg: config.cfg }),
  };
  const topQualified = snapshots.find((s) => s.status === "QUALIFIED") ?? null;
  return {
    mode: "manual",
    snapshots,
    cfg: config.cfg,
    configLabel: config.label,
    ledgers,
    loadErrors: { manual: manual.ok ? null : manual.reason, paper: paper.ok ? null : paper.reason, paperModel: paperModel.ok ? null : paperModel.reason },
    configError: config.error,
    engineError: null,
    selectedRoot: ledgers.manual.activeCampaign?.root ?? topQualified?.root ?? null,
    drawer: null,
    demo: { campaignId: null, next: 0, total: 0 },
    notice: null,
    ledgerVersion: 0,
    storageKind: storage instanceof MemoryStorage ? "memory" : "localStorage",
    modelAssist: true,
    modelInFlight: false,
    modelError: null,
    modelReading: null,
  };
}

export interface AppDeps {
  /** Injected in tests; the app posts to the interpreter function. */
  interpreter?: InterpreterCall;
}

export function useAppStore(storage: StorageLike, deps: AppDeps = {}): AppStore {
  const [state, setState] = useState<AppState>(() => initialState(storage));
  const ref = useRef(state);
  ref.current = state;

  const persist = useCallback(
    (mode: Mode) => {
      const ledger = ref.current.ledgers[mode];
      // A ledger whose stored copy was refused is never overwritten silently.
      if (ref.current.loadErrors[mode]) return;
      saveLedger(storage, ledger);
    },
    [storage],
  );

  const bump = useCallback((patch: Partial<AppState> = {}) => {
    setState((s) => ({ ...s, ...patch, ledgerVersion: s.ledgerVersion + 1 }));
  }, []);

  const actions = useMemo<AppActions>(() => {
    const interpreter: InterpreterCall = deps.interpreter ?? ((body) => callInterpreter(body));

    const engineInputFor = (): ModelEngineInput => ({
      interpreter,
      histories: fixtureSnapshotHistory(ref.current.cfg),
      snapshotsByBar: fixtureSnapshotsByBar(ref.current.cfg),
      cfg: ref.current.cfg,
    });

    const reading = modelReadingFrom;
    const noticeFor = noticeForModelResult;

    /** One interpreter call at a time, and never on a timer. */
    const runModel = async <T>(mode: Mode, fn: (engineInput: ModelEngineInput) => Promise<T | null>): Promise<T | null> => {
      if (ref.current.modelInFlight) return null;
      setState((s) => ({ ...s, modelInFlight: true, modelError: null }));
      try {
        return await fn(engineInputFor());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        bump({ modelError: `Interpreter error in ${mode}: ${message}` });
        return null;
      } finally {
        setState((s) => ({ ...s, modelInFlight: false }));
      }
    };

    const demoFor = (mode: Mode): DemoProgress => {
      const c = ref.current.ledgers[mode].activeCampaign;
      if (!c) return { campaignId: null, next: 0, total: 0 };
      const snap = ref.current.snapshots.find((s) => s.root === c.root);
      const total = snap ? demoBarsFor(snap, c.side).length : 0;
      return ref.current.demo.campaignId === c.id ? { ...ref.current.demo, total } : { campaignId: c.id, next: 0, total };
    };
    return {
      setMode(mode) {
        const active = ref.current.ledgers[mode].activeCampaign;
        setState((s) => ({ ...s, mode, selectedRoot: active?.root ?? s.selectedRoot, notice: MODE_NOTICES[mode] }));
      },
      select(root) {
        setState((s) => ({ ...s, selectedRoot: root }));
      },
      openDrawer(id) {
        setState((s) => ({ ...s, drawer: id }));
      },
      append(mode, events) {
        const ledger = ref.current.ledgers[mode];
        let firstError: string | null = null;
        for (const e of events) {
          const r = ledger.append(e);
          if (!r.applied && !firstError) firstError = r.reason === "duplicate" ? `event id ${e.id} already exists in the ${mode} ledger; nothing was recorded` : r.reason;
        }
        persist(mode);
        bump();
        return firstError;
      },
      saveSettings(overrides) {
        const saved = saveConfig(storage, overrides, ref.current.configLabel);
        const snapshots = fixtureSnapshots(saved.cfg);
        setState((s) => ({ ...s, cfg: saved.cfg, configLabel: saved.label, snapshots, notice: `Model settings saved as ${saved.label}. Running campaigns keep their frozen config.` }));
      },
      paperStart() {
        const ledger = ref.current.ledgers.paper;
        try {
          const outcome = onDecisionBar(ledger, ref.current.snapshots, ledger.equityMils, ref.current.cfg);
          persist("paper");
          const demo = outcome.kind === "queued" ? { campaignId: outcome.campaignId, next: 0, total: 0 } : ref.current.demo;
          bump({ demo: { ...demo, total: 0 }, selectedRoot: outcome.kind === "queued" ? outcome.root : ref.current.selectedRoot, engineError: null });
          return outcome;
        } catch (err) {
          bump({ engineError: `Paper engine error on start: ${err instanceof Error ? err.message : String(err)}` });
          return null;
        }
      },
      paperStep() {
        const ledger = ref.current.ledgers.paper;
        const c = ledger.activeCampaign;
        if (!c) return null;
        const snap = ref.current.snapshots.find((s) => s.root === c.root);
        if (!snap) return null;
        const bars = demoBarsFor(snap, c.side);
        const progress = demoFor("paper");
        const bar = bars[progress.next];
        if (!bar) return null;
        const trail = demoTrailInputs(snap);
        try {
          const out = progress.next === 0 ? onExecutableBar(ledger, bar, trail, ref.current.cfg) : onObservationBar(ledger, bar, trail, ref.current.cfg);
          persist("paper");
          bump({ demo: { campaignId: c.id, next: progress.next + 1, total: bars.length }, engineError: null });
          return out;
        } catch (err) {
          bump({ engineError: `Paper engine error on step: ${err instanceof Error ? err.message : String(err)}` });
          return null;
        }
      },
      async paperModelStart() {
        return runModel("paperModel", async (engineInput) => {
          const ledger = ref.current.ledgers.paperModel;
          const result = await onModelDecisionBar(ledger, engineInput);
          persist("paperModel");
          bump({
            demo: result.kind === "queued" ? { campaignId: result.campaignId, next: 0, total: 0 } : ref.current.demo,
            selectedRoot: ledger.activeCampaign?.root ?? ref.current.selectedRoot,
            modelReading: reading("paperModel", result),
            notice: noticeFor(result),
          });
          return result;
        });
      },
      async paperModelStep() {
        return runModel("paperModel", async (engineInput) => {
          const ledger = ref.current.ledgers.paperModel;
          const c = ledger.activeCampaign;
          if (!c) return null;
          const snap = ref.current.snapshots.find((s) => s.root === c.root);
          if (!snap) return null;
          const bars = demoBarsFor(snap, c.side);
          const progress = demoFor("paperModel");
          const bar = bars[progress.next];
          if (!bar) return null;
          const trail = demoTrailInputs(snap);
          if (!ref.current.modelAssist) {
            // Model assist off: the same ledger, rules only, so the loop's contribution stays measurable.
            const out = progress.next === 0 ? onExecutableBar(ledger, bar, trail, ref.current.cfg) : onObservationBar(ledger, bar, trail, ref.current.cfg);
            persist("paperModel");
            bump({ demo: { campaignId: c.id, next: progress.next + 1, total: bars.length } });
            return { rules: out, events: out.events, response: null, clamped: null, reasons: ["model assist is off; this step ran the rules only"], applied: null, lesson: null, digest: null };
          }
          const result = await onModelBar(ledger, bar, trail, engineInput);
          persist("paperModel");
          bump({
            demo: { campaignId: c.id, next: progress.next + 1, total: bars.length },
            modelReading: result.response
              ? { mode: "paperModel", kind: "observation", barEnd: bar.barEnd, response: result.response, clamped: result.clamped, reasons: result.reasons, at: new Date().toISOString() }
              : ref.current.modelReading,
          });
          return result;
        });
      },
      async askModel() {
        return runModel("manual", async (engineInput) => {
          const ledger = ref.current.ledgers.manual;
          const result = await askModelEngine(ledger, engineInput);
          persist("manual");
          bump({ modelReading: reading("manual", result), notice: noticeFor(result) });
          return result;
        });
      },
      setModelAssist(on) {
        setState((s) => ({ ...s, modelAssist: on }));
      },
      paperPause() {
        const mode = ref.current.mode === "paperModel" ? "paperModel" : "paper";
        enginePause(ref.current.ledgers[mode], new Date().toISOString());
        persist(mode);
        bump();
      },
      paperResume() {
        const mode = ref.current.mode === "paperModel" ? "paperModel" : "paper";
        engineResume(ref.current.ledgers[mode], new Date().toISOString());
        persist(mode);
        bump();
      },
      setNotice(text) {
        setState((s) => ({ ...s, notice: text }));
      },
    };
  }, [bump, deps.interpreter, persist, storage]);

  return { state, actions, storage };
}

export function AppProvider(props: { storage: StorageLike; children: ReactNode; deps?: AppDeps }) {
  const store = useAppStore(props.storage, props.deps ?? {});
  return createElement(Ctx.Provider, { value: store }, props.children);
}

export function useApp(): AppStore {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside AppProvider");
  return v;
}

/** Selected snapshot, falling back to the active campaign's root or the top qualifying candidate. */
export function selectedSnapshot(state: AppState): SignalSnapshot | null {
  const root = state.selectedRoot;
  return state.snapshots.find((s) => s.root === root) ?? null;
}

export function ledgerOf(state: AppState): Ledger {
  return state.ledgers[state.mode];
}

export { candidateSide };

/** Notice shown when the mode changes (D18 labels). */
export const MODE_NOTICES: Record<Mode, string> = {
  manual: "Manual journal. Record actual broker fills here; no broker connection.",
  paper: "Paper (rules) uses its own ledger and the rules engine only. It is the control for comparison.",
  paperModel: "Paper (model) uses its own ledger. The interpreter proposes, the risk engine clamps, the deterministic engine executes.",
};

/** Panel state for one interpreter result. Pure, so it can be tested without React. */
export function modelReadingFrom(mode: Mode, result: ModelDecisionResult, at: string = new Date().toISOString()): ModelReading {
  return {
    mode,
    kind: result.kind,
    barEnd: result.request?.barEnd ?? null,
    response: result.response,
    clamped: result.clamped,
    reasons: result.reasons,
    at,
  };
}

/** One sentence for the notice line. Never says an unexecuted proposal was acted on. */
export function noticeForModelResult(result: ModelDecisionResult): string {
  switch (result.kind) {
    case "queued":
      return `Model proposal cleared the risk engine and was queued as ${result.campaignId}. Nothing is filled until the next synthetic bar.`;
    case "advisory":
      return "Model reading recorded in this ledger. Nothing was executed; record your own fills.";
    case "no-proposal":
      return "Model proposed no trade on this bar.";
    case "not-executable":
      return `Proposal logged, not executed: ${result.reasons.join("; ")}`;
    case "rejected":
      return `Model answer refused and logged unused: ${result.reasons.join("; ")}`;
    case "call-failed":
      return `Interpreter call failed: ${result.reasons.join("; ")}`;
    case "already-answered":
      return "This bar already has a stored model answer; no new call was made.";
    case "position-active":
      return "A paper (model) position is already active.";
    case "paused":
      return "Paper (model) engine is paused; no new entries.";
  }
}
