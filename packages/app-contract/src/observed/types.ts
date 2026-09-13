/**
 * Observed intent — the strict boundary for intent recovered from an
 * implementation (the Finish Existing entrance).
 *
 * An observer (scanner, importer, agent) never writes ISL, code, or files. It
 * fills in this schema and nothing else: what constructs exist, where each was
 * seen, and how confident the observation is. Everything after this point is
 * deterministic — ambiguity derivation, ISL projection, ruling validation,
 * sealing. A scanner cannot promote its guess into the contract; only a human
 * ruling can.
 *
 * Provenance law (frozen §4): inferred intent is not authoritative until
 * confirmed and sealed. Every clause therefore carries exactly one of three
 * recorded origins once sealed:
 *
 *   observed   → seen in the implementation, awaiting a ruling (never sealed)
 *   confirmed  → observed from the implementation AND accepted by the user
 *   authored   → explicitly supplied by the user through a ruled edit
 *
 * Unknowns are representable (`ownedByUser: null`, absent transition rows):
 * saying "we did not see it" is the input's job, not the derivation's.
 */

import { z } from 'zod';
import { DRAFT_FIELD_TYPES, type DraftFieldType } from '../nl/draft.js';
import type { QuestionImpact } from '../nl/questions.js';
import { IMPACT_WEIGHTS } from '../nl/questions.js';
import { ContractOpSchema } from '../patch/op-schema.js';
import type { ContractOp } from '../patch/ops.js';

export const OBSERVED_INTENT_SCHEMA_VERSION = 'observed-intent/1' as const;

const identifier = z
  .string()
  .min(1)
  .max(60)
  .regex(
    /^[A-Za-z][A-Za-z0-9 _-]*$/,
    'must start with a letter and contain only letters, numbers, spaces, - or _',
  );

/** Where in the implementation a fact was seen. Non-empty per fact. */
export const ObservedEvidenceSchema = z.object({
  kind: z.enum(['route', 'table', 'screen', 'file', 'config', 'fixture']),
  ref: z.string().min(1).max(200),
});
export type ObservedEvidence = z.infer<typeof ObservedEvidenceSchema>;

export const ObservedFieldSchema = z.object({
  name: identifier,
  type: z.enum(DRAFT_FIELD_TYPES),
  optional: z.boolean().default(false),
  searchable: z.boolean().default(false),
  /** Required when `type` is `choice`; the observed option set, in order. */
  choices: z.array(identifier).max(24).default([]),
  /** Observed end-of-lifecycle options. Must be a subset of `choices`. */
  endStates: z.array(identifier).max(8).default([]),
  evidence: z.array(ObservedEvidenceSchema).min(1).max(12),
  confidence: z.number().min(0).max(1),
});
export type ObservedField = z.infer<typeof ObservedFieldSchema>;

export const ObservedEntitySchema = z.object({
  name: identifier,
  description: z.string().max(300).default(''),
  fields: z.array(ObservedFieldSchema).min(1).max(40),
  /**
   * Whether records belong to the person who created them. `null` means the
   * implementation did not make ownership observable — the single most
   * consequential unknown in an import, because it decides every row-level
   * authorization check.
   */
  ownedByUser: z.boolean().nullable().default(null),
  linksTo: z.array(identifier).max(8).default([]),
  evidence: z.array(ObservedEvidenceSchema).min(1).max(12),
  confidence: z.number().min(0).max(1),
});
export type ObservedEntity = z.infer<typeof ObservedEntitySchema>;

export const ObservedRoleSchema = z.object({
  name: identifier,
  evidence: z.array(ObservedEvidenceSchema).min(1).max(12),
  confidence: z.number().min(0).max(1),
});
export type ObservedRole = z.infer<typeof ObservedRoleSchema>;

export const ObservedTransitionSchema = z.object({
  entity: identifier,
  from: identifier,
  to: identifier,
  evidence: z.array(ObservedEvidenceSchema).min(1).max(12),
  confidence: z.number().min(0).max(1),
});
export type ObservedTransition = z.infer<typeof ObservedTransitionSchema>;

export const ObservedPermissionSchema = z.object({
  entity: identifier,
  action: z.enum(['read', 'write', 'delete']),
  roles: z.array(identifier).max(12).default([]),
  /** `null` = ownership term not observable for this grant. */
  owner: z.boolean().nullable().default(null),
  evidence: z.array(ObservedEvidenceSchema).min(1).max(12),
  confidence: z.number().min(0).max(1),
});
export type ObservedPermission = z.infer<typeof ObservedPermissionSchema>;

/**
 * A behavioral statement guessed from code (a guard clause, a status check).
 * Deliberately NOT compiled here: like the natural-language layer, a rule
 * becomes enforcement only through a ruled edit carrying explicit invariant or
 * behavior operations. Until then it travels as recorded intent.
 */
export const ObservedRuleSchema = z.object({
  statement: z.string().min(3).max(400),
  evidence: z.array(ObservedEvidenceSchema).min(1).max(12),
  confidence: z.number().min(0).max(1),
});
export type ObservedRule = z.infer<typeof ObservedRuleSchema>;

export const ObservedIntentSchema = z.object({
  schemaVersion: z.literal(OBSERVED_INTENT_SCHEMA_VERSION),
  appName: identifier,
  purpose: z.string().min(3).max(400),
  /** What was observed — repo name, upload id, or similar provenance anchor. */
  observedFrom: z.string().min(1).max(200),
  observedAt: z.string().datetime(),
  entities: z.array(ObservedEntitySchema).min(1).max(24),
  roles: z.array(ObservedRoleSchema).max(12).default([]),
  transitions: z.array(ObservedTransitionSchema).max(120).default([]),
  permissions: z.array(ObservedPermissionSchema).max(120).default([]),
  rules: z.array(ObservedRuleSchema).max(24).default([]),
});
export type ObservedIntent = z.infer<typeof ObservedIntentSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Ambiguity surfacing

