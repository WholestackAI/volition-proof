/**
 * App Contract copy of the ISL authorization-owner bind.
 *
 * `@wholestack/app-contract` may not depend on the typechecker. Keep this
 * reading identical to `@isl-lang/typechecker` `authorizationOwnerFieldName`
 * so a grant's `ownerField` is the same column RLS and the FK use.
 */
import type { Entity, Field } from '@isl-lang/parser';

export const AUTHORIZATION_OWNER_FIELD = 'owner_user_id';

const PRINCIPAL_ENTITY_NAMES = new Set(['user', 'account', 'actor', 'principal', 'person', 'identity']);

function compactFieldName(name: string): string {
  return name.replace(/_/g, '').toLowerCase();
}

function isCanonical(name: string): boolean {
  return compactFieldName(name) === 'owneruserid';
}

function isLegacy(name: string): boolean {
  const compact = compactFieldName(name);
  return compact === 'ownerid' || compact === 'userid';
}

function isPrincipal(name: string): boolean {
  return PRINCIPAL_ENTITY_NAMES.has(name.toLowerCase());
}

function expressionText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return undefined;
  const node = value as {
    value?: unknown;
    name?: string;
    parts?: { name?: string }[];
  };
  if (typeof node.value === 'string') return node.value;
  if (typeof node.name === 'string') return node.name;
  if (Array.isArray(node.parts) && node.parts.length > 0) {
    return node.parts.map((part) => part.name ?? '').filter(Boolean).join('.');
  }
  return undefined;
}

function fieldReferencesEntity(field: Field): string | undefined {
  for (const annotation of field.annotations ?? []) {
    if ((annotation.name?.name ?? '').toLowerCase() !== 'references') continue;
    const text = expressionText(annotation.value)?.trim();
    if (!text) continue;
    const entity = text.split('.')[0]?.trim();
    if (entity) return entity;
  }
  return undefined;
}

function rank(name: string): number {
  const compact = compactFieldName(name);
  if (compact === 'owneruserid') return 0;
  if (compact === 'ownerid') return 1;
  if (compact === 'userid') return 2;
  return 9;
}

/** The column `owner` binds to. Null when the grant has no principal column. */
export function resolveAuthorizationOwnerField(entity: Entity): string | null {
  const candidates: string[] = [];
  for (const field of entity.fields ?? []) {
    const name = field.name?.name ?? '';
    if (!name) continue;
    if (isCanonical(name)) {
      candidates.push(name);
      continue;
    }
    if (!isLegacy(name)) continue;
    const target = fieldReferencesEntity(field);
    if (target && isPrincipal(target)) candidates.push(name);
  }
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => {
    const byRank = rank(left) - rank(right);
    if (byRank !== 0) return byRank;
    return left.localeCompare(right);
  });
  return candidates[0] ?? null;
}
