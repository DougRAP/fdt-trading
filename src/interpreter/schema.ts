/**
 * JSON Schemas for the interpreter's outputs plus a hand-written validator.
 *
 * The schemas are used twice: as `output_config.format` for structured outputs, and as the
 * documented shape for the runtime validator below. The validator is hand-written (no new
 * dependencies) and is deliberately strict: any field outside an enum, any number that is not a safe
 * integer tick, any market not in the request, any unknown key, or any inconsistent
 * action/root/side/stop combination rejects the whole response. No partial use.
 *
 * Two checks are deliberately NOT here because they produce a clamp, not a rejection:
 * an `enter` for a root outside `bounds.allowedCandidates`, and an `enter` on an observation call.
 * Those are logged as INTERPRETER_CLAMPED by the risk engine.
 */
import { INSTRUMENT_ROOTS, type InstrumentRoot } from "../config/modelConfig";
import {
  ACTIVITY_VALUES,
  BREADTH_VALUES,
  EVIDENCE_STRENGTH_VALUES,
  INVALIDATION_KINDS,
  PRICE_RESPONSE_VALUES,
  PROPOSAL_ACTIONS,
  type Digest,
  type InterpreterRequest,
  type InterpreterResponse,
  type Invalidation,
  type Lesson,
  type Proposal,
  type Reading,
  type ValidationResult,
} from "./types";

/** Caps that keep a malformed or runaway response from entering the ledger. */
export const LIMITS = Object.freeze({
  maxEvidence: 20,
  maxEvidenceChars: 400,
  maxInvalidation: 12,
  maxTextChars: 4000,
  maxListItems: 20,
  maxListItemChars: 400,
  /** Sanity bound on a tick count; instrument tick grids are far below this. */
  maxTicks: 100_000_000,
});

// ---------------------------------------------------------------------------
// JSON Schemas
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

const stringSchema = (maxLength: number): JsonSchema => ({ type: "string", maxLength });
const stringArraySchema = (maxItems: number, maxLength: number): JsonSchema => ({
  type: "array",
  maxItems,
  items: stringSchema(maxLength),
});
const tickSchema: JsonSchema = { type: "integer", minimum: 1, maximum: LIMITS.maxTicks };

/** Response schema restricted to the roots actually present in the request. */
export function responseSchemaFor(roots: readonly InstrumentRoot[]): JsonSchema {
  const rootEnum: JsonSchema = { type: "string", enum: [...roots] };
  const invalidation: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["kind", "root", "threshold", "note"],
    properties: {
      kind: { type: "string", enum: [...INVALIDATION_KINDS] },
      root: rootEnum,
      // anyOf rather than a type array: structured outputs accept anyOf, enum, required and additionalProperties.
      threshold: { anyOf: [{ type: "number" }, { type: "null" }] },
      note: stringSchema(LIMITS.maxEvidenceChars),
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["promptVersion", "readings", "crossMarket", "hypothesis", "proposal", "evidenceStrength"],
    properties: {
      promptVersion: stringSchema(64),
      readings: {
        type: "array",
        maxItems: roots.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["root", "activity", "breadth", "priceResponse", "noiseFlag", "evidence"],
          properties: {
            root: rootEnum,
            activity: { type: "string", enum: [...ACTIVITY_VALUES] },
            breadth: { type: "string", enum: [...BREADTH_VALUES] },
            priceResponse: { type: "string", enum: [...PRICE_RESPONSE_VALUES] },
            noiseFlag: { type: "boolean" },
            evidence: stringArraySchema(LIMITS.maxEvidence, LIMITS.maxEvidenceChars),
          },
        },
      },
      crossMarket: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "supports", "contradicts"],
        properties: {
          summary: stringSchema(LIMITS.maxTextChars),
          supports: { type: "array", maxItems: roots.length, items: rootEnum },
          contradicts: { type: "array", maxItems: roots.length, items: rootEnum },
        },
      },
      hypothesis: stringSchema(LIMITS.maxTextChars),
      proposal: {
        type: "object",
        additionalProperties: false,
        required: ["action", "root", "side", "entryZone", "stopTicks", "invalidation", "rationale"],
        properties: {
          action: { type: "string", enum: [...PROPOSAL_ACTIONS] },
          root: { anyOf: [rootEnum, { type: "null" }] },
          side: { anyOf: [{ type: "integer", enum: [1, -1] }, { type: "null" }] },
          entryZone: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["lowTicks", "highTicks"],
                properties: { lowTicks: tickSchema, highTicks: tickSchema },
              },
              { type: "null" },
            ],
          },
          stopTicks: { anyOf: [tickSchema, { type: "null" }] },
          invalidation: { type: "array", maxItems: LIMITS.maxInvalidation, items: invalidation },
          rationale: stringSchema(LIMITS.maxTextChars),
        },
      },
      evidenceStrength: { type: "string", enum: [...EVIDENCE_STRENGTH_VALUES] },
    },
  };
}

