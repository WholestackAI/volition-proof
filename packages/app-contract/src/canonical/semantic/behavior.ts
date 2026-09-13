/**
 * Behavior-group projection: ISL AST → typed semantic payloads.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY
 * ─────────────────────────────────────────────────────────────────────────────
 * The P0 inventory scored every clause kind by executing real source mutations
 * and watching `contractHash`. This group scored worst:
 *
 *   behavior     4/20 visible — and all four were renames. Deleting an input,
 *                changing an input type, retargeting `output.success`, deleting
 *                an error block, flipping `retriable`, changing
 *                `[setField: "status = 'ACCEPTED'"]` to `'REJECTED'` — every one
 *                of those changed the generated app and moved no bytes.
 *   invariant    1/9 visible. 248 entity predicates across the corpus produced
 *                ZERO clauses, so negating the spend guard
 *                `spentCents <= capCents` → `>=` was free.
 *
 * The cause in both cases was the same: the clause's whole semantic content was
 * `islExcerpt`, and for these kinds the projector wrote the construct's NAME
 * (`behavior CreateEstimate`, `invariant SpendCap`). This module replaces that
 * with the data.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE EXPRESSION TRANSLATOR
 * ─────────────────────────────────────────────────────────────────────────────
 * {@link normalizeExpression} is the load-bearing piece — preconditions,
 * postconditions, invariants, policy rules, aggregate filters and field defaults
 * all bottom out in it. Four rules it must never break:
 *
 *   1. Comparisons go through `orientComparison`, so `20000 < x` and `x > 20000`
 *      are ONE rule. `>` is never collapsed into `>=`: they differ at exactly
 *      the boundary value, which is the value business rules are written about.
 *   2. Number literals keep the DECIMAL CLAIM the author made. The AST carries
 *      `{value, isFloat}` and no source text, and `isFloat` is exactly the bit
 *      that matters: against a minor-units column `amountCents >= 20000` is $200
 *      and `amountCents >= 20000.00` is $20,000, and those two differ in
 *      `isFloat`. `20000.00` and `20000.0` do NOT differ — same value, same
 *      decimal claim — so they must normalize identically. See
 *      {@link numericLiteral}: wrong in either direction is broken.
 *   3. `and`/`or` are commutative and associative, so their operands are
 *      flattened and sorted. `not` is NOT pushed inward — De Morgan over a
 *      nullable column is three-valued and unsound, and a wrong normalizer
 *      trades a loud false positive for a silent false negative.
 *   4. A node this cannot translate becomes `{node:'unrepresented', astKind}`.
 *      Never a rendered string. The old renderer's `default:` branch returned
 *      `` `[${kind}]` ``, which collapses whole classes of node onto one token
 *      that reads like real content.
 *
 * Operators the payload vocabulary has no node for (`+ - * / % in implies iff`,
 * indexing, conditionals, quantifiers) are carried as `call` nodes with an
 * `operator:`/`quantifier:` prefixed name. The prefix contains a `:`, which no
 * ISL identifier may, so an operator can never be mistaken for — or collide
 * with — a function an author actually declared. This keeps `a - b` distinct
 * from `a + b`, which `unrepresented` would not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE GRAMMAR CANNOT SAY (recorded, never inferred)
 * ─────────────────────────────────────────────────────────────────────────────
 * `Behavior` has no `effects` node — zero hits in the parser. The only
 * authorable effects are the `[action]` / `[setField]` annotations, whose values
 * are opaque strings re-parsed downstream by two independent regex mini-parsers
 * (`isl-to-react.ts:parseActionAnnotations` and
 * `extract-blueprint.ts:parseSetFieldRaw`). {@link behaviorSemantic} parses them
 * into {@link BehaviorEffect} against the same grammar those two accept, so the
 * contract and the codegen agree on what a `[setField]` means. Every behavior
 * carries a `behavior.effects` gap regardless, so `effects: []` can never be
 * read as "this command has no effects".
 *
 * `LifecycleTransition` is `{from, to}` and nothing else: no actor, no guard, no
 * command. Those come back as `principals: []`, `guard: null`, `command: null`
 * plus `not-in-grammar` gaps. They are not inferred from behavior names — a
 * guessed actor on a state machine is worse than an absent one.
 *
 * Pure: no fs, no clock, no randomness, no network.
 */

