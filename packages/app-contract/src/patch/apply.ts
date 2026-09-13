/**
 * Deterministic patch application.
 *
 * The pipeline is always the same: clone the AST → apply typed ops → unparse →
 * re-parse → re-project. Nothing is spliced into source text and nothing is
 * trusted: if the edited AST does not serialise to ISL the real parser accepts,
 * the patch is rejected whole. A patch is never partially applied.
 *
 * Locks are enforced against the *semantic diff*, not against the ops, so a
 * change that reaches a locked clause indirectly is caught just the same.
 */

import type {
  Domain,
  Entity,
  Expression,
  Identifier,
  LifecycleTransition,
  PermissionRule,
  RoleDecl,
  RoleExpr,
  SourceLocation,
  StringLiteral,
} from '@isl-lang/parser';
import { unparse } from '@isl-lang/parser';
import { expressionToIsl } from '../canonical/expression.js';
import { parseAppContract } from '../canonical/parse.js';
import type { AppContract, ClauseMeta, ContractMeta } from '../canonical/types.js';
import { defaultClauseMeta } from '../canonical/types.js';
import { analyzeImpact, type ImpactReport } from '../diff/impact.js';
import { diffContracts, type SemanticDiff } from '../diff/semantic-diff.js';
import {
  behaviorFragment,
  entityFragment,
  expressionFragment,
  fieldFragment,
  FragmentError,
  invariantFragment,
} from './fragment.js';
import type { ContractOp, SemanticPatch } from './ops.js';

const SYNTHETIC: SourceLocation = { file: 'patch', line: 0, column: 0, endLine: 0, endColumn: 0 };

type EnumTypeDefinition = {
  variants: { kind: string; name: Identifier; location: SourceLocation }[];
};
type NamedTypeRef = { name?: { parts?: { name: string }[] } };

function asEnumTypeDefinition(value: unknown): EnumTypeDefinition {
  return value as EnumTypeDefinition;
}

function asNamedTypeRef(value: unknown): NamedTypeRef {
  return value as NamedTypeRef;
}

function ident(name: string): Identifier {
  return { kind: 'Identifier', name, location: SYNTHETIC };
}

function str(value: string): StringLiteral {
  return { kind: 'StringLiteral', value, location: SYNTHETIC };
}

export class PatchError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'PatchError';
  }
}

export type ApplyResult =
  | {
      ok: true;
      contract: AppContract;
      diff: SemanticDiff;
      impact: ImpactReport;
    }
  | {
      ok: false;
      reason: 'invalid-op' | 'unparseable' | 'locked';
      /** Plain-English explanation shown to the user. */
      message: string;
      detail?: string;
      /** Populated when `reason` is `locked`. */
      lockViolations?: string[];
      diff?: SemanticDiff;
    };

