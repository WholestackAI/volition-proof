/**
 * The typed semantic payload — what a clause MEANS, as data.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Until now a clause's entire semantic content was one string, `islExcerpt`.
 * `semanticNormalForm` hashed `{id, kind, isl}`; `diffContracts` compared that
 * string and nothing else. For seven of the nineteen clause kinds the projector
 * had nowhere structured to put the meaning, so it wrote the construct's NAME —
 * `policy lead_visibility`, `invariant SpendCap`, `view RevenueByMonth`. For
 * those kinds the clause sat outside the trust boundary entirely.
 *
 * Measured consequences, every one reproduced against real fixtures:
 *
 *   - inverting an access policy from owner-scoped to public → identical hash,
 *     and `diffContracts` reports {added:0, removed:0, modified:0}
 *   - negating a spend guard, `spentCents <= capCents` → `>=` → identical hash
 *     (248 entity invariants across the corpus produce 0 clauses)
 *   - `requires authenticated` → `requires anonymous` → identical hash
 *   - deleting an entire event + handler + workflow block → 228 clauses before,
 *     228 after, identical hash
 *   - a view measure `sum(amount)` → `count(*)` → identical hash
 *
 * The rule this module exists to enforce:
 *
 *   > If changing something can alter application behavior, that thing must
 *   > exist in the canonical semantic object.
 *
 * `islExcerpt` survives, for display and for the Code lens. It is no longer
 * truth. Truth is {@link ClauseSemantic}.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE IS AND IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * It is the TYPES plus the few normalization primitives that carry real logic
 * (numeric literals, sets, comparison orientation, a total expression order).
 * Projection from the AST and the normal form itself are separate modules, so
 * this one stays pure and cheap to reason about.
 *
 * It deliberately does NOT attempt general expression equivalence. Orienting a
 * mirrored comparison is decidable and sound; proving `a*2 == a+a` is not, and
 * a normalizer that tries trades loud false positives for silent false
 * negatives — the strictly worse failure for a security-relevant hash.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE THINGS THE INVENTORY FORCED INTO THE DESIGN
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. NUMBERS KEEP THEIR WRITTEN FORM. `20000` and `20000.00` are the same
 *    number and a different claim: against a column held in minor units the
 *    first is $200 and the second is almost certainly $20,000. The parse cannot
 *    distinguish them — only the source text can — so the source text is what
 *    is carried and hashed. A payload storing a bare `number` inherits the
 *    exact blindness this replaces.
 *
 * 2. GAPS ARE RECORDED, NOT OMITTED. An absent field is ambiguous between "the
 *    author did not say" and "the language cannot say", and those are different
 *    facts — one is a choice, the other is a hole. {@link ProjectionGap} makes
 *    the second explicit and hashable, so a screen block that exists in the AST
 *    and reaches no clause stops being invisible, and closing a grammar gap
 *    later is a visible change rather than a silent one.
 *
 * 3. UNREPRESENTED EXPRESSION NODES ARE A VARIANT, NOT A FALLBACK STRING. The
 *    old renderer had a `default:` branch returning `[NodeKind]`, which
 *    collapses whole classes of node onto one token. Here that is
 *    `{node:'unrepresented', astKind}` — greppable, countable, and impossible
 *    to mistake for a real comparison.
 */
import type { ClauseKind } from './types.js';

export { CLAUSE_KINDS } from './types.js';

/**
 * Bumped whenever the payload's SHAPE changes.
 *
 * Certificates and lockfiles record it, so anything sealed under an older
 * version is reported STALE — needs re-proof — rather than FAILING or, worse,
 * being silently trusted. `lockfile.ts` already checks the contract schema
 * version before comparing hashes, which is the hook this rides on.
 */
export const SEMANTIC_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * A numeric literal, carried as written.
 *
 * `value` is `null` when the text does not parse as a finite decimal. That is
 * deliberate: `1e3` currently lexes as `1` plus a stray identifier with no
 * diagnostic, and a payload that quietly stored `0` or `1000` would be
 * inventing a threshold nobody wrote.
 */
export interface NumericValue {
  /** The literal exactly as it appeared in source. This is what gets hashed. */
  written: string;
  /** Parsed value for arithmetic readers, or `null` when unparseable. */
  value: number | null;
}

const DECIMAL = /^-?\d+(?:\.\d+)?$/;

export function numeric(written: string): NumericValue {
  const trimmed = written.trim();
  if (!DECIMAL.test(trimmed)) return { written, value: null };
  const parsed = Number(trimmed);
  return { written, value: Number.isFinite(parsed) ? parsed : null };
}

