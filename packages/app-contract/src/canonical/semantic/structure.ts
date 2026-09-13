/**
 * Structure projection — the `app`, `entity`, `field`, `relationship` and
 * `status-set` variants of {@link ClauseSemantic}.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FIXES
 * ─────────────────────────────────────────────────────────────────────────────
 * `from-isl.ts` projects these five kinds into one string, `islExcerpt`, built
 * by `typeToIsl` + a rendering of the annotation list. Measured against real
 * fixtures, that string cannot see:
 *
 *   - `tenancy: "single-tenant"` (drops tenant-isolation RLS; reaches `detail`,
 *     which is not hashed)
 *   - `entity Lead [shared]` added or removed (grants `authenticated` action
 *     `*`; `Entity.annotations` is never read — 12 in the corpus)
 *   - `Int { min: 0 }` added or removed (`typeToIsl` returns the base and drops
 *     `ConstrainedType.constraints`), including through a named type, so
 *     `type Money = Decimal {…}` → `String {…}` is invisible
 *   - `amountCents: Int = 20000` — the `= expr` default, a different AST node
 *     from the `[default: …]` annotation, which does survive
 *   - `doubled: Int = amountCents * 2` → `* 3`
 *
 * and, in the other direction, it moves for changes that are not changes:
 * reordering `[unique, indexed]`, or reordering the variants of the enum a
 * plain field is typed by.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FOUR DECISIONS WORTH KNOWING ABOUT
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. NAMED TYPES ARE RESOLVED. `price: Money` where `type Money = Decimal
 *    { min: 0 }` projects as `type: 'Decimal'` plus `constraints: [{min, 0}]`.
 *    Editing the alias' definition therefore moves the payload. The cost is
 *    that renaming the alias alone (`Money` → `Cash`, same definition) does
 *    not — an alias rename with an identical definition generates identical
 *    code, so that is the right way round.
 *
 * 2. A NAMED ENUM RESOLVES TO ITS SORTED MEMBERSHIP. `source: LeadSource`
 *    projects as `enum { FACEBOOK, REFERRAL }`, so adding a variant (a schema
 *    migration) moves the payload while reordering the declaration does not.
 *    `status-set.states` is the opposite: there the order IS the reading order
 *    of a lifecycle, so it is preserved verbatim.
 *
 * 3. NUMBERS ARE RECONSTRUCTED, NOT READ. `NumberLiteral` keeps `value: number`
 *    and `isFloat: boolean` and throws the source text away, so `20000` and
 *    `20000.00` can be told apart (`"20000"` vs `"20000.0"`) but `20000.0` and
 *    `20000.00` cannot. Every field that carries a float literal therefore also
 *    carries a `numericPrecision` gap: the imprecision is itself recorded
 *    rather than silently assumed away.
 *
 * 4. WHERE THE VARIANT HAS NO SLOT, THE GAP CARRIES THE FACT. `relationship`
 *    has nowhere to put the FK column's type or its `[indexed]` annotation, and
 *    both change what is generated. Rather than regress a mutation that IS
 *    visible today, those land in `ProjectionGap.detail`, which is part of the
 *    payload and hashed. Anything genuinely unavailable — relationship
 *    cardinality, generic type arguments — is `'unspecified'` / empty plus a
 *    `not-in-grammar` gap, never a plausible default.
 */
import type {
  Annotation,
  Domain,
  Entity,
  Expression,
  Field,
  RelationshipDecl,
  TypeDefinition,
} from '@isl-lang/parser';

import {
  compareExpressions,
  numeric,
  orientComparison,
  sortedSet,
  type ClauseSemantic,
  type CompareOp,
  type NormalizedExpression,
  type ProjectionGap,
} from '../semantic.js';

export type AppSemantic = Extract<ClauseSemantic, { kind: 'app' }>;
export type EntitySemantic = Extract<ClauseSemantic, { kind: 'entity' }>;
export type FieldSemantic = Extract<ClauseSemantic, { kind: 'field' }>;
export type RelationshipSemantic = Extract<ClauseSemantic, { kind: 'relationship' }>;
export type StatusSetSemantic = Extract<ClauseSemantic, { kind: 'status-set' }>;
export type AuditSemantic = Extract<ClauseSemantic, { kind: 'audit' }>;