export interface ApplyOptions {
  /**
   * Apply even though the change touches locked clauses. Only ever set after
   * the user has seen the semantic diff and explicitly approved it.
   */
  allowLocked?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// AST mutation

function findEntity(domain: Domain, name: string): Entity {
  const entity = domain.entities?.find((e) => e.name.name === name);
  if (!entity) throw new PatchError(`There is no “${name}” record type in this app.`);
  return entity;
}

function findBehavior(domain: Domain, name: string) {
  const behavior = domain.behaviors?.find((b) => b.name.name === name);
  if (!behavior) throw new PatchError(`There is no “${name}” action in this app.`);
  return behavior;
}

function enumDeclFor(domain: Domain, typeName: string) {
  const decl = domain.types?.find((t) => t.name.name === typeName);
  if (!decl || (decl.definition as { kind?: string }).kind !== 'EnumType') return undefined;
  return asEnumTypeDefinition(decl.definition);
}

function roleExpr(op: { roles: string[]; owner?: boolean; related?: string[] }): RoleExpr {
  return {
    kind: 'RoleExpr',
    roles: op.roles.map(ident),
    owner: Boolean(op.owner),
    ...(op.related?.length ? { related: op.related.map(ident) } : {}),
    location: SYNTHETIC,
  };
}

function applyOp(domain: Domain, op: ContractOp): void {
  switch (op.op) {
    case 'add-entity': {
      const entity = entityFragment(op.isl);
      if (domain.entities?.some((e) => e.name.name === entity.name.name)) {
        throw new PatchError(`“${entity.name.name}” already exists.`);
      }
      domain.entities = [...(domain.entities ?? []), entity];
      return;
    }
    case 'remove-entity': {
      findEntity(domain, op.entity);
      domain.entities = (domain.entities ?? []).filter((e) => e.name.name !== op.entity);
      return;
    }
    case 'add-field': {
      const entity = findEntity(domain, op.entity);
      const field = fieldFragment(op.isl);
      if (entity.fields?.some((f) => f.name.name === field.name.name)) {
        throw new PatchError(`${op.entity} already records ${field.name.name}.`);
      }
      entity.fields = [...(entity.fields ?? []), field];
      return;
    }
    case 'remove-field': {
      const entity = findEntity(domain, op.entity);
      if (!entity.fields?.some((f) => f.name.name === op.field)) {
        throw new PatchError(`${op.entity} does not record ${op.field}.`);
      }
      entity.fields = entity.fields.filter((f) => f.name.name !== op.field);
      return;
    }
    case 'add-role': {
      const existing = domain.roles?.roles ?? [];
      if (existing.some((r) => r.name.name === op.role)) return;
      const decl: RoleDecl = { kind: 'RoleDecl', name: ident(op.role), location: SYNTHETIC };
      domain.roles = {
        kind: 'RolesDecl',
        roles: [...existing, decl],
        location: domain.roles?.location ?? SYNTHETIC,
      };
      return;
    }
    case 'remove-role': {
      const existing = domain.roles?.roles ?? [];
      const next = existing.filter((r) => r.name.name !== op.role);
      if (next.length === existing.length) throw new PatchError(`There is no “${op.role}” role.`);
      domain.roles = {
        kind: 'RolesDecl',
        roles: next,
        location: domain.roles?.location ?? SYNTHETIC,
      };
      return;
    }
    case 'set-permission': {
      const entity = findEntity(domain, op.entity);
      const rule: PermissionRule = {
        kind: 'PermissionRule',
        action: op.action,
        allow: roleExpr(op),
        location: SYNTHETIC,
      };
      const rules = (entity.permissions?.rules ?? []).filter((r) => r.action !== op.action);
      entity.permissions = {
        kind: 'PermissionsBlock',
        rules: [...rules, rule],
        location: entity.permissions?.location ?? SYNTHETIC,
      };
      return;
    }
    case 'remove-permission': {
      const entity = findEntity(domain, op.entity);
      const rules = (entity.permissions?.rules ?? []).filter((r) => r.action !== op.action);
      if (!entity.permissions)
        throw new PatchError(`${op.entity} has no permission rules to remove.`);
      entity.permissions = { ...entity.permissions, rules };
      return;
    }
    case 'add-status': {
      const entity = findEntity(domain, op.entity);
      const field = entity.fields?.find((f) => f.name.name === op.field);
      if (!field) throw new PatchError(`${op.entity} has no ${op.field} field.`);
      const typeName = asNamedTypeRef(field.type)
        ?.name?.parts?.map((p) => p.name)
        .join('.');
      const enumDef = typeName ? enumDeclFor(domain, typeName) : undefined;
      if (!enumDef) throw new PatchError(`${op.entity}.${op.field} is not a status field.`);
      if (enumDef.variants.some((v) => v.name.name === op.status)) return;
      const variant = { kind: 'EnumVariant', name: ident(op.status), location: SYNTHETIC };
      const at = op.after ? enumDef.variants.findIndex((v) => v.name.name === op.after) : -1;
      if (at >= 0) enumDef.variants.splice(at + 1, 0, variant);
      else enumDef.variants.push(variant);
      return;
    }
    case 'set-terminal': {
      const entity = findEntity(domain, op.entity);
      const field = entity.fields?.find((f) => f.name.name === op.field);
      if (!field) throw new PatchError(`${op.entity} has no ${op.field} field.`);
      const typeName = asNamedTypeRef(field.type)
        ?.name?.parts?.map((p) => p.name)
        .join('.');
      const enumDef = typeName ? enumDeclFor(domain, typeName) : undefined;
      if (!enumDef) throw new PatchError(`${op.entity}.${op.field} is not a status field.`);
      const known = new Set(enumDef.variants.map((v) => v.name.name));
      for (const s of op.statuses) {
        if (!known.has(s)) throw new PatchError(`${op.entity}.${op.field} has no “${s}” status.`);
      }
      const others = (field.annotations ?? []).filter((a) => a.name.name !== 'terminal');
      field.annotations = [
        ...others,
        { kind: 'Annotation', name: ident('terminal'), value: str(op.statuses.join(', ')), location: SYNTHETIC },
      ];
      return;
    }
    case 'add-transition': {
      const entity = findEntity(domain, op.entity);
      const transitions = entity.lifecycle?.transitions ?? [];
      if (transitions.some((t) => t.from.name === op.from && t.to.name === op.to)) return;
      const transition: LifecycleTransition = {
        kind: 'LifecycleTransition',
        from: ident(op.from),
        to: ident(op.to),
        location: SYNTHETIC,
      };
      entity.lifecycle = {
        kind: 'LifecycleSpec',
        transitions: [...transitions, transition],
        location: entity.lifecycle?.location ?? SYNTHETIC,
      };
      return;
    }
    case 'remove-transition': {
      const entity = findEntity(domain, op.entity);
      const transitions = entity.lifecycle?.transitions ?? [];
      const next = transitions.filter((t) => !(t.from.name === op.from && t.to.name === op.to));
      if (next.length === transitions.length) {
        throw new PatchError(`${op.entity} has no ${op.from} → ${op.to} step to remove.`);
      }
      entity.lifecycle = {
        kind: 'LifecycleSpec',
        transitions: next,
        location: entity.lifecycle?.location ?? SYNTHETIC,
      };
      return;
    }
    case 'add-precondition': {
      const behavior = findBehavior(domain, op.behavior);
      const expression = expressionFragment(op.expression);
      const canonical = expressionToIsl(expression);
      const existing = behavior.preconditions ?? [];
      if (existing.some((p: Expression) => expressionToIsl(p) === canonical)) return;
      behavior.preconditions = [...existing, expression];
      return;
    }
    case 'remove-precondition': {
      const behavior = findBehavior(domain, op.behavior);
      const target = expressionToIsl(expressionFragment(op.expression));
      const existing = behavior.preconditions ?? [];
      const next = existing.filter((p: Expression) => expressionToIsl(p) !== target);
      if (next.length === existing.length) {
        throw new PatchError(`${op.behavior} does not have that condition.`);
      }
      behavior.preconditions = next;
      return;
    }
    case 'add-behavior': {
      const behavior = behaviorFragment(op.isl);
      if (domain.behaviors?.some((b) => b.name.name === behavior.name.name)) {
        throw new PatchError(`“${behavior.name.name}” already exists.`);
      }
      domain.behaviors = [...(domain.behaviors ?? []), behavior];
      return;
    }
    case 'remove-behavior': {
      findBehavior(domain, op.behavior);
      domain.behaviors = (domain.behaviors ?? []).filter((b) => b.name.name !== op.behavior);
      return;
    }
    case 'set-behavior-role': {
      const behavior = findBehavior(domain, op.behavior);
      const others = (behavior.annotations ?? []).filter((a) => a.name.name !== 'requireRole');
      behavior.annotations = op.role
        ? [
            ...others,
            {
              kind: 'Annotation',
              name: ident('requireRole'),
              value: str(op.role),
              location: SYNTHETIC,
            },
          ]
        : others;
      return;
    }
    case 'add-invariant': {
      const invariant = invariantFragment(op.isl);
      if (domain.invariants?.some((i) => i.name.name === invariant.name.name)) {
        throw new PatchError(`“${invariant.name.name}” already exists.`);
      }
      domain.invariants = [...(domain.invariants ?? []), invariant];
      return;
    }
    case 'remove-invariant': {
      const existing = domain.invariants ?? [];
      const next = existing.filter((i) => i.name.name !== op.invariant);
      if (next.length === existing.length)
        throw new PatchError(`There is no “${op.invariant}” rule.`);
      domain.invariants = next;
      return;
    }
    case 'set-app-description': {
      domain.description = str(op.description);
      return;
    }
    default: {
      const never: never = op;
      throw new PatchError(`Unsupported change: ${JSON.stringify(never)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// public API

/** Apply a patch, or explain in plain English why it cannot be applied. */
export function applyPatch(
  contract: AppContract,
  patch: SemanticPatch,
  options: ApplyOptions = {},
): ApplyResult {
  const draft: Domain = structuredClone(contract.domain);

  try {
    for (const op of patch.ops) applyOp(draft, op);
  } catch (error) {
    if (error instanceof PatchError) {
      return {
        ok: false,
        reason: 'invalid-op',
        message: error.message,
        ...(error.detail ? { detail: error.detail } : {}),
      };
    }
    if (error instanceof FragmentError) {
      return { ok: false, reason: 'invalid-op', message: error.message, detail: error.detail };
    }
    throw error;
  }

  const nextRevision = contract.meta.revision + 1;
  const carried: ContractMeta = {
    ...contract.meta,
    revision: nextRevision,
    clauses: { ...contract.meta.clauses },
  };

  const islSource = unparse(draft);
  const reparsed = parseAppContract(islSource, { meta: carried });
  if (!reparsed.ok) {
    return {
      ok: false,
      reason: 'unparseable',
      message:
        'That change would produce a contract the compiler cannot read, so it was not applied.',
      detail: reparsed.diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => `${d.code}: ${d.message}`)
        .join('; '),
    };
  }

  const diff = diffContracts(contract, reparsed.contract);
  if (diff.lockViolations.length && !options.allowLocked) {
    return {
      ok: false,
      reason: 'locked',
      message:
        diff.lockViolations.length === 1
          ? 'That change would modify a locked requirement. Review and approve it first.'
          : `That change would modify ${diff.lockViolations.length} locked requirements. Review and approve them first.`,
      lockViolations: diff.lockViolations,
      diff,
    };
  }

  stampProvenance(reparsed.contract, diff, patch, nextRevision);

  return { ok: true, contract: reparsed.contract, diff, impact: analyzeImpact(diff) };
}

/**
 * Record where each new or changed clause came from. This is the step that
 * makes an AI-authored clause visibly different from one the user wrote.
 */
function stampProvenance(
  contract: AppContract,
  diff: SemanticDiff,
  patch: SemanticPatch,
  revision: number,
): void {
  for (const change of diff.changes) {
    if (change.kind === 'removed') {
      delete contract.meta.clauses[change.clauseId];
      continue;
    }
    const previous = contract.meta.clauses[change.clauseId];
    const base: ClauseMeta =
      change.kind === 'added' || !previous
        ? defaultClauseMeta(patch.origin, revision)
        : { ...previous };
    contract.meta.clauses[change.clauseId] = {
      ...base,
      source: patch.origin,
      confirmed: patch.origin === 'user',
      confidence: patch.origin === 'inferred' ? base.confidence : 1,
      modifiedRevision: revision,
      ...(patch.originalText ? { originalText: patch.originalText } : {}),
      ...(patch.rationale ? { rationale: patch.rationale } : {}),
      // A lock survives a change only when the user approved that change.
      locked: previous?.locked ?? false,
    };
  }
}

/**
 * Dry run: compute the semantic diff and impact a patch would produce without
 * committing it. This is what the review screen renders before "Apply".
 */
export function previewPatch(contract: AppContract, patch: SemanticPatch): ApplyResult {
  return applyPatch(contract, patch, { allowLocked: true });
}