/**
 * Sort and dedupe — for genuinely set-valued things: roles, annotations, enum
 * variants, refs.
 *
 * Codepoint order, never `localeCompare`. `localeCompare` without an explicit
 * locale resolves against host ICU and is not byte-stable across ICU versions,
 * which would make the hash depend on the machine that computed it. (The
 * existing `fixedPointHash` in the ISL package has this bug; do not copy it.)
 *
 * Use this ONLY where order is not meaning. Lifecycle transitions, argument
 * lists and section ordering are ordered; sorting them would erase a fact.
 */
export function sortedSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type CompareOp = '==' | '!=' | '<' | '<=' | '>' | '>=';

/** Mirror table. `a < b` is `b > a`; equality and inequality are symmetric. */
const MIRRORED: Record<CompareOp, CompareOp> = {
  '<': '>',
  '>': '<',
  '<=': '>=',
  '>=': '<=',
  '==': '==',
  '!=': '!=',
};

export type NormalizedExpression =
  | { node: 'string'; value: string }
  | { node: 'boolean'; value: boolean }
  | { node: 'null' }
  | { node: 'number'; number: NumericValue }
  /** A path: `row.ownerId` is `['row','ownerId']`, `ctx.userId` is `['ctx','userId']`. */
  | { node: 'ref'; path: readonly string[] }
  | { node: 'compare'; op: CompareOp; left: NormalizedExpression; right: NormalizedExpression }
  /** Commutative — `operands` is sorted by {@link compareExpressions}. */
  | { node: 'logical'; op: 'and' | 'or'; operands: readonly NormalizedExpression[] }
  | { node: 'not'; operand: NormalizedExpression }
  /** `sum(x)`, `count(x)`, `length(x)`. Argument order is meaning; not sorted. */
  | { node: 'call'; fn: string; args: readonly NormalizedExpression[] }
  /** A literal list. Order preserved — `in [A, B]` and `in [B, A]` may differ. */
  | { node: 'list'; items: readonly NormalizedExpression[] }
  /**
   * An AST node this projection cannot yet carry.
   *
   * A variant rather than a fallback string, so it is greppable, countable, and
   * can never be mistaken for a comparison that was understood.
   */
  | { node: 'unrepresented'; astKind: string };

/**
 * Rank by node type first, so the total order never compares apples to pears.
 *
 * `ref` deliberately outranks the literals. That makes the field the canonical
 * LEFT operand, so `amountCents > 20000` is the normal form and
 * `20000 < amountCents` mirrors onto it — matching the convention the money
 * analyzer already uses, and keeping the normalized form readable rather than
 * inverted. Any total order would hash correctly; this one also reads right.
 */
const NODE_RANK: Record<NormalizedExpression['node'], number> = {
  null: 0,
  boolean: 1,
  ref: 2,
  number: 3,
  string: 4,
  call: 5,
  list: 6,
  not: 7,
  compare: 8,
  logical: 9,
  unrepresented: 10,
};

function cmp(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * A total, deterministic order over expressions.
 *
 * Needed for two jobs: sorting the operands of a commutative `and`/`or`, and
 * deciding which side of a comparison is canonically the left. It must be total
 * — a partial order would make the result depend on input order, which is the
 * whole thing being fixed.
 */
export function compareExpressions(a: NormalizedExpression, b: NormalizedExpression): number {
  const rank = NODE_RANK[a.node] - NODE_RANK[b.node];
  if (rank !== 0) return Math.sign(rank);

  switch (a.node) {
    case 'null':
      return 0;
    case 'boolean':
      return cmp(String(a.value), String((b as typeof a).value));
    case 'number':
      return cmp(a.number.written, (b as typeof a).number.written);
    case 'string':
      return cmp(a.value, (b as typeof a).value);
    case 'ref':
      return cmp(a.path.join('.'), (b as typeof a).path.join('.'));
    case 'unrepresented':
      return cmp(a.astKind, (b as typeof a).astKind);
    case 'not':
      return compareExpressions(a.operand, (b as typeof a).operand);
    case 'call': {
      const other = b as typeof a;
      return cmp(a.fn, other.fn) || compareList(a.args, other.args);
    }
    case 'list':
      return compareList(a.items, (b as typeof a).items);
    case 'compare': {
      const other = b as typeof a;
      return (
        cmp(a.op, other.op) ||
        compareExpressions(a.left, other.left) ||
        compareExpressions(a.right, other.right)
      );
    }
    case 'logical': {
      const other = b as typeof a;
      return cmp(a.op, other.op) || compareList(a.operands, other.operands);
    }
  }
}

function compareList(
  a: readonly NormalizedExpression[],
  b: readonly NormalizedExpression[],
): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const step = compareExpressions(a[index]!, b[index]!);
    if (step !== 0) return step;
  }
  return a.length - b.length;
}

