/**
 * Agent Mandate — a machine-readable *view* of a sealed `AppContract`.
 *
 * This is not a second language, not a prompt, and not `volition.authorize`.
 * `decideCommand` remains the vote. The mandate compiles existing clause kinds
 * (`role`, `permission`, `behavior`, `precondition`, `behavior-security`,
 * `invariant`) into an allow-list an agent runtime can read.
 *
 * `may` is that allow list. This module does **not** synthesize a `may_not`
 * deny list: unknown actions are already fail-closed by `decideCommand`
 * (`UNKNOWN_ACTION`). Absence from `may` is the same contract, viewed as a
 * grant list — not a new keyword.
 *
 * No `budget`, `goal`, `objective`, or path-ownership fields. Limits are
 * `precondition` clauses. Approvals are `behavior-security` clauses whose
 * requirement is approval (the same classification `decideCommand` uses).
 *
 * Pure: no IO, no clock, no network.
 */

import type { ClauseSemantic, NormalizedExpression } from './canonical/semantic.js';
import { sortedSet } from './canonical/semantic.js';
import type { AppContract, Clause, ClauseId } from './canonical/types.js';

/** One `precondition` restated as a bound on a named behavior. */
export interface MandateLimit {
  readonly behavior: string;
  readonly reason: string;
  readonly clauseId: ClauseId;
}

/**
 * Projection of a sealed contract for agent authority.
 *
 * `behaviors` is the full named surface. `requiresApproval` is the subset
 * gated by `behavior-security` / approval. `may` is the remainder — granted
 * without an approval clause. The two partitions are disjoint; their union is
 * `behaviors`.
 */
export interface MandateView {
  readonly roles: readonly string[];
  readonly behaviors: readonly string[];
  readonly may: readonly string[];
  readonly requiresApproval: readonly string[];
  readonly limits: readonly MandateLimit[];
  readonly invariants: readonly string[];
  readonly clauseIds: readonly ClauseId[];
}

/**
 * NORTH-STAR §1a autonomy ladder. Derived from a mandate view.
 * Not a writable contract field. A4/A5 need constructs this view does not have.
 */
export const AUTONOMY_LEVELS = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export interface DerivedAutonomy {
  readonly level: AutonomyLevel;
  readonly reason: string;
}

/** Ceiling implied by the mandate partitions. Never A4 or A5 today. */
export function deriveAutonomy(mandate: MandateView): DerivedAutonomy {
  if (mandate.behaviors.length === 0) {
    return { level: 'A0', reason: 'No named behaviors. Observe only.' };
  }
  if (mandate.may.length === 0) {
    return { level: 'A1', reason: 'Every named behavior requires approval.' };
  }
  if (mandate.limits.length === 0) {
    return { level: 'A2', reason: 'Ungated behaviors exist. No precondition bounds.' };
  }
  return {
    level: 'A3',
    reason: 'Ungated behaviors exist and preconditions bound them.',
  };
}

const MANDATE_KINDS = new Set<Clause['kind']>([
  'role',
  'permission',
  'behavior',
  'precondition',
  'behavior-security',
  'invariant',
]);

function semanticOf<K extends ClauseSemantic['kind']>(
  clause: Clause,
  kind: K,
): Extract<ClauseSemantic, { kind: K }> | undefined {
  const semantic = clause.semantic;
  if (semantic?.kind === kind) return semantic as Extract<ClauseSemantic, { kind: K }>;
  return undefined;
}

function nameAfterPrefix(id: string, prefix: string): string {
  if (!id.startsWith(prefix)) return '';
  const rest = id.slice(prefix.length);
  const colon = rest.indexOf(':');
  return colon === -1 ? rest : rest.slice(0, colon);
}

function securityText(expr: NormalizedExpression): string {
  if (expr.node === 'ref') return expr.path.join('.');
  if (expr.node === 'string') return expr.value;
  return '';
}

/**
 * Same meaning as `commandRequiresApproval` in `@wholestack/authority`.
 * Duplicated here so this package does not import the voter — the mandate is a
 * view of clauses, not a second authorizer.
 */
