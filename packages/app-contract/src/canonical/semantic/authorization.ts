/**
 * Group C — the authorization payloads: `role`, `permission`, `policy`,
 * `behavior-security`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUG THIS MODULE EXISTS TO CLOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * `securityToIsl` (`from-isl.ts:452-457`) reads `x.requirement ?? x.kind`,
 * `x.expression` and `x.value`. The node it is handed is
 *
 *     SecuritySpec { kind: "SecuritySpec", type: "requires" | "rate_limit" |
 *                    "fraud_check", details: Expression }        (ast.ts:340)
 *
 * None of those three field names exist on it. `x.requirement` is `undefined`,
 * so `?? x.kind` wins and returns the literal AST discriminant; `x.expression`
 * and `x.value` are `undefined`, so the detail is empty. Every security clause
 * in the corpus therefore renders the same constant string, `requires
 * SecuritySpec` — measured at 95 clauses, exactly 1 distinct excerpt.
 *
 * That is not merely lossy. The clause id is `behavior-security:<Name>:<digest
 * of the excerpt>`, so a constant excerpt gives a constant digest, which gives a
 * constant id, and `from-isl.ts:605` de-duplicates on id: EVERY security spec
 * after the first on a behavior is silently dropped. A behavior written as
 *
 *     security { requires authenticated  rate_limit 10.per_minute }
 *
 * produces one clause, and it is indistinguishable from a behavior that says
 * `requires anonymous`.
 *
 * The payloads below read `type` and `details`, keep `requirementType` separate
 * from `requirement` (a hard gate and a throttle must never be the same fact),
 * and give two specs on one behavior two different payloads.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OTHER THREE
 * ─────────────────────────────────────────────────────────────────────────────
 * `policy` — 9 of 11 measured mutations were invisible: the excerpt is
 * `policy <Name>` and the rules live as English prose in `title`. Allow↔deny,
 * `==` → `!=`, `ctx.userId` → `ctx.tenantId`, `applies_to: Lead` → `all`, and
 * deleting every rule all left the contract hash untouched.
 *
 * `permission` — already strong (the excerpt carries the whole `RoleExpr`), with
 * two holes. Role ORDER moved the hash for no reason (a false positive, which
 * trains people to ignore diffs), and what `owner` BINDS to was absent, so
 * renaming `Lead.ownerId` to `accountId` left the grant byte-identical while
 * breaking it.
 *
 * `role` — faithful, because the grammar is empty: `RoleDecl` has exactly one
 * member, `name`. That emptiness is recorded as a gap rather than passed off as
 * completeness.
 *
 * Pure: no fs, no clock, no randomness, no network.
 */
import type {
  Annotation,
  Entity,
  Expression,
  PermissionRule,
  Policy,
  RoleDecl,
  SecuritySpec,
} from '@isl-lang/parser';

import {
  compareExpressions,
  numeric,
  orientComparison,
  sortedSet,
  type AccessScope,
  type ClauseSemantic,
  type CompareOp,
  type NormalizedExpression,
  type ProjectionGap,
} from '../semantic.js';
import { AUTHORIZATION_OWNER_FIELD, resolveAuthorizationOwnerField } from './owner-field.js';

type RoleSemantic = Extract<ClauseSemantic, { kind: 'role' }>;
type PermissionSemantic = Extract<ClauseSemantic, { kind: 'permission' }>;
type PolicySemantic = Extract<ClauseSemantic, { kind: 'policy' }>;
type BehaviorSecuritySemantic = Extract<ClauseSemantic, { kind: 'behavior-security' }>;

type PolicyRuleSemantic = { condition: NormalizedExpression | null; effect: 'allow' | 'deny' };

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------

/** Deterministic order and no duplicates — gaps are hashed like everything else. */
function normalizeGaps(gaps: readonly ProjectionGap[]): ProjectionGap[] {
  const seen = new Map<string, ProjectionGap>();
  for (const gap of gaps) {
    seen.set(`${gap.construct} ${gap.reason} ${gap.detail ?? ''}`, gap);
  }
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, gap]) => gap);
}

