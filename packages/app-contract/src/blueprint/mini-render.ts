/**
 * Reverse projection: canonical contract → Mini-ISL.
 *
 * `expandMiniIsl` has always been one-way — a shorthand a human writes that the
 * pipeline expands. Without the return trip, a contract edited anywhere else
 * could never be shown back in the readable form, so the readable form was a
 * write-only entry point. This closes the loop:
 *
 *   mini → ISL → contract → mini → ISL → contract   (same semantic hash)
 *
 * The projection is deliberately lossy in one direction only: constructs Mini
 * cannot express (hand-written invariants, policies, bespoke lifecycles) are
 * reported in `unrepresented` rather than silently dropped, so a caller can
 * refuse to show a Mini view that would understate the contract.
 */

import type { Domain, Entity, Field, Policy, View } from '@isl-lang/parser';
import { expressionToIsl } from '../canonical/expression.js';
import { collectEnums, referenceTarget, typeToIsl } from '../canonical/from-isl.js';
import type { AppContract } from '../canonical/types.js';

/** ISL primitive → the Mini type token that expands back to it. */
const ISL_TO_MINI_TYPE: Record<string, string> = {
  String: 'string',
  Text: 'text',
  Int: 'int',
  Decimal: 'decimal',
  Float: 'float',
  Boolean: 'bool',
  Date: 'date',
  Timestamp: 'timestamp',
  UUID: 'uuid',
  JSON: 'json',
};

/** Fields the expander always injects; never written by a Mini author. */
const INJECTED_FIELDS = new Set(['id', 'createdAt']);

const MINI_ANNOTATIONS = new Set(['search', 'pay', 'media', 'file', 'unique', 'indexed']);

export interface MiniRenderResult {
  mini: string;
  /**
   * Contract clauses Mini cannot carry. Non-empty means the Mini view is a
   * summary, not an equivalent — callers must say so.
   */
  unrepresented: string[];
}

type ViewForEntity = { name?: { parts?: { name: string }[] } };

function asViewForEntity(value: unknown): ViewForEntity {
  return value as ViewForEntity;
}

function idOf(node: { name: string } | undefined): string {
  return node?.name ?? '';
}

