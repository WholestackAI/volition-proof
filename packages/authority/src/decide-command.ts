/**
 * decideCommand — pure authority vote before a tool or behavior runs.
 *
 * Evaluates typed AppContract clauses. Does not special-case payload.amount.
 * Fail closed on unrepresented predicates. No IO. No model.
 */
import type {
  AppContract,
  Clause,
  CompareOp,
  NormalizedExpression,
} from '@wholestack/app-contract';
import {
  evaluateEffectPolicies,
  inferEffectsFromAction,
  type EffectDescriptor,
} from './effect-authority.js';

export type AuthorityDecisionStatus = 'GRANTED' | 'DENIED' | 'ESCALATION_REQUIRED';

export type AuthorityDecisionCode =
  | 'GRANTED'
  | 'UNKNOWN_ACTION'
  | 'ROLE_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'LOCKED_PATH'
  | 'TEST_MANIPULATION'
  | 'UNREPRESENTED_PREDICATE'
  | 'PRECONDITION_FAILED'
  | 'REFUND_LIMIT_EXCEEDED'
  | 'COERCED_INTENT'
  | 'UNLISTED_TOOL'
  | 'COMMAND_NOT_LEASED'
  | 'TENANT_DENIED'
  | 'EXPIRED_LEASE'
  | 'EFFECT_PROHIBITED'
  | 'UNAUTHORIZED_EGRESS'
  | 'COVERT_CHANNEL_DETECTED'
  | 'IMMUTABLE_GOVERNOR_VIOLATION'
  | 'SWARM_AMPLIFICATION_DENIED';

export interface DecideCommandActor {
  id: string;
  roles: readonly string[];
  tenantId?: string;
}

/** Structural slice of AuthoritySession — avoid a circular import with index.ts. */
export interface DecideCommandSession {
  expiresAt: string;
  revokedAt?: string;
  authorizedCommands?: readonly string[];
  tenantId?: string;
}

export interface DecideCommandEvidence {
  boundProposalHash?: string | null;
  prompted?: Record<string, unknown>;
  requireApproval?: boolean;
  allowLocked?: boolean;
  /** ISO timestamp; expired leases fail closed. */
  leaseExpiresAt?: string;
  /** Graph session / capability lease. Child commands cannot exceed the lookup. */
  session?: DecideCommandSession;
}

/** Structural slice of AuthorityGraph — avoid a circular import with index.ts. */
export interface AuthorityLookup {
  get(id: string): {
    tenantId: string;
    role: string;
    /** When set, decideCommand uses this set instead of the single `role`. */
    roles?: readonly string[];
    parentId?: string;
    entitlements?: { permissions?: readonly string[] };
  } | undefined;
}

export interface DecideCommandInput {
  contract: AppContract;
  actor: DecideCommandActor;
  action: string;
  args: Record<string, unknown>;
  state?: Record<string, unknown>;
  evidence?: DecideCommandEvidence;
  graph?: AuthorityLookup;
  effects?: readonly EffectDescriptor[];
}

export interface AuthorityDecision {
  status: AuthorityDecisionStatus;
  allowed: boolean;
  code: AuthorityDecisionCode;
  clauseIds: string[];
  reason: string;
  requested?: number;
  maximum?: number;
}

const RANK: Record<AuthorityDecisionStatus, number> = {
  GRANTED: 0,
  ESCALATION_REQUIRED: 1,
  DENIED: 2,
};

const AUTHORITY_PATH = /(?:\.isl$|intent-lock\.json$|intent\.lock\.json$)/i;
const TEST_PATH = /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/i;

function granted(clauseIds: string[] = []): AuthorityDecision {
  return {
    status: 'GRANTED',
    allowed: true,
    code: 'GRANTED',
    clauseIds,
    reason: 'All applicable clauses held.',
  };
}