/**
 * Put a comparison in canonical orientation.
 *
 * `2000000 < Estimate.amountCents` and `Estimate.amountCents > 2000000` are one
 * rule, and an author writing the first should not produce a different hash
 * from an author writing the second. The smaller operand under
 * {@link compareExpressions} becomes the left; the operator mirrors with it.
 *
 * `>` and `>=` are NOT collapsed. They differ at exactly the boundary value,
 * which is the value business rules are written about.
 */
export function orientComparison(
  op: CompareOp,
  left: NormalizedExpression,
  right: NormalizedExpression,
): Extract<NormalizedExpression, { node: 'compare' }> {
  return compareExpressions(left, right) <= 0
    ? { node: 'compare', op, left, right }
    : { node: 'compare', op: MIRRORED[op], left: right, right: left };
}

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------

/**
 * Something the AST held, or the language should hold, that this clause could
 * not carry.
 *
 * Recorded and hashed, because silence is indistinguishable from absence. A
 * screen block that parses fully and reaches no clause is a gap; a view filter
 * the grammar rejects outright is a different gap; conflating them hides which
 * one a fix belongs to.
 */
export interface ProjectionGap {
  /** Dotted construct path, e.g. `view.filter`, `screen`, `behavior.effects`. */
  construct: string;
  /**
   * `not-in-grammar` — the language cannot express it; fixing needs parser work.
   * `not-projected` — the AST holds it and the projector drops it.
   */
  reason: 'not-in-grammar' | 'not-projected';
  detail?: string;
}

// ---------------------------------------------------------------------------
// Per-kind payloads
// ---------------------------------------------------------------------------

interface SemanticBase {
  /** Constructs this clause could not carry. Sorted by `construct`. */
  gaps: readonly ProjectionGap[];
}

/** Where an access decision draws its line. */
export type AccessScope = 'owner' | 'role' | 'tenant' | 'related' | 'public' | 'unspecified';

