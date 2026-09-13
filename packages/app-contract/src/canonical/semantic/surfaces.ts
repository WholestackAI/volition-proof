/**
 * Group D — surfaces: `view`, `aggregate`, `integration`, `auth-provider`, `screen`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE DIFFERENT FAILURES LIVE IN THIS FILE. THEY ARE NOT THE SAME FAILURE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. `view` and `aggregate` are PROJECTOR failures. The AST is rich and the old
 *    clause threw it away. `view` hashed its NAME and nothing else, so
 *    `sum(Estimate.amountCents)` → `count(Estimate)` produced an identical hash
 *    AND zero projection delta — the measure function appeared nowhere in the
 *    clause. `aggregate` was worse: a bare name with `refs: []` and no `detail`,
 *    so `for:`, the measures, `group_by` and `filter` were all invisible.
 *    Everything the AST holds is carried here.
 *
 * 2. `integration` and `auth-provider` are GRAMMAR failures. `ProviderDecl`
 *    (`ast.ts:237`) has exactly ONE member — `name`. There is no config, no
 *    scopes, no version, no operations, no env binding to project. Nothing was
 *    discarded; the language holds nothing to discard. Two apps with completely
 *    different Stripe wiring are byte-identical here and no amount of projector
 *    work changes that. What this module can do is say so, with
 *    `not-in-grammar` gaps, so closing the grammar hole later is a VISIBLE
 *    change rather than a silent one.
 *
 * 3. `screen` had NO PROJECTOR AT ALL. `'screen'` is in `CLAUSE_KINDS` and
 *    `impact.ts:91` carries a `case 'screen'` that is unreachable by
 *    construction, while the parser fills route, layout, components (with
 *    type/entity/behavior), field validation and navigation. Deleting an entire
 *    screen block was invisible; so was renaming one. This is pure projector
 *    work against an AST that was already rich.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * JUDGEMENT CALLS, AND WHY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * MEASURES vs DIMENSIONS. A `ViewField` whose computation is `group(X)` is a
 * GROUP BY dimension, not a measure — it decides how many rows come back, while
 * a measure decides what each row contains. Mixing them would make
 * `group(Lead.source)` → `count(Lead.source)` look like a measure edit when it
 * actually turns a pivot table into a single stat. They are split.
 *
 * DIMENSION ENCODING. `groupBy` is `readonly string[]`, but a view dimension is
 * three facts, not one: an output alias, a declared type and the grouped
 * expression (`source: LeadSource = group(Lead.source)`). Carrying only the
 * expression would make renaming the generated column invisible; carrying only
 * the alias would make regrouping invisible. Each entry is therefore written
 * `alias: Type = expression` — the same shape SQL uses for a GROUP BY select
 * item, and lossless. An `aggregate` dimension has no alias or type in the
 * grammar (`group_by: status`), so it stays a bare name.
 *
 * MEASURE ORDER IS KEPT, NOT SORTED. Measure order is the column order of the
 * generated table and the card order of the generated stat row, so it is
 * meaning; `sortedSet` would erase it. Only genuinely set-valued things get
 * sorted, and nothing in this file is set-valued except the gap list, which is
 * sorted by `construct` for stability.
 *
 * COMPONENT ORDER IS KEPT for the same reason: it is the render order down the
 * page.
 *
 * PROVIDER ORDER. It IS meaning for `auth` — the declaration order is the order
 * of the sign-in buttons, and which provider a user reaches for first is a
 * product decision. It is NOT meaning for `integrations`, where the services are
 * a set and wiring order has no user-visible effect. A per-provider payload
 * cannot carry a position, so `auth-provider` records an `auth-provider.order`
 * gap and `integration` does not. Duplicate declarations collapse under id
 * dedup, which is correct for both: you cannot sign in with Google twice.
 *
 * NUMBERS. `numeric()` keeps the written form, but the parser has already thrown
 * it away — `NumberLiteral` (`ast.ts:648`) carries `value: number` plus
 * `isFloat: boolean` and no source text, so `20000.00` and `20000.0` arrive
 * identical. The int/decimal distinction survives and is preserved; trailing
 * zeros do not, and a filter containing a number literal records that as a gap
 * rather than pretending otherwise.
 *
 * Pure: no fs, no clock, no randomness, no network.
 */