import type {
  Annotation,
  Behavior,
  Constraint,
  Entity,
  Expression,
  InvariantBlock,
  LifecycleTransition,
  PostconditionBlock,
  TypeDefinition,
} from '@isl-lang/parser';

import { isLifecycleFieldName } from '../../lifecycle-field.js';
import {
  compareExpressions,
  numeric,
  orientComparison,
  sortedSet,
  type BehaviorEffect,
  type ClauseSemantic,
  type CompareOp,
  type NormalizedExpression,
  type ProjectionGap,
} from '../semantic.js';

type Node = Record<string, unknown>;

/** Reviewed single widening — prefer this over inline `as unknown as`. */
function asTyped<T>(value: unknown): T {
  return value as T;
}

type BehaviorSemantic = Extract<ClauseSemantic, { kind: 'behavior' }>;
type PreconditionSemantic = Extract<ClauseSemantic, { kind: 'precondition' }>;
type PostconditionSemantic = Extract<ClauseSemantic, { kind: 'postcondition' }>;
type TransitionSemantic = Extract<ClauseSemantic, { kind: 'transition' }>;
type InvariantSemantic = Extract<ClauseSemantic, { kind: 'invariant' }>;

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

const COMPARE_OPS = new Set(['==', '!=', '<', '<=', '>', '>=']);

const unrepresented = (astKind: string): NormalizedExpression => ({
  node: 'unrepresented',
  astKind,
});

const call = (fn: string, args: NormalizedExpression[]): NormalizedExpression => ({
  node: 'call',
  fn,
  args,
});

const ref = (...path: string[]): NormalizedExpression => ({ node: 'ref', path });

function nameOf(node: unknown): string {
  return (node as { name?: string } | undefined)?.name ?? '';
}

/**
 * Canonical text for a number literal, built from what the AST actually holds.
 *
 * `NumberLiteral` is `{value: number, isFloat: boolean}` — no source text, in
 * either front end (`expression-parser.ts:698` sets `isFloat` from
 * `token.value.includes(".")`; the peggy grammar sets it from which of
 * `parseFloat`/`parseInt` ran). So the rendering is:
 *
 *   isFloat === false  →  `20000`     — an integer count
 *   isFloat === true   →  `20000.0`   — a decimal quantity
 *
 * That separates the pair the rule exists for, `20000` vs `20000.00`, and
 * deliberately merges `20000.00` with `20000.0`: same value, same decimal
 * claim, and treating trailing zeros as meaning would be a false positive in
 * the other direction. A number written with digits after the point that are
 * not zero renders them, because `String(0.5)` already carries them.
 */
function numberText(node: Node): string {
  const value = typeof node.value === 'number' ? node.value : Number.NaN;
  // Not a finite decimal (`1e3` currently lexes as `1` plus a stray identifier):
  // pass the raw through so `numeric` reports `value: null` rather than a
  // threshold nobody wrote.
  if (!Number.isFinite(value)) return String(node.value);
  const plain = String(value);
  if (!node.isFloat) return plain;
  return plain.includes('.') ? plain : `${plain}.0`;
}

/**
 * TODO(compose): `numeric()` is slated to take `{value, isFloat}` directly. When
 * it does, this is the one call site to swap — the semantics above are already
 * what it must implement.
 */
function numericLiteral(node: Node) {
  return numeric(numberText(node));
}

/** `a and (b and c)` and `(a and b) and c` are one conjunction, so flatten. */
function flatten(op: 'and' | 'or', expression: NormalizedExpression): NormalizedExpression[] {
  return expression.node === 'logical' && expression.op === op
    ? [...expression.operands]
    : [expression];
}