/** Default response schema over every configured root. */
export const RESPONSE_SCHEMA: JsonSchema = responseSchemaFor(INSTRUMENT_ROOTS);

export const LESSON_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["campaignId", "whatHeld", "whatFailed", "weighDifferently", "evidenceToWatch"],
  properties: {
    campaignId: stringSchema(200),
    whatHeld: stringArraySchema(LIMITS.maxListItems, LIMITS.maxListItemChars),
    whatFailed: stringArraySchema(LIMITS.maxListItems, LIMITS.maxListItemChars),
    weighDifferently: stringArraySchema(LIMITS.maxListItems, LIMITS.maxListItemChars),
    evidenceToWatch: stringArraySchema(LIMITS.maxListItems, LIMITS.maxListItemChars),
  },
};

export const DIGEST_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "lessonsCovered", "summary", "whatHeld", "whatFailed", "weighDifferently", "evidenceToWatch"],
  properties: {
    version: { type: "integer", minimum: 1 },
    lessonsCovered: { type: "integer", minimum: 0 },
    summary: stringSchema(LIMITS.maxTextChars),
    whatHeld: stringArraySchema(LIMITS.maxListItems, LIMITS.maxListItemChars),
    whatFailed: stringArraySchema(LIMITS.maxListItems, LIMITS.maxListItemChars),
    weighDifferently: stringArraySchema(LIMITS.maxListItems, LIMITS.maxListItemChars),
    evidenceToWatch: stringArraySchema(LIMITS.maxListItems, LIMITS.maxListItemChars),
  },
};

// ---------------------------------------------------------------------------
// Validator helpers
// ---------------------------------------------------------------------------

const fail = <T>(reason: string): ValidationResult<T> => ({ ok: false, reason });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Returns a reason when the object carries a key outside `allowed`. */
function unknownKey(o: Record<string, unknown>, allowed: readonly string[], where: string): string | null {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) return `${where} has unknown field ${k}`;
  }
  return null;
}

function requireString(o: Record<string, unknown>, key: string, where: string, maxLength: number): string | { error: string } {
  const v = o[key];
  if (typeof v !== "string") return { error: `${where}.${key} must be a string` };
  if (v.length === 0) return { error: `${where}.${key} must not be empty` };
  if (v.length > maxLength) return { error: `${where}.${key} exceeds ${maxLength} characters` };
  return v;
}

function requireStringArray(
  o: Record<string, unknown>,
  key: string,
  where: string,
  maxItems: number,
  maxLength: number,
): string[] | { error: string } {
  const v = o[key];
  if (!Array.isArray(v)) return { error: `${where}.${key} must be an array` };
  if (v.length > maxItems) return { error: `${where}.${key} exceeds ${maxItems} items` };
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const item = v[i];
    if (typeof item !== "string") return { error: `${where}.${key}[${i}] must be a string` };
    if (item.length === 0) return { error: `${where}.${key}[${i}] must not be empty` };
    if (item.length > maxLength) return { error: `${where}.${key}[${i}] exceeds ${maxLength} characters` };
    out.push(item);
  }
  return out;
}

function requireEnum<T extends string>(
  o: Record<string, unknown>,
  key: string,
  where: string,
  values: readonly T[],
): T | { error: string } {
  const v = o[key];
  if (typeof v !== "string" || !values.includes(v as T)) {
    return { error: `${where}.${key} must be one of ${values.join(" | ")}, got ${JSON.stringify(v)}` };
  }
  return v as T;
}

/** A tick count must be a positive safe integer within the sanity bound. */
function requireTick(v: unknown, where: string): number | { error: string } {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) return { error: `${where} must be a safe integer tick count, got ${JSON.stringify(v)}` };
  if (v <= 0) return { error: `${where} must be a positive tick count` };
  if (v > LIMITS.maxTicks) return { error: `${where} exceeds the tick sanity bound` };
  return v;
}

function isError(v: unknown): v is { error: string } {
  return isPlainObject(v) && typeof v.error === "string";
}

/** What the validator needs from the request. A full InterpreterRequest satisfies it. */
export interface ResponseValidationContext {
  promptVersion: string;
  roots: readonly InstrumentRoot[];
}