// ---------------------------------------------------------------------------
// Expression normalization — LOCAL FALLBACK
// ---------------------------------------------------------------------------

/**
 * TODO(group-b): replace with `normalizeExpression` from `./behavior.js` once
 * that module lands, and delete everything down to the next section rule.
 *
 * This is a deliberately narrow stand-in covering only the shapes that reach a
 * policy condition or a security requirement: paths, comparisons, `and`/`or`,
 * `not`, literals, calls and lists. It is NOT a second general normalizer —
 * anything outside that set becomes `{node:'unrepresented'}` and is reported as
 * a gap by the caller.
 *
 * When the switch happens, keep the gap collection: unrepresented nodes and
 * number literals have to stay countable, and a drop-in that returns only an
 * expression would silently lose that.
 */
interface NormalizeResult {
  expression: NormalizedExpression;
  /** AST kinds this projection could not carry. Drives `not-projected` gaps. */
  unrepresented: string[];
  /**
   * A `NumberLiteral` was projected. `NumberLiteral` is `{value: number}` with
   * no source text (ast.ts:653), so the written form is already gone by the time
   * the projector sees it: `20000` and `20000.00` cannot be told apart here.
   */
  sawNumberLiteral: boolean;
}

const COMPARISONS = new Set<string>(['==', '!=', '<', '<=', '>', '>=']);

type Node = Record<string, unknown>;

function asNode(value: unknown): Node {
  return value as Node;
}

function asNodeOrUndefined(value: unknown): Node | undefined {
  return value == null ? undefined : asNode(value);
}

function isRef(e: NormalizedExpression): e is Extract<NormalizedExpression, { node: 'ref' }> {
  return e.node === 'ref';
}

/** Flatten `(a and b) and c` into one operand list. `and`/`or` are associative. */
function flatten(
  op: 'and' | 'or',
  expression: NormalizedExpression,
  into: NormalizedExpression[],
): void {
  if (expression.node === 'logical' && expression.op === op) {
    for (const operand of expression.operands) flatten(op, operand, into);
    return;
  }
  into.push(expression);
}

function normalizeExpressionLocal(expression: Expression | undefined): NormalizeResult {
  const unrepresented: string[] = [];
  let sawNumberLiteral = false;

  const walk = (e: Expression | undefined): NormalizedExpression => {
    if (!e || typeof e !== 'object') {
      unrepresented.push('missing');
      return { node: 'unrepresented', astKind: 'missing' };
    }
    const x = asNode(e);
    switch (x.kind) {
      case 'Identifier':
        return { node: 'ref', path: [String(x.name ?? '')] };

      case 'QualifiedName':
        return { node: 'ref', path: ((x.parts as { name: string }[]) ?? []).map((p) => p.name) };

      case 'MemberExpr': {
        const object = walk(x.object as Expression);
        const property = (x.property as { name?: string } | undefined)?.name ?? '';
        if (isRef(object)) return { node: 'ref', path: [...object.path, property] };
        // Member access over something that is not a path — `10.per_minute` is
        // how the lexer reports a rate limit. Carried as an operator
        // application rather than collapsed to `unrepresented`, because
        // `10.per_minute` and `100.per_minute` are different throttles and a
        // false negative is the dangerous direction. The leading `.` keeps it
        // impossible to confuse with a real call to a function named
        // `per_minute`.
        return { node: 'call', fn: `.${property}`, args: [object] };
      }

      case 'StringLiteral':
        return { node: 'string', value: String(x.value ?? '') };

      case 'NumberLiteral':
        sawNumberLiteral = true;
        return { node: 'number', number: numeric(String(x.value)) };

      case 'BooleanLiteral':
        return { node: 'boolean', value: Boolean(x.value) };

      case 'NullLiteral':
        return { node: 'null' };

      case 'BinaryExpr': {
        const op = String(x.operator ?? '');
        const left = walk(x.left as Expression);
        const right = walk(x.right as Expression);
        if (COMPARISONS.has(op)) return orientComparison(op as CompareOp, left, right);
        if (op === 'and' || op === 'or') {
          const operands: NormalizedExpression[] = [];
          flatten(op, left, operands);
          flatten(op, right, operands);
          return { node: 'logical', op, operands: operands.sort(compareExpressions) };
        }
        // Arithmetic, `in`, `implies`, `iff`. The union has no variant for
        // these; both operands are kept so `spent + fee` and `spent - fee` stay
        // different, and the shortfall is recorded as a gap.
        unrepresented.push(`BinaryExpr(${op})`);
        return { node: 'call', fn: op, args: [left, right] };
      }

      case 'UnaryExpr': {
        const op = String(x.operator ?? '');
        const operand = walk(x.operand as Expression);
        if (op === 'not') return { node: 'not', operand };
        unrepresented.push(`UnaryExpr(${op})`);
        return { node: 'call', fn: op, args: [operand] };
      }

      case 'CallExpr': {
        const callee = walk(x.callee as Expression);
        // Argument order is meaning — never sorted.
        const args = ((x.arguments as Expression[]) ?? []).map(walk);
        if (isRef(callee)) return { node: 'call', fn: callee.path.join('.'), args };
        unrepresented.push('CallExpr');
        return { node: 'unrepresented', astKind: 'CallExpr' };
      }

      case 'ListExpr':
        // Order preserved: `in [A, B]` and `in [B, A]` may differ.
        return { node: 'list', items: ((x.elements as Expression[]) ?? []).map(walk) };

      default: {
        const astKind = String(x.kind ?? 'unknown');
        unrepresented.push(astKind);
        return { node: 'unrepresented', astKind };
      }
    }
  };

  return { expression: walk(expression), unrepresented, sawNumberLiteral };
}

