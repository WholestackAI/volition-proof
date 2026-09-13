/**
 * Semantic locking and assumption confirmation.
 *
 * A lock is a promise to the user that a requirement they cared about will not
 * be quietly rewritten by an AI edit, a template merge, or a regeneration. It
 * is enforced in `applyPatch` against the semantic diff — this module only
 * records the intent.
 */

import type { AppContract, ClauseId, ClauseMeta } from '../canonical/types.js';

function withMeta(contract: AppContract, id: ClauseId, patch: Partial<ClauseMeta>): AppContract {
  const existing = contract.meta.clauses[id];
  if (!existing) return contract;
  return {
    ...contract,
    meta: {
      ...contract.meta,
      clauses: { ...contract.meta.clauses, [id]: { ...existing, ...patch } },
    },
  };
}

export function lockClause(contract: AppContract, id: ClauseId): AppContract {
  return withMeta(contract, id, { locked: true, confirmed: true });
}

export function unlockClause(contract: AppContract, id: ClauseId): AppContract {
  return withMeta(contract, id, { locked: false });
}

/**
 * Promote an assumption to confirmed intent. Confidence goes to 1 because the
 * user has now said it out loud — the clause is no longer a guess.
 */
export function confirmClause(contract: AppContract, id: ClauseId): AppContract {
  return withMeta(contract, id, { confirmed: true, source: 'user', confidence: 1 });
}

export function isLocked(contract: AppContract, id: ClauseId): boolean {
  return contract.meta.clauses[id]?.locked ?? false;
}

/** Every clause the system inferred and the user has not yet confirmed. */
export function openAssumptions(contract: AppContract): { id: ClauseId; meta: ClauseMeta }[] {
  return Object.entries(contract.meta.clauses)
    .filter(([, meta]) => meta.source === 'inferred' && !meta.confirmed)
    .map(([id, meta]) => ({ id, meta }))
    .sort((a, b) => a.meta.confidence - b.meta.confidence);
}
