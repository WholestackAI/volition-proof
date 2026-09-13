/**
 * Sealing: rulings in, one authoritative Intent Contract out.
 *
 * The workflow this module closes:
 *
 *   observe → propose (ISL + ranked ambiguities) → rule (accept / reject /
 *   edit / defer) → seal → intent.lock.json
 *
 * Laws enforced here, structurally rather than by convention:
 *
 *   §4  Inferred intent is not authoritative until confirmed and sealed.
 *       Every business clause must end the seal confirmed; anything the user
 *       did not resolve is either gone from the contract (reject) or blocks
 *       sealing outright (defer). Silence is never agreement.
 *   §2  Models propose; humans decide. The proposal is recomputed from the
 *       observation on every call — a caller cannot hand us a doctored
 *       contract, and the same observation plus the same rulings always
 *       produces the same hashes.
 *   §3  Provenance back to intent. The receipt records, clause by clause,
 *       whether semantics were observed-and-confirmed, explicitly authored,
 *       or system-derived plumbing — and which ruling confirmed each.
 *
 * A sealed contract locks every business clause: later changes go through
 * governed semantic patches that show their blast radius first.
 */

import { buildIntentLock, serializeIntentLock, type IntentLock } from '../artifacts/lockfile.js';
import type { AppContract } from '../canonical/types.js';
import { validateIntentDraft, type IntentDraft } from '../nl/draft.js';
import { applyPatch } from '../patch/apply.js';
import type { ContractOp, SemanticPatch } from '../patch/ops.js';
import {
  ROOT_RULING_ID,
  ObservedIntentError,
  ObservedRulingSchema,
  type BlockedOutcome,
  type DeferredItem,
  type ObservedRuling,
  type ProvenanceEntry,
  type ProvenanceKind,
  type RulingAction,
  type RulingReceipt,
  type SealOutcome,
  type SealReceipt,
  type SurfacedAmbiguity,
} from './types.js';
import {
  buildProposalContract,
  cleanObservedIntent,
  proposeFromObservation,
  storageFieldName,
} from './propose.js';

// ─────────────────────────────────────────────────────────────────────────────
// helpers

const key = (...parts: string[]): string => parts.join(':');

/**
 * Zod infers optional properties as `prop?: T | undefined`; the contract op
 * types forbid explicit undefined. Strip undefined keys so a validated ruling
 * satisfies the governed op types without lying about it.
 */
function normalizeOps(ops: ReadonlyArray<Record<string, unknown>>): ContractOp[] {
  return ops.map((op) => {
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(op)) {
      if (v !== undefined) cleaned[k] = v;
    }
    return cleaned as unknown as ContractOp;
  });
}

function rulingRationale(rulings: ValidatedRulings, itemId: string): string | undefined {
  return rulings.byItemId.get(itemId)?.rationale;
}

function rootQuestion(): SurfacedAmbiguity {
  return {
    id: ROOT_RULING_ID,
    topic: 'permissions',
    score: 1000,
    material: true,
    question: 'Accept the observed structure as proposed?',
    why: 'Everything shown enters the sealed contract as confirmed requirements.',
    defaultResolution: 'No — nothing seals without your acceptance.',
    subjectClauseIds: [],
    rejectable: true,
  };
}

interface ValidatedRulings {
  root: ObservedRuling | undefined;
  byItemId: Map<string, ObservedRuling>;
}