function isApprovalSecurity(
  semantic: Extract<ClauseSemantic, { kind: 'behavior-security' }>,
): boolean {
  if (semantic.requirementType === 'requireRole') return false;
  if (semantic.requirementType === 'requires') {
    return /^approval$/i.test(securityText(semantic.requirement));
  }
  return /approv/i.test(semantic.requirementType);
}

function renderPredicate(expr: NormalizedExpression): string {
  switch (expr.node) {
    case 'null':
      return 'null';
    case 'boolean':
      return String(expr.value);
    case 'number':
      return expr.number.written;
    case 'string':
      return JSON.stringify(expr.value);
    case 'ref':
      return expr.path.join('.');
    case 'compare':
      return `${renderPredicate(expr.left)} ${expr.op} ${renderPredicate(expr.right)}`;
    case 'logical':
      return expr.operands.map(renderPredicate).join(` ${expr.op} `);
    case 'not':
      return `not (${renderPredicate(expr.operand)})`;
    case 'call':
      return `${expr.fn}(${expr.args.map(renderPredicate).join(', ')})`;
    case 'list':
      return `[${expr.items.map(renderPredicate).join(', ')}]`;
    case 'unrepresented':
      return '';
  }
}

function limitReason(clause: Clause, predicate: NormalizedExpression | undefined): string {
  if (predicate) {
    const rendered = renderPredicate(predicate);
    if (rendered) return rendered;
  }
  return clause.title;
}

function sortLimits(limits: readonly MandateLimit[]): MandateLimit[] {
  return [...limits].sort((left, right) => {
    if (left.behavior !== right.behavior) {
      return left.behavior < right.behavior ? -1 : 1;
    }
    if (left.clauseId !== right.clauseId) {
      return left.clauseId < right.clauseId ? -1 : 1;
    }
    return 0;
  });
}

/** Project a sealed AppContract into an Agent Mandate view. */
export function projectMandate(contract: AppContract): MandateView {
  const roles: string[] = [];
  const behaviors: string[] = [];
  const approval = new Set<string>();
  const limits: MandateLimit[] = [];
  const invariants: string[] = [];
  const clauseIds: ClauseId[] = [];

  for (const clause of contract.clauses) {
    if (!MANDATE_KINDS.has(clause.kind)) continue;
    clauseIds.push(clause.id);

    switch (clause.kind) {
      case 'role': {
        const name = semanticOf(clause, 'role')?.role || nameAfterPrefix(clause.id, 'role:');
        if (name) roles.push(name);
        break;
      }
      case 'behavior': {
        const name =
          semanticOf(clause, 'behavior')?.behavior || nameAfterPrefix(clause.id, 'behavior:');
        if (name) behaviors.push(name);
        break;
      }
      case 'behavior-security': {
        const semantic = semanticOf(clause, 'behavior-security');
        if (semantic && isApprovalSecurity(semantic)) approval.add(semantic.behavior);
        break;
      }
      case 'precondition': {
        const semantic = semanticOf(clause, 'precondition');
        const behavior =
          semantic?.behavior || nameAfterPrefix(clause.id, 'precondition:');
        if (!behavior) break;
        limits.push({
          behavior,
          reason: limitReason(clause, semantic?.predicate),
          clauseId: clause.id,
        });
        break;
      }
      case 'invariant': {
        const semantic = semanticOf(clause, 'invariant');
        const label = semantic?.name || clause.title;
        if (label) invariants.push(label);
        break;
      }
      case 'permission':
        break;
      default:
        break;
    }
  }

  const uniqueBehaviors = sortedSet(behaviors);
  const requiresApproval = sortedSet([...approval].filter((name) => uniqueBehaviors.includes(name)));
  const blocked = new Set(requiresApproval);
  const may = uniqueBehaviors.filter((name) => !blocked.has(name));

  return {
    roles: sortedSet(roles),
    behaviors: uniqueBehaviors,
    may,
    requiresApproval,
    limits: sortLimits(limits),
    invariants: sortedSet(invariants),
    clauseIds: sortedSet(clauseIds),
  };
}
