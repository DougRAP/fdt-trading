/**
 * Campaign, order-event and account-equity records (brief "Suggested records", D16).
 * The ledger is an append-only event log per mode; campaign state is derived by reducing events.
 * Prices are Ticks, money is Mils.
 */
import type { InstrumentRoot, ModelConfig } from "../config/modelConfig";
import type { Side, SignalSnapshot } from "../formula/types";
import type { Mils } from "../numerics/money";
import type { Ticks } from "../numerics/ticks";
import type { PerContractRisk, PositionSize } from "../sizing/sizing";
import type { StopDistance, StopReason, StopState } from "../stops/stops";

export type Mode = "manual" | "paper";
export type CampaignState = "PENDING" | "OPEN" | "CLOSED" | "CANCELLED";
export type FillModel = "actual-broker" | "paper-model-0.1";
export type ExitReason = "stop-touched" | "gap-open" | "close-required" | "manual";
export type BrokerStopStatus = "working" | "filled" | "cancelled" | "unknown";

export interface CampaignPlan {
  contracts: number;
  plannedEntry: Ticks;
  plannedStop: Ticks;
  riskBudgetMils: Mils;
  perContractRisk: PerContractRisk;
  sizing: PositionSize;
}

interface EventBase {
  /** Caller-supplied id; applying a duplicate id is a no-op. */
  id: string;
  /** ISO timestamp of the event itself. */
  timestamp: string;
  /** Actual broker fact (true) or simulated/modeled (false). */
  actual: boolean;
  /** Present on corrections; the superseded event stays in the log but is not applied. */
  supersededEventId?: string;
}

export interface CampaignQueuedEvent extends EventBase {
  type: "CAMPAIGN_QUEUED";
  campaignId: string;
  mode: Mode;
  root: InstrumentRoot;
  contract: string;
  side: Side;
  plan: CampaignPlan;
  frozenConfig: ModelConfig;
  frozenSnapshot: SignalSnapshot;
  decisionDistance: StopDistance;
}

export interface EntryFillEvent extends EventBase {
  type: "ENTRY_FILL";
  campaignId: string;
  /** Filled side. If it differs from the planned side on the first fill, the campaign takes this side (a recorded deviation). */
  side: Side;
  quantity: number;
  price: Ticks;
  feesMils: Mils;
  filledAt: string;
  timezone?: string;
  fillModel: FillModel;
  /** Per-contract stop risk computed from this actual fill and its initial stop (cost convention included). */
  perContractRiskMils: Mils;
  /** Required when the fill differs from the plan (manual mode). */
  deviationReason?: string;
}

export interface ExitFillEvent extends EventBase {
  type: "EXIT_FILL";
  campaignId: string;
  quantity: number;
  price: Ticks;
  feesMils: Mils;
  filledAt: string;
  timezone?: string;
  fillModel: FillModel;
  reason: ExitReason;
  deviationReason?: string;
}

export interface StopSetEvent extends EventBase {
  type: "STOP_SET";
  campaignId: string;
  /** "proposed": model suggestion (both modes). "resting": paper simulated resting stop. */
  kind: "proposed" | "resting";
  stop: StopState;
}

export interface BrokerStopRecordedEvent extends EventBase {
  type: "BROKER_STOP_RECORDED";
  campaignId: string;
  price: Ticks | null;
  status: BrokerStopStatus;
  confirmedAt: string;
}

export interface MarkEvent extends EventBase {
  type: "MARK";
  root: InstrumentRoot;
  price: Ticks;
  observedAt: string;
  source: string;
  /** True only for a completed bar close; only completed closes advance the trailing-stop reference. */
  completedClose: boolean;
}

export interface CashFlowEvent extends EventBase {
  type: "CASH_FLOW";
  amountMils: Mils;
  note: string;
}

export interface PaperPausedEvent extends EventBase {
  type: "PAPER_PAUSED";
}

export interface PaperResumedEvent extends EventBase {
  type: "PAPER_RESUMED";
}

export interface CampaignCancelledEvent extends EventBase {
  type: "CAMPAIGN_CANCELLED";
  campaignId: string;
  reason: string;
}