function binary(node: Node): NormalizedExpression {
  const op = String(node.operator ?? '');
  const left = normalizeExpression(node.left as Expression);
  const right = normalizeExpression(node.right as Expression);

  if (COMPARE_OPS.has(op)) return orientComparison(op as CompareOp, left, right);
  if (op === 'and' || op === 'or') {
    return {
      node: 'logical',
      op,
      operands: [...flatten(op, left), ...flatten(op, right)].sort(compareExpressions),
    };
  }
  // Arithmetic, `in`, `implies`, `iff`: no node exists for them, and collapsing
  // them onto `unrepresented` would make `a - b` and `a + b` the same claim.
  return call(`operator:${op}`, [left, right]);
}

function unary(node: Node): NormalizedExpression {
  const op = String(node.operator ?? '');
  const operandNode = node.operand as Node | undefined;

  // `-5` lexes as MINUS + NUMBER; fold it back so the literal reads as written.
  if (op === '-' && operandNode?.kind === 'NumberLiteral') {
    return { node: 'number', number: numeric(`-${numberText(operandNode)}`) };
  }

  const operand = normalizeExpression(node.operand as Expression);
  // NOT stays outside. Pushing it in is unsound the moment a column is nullable.
  if (op === 'not') return { node: 'not', operand };
  return call('operator:neg', [operand]);
}

/**
 * Translate one ISL expression into the canonical normal form.
 *
 * Total: every input produces a node, and anything unhandled is an explicit
 * `unrepresented` variant rather than a string that looks like content.
 */
export function normalizeExpression(expression: Expression | undefined): NormalizedExpression {
  if (!expression || typeof expression !== 'object') return unrepresented('missing');
  const node = asTyped<Node>(expression);

  switch (node.kind) {
    case 'Identifier':
      return ref(String(node.name ?? ''));
    case 'QualifiedName':
      return { node: 'ref', path: ((node.parts as Node[]) ?? []).map((part) => nameOf(part)) };
    case 'StringLiteral':
      return { node: 'string', value: String(node.value ?? '') };
    case 'BooleanLiteral':
      return { node: 'boolean', value: Boolean(node.value) };
    case 'NullLiteral':
      return { node: 'null' };
    case 'NumberLiteral':
      return { node: 'number', number: numericLiteral(node) };
    case 'DurationLiteral':
      return call('operator:duration', [
        { node: 'number', number: numeric(String(node.value)) },
        { node: 'string', value: String(node.unit ?? '') },
      ]);
    case 'RegexLiteral':
      return call('operator:regex', [
        { node: 'string', value: String(node.pattern ?? '') },
        { node: 'string', value: String(node.flags ?? '') },
      ]);
    case 'BinaryExpr':
      return binary(node);
    case 'UnaryExpr':
      return unary(node);
    case 'MemberExpr': {
      // `row.ownerId` is a path, not a projection: keep it as one ref so
      // renaming the column is a visible edit to every rule that reads it.
      const object = normalizeExpression(node.object as Expression);
      const property = nameOf(node.property);
      if (object.node === 'ref' && property)
        return { node: 'ref', path: [...object.path, property] };
      return unrepresented('MemberExpr');
    }
    case 'InputExpr':
      return ref('input', nameOf(node.property));
    case 'ResultExpr':
      return node.property ? ref('result', nameOf(node.property)) : ref('result');
    case 'OldExpr':
      // `old(x)` always parses as OldExpr, so a declared function of that name
      // can never reach here to collide with it.
      return call('old', [normalizeExpression(node.expression as Expression)]);
    case 'CallExpr': {
      const callee = normalizeExpression(node.callee as Expression);
      const args = ((node.arguments as Expression[]) ?? []).map(normalizeExpression);
      if (callee.node !== 'ref') return unrepresented('CallExpr');
      return call(callee.path.join('.'), args);
    }
    case 'IndexExpr':
      return call('operator:index', [
        normalizeExpression(node.object as Expression),
        normalizeExpression(node.index as Expression),
      ]);
    case 'ConditionalExpr':
      return call('operator:if', [
        normalizeExpression(node.condition as Expression),
        normalizeExpression(node.thenBranch as Expression),
        normalizeExpression(node.elseBranch as Expression),
      ]);
    case 'QuantifierExpr':
      // [binder, collection, predicate] — fixed positions, nothing dropped. The
      // binder is kept because the predicate references it by name, so erasing
      // it would not buy alpha-equivalence, only lost information.
      return call(`quantifier:${String(node.quantifier ?? '')}`, [
        ref(nameOf(node.variable)),
        normalizeExpression(node.collection as Expression),
        normalizeExpression(node.predicate as Expression),
      ]);
    case 'LambdaExpr':
      return call('operator:lambda', [
        ...((node.params as Node[]) ?? []).map((param) => ref(nameOf(param))),
        normalizeExpression(node.body as Expression),
      ]);
    case 'ListExpr':
      // Order preserved: `in [A, B]` and `in [B, A]` are the same set today, but
      // a list is also how ordered arguments are written, and sorting one erases
      // a fact that cannot be recovered.
      return {
        node: 'list',
        items: ((node.elements as Expression[]) ?? []).map(normalizeExpression),
      };
    case 'MapExpr':
      return call(
        'operator:map',
        ((node.entries as Node[]) ?? []).flatMap((entry) => [
          normalizeExpression(entry.key as Expression),
          normalizeExpression(entry.value as Expression),
        ]),
      );
    default:
      return unrepresented(String(node.kind ?? 'unknown'));
  }
}