export type ClauseSemantic =
  | (SemanticBase & { kind: 'app'; name: string; version: string; tenancy: string | null })
  | (SemanticBase & { kind: 'role'; role: string })
  | (SemanticBase & { kind: 'entity'; entity: string; annotations: readonly string[] })
  | (SemanticBase & {
      kind: 'field';
      entity: string;
      field: string;
      type: string;
      /** Generic arguments, e.g. `Money<USD>` → `['USD']`. Empty when none. */
      typeArguments: readonly string[];
      optional: boolean;
      annotations: readonly { name: string; value: string | null }[];
      constraints: readonly { name: string; value: string }[];
      defaultValue: NormalizedExpression | null;
      computedAs: NormalizedExpression | null;
    })
  | (SemanticBase & {
      kind: 'relationship';
      fromEntity: string;
      fromField: string;
      toEntity: string;
      toColumn: string | null;
      onDelete: string | null;
      cardinality:
        | 'one'
        | 'many'
        | 'unspecified'
        | 'one_to_one'
        | 'one_to_many'
        | 'many_to_one'
        | 'many_to_many';
      name?: string;
      associationEntity?: string | null;
    })
  | (SemanticBase & {
      kind: 'status-set';
      entity: string;
      field: string;
      /** Declaration order is meaning here — it is the reading order of a lifecycle. */
      states: readonly string[];
      initial: string | null;
      terminal: readonly string[];
    })
  | (SemanticBase & {
      kind: 'transition';
      entity: string;
      statusField: string | null;
      from: string;
      to: string;
      command: string | null;
      principals: readonly string[];
      guard: NormalizedExpression | null;
      forbidden?: boolean;
    })
  | (SemanticBase & { kind: 'audit'; entity: string })
  | (SemanticBase & {
      kind: 'permission';
      entity: string;
      action: string;
      roles: readonly string[];
      owner: boolean;
      ownerField: string | null;
      related: readonly string[];
      tenant?: boolean;
      none?: boolean;
    })
  | (SemanticBase & {
      kind: 'behavior';
      behavior: string;
      inputs: readonly { name: string; type: string; optional: boolean }[];
      output: string | null;
      errors: readonly { code: string; retriable: boolean }[];
      /** Declared effects. Empty plus a `behavior.effects` gap ≠ "no effects". */
      effects: readonly BehaviorEffect[];
    })
  | (SemanticBase & { kind: 'precondition'; behavior: string; predicate: NormalizedExpression })
  | (SemanticBase & {
      kind: 'postcondition';
      behavior: string;
      condition: string;
      predicate: NormalizedExpression;
    })
  | (SemanticBase & {
      kind: 'behavior-security';
      behavior: string;
      /** `requires` | `rate_limit` | `fraud_check` — a gate and a throttle differ. */
      requirementType: string;
      requirement: NormalizedExpression;
    })
  | (SemanticBase & {
      kind: 'invariant';
      /** The entity it constrains, or `null` for a domain-level block. */
      entity: string | null;
      name: string | null;
      scope: 'global' | 'transaction' | 'unspecified';
      predicates: readonly NormalizedExpression[];
    })
  | (SemanticBase & {
      kind: 'policy';
      policy: string;
      /** `null` means the policy applies to everything — a widening, not an absence. */
      appliesTo: string | null;
      rules: readonly { condition: NormalizedExpression | null; effect: 'allow' | 'deny' }[];
      otherwise: 'allow' | 'deny' | 'unspecified';
      scope: AccessScope;
    })
  | (SemanticBase & {
      kind: 'view';
      view: string;
      forEntity: string | null;
      measures: readonly {
        name: string;
        fn: string | null;
        over: string | null;
        type: string | null;
      }[];
      groupBy: readonly string[];
      cacheTtlSeconds: number | null;
      consistency: string | null;
      display: string | null;
    })
  | (SemanticBase & {
      kind: 'aggregate';
      aggregate: string;
      forEntity: string | null;
      measures: readonly { fn: string; over: string | null }[];
      groupBy: readonly string[];
      filter: NormalizedExpression | null;
    })
  | (SemanticBase & {
      kind: 'integration';
      provider: string;
      integrationType?: string;
      direction?: string;
      capability?: string;
      requires?: readonly string[];
      event?: string;
      action?: string;
    })
  | (SemanticBase & { kind: 'auth-provider'; provider: string })
  | (SemanticBase & {
      kind: 'screen';
      screen: string;
      route: string | null;
      layout: string | null;
      components: readonly {
        name: string;
        type: string | null;
        entity: string | null;
        behavior: string | null;
      }[];
      audience?: string;
      authentication?: string;
      visibility?: string;
      contextEntity?: string;
      allowedActions?: readonly string[];
    })
  | (SemanticBase & {
      kind: 'query';
      query: string;
      forEntity: string | null;
      filter: NormalizedExpression | null;
      filterBy: readonly string[];
    })
  | (SemanticBase & {
      kind: 'job';
      job: string;
      forEntity: string | null;
      schedule: string;
      cadence: string | null;
      action: string | null;
    })
  | (SemanticBase & {
      kind: 'notification';
      notification: string;
      forEntity: string | null;
      to: string;
      event: string | null;
    })
  | (SemanticBase & {
      kind: 'compliance';
      standard?: string | null;
      requirement?: string | null;
      control?: string | null;
      description?: string | null;
    })
  | (SemanticBase & {
      kind: 'temporal';
      condition?: string | null;
      duration?: string | null;
      schedule?: string | null;
      description?: string | null;
    });

/**
 * What a command does.
 *
 * The ISL grammar has no `effects` node today — `Behavior` carries none, and
 * the only authorable effect is a `[setField: "status = 'X'"]` annotation whose
 * payload is an opaque string re-parsed downstream by two independent regex
 * mini-parsers. The type exists now so the grammar work has somewhere to lower
 * into, and so a behavior with no declared effects is distinguishable from one
 * whose effects the language could not express — the latter carries a
 * `behavior.effects` gap.
 */
export type BehaviorEffect =
  | { effect: 'create-entity'; entity: string }
  | { effect: 'update-field'; entity: string; field: string; to: NormalizedExpression }
  | { effect: 'transition-state'; entity: string; field: string; to: string }
  | { effect: 'emit-event'; event: string }
  | { effect: 'unrepresented'; source: string };

/**
 * The payload variant a clause kind maps to.
 *
 * One-to-one today. It exists as a function rather than an inline cast so the
 * "every kind has a variant" test has something total to check — a kind added
 * to `CLAUSE_KINDS` without a payload must fail loudly rather than silently
 * falling back to prose, which is the failure mode this whole module replaces.
 */
export function semanticKindOf(kind: ClauseKind): ClauseSemantic['kind'] {
  return kind;
}