export interface CloseRequestedEvent extends EventBase {
  type: "CLOSE_REQUESTED";
  campaignId: string;
  reason: string;
}

export interface StopMonitorEvent extends EventBase {
  type: "STOP_MONITOR";
  healthy: boolean;
  checkedAt: string;
  detail: string;
}

export type LedgerEvent =
  | CampaignQueuedEvent
  | EntryFillEvent
  | ExitFillEvent
  | StopSetEvent
  | BrokerStopRecordedEvent
  | MarkEvent
  | CashFlowEvent
  | PaperPausedEvent
  | PaperResumedEvent
  | CampaignCancelledEvent
  | CloseRequestedEvent
  | StopMonitorEvent;

export type OrderEvent = EntryFillEvent | ExitFillEvent;

export interface Fill {
  eventId: string;
  kind: "entry" | "exit";
  /** Present on entry fills. */
  side?: Side;
  quantity: number;
  price: Ticks;
  feesMils: Mils;
  filledAt: string;
  timezone?: string;
  fillModel: FillModel;
  actual: boolean;
  reason?: ExitReason;
  deviationReason?: string;
}

/** FIFO entry lot; exits consume lots in order so realized P&L stays exact in mils. */
export interface Lot {
  price: Ticks;
  remaining: number;
}

export interface BrokerStop {
  price: Ticks | null;
  status: BrokerStopStatus;
  confirmedAt: string;
}

export interface Campaign {
  id: string;
  mode: Mode;
  root: InstrumentRoot;
  contract: string;
  side: Side;
  state: CampaignState;
  frozenConfig: ModelConfig;
  frozenSnapshot: SignalSnapshot;
  decisionDistance: StopDistance;
  plan: CampaignPlan;
  fills: Fill[];
  lots: Lot[];
  entryQuantity: number;
  exitQuantity: number;
  remaining: number;
  /** Sum of entry price x quantity in ticks, for display-only average entry. */
  entryBasisTicksQty: number;
  /** Frozen at the first entry fill: per-contract risk x contracts entered. */
  originalRiskMils: Mils | null;
  grossRealizedMils: Mils;
  feesMils: Mils;
  /** grossRealized - all fees paid to date. */
  netRealizedMils: Mils;
  proposedStop: StopState | null;
  restingStop: StopState | null;
  brokerStop: BrokerStop | null;
  closeRequested: { reason: string; at: string } | null;
  /** Highest (long) or lowest (short) completed close since entry. */
  extremeClose: Ticks | null;
  exposureBars: number;
  deviationReasons: string[];
  /** Set when the latest stop recalculation was frozen for missing inputs. */
  stopFrozenReason: StopReason | null;
  queuedAt: string;
  openedAt: string | null;
  closedAt: string | null;
  cancelReason: string | null;
}

export interface Mark {
  root: InstrumentRoot;
  price: Ticks;
  observedAt: string;
  source: string;
}

export interface StopMonitor {
  healthy: boolean;
  lastCheckedAt: string | null;
  detail: string;
}

export interface AccountEquityPoint {
  mode: Mode;
  timestamp: string;
  cashMils: Mils;
  realizedMils: Mils;
  unrealizedMils: Mils;
  liabilitiesMils: Mils;
  externalCashFlowMils: Mils;
  equityMils: Mils;
  /** "marked": unrealized from marks; "no-mark": open position without a mark (unrealized 0); "flat". */
  freshness: "marked" | "no-mark" | "flat";
}

export interface LedgerState {
  mode: Mode;
  campaigns: Record<string, Campaign>;
  campaignOrder: string[];
  /** PENDING or OPEN campaign id; at most one per mode. */
  activeCampaignId: string | null;
  marks: Partial<Record<InstrumentRoot, Mark>>;
  paused: boolean;
  stopMonitor: StopMonitor;
  startingEquityMils: Mils;
  cashMils: Mils;
  externalCashFlowMils: Mils;
  cumulativeNetRealizedMils: Mils;
  equitySeries: AccountEquityPoint[];
  appliedEventIds: string[];
  supersededEventIds: string[];
}