/** Turn one normalization's shortfalls into gaps under a construct path. */
function gapsFor(construct: string, result: NormalizeResult): ProjectionGap[] {
  const gaps: ProjectionGap[] = [];
  for (const astKind of result.unrepresented) {
    gaps.push({
      construct,
      reason: 'not-projected',
      detail: `${astKind} has no dedicated normalized form; the expression is carried without it`,
    });
  }
  if (result.sawNumberLiteral) {
    gaps.push({
      construct,
      reason: 'not-in-grammar',
      detail:
        'a number literal reached this expression; NumberLiteral carries no source text, so 20000 and 20000.00 cannot be distinguished here',
    });
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// role
// ---------------------------------------------------------------------------

/**
 * A role is a name and nothing else.
 *
 * `RoleDecl` (ast.ts:219) has exactly one member. There is no capability list,
 * no hierarchy, no description — what a role may actually do lives entirely in
 * the `permission` and `policy` clauses that name it. Two apps whose "manager"
 * means wildly different things hash identically here, and no projector change
 * can fix that, so it is recorded as a grammar gap rather than passed off as
 * completeness.
 */
export function roleSemantic(role: RoleDecl): RoleSemantic {
  return {
    kind: 'role',
    role: role.name?.name ?? '',
    gaps: normalizeGaps([
      {
        construct: 'role.capabilities',
        reason: 'not-in-grammar',
        detail:
          'RoleDecl carries only a name — no capabilities, hierarchy or description; what the role may do is stated only by the permissions and policies that mention it',
      },
    ]),
  };
}

// ---------------------------------------------------------------------------
// permission
// ---------------------------------------------------------------------------

/**
 * The column `owner` binds to.
 *
 * Same function the engine projector uses: the compiler slot `owner_user_id`,
 * else a historical `owner_id` / `user_id` that actually references a principal.
 * A business `owner_id` → Owner is not a bind.
 */
function resolveOwnerField(entity: Entity): string | null {
  return resolveAuthorizationOwnerField(entity);
}

/**
 * One `read|write|delete: <RoleExpr>` grant.
 *
 * The `RoleExpr` decomposition — roles / owner / related — is the same one
 * `engine/project.ts:296-321` already performs; this deliberately reuses that
 * reading rather than inventing a second one, so the contract layer and the
 * engine projector can never disagree about what a grant says.
 *
 * `roles` and `related` are sorted sets. `manager | owner` and `owner | manager`
 * are one grant; that they move the contract hash today is a false positive, and
 * a hash that cries wolf gets ignored. Set membership is meaning, order is not.
 *
 * `roles` is populated so a caller can finally build the edge from a permission
 * to a `role:*` clause. Nothing refs a role clause today, which is why
 * `zeta contract show role:manager` reports "0 statements depend on this" while
 * 18 permissions grant to it.
 */
export function permissionSemantic(entity: Entity, rule: PermissionRule): PermissionSemantic {
  const allow = rule.allow as
    { roles?: { name: string }[]; owner?: boolean; related?: { name: string }[] } | undefined;
  const roles = sortedSet((allow?.roles ?? []).map((r) => r.name ?? ''));
  const owner = Boolean(allow?.owner);
  const related = sortedSet((allow?.related ?? []).map((r) => r.name ?? ''));
  const ownerField = resolveOwnerField(entity);
  const entityName = entity.name?.name ?? '';

  const gaps: ProjectionGap[] = [];
  if (owner && ownerField === null) {
    // A silent authorization downgrade at the contract layer: the grant reads
    // as owner-scoped and there is no column for anything to check it against.
    // `project.ts:322` refuses to lower exactly this case; until this payload
    // existed the contract itself said nothing about it at all.
    gaps.push({
      construct: 'permission.owner',
      reason: 'not-in-grammar',
      detail: `grants ${rule.action} to owner, but ${entityName} declares no ${AUTHORIZATION_OWNER_FIELD} (or ownerId → User) column; ISL cannot state which column owner binds to, so the grant binds to nothing`,
    });
  }

  return {
    kind: 'permission',
    entity: entityName,
    action: rule.action,
    roles,
    owner,
    ownerField,
    related,
    ...((allow as { tenant?: boolean } | undefined)?.tenant ? { tenant: true } : {}),
    ...((allow as { none?: boolean } | undefined)?.none ? { none: true } : {}),
    gaps: normalizeGaps(gaps),
  };
}

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

/**
 * Column names that mean "the row's owner" — the same literal convention the
 * rest of the repo uses; see {@link resolveOwnerField}.
 */
const OWNER_COLUMNS = new Set(['ownerId', 'owner_id', 'owner_user_id', 'ownerUserId']);
/** `ctx.*` segments that mean "the person making the request". */
const ACTOR_SEGMENTS = new Set([
  'userId',
  'user_id',
  'actorId',
  'actor_id',
  'principalId',
  'principal_id',
]);
/** `ctx.*` segments that mean "the customer / organisation boundary". */
const TENANT_SEGMENTS = new Set([
  'tenantId',
  'tenant_id',
  'orgId',
  'org_id',
  'organizationId',
  'organization_id',
]);
/** `ctx.*` segments that mean "which role the requester holds". */
const ROLE_SEGMENTS = new Set(['role', 'roles']);

function eachNode(
  expression: NormalizedExpression,
  visit: (node: NormalizedExpression) => void,
): void {
  visit(expression);
  switch (expression.node) {
    case 'compare':
      eachNode(expression.left, visit);
      eachNode(expression.right, visit);
      return;
    case 'logical':
      for (const operand of expression.operands) eachNode(operand, visit);
      return;
    case 'not':
      eachNode(expression.operand, visit);
      return;
    case 'call':
      for (const arg of expression.args) eachNode(arg, visit);
      return;
    case 'list':
      for (const item of expression.items) eachNode(item, visit);
      return;
    default:
      return;
  }
}

function isCtx(e: NormalizedExpression, segments: Set<string>): boolean {
  return (
    e.node === 'ref' &&
    e.path.length >= 2 &&
    e.path[0] === 'ctx' &&
    segments.has(e.path[e.path.length - 1] ?? '')
  );
}

/**
 * Where the policy draws its line.
 *
 * Derived ONLY from equality between a row column and a `ctx.*` segment, in this
 * precedence:
 *
 *   owner    `<row>.ownerId == ctx.userId` — a depth-2 path whose last segment
 *            is the owner column, equated with the acting user.
 *   related  the same shape, but the row side reaches through a relationship
 *            (depth >= 3, e.g. `row.lead.ownerId`), so the decision is drawn on
 *            a different record than the one being accessed.
 *   tenant   equality against a `ctx.tenantId` / `ctx.orgId` style segment.
 *   role     any condition that reads `ctx.role` / `ctx.roles`.
 *   public   there is at least one rule, NO rule carries a condition, and every
 *            rule allows. That is not an inference — it is what the policy says.
 *   unspecified  everything else.
 *
 * Three deliberate refusals, because a wrong scope is worse than no scope:
 *
 *  - `!=` never classifies. `row.ownerId != ctx.userId` grants to everyone
 *    EXCEPT the owner; calling that "owner-scoped" would label an inversion as
 *    the thing it inverts.
 *  - a policy with rules but no recognised shape stays `unspecified` rather
 *    than defaulting to `public`. A guessed `public` is an invented widening.
 *  - `scope` is an advisory summary, for readers and for search. `rules` is the
 *    truth and is hashed alongside it; nothing may depend on `scope` alone.
 */
function deriveScope(rules: readonly PolicyRuleSemantic[]): AccessScope {
  let related = false;
  let tenant = false;
  let role = false;

  for (const rule of rules) {
    if (!rule.condition) continue;
    let owner = false;
    eachNode(rule.condition, (node) => {
      if (isCtx(node, ROLE_SEGMENTS)) role = true;
      if (node.node !== 'compare' || node.op !== '==') return;
      for (const [actorSide, rowSide] of [
        [node.left, node.right],
        [node.right, node.left],
      ] as const) {
        if (isCtx(actorSide, ACTOR_SEGMENTS) && rowSide.node === 'ref') {
          const last = rowSide.path[rowSide.path.length - 1] ?? '';
          if (rowSide.path.length === 2 && OWNER_COLUMNS.has(last)) owner = true;
          else if (rowSide.path.length >= 3) related = true;
        }
        if (isCtx(actorSide, TENANT_SEGMENTS) && rowSide.node === 'ref') tenant = true;
      }
    });
    if (owner) return 'owner';
  }

  if (related) return 'related';
  if (tenant) return 'tenant';
  if (role) return 'role';
  if (rules.length > 0 && rules.every((r) => !r.condition && r.effect === 'allow')) return 'public';
  return 'unspecified';
}

/** `allow` / `deny` as written. Anything else is not guessed at. */
function effectOf(action: Expression | undefined): 'allow' | 'deny' | null {
  const x = asNodeOrUndefined(action);
  const text =
    x?.kind === 'Identifier'
      ? String(x.name ?? '')
      : x?.kind === 'StringLiteral'
        ? String(x.value ?? '')
        : '';
  return text === 'allow' ? 'allow' : text === 'deny' ? 'deny' : null;
}

/**
 * A whole access policy: what it covers, its rules in order, and its catch-all.
 *
 * `appliesTo: null` means the policy applies to EVERYTHING. That is a widening,
 * not an absence — `applies_to: Lead` → `applies_to: all` turns a one-entity
 * rule into a global one, and it is one of the mutations that left the contract
 * hash untouched. The parser also defaults `PolicyTarget.target` to `"all"` when
 * the member is omitted entirely (`statement-parser.ts:2195`), so an unqualified
 * policy is global by construction and reads as `null` here too.
 *
 * `rules` keeps DECLARATION ORDER, because a policy is first-match-wins:
 * `owner: allow` then `default: deny` is the opposite of `default: deny` then
 * `owner: allow`. Unconditional rules stay in the list with `condition: null`,
 * so nothing is dropped; `otherwise` additionally names the effect of the first
 * unconditional rule, so "does this policy fail open?" is answerable without
 * walking the list. That duplication is derived from data already present and
 * cannot move independently of it.
 */
export function policySemantic(policy: Policy): PolicySemantic {
  const gaps: ProjectionGap[] = [];

  const target = policy.appliesTo?.target;
  let appliesTo: string | null = null;
  if (target !== undefined && target !== 'all') {
    const names = sortedSet(target.map((t) => t.name ?? ''));
    if (names.length === 0) {
      gaps.push({
        construct: 'policy.appliesTo',
        reason: 'not-projected',
        detail:
          'applies_to was written with no targets; recorded as global, which is the widest reading',
      });
    }
    // Several targets flatten to a sorted comma list: the payload field is a
    // single string, and the order the author listed them in is not meaning.
    appliesTo = names.length === 0 ? null : names.join(',');
  }

  const rules: PolicyRuleSemantic[] = (policy.rules ?? []).map((rule) => {
    let condition: NormalizedExpression | null = null;
    if (rule.condition) {
      const normalized = normalizeExpressionLocal(rule.condition);
      condition = normalized.expression;
      gaps.push(...gapsFor('policy.rules.condition', normalized));
    }
    const effect = effectOf(rule.action);
    if (effect === null) {
      const written = asNodeOrUndefined(rule.action)?.kind ?? 'missing';
      gaps.push({
        construct: 'policy.rules.effect',
        reason: 'not-projected',
        detail: `rule action (${String(written)}) is neither allow nor deny; recorded as deny, which fails closed`,
      });
    }
    return { condition, effect: effect ?? 'deny' };
  });

  const fallback = rules.find((rule) => rule.condition === null);

  return {
    kind: 'policy',
    policy: policy.name?.name ?? '',
    appliesTo,
    rules,
    otherwise: fallback ? fallback.effect : 'unspecified',
    scope: deriveScope(rules),
    gaps: normalizeGaps(gaps),
  };
}

// ---------------------------------------------------------------------------
// behavior-security
// ---------------------------------------------------------------------------

/**
 * One security requirement on a behavior.
 *
 * Reads `type` and `details` — the fields the node actually has. `type` lands in
 * `requirementType` and the expression in `requirement`, kept apart on purpose:
 * `requires authenticated` is a hard gate and `rate_limit authenticated` is a
 * throttle, and a payload that folded them together would repeat the original
 * bug in a new shape.
 *
 * Two producers feed this clause kind and both are handled here, because a
 * projector covering only one would leave the other with no payload at all:
 *
 *  - `SecuritySpec`, from a `security { … }` block.
 *  - `Annotation`, from the `[requireRole: "manager"]` behavior annotation that
 *    `from-isl.ts:432-447` also emits as `behavior-security`. Its
 *    `requirementType` is the annotation name.
 *
 * `behavior` is part of the payload, so the same requirement on two behaviors
 * stays two facts.
 */
export function behaviorSecuritySemantic(
  behavior: string,
  spec: SecuritySpec | Annotation,
): BehaviorSecuritySemantic {
  const gaps: ProjectionGap[] = [];

  if (spec.kind === 'SecuritySpec') {
    const normalized = normalizeExpressionLocal(spec.details);
    gaps.push(...gapsFor('behavior-security.requirement', normalized));
    return {
      kind: 'behavior-security',
      behavior,
      requirementType: spec.type,
      requirement: normalized.expression,
      gaps: normalizeGaps(gaps),
    };
  }

  const name = spec.name?.name ?? '';
  if (!spec.value) {
    gaps.push({
      construct: 'behavior-security.requirement',
      reason: 'not-projected',
      detail: `annotation [${name}] carries no value; there is nothing to require against`,
    });
    return {
      kind: 'behavior-security',
      behavior,
      requirementType: name,
      requirement: { node: 'null' },
      gaps: normalizeGaps(gaps),
    };
  }

  const normalized = normalizeExpressionLocal(spec.value);
  gaps.push(...gapsFor('behavior-security.requirement', normalized));
  return {
    kind: 'behavior-security',
    behavior,
    requirementType: name,
    requirement: normalized.expression,
    gaps: normalizeGaps(gaps),
  };
}