function camel(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function isProjectedOwnerPolicy(policy: Policy, ownedEntities: ReadonlySet<string>): boolean {
  const target = policy.appliesTo?.target;
  if (target === 'all' || !Array.isArray(target) || target.length !== 1) return false;
  const entityName = idOf(target[0]);
  if (!ownedEntities.has(entityName)) return false;
  if (idOf(policy.name) !== `per_owner_${snake(entityName)}`) return false;

  const rules = policy.rules ?? [];
  if (rules.length !== 2) return false;
  const ownerAllow = rules.some(
    (rule) =>
      rule.condition != null &&
      expressionToIsl(rule.condition).replace(/^\((.*)\)$/, '$1') === 'row.ownerId == ctx.userId' &&
      expressionToIsl(rule.action) === 'allow',
  );
  const defaultDeny = rules.some(
    (rule) => rule.condition == null && expressionToIsl(rule.action) === 'deny',
  );
  return ownerAllow && defaultDeny;
}

function annotationValue(field: Field, name: string): string | undefined {
  const value = field.annotations?.find((a) => idOf(a.name) === name)?.value;
  if (!value) return undefined;
  const text = expressionToIsl(value);
  return text.startsWith('"') ? text.slice(1, -1) : text;
}

function miniAnnotations(field: Field): string {
  const names = (field.annotations ?? [])
    .map((a) => idOf(a.name))
    .filter((n) => MINI_ANNOTATIONS.has(n));
  const ai = annotationValue(field, 'ai');
  const parts = names.map((n) => `[${n}]`);
  if (ai) parts.push(`[ai:${JSON.stringify(ai)}]`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

function renderField(
  field: Field,
  enums: Map<string, string[]>,
  unrepresented: string[],
  entityName: string,
): string | null {
  const name = idOf(field.name);
  if (INJECTED_FIELDS.has(name)) return null;

  const typeIsl = typeToIsl(field.type);
  const bare = typeIsl.replace(/\?$/, '');
  const optional = field.optional || typeIsl.endsWith('?');

  const variants = enums.get(bare);
  if (variants) {
    const terminal = annotationValue(field, 'terminal');
    const list = variants.map((v) => v.toLowerCase()).join(',');
    const suffix = terminal
      ? ` terminal:${terminal
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean)
          .join(',')}`
      : '';
    return `${name}:[${list}]${suffix}`;
  }

  const miniType = ISL_TO_MINI_TYPE[bare];
  if (!miniType) {
    unrepresented.push(`${entityName}.${name} has type ${bare}, which Mini cannot express.`);
    return null;
  }
  const annotations = miniAnnotations(field);
  if (miniType === 'string' && !optional && !annotations) return name;
  return `${name}:${miniType}${optional ? '?' : ''}${annotations}`;
}

function renderEntity(
  entity: Entity,
  enums: Map<string, string[]>,
  entityNames: Set<string>,
  unrepresented: string[],
): string | null {
  const name = idOf(entity.name);
  if (name === 'User') return null; // injected principal

  let owned = false;
  const refs: string[] = [];
  const fields: string[] = [];

  for (const field of entity.fields ?? []) {
    const fieldName = idOf(field.name);
    if (fieldName === 'ownerId') {
      owned = true;
      continue;
    }
    const target = referenceTarget(field);
    if (target && entityNames.has(target) && fieldName === `${camel(target)}Id`) {
      refs.push(target);
      continue;
    }
    const rendered = renderField(field, enums, unrepresented, name);
    if (rendered) fields.push(rendered);
  }

  const permissions: string[] = [];
  for (const rule of entity.permissions?.rules ?? []) {
    const terms = [
      ...(rule.allow?.roles ?? []).map((r) => idOf(r)),
      ...(rule.allow?.owner ? ['owner'] : []),
    ];
    if (rule.allow?.related?.length) {
      // `related(buyerId)` has no Mini spelling; say so instead of dropping the
      // rule and showing a narrower permission than the contract carries.
      unrepresented.push(
        `${name}.${rule.action} is also allowed for counterparties, which the short form cannot express.`,
      );
    }
    if (terms.length) permissions.push(`${rule.action}:${terms.join('|')}`);
  }

  const modifiers = [owned ? 'owned' : '', ...refs.map((r) => `->${r}`), ...permissions]
    .filter(Boolean)
    .join('  ');
  return `${name} { ${fields.join(', ')} }${modifiers ? `  ${modifiers}` : ''}`;
}

function renderView(view: View, unrepresented: string[]): string | null {
  const name = idOf(view.name);
  const forEntity = (asViewForEntity(view.forEntity)?.name?.parts ?? [])
    .map((p) => p.name)
    .join('.');
  const aggregates: string[] = [];
  let by: string | undefined;

  for (const field of view.fields ?? []) {
    const computation = expressionToIsl(field.computation);
    const group = computation.match(/^group\(([A-Za-z_]\w*)\.([A-Za-z_]\w*)\)$/);
    if (group) {
      by = group[2];
      continue;
    }
    // `count`, `sum`, `avg`, `min` and `max` are quantifier keywords in ISL, so
    // the parser lifts them into a QuantifierExpr whose canonical text carries a
    // synthesised lambda: `count(Appointment, _ => Appointment)`.
    const count = computation.match(/^count\([A-Za-z_]\w*(?:\s*,[^)]*)?\)$/);
    if (count) {
      aggregates.push('count');
      continue;
    }
    const agg = computation.match(
      /^(sum|avg|min|max)\([A-Za-z_]\w*\.([A-Za-z_]\w*)(?:\s*,[^)]*)?\)$/,
    );
    if (agg) {
      aggregates.push(`${agg[1]}(${agg[2]})`);
      continue;
    }
    unrepresented.push(`View ${name} computes ${computation}, which Mini cannot express.`);
  }

  if (!aggregates.length) return null;
  return `view ${name} = ${forEntity} ${aggregates.join(', ')}${by ? ` by ${by}` : ''}`;
}

/** Project a canonical contract back into Mini-ISL. */
export function renderMini(contract: AppContract): MiniRenderResult {
  return renderMiniFromDomain(contract.domain);
}

export function renderMiniFromDomain(domain: Domain): MiniRenderResult {
  const unrepresented: string[] = [];
  const enums = collectEnums(domain);
  const entityNames = new Set((domain.entities ?? []).map((e) => idOf(e.name)));
  const ownedEntities = new Set(
    (domain.entities ?? [])
      .filter((entity) => (entity.fields ?? []).some((field) => idOf(field.name) === 'ownerId'))
      .map((entity) => idOf(entity.name)),
  );

  const lines: string[] = [`app ${idOf(domain.name)}`, ''];

  const roles = (domain.roles?.roles ?? []).map((r) => idOf(r.name)).filter(Boolean);
  if (roles.length) lines.push(`roles ${roles.join(', ')}`, '');

  for (const entity of domain.entities ?? []) {
    const rendered = renderEntity(entity, enums, entityNames, unrepresented);
    if (rendered) lines.push(rendered);
  }

  const views = (domain.views ?? []).map((v) => renderView(v, unrepresented)).filter(Boolean);
  if (views.length) {
    lines.push('');
    for (const view of views) lines.push(view as string);
  }

  for (const invariant of domain.invariants ?? []) {
    unrepresented.push(`Rule “${idOf(invariant.name)}” is written directly in ISL.`);
  }
  for (const policy of domain.policies ?? []) {
    if (isProjectedOwnerPolicy(policy, ownedEntities)) continue;
    unrepresented.push(`Access policy “${idOf(policy.name)}” is written directly in ISL.`);
  }
  for (const behavior of domain.behaviors ?? []) {
    if ((behavior.preconditions ?? []).length) {
      unrepresented.push(
        `Action “${idOf(behavior.name)}” carries conditions written directly in ISL.`,
      );
    }
  }
  return { mini: `${lines.join('\n')}\n`, unrepresented };
}
