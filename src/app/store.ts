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
import { Ledger } from "../ledger/ledger";
import { MemoryStorage, loadLedger, saveLedger, type StorageLike } from "../ledger/storage";
import { onDecisionBar, onExecutableBar, onObservationBar, pause as enginePause, resume as engineResume, type DecisionOutcome, type ObservationOutcome } from "../paper/engine";
import { candidateSide } from "./plan";

export type DrawerId = "formula" | "journal" | "settings" | "results" | null;

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
  };
}

export function useAppStore(storage: StorageLike): AppStore {
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
        setState((s) => ({ ...s, mode, selectedRoot: active?.root ?? s.selectedRoot, notice: mode === "paper" ? "Paper mode uses a separate ledger. Nothing is sent to a broker." : "Manual journal. Record actual broker fills here; no broker connection." }));
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
      paperPause() {
        enginePause(ref.current.ledgers.paper, new Date().toISOString());
        persist("paper");
        bump();
      },
      paperResume() {
        engineResume(ref.current.ledgers.paper, new Date().toISOString());
        persist("paper");
        bump();
      },
      setNotice(text) {
        setState((s) => ({ ...s, notice: text }));
      },
    };
  }, [bump, persist, storage]);

  return { state, actions, storage };
}

export function AppProvider(props: { storage: StorageLike; children: ReactNode }) {
  const store = useAppStore(props.storage);
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