function validateRulings(raw: unknown[], ambiguities: SurfacedAmbiguity[]): ValidatedRulings {
  const known = new Map(ambiguities.map((a) => [a.id, a]));
  const byItemId = new Map<string, ObservedRuling>();
  const reasons: string[] = [];
  let root: ObservedRuling | undefined;

  for (const [index, item] of raw.entries()) {
    const parsed = ObservedRulingSchema.safeParse(item);
    if (!parsed.success) {
      reasons.push(`rulings[${index}]: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      continue;
    }
    const ruling = parsed.data;

    if (ruling.itemId !== ROOT_RULING_ID && !known.has(ruling.itemId)) {
      reasons.push(
        `Ruling references "${ruling.itemId}", which was never asked. Only surfaced items are answerable.`,
      );
      continue;
    }
    if (byItemId.has(ruling.itemId)) {
      reasons.push(`Duplicate rulings for "${ruling.itemId}" — one decision per item.`);
      continue;
    }
    if (
      ruling.action === 'reject' &&
      ruling.itemId !== ROOT_RULING_ID &&
      !known.get(ruling.itemId)!.rejectable
    ) {
      reasons.push(
        `"${ruling.itemId}" has no construct to remove. Accept it, edit it, or defer it.`,
      );
      continue;
    }

    byItemId.set(ruling.itemId, ruling);
    if (ruling.itemId === ROOT_RULING_ID) root = ruling;
  }

  // An edit on the root rides along with acceptance; it is still one decision.
  if (reasons.length) {
    throw new ObservedIntentError('Rulings could not be applied', reasons);
  }
  return { root, byItemId };
}

/** Draft-level effect of a reject ruling: the uncertain construct never enters. */
function applyRejectionsToDraft(
  draft: IntentDraft,
  rulings: ValidatedRulings,
  excluded: Set<string>,
): IntentDraft {
  const next: IntentDraft = JSON.parse(JSON.stringify(draft)) as IntentDraft;

  const findField = (entityName: string, storedName: string) =>
    next.entities
      .find((e) => e.name === entityName)
      ?.fields.find((f) => storageFieldName(f.name, f.type) === storedName);

  for (const ruling of rulings.byItemId.values()) {
    if (ruling.action !== 'reject') continue;
    const parts = ruling.itemId.split(':');

    if (parts[0] === 'own' && parts[1]) {
      const entity = next.entities.find((e) => e.name === parts[1]);
      if (entity) entity.ownedByUser = false;
    } else if (parts[0] === 'edges' && parts[1]) {
      const dot = parts[1].indexOf('.');
      const entityName = dot === -1 ? parts[1] : parts[1].slice(0, dot);
      const storedName = dot === -1 ? parts.slice(2).join(':') : parts[1].slice(dot + 1);
      const field = findField(entityName, storedName);
      if (field) {
        field.endStates = [];
        excluded.add(key('lifecycle', entityName, storedName));
      }
    } else if (parts[0] === 'conflict' && parts[1] === 'field' && parts[2]) {
      const separator = parts[2]!.indexOf('.');
      const entityName = parts[2]!.slice(0, separator);
      const storedName = parts[2]!.slice(separator + 1);
      const entity = next.entities.find((e) => e.name === entityName);
      if (entity) {
        entity.fields = entity.fields.filter(
          (f) => storageFieldName(f.name, f.type) !== storedName,
        );
      }
    } else if (parts[0] === 'lowconf') {
      if (parts[1] === 'entity' && parts[2]) {
        next.entities = next.entities.filter((e) => e.name !== parts[2]);
      } else if (parts[1] === 'field' && parts[2]) {
        const separator = parts[2]!.indexOf('.');
        const entityName = parts[2]!.slice(0, separator);
        const storedName = parts[2]!.slice(separator + 1);
        const entity = next.entities.find((e) => e.name === entityName);
        if (entity) {
          entity.fields = entity.fields.filter(
            (f) => storageFieldName(f.name, f.type) !== storedName,
          );
        }
      } else if (parts[1] === 'role' && parts[2]) {
        next.roles = next.roles.filter((r) => r.name !== parts[2]);
      } else if (parts[1] === 'perm' && parts.length >= 4) {
        excluded.add(key('perm', parts[2]!, parts[3]!));
      }
    }
  }
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// confirmation stamping

/**
 * Promote every business clause to confirmed and lock it. System plumbing
 * (surrogate keys, timestamps) stays unlocked and unconfirmed — it is derived
 * machinery, never stated semantics.
 */
function stampSealedProvenance(
  contract: AppContract,
  viaItem: (clauseId: string) => string,
  actor: string,
): void {
  for (const clause of contract.clauses) {
    const meta = contract.meta.clauses[clause.id];
    if (!meta || meta.source === 'system') continue;
    const itemId = viaItem(clause.id);
    const suffix =
      meta.source === 'user'
        ? ` Authored by ${actor}${itemId ? ` via ${itemId}` : ''}.`
        : ` Confirmed by ${actor}${itemId && itemId !== ROOT_RULING_ID ? ` via ${itemId}` : ''}.`;
    const rationale = `${meta.rationale ?? ''}${suffix}`;
    contract.meta.clauses[clause.id] = {
      ...meta,
      confirmed: true,
      locked: true,
      confidence: 1,
      rationale: rationale.length > 480 ? `${rationale.slice(0, 477)}…` : rationale,
    };
  }
}

/** Defense in depth: a sealed contract may not contain unconfirmed semantics. */
function assertFullyConfirmed(contract: AppContract): void {
  const open = contract.clauses
    .filter((c) => {
      const meta = contract.meta.clauses[c.id];
      return meta && meta.source !== 'system' && !meta.confirmed;
    })
    .map((c) => c.id);
  if (open.length) {
    throw new ObservedIntentError('Refusing to seal: unconfirmed semantics remain', open);
  }
}

function provenanceEntries(
  contract: AppContract,
  viaItem: (clauseId: string) => string,
): ProvenanceEntry[] {
  const entries: ProvenanceEntry[] = [];
  for (const clause of contract.clauses) {
    const meta = contract.meta.clauses[clause.id];
    if (!meta) continue;
    const kind: ProvenanceKind =
      meta.source === 'user' ? 'authored' : meta.source === 'system' ? 'system' : 'confirmed';
    entries.push({
      clauseId: clause.id,
      kind,
      ...(kind === 'system' ? {} : { viaItemId: viaItem(clause.id) }),
    });
  }
  return entries.sort((a, b) => (a.clauseId < b.clauseId ? -1 : 1));
}

function emptyCounts(): Record<ProvenanceKind, number> {
  return { confirmed: 0, authored: 0, system: 0 };
}

function countEntries(entries: ProvenanceEntry[]): Record<ProvenanceKind, number> {
  const counts = emptyCounts();
  for (const entry of entries) counts[entry.kind] += 1;
  return counts;
}

// ─────────────────────────────────────────────────────────────────────────────
// sealing

export interface SealObservedIntentInput {
  /** Raw observed intent (validated here — callers cannot bypass the schema). */
  observed: unknown;
  /** One ruling per asked item, plus exactly one on the reserved root id. */
  rulings?: unknown[];
  /** Who is confirming — recorded verbatim in provenance. */
  actor: string;
  sealedAt?: string;
}

/**
 * Close the workflow. Pure and deterministic: same observation, same rulings,
 * same contract hash and lock. Throws `ObservedIntentError` only for malformed
 * input or impossible rulings — deferrals and rejections are outcomes, not
 * errors.
 */
export function sealObservedIntent(input: SealObservedIntentInput): SealOutcome {
  if (!input.actor.trim()) {
    throw new ObservedIntentError('A sealer identity is required', ['actor must not be empty']);
  }
  const actor = input.actor.trim();
  const sealedAt = input.sealedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');

  const proposal = proposeFromObservation(input.observed);
  if (!proposal.ok) {
    throw new ObservedIntentError(
      'The observation does not propose a valid contract',
      proposal.errors,
    );
  }

  const ambiguities = proposal.ambiguities;
  const rulings = validateRulings(input.rulings ?? [], ambiguities);

  // Silence is a deferral, never agreement.
  const effectiveAction = (itemId: string): RulingAction =>
    rulings.byItemId.get(itemId)?.action ?? 'defer';

  const receiptBase = {
    app: proposal.observed.appName,
    actor,
    sealedAt,
    observedFrom: proposal.observed.observedFrom,
    questionsAsked: ambiguities.length,
    assumptions: [] as SealReceipt['assumptions'],
    uncompiledRules: proposal.observed.rules.map((rule) => ({
      statement: rule.statement,
      evidence: rule.evidence.map((e) => `${e.kind} ${e.ref}`),
    })),
  };

  // ── root disposition ────────────────────────────────────────────────────
  const rootAction = effectiveAction(ROOT_RULING_ID);

  if (rootAction === 'reject') {
    const rootRationale = rulings.root?.rationale;
    const receipt: SealReceipt = {
      ...receiptBase,
      rulingsApplied: 1,
      accepted: [],
      rejected: [
        {
          itemId: ROOT_RULING_ID,
          action: 'reject',
          subjectClauseIds: [],
          ...(rootRationale ? { rationale: rootRationale } : {}),
        },
      ],
      edited: [],
      deferred: [],
      provenance: { counts: emptyCounts(), entries: [] },
      contractHash: proposal.contract.contractHash,
      revision: proposal.contract.meta.revision,
    };
    return { outcome: 'rejected', receipt };
  }

  // ── deferrals block sealing ─────────────────────────────────────────────
  const deferred: DeferredItem[] = [];
  const unresolved: SurfacedAmbiguity[] = [];

  if (rootAction === 'defer') {
    deferred.push({ itemId: ROOT_RULING_ID, question: rootQuestion().question });
    unresolved.push(rootQuestion());
  }
  for (const item of ambiguities) {
    if (effectiveAction(item.id) !== 'defer') continue;
    deferred.push({ itemId: item.id, question: item.question });
    unresolved.push(item);
  }

  if (deferred.length) {
    const receipt: SealReceipt = {
      ...receiptBase,
      rulingsApplied: rulings.byItemId.size,
      accepted: [],
      rejected: [],
      edited: [],
      deferred,
      provenance: { counts: emptyCounts(), entries: [] },
      contractHash: proposal.contract.contractHash,
      revision: proposal.contract.meta.revision,
    };
    const blocked: BlockedOutcome = {
      outcome: 'blocked',
      unresolved: unresolved.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)),
      receipt,
    };
    return blocked;
  }

  // ── apply resolutions ───────────────────────────────────────────────────
  const observation = cleanObservedIntent(proposal.observed);
  const excluded = new Set<string>();
  const workingDraft = applyRejectionsToDraft(proposal.draft, rulings, excluded);

  const redrafted = validateIntentDraft(workingDraft);
  if (!redrafted.ok) {
    throw new ObservedIntentError(
      'The rejected-away observations leave a structure that cannot be proposed',
      redrafted.errors,
    );
  }

  let contract: AppContract;
  try {
    contract = buildProposalContract(redrafted.draft, observation, { excluded }).contract;
  } catch (error) {
    if (error instanceof ObservedIntentError) throw error;
    throw error;
  }

  // Edits are user-authored patches — the governed path, blast radius checked.
  const editedReceipts: RulingReceipt[] = [];
  const editRulings = [...rulings.byItemId.values()]
    .filter((r) => r.action === 'edit')
    .sort((a, b) =>
      a.itemId === ROOT_RULING_ID
        ? -1
        : b.itemId === ROOT_RULING_ID
          ? 1
          : a.itemId < b.itemId
            ? -1
            : 1,
    );

  for (const ruling of editRulings) {
    if (!ruling.ops?.length) continue;
    const patch: SemanticPatch = {
      id: `ruling:${ruling.itemId}`,
      title: `Authored during import — ${ruling.itemId}`,
      origin: 'user',
      ops: normalizeOps(ruling.ops),
      ...(ruling.rationale ? { rationale: ruling.rationale, originalText: ruling.rationale } : {}),
    };
    const result = applyPatch(contract, patch);
    if (!result.ok) {
      throw new ObservedIntentError(`The edit on "${ruling.itemId}" cannot be applied`, [
        result.message,
        ...(result.detail ? [result.detail] : []),
      ]);
    }
    contract = result.contract;
    editedReceipts.push({
      itemId: ruling.itemId,
      action: 'edit',
      subjectClauseIds: [
        ...new Set(result.diff.changes.filter((c) => c.kind !== 'removed').map((c) => c.clauseId)),
      ],
      ...(ruling.rationale ? { rationale: ruling.rationale } : {}),
    });
  }

  // ── confirmation ────────────────────────────────────────────────────────
  const claimsByClause = new Map<string, string>();
  for (const item of [...ambiguities].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))) {
    if (effectiveAction(item.id) !== 'accept') continue;
    for (const clauseId of item.subjectClauseIds) {
      if (!claimsByClause.has(clauseId)) claimsByClause.set(clauseId, item.id);
    }
  }
  for (const receipt of editedReceipts) {
    for (const clauseId of receipt.subjectClauseIds) claimsByClause.set(clauseId, receipt.itemId);
  }
  const viaItem = (clauseId: string): string => claimsByClause.get(clauseId) ?? ROOT_RULING_ID;

  stampSealedProvenance(contract, viaItem, actor);
  assertFullyConfirmed(contract);

  // ── artifacts ───────────────────────────────────────────────────────────
  const lock: IntentLock = buildIntentLock(contract);
  const entries = provenanceEntries(contract, viaItem);

  const acceptedReceipts: RulingReceipt[] = ambiguities
    .filter((item) => effectiveAction(item.id) === 'accept')
    .map((item) => {
      const rationale = rulingRationale(rulings, item.id);
      return {
        itemId: item.id,
        action: 'accept' as const,
        subjectClauseIds: item.subjectClauseIds,
        ...(rationale ? { rationale } : {}),
      };
    });

  const rejectedReceipts: RulingReceipt[] = ambiguities
    .filter((item) => effectiveAction(item.id) === 'reject')
    .map((item) => {
      const rationale = rulingRationale(rulings, item.id);
      return {
        itemId: item.id,
        action: 'reject' as const,
        subjectClauseIds: item.subjectClauseIds,
        ...(rationale ? { rationale } : {}),
      };
    });

  // Endorsed defaults: resolutions the base proposal baked in and the user
  // accepted wholesale. Recorded so the audit trail shows they were choices.
  const assumptions = ambiguities
    .filter((item) => effectiveAction(item.id) === 'accept')
    .map((item) => ({ about: item.id, statement: item.defaultResolution }));

  const receipt: SealReceipt = {
    ...receiptBase,
    rulingsApplied: rulings.byItemId.size,
    accepted: acceptedReceipts,
    rejected: rejectedReceipts,
    edited: editedReceipts,
    deferred: [],
    assumptions,
    provenance: { counts: countEntries(entries), entries },
    contractHash: contract.contractHash,
    revision: contract.meta.revision,
  };

  return {
    outcome: 'sealed',
    contract,
    islSource: contract.islSource,
    lock,
    lockJson: serializeIntentLock(lock),
    receipt,
  };
}

/** Clause ids a ruling ended up governing come from the applied patch's diff. */

// ─────────────────────────────────────────────────────────────────────────────
// inspection

/**
 * Business clauses observed from the implementation that no human has
 * confirmed yet. Empty is the precondition for sealing.
 */
export function unconfirmedObserved(contract: AppContract): { id: string; rationale?: string }[] {
  return contract.clauses
    .filter((c) => {
      const meta = contract.meta.clauses[c.id];
      return meta && meta.source === 'imported' && !meta.confirmed;
    })
    .map((c) => ({
      id: c.id,
      ...(contract.meta.clauses[c.id]?.rationale
        ? { rationale: contract.meta.clauses[c.id]!.rationale }
        : {}),
    }));
}