function contextOf(request: InterpreterRequest | ResponseValidationContext): ResponseValidationContext {
  if ("markets" in request) {
    return { promptVersion: request.promptVersion, roots: request.markets.map((m) => m.root) };
  }
  return request;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const READING_KEYS = ["root", "activity", "breadth", "priceResponse", "noiseFlag", "evidence"] as const;
const INVALIDATION_KEYS = ["kind", "root", "threshold", "note"] as const;
const PROPOSAL_KEYS = ["action", "root", "side", "entryZone", "stopTicks", "invalidation", "rationale"] as const;
const CROSS_KEYS = ["summary", "supports", "contradicts"] as const;
const RESPONSE_KEYS = ["promptVersion", "readings", "crossMarket", "hypothesis", "proposal", "evidenceStrength"] as const;

function validateReadings(value: unknown, roots: readonly InstrumentRoot[]): Reading[] | { error: string } {
  if (!Array.isArray(value)) return { error: "readings must be an array" };
  if (value.length === 0) return { error: "readings must not be empty" };
  if (value.length > roots.length) return { error: `readings has more entries (${value.length}) than markets in the request (${roots.length})` };
  const seen = new Set<string>();
  const out: Reading[] = [];
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    const where = `readings[${i}]`;
    if (!isPlainObject(raw)) return { error: `${where} must be an object` };
    const unknown = unknownKey(raw, READING_KEYS, where);
    if (unknown) return { error: unknown };
    const root = raw.root;
    if (typeof root !== "string" || !roots.includes(root as InstrumentRoot)) {
      return { error: `${where}.root ${JSON.stringify(root)} is not a market in the request` };
    }
    if (seen.has(root)) return { error: `${where}.root ${root} appears twice in readings` };
    seen.add(root);
    const activity = requireEnum(raw, "activity", where, ACTIVITY_VALUES);
    if (isError(activity)) return activity;
    const breadth = requireEnum(raw, "breadth", where, BREADTH_VALUES);
    if (isError(breadth)) return breadth;
    const priceResponse = requireEnum(raw, "priceResponse", where, PRICE_RESPONSE_VALUES);
    if (isError(priceResponse)) return priceResponse;
    if (typeof raw.noiseFlag !== "boolean") return { error: `${where}.noiseFlag must be a boolean` };
    const evidence = requireStringArray(raw, "evidence", where, LIMITS.maxEvidence, LIMITS.maxEvidenceChars);
    if (isError(evidence)) return evidence;
    out.push({ root: root as InstrumentRoot, activity, breadth, priceResponse, noiseFlag: raw.noiseFlag, evidence });
  }
  return out;
}

function validateInvalidation(value: unknown, roots: readonly InstrumentRoot[]): Invalidation[] | { error: string } {
  if (!Array.isArray(value)) return { error: "proposal.invalidation must be an array" };
  if (value.length > LIMITS.maxInvalidation) return { error: `proposal.invalidation exceeds ${LIMITS.maxInvalidation} items` };
  const out: Invalidation[] = [];
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    const where = `proposal.invalidation[${i}]`;
    if (!isPlainObject(raw)) return { error: `${where} must be an object` };
    const unknown = unknownKey(raw, INVALIDATION_KEYS, where);
    if (unknown) return { error: unknown };
    const kind = requireEnum(raw, "kind", where, INVALIDATION_KINDS);
    if (isError(kind)) return kind;
    const root = raw.root;
    if (typeof root !== "string" || !roots.includes(root as InstrumentRoot)) {
      return { error: `${where}.root ${JSON.stringify(root)} is not a market in the request` };
    }
    const threshold = raw.threshold;
    if (threshold !== null && (typeof threshold !== "number" || !Number.isFinite(threshold))) {
      return { error: `${where}.threshold must be a finite number or null` };
    }
    const note = requireString(raw, "note", where, LIMITS.maxEvidenceChars);
    if (isError(note)) return note;
    out.push({ kind, root: root as InstrumentRoot, threshold, note });
  }
  return out;
}