/**
 * What a structure payload needs beyond the node itself.
 *
 * Both members come from the enclosing `Domain`: the declared type table (so a
 * named type or enum can be resolved rather than carried as a bare name), and
 * the entity names (so a `[references: "X.id"]` pointing at a non-entity, or at
 * the field's own entity, can be told apart from a real foreign key).
 */
export interface StructureContext {
  types: ReadonlyMap<string, TypeDefinition>;
  entityNames: ReadonlySet<string>;
}

export function structureContext(domain: Domain): StructureContext {
  const types = new Map<string, TypeDefinition>();
  for (const declaration of domain.types ?? []) {
    const name = declaration.name?.name;
    if (name && declaration.definition) types.set(name, declaration.definition);
  }
  const entityNames = new Set<string>();
  for (const entity of domain.entities ?? []) {
    if (entity.name?.name) entityNames.add(entity.name.name);
  }
  return { types, entityNames };
}

/** Widen an ISL AST node so kind-switches can index fields the parser unions don't share. */
function asNode(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// gaps

function makeGap(
  construct: string,
  reason: ProjectionGap['reason'],
  detail?: string,
): ProjectionGap {
  return detail === undefined ? { construct, reason } : { construct, reason, detail };
}

function cmp(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Sorted by construct and deduped, so gap emission order cannot reach the hash. */
function sortGaps(gaps: readonly ProjectionGap[]): ProjectionGap[] {
  const unique = new Map<string, ProjectionGap>();
  for (const gap of gaps)
    unique.set(`${gap.construct}\u0000${gap.reason}\u0000${gap.detail ?? ''}`, gap);
  return [...unique.values()].sort(
    (a, b) =>
      cmp(a.construct, b.construct) ||
      cmp(a.reason, b.reason) ||
      cmp(a.detail ?? '', b.detail ?? ''),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// expressions

/**
 * Set when a float literal had to be reconstructed from `value` + `isFloat`.
 *
 * Not a warning channel — it decides whether the payload admits, in a gap, that
 * its own numeric fidelity is partial.
 */
interface Notes {
  inexactNumber: boolean;
}

function notes(): Notes {
  return { inexactNumber: false };
}

const COMPARE_OPS: ReadonlySet<string> = new Set(['==', '!=', '<', '>', '<=', '>=']);

/**
 * The written form of a number literal, as far as the AST allows.
 *
 * The lexer holds the exact text and `parseNumberLiteral` keeps only the parsed
 * value plus a "had a decimal point" flag, so an integer round-trips exactly
 * and a float loses trailing zeros. Reconstructing `20000.0` rather than
 * `20000` at least keeps `20000` and `20000.00` apart, which is the difference
 * between $200 and $20,000 against a minor-units column.
 */
function writtenNumber(value: number, isFloat: boolean): string {
  if (!Number.isFinite(value)) return String(value);
  const text = String(value);
  if (isFloat && !text.includes('.') && !text.includes('e')) return `${text}.0`;
  return text;
}

function refNode(path: readonly string[]): NormalizedExpression {
  return { node: 'ref', path };
}

function flattenLogical(op: 'and' | 'or', operand: NormalizedExpression): NormalizedExpression[] {
  return operand.node === 'logical' && operand.op === op ? [...operand.operands] : [operand];
}

function qualifiedParts(name: unknown): string[] {
  const parts = (name as { parts?: { name?: string }[] } | undefined)?.parts ?? [];
  return parts.map((part) => part.name ?? '');
}

/**
 * ISL expression → {@link NormalizedExpression}.
 *
 * Total: every node either lands on a variant that carries its meaning, or on
 * `{node:'unrepresented', astKind}`. Nothing is rendered to prose on the way.
 *
 * Nodes the payload type has no dedicated variant for are encoded as `call`
 * with a punctuation `fn` — `'*'`, `'?:'`, `'[]'`, `'{}'`, `'=>'`, `'.days'`,
 * `'//'`. None of those is a legal ISL identifier, so the encoding cannot
 * collide with a real function of the same name, and it is lossless: `* 2` and
 * `* 3`, or `+` and `*`, stay different payloads.
 */
export function normalizeExpression(
  expression: Expression | undefined,
  sink: Notes = notes(),
): NormalizedExpression {
  if (!expression || typeof expression !== 'object') {
    return { node: 'unrepresented', astKind: 'missing' };
  }
  const node = asNode(expression);
  const child = (key: string): NormalizedExpression =>
    normalizeExpression(node[key] as Expression | undefined, sink);
  const children = (key: string): NormalizedExpression[] =>
    ((node[key] as Expression[] | undefined) ?? []).map((item) => normalizeExpression(item, sink));

  switch (node.kind) {
    case 'Identifier':
      return refNode([String(node.name ?? '')]);
    case 'QualifiedName':
      return refNode(qualifiedParts(node));
    case 'StringLiteral':
      return { node: 'string', value: String(node.value ?? '') };
    case 'BooleanLiteral':
      return { node: 'boolean', value: Boolean(node.value) };
    case 'NullLiteral':
      return { node: 'null' };
    case 'NumberLiteral': {
      const isFloat = Boolean(node.isFloat);
      if (isFloat) sink.inexactNumber = true;
      return { node: 'number', number: numeric(writtenNumber(Number(node.value), isFloat)) };
    }
    case 'DurationLiteral':
      return {
        node: 'call',
        fn: `.${String(node.unit ?? '')}`,
        args: [{ node: 'number', number: numeric(writtenNumber(Number(node.value), false)) }],
      };
    case 'RegexLiteral':
      return {
        node: 'call',
        fn: '//',
        args: [
          { node: 'string', value: String(node.pattern ?? '') },
          { node: 'string', value: String(node.flags ?? '') },
        ],
      };
    case 'BinaryExpr': {
      const op = String(node.operator ?? '');
      const left = child('left');
      const right = child('right');
      if (COMPARE_OPS.has(op)) return orientComparison(op as CompareOp, left, right);
      if (op === 'and' || op === 'or') {
        return {
          node: 'logical',
          op,
          operands: [...flattenLogical(op, left), ...flattenLogical(op, right)].sort(
            compareExpressions,
          ),
        };
      }
      return { node: 'call', fn: op, args: [left, right] };
    }
    case 'UnaryExpr': {
      const operand = child('operand');
      return node.operator === 'not'
        ? { node: 'not', operand }
        : { node: 'call', fn: String(node.operator ?? '-'), args: [operand] };
    }
    case 'MemberExpr': {
      const object = child('object');
      const property = String((node.property as { name?: string } | undefined)?.name ?? '');
      return object.node === 'ref'
        ? refNode([...object.path, property])
        : { node: 'call', fn: '.', args: [object, { node: 'string', value: property }] };
    }
    case 'IndexExpr':
      return { node: 'call', fn: '[]', args: [child('object'), child('index')] };
    case 'CallExpr': {
      const callee = child('callee');
      const args = children('arguments');
      return callee.node === 'ref'
        ? { node: 'call', fn: callee.path.join('.'), args }
        : { node: 'call', fn: '()', args: [callee, ...args] };
    }
    case 'QuantifierExpr':
      return {
        node: 'call',
        fn: String(node.quantifier ?? ''),
        args: [
          child('collection'),
          {
            node: 'call',
            fn: '=>',
            args: [
              refNode([String((node.variable as { name?: string } | undefined)?.name ?? '')]),
              child('predicate'),
            ],
          },
        ],
      };
    case 'ConditionalExpr':
      return {
        node: 'call',
        fn: '?:',
        args: [child('condition'), child('thenBranch'), child('elseBranch')],
      };
    case 'OldExpr':
      return { node: 'call', fn: 'old', args: [child('expression')] };
    case 'ResultExpr': {
      const property = (node.property as { name?: string } | undefined)?.name;
      return refNode(property ? ['result', property] : ['result']);
    }
    case 'InputExpr':
      return refNode([
        'input',
        String((node.property as { name?: string } | undefined)?.name ?? ''),
      ]);
    case 'LambdaExpr':
      return {
        node: 'call',
        fn: '=>',
        args: [
          ...((node.params as { name?: string }[] | undefined) ?? []).map((param) =>
            refNode([param.name ?? '']),
          ),
          child('body'),
        ],
      };
    case 'ListExpr':
      return { node: 'list', items: children('elements') };
    case 'MapExpr':
      return {
        node: 'call',
        fn: '{}',
        args: (
          ((node.entries as { key: Expression; value: Expression }[] | undefined) ?? []) as {
            key: Expression;
            value: Expression;
          }[]
        ).flatMap((entry) => [
          normalizeExpression(entry.key, sink),
          normalizeExpression(entry.value, sink),
        ]),
      };
    default:
      return { node: 'unrepresented', astKind: String(node.kind ?? 'unknown') };
  }
}

/**
 * Canonical text for a normalized expression.
 *
 * Two payload slots are typed `string` — `field.annotations[].value` and
 * `field.constraints[].value` — so they need a rendering, and it has to be a
 * rendering of the NORMALIZED form rather than of the AST. That way a mirrored
 * comparison inside an annotation (`20000 < x` vs `x > 20000`) and a written
 * number (`20000.00`) behave in an annotation exactly as they do in a
 * predicate, instead of quietly following different rules.
 */
function renderNormalized(expression: NormalizedExpression): string {
  switch (expression.node) {
    case 'string':
      return `"${expression.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    case 'boolean':
      return expression.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'number':
      return expression.number.written;
    case 'ref':
      return expression.path.join('.');
    case 'compare':
      return `(${renderNormalized(expression.left)} ${expression.op} ${renderNormalized(expression.right)})`;
    case 'logical':
      return `(${expression.operands.map(renderNormalized).join(` ${expression.op} `)})`;
    case 'not':
      return `(not ${renderNormalized(expression.operand)})`;
    case 'call':
      return `${expression.fn}(${expression.args.map(renderNormalized).join(', ')})`;
    case 'list':
      return `[${expression.items.map(renderNormalized).join(', ')}]`;
    case 'unrepresented':
      return `<unrepresented:${expression.astKind}>`;
  }
}

function expressionText(expression: Expression | undefined, sink: Notes): string {
  return renderNormalized(normalizeExpression(expression, sink));
}

// ─────────────────────────────────────────────────────────────────────────────
// annotations

const KEY_SEP = '\u0000';

function annotationName(annotation: Annotation): string {
  return annotation.name?.name ?? '';
}

/**
 * Annotations as a SET of `{name, value}` pairs.
 *
 * `[unique, indexed]` and `[indexed, unique]` declare the same column, and the
 * hash moves between them today. The pairs are encoded to strings so
 * {@link sortedSet} — codepoint order, never `localeCompare` — does the sorting
 * and deduping, then decoded back.
 */
function annotationEntries(
  annotations: readonly Annotation[] | undefined,
  sink: Notes,
): { name: string; value: string | null }[] {
  const keys = (annotations ?? []).map((annotation) => {
    const name = annotationName(annotation);
    return annotation.value === undefined
      ? `${name}${KEY_SEP}`
      : `${name}${KEY_SEP}=${expressionText(annotation.value, sink)}`;
  });
  return sortedSet(keys).map((key) => {
    const at = key.indexOf(KEY_SEP);
    const name = at === -1 ? key : key.slice(0, at);
    const rest = at === -1 ? '' : key.slice(at + 1);
    return { name, value: rest.startsWith('=') ? rest.slice(1) : null };
  });
}

/** The raw text of one annotation: `[references: "User.id"]` → `User.id`. */
function annotationRaw(field: Field, name: string): string | null {
  const found = (field.annotations ?? []).find((annotation) => annotationName(annotation) === name);
  if (!found) return null;
  if (!found.value) return '';
  const node = asNode(found.value);
  if (node.kind === 'StringLiteral') return String(node.value ?? '');
  if (node.kind === 'Identifier') return String(node.name ?? '');
  return expressionText(found.value, notes());
}

// ─────────────────────────────────────────────────────────────────────────────
// types

function enumVariantNames(definition: TypeDefinition): string[] {
  const variants =
    (asNode(definition).variants as { name?: { name?: string } }[] | undefined) ?? [];
  return variants.map((variant) => variant.name?.name ?? '');
}

/**
 * Canonical text for a type, with declared types resolved.
 *
 * `ConstrainedType` renders as its base — the constraints are collected
 * separately into their own slot rather than being stringified into the type.
 * An enum renders as its SORTED membership: which variants exist is meaning,
 * the order they were declared in is not (for a lifecycle it is, and that is
 * `status-set.states`, not this).
 */
function typeText(
  type: TypeDefinition | undefined,
  ctx: StructureContext,
  seen: ReadonlySet<string> = new Set(),
): string {
  if (!type) return '';
  const node = asNode(type);
  switch (node.kind) {
    case 'PrimitiveType': {
      const name = String(node.name ?? '');
      const declared = ctx.types.get(name);
      if (declared && !seen.has(name)) {
        return typeText(declared, ctx, new Set([...seen, name]));
      }
      return name;
    }
    case 'OptionalType': {
      const inner = typeText(node.inner as TypeDefinition, ctx, seen);
      return inner.endsWith('?') ? inner : `${inner}?`;
    }
    case 'ListType':
      return `List<${typeText(node.element as TypeDefinition, ctx, seen)}>`;
    case 'MapType':
      return `Map<${typeText(node.key as TypeDefinition, ctx, seen)}, ${typeText(node.value as TypeDefinition, ctx, seen)}>`;
    case 'ConstrainedType':
      return typeText(node.base as TypeDefinition, ctx, seen);
    case 'EnumType':
      return `enum { ${sortedSet(enumVariantNames(type)).join(', ')} }`;
    case 'StructType': {
      const fields = ((node.fields as Field[] | undefined) ?? []).map((field) => {
        const inner = typeText(field.type, ctx, seen);
        const optional = field.optional && !inner.endsWith('?');
        return `${field.name?.name ?? ''}: ${inner}${optional ? '?' : ''}`;
      });
      return `struct { ${sortedSet(fields).join(', ')} }`;
    }
    case 'UnionType': {
      const variants = (
        (node.variants as
          { name?: { name?: string }; memberType?: TypeDefinition }[] | undefined) ?? []
      ).map((variant) =>
        variant.memberType ? typeText(variant.memberType, ctx, seen) : (variant.name?.name ?? ''),
      );
      return `union { ${sortedSet(variants).join(' | ')} }`;
    }
    case 'ReferenceType': {
      const name = qualifiedParts(node.name).join('.');
      const declared = ctx.types.get(name);
      if (!declared || seen.has(name)) return name;
      return typeText(declared, ctx, new Set([...seen, name]));
    }
    default:
      return `<unknown:${String(node.kind ?? '')}>`;
  }
}

/**
 * Every constraint reachable from a field's type, including through a declared
 * type alias.
 *
 * Constraints under a `List`/`Map` are kept but path-prefixed (`element.min`),
 * because `List<Int { min: 0 }>` constrains the elements and not the column,
 * and flattening the two together would say something false.
 */
function collectConstraints(
  type: TypeDefinition | undefined,
  ctx: StructureContext,
  sink: Notes,
  seen: ReadonlySet<string> = new Set(),
  prefix = '',
): { name: string; value: string }[] {
  if (!type) return [];
  const node = asNode(type);
  switch (node.kind) {
    case 'ConstrainedType': {
      const own = (
        (node.constraints as { name?: string; value?: Expression }[] | undefined) ?? []
      ).map((constraint) => ({
        name: `${prefix}${constraint.name ?? ''}`,
        value: expressionText(constraint.value, sink),
      }));
      return [...own, ...collectConstraints(node.base as TypeDefinition, ctx, sink, seen, prefix)];
    }
    case 'OptionalType':
      return collectConstraints(node.inner as TypeDefinition, ctx, sink, seen, prefix);
    case 'ListType':
      return collectConstraints(
        node.element as TypeDefinition,
        ctx,
        sink,
        seen,
        `${prefix}element.`,
      );
    case 'MapType':
      return [
        ...collectConstraints(node.key as TypeDefinition, ctx, sink, seen, `${prefix}key.`),
        ...collectConstraints(node.value as TypeDefinition, ctx, sink, seen, `${prefix}value.`),
      ];
    case 'PrimitiveType': {
      const name = String(node.name ?? '');
      const declared = ctx.types.get(name);
      if (!declared || seen.has(name)) return [];
      return collectConstraints(declared, ctx, sink, new Set([...seen, name]), prefix);
    }
    case 'ReferenceType': {
      const name = qualifiedParts(node.name).join('.');
      const declared = ctx.types.get(name);
      if (!declared || seen.has(name)) return [];
      return collectConstraints(declared, ctx, sink, new Set([...seen, name]), prefix);
    }
    default:
      return [];
  }
}

/** A constraint set: order of declaration is not meaning, presence is. */
function constraintSet(
  constraints: readonly { name: string; value: string }[],
): { name: string; value: string }[] {
  return sortedSet(constraints.map((c) => `${c.name}${KEY_SEP}${c.value}`)).map((key) => {
    const at = key.indexOf(KEY_SEP);
    return { name: key.slice(0, at), value: key.slice(at + 1) };
  });
}

/** True when a generic argument list could have been written and discarded. */
function mentionsReferenceType(type: TypeDefinition | undefined): boolean {
  if (!type) return false;
  const node = asNode(type);
  switch (node.kind) {
    case 'ReferenceType':
      return true;
    case 'OptionalType':
      return mentionsReferenceType(node.inner as TypeDefinition);
    case 'ConstrainedType':
      return mentionsReferenceType(node.base as TypeDefinition);
    case 'ListType':
      return mentionsReferenceType(node.element as TypeDefinition);
    case 'MapType':
      return (
        mentionsReferenceType(node.key as TypeDefinition) ||
        mentionsReferenceType(node.value as TypeDefinition)
      );
    default:
      return false;
  }
}

/** The variants of the enum a field is typed by, in DECLARATION order. */
function enumStates(
  type: TypeDefinition | undefined,
  ctx: StructureContext,
  seen: ReadonlySet<string> = new Set(),
): string[] {
  if (!type) return [];
  const node = asNode(type);
  switch (node.kind) {
    case 'EnumType':
      return enumVariantNames(type);
    case 'OptionalType':
      return enumStates(node.inner as TypeDefinition, ctx, seen);
    case 'ConstrainedType':
      return enumStates(node.base as TypeDefinition, ctx, seen);
    case 'PrimitiveType': {
      const name = String(node.name ?? '');
      const declared = ctx.types.get(name);
      if (!declared || seen.has(name)) return [];
      return enumStates(declared, ctx, new Set([...seen, name]));
    }
    case 'ReferenceType': {
      const name = qualifiedParts(node.name).join('.');
      const declared = ctx.types.get(name);
      if (!declared || seen.has(name)) return [];
      return enumStates(declared, ctx, new Set([...seen, name]));
    }
    default:
      return [];
  }
}

/** `[references: "User.id"]` → `User`; `null` when the field is not a foreign key. */
function referenceTarget(field: Field): { entity: string; column: string | null } | null {
  const reference = annotationRaw(field, 'references');
  if (reference === null || reference === '') return null;
  const dot = reference.indexOf('.');
  return dot === -1
    ? { entity: reference, column: null }
    : { entity: reference.slice(0, dot), column: reference.slice(dot + 1) };
}

const NUMERIC_PRECISION_GAP =
  'a float literal is reconstructed from NumberLiteral.value + isFloat; the lexer holds the source text and the AST does not, so 20000.0 and 20000.00 collide';

// ─────────────────────────────────────────────────────────────────────────────
// app

/**
 * Domain-level constructs that parse fully and reach no clause in this
 * projection. Recorded as gaps so "this app has three workflows nothing can
 * see" is a fact in the payload rather than a silence.
 *
 * `screen` is deliberately absent — it has a clause kind of its own.
 */
function unprojectedDomainConstructs(domain: Domain): [string, number][] {
  return [
    ['api', (domain.apis ?? []).length],
    ['automation.event', (domain.events ?? []).length],
    ['automation.handler', (domain.handlers ?? []).length],
    ['automation.workflow', (domain.workflows ?? []).length],
    ['chaos', (domain.chaos ?? []).length],
    ['config', domain.config ? 1 : 0],
    ['import', (domain.imports ?? []).length],
    ['ledger', (domain.ledgers ?? []).length],
    ['scenario', (domain.scenarios ?? []).length],
    ['storage', (domain.storage ?? []).length],
    ['use', (domain.uses ?? []).length],
  ];
}

export function appSemantic(domain: Domain): AppSemantic {
  const gaps: ProjectionGap[] = [];
  for (const [construct, count] of unprojectedDomainConstructs(domain)) {
    if (count > 0) {
      gaps.push(makeGap(construct, 'not-projected', `${count} declaration(s) reach no clause`));
    }
  }
  return {
    kind: 'app',
    name: domain.name?.name ?? '',
    version: domain.version?.value ?? '',
    // Absent is not the same claim as `tenancy: "multi-tenant"`. The compiler
    // treats absent as multi-tenant; the contract records what was written.
    tenancy: domain.tenancy ?? null,
    gaps: sortGaps(gaps),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// entity

export function entitySemantic(entity: Entity): EntitySemantic {
  const sink = notes();
  const annotations = sortedSet(
    (entity.annotations ?? []).map((annotation) =>
      annotation.value
        ? `${annotationName(annotation)}: ${expressionText(annotation.value, sink)}`
        : annotationName(annotation),
    ),
  );

  const gaps: ProjectionGap[] = [];
  const invariantCount = (entity.invariants ?? []).length;
  if (invariantCount > 0) {
    // `Entity.invariants` belongs to the `invariant` payload. Recorded here so
    // that if that projection lags, 248 corpus predicates do not vanish twice.
    gaps.push(
      makeGap(
        'entity.invariants',
        'not-projected',
        `${invariantCount} predicate(s) belong to the invariant clause, not to this one`,
      ),
    );
  }
  if (sink.inexactNumber)
    gaps.push(makeGap('entity.numericPrecision', 'not-in-grammar', NUMERIC_PRECISION_GAP));

  return {
    kind: 'entity',
    entity: entity.name?.name ?? '',
    annotations,
    gaps: sortGaps(gaps),
  };
}

export function auditSemantic(entity: Entity): AuditSemantic {
  return {
    kind: 'audit',
    entity: entity.name?.name ?? '',
    gaps: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// field

export function fieldSemantic(entity: Entity, field: Field, ctx: StructureContext): FieldSemantic {
  const sink = notes();
  const entityName = entity.name?.name ?? '';
  const written = typeText(field.type, ctx);
  const optional = Boolean(field.optional) || written.endsWith('?');
  const gaps: ProjectionGap[] = [];

  if (field.defaultValue) {
    // `computed x: T = expr` and `x: T = expr` are the same AST. The `computed`
    // marker is consumed by the field parser and has no slot to land in, so a
    // derived column cannot be told from a defaulted one.
    gaps.push(
      makeGap(
        'field.computedAs',
        'not-in-grammar',
        'the `computed` marker is consumed at parse and shares the defaultValue slot',
      ),
    );
  }
  if (mentionsReferenceType(field.type)) {
    gaps.push(
      makeGap(
        'field.typeArguments',
        'not-in-grammar',
        'generic arguments are parsed for well-formedness and discarded, so `Money<USD>` and `Money<EUR>` are one type',
      ),
    );
  }
  const target = referenceTarget(field);
  if (target && target.entity === entityName) {
    gaps.push(
      makeGap(
        'relationship.selfReference',
        'not-projected',
        `${entityName}.${field.name?.name ?? ''} points at its own entity and is carried as a plain field, not as a relationship`,
      ),
    );
  }

  const annotations = annotationEntries(field.annotations, sink);
  const constraints = constraintSet(collectConstraints(field.type, ctx, sink));
  const defaultValue = field.defaultValue ? normalizeExpression(field.defaultValue, sink) : null;
  if (sink.inexactNumber)
    gaps.push(makeGap('field.numericPrecision', 'not-in-grammar', NUMERIC_PRECISION_GAP));

  return {
    kind: 'field',
    entity: entityName,
    field: field.name?.name ?? '',
    type: written.endsWith('?') ? written.slice(0, -1) : written,
    typeArguments: [],
    optional,
    annotations,
    constraints,
    defaultValue,
    computedAs: null,
    gaps: sortGaps(gaps),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// relationship

export function relationshipSemantic(
  entity: Entity,
  field: Field,
  ctx: StructureContext,
): RelationshipSemantic {
  const sink = notes();
  const entityName = entity.name?.name ?? '';
  const target = referenceTarget(field);
  const gaps: ProjectionGap[] = [
    makeGap(
      'relationship.cardinality',
      'not-in-grammar',
      'the AST has no cardinality node; one/many is hardcoded downstream',
    ),
    // The variant has no slot for either, and both change generated code, so
    // they ride in the gap rather than being dropped.
    makeGap('relationship.fieldType', 'not-projected', typeText(field.type, ctx)),
  ];

  if (!target) {
    gaps.push(
      makeGap('relationship.toEntity', 'not-projected', 'no [references] annotation on this field'),
    );
  } else if (!ctx.entityNames.has(target.entity)) {
    gaps.push(
      makeGap(
        'relationship.toEntity',
        'not-projected',
        `[references] names ${target.entity}, which is not an entity in this domain`,
      ),
    );
  }

  const carried = new Set(['references', 'onDelete']);
  const rest = annotationEntries(
    (field.annotations ?? []).filter((annotation) => !carried.has(annotationName(annotation))),
    sink,
  );
  if (rest.length > 0) {
    gaps.push(
      makeGap(
        'relationship.annotations',
        'not-projected',
        rest
          .map((entry) => (entry.value === null ? entry.name : `${entry.name}=${entry.value}`))
          .join(', '),
      ),
    );
  }
  if (sink.inexactNumber)
    gaps.push(makeGap('relationship.numericPrecision', 'not-in-grammar', NUMERIC_PRECISION_GAP));

  return {
    kind: 'relationship',
    fromEntity: entityName,
    fromField: field.name?.name ?? '',
    toEntity: target?.entity ?? '',
    toColumn: target?.column ?? null,
    onDelete: annotationRaw(field, 'onDelete'),
    cardinality: 'unspecified',
    gaps: sortGaps(gaps),
  };
}

export function domainRelationshipSemantic(relationship: RelationshipDecl): RelationshipSemantic {
  const association = relationship.associationEntity?.name;
  return {
    kind: 'relationship',
    fromEntity: relationship.source.name,
    fromField: relationship.sourceField?.name ?? '',
    toEntity: relationship.target.name,
    toColumn: relationship.targetField?.name ?? null,
    onDelete: null,
    cardinality: relationship.cardinality,
    name: relationship.name.name,
    ...(association ? { associationEntity: association } : {}),
    gaps: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// status-set

/**
 * Whether a field is EMITTED as a status-set is the caller's gate — today an
 * unanchored `/status|stage|state|phase/i` name test plus the presence of an
 * `entity.lifecycle` block. This function answers a different question: given
 * that a field IS a status set, what does it mean.
 */
export function statusSetSemantic(
  entity: Entity,
  field: Field,
  ctx: StructureContext,
): StatusSetSemantic {
  const sink = notes();
  // Declaration order is the reading order of the lifecycle, so unlike every
  // other membership list in this module it is NOT sorted.
  const states = enumStates(field.type, ctx);
  const terminalRaw = annotationRaw(field, 'terminal');
  const gaps: ProjectionGap[] = [
    makeGap(
      'status-set.lifecycleMetadata',
      'not-in-grammar',
      '`lifecycle { initial: … / terminal: … }` is accepted for well-formedness and discarded at parse; initial and terminal are read from the field annotations instead',
    ),
  ];

  if (states.length === 0) {
    gaps.push(
      makeGap(
        'status-set.states',
        'not-projected',
        `the type of ${field.name?.name ?? ''} does not resolve to a declared enum`,
      ),
    );
  }

  const carried = new Set(['default', 'terminal']);
  const rest = annotationEntries(
    (field.annotations ?? []).filter((annotation) => !carried.has(annotationName(annotation))),
    sink,
  );
  if (rest.length > 0) {
    gaps.push(
      makeGap(
        'status-set.annotations',
        'not-projected',
        rest
          .map((entry) => (entry.value === null ? entry.name : `${entry.name}=${entry.value}`))
          .join(', '),
      ),
    );
  }
  if (sink.inexactNumber)
    gaps.push(makeGap('status-set.numericPrecision', 'not-in-grammar', NUMERIC_PRECISION_GAP));

  const initial = annotationRaw(field, 'default');
  return {
    kind: 'status-set',
    entity: entity.name?.name ?? '',
    field: field.name?.name ?? '',
    states,
    // The `[default: …]` annotation IS the state a row starts in — the column
    // default and the initial state are the same fact written once.
    initial: initial === null || initial === '' ? null : initial,
    // Terminal states are a set: which ones end the workflow is meaning, the
    // order they were listed in is not.
    terminal: terminalRaw
      ? sortedSet(
          terminalRaw
            .split(',')
            .map((state) => state.trim())
            .filter(Boolean),
        )
      : [],
    gaps: sortGaps(gaps),
  };
}