import type {
  Aggregate,
  ComponentDecl,
  ConsistencySpec,
  Expression,
  JobDecl,
  NotificationDecl,
  ProviderDecl,
  QueryDecl,
  ScreenDecl,
  TypeDefinition,
  View,
  ViewField,
} from '@isl-lang/parser';

import { expressionToIsl } from '../expression.js';
import {
  compareExpressions,
  numeric,
  orientComparison,
  type ClauseSemantic,
  type CompareOp,
  type NormalizedExpression,
  type ProjectionGap,
} from '../semantic.js';

export type ViewSemantic = Extract<ClauseSemantic, { kind: 'view' }>;
export type AggregateSemantic = Extract<ClauseSemantic, { kind: 'aggregate' }>;
export type QuerySemantic = Extract<ClauseSemantic, { kind: 'query' }>;
export type JobSemantic = Extract<ClauseSemantic, { kind: 'job' }>;
export type NotificationSemantic = Extract<ClauseSemantic, { kind: 'notification' }>;
export type IntegrationSemantic = Extract<ClauseSemantic, { kind: 'integration' }>;
export type AuthProviderSemantic = Extract<ClauseSemantic, { kind: 'auth-provider' }>;
export type ScreenSemantic = Extract<ClauseSemantic, { kind: 'screen' }>;

/**
 * How an aggregate `filter:` becomes a {@link NormalizedExpression}.
 *
 * The real normalizer belongs to `semantic/behavior.ts`, which owns predicates
 * for preconditions, postconditions, invariants and policies. Passing it in
 * keeps exactly one normalizer in the system.
 */
export interface SurfaceOptions {
  normalizeExpression?: (expression: Expression) => NormalizedExpression;
}

// ---------------------------------------------------------------------------
// Small shared readers
// ---------------------------------------------------------------------------

type Node = Record<string, unknown>;

function asNode(value: unknown): Node {
  return value as Node;
}

function asNodeOrUndefined(value: unknown): Node | undefined {
  return value == null ? undefined : asNode(value);
}

function asUnknownArray(value: unknown): unknown[] | undefined {
  return value as unknown[] | undefined;
}