function validateProposal(value: unknown, roots: readonly InstrumentRoot[]): Proposal | { error: string } {
  if (!isPlainObject(value)) return { error: "proposal must be an object" };
  const unknown = unknownKey(value, PROPOSAL_KEYS, "proposal");
  if (unknown) return { error: unknown };
  const action = requireEnum(value, "action", "proposal", PROPOSAL_ACTIONS);
  if (isError(action)) return action;

  const rawRoot = value.root;
  let root: InstrumentRoot | null = null;
  if (rawRoot !== null) {
    if (typeof rawRoot !== "string" || !roots.includes(rawRoot as InstrumentRoot)) {
      return { error: `proposal.root ${JSON.stringify(rawRoot)} is not a market in the request` };
    }
    root = rawRoot as InstrumentRoot;
  }

  const rawSide = value.side;
  if (rawSide !== null && rawSide !== 1 && rawSide !== -1) return { error: `proposal.side must be 1, -1 or null, got ${JSON.stringify(rawSide)}` };
  const side = rawSide as 1 | -1 | null;

  let entryZone: { lowTicks: number; highTicks: number } | null = null;
  if (value.entryZone !== null) {
    const z = value.entryZone;
    if (!isPlainObject(z)) return { error: "proposal.entryZone must be an object or null" };
    const unknownZone = unknownKey(z, ["lowTicks", "highTicks"], "proposal.entryZone");
    if (unknownZone) return { error: unknownZone };
    const low = requireTick(z.lowTicks, "proposal.entryZone.lowTicks");
    if (isError(low)) return low;
    const high = requireTick(z.highTicks, "proposal.entryZone.highTicks");
    if (isError(high)) return high;
    if (low > high) return { error: "proposal.entryZone.lowTicks must not exceed highTicks" };
    entryZone = { lowTicks: low, highTicks: high };
  }

  let stopTicks: number | null = null;
  if (value.stopTicks !== null) {
    const s = requireTick(value.stopTicks, "proposal.stopTicks");
    if (isError(s)) return s;
    stopTicks = s;
  }

  const invalidation = validateInvalidation(value.invalidation, roots);
  if (isError(invalidation)) return invalidation;
  const rationale = requireString(value, "rationale", "proposal", LIMITS.maxTextChars);
  if (isError(rationale)) return rationale;

  // Consistency: an action names exactly the fields it can act on.
  if (action === "enter") {
    if (root === null) return { error: "proposal.action enter requires a root" };
    if (side === null) return { error: "proposal.action enter requires a side" };
    if (stopTicks === null) return { error: "proposal.action enter requires stopTicks" };
  }
  if (action === "wait") {
    if (side !== null) return { error: "proposal.action wait must not carry a side" };
    if (stopTicks !== null) return { error: "proposal.action wait must not carry stopTicks" };
    if (entryZone !== null) return { error: "proposal.action wait must not carry an entryZone" };
  }
  if (action === "hold" || action === "tighten" || action === "exit") {
    if (root === null) return { error: `proposal.action ${action} requires the root of the open position` };
    if (entryZone !== null) return { error: `proposal.action ${action} must not carry an entryZone` };
    if (action === "tighten" && stopTicks === null) return { error: "proposal.action tighten requires stopTicks" };
    if (action !== "tighten" && stopTicks !== null) return { error: `proposal.action ${action} must not carry stopTicks` };
  }
  return { action, root, side, entryZone, stopTicks, invalidation, rationale };
}

function validateCrossMarket(value: unknown, roots: readonly InstrumentRoot[]): { summary: string; supports: InstrumentRoot[]; contradicts: InstrumentRoot[] } | { error: string } {
  if (!isPlainObject(value)) return { error: "crossMarket must be an object" };
  const unknown = unknownKey(value, CROSS_KEYS, "crossMarket");
  if (unknown) return { error: unknown };
  const summary = requireString(value, "summary", "crossMarket", LIMITS.maxTextChars);
  if (isError(summary)) return summary;
  const lists: Record<"supports" | "contradicts", InstrumentRoot[]> = { supports: [], contradicts: [] };
  for (const key of ["supports", "contradicts"] as const) {
    const v = value[key];
    if (!Array.isArray(v)) return { error: `crossMarket.${key} must be an array` };
    if (v.length > roots.length) return { error: `crossMarket.${key} lists more markets than the request contains` };
    for (let i = 0; i < v.length; i++) {
      const r = v[i];
      if (typeof r !== "string" || !roots.includes(r as InstrumentRoot)) {
        return { error: `crossMarket.${key}[${i}] ${JSON.stringify(r)} is not a market in the request` };
      }
      if (lists[key].includes(r as InstrumentRoot)) return { error: `crossMarket.${key} lists ${r} twice` };
      lists[key].push(r as InstrumentRoot);
    }
  }
  for (const r of lists.supports) {
    if (lists.contradicts.includes(r)) return { error: `crossMarket lists ${r} as both supporting and contradicting` };
  }
  return { summary, supports: lists.supports, contradicts: lists.contradicts };
}

/**
 * Validate a model response against the request it answers. Rejection is total: the caller logs
 * INTERPRETER_REJECTED with the reason and uses nothing from the response.
 */