// ---------------------------------------------------------------------------
// Types (the `type` slot is a string by design; this is what fills it)
// ---------------------------------------------------------------------------

/** Deterministic text for a normalized expression, for the type label only. */
function literalText(expression: NormalizedExpression): string {
  switch (expression.node) {
    case 'number':
      return expression.number.written;
    case 'string':
      return JSON.stringify(expression.value);
    case 'boolean':
      return String(expression.value);
    case 'null':
      return 'null';
    case 'ref':
      return expression.path.join('.');
    case 'call':
      return `${expression.fn}(${expression.args.map(literalText).join(', ')})`;
    case 'list':
      return `[${expression.items.map(literalText).join(', ')}]`;
    case 'not':
      return `not ${literalText(expression.operand)}`;
    case 'compare':
      return `(${literalText(expression.left)} ${expression.op} ${literalText(expression.right)})`;
    case 'logical':
      return `(${expression.operands.map(literalText).join(` ${expression.op} `)})`;
    case 'unrepresented':
      return `<${expression.astKind}>`;
  }
}

/**
 * Field type as text — INCLUDING constraints, which `from-isl.ts:typeToIsl`
 * drops. `Int { min: 0 }` relaxed to `Int { min: -1 }` is a validation change,
 * and on a behavior input it is the difference between rejecting a negative
 * amount and accepting one. Constraint order is not meaning, so it is sorted.
 */
function typeToText(type: TypeDefinition | undefined): string {
  if (!type) return '';
  const node = asTyped<Node>(type);

  switch (node.kind) {
    case 'PrimitiveType':
      return String(node.name ?? '');
    case 'ReferenceType':
      return (((node.name as Node)?.parts as Node[]) ?? []).map((part) => nameOf(part)).join('.');
    case 'OptionalType':
      return `${typeToText(node.inner as TypeDefinition)}?`;
    case 'ListType':
      return `List<${typeToText(node.element as TypeDefinition)}>`;
    case 'MapType':
      return `Map<${typeToText(node.key as TypeDefinition)}, ${typeToText(node.value as TypeDefinition)}>`;
    case 'ConstrainedType': {
      const constraints = sortedSet(
        ((node.constraints as Constraint[]) ?? []).map(
          (constraint) =>
            `${constraint.name}: ${literalText(normalizeExpression(constraint.value))}`,
        ),
      );
      const base = typeToText(node.base as TypeDefinition);
      return constraints.length ? `${base} { ${constraints.join(', ')} }` : base;
    }
    case 'EnumType':
      return `enum { ${((node.variants as Node[]) ?? []).map((v) => nameOf(v.name)).join(', ')} }`;
    case 'StructType':
      return 'struct';
    case 'UnionType':
      return 'union';
    default:
      return String(node.kind ?? '');
  }
}

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------