function decision(
  status: AuthorityDecisionStatus,
  code: AuthorityDecisionCode,
  reason: string,
  clauseIds: string[] = [],
  extra: Partial<AuthorityDecision> = {},
): AuthorityDecision {
  return {
    status,
    allowed: false,
    code,
    clauseIds,
    reason,
    ...extra,
  };
}

function norm(value: string): string {
  return value.replace(/[-_]/g, '').toLowerCase();
}

function rolesMatch(have: readonly string[], need: string): boolean {
  const wanted = need.replace(/^["']|["']$/g, '');
  return have.some((role) => norm(role) === norm(wanted));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function lookup(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (current == null) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function envLookup(
  path: readonly string[],
  args: Record<string, unknown>,
  state: Record<string, unknown>,
  actor: DecideCommandActor,
): unknown {
  if (path.length === 0) return undefined;
  const [head, ...rest] = path;
  if (head === 'input' || head === 'args') return lookup(args, rest);
  if (head === 'state' || head === 'row') return lookup(state, rest.length ? rest : path);
  if (head === 'ctx' || head === 'actor') {
    const bag = { userId: actor.id, actorId: actor.id, role: actor.roles[0], roles: actor.roles, tenantId: actor.tenantId };
    return lookup(bag, rest);
  }
  if (head === 'content' && rest[0] === 'length') {
    const content = args.content;
    return typeof content === 'string' ? content.length : undefined;
  }
  if (rest.length === 1 && rest[0] === 'length') {
    const value = args[head!] ?? state[head!];
    if (typeof value === 'string' || Array.isArray(value)) return value.length;
  }
  if (Object.prototype.hasOwnProperty.call(args, head!)) return lookup(args, rest.length ? [head!, ...rest] : [head!]);
  if (Object.prototype.hasOwnProperty.call(state, head!)) return lookup(state, rest.length ? [head!, ...rest] : [head!]);
  return lookup({ ...state, ...args }, path);
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 'false') return false;
  if (value === 1 || value === 'true') return true;
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

type EvalResult =
  | { ok: true; value: unknown }
  | { ok: false; code: 'UNREPRESENTED_PREDICATE' | 'PRECONDITION_FAILED'; astKind?: string };

function evalExpr(
  expr: NormalizedExpression,
  args: Record<string, unknown>,
  state: Record<string, unknown>,
  actor: DecideCommandActor,
): EvalResult {
  switch (expr.node) {
    case 'unrepresented':
      return { ok: false, code: 'UNREPRESENTED_PREDICATE', astKind: expr.astKind };
    case 'null':
      return { ok: true, value: null };
    case 'boolean':
      return { ok: true, value: expr.value };
    case 'string':
      return { ok: true, value: expr.value };
    case 'number':
      return expr.number.value == null
        ? { ok: false, code: 'UNREPRESENTED_PREDICATE', astKind: 'NumberLiteral' }
        : { ok: true, value: expr.number.value };
    case 'ref':
      return { ok: true, value: envLookup(expr.path, args, state, actor) };
    case 'not': {
      const inner = evalExpr(expr.operand, args, state, actor);
      if (!inner.ok) return inner;
      const flag = asBoolean(inner.value);
      if (flag === undefined) return { ok: false, code: 'UNREPRESENTED_PREDICATE', astKind: 'not' };
      return { ok: true, value: !flag };
    }
    case 'logical': {
      if (expr.op === 'and') {
        for (const operand of expr.operands) {
          const inner = evalPredicate(operand, args, state, actor);
          if (!inner.ok) return inner;
          if (inner.value !== true) return { ok: true, value: false };
        }
        return { ok: true, value: true };
      }
      let unrepresented: EvalResult | null = null;
      for (const operand of expr.operands) {
        const inner = evalPredicate(operand, args, state, actor);
        if (!inner.ok) {
          unrepresented = inner;
          continue;
        }
        if (inner.value === true) return { ok: true, value: true };
      }
      return unrepresented ?? { ok: true, value: false };
    }
    case 'compare':
      return evalCompare(expr, args, state, actor);
    case 'call':
      return evalCall(expr, args, state, actor);
    case 'list': {
      const items: unknown[] = [];
      for (const item of expr.items) {
        const inner = evalExpr(item, args, state, actor);
        if (!inner.ok) return inner;
        items.push(inner.value);
      }
      return { ok: true, value: items };
    }
    default: {
      const _never: never = expr;
      return { ok: false, code: 'UNREPRESENTED_PREDICATE', astKind: String(_never) };
    }
  }
}

function evalPredicate(
  expr: NormalizedExpression,
  args: Record<string, unknown>,
  state: Record<string, unknown>,
  actor: DecideCommandActor,
): EvalResult {
  if (expr.node === 'compare' || expr.node === 'not' || expr.node === 'logical' || expr.node === 'call') {
    const inner = evalExpr(expr, args, state, actor);
    if (!inner.ok) return inner;
    const flag = asBoolean(inner.value);
    if (flag === undefined) return { ok: false, code: 'UNREPRESENTED_PREDICATE', astKind: expr.node };
    return { ok: true, value: flag };
  }
  const inner = evalExpr(expr, args, state, actor);
  if (!inner.ok) return inner;
  const flag = asBoolean(inner.value);
  if (flag === undefined) return { ok: false, code: 'UNREPRESENTED_PREDICATE', astKind: expr.node };
  return { ok: true, value: flag };
}

function compareOp(op: CompareOp, left: unknown, right: unknown): boolean | undefined {
  const ln = asNumber(left);
  const rn = asNumber(right);
  if (ln !== undefined && rn !== undefined) {
    switch (op) {
      case '==':
        return ln === rn;
      case '!=':
        return ln !== rn;
      case '<':
        return ln < rn;
      case '<=':
        return ln <= rn;
      case '>':
        return ln > rn;
      case '>=':
        return ln >= rn;
    }
  }
  const ls = asString(left);
  const rs = asString(right);
  if (ls !== undefined && rs !== undefined) {
    switch (op) {
      case '==':
        return ls === rs;
      case '!=':
        return ls !== rs;
      case '<':
        return ls < rs;
      case '<=':
        return ls <= rs;
      case '>':
        return ls > rs;
      case '>=':
        return ls >= rs;
    }
  }
  const lb = asBoolean(left);
  const rb = asBoolean(right);
  if (lb !== undefined && rb !== undefined) {
    return op === '!=' ? lb !== rb : lb === rb;
  }
  if (op === '==') return left === right;
  if (op === '!=') return left !== right;
  return undefined;
}

function evalCompare(
  expr: Extract<NormalizedExpression, { node: 'compare' }>,
  args: Record<string, unknown>,
  state: Record<string, unknown>,
  actor: DecideCommandActor,
): EvalResult {
  const left = evalExpr(expr.left, args, state, actor);
  if (!left.ok) return left;
  const right = evalExpr(expr.right, args, state, actor);
  if (!right.ok) return right;
  const value = compareOp(expr.op, left.value, right.value);
  if (value === undefined) return { ok: false, code: 'UNREPRESENTED_PREDICATE', astKind: 'compare' };
  return { ok: true, value };
}

function evalCall(
  expr: Extract<NormalizedExpression, { node: 'call' }>,
  args: Record<string, unknown>,
  state: Record<string, unknown>,
  actor: DecideCommandActor,
): EvalResult {
  const fn = expr.fn;
  if (fn === 'matches' || fn.endsWith('.matches')) {
    const objectPath = fn.endsWith('.matches') ? fn.slice(0, -'.matches'.length).split('.') : [];
    const target =
      objectPath.length > 0
        ? envLookup(objectPath, args, state, actor)
        : evalExpr(expr.args[0]!, args, state, actor);
    const patternSource =
      objectPath.length > 0
        ? evalExpr(expr.args[0]!, args, state, actor)
        : evalExpr(expr.args[1]!, args, state, actor);
    const text = asString(objectPath.length > 0 ? target : (target as EvalResult).ok ? (target as { value: unknown }).value : undefined);
    if (objectPath.length === 0) {
      if (!('ok' in (target as EvalResult)) || !(target as EvalResult).ok) return target as EvalResult;
    }
    if (!patternSource.ok) return patternSource;
    const pattern = asString(patternSource.value);
    const haystack = objectPath.length > 0 ? asString(target) : asString((target as { ok: true; value: unknown }).value);
    if (haystack === undefined || pattern === undefined) {
      return { ok: false, code: 'UNREPRESENTED_PREDICATE', astKind: 'matches' };
    }
    try {
      return { ok: true, value: new RegExp(pattern).test(haystack) };
    } catch {
      return { ok: false, code: 'UNREPRESENTED_PREDICATE', astKind: 'matches' };
    }
  }
  if (fn === 'length' || fn.endsWith('.length')) {
    const inner = fn === 'length' ? evalExpr(expr.args[0]!, args, state, actor) : { ok: true as const, value: envLookup(fn.slice(0, -'.length'.length).split('.'), args, state, actor) };
    if (!inner.ok) return inner;
    const value = inner.value;
    if (typeof value === 'string' || Array.isArray(value)) return { ok: true, value: value.length };
    return { ok: false, code: 'UNREPRESENTED_PREDICATE', astKind: 'length' };
  }
  if (fn === 'in') {
    const left = evalExpr(expr.args[0]!, args, state, actor);
    if (!left.ok) return left;
    const right = evalExpr(expr.args[1]!, args, state, actor);
    if (!right.ok) return right;
    if (!Array.isArray(right.value)) return { ok: false, code: 'UNREPRESENTED_PREDICATE', astKind: 'in' };
    return { ok: true, value: right.value.some((item) => item === left.value) };
  }
  return { ok: false, code: 'UNREPRESENTED_PREDICATE', astKind: fn };
}

function extractCompareBounds(
  expr: NormalizedExpression,
  args: Record<string, unknown>,
  state: Record<string, unknown>,
  actor: DecideCommandActor,
): { requested?: number; maximum?: number } {
  if (expr.node === 'logical') {
    for (const operand of expr.operands) {
      const nested = extractCompareBounds(operand, args, state, actor);
      if (nested.maximum !== undefined) return nested;
    }
    return {};
  }
  if (expr.node === 'not') return extractCompareBounds(expr.operand, args, state, actor);
  if (expr.node !== 'compare') return {};
  const left = evalExpr(expr.left, args, state, actor);
  const right = evalExpr(expr.right, args, state, actor);
  if (!left.ok || !right.ok) return {};
  const ln = asNumber(left.value);
  const rn = asNumber(right.value);
  if (ln === undefined || rn === undefined) return {};
  if (expr.left.node === 'ref') return { requested: ln, maximum: expr.op === '<=' || expr.op === '<' ? rn : undefined };
  if (expr.right.node === 'ref') return { requested: rn, maximum: expr.op === '>=' || expr.op === '>' ? ln : undefined };
  return { requested: ln, maximum: rn };
}

function clauseBehaviorName(clause: Clause): string | null {
  const semantic = clause.semantic;
  if (!semantic) return null;
  if (semantic.kind === 'behavior') return semantic.behavior;
  if (semantic.kind === 'precondition' || semantic.kind === 'postcondition' || semantic.kind === 'behavior-security') {
    return semantic.behavior;
  }
  return null;
}

function actionMatches(action: string, name: string): boolean {
  return norm(action) === norm(name);
}

function behaviorClauses(contract: AppContract, action: string): Clause[] {
  return contract.clauses.filter((clause) => {
    const name = clauseBehaviorName(clause);
    if (name && actionMatches(action, name)) return true;
    if (clause.kind === 'behavior' && actionMatches(action, clause.id.replace(/^behavior:/, ''))) return true;
    return false;
  });
}

function securityText(expr: NormalizedExpression): string {
  if (expr.node === 'ref') return expr.path.join('.');
  if (expr.node === 'string') return expr.value;
  return '';
}

export function commandRequiresApproval(contract: AppContract, action: string, requireApproval?: boolean): boolean {
  if (requireApproval) return true;
  const clauses = behaviorClauses(contract, action);
  return clauses.some((clause) => {
    if (clause.kind !== 'behavior-security' || clause.semantic?.kind !== 'behavior-security') return false;
    if (clause.semantic.requirementType === 'requireRole') return false;
    if (clause.semantic.requirementType === 'requires') {
      return /^approval$/i.test(securityText(clause.semantic.requirement));
    }
    return /approv/i.test(clause.semantic.requirementType);
  });
}

function moreRestrictive(left: AuthorityDecision, right: AuthorityDecision): AuthorityDecision {
  return RANK[right.status] > RANK[left.status] ? right : left;
}

function mergeActor(
  input: DecideCommandInput,
): DecideCommandActor & { denied?: AuthorityDecision } {
  const actor: DecideCommandActor = { ...input.actor, roles: [...input.actor.roles] };
  if (!input.graph) return actor;
  const principal = input.graph.get(actor.id);
  if (!principal) return actor;
  if (actor.tenantId && principal.tenantId !== actor.tenantId) {
    return {
      ...actor,
      denied: decision(
        'DENIED',
        'TENANT_DENIED',
        `DENIED — tenant ${actor.tenantId} does not match principal tenant ${principal.tenantId}.`,
        [],
      ),
    };
  }
  // Graph is the grant. Claimed extras the lookup did not grant are dropped.
  return {
    ...actor,
    tenantId: actor.tenantId ?? principal.tenantId,
    roles: principal.roles && principal.roles.length > 0 ? [...principal.roles] : [principal.role],
  };
}

function leaseExpired(expiresAt: string, nowMs: number): boolean {
  const ms = Date.parse(expiresAt);
  return !Number.isFinite(ms) || nowMs >= ms;
}

function decideLease(
  input: DecideCommandInput,
  actor: DecideCommandActor,
): AuthorityDecision | undefined {
  const evidence = input.evidence;
  const session = evidence?.session;
  if (session?.tenantId && actor.tenantId && session.tenantId !== actor.tenantId) {
    return decision(
      'DENIED',
      'TENANT_DENIED',
      `DENIED — session tenant ${session.tenantId} does not match actor tenant ${actor.tenantId}.`,
    );
  }
  if (session?.revokedAt) {
    return decision(
      'DENIED',
      'EXPIRED_LEASE',
      `DENIED EXPIRED_LEASE — session revoked at ${session.revokedAt}.`,
    );
  }
  const nowMs = Date.now();
  const expiryStamps = [session?.expiresAt, evidence?.leaseExpiresAt].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  for (const expiresAt of expiryStamps) {
    if (leaseExpired(expiresAt, nowMs)) {
      return decision(
        'DENIED',
        'EXPIRED_LEASE',
        `DENIED EXPIRED_LEASE — lease expired at ${expiresAt}.`,
      );
    }
  }
  const principal = input.graph?.get(actor.id);
  const granted = principal?.entitlements?.permissions;
  if (granted && session?.authorizedCommands) {
    const extra = session.authorizedCommands.filter(
      (command) => !granted.some((permission) => actionMatches(command, permission)),
    );
    if (extra.length > 0) {
      return decision(
        'DENIED',
        'COMMAND_NOT_LEASED',
        `DENIED COMMAND_NOT_LEASED — child commands [${extra.join(',')}] are not granted by the authority lookup.`,
      );
    }
  }
  return decideAttenuation(input, actor);
}

/** ChildAuthority ⊆ ParentAuthority. Runs only when a graph lookup is present. */
function decideAttenuation(
  input: DecideCommandInput,
  actor: DecideCommandActor,
): AuthorityDecision | undefined {
  const graph = input.graph;
  if (!graph) return undefined;
  const child = graph.get(actor.id);
  if (!child) return undefined;
  const childPerms = child.entitlements?.permissions;
  if (child.parentId) {
    const parent = graph.get(child.parentId);
    if (!parent) {
      return decision(
        'DENIED',
        'COMMAND_NOT_LEASED',
        `DENIED COMMAND_NOT_LEASED — parent ${child.parentId} is not in the authority lookup.`,
      );
    }
    if (child.tenantId !== parent.tenantId) {
      return decision(
        'DENIED',
        'TENANT_DENIED',
        `DENIED — child tenant ${child.tenantId} does not match parent tenant ${parent.tenantId}.`,
      );
    }
    const parentPerms = parent.entitlements?.permissions ?? [];
    const extra = (childPerms ?? []).filter(
      (command) => !parentPerms.some((permission) => actionMatches(command, permission)),
    );
    if (extra.length > 0) {
      return decision(
        'DENIED',
        'COMMAND_NOT_LEASED',
        `DENIED COMMAND_NOT_LEASED — child commands [${extra.join(',')}] exceed parent ${parent.role}.`,
      );
    }
  }
  if (childPerms) {
    if (!childPerms.some((permission) => actionMatches(input.action, permission))) {
      return decision(
        'DENIED',
        'COMMAND_NOT_LEASED',
        `DENIED COMMAND_NOT_LEASED — action "${input.action}" is not granted by the authority graph.`,
      );
    }
  }
  return undefined;
}

function decideLeasedCommand(
  action: string,
  session: DecideCommandSession | undefined,
  clauseIds: string[],
): AuthorityDecision | undefined {
  if (!session?.authorizedCommands) return undefined;
  if (session.authorizedCommands.some((command) => actionMatches(action, command))) return undefined;
  return decision(
    'DENIED',
    'COMMAND_NOT_LEASED',
    `DENIED COMMAND_NOT_LEASED — action "${action}" is not in the leased command set.`,
    clauseIds,
  );
}

function pathArg(args: Record<string, unknown>): string {
  return asString(args.path) ?? asString(args.file) ?? asString(args.filename) ?? '';
}

function decideAgainstBinding(input: DecideCommandInput, args: Record<string, unknown>): AuthorityDecision {
  const { contract, action, evidence } = input;
  const state = input.state ?? {};
  const actor = mergeActor(input);
  if (actor.denied) return actor.denied;
  const lease = decideLease(input, actor);
  if (lease) return lease;
  const applied = behaviorClauses(contract, action);
  const behavior = applied.find((clause) => clause.kind === 'behavior');
  if (!behavior) {
    return decision('DENIED', 'UNKNOWN_ACTION', `Unknown action "${action}".`, []);
  }

  const clauseIds: string[] = [behavior.id];
  const leased = decideLeasedCommand(action, evidence?.session, clauseIds);
  if (leased) return leased;

  for (const clause of applied) {
    if (clause.kind !== 'behavior-security' || clause.semantic?.kind !== 'behavior-security') continue;
    clauseIds.push(clause.id);
    if (clause.semantic.requirementType === 'requireRole') {
      const role = securityText(clause.semantic.requirement);
      if (!rolesMatch(actor.roles, role)) {
        return decision(
          'DENIED',
          'ROLE_DENIED',
          `DENIED — actor roles [${actor.roles.join(',')}] miss required role ${role}.`,
          [clause.id, behavior.id],
        );
      }
    }
  }

  if ((actionMatches(action, 'write_file') || actionMatches(action, 'edit_file')) && AUTHORITY_PATH.test(pathArg(args)) && !evidence?.allowLocked) {
    return decision(
      'DENIED',
      'LOCKED_PATH',
      `DENIED LOCKED_PATH — cannot modify authority artifact ${pathArg(args)}.`,
      clauseIds,
    );
  }

  if (
    (actionMatches(action, 'write_file') || actionMatches(action, 'edit_file')) &&
    TEST_PATH.test(pathArg(args)) &&
    asString(args.content) === ''
  ) {
    return decision(
      'DENIED',
      'TEST_MANIPULATION',
      `DENIED TEST_MANIPULATION — emptying ${pathArg(args)} is forbidden.`,
      clauseIds,
    );
  }

  const inferredEffects = input.effects ?? inferEffectsFromAction(action, args);
  if (inferredEffects.length > 0) {
    const effectEval = evaluateEffectPolicies(inferredEffects, [], {
      allowLocked: evidence?.allowLocked,
      boundProposalHash: evidence?.boundProposalHash,
    });
    if (!effectEval.allowed) {
      return decision(
        effectEval.status,
        effectEval.code,
        effectEval.reason ?? `DENIED ${effectEval.code}`,
        clauseIds,
      );
    }
  }

  for (const clause of applied) {
    if (clause.kind !== 'precondition' || clause.semantic?.kind !== 'precondition') continue;
    clauseIds.push(clause.id);
    const result = evalPredicate(clause.semantic.predicate, args, state, actor);
    if (!result.ok && result.code === 'UNREPRESENTED_PREDICATE') {
      return decision(
        'DENIED',
        'UNREPRESENTED_PREDICATE',
        `DENIED — predicate cannot be evaluated (${result.astKind ?? 'unrepresented'}).`,
        [clause.id],
      );
    }
    if (!result.ok || result.value === false) {
      const bounds = extractCompareBounds(clause.semantic.predicate, args, state, actor);
      const refund = actionMatches(action, 'refund');
      const code: AuthorityDecisionCode = refund && bounds.maximum !== undefined ? 'REFUND_LIMIT_EXCEEDED' : 'PRECONDITION_FAILED';
      const reason = refund && bounds.requested !== undefined && bounds.maximum !== undefined
        ? `DENIED REFUND_LIMIT_EXCEEDED requested: ${bounds.requested} maximum: ${bounds.maximum}`
        : `DENIED PRECONDITION_FAILED — ${clause.title}`;
      return decision('DENIED', code, reason, [clause.id], bounds);
    }
  }

  // Approval after predicates: an over-cap payload is DENIED, not merely escalated.
  if (commandRequiresApproval(contract, action, evidence?.requireApproval) && !evidence?.boundProposalHash) {
    const approvalClause = applied.find((clause) => {
      if (clause.kind !== 'behavior-security' || clause.semantic?.kind !== 'behavior-security') return false;
      return (
        clause.semantic.requirementType !== 'requireRole' &&
        (/approv/i.test(clause.semantic.requirementType) || /^approval$/i.test(securityText(clause.semantic.requirement)))
      );
    });
    return decision(
      'ESCALATION_REQUIRED',
      'APPROVAL_REQUIRED',
      'Execution requires evidence-bound approval, not a prompt string.',
      approvalClause ? [approvalClause.id, behavior.id] : clauseIds,
    );
  }

  return granted(clauseIds);
}

export function decideCommand(input: DecideCommandInput): AuthorityDecision {
  const args = asRecord(input.args);
  const primary = decideAgainstBinding(input, args);
  const prompted = input.evidence?.prompted;
  if (!prompted) return primary;
  const overlay = decideAgainstBinding(input, { ...args, ...asRecord(prompted) });
  if (RANK[overlay.status] > RANK[primary.status]) {
    return {
      ...overlay,
      code: overlay.status === 'DENIED' ? 'COERCED_INTENT' : overlay.code,
      reason: `Prompted intent is more restrictive than tool args. ${overlay.reason}`,
    };
  }
  return moreRestrictive(primary, overlay);
}
