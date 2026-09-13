/**
 * Semantic normal form.
 *
 * Two contracts are *semantically* equal when they carry the same set of
 * clauses with the same meaning, regardless of declaration order, indentation,
 * or whitespace. `contractHash` is the digest of that normal form, so a reformat
 * is provably a no-op and a real change is provably not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE CHANGED
 * ─────────────────────────────────────────────────────────────────────────────
 * It used to hash `{id, kind, isl: collapse(islExcerpt)}` — one rendered string
 * per clause. For seven of the nineteen clause kinds the projector had nowhere
 * structured to put the meaning, so it wrote the construct's NAME. Measured
 * consequences of that, all reproduced against real fixtures:
 *
 *   - inverting an access policy from owner-scoped to public: identical hash
 *   - negating a spend guard, `spentCents <= capCents` → `>=`: identical hash
 *   - deleting `auth: authenticated` from a DELETE endpoint: identical hash
 *
 * Hashing text also failed in the OTHER direction, which matters just as much:
 * `collapse()` normalises whitespace INSIDE string literals, so `default: "a b"`
 * and `default: "a  b"` were one hash; while reordering field annotations or
 * enum variants MOVED the hash for no semantic change at all.
 *
 * So the unit of hashing is now `Clause.semantic` — a typed payload — and
 * `islExcerpt` is display only.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FALLBACK IS A MIGRATION STATE, NOT A DESIGN
 * ─────────────────────────────────────────────────────────────────────────────
 * A clause with no payload still hashes its `islExcerpt`, so the projector can
 * migrate one kind at a time without the hash going undefined in between. Every
 * kind that gains a payload is strictly less blind than it was; none regresses.
 * When the last kind lands, `Clause.semantic` becomes required and this branch
 * is deleted. {@link unmigratedKinds} exists so a test can ratchet that down to
 * zero rather than leaving it to memory.
 */

import { sha256Hex } from './hash.js';
import type { Clause, ClauseKind } from './types.js';

export interface SemanticNormalForm {
  schemaVersion: string;
  app: string;
  clauses: NormalizedClause[];
}

interface NormalizedClause {
  id: string;
  kind: string;
  /** Rendered payload when the clause has one; otherwise the legacy excerpt. */
  semantic: string;
  /** True while this clause is still hashing its excerpt. Migration telemetry. */
  legacy: boolean;
}

export function semanticNormalForm(
  appName: string,
  clauses: Clause[],
  schemaVersion: string,
): SemanticNormalForm {
  const normalized = clauses
    .map((clause) => ({
      id: clause.id,
      kind: clause.kind,
      semantic: clause.semantic ? canonicalStringify(clause.semantic) : collapse(clause.islExcerpt),
      legacy: clause.semantic === undefined,
    }))
    // Codepoint order, never `localeCompare` — that resolves against host ICU
    // and is not byte-stable across ICU versions, which would make the hash
    // depend on the machine that computed it.
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { schemaVersion, app: appName, clauses: normalized };
}

/** Kinds still hashing their excerpt. Ratchet this to empty; never let it grow. */
export function unmigratedKinds(clauses: Clause[]): ClauseKind[] {
  const kinds = new Set<ClauseKind>();
  for (const clause of clauses) if (clause.semantic === undefined) kinds.add(clause.kind);
  return [...kinds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Whitespace-insensitive clause text — the LEGACY unit of comparison.
 *
 * Retained only for unmigrated kinds. Note what it does wrong, since it is the
 * reason the payload exists: it collapses whitespace inside string literals
 * too, so three distinct default values can share one hash.
 */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Deterministic JSON: keys sorted recursively, `undefined` serialized as `null`.
 *
 * Byte-identical to `canonicalStringify` in `@wholestack/contracts`, which is
 * the shared implementation this SHOULD import. It is duplicated here only
 * because `@wholestack/app-contract` does not yet depend on that package, and
 * adding a workspace dependency rewrites `pnpm-lock.yaml` — which is not a safe
 * thing to do while other sessions are working in this checkout.
 *
 * That package's own header warns that "four independent copies of canonical
 * JSON is how two packages end up disagreeing about the hash of the same
 * object", and this is a fifth. Replace it with the import as soon as the
 * dependency can be added; keeping the bytes identical is what makes that swap
 * a no-op rather than a hash break.
 *
 * `undefined` → `null` matters: an absent optional field must serialize the
 * same way every time, or a payload's hash depends on how it was constructed.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return (JSON.stringify(value) as string | undefined) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${(value as unknown[]).map(canonicalStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
    .join(',')}}`;
}

/** Deterministic serialization of the whole normal form. */
export function stableStringify(value: SemanticNormalForm): string {
  return canonicalStringify(value);
}

export function hashNormalForm(form: SemanticNormalForm): string {
  return `sha256:${sha256Hex(stableStringify(form))}`;
}
