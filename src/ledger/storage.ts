/**
 * Ledger persistence (D12): separate keys per mode, versioned schema, injectable storage.
 * Unknown schema versions are refused with a reason; nothing is migrated silently.
 */
import { LedgerError } from "../campaign/reduce";
import type { LedgerEvent, Mode } from "../campaign/types";
import { mils, type Mils } from "../numerics/money";
import { Ledger, type LedgerOptions } from "./ledger";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class MemoryStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

export const SCHEMA_VERSION = 1 as const;

export const LEDGER_KEYS: Record<Mode, string> = {
  manual: "fdt.v1.manual",
  paper: "fdt.v1.paper",
  paperModel: "fdt.v1.paperModel",
};

export interface StoredLedger {
  schemaVersion: typeof SCHEMA_VERSION;
  mode: Mode;
  startingEquityMils: Mils;
  events: LedgerEvent[];
}

export function ledgerKey(mode: Mode): string {
  return LEDGER_KEYS[mode];
}

export function serializeLedger(ledger: Ledger): string {
  const doc: StoredLedger = {
    schemaVersion: SCHEMA_VERSION,
    mode: ledger.mode,
    startingEquityMils: ledger.startingEquityMils,
    events: [...ledger.events],
  };
  return JSON.stringify(doc);
}

export function saveLedger(storage: StorageLike, ledger: Ledger): void {
  storage.setItem(ledgerKey(ledger.mode), serializeLedger(ledger));
}

export type LoadResult =
  | { ok: true; ledger: Ledger; source: "stored" | "empty" }
  | { ok: false; reason: string; raw: string };

/** Load a mode's ledger. Missing key => fresh empty ledger. Bad/unknown schema => refused. */
export function loadLedger(storage: StorageLike, mode: Mode, options: LedgerOptions = {}): LoadResult {
  const raw = storage.getItem(ledgerKey(mode));
  if (raw === null) return { ok: true, ledger: new Ledger(mode, options), source: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "stored ledger is not valid JSON", raw };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "stored ledger is not an object", raw };
  const doc = parsed as Partial<StoredLedger>;
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, reason: `unknown ledger schemaVersion ${String(doc.schemaVersion)} (expected ${SCHEMA_VERSION}); refusing to load or migrate`, raw };
  }
  if (doc.mode !== mode) return { ok: false, reason: `stored ledger mode ${String(doc.mode)} does not match ${mode}`, raw };
  if (!Array.isArray(doc.events)) return { ok: false, reason: "stored ledger has no events array", raw };
  if (!Number.isSafeInteger(doc.startingEquityMils)) return { ok: false, reason: "stored ledger startingEquityMils is invalid", raw };
  for (let i = 0; i < doc.events.length; i++) {
    const problem = validateEventShape(doc.events[i], i);
    if (problem) return { ok: false, reason: `stored ledger refused: ${problem}`, raw };
  }
  const normalized = normalizeStoredEvents(doc.events);
  if (!normalized.ok) return { ok: false, reason: `stored ledger refused: ${normalized.reason}`, raw };
  try {
    const ledger = Ledger.fromEvents(mode, normalized.events, { ...options, startingEquityMils: mils(doc.startingEquityMils as number) });
    return { ok: true, ledger, source: "stored" };
  } catch (err) {
    const message = err instanceof LedgerError ? err.message : err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { ok: false, reason: `stored ledger failed validation: ${message}`, raw };
  }
}

const KNOWN_TYPES = new Set<string>([
  "CAMPAIGN_QUEUED",
  "ENTRY_FILL",
  "EXIT_FILL",
  "STOP_SET",
  "BROKER_STOP_RECORDED",
  "MARK",
  "CASH_FLOW",
  "PAPER_PAUSED",
  "PAPER_RESUMED",
  "CAMPAIGN_CANCELLED",
  "CLOSE_REQUESTED",
  "STOP_MONITOR",
  "INTERPRETER_REQUEST",
  "INTERPRETER_RESPONSE",
  "INTERPRETER_REJECTED",
  "INTERPRETER_CLAMPED",
  "INTERPRETER_LESSON",
  "INTERPRETER_DIGEST",
  "INTERPRETER_MEMORY_RESET",
]);