export function validateResponse(json: unknown, request: InterpreterRequest | ResponseValidationContext): ValidationResult<InterpreterResponse> {
  const ctx = contextOf(request);
  if (!isPlainObject(json)) return fail("response must be a JSON object");
  const unknown = unknownKey(json, RESPONSE_KEYS, "response");
  if (unknown) return fail(unknown);

  const promptVersion = requireString(json, "promptVersion", "response", 64);
  if (isError(promptVersion)) return fail(promptVersion.error);
  if (promptVersion !== ctx.promptVersion) {
    return fail(`response.promptVersion ${promptVersion} does not match the request's ${ctx.promptVersion}`);
  }
  if (ctx.roots.length === 0) return fail("request carries no markets, so no response can reference one");

  const readings = validateReadings(json.readings, ctx.roots);
  if (isError(readings)) return fail(readings.error);
  const crossMarket = validateCrossMarket(json.crossMarket, ctx.roots);
  if (isError(crossMarket)) return fail(crossMarket.error);
  const hypothesis = requireString(json, "hypothesis", "response", LIMITS.maxTextChars);
  if (isError(hypothesis)) return fail(hypothesis.error);
  const proposal = validateProposal(json.proposal, ctx.roots);
  if (isError(proposal)) return fail(proposal.error);
  const evidenceStrength = requireEnum(json, "evidenceStrength", "response", EVIDENCE_STRENGTH_VALUES);
  if (isError(evidenceStrength)) return fail(evidenceStrength.error);

  return { ok: true, value: { promptVersion, readings, crossMarket, hypothesis, proposal, evidenceStrength } };
}

const LESSON_KEYS = ["campaignId", "whatHeld", "whatFailed", "weighDifferently", "evidenceToWatch"] as const;

/** Validate a lesson. `campaignId` must match the campaign the lesson was requested for. */
export function validateLesson(json: unknown, expectedCampaignId: string): ValidationResult<Lesson> {
  if (!isPlainObject(json)) return fail("lesson must be a JSON object");
  const unknown = unknownKey(json, LESSON_KEYS, "lesson");
  if (unknown) return fail(unknown);
  const campaignId = requireString(json, "campaignId", "lesson", 200);
  if (isError(campaignId)) return fail(campaignId.error);
  if (campaignId !== expectedCampaignId) return fail(`lesson.campaignId ${campaignId} does not match ${expectedCampaignId}`);
  const lists: Record<string, string[]> = {};
  for (const key of ["whatHeld", "whatFailed", "weighDifferently", "evidenceToWatch"] as const) {
    const v = requireStringArray(json, key, "lesson", LIMITS.maxListItems, LIMITS.maxListItemChars);
    if (isError(v)) return fail(v.error);
    lists[key] = v;
  }
  return {
    ok: true,
    value: {
      campaignId,
      whatHeld: lists.whatHeld!,
      whatFailed: lists.whatFailed!,
      weighDifferently: lists.weighDifferently!,
      evidenceToWatch: lists.evidenceToWatch!,
    },
  };
}

const DIGEST_KEYS = ["version", "lessonsCovered", "summary", "whatHeld", "whatFailed", "weighDifferently", "evidenceToWatch"] as const;

export function validateDigest(json: unknown): ValidationResult<Digest> {
  if (!isPlainObject(json)) return fail("digest must be a JSON object");
  const unknown = unknownKey(json, DIGEST_KEYS, "digest");
  if (unknown) return fail(unknown);
  const version = json.version;
  if (!Number.isSafeInteger(version) || (version as number) < 1) return fail("digest.version must be a positive integer");
  const lessonsCovered = json.lessonsCovered;
  if (!Number.isSafeInteger(lessonsCovered) || (lessonsCovered as number) < 0) return fail("digest.lessonsCovered must be a nonnegative integer");
  const summary = requireString(json, "summary", "digest", LIMITS.maxTextChars);
  if (isError(summary)) return fail(summary.error);
  const lists: Record<string, string[]> = {};
  for (const key of ["whatHeld", "whatFailed", "weighDifferently", "evidenceToWatch"] as const) {
    const v = requireStringArray(json, key, "digest", LIMITS.maxListItems, LIMITS.maxListItemChars);
    if (isError(v)) return fail(v.error);
    lists[key] = v;
  }
  return {
    ok: true,
    value: {
      version: version as number,
      lessonsCovered: lessonsCovered as number,
      summary,
      whatHeld: lists.whatHeld!,
      whatFailed: lists.whatFailed!,
      weighDifferently: lists.weighDifferently!,
      evidenceToWatch: lists.evidenceToWatch!,
    },
  };
}
