/**
 * Semantic diff — changes in *meaning*, not in text.
 *
 * Two contracts are compared clause by clause on their canonical ISL excerpt,
 * whitespace-collapsed. Reindenting a spec, reordering entities, or rewriting a
 * comment produces an empty diff; changing an approval threshold from $10,000
 * to $20,000 produces exactly one `changed` entry.
 */

import type {
  AppContract,
  BlueprintSection,
  Clause,
  ClauseId,
  ClauseKind,
} from '../canonical/types.js';

export type SemanticChangeKind = 'added' | 'removed' | 'changed';

export interface SemanticChange {
  kind: SemanticChangeKind;
  clauseId: ClauseId;
  clauseKind: ClauseKind;
  section: BlueprintSection;
  /** Plain-English before/after. `before` is absent for additions. */
  before?: string;
  after?: string;
  beforeIsl?: string;
  afterIsl?: string;
  /** True when the clause was locked in the source contract. */
  locked: boolean;
}

export interface SemanticDiff {
  fromHash: string;
  toHash: string;
  changes: SemanticChange[];
  hasChanges: boolean;
  /** Locked clauses this diff would modify or remove. Empty means safe to apply. */
  lockViolations: ClauseId[];
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function byId(clauses: Clause[]): Map<ClauseId, Clause> {
  return new Map(clauses.map((c) => [c.id, c]));
}

export function diffContracts(before: AppContract, after: AppContract): SemanticDiff {
  const beforeMap = byId(before.clauses);
  const afterMap = byId(after.clauses);
  const changes: SemanticChange[] = [];
  const lockViolations: ClauseId[] = [];

  for (const [id, beforeClause] of beforeMap) {
    const locked = before.meta.clauses[id]?.locked ?? false;
    const afterClause = afterMap.get(id);
    if (!afterClause) {
      changes.push({
        kind: 'removed',
        clauseId: id,
        clauseKind: beforeClause.kind,
        section: beforeClause.section,
        before: beforeClause.title,
        beforeIsl: beforeClause.islExcerpt,
        locked,
      });
      if (locked) lockViolations.push(id);
      continue;
    }
    if (collapse(beforeClause.islExcerpt) !== collapse(afterClause.islExcerpt)) {
      changes.push({
        kind: 'changed',
        clauseId: id,
        clauseKind: afterClause.kind,
        section: afterClause.section,
        before: beforeClause.title,
        after: afterClause.title,
        beforeIsl: beforeClause.islExcerpt,
        afterIsl: afterClause.islExcerpt,
        locked,
      });
      if (locked) lockViolations.push(id);
    }
  }

  for (const [id, afterClause] of afterMap) {
    if (beforeMap.has(id)) continue;
    changes.push({
      kind: 'added',
      clauseId: id,
      clauseKind: afterClause.kind,
      section: afterClause.section,
      after: afterClause.title,
      afterIsl: afterClause.islExcerpt,
      locked: false,
    });
  }

  changes.sort((a, b) => (a.clauseId < b.clauseId ? -1 : a.clauseId > b.clauseId ? 1 : 0));

  return {
    fromHash: before.contractHash,
    toHash: after.contractHash,
    changes,
    hasChanges: changes.length > 0,
    lockViolations,
  };
}

/** One-line English summary of a diff, for a commit message or a CLI line. */
export function summarizeDiff(diff: SemanticDiff): string {
  if (!diff.hasChanges) return 'No change in meaning.';
  const counts = { added: 0, removed: 0, changed: 0 };
  for (const change of diff.changes) counts[change.kind] += 1;
  const parts: string[] = [];
  if (counts.added) parts.push(`${counts.added} added`);
  if (counts.changed) parts.push(`${counts.changed} changed`);
  if (counts.removed) parts.push(`${counts.removed} removed`);
  return parts.join(', ');
}