function identifierName(node: { name?: string } | undefined): string | null {
  const name = node?.name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

/** Dotted name behind a `ReferenceType` (`for: Sales.Lead` → `Sales.Lead`). */
function referenceName(reference: unknown): string | null {
  const parts = ((reference as Node | undefined)?.name as Node | undefined)?.parts as
    { name: string }[] | undefined;
  const names = (parts ?? []).map((part) => part.name).filter(Boolean);
  return names.length > 0 ? names.join('.') : null;
}

/**
 * The dotted path behind an expression, when it IS a path.
 *
 * `Estimate.amountCents` is a column; `amountCents * 2` is not, and returning
 * null rather than a rendered approximation is what keeps the two apart.
 */
function pathOf(expression: Expression | undefined): string[] | null {
  if (!expression || typeof expression !== 'object') return null;
  const node = asNode(expression);
  switch (node.kind) {
    case 'Identifier': {
      const name = identifierName(node as { name?: string });
      return name ? [name] : null;
    }
    case 'QualifiedName': {
      const parts = ((node.parts as { name: string }[]) ?? []).map((part) => part.name);
      return parts.length > 0 && parts.every(Boolean) ? parts : null;
    }
    case 'MemberExpr': {
      const object = pathOf(node.object as Expression);
      const property = identifierName(node.property as { name?: string });
      return object && property ? [...object, property] : null;
    }
    default:
      return null;
  }
}

/**
 * A column reference as text when the expression is a path, canonical ISL text
 * otherwise.
 *
 * `expressionToIsl` is the module that already owns deterministic ISL
 * rendering; a second renderer here would be a second thing to keep correct.
 */
function columnText(expression: Expression | undefined): string | null {
  if (!expression) return null;
  return pathOf(expression)?.join('.') ?? expressionToIsl(expression) ?? null;
}

/**
 * A view field's declared type as text.
 *
 * Deliberately narrow — a view field is a scalar column, so primitives,
 * enum/entity references, optionals and lists cover the grammar. An unhandled
 * type node yields its AST kind, which is greppable, rather than an empty
 * string, which would silently equal "no type".
 */
function typeName(type: TypeDefinition | undefined): string | null {
  if (!type || typeof type !== 'object') return null;
  const node = asNode(type);
  switch (node.kind) {
    case 'PrimitiveType':
      return typeof node.name === 'string' ? node.name : null;
    case 'ReferenceType':
      return referenceName(node);
    case 'OptionalType': {
      const inner = typeName(node.inner as TypeDefinition);
      return inner ? `${inner}?` : null;
    }
    case 'ListType': {
      const element = typeName(node.element as TypeDefinition);
      return element ? `List<${element}>` : null;
    }
    case 'ConstrainedType':
      // Constraints are recorded as a gap by the caller, not dropped silently.
      return typeName(node.base as TypeDefinition);
    default:
      return String(node.kind);
  }
}

const SECONDS_PER_UNIT: Record<string, number> = {
  ms: 1 / 1000,
  seconds: 1,
  minutes: 60,
  hours: 60 * 60,
  days: 24 * 60 * 60,
};

/**
 * A cache TTL in seconds.
 *
 * Normalised rather than kept as written, because the payload types it as a
 * number: `60s` and `1m` are one cache policy, and a diff that flagged them as
 * different would be a false positive. This is the opposite call from a
 * threshold literal, where the written form IS the claim.
 */
function durationSeconds(duration: unknown): number | null {
  const node = duration as Node | undefined;
  if (!node || typeof node.value !== 'number' || !Number.isFinite(node.value)) return null;
  const perUnit = SECONDS_PER_UNIT[String(node.unit)];
  return perUnit === undefined ? null : node.value * perUnit;
}

function sortGaps(gaps: ProjectionGap[]): ProjectionGap[] {
  return [...gaps].sort((left, right) =>
    left.construct < right.construct ? -1 : left.construct > right.construct ? 1 : 0,
  );
}

// ---------------------------------------------------------------------------
// The narrow local filter normalizer
// ---------------------------------------------------------------------------

const COMPARE_OPS = new Set<string>(['==', '!=', '<', '<=', '>', '>=']);

/**
 * The written form of a number literal, reconstructed as faithfully as the
 * parser allows.
 *
 * `NumberLiteral` keeps `value` and `isFloat` and discards the source text, so
 * `0` and `0.00` are distinguishable (int versus decimal) while `0.0` and
 * `0.00` are not. Rendering a float that lands on an integer as `0.0` preserves
 * the distinction that survived; collapsing both onto `0` would erase it, and
 * erasing it is the false negative the whole payload exists to prevent.
 */
function numberText(node: Node): string {
  const value = node.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  const rendered = String(value);
  return node.isFloat === true && !rendered.includes('.') ? `${rendered}.0` : rendered;
}

/** Flatten `a and (b and c)` so associativity is not a hash difference. */
function flatten(op: 'and' | 'or', expression: NormalizedExpression): NormalizedExpression[] {
  return expression.node === 'logical' && expression.op === op
    ? [...expression.operands]
    : [expression];
}

/**
 * TODO(P0.4): replace with `normalizeExpression` from `semantic/behavior.ts` and
 * delete this function. That module exists but its `normalizeExpression` is
 * still a red-phase stub returning `{node:'unrepresented', astKind:'TODO'}` for
 * every input, so importing it today would erase every aggregate filter. The
 * swap is one line at the call site once it is real: pass it in via
 * {@link SurfaceOptions.normalizeExpression}. This function exists ONLY so an
 * aggregate `filter:` is not dropped in the meantime.
 *
 * Deliberately narrow: comparisons, `and`/`or`, `not`, paths and literals —
 * which is the whole of what an aggregate filter is in the corpus. Arithmetic,
 * calls, quantifiers and everything else become `{node:'unrepresented'}` rather
 * than a rendered string, so this stub can never be mistaken for the real
 * normalizer or quietly outlive it.
 */
function narrowNormalize(expression: Expression | undefined): NormalizedExpression {
  if (!expression || typeof expression !== 'object')
    return { node: 'unrepresented', astKind: 'missing' };
  const node = asNode(expression);
  switch (node.kind) {
    case 'StringLiteral':
      return { node: 'string', value: String(node.value) };
    case 'BooleanLiteral':
      return { node: 'boolean', value: node.value === true };
    case 'NullLiteral':
      return { node: 'null' };
    case 'NumberLiteral':
      return { node: 'number', number: numeric(numberText(node)) };
    case 'Identifier':
    case 'QualifiedName':
    case 'MemberExpr': {
      const path = pathOf(expression);
      return path ? { node: 'ref', path } : { node: 'unrepresented', astKind: String(node.kind) };
    }
    case 'UnaryExpr':
      return node.operator === 'not'
        ? { node: 'not', operand: narrowNormalize(node.operand as Expression) }
        : { node: 'unrepresented', astKind: 'UnaryExpr' };
    case 'BinaryExpr': {
      const op = String(node.operator);
      const left = narrowNormalize(node.left as Expression);
      const right = narrowNormalize(node.right as Expression);
      if (COMPARE_OPS.has(op)) return orientComparison(op as CompareOp, left, right);
      if (op === 'and' || op === 'or') {
        const operands = [...flatten(op, left), ...flatten(op, right)].sort(compareExpressions);
        return { node: 'logical', op, operands };
      }
      return { node: 'unrepresented', astKind: 'BinaryExpr' };
    }
    default:
      return { node: 'unrepresented', astKind: String(node.kind) };
  }
}

/** True when any node under this expression is a number literal. */
function containsNumberLiteral(expression: Expression | undefined): boolean {
  if (!expression || typeof expression !== 'object') return false;
  const node = asNode(expression);
  if (node.kind === 'NumberLiteral') return true;
  return Object.entries(node).some(([key, value]) => {
    if (key === 'location' || key === 'kind') return false;
    if (Array.isArray(value))
      return value.some((item) => containsNumberLiteral(item as Expression));
    return (
      typeof value === 'object' && value !== null && containsNumberLiteral(value as Expression)
    );
  });
}

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

type Computation =
  | { role: 'dimension'; over: string | null }
  | { role: 'measure'; fn: string | null; over: string | null };

/**
 * Classify a view field's computation.
 *
 * `group(X)` lexes as a `CallExpr`; `count(X)` and `sum(X)` lex as a
 * `QuantifierExpr` (`quantifier` is the function name); `avg`/`min`/`max` are
 * not quantifier keywords and lex as a `CallExpr`. All three shapes carry the
 * same meaning and all three are read here — reading only one is how the
 * measure function stayed invisible.
 */
function classify(computation: Expression | undefined): Computation {
  if (!computation || typeof computation !== 'object')
    return { role: 'measure', fn: null, over: null };
  const node = asNode(computation);

  if (node.kind === 'CallExpr') {
    const fn = identifierName(node.callee as { name?: string });
    const args = (node.arguments as Expression[]) ?? [];
    const over =
      args.length === 1
        ? columnText(args[0])
        : args.length === 0
          ? null
          : args.map(columnText).join(', ');
    if (fn === 'group') return { role: 'dimension', over };
    return { role: 'measure', fn, over };
  }

  if (node.kind === 'QuantifierExpr') {
    const collection = node.collection as Expression;
    const predicate = node.predicate as Expression;
    // The simple form `sum(x)` sets predicate === collection. The lambda form
    // `all(xs, x => p)` does not, and its predicate is meaning, so the whole
    // expression is carried rather than just the collection.
    const simple = expressionToIsl(collection) === expressionToIsl(predicate);
    return {
      role: 'measure',
      fn: String(node.quantifier),
      over: simple ? columnText(collection) : expressionToIsl(computation),
    };
  }

  // A plain computed column, e.g. `total: Int = amountCents * 2`. There is no
  // measure function; the expression itself is what the column means.
  return { role: 'measure', fn: null, over: expressionToIsl(computation) };
}

function consistencyText(consistency: ConsistencySpec | undefined): string | null {
  const node = asNodeOrUndefined(consistency);
  const mode = typeof node?.mode === 'string' ? node.mode : null;
  if (!mode) return null;
  const bound = node?.maxDelay as Node | undefined;
  // `eventual within 5s` is one statement about staleness, not two, so the
  // bound rides with the mode. `strongly_consistent: [...]` is a separate
  // member and gets a gap instead.
  return bound ? `${mode} within ${bound.value}.${bound.unit}` : mode;
}

function hasConstrainedType(type: TypeDefinition | undefined): boolean {
  const node = asNodeOrUndefined(type);
  if (!node) return false;
  if (node.kind === 'ConstrainedType') return true;
  if (node.kind === 'OptionalType') return hasConstrainedType(node.inner as TypeDefinition);
  if (node.kind === 'ListType') return hasConstrainedType(node.element as TypeDefinition);
  return false;
}

export function viewSemantic(view: View): ViewSemantic {
  const gaps: ProjectionGap[] = [
    {
      construct: 'view.filter',
      reason: 'not-in-grammar',
      detail:
        'the parser rejects a `filter:` member of a view (P001), so a view cannot restrict its rows',
    },
    {
      construct: 'view.sort',
      reason: 'not-in-grammar',
      detail:
        'the parser rejects a `sort:` member of a view (P001), so result ordering is codegen-defined',
    },
    {
      construct: 'view.limit',
      reason: 'not-in-grammar',
      detail: 'the parser rejects a `limit:` member of a view (P001), so a view cannot paginate',
    },
  ];

  const measures: { name: string; fn: string | null; over: string | null; type: string | null }[] =
    [];
  const groupBy: string[] = [];

  for (const field of (view.fields ?? []) as ViewField[]) {
    const name = identifierName(field.name) ?? '';
    const type = typeName(field.type);
    const computation = classify(field.computation);

    if (hasConstrainedType(field.type)) {
      gaps.push({
        construct: `view.field.${name}.type.constraints`,
        reason: 'not-projected',
        detail:
          'the payload carries a type name, so a refinement such as `Int { min: 0 }` is not carried',
      });
    }

    if (computation.role === 'dimension') {
      // `alias: Type = expression` — see the module header. All three facts are
      // load-bearing and `groupBy` is a string list, so all three are written.
      const label = type ? `${name}: ${type}` : name;
      groupBy.push(computation.over === null ? label : `${label} = ${computation.over}`);
      continue;
    }
    measures.push({ name, fn: computation.fn, over: computation.over, type });
  }

  const cache = asNodeOrUndefined(view.cache);
  const invalidateOn = asUnknownArray(cache?.invalidateOn) ?? [];
  if (invalidateOn.length > 0) {
    gaps.push({
      construct: 'view.cache.invalidateOn',
      reason: 'not-projected',
      detail: `${invalidateOn.length} cache invalidation expression(s) are declared and not carried`,
    });
  }

  const strongFields = asUnknownArray(asNodeOrUndefined(view.consistency)?.strongFields);
  if (strongFields && strongFields.length > 0) {
    gaps.push({
      construct: 'view.consistency.strongFields',
      reason: 'not-projected',
      detail: `${strongFields.length} strongly_consistent field(s) are declared and not carried`,
    });
  }

  return {
    kind: 'view',
    view: identifierName(view.name) ?? '',
    forEntity: referenceName(view.forEntity),
    measures,
    groupBy,
    cacheTtlSeconds: cache ? durationSeconds(cache.ttl) : null,
    consistency: consistencyText(view.consistency),
    display: typeof view.display === 'string' ? view.display : null,
    gaps: sortGaps(gaps),
  };
}

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

export function aggregateSemantic(
  aggregate: Aggregate,
  options: SurfaceOptions = {},
): AggregateSemantic {
  const normalize = options.normalizeExpression ?? narrowNormalize;

  const gaps: ProjectionGap[] = [
    {
      construct: 'aggregate.groupBy.multiple',
      reason: 'not-in-grammar',
      detail:
        'the parser rejects `group_by: a, b` (P001), so an aggregate pivots on at most one dimension',
    },
    {
      construct: 'aggregate.sort',
      reason: 'not-in-grammar',
      detail: 'the parser rejects a `sort:` member of an aggregate (P001)',
    },
    {
      construct: 'aggregate.limit',
      reason: 'not-in-grammar',
      detail:
        'the parser rejects a `limit:` member of an aggregate (P001), so an aggregate cannot be a top-N',
    },
  ];

  if (aggregate.filter && containsNumberLiteral(aggregate.filter)) {
    gaps.push({
      construct: 'aggregate.filter.numericLiteral',
      reason: 'not-in-grammar',
      detail:
        'NumberLiteral keeps value and isFloat but not the source text, so 20000.00 and 20000.0 arrive identical',
    });
  }

  return {
    kind: 'aggregate',
    aggregate: identifierName(aggregate.name) ?? '',
    forEntity: referenceName(aggregate.forEntity),
    // Declaration order is the stat-card and table-column order, so it is kept.
    measures: (aggregate.measures ?? []).map((measure) => ({
      fn: String(measure.fn),
      over: identifierName(measure.field),
    })),
    groupBy: aggregate.groupBy ? [identifierName(aggregate.groupBy) ?? ''] : [],
    filter: aggregate.filter ? normalize(aggregate.filter) : null,
    gaps: sortGaps(gaps),
  };
}

export function querySemantic(query: QueryDecl, options: SurfaceOptions = {}): QuerySemantic {
  const normalize = options.normalizeExpression ?? narrowNormalize;
  return {
    kind: 'query',
    query: identifierName(query.name) ?? '',
    forEntity: referenceName(query.forEntity),
    filter: query.filter ? normalize(query.filter) : null,
    filterBy: (query.filterBy ?? []).map((field) => identifierName(field) ?? '').filter(Boolean),
    gaps: [],
  };
}

export function jobSemantic(job: JobDecl): JobSemantic {
  return {
    kind: 'job',
    job: identifierName(job.name) ?? '',
    forEntity: referenceName(job.forEntity),
    schedule: identifierName(job.schedule) ?? '',
    cadence: identifierName(job.cadence),
    action: identifierName(job.action),
    gaps: [],
  };
}

export function notificationSemantic(notice: NotificationDecl): NotificationSemantic {
  return {
    kind: 'notification',
    notification: identifierName(notice.name) ?? '',
    forEntity: notice.forEntity ? referenceName(notice.forEntity) : null,
    to: identifierName(notice.to) ?? '',
    event: identifierName(notice.event),
    gaps: [],
  };
}

// ---------------------------------------------------------------------------
// integration / auth-provider — a grammar hole, faithfully reported
// ---------------------------------------------------------------------------

export function integrationSemantic(service: ProviderDecl): IntegrationSemantic {
  const integrationType = identifierName(service.type);
  const direction = identifierName(service.direction);
  const capability = service.capability ? String(service.capability.value) : null;
  const requires = (service.requires ?? []).map((item) => identifierName(item) ?? '').filter(Boolean);
  const event = service.event ? String(service.event.value) : null;
  const action = identifierName(service.action);
  const rich =
    integrationType !== null ||
    direction !== null ||
    capability !== null ||
    requires.length > 0 ||
    event !== null ||
    action !== null;

  const gaps: ProjectionGap[] = [];
  if (integrationType === null) {
    gaps.push({
      construct: 'integration.config',
      reason: 'not-in-grammar',
      detail:
        'ProviderDecl has one member, `name`; two apps with completely different wiring for the same service are identical here',
    });
  }
  if (requires.length === 0) {
    gaps.push({
      construct: 'integration.credentials',
      reason: 'not-in-grammar',
      detail:
        'no env or secret binding can be declared, so which key a service runs on is unstated',
    });
  }
  if (event === null && action === null) {
    gaps.push({
      construct: 'integration.operations',
      reason: 'not-in-grammar',
      detail: 'the service cannot declare which of its operations the app uses',
    });
  }
  if (!rich) {
    gaps.push({
      construct: 'integration.version',
      reason: 'not-in-grammar',
      detail:
        'no API version can be pinned, so a provider-side breaking change is invisible to the contract',
    });
  }

  return {
    kind: 'integration',
    provider: identifierName(service.name) ?? '',
    ...(integrationType ? { integrationType } : {}),
    ...(direction ? { direction } : {}),
    ...(capability ? { capability } : {}),
    ...(requires.length > 0 ? { requires } : {}),
    ...(event ? { event } : {}),
    ...(action ? { action } : {}),
    gaps: sortGaps(gaps),
  };
}

export function authProviderSemantic(provider: ProviderDecl): AuthProviderSemantic {
  return {
    kind: 'auth-provider',
    provider: identifierName(provider.name) ?? '',
    gaps: sortGaps([
      {
        construct: 'auth-provider.config',
        reason: 'not-in-grammar',
        detail:
          'ProviderDecl has one member, `name` — no client id, callback, or tenant restriction',
      },
      {
        construct: 'auth-provider.credentials',
        reason: 'not-in-grammar',
        detail: 'no env or secret binding can be declared for the provider',
      },
      {
        construct: 'auth-provider.scopes',
        reason: 'not-in-grammar',
        detail: 'the scopes requested at consent cannot be declared, so widening them is invisible',
      },
      {
        // Order IS meaning here: it is the order of the sign-in buttons. A
        // per-provider payload has nowhere to put a position, so it is a hole.
        // `integration` gets no equivalent gap — service order is not meaning.
        construct: 'auth-provider.order',
        reason: 'not-projected',
        detail:
          'declaration order decides sign-in button order and a per-provider payload cannot carry a position',
      },
    ]),
  };
}

// ---------------------------------------------------------------------------
// screen — previously no projector at all
// ---------------------------------------------------------------------------

export function screenSemantic(screen: ScreenDecl): ScreenSemantic {
  const gaps: ProjectionGap[] = [];
  const name = identifierName(screen.name) ?? '';

  if (screen.description) {
    gaps.push({
      construct: 'screen.description',
      reason: 'not-projected',
      detail: 'the payload carries no prose description',
    });
  }

  const navigation = screen.navigation ?? [];
  if (navigation.length > 0) {
    gaps.push({
      construct: 'screen.navigation',
      reason: 'not-projected',
      detail: `${navigation.length} navigation entr(y|ies) declared; labels, targets and icons are not carried`,
    });
  }

  const components = ((screen.components ?? []) as ComponentDecl[]).map((component) => {
    const componentName = identifierName(component.name) ?? '';
    const fields = component.fields ?? [];
    if (fields.length > 0) {
      gaps.push({
        construct: `screen.component.${componentName}.fields`,
        reason: 'not-projected',
        detail: `${fields.length} field(s) declared; input type, label, required and validation are not carried`,
      });
    }
    if (component.submit) {
      gaps.push({
        construct: `screen.component.${componentName}.submit`,
        reason: 'not-projected',
        detail: 'the submit label is not carried',
      });
    }
    if ((component.actions ?? []).length > 0) {
      gaps.push({
        construct: `screen.component.${componentName}.actions`,
        reason: 'not-projected',
        detail: `${component.actions.length} action expression(s) declared and not carried`,
      });
    }
    return {
      name: componentName,
      // The parser defaults an undeclared `type:` to "custom", so an absent
      // member and an explicit `type: custom` are one thing downstream too.
      type: typeof component.type === 'string' ? component.type : null,
      entity: identifierName(component.entity),
      behavior: identifierName(component.behavior),
    };
  });

  return {
    kind: 'screen',
    screen: name,
    route: screen.route ? String(screen.route.value) : null,
    layout: identifierName(screen.layout),
    // Declaration order is the render order down the page, so it is kept.
    components,
    ...(identifierName(screen.audience) ? { audience: identifierName(screen.audience)! } : {}),
    ...(identifierName(screen.authentication)
      ? { authentication: identifierName(screen.authentication)! }
      : {}),
    ...(identifierName(screen.visibility) ? { visibility: identifierName(screen.visibility)! } : {}),
    ...(identifierName(screen.contextEntity)
      ? { contextEntity: identifierName(screen.contextEntity)! }
      : {}),
    ...((screen.allowedActions ?? []).length > 0
      ? { allowedActions: (screen.allowedActions ?? []).map((action) => identifierName(action) ?? '').filter(Boolean) }
      : {}),
    gaps: sortGaps(gaps),
  };
}
