/**
 * Impact analysis — what a semantic change forces downstream.
 *
 * Deterministic mapping from clause kind + change kind to the parts of the
 * generated system that must move. No AI: the compiler already knows which
 * clause kinds project to schema, routes, authorization, screens and proof, so
 * the blast radius is derivable, not guessed.
 */

import type { ClauseId } from '../canonical/types.js';
import type { SemanticChange, SemanticDiff } from './semantic-diff.js';

export type ImpactArea =
  | 'data-migration'
  | 'api'
  | 'authorization'
  | 'ui'
  | 'background'
  | 'infrastructure'
  | 'tests'
  | 'proof';

export type ImpactRisk = 'low' | 'medium' | 'high';

export interface ImpactReport {
  /** Human-readable consequences, grouped by area. */
  areas: Record<ImpactArea, string[]>;
  risk: ImpactRisk;
  /**
   * Clauses whose existing proof evidence no longer applies. ShipGate must
   * re-prove these before the app can ship again.
   */
  invalidatedProof: ClauseId[];
  /** True when the change cannot be applied without a database migration. */
  requiresMigration: boolean;
  /** True when the change removes or narrows an existing guarantee. */
  narrowsGuarantees: boolean;
}

function emptyAreas(): Record<ImpactArea, string[]> {
  return {
    'data-migration': [],
    api: [],
    authorization: [],
    ui: [],
    background: [],
    infrastructure: [],
    tests: [],
    proof: [],
  };
}

function label(change: SemanticChange): string {
  const verb =
    change.kind === 'added' ? 'Added' : change.kind === 'removed' ? 'Removed' : 'Changed';
  return `${verb}: ${change.after ?? change.before ?? change.clauseId}`;
}

function push(areas: Record<ImpactArea, string[]>, area: ImpactArea, text: string): void {
  if (!areas[area].includes(text)) areas[area].push(text);
}

/** Areas each clause kind projects into. This is the compiler's own topology. */
function areasFor(change: SemanticChange): ImpactArea[] {
  switch (change.clauseKind) {
    case 'entity':
    case 'field':
    case 'relationship':
      return ['data-migration', 'api', 'ui', 'tests', 'proof'];
    case 'status-set':
      return ['data-migration', 'ui', 'tests', 'proof'];
    case 'transition':
      return ['api', 'ui', 'tests', 'proof'];
    case 'permission':
    case 'policy':
    case 'behavior-security':
      return ['authorization', 'api', 'ui', 'tests', 'proof'];
    case 'role':
      return ['authorization', 'ui', 'tests'];
    case 'behavior':
      return ['api', 'ui', 'tests', 'proof'];
    case 'precondition':
    case 'postcondition':
    case 'invariant':
      return ['api', 'tests', 'proof'];
    case 'view':
    case 'aggregate':
      return ['ui', 'api', 'tests'];
    case 'query':
      return ['ui', 'api', 'tests'];
    case 'job':
    case 'notification':
      return ['background', 'api', 'tests'];
    case 'integration':
    case 'auth-provider':
      return ['infrastructure', 'background', 'api', 'tests'];
    case 'screen':
      return ['ui', 'tests'];
    case 'app':
      return ['infrastructure'];
    default:
      return ['tests'];
  }
}

const MIGRATION_KINDS = new Set(['entity', 'field', 'relationship', 'status-set']);

export function analyzeImpact(diff: SemanticDiff): ImpactReport {
  const areas = emptyAreas();
  const invalidatedProof: ClauseId[] = [];
  let requiresMigration = false;
  let narrowsGuarantees = false;

  for (const change of diff.changes) {
    const text = label(change);
    for (const area of areasFor(change)) push(areas, area, text);

    if (MIGRATION_KINDS.has(change.clauseKind) && change.kind !== 'added') requiresMigration = true;
    if (MIGRATION_KINDS.has(change.clauseKind) && change.kind === 'added') requiresMigration = true;
    if (change.kind === 'removed') narrowsGuarantees = true;

    if (areasFor(change).includes('proof')) {
      invalidatedProof.push(change.clauseId);
      // A rule's proof also dies when the behavior it guards moves.
      for (const other of diff.changes) {
        if (
          other.clauseId !== change.clauseId &&
          other.clauseId.startsWith(`${change.clauseId}:`)
        ) {
          invalidatedProof.push(other.clauseId);
        }
      }
    }
  }

  const risk: ImpactRisk =
    diff.lockViolations.length > 0 || narrowsGuarantees
      ? 'high'
      : areas.authorization.length > 0 || requiresMigration
        ? 'medium'
        : 'low';

  return {
    areas,
    risk,
    invalidatedProof: [...new Set(invalidatedProof)],
    requiresMigration,
    narrowsGuarantees,
  };
}

/** Flatten an impact report into the ordered lines the Blueprint shows. */
export function impactLines(report: ImpactReport): { area: ImpactArea; lines: string[] }[] {
  const order: ImpactArea[] = [
    'data-migration',
    'authorization',
    'api',
    'ui',
    'background',
    'infrastructure',
    'tests',
    'proof',
  ];
  return order
    .map((area) => ({ area, lines: report.areas[area] }))
    .filter((entry) => entry.lines.length > 0);
}