/** Below this, an observation is surfaced for review instead of trusted. */
export const LOW_CONFIDENCE_FLOOR = 0.55;

/**
 * Only materially consequential unknowns are asked. An impact scores at least
 * this much when a different answer changes permissions, the data model, the
 * workflow graph, or an invariant — the things proof and SHIP stand on.
 * Cosmetic, cost, and infrastructure unknowns never interrupt the user; they
 * ride visibly in the proposal and its assumptions.
 */
export const MATERIAL_IMPACT_THRESHOLD = 70;

export function isMaterialImpact(topic: QuestionImpact): boolean {
  return IMPACT_WEIGHTS[topic] >= MATERIAL_IMPACT_THRESHOLD;
}

/**
 * One ambiguity the derivation could not resolve on its own. Every surfaced
 * item is materially consequential by construction — immaterial unknowns are
 * never asked, they are recorded.
 */
export const SurfacedAmbiguitySchema = z.object({
  /** Stable id (`edges:Invoice.status`). Rulings reference this. */
  id: z.string().min(1).max(120),
  topic: z.custom<QuestionImpact>((v) => typeof v === 'string' && v in IMPACT_WEIGHTS),
  score: z.number().int().min(0),
  /** Always true today; present so the wire contract survives a future where advisory notes exist. */
  material: z.literal(true),
  /** Plain-language question. No jargon, no schema words. */
  question: z.string().min(1).max(400),
  /** What changes in the contract depending on the answer. */
  why: z.string().min(1).max(400),
  /** The conservative resolution already baked into the proposal. */
  defaultResolution: z.string().min(1).max(400),
  /** Clauses this answer governs. Empty = the construct is prospective (an omission being confirmed). */
  subjectClauseIds: z.array(z.string().min(1)).max(60),
  /** False when there is no construct to remove — reject would be meaningless and is refused. */
  rejectable: z.boolean(),
});
export type SurfacedAmbiguity = z.infer<typeof SurfacedAmbiguitySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Rulings

export const RULING_ACTIONS = ['accept', 'reject', 'edit', 'defer'] as const;
export type RulingAction = (typeof RULING_ACTIONS)[number];

/** The whole-proposal ruling uses this reserved item id. */
export const ROOT_RULING_ID = 'proposal';

export const ObservedRulingSchema = z
  .object({
    itemId: z.string().min(1).max(120),
    action: z.enum(RULING_ACTIONS),
    /** Replacement semantics. Required for `edit`, forbidden otherwise. */
    ops: z.array(ContractOpSchema).max(40).optional(),
    rationale: z.string().max(400).optional(),
  })
  .superRefine((ruling, ctx) => {
    if (ruling.action === 'edit') {
      if (!ruling.ops || ruling.ops.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ops'],
          message: 'An edit ruling must carry at least one operation',
        });
      }
    } else if (ruling.ops !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ops'],
        message: `Only edit rulings carry operations (got one on "${ruling.action}")`,
      });
    }
  });
export type ObservedRuling = z.infer<typeof ObservedRulingSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Receipts and outcomes

/** Recorded origin of one clause in the sealed contract. */
export type ProvenanceKind = 'confirmed' | 'authored' | 'system';

export interface ProvenanceEntry {
  clauseId: string;
  kind: ProvenanceKind;
  /** The ambiguity or root ruling that confirmed it, when applicable. */
  viaItemId?: string;
}

export interface RulingReceipt {
  itemId: string;
  action: RulingAction;
  subjectClauseIds: string[];
  rationale?: string;
}

export interface DeferredItem {
  itemId: string;
  question: string;
}

export interface SealReceipt {
  app: string;
  actor: string;
  sealedAt: string;
  observedFrom: string;
  /** Material unknowns put to the user. */
  questionsAsked: number;
  rulingsApplied: number;
  accepted: RulingReceipt[];
  rejected: RulingReceipt[];
  edited: RulingReceipt[];
  deferred: DeferredItem[];
  /** Conservative defaults the root acceptance endorsed, recorded for audit. */
  assumptions: { about: string; statement: string }[];
  /** Behavioral statements kept as recorded intent — not enforced until authored as invariants. */
  uncompiledRules: { statement: string; evidence: string[] }[];
  provenance: {
    counts: Record<ProvenanceKind, number>;
    entries: ProvenanceEntry[];
  };
  contractHash: string;
  revision: number;
}

export type SealedOutcome = {
  outcome: 'sealed';
  contract: import('../canonical/types.js').AppContract;
  islSource: string;
  lock: import('../artifacts/lockfile.js').IntentLock;
  /** Canonical serialized intent.lock.json — write this next to app.isl. */
  lockJson: string;
  receipt: SealReceipt;
};

export type RejectedOutcome = {
  outcome: 'rejected';
  receipt: SealReceipt;
};

export type BlockedOutcome = {
  outcome: 'blocked';
  /** Material items still awaiting a resolution. Sealing refuses while any remains. */
  unresolved: SurfacedAmbiguity[];
  receipt: SealReceipt;
};

export type SealOutcome = SealedOutcome | RejectedOutcome | BlockedOutcome;

/** Thrown for malformed input or impossible rulings — the caller's bug, not a workflow state. */
export class ObservedIntentError extends Error {
  constructor(
    message: string,
    readonly reasons: readonly string[],
  ) {
    super(reasons.length ? `${message}: ${reasons.join('; ')}` : message);
    this.name = 'ObservedIntentError';
  }
}

export type { ContractOp, DraftFieldType, QuestionImpact };