/** Per-type required fields (beyond id/type/timestamp/actual). */
const REQUIRED_FIELDS: Record<string, string[]> = {
  CAMPAIGN_QUEUED: ["campaignId", "mode", "root", "contract", "side", "plan", "frozenConfig", "frozenSnapshot", "decisionDistance"],
  // side is tolerated when absent (see normalizeStoredEvents): supplied from the campaign's planned side.
  ENTRY_FILL: ["campaignId", "quantity", "price", "feesMils", "filledAt", "fillModel", "perContractRiskMils"],
  EXIT_FILL: ["campaignId", "quantity", "price", "feesMils", "filledAt", "fillModel", "reason"],
  STOP_SET: ["campaignId", "kind", "stop"],
  BROKER_STOP_RECORDED: ["campaignId", "status", "confirmedAt"],
  // completedClose is tolerated when absent (see normalizeStoredEvent): an older MARK is read as a plain mark.
  MARK: ["root", "price", "observedAt", "source"],
  CASH_FLOW: ["amountMils", "note"],
  PAPER_PAUSED: [],
  PAPER_RESUMED: [],
  CAMPAIGN_CANCELLED: ["campaignId", "reason"],
  CLOSE_REQUESTED: ["campaignId", "reason"],
  STOP_MONITOR: ["healthy", "checkedAt", "detail"],
  INTERPRETER_REQUEST: ["mode", "callKind", "barEnd", "requestHash", "promptVersion", "model", "nBars"],
  INTERPRETER_RESPONSE: ["responseId", "barEnd", "callKind", "model", "promptVersion", "response", "usage", "latencyMs", "costEstimateMils"],
  INTERPRETER_REJECTED: ["barEnd", "callKind", "model", "promptVersion", "reason"],
  INTERPRETER_CLAMPED: ["responseId", "barEnd", "callKind", "before", "after", "reasons"],
  INTERPRETER_LESSON: ["campaignId", "epochId", "model", "promptVersion", "lesson"],
  INTERPRETER_DIGEST: ["epochId", "model", "promptVersion", "digest"],
  INTERPRETER_MEMORY_RESET: ["epochId", "previousEpochId", "reason"],
};

/**
 * Tolerant read, not a migration: a stored MARK without `completedClose` (written before the field
 * existed) is normalized to completedClose:false. A mark of unknown kind is conservative — it updates
 * P&L and equity but never advances the trailing-stop reference. The stored document is not rewritten
 * until the next save; the schema version is unchanged.
 */
export function normalizeStoredEvent(e: LedgerEvent): LedgerEvent {
  if (e.type === "MARK" && (e as { completedClose?: unknown }).completedClose === undefined) {
    // The paper engine's bar-close marks were always completed closes; anything else is unknown => false.
    return { ...e, completedClose: e.source === "paper-observation-bar" };
  }
  return e;
}

/**
 * Tolerant read, not a migration (second rule): an ENTRY_FILL stored without `side` (written before the
 * field existed) takes the side of its campaign's CAMPAIGN_QUEUED event — old fills always matched the
 * plan. Refused by name when that queued event is absent. The stored document is not rewritten.
 */
export function normalizeStoredEvents(events: readonly LedgerEvent[]): { ok: true; events: LedgerEvent[] } | { ok: false; reason: string } {
  const plannedSide = new Map<string, 1 | -1>();
  for (const e of events) if (e.type === "CAMPAIGN_QUEUED") plannedSide.set(e.campaignId, e.side);
  const out: LedgerEvent[] = [];
  for (const raw of events) {
    const e = normalizeStoredEvent(raw);
    if (e.type === "ENTRY_FILL" && (e as { side?: unknown }).side === undefined) {
      const side = plannedSide.get(e.campaignId);
      if (side === undefined) return { ok: false, reason: `event ${e.id} (ENTRY_FILL) has no side and no CAMPAIGN_QUEUED event for campaign ${e.campaignId}` };
      out.push({ ...e, side });
      continue;
    }
    out.push(e);
  }
  return { ok: true, events: out };
}

/** Structural check of one stored event; returns a reason naming the event, or null. */
export function validateEventShape(e: unknown, index: number): string | null {
  if (typeof e !== "object" || e === null) return `event #${index} is not an object`;
  const o = e as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : null;
  const name = id !== null ? `event ${id}` : `event #${index}`;
  if (id === null || id.length === 0) return `${name} has no string id`;
  if (typeof o.type !== "string") return `${name} has no string type`;
  if (typeof o.timestamp !== "string") return `${name} has no string timestamp`;
  if (typeof o.actual !== "boolean") return `${name} has no boolean actual flag`;
  if (!KNOWN_TYPES.has(o.type)) return `${name} has unknown event type ${o.type}`;
  for (const f of REQUIRED_FIELDS[o.type] ?? []) {
    if (!(f in o) || o[f] === undefined) return `${name} (${o.type}) is missing required field ${f}`;
  }
  if (o.type === "CAMPAIGN_QUEUED") {
    const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
    const cfg = o.frozenConfig;
    const snap = o.frozenSnapshot;
    const plan = o.plan;
    const dist = o.decisionDistance;
    if (!isObj(cfg) || typeof cfg.version !== "string") return `${name} (CAMPAIGN_QUEUED) frozenConfig.version must be a string`;
    if (!isObj(cfg.costs) || !isObj(cfg.costs[String(o.root)])) return `${name} (CAMPAIGN_QUEUED) frozenConfig.costs must contain root ${String(o.root)}`;
    if (!isObj(snap) || typeof snap.root !== "string") return `${name} (CAMPAIGN_QUEUED) frozenSnapshot.root must be a string`;
    if (!isObj(plan) || !Number.isInteger(plan.contracts)) return `${name} (CAMPAIGN_QUEUED) plan.contracts must be an integer`;
    if (!isObj(dist) || typeof dist.dTicks !== "number" || !Number.isFinite(dist.dTicks)) return `${name} (CAMPAIGN_QUEUED) decisionDistance.dTicks must be a number`;
  }
  return null;
}