function sortGaps(gaps: readonly ProjectionGap[]): ProjectionGap[] {
  return [...gaps].sort((left, right) =>
    left.construct < right.construct ? -1 : left.construct > right.construct ? 1 : 0,
  );
}

const EFFECTS_GAP: ProjectionGap = {
  construct: 'behavior.effects',
  reason: 'not-in-grammar',
  detail:
    'ISL has no effects node. Effects are recovered from [action]/[setField] annotations only, so an empty list means "none declarable", not "none".',
};

// ---------------------------------------------------------------------------
// [action] / [setField] → BehaviorEffect
// ---------------------------------------------------------------------------

/** `col` or `entity.col`. Anything else is refused rather than guessed at. */
const LHS = /^([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?$/;
const BARE_TOKEN = /^[A-Za-z_]\w*$/;
const NUMBER_TEXT = /^-?\d+(?:\.\d+)?$/;
const INPUT_REF = /^input\.([A-Za-z_]\w*)$/;
const SELF_DELTA = /^([A-Za-z_]\w*)\s*([+-])\s*(input\.[A-Za-z_]\w*|-?\d+(?:\.\d+)?)$/;

/** String payload of an annotation (`[action: "Invitation"]` → `Invitation`). */
function annotationText(annotation: Annotation): string | null {
  if (!annotation.value) return null;
  const value = normalizeExpression(annotation.value);
  if (value.node === 'string') return value.value;
  if (value.node === 'ref') return value.path.join('.');
  if (value.node === 'number') return value.number.written;
  return null;
}

function annotationsNamed(behavior: Behavior, name: string): Annotation[] {
  return (behavior.annotations ?? []).filter(
    (annotation) => nameOf(annotation.name).toLowerCase() === name,
  );
}

/**
 * Split one `[setField]` value that packs several assignments, on commas that
 * introduce a new `ident =` clause and never mid-RHS. Same split the codegen
 * uses (`splitSetFieldAssignments`), so both read `"xpToday = 0, streak = 0"`
 * as two writes.
 */
function splitAssignments(raw: string): string[] {
  const parts = raw
    .split(/,\s*(?=[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?\s*=)/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [raw.trim()].filter(Boolean);
}

interface SetValue {
  /** Set when the RHS is an enum-ish token, which a lifecycle column moves to. */
  token: string | null;
  expression: NormalizedExpression;
}

/**
 * The right-hand side grammar this accepts — deliberately the same one the two
 * downstream mini-parsers lower, so an accepted `[setField]` is one that
 * actually reaches the database:
 *
 *   `0`, `-3`, `1.50`      numeric literal, written form kept
 *   `true` / `false`       boolean
 *   `null`                 null
 *   `'X'` / `"X"`          quoted string
 *   `X`                    bare enum/status token — the codegen JSON-stringifies
 *                          this, so it is the SAME write as `'X'` and normalizes
 *                          to the same string node
 *   `input.f`              a declared input written straight to the column
 *   `col ± input.f`        self-delta (the column must be the assignment target)
 *   `col ± 1`              constant self-delta
 *
 * Anything else returns null and the whole assignment becomes an
 * `unrepresented` effect carrying the source — never dropped.
 */
function setValue(rhs: string, column: string): SetValue | null {
  if (NUMBER_TEXT.test(rhs))
    return { token: null, expression: { node: 'number', number: numeric(rhs) } };
  if (rhs === 'true' || rhs === 'false')
    return { token: null, expression: { node: 'boolean', value: rhs === 'true' } };
  if (rhs === 'null') return { token: null, expression: { node: 'null' } };

  const quoted = /^'([^']*)'$/.exec(rhs) ?? /^"([^"]*)"$/.exec(rhs);
  if (quoted) return { token: quoted[1]!, expression: { node: 'string', value: quoted[1]! } };

  const inputRef = INPUT_REF.exec(rhs);
  if (inputRef) return { token: null, expression: ref('input', inputRef[1]!) };

  const delta = SELF_DELTA.exec(rhs);
  if (delta && delta[1] === column) {
    const amount = delta[3]!;
    const operand = amount.startsWith('input.')
      ? ref('input', amount.slice('input.'.length))
      : ({ node: 'number', number: numeric(amount) } as NormalizedExpression);
    return {
      token: null,
      expression: call(`operator:${delta[2]}`, [ref(column), operand]),
    };
  }

  if (BARE_TOKEN.test(rhs)) return { token: rhs, expression: { node: 'string', value: rhs } };
  return null;
}

function setFieldEffect(clause: string, target: string | null): BehaviorEffect {
  const source = `setField: ${JSON.stringify(clause)}`;
  const equals = clause.indexOf('=');
  // Without an [action] there is no entity to write to: the codegen ignores the
  // annotation entirely (its CARDINAL guardrail), so claiming a typed effect
  // here would describe a write that never happens.
  if (equals < 0 || !target) return { effect: 'unrepresented', source };

  const parsed = LHS.exec(clause.slice(0, equals).trim());
  const rhs = clause.slice(equals + 1).trim();
  if (!parsed || !rhs) return { effect: 'unrepresented', source };

  const [, head, tail] = parsed;
  const field = tail ?? head!;
  const entity = tail
    ? head!.toLowerCase() === target.toLowerCase()
      ? target
      : `${head!.charAt(0).toUpperCase()}${head!.slice(1)}`
    : target;

  const value = setValue(rhs, field);
  if (!value) return { effect: 'unrepresented', source };

  // A lifecycle column moving to a named state is a transition, not a generic
  // write — that is the difference between `status = 'ACCEPTED'` and
  // `title = 'ACCEPTED'`, and it is what a workflow reader is looking for.
  if (value.token !== null && isLifecycleFieldName(field)) {
    return { effect: 'transition-state', entity, field, to: value.token };
  }
  return { effect: 'update-field', entity, field, to: value.expression };
}

function behaviorEffects(behavior: Behavior): {
  effects: BehaviorEffect[];
  gaps: ProjectionGap[];
} {
  const action = annotationsNamed(behavior, 'action')[0];
  const target = action ? annotationText(action) : null;
  const raws = annotationsNamed(behavior, 'setfield')
    .map(annotationText)
    .filter((raw): raw is string => raw !== null && raw.trim() !== '');

  const effects: BehaviorEffect[] = [];
  const gaps: ProjectionGap[] = [];

  // Declaration order is meaning here: a delta applied before a reset is not the
  // same command as the reverse.
  for (const raw of raws)
    for (const clause of splitAssignments(raw)) effects.push(setFieldEffect(clause, target));

  if (raws.length > 0 && !target) {
    gaps.push({
      construct: 'behavior.effects.target',
      reason: 'not-in-grammar',
      detail: '[setField] names a column but no entity; without [action] the write has no target.',
    });
  }
  if (target && effects.length === 0) {
    effects.push({ effect: 'unrepresented', source: `action: ${JSON.stringify(target)}` });
    gaps.push({
      construct: 'behavior.effects.verb',
      reason: 'not-in-grammar',
      detail: '[action] names the entity a command mutates, never the verb applied to it.',
    });
  }

  return { effects, gaps };
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/** Annotations this projection carries elsewhere; the rest are a recorded gap. */
const CARRIED_ANNOTATIONS = new Set(['action', 'setfield', 'requirerole']);

export function behaviorSemantic(behavior: Behavior): BehaviorSemantic {
  const { effects, gaps: effectGaps } = behaviorEffects(behavior);
  const gaps: ProjectionGap[] = [EFFECTS_GAP, ...effectGaps];

  // Input order is NOT normalised: it is the order the generated form renders
  // its fields in, so a reorder is a real (if small) change to the app.
  const inputs = (behavior.input?.fields ?? []).map((field) => {
    const type = typeToText(field.type);
    return {
      name: nameOf(field.name),
      type,
      optional: Boolean(field.optional) || type.endsWith('?'),
    };
  });

  const errorSpecs = behavior.output?.errors ?? [];
  const errors = errorSpecs.map((spec) => ({
    code: nameOf(spec.name),
    retriable: Boolean(spec.retriable),
  }));

  if (behavior.actors?.length)
    gaps.push({
      construct: 'behavior.actors',
      reason: 'not-projected',
      detail: 'actors {} block parses and reaches no payload slot.',
    });
  if (behavior.invariants?.length)
    gaps.push({
      construct: 'behavior.invariants',
      reason: 'not-projected',
      detail: 'behavior-scoped invariants have no clause kind; only entity and domain blocks do.',
    });
  if (behavior.temporal?.length)
    gaps.push({ construct: 'behavior.temporal', reason: 'not-projected' });
  if (behavior.compliance?.length)
    gaps.push({ construct: 'behavior.compliance', reason: 'not-projected' });
  if (behavior.observability)
    gaps.push({ construct: 'behavior.observability', reason: 'not-projected' });

  if (errorSpecs.some((spec) => spec.when))
    gaps.push({
      construct: 'behavior.errors.when',
      reason: 'not-projected',
      detail: 'the condition prose an error fires under.',
    });
  if (errorSpecs.some((spec) => spec.retryAfter))
    gaps.push({ construct: 'behavior.errors.retryAfter', reason: 'not-projected' });
  if (errorSpecs.some((spec) => spec.returns))
    gaps.push({ construct: 'behavior.errors.returns', reason: 'not-projected' });

  const inputFields = behavior.input?.fields ?? [];
  if (inputFields.some((field) => field.annotations?.length))
    gaps.push({ construct: 'behavior.input.annotations', reason: 'not-projected' });
  if (inputFields.some((field) => field.defaultValue))
    gaps.push({ construct: 'behavior.input.defaultValue', reason: 'not-projected' });

  const stray = sortedSet(
    (behavior.annotations ?? [])
      .map((annotation) => nameOf(annotation.name))
      .filter((name) => name !== '' && !CARRIED_ANNOTATIONS.has(name.toLowerCase())),
  );
  if (stray.length)
    gaps.push({
      construct: 'behavior.annotations',
      reason: 'not-projected',
      detail: stray.join(', '),
    });

  return {
    kind: 'behavior',
    behavior: nameOf(behavior.name),
    inputs,
    output: behavior.output ? typeToText(behavior.output.success) || null : null,
    errors,
    effects,
    gaps: sortGaps(gaps),
  };
}

export function preconditionSemantic(
  behavior: Behavior,
  predicate: Expression,
): PreconditionSemantic {
  return {
    kind: 'precondition',
    behavior: nameOf(behavior.name),
    predicate: normalizeExpression(predicate),
    gaps: [],
  };
}

export function postconditionSemantic(
  behavior: Behavior,
  block: PostconditionBlock,
  predicate: Expression,
): PostconditionSemantic {
  return {
    kind: 'postcondition',
    behavior: nameOf(behavior.name),
    // `success` / `any_error` arrive as bare strings; a named block arrives as
    // an Identifier. A guarantee that holds on success is not the same claim as
    // one that holds on failure, so the discriminator is carried.
    condition: typeof block.condition === 'string' ? block.condition : nameOf(block.condition),
    predicate: normalizeExpression(predicate),
    gaps: [],
  };
}

/**
 * The column a `lifecycle {}` block governs.
 *
 * The grammar never says. The only signal is the field name, via the one
 * predicate the writer and reader share (`isLifecycleFieldName`). Exactly one
 * candidate is required: with two, picking either would be a guess, and a guess
 * that lands in a hashed payload is worse than an admitted hole.
 */
function lifecycleColumn(entity: Entity): string | null {
  const candidates = (entity.fields ?? [])
    .map((field) => nameOf(field.name))
    .filter((name) => name !== '' && isLifecycleFieldName(name));
  return candidates.length === 1 ? candidates[0]! : null;
}

export function transitionSemantic(
  entity: Entity,
  transition: LifecycleTransition,
): TransitionSemantic {
  const statusField = lifecycleColumn(entity);
  const gaps: ProjectionGap[] = [
    {
      construct: 'transition.command',
      reason: 'not-in-grammar',
      detail: 'lifecycle { A -> B } never names the behavior that performs the move.',
    },
    {
      construct: 'transition.guard',
      reason: 'not-in-grammar',
      detail: 'LifecycleTransition is {from, to}; there is nowhere to write a condition.',
    },
    {
      construct: 'transition.principals',
      reason: 'not-in-grammar',
      detail: 'LifecycleTransition is {from, to}; there is nowhere to write an actor.',
    },
  ];
  if (!statusField) {
    gaps.push({
      construct: 'transition.statusField',
      reason: 'not-in-grammar',
      detail:
        'lifecycle {} does not name the column it governs, and no single field name identified one.',
    });
  }

  return {
    kind: 'transition',
    entity: nameOf(entity.name),
    statusField,
    from: nameOf(transition.from),
    to: nameOf(transition.to),
    // Not inferred from behavior names: a fabricated actor or guard on a state
    // machine reads as a security control that nobody wrote.
    command: null,
    principals: [],
    guard: null,
    ...(transition.forbidden ? { forbidden: true } : {}),
    gaps: sortGaps(gaps),
  };
}

/**
 * An invariant block is a conjunction, so its predicates are a set: reordering
 * them is not a change and must not move the hash.
 */
function conjunction(predicates: readonly Expression[]): NormalizedExpression[] {
  return predicates.map(normalizeExpression).sort(compareExpressions);
}

/**
 * Both invariant shapes, because both constrain the app and only one of them
 * ever reached a clause.
 *
 * An `Entity` carries its `invariants: Expression[]` — 248 predicates across the
 * corpus, previously projected nowhere at all. An `InvariantBlock` is the
 * domain-level `invariants Name { scope: … }` form, whose predicates reached
 * `detail` prose and whose `scope` was read by nothing.
 */
export function invariantSemantic(source: Entity | InvariantBlock): InvariantSemantic {
  if (asTyped<Node>(source).kind === 'InvariantBlock') {
    const block = source as InvariantBlock;
    const name = nameOf(block.name);
    return {
      kind: 'invariant',
      entity: null,
      // The parser gives an anonymous `invariants { }` the empty name; that is
      // an absence, not a name.
      name: name === '' ? null : name,
      scope: block.scope === 'transaction' ? 'transaction' : 'global',
      predicates: conjunction(block.predicates ?? []),
      gaps: [],
    };
  }

  const entity = source as Entity;
  return {
    kind: 'invariant',
    entity: nameOf(entity.name),
    name: null,
    scope: 'unspecified',
    predicates: conjunction(entity.invariants ?? []),
    gaps: sortGaps([
      {
        construct: 'invariant.name',
        reason: 'not-in-grammar',
        detail:
          'an entity `invariants { }` block is anonymous; there is no name to cite in a violation.',
      },
      {
        construct: 'invariant.scope',
        reason: 'not-in-grammar',
        detail:
          'an entity `invariants { }` block has no scope keyword; global vs transaction is unsaid.',
      },
    ]),
  };
}
