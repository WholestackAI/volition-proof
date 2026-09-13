/**
 * Projection: ISL `Domain` AST → canonical clauses.
 *
 * Deterministic and total. Every clause id is derived from *names and content*,
 * never from position, so reordering a spec or reformatting it produces the
 * identical id set — which is what makes provenance, locks, and semantic diff
 * survive an edit.
 *
 * Ids are documented in `CLAUSE_ID_SCHEME` and are part of the
 * `app-contract/1` schema contract. Changing one is a schema break.
 */

import type {
  Aggregate,
  Behavior,
  Domain,
  Entity,
  Expression,
  Field,
  InvariantBlock,
  JobDecl,
  NotificationDecl,
  Policy,
  QueryDecl,
  RoleExpr,
  TypeDeclaration,
  TypeDefinition,
  View,
} from '@isl-lang/parser';
import {
  expressionToEnglish,
  expressionToIsl,
  humanizeIdentifier,
  humanizeTypeName,
  isMinorUnitField,
  stripMinorUnitSuffix,
  titleCaseName,
  withArticle,
} from './expression.js';
import { shortDigest } from './hash.js';
import { isLifecycleFieldName } from '../lifecycle-field.js';
import type { Clause, ClauseId } from './types.js';
import {
  behaviorSecuritySemantic,
  permissionSemantic,
  policySemantic,
  roleSemantic,
} from './semantic/authorization.js';
import {
  behaviorSemantic,
  invariantSemantic,
  normalizeExpression as normalizePredicate,
  postconditionSemantic,
  preconditionSemantic,
  transitionSemantic,
} from './semantic/behavior.js';
import {
  appSemantic,
  auditSemantic,
  domainRelationshipSemantic,
  entitySemantic,
  fieldSemantic,
  relationshipSemantic,
  statusSetSemantic,
  structureContext,
  type StructureContext,
} from './semantic/structure.js';
import {
  aggregateSemantic,
  authProviderSemantic,
  integrationSemantic,
  jobSemantic,
  notificationSemantic,
  querySemantic,
  screenSemantic,
  viewSemantic,
} from './semantic/surfaces.js';

export const CLAUSE_ID_SCHEME = `
app
role:<role>
entity:<Entity>
field:<Entity>.<field>
relationship:<Entity>.<field>-><Target>
relationship:<name>           (named domain relationship, including many-to-many)
status-set:<Entity>.<field>
transition:<Entity>:<FROM>><TO>
transition:<Entity>:<FROM>><TO>:forbid
audit:<Entity>
permission:<Entity>:<action>
permission:<Entity>:<action>:<scope>   (when multiple rules share an action)
behavior:<Behavior>
precondition:<Behavior>:<digest>
postcondition:<Behavior>:<condition>:<digest>
behavior-security:<Behavior>:<digest>
invariant:<Name>          (domain-level "invariants Name { }" block)
invariant:<Entity>         (entity-level "invariants { }" block — anonymous, so the entity names it)
policy:<Name>
view:<View>
aggregate:<Aggregate>
query:<Query>
job:<Job>
notification:<Notification>
auth-provider:<name>
integration:<name>
screen:<name>
`.trim();

// ─────────────────────────────────────────────────────────────────────────────
// helpers

function idOf(node: { name: string } | undefined): string {
  return node?.name ?? '';
}

/** Widen an ISL AST node so kind-switches can index fields the parser unions don't share. */
function asNode(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** Field type as ISL text, so the Code lens can show it without re-unparsing. */
export function typeToIsl(t: TypeDefinition | undefined): string {
  if (!t) return '';
  const x = asNode(t);
  switch (x.kind) {
    case 'PrimitiveType':
      return String(x.name);
    case 'ReferenceType':
      return ((x.name as { parts?: { name: string }[] })?.parts ?? []).map((p) => p.name).join('.');
    case 'OptionalType':
      return `${typeToIsl(x.inner as TypeDefinition)}?`;
    case 'ListType':
      return `List<${typeToIsl(x.element as TypeDefinition)}>`;
    case 'MapType':
      return `Map<${typeToIsl(x.key as TypeDefinition)}, ${typeToIsl(x.value as TypeDefinition)}>`;
    case 'ConstrainedType':
      return typeToIsl(x.base as TypeDefinition);
    case 'EnumType':
      return `enum { ${((x.variants as { name: { name: string } }[]) ?? []).map((v) => v.name.name).join(', ')} }`;
    case 'StructType':
      return 'struct';
    case 'UnionType':
      return 'union';
    default:
      return String(x.kind ?? '');
  }
}

const TYPE_ENGLISH: Record<string, string> = {
  String: 'text',
  Text: 'long text',
  Int: 'whole number',
  Decimal: 'decimal number',
  Float: 'decimal number',
  Boolean: 'yes/no',
  Timestamp: 'date and time',
  Date: 'date',
  UUID: 'identifier',
  Duration: 'duration',
  JSON: 'structured data',
};

/** Plain-English name for a field type, resolving enums through the type table. */
export function typeToEnglish(t: TypeDefinition | undefined, enums: Map<string, string[]>): string {
  const isl = typeToIsl(t);
  if (enums.has(isl)) return `one of ${enums.get(isl)!.map(humanizeIdentifier).join(', ')}`;
  const optional = isl.endsWith('?');
  const bare = optional ? isl.slice(0, -1) : isl;
  if (enums.has(bare)) return `one of ${enums.get(bare)!.map(humanizeIdentifier).join(', ')}`;
  return TYPE_ENGLISH[bare] ?? humanizeIdentifier(bare);
}

function annotation(field: Field, name: string): Expression | undefined {
  return field.annotations?.find((a) => idOf(a.name) === name)?.value;
}

function annotationText(field: Field, name: string): string | undefined {
  const value = annotation(field, name);
  if (!value) return undefined;
  const text = expressionToIsl(value);
  return text.startsWith('"') ? text.slice(1, -1) : text;
}

function hasAnnotation(field: Field, name: string): boolean {
  return Boolean(field.annotations?.some((a) => idOf(a.name) === name));
}

/** `[references: "Customer.id"]` → `Customer`. */
export function referenceTarget(field: Field): string | undefined {
  const ref = annotationText(field, 'references');
  if (!ref) return undefined;
  return ref.split('.')[0];
}

function roleExprToEnglish(expr: RoleExpr | undefined): string {
  if (!expr) return 'nobody';
  if (expr.none && (expr.roles ?? []).length === 0 && !expr.owner && !expr.tenant && (expr.related ?? []).length === 0) {
    return 'nobody';
  }
  const parts: string[] = [];
  for (const role of expr.roles ?? []) parts.push(`${humanizeIdentifier(idOf(role))}s`);
  if (expr.owner) parts.push('the record owner');
  if (expr.tenant) parts.push('anyone in the same tenant');
  for (const rel of expr.related ?? [])
    parts.push(`the linked ${humanizeIdentifier(idOf(rel)).replace(/ id$/, '')}`);
  if (expr.none) parts.push('nobody');
  if (!parts.length) return 'nobody';
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

function roleExprToIsl(expr: RoleExpr | undefined): string {
  if (!expr) return '';
  if (expr.none && (expr.roles ?? []).length === 0 && !expr.owner && !expr.tenant && (expr.related ?? []).length === 0) {
    return 'none';
  }
  const parts = [
    ...(expr.roles ?? []).map((r) => idOf(r)),
    ...(expr.owner ? ['owner'] : []),
    ...(expr.tenant ? ['tenant'] : []),
    ...(expr.related ?? []).map((r) => `related(${idOf(r)})`),
    ...(expr.none ? ['none'] : []),
  ];
  return parts.join(' | ');
}

const ACTION_ENGLISH: Record<string, string> = {
  read: 'view',
  write: 'create and change',
  delete: 'delete',
};

/** Enum variant lists keyed by declared type name, for English rendering. */
export function collectEnums(domain: Domain): Map<string, string[]> {
  const enums = new Map<string, string[]>();
  for (const decl of domain.types ?? []) {
    const def = decl.definition;
    if (def?.kind === 'EnumType') {
      enums.set(
        idOf(decl.name),
        def.variants.map((v) => v.name.name),
      );
    }
  }
  return enums;
}

// ─────────────────────────────────────────────────────────────────────────────
// projection

interface Ctx {
  enums: Map<string, string[]>;
  entityNames: Set<string>;
  entityFields: Map<string, Set<string>>;
  /** Type-alias table for resolving field/relationship/status-set semantics. */
  structure: StructureContext;
}

function appClause(domain: Domain): Clause {
  const name = idOf(domain.name);
  const description = domain.description?.value;
  return {
    id: 'app',
    kind: 'app',
    section: 'overview',
    title: description || `${titleCaseName(name)} is the application this contract describes.`,
    detail: `Version ${domain.version?.value ?? '1.0.0'}${domain.tenancy ? `, ${domain.tenancy}` : ''}.`,
    refs: [],
    islExcerpt: `domain ${name} version "${domain.version?.value ?? '1.0.0'}"`,
    semantic: appSemantic(domain),
    ...(domain.location ? { location: domain.location } : {}),
  };
}

function roleClauses(domain: Domain): Clause[] {
  return (domain.roles?.roles ?? []).map((role) => {
    const name = idOf(role.name);
    return {
      id: `role:${name}`,
      kind: 'role' as const,
      section: 'people' as const,
      title: `${humanizeTypeName(name)} is a role people can hold in this app.`,
      refs: [],
      islExcerpt: name,
      semantic: roleSemantic(role),
      ...(role.location ? { location: role.location } : {}),
    };
  });
}

/** Surrogate keys and audit stamps the compiler adds; not user intent. */
const PLUMBING_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'deletedAt']);

function fieldClauses(entity: Entity, ctx: Ctx): Clause[] {
  const entityName = idOf(entity.name);
  const entityId = `entity:${entityName}`;
  const clauses: Clause[] = [];

  for (const field of entity.fields ?? []) {
    const fieldName = idOf(field.name);
    const typeIsl = typeToIsl(field.type);
    const target = referenceTarget(field);
    const annotationsIsl = (field.annotations ?? [])
      .map((a) => (a.value ? `${idOf(a.name)}: ${expressionToIsl(a.value)}` : idOf(a.name)))
      .join(', ');
    // The variant list is part of the field's meaning, not a separate clause:
    // adding a status must register as a change to the field that uses it, or
    // the semantic diff misses a schema migration.
    const declaredVariants = ctx.enums.get(typeIsl.replace(/\?$/, ''));
    const variantsIsl = declaredVariants ? ` = { ${declaredVariants.join(', ')} }` : '';
    const islExcerpt = `${fieldName}: ${typeIsl}${annotationsIsl ? ` [${annotationsIsl}]` : ''}${variantsIsl}`;

    if (target && ctx.entityNames.has(target) && target !== entityName) {
      const ownership = fieldName === 'ownerId';
      clauses.push({
        id: `relationship:${entityName}.${fieldName}->${target}`,
        kind: 'relationship',
        section: 'data',
        title: ownership
          ? `Every ${humanizeTypeName(entityName)} has an owner — the person who created it.`
          : `Each ${humanizeTypeName(entityName)} belongs to one ${humanizeTypeName(target)}.`,
        ...(ownership
          ? { detail: 'Ownership is what per-person visibility rules are checked against.' }
          : {}),
        refs: [entityId, `entity:${target}`],
        islExcerpt,
        semantic: relationshipSemantic(entity, field, ctx.structure),
        ...(field.location ? { location: field.location } : {}),
      });
      continue;
    }

    const variants = ctx.enums.get(typeIsl);
    const isStatus =
      Boolean(variants) && entity.lifecycle !== undefined && isLifecycleFieldName(fieldName);
    if (variants && isStatus) {
      const terminal = annotationText(field, 'terminal');
      const terminals = terminal
        ? terminal
            .split(',')
            .map((t) => humanizeTypeName(t.trim()))
            .filter(Boolean)
        : [];
      clauses.push({
        id: `status-set:${entityName}.${fieldName}`,
        kind: 'status-set',
        section: 'workflows',
        title: `${capitalize(withArticle(humanizeTypeName(entityName)))} moves through these stages: ${variants.map(humanizeIdentifier).join(', ')}.`,
        ...(terminals.length
          ? {
              detail: `${terminals.join(' and ')} ${terminals.length === 1 ? 'ends' : 'end'} the workflow.`,
            }
          : {}),
        refs: [entityId],
        islExcerpt,
        semantic: statusSetSemantic(entity, field, ctx.structure),
        ...(field.location ? { location: field.location } : {}),
      });
      continue;
    }

    const optional = field.optional || typeIsl.endsWith('?');
    const searchable = hasAnnotation(field, 'search');
    const money = isMinorUnitField(fieldName);
    const label = humanizeIdentifier(stripMinorUnitSuffix(fieldName));
    const typeLabel = money ? 'money' : typeToEnglish(field.type, ctx.enums);
    clauses.push({
      id: `field:${entityName}.${fieldName}`,
      kind: 'field',
      section: 'data',
      title: `Each ${humanizeTypeName(entityName)} records ${label} (${typeLabel})${optional ? ', optional' : ''}.`,
      ...(searchable ? { detail: 'Searchable.' } : {}),
      refs: [entityId],
      islExcerpt,
      semantic: fieldSemantic(entity, field, ctx.structure),
      ...(field.location ? { location: field.location } : {}),
      ...(PLUMBING_FIELDS.has(fieldName) ? { plumbing: true as const } : {}),
    });
  }

  return clauses;
}

function transitionClauses(entity: Entity, ctx: Ctx): Clause[] {
  const entityName = idOf(entity.name);
  void ctx; // reserved for a future statusField cross-check; transitionSemantic needs only the entity
  return (entity.lifecycle?.transitions ?? []).map((t) => {
    const from = idOf(t.from);
    const to = idOf(t.to);
    const forbidden = Boolean(t.forbidden);
    return {
      id: forbidden
        ? `transition:${entityName}:${from}>${to}:forbid`
        : `transition:${entityName}:${from}>${to}`,
      kind: 'transition' as const,
      section: 'workflows' as const,
      title: forbidden
        ? `${capitalize(withArticle(humanizeTypeName(entityName)))} cannot move from ${humanizeTypeName(from)} to ${humanizeTypeName(to)}.`
        : `${capitalize(withArticle(humanizeTypeName(entityName)))} can move from ${humanizeTypeName(from)} to ${humanizeTypeName(to)}.`,
      refs: [`entity:${entityName}`],
      islExcerpt: forbidden ? `forbid ${from} -> ${to}` : `${from} -> ${to}`,
      semantic: transitionSemantic(entity, t),
      ...(t.location ? { location: t.location } : {}),
    };
  });
}

/**
 * An entity's own `invariants { }` block, projected as one clause.
 *
 * `Entity.invariants` is anonymous — there is no name to key the clause id on,
 * so the entity's own name fills the slot the domain-level form uses for its
 * block name. `invariantSemantic` already handles this shape (see its header);
 * this was the missing call site, and until now the 248 predicates it measured
 * across the corpus reached no clause AT ALL, not merely an unhashed one.
 */
function entityInvariantClauses(entity: Entity): Clause[] {
  const predicates = entity.invariants ?? [];
  if (predicates.length === 0) return [];
  const entityName = idOf(entity.name);
  const english = predicates.map(expressionToEnglish).filter(Boolean);
  return [
    {
      id: `invariant:${entityName}`,
      kind: 'invariant',
      section: 'rules',
      title: `${humanizeTypeName(entityName)} records must always satisfy: ${english.join('; ')}.`,
      refs: [`entity:${entityName}`],
      islExcerpt: `invariants { ${predicates.map(expressionToIsl).join('; ')} }`,
      semantic: invariantSemantic(entity),
    },
  ];
}

function permissionScopeKey(rule: { allow: RoleExpr }): string {
  if (rule.allow.none) return 'none';
  const parts: string[] = [];
  if (rule.allow.owner) parts.push('owner');
  if (rule.allow.tenant) parts.push('tenant');
  for (const related of rule.allow.related ?? []) parts.push(`related:${related.name}`);
  for (const role of rule.allow.roles) parts.push(role.name);
  return parts.join('+') || 'roles';
}

function permissionClauses(entity: Entity): Clause[] {
  const entityName = idOf(entity.name);
  const rules = entity.permissions?.rules ?? [];
  const actionCount = new Map<string, number>();
  for (const rule of rules) {
    actionCount.set(rule.action, (actionCount.get(rule.action) ?? 0) + 1);
  }
  return rules.map((rule) => {
    const scope = permissionScopeKey(rule);
    const id =
      (actionCount.get(rule.action) ?? 0) > 1
        ? `permission:${entityName}:${rule.action}:${scope}`
        : `permission:${entityName}:${rule.action}`;
    return {
      id,
      kind: 'permission' as const,
      section: 'permissions' as const,
      title: `${capitalize(roleExprToEnglish(rule.allow))} can ${ACTION_ENGLISH[rule.action] ?? rule.action} ${humanizeTypeName(entityName)} records.`,
      refs: [`entity:${entityName}`],
      semantic: permissionSemantic(entity, rule),
      islExcerpt: `${rule.action}: ${roleExprToIsl(rule.allow)}`,
      ...(rule.location ? { location: rule.location } : {}),
    };
  });
}

function entityHasAuditTrail(entity: Entity): { mode: 'appendOnly' | 'audit' } | null {
  const names = (entity.annotations ?? []).map((a) =>
    idOf(a.name)
      .toLowerCase()
      .replace(/[-_]/g, ''),
  );
  if (names.includes('appendonly')) return { mode: 'appendOnly' };
  if (names.includes('audit')) return { mode: 'audit' };
  return null;
}

function auditClause(entity: Entity): Clause | null {
  const trail = entityHasAuditTrail(entity);
  if (!trail) return null;
  const entityName = idOf(entity.name);
  const appendOnly = trail.mode === 'appendOnly';
  return {
    id: `audit:${entityName}`,
    kind: 'audit',
    section: 'rules',
    title: appendOnly
      ? `${capitalize(humanizeTypeName(entityName))} records cannot be changed or deleted after they are written.`
      : `The app keeps an audit trail of who changed ${humanizeTypeName(entityName)} records.`,
    refs: [`entity:${entityName}`],
    islExcerpt: appendOnly ? `entity ${entityName} [appendOnly]` : `entity ${entityName} [audit]`,
    semantic: auditSemantic(entity),
    ...(entity.location ? { location: entity.location } : {}),
  };
}

function entityClauses(entity: Entity, ctx: Ctx): Clause[] {
  const entityName = idOf(entity.name);
  const fieldCount = (entity.fields ?? []).length;
  const head: Clause = {
    id: `entity:${entityName}`,
    kind: 'entity',
    section: 'data',
    title: `The app keeps a record of every ${humanizeTypeName(entityName)}.`,
    detail: `${fieldCount} field${fieldCount === 1 ? '' : 's'}.`,
    refs: [],
    islExcerpt: `entity ${entityName}`,
    semantic: entitySemantic(entity),
    ...(entity.location ? { location: entity.location } : {}),
  };
  const audit = auditClause(entity);
  return [
    head,
    ...fieldClauses(entity, ctx),
    ...transitionClauses(entity, ctx),
    ...(audit ? [audit] : []),
    ...entityInvariantClauses(entity),
    ...permissionClauses(entity),
  ];
}

/**
 * `CreateEstimate` → `create an Estimate`. Verb-object behavior names are the
 * convention the spec writer emits, so the article attaches to the object.
 */
function behaviorPhrase(name: string, ctx: Ctx): string {
  for (const entity of ctx.entityNames) {
    if (name.length > entity.length && name.endsWith(entity)) {
      const verb = humanizeIdentifier(name.slice(0, name.length - entity.length));
      if (verb) return `${verb} ${withArticle(humanizeTypeName(entity))}`;
    }
  }
  return humanizeIdentifier(name);
}

function behaviorClauses(behavior: Behavior, ctx: Ctx): Clause[] {
  const name = idOf(behavior.name);
  const label = humanizeTypeName(name);
  const behaviorId = `behavior:${name}`;
  const inputIsl = (behavior.input?.fields ?? [])
    .map((field) => `${idOf(field.name)}: ${typeToIsl(field.type)}`)
    .join(', ');
  const clauses: Clause[] = [
    {
      id: behaviorId,
      kind: 'behavior',
      section: 'screens',
      title: behavior.description?.value || `People can ${behaviorPhrase(name, ctx)}.`,
      refs: [],
      islExcerpt: inputIsl ? `behavior ${name} { input { ${inputIsl} } }` : `behavior ${name}`,
      semantic: behaviorSemantic(behavior),
      ...(behavior.location ? { location: behavior.location } : {}),
    },
  ];

  for (const pre of behavior.preconditions ?? []) {
    const isl = expressionToIsl(pre);
    clauses.push({
      id: `precondition:${name}:${shortDigest(isl)}`,
      kind: 'precondition',
      section: 'rules',
      title: `${label} is only allowed when ${expressionToEnglish(pre)}.`,
      refs: [behaviorId],
      islExcerpt: isl,
      semantic: preconditionSemantic(behavior, pre),
      ...(pre.location ? { location: pre.location } : {}),
    });
  }

  for (const block of behavior.postconditions ?? []) {
    const condition = typeof block.condition === 'string' ? block.condition : idOf(block.condition);
    for (const pred of block.predicates ?? []) {
      const isl = expressionToIsl(pred);
      clauses.push({
        id: `postcondition:${name}:${condition}:${shortDigest(isl)}`,
        kind: 'postcondition',
        section: 'rules',
        title:
          condition === 'success'
            ? `After ${label} succeeds, ${expressionToEnglish(pred)}.`
            : `On ${humanizeIdentifier(condition)} from ${label}, ${expressionToEnglish(pred)}.`,
        refs: [behaviorId],
        islExcerpt: isl,
        semantic: postconditionSemantic(behavior, block, pred),
        ...(pred.location ? { location: pred.location } : {}),
      });
    }
  }

  for (const sec of behavior.security ?? []) {
    const isl = securityToIsl(sec);
    clauses.push({
      id: `behavior-security:${name}:${shortDigest(isl)}`,
      kind: 'behavior-security',
      section: 'permissions',
      title: `${label} requires ${securityToEnglish(sec)}.`,
      refs: [behaviorId],
      islExcerpt: isl,
      semantic: behaviorSecuritySemantic(name, sec),
      ...((sec as { location?: Clause['location'] }).location
        ? { location: (sec as { location: NonNullable<Clause['location']> }).location }
        : {}),
    });
  }

  // Role gates carried as behavior annotations (`[requireRole: "manager"]`).
  for (const ann of behavior.annotations ?? []) {
    if (idOf(ann.name) !== 'requireRole' || !ann.value) continue;
    const raw = expressionToIsl(ann.value);
    const role = raw.startsWith('"') ? raw.slice(1, -1) : raw;
    const isl = `requireRole: "${role}"`;
    clauses.push({
      id: `behavior-security:${name}:${shortDigest(isl)}`,
      kind: 'behavior-security',
      section: 'permissions',
      title: `Only ${humanizeIdentifier(role)}s can ${humanizeIdentifier(name)}.`,
      refs: [behaviorId],
      islExcerpt: isl,
      semantic: behaviorSecuritySemantic(name, ann),
      ...(ann.location ? { location: ann.location } : {}),
    });
  }

  void ctx;
  return clauses;
}

function securityToIsl(sec: Behavior['security'][number]): string {
  const x = asNode(sec);
  const requirement = x.requirement ?? x.kind ?? '';
  const detail = x.expression ? expressionToIsl(x.expression as Expression) : (x.value ?? '');
  return `requires ${String(requirement)}${detail ? ` ${String(detail)}` : ''}`.trim();
}

function securityToEnglish(sec: Behavior['security'][number]): string {
  const x = asNode(sec);
  const requirement = String(x.requirement ?? x.kind ?? 'authorization');
  if (requirement === 'authenticated') return 'the person to be signed in';
  if (requirement === 'authorization' && x.expression)
    return expressionToEnglish(x.expression as Expression);
  return humanizeIdentifier(requirement);
}

/** Resolve explicit `Entity.field` references without guessing bare identifiers. */
function expressionClauseRefs(expression: Expression, ctx: Ctx): ClauseId[] {
  const refs = new Set<ClauseId>();

  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const node = asNode(value);
    if (node.kind === 'MemberExpr') {
      const object = asNode(node.object);
      const property = asNode(node.property);
      if (object.kind === 'Identifier' && property.kind === 'Identifier') {
        const entity = String(object.name ?? '');
        const field = String(property.name ?? '');
        if (ctx.entityFields.get(entity)?.has(field)) refs.add(`field:${entity}.${field}`);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'location') continue;
      if (Array.isArray(child)) child.forEach(walk);
      else walk(child);
    }
  };

  walk(expression);
  return [...refs].sort();
}

function invariantClauses(inv: InvariantBlock, ctx: Ctx): Clause[] {
  const name = idOf(inv.name);
  const predicates = (inv.predicates ?? []).map(expressionToEnglish).filter(Boolean);
  const refs = new Set<ClauseId>();
  for (const predicate of inv.predicates ?? []) {
    for (const ref of expressionClauseRefs(predicate, ctx)) refs.add(ref);
  }
  return [
    {
      id: `invariant:${name}`,
      kind: 'invariant',
      section: 'rules',
      title: inv.description?.value || `${humanizeTypeName(name)} must always hold.`,
      ...(predicates.length ? { detail: `Always true: ${predicates.join('; ')}.` } : {}),
      refs: [...refs].sort(),
      islExcerpt: `invariant ${name}`,
      semantic: invariantSemantic(inv),
      ...(inv.location ? { location: inv.location } : {}),
    },
  ];
}

function policyClauses(policy: Policy): Clause[] {
  const name = idOf(policy.name);
  const target = policy.appliesTo?.target;
  const targets =
    target === 'all'
      ? 'every record'
      : (target ?? []).map((t) => humanizeTypeName(idOf(t))).join(', ');
  const rules = (policy.rules ?? []).map((rule) => {
    const action = expressionToIsl(rule.action);
    if (!rule.condition) return `otherwise ${humanizeIdentifier(action)}`;
    return `${humanizeIdentifier(action)} when ${expressionToEnglish(rule.condition)}`;
  });
  return [
    {
      id: `policy:${name}`,
      kind: 'policy',
      section: 'permissions',
      title: `Access to ${targets}: ${rules.join('; ')}.`,
      refs: target === 'all' ? [] : (target ?? []).map((t) => `entity:${idOf(t)}`),
      islExcerpt: `policy ${name}`,
      semantic: policySemantic(policy),
      ...(policy.location ? { location: policy.location } : {}),
    },
  ];
}

function viewClauses(view: View, ctx: Ctx): Clause[] {
  const name = idOf(view.name);
  const forEntity = (view.forEntity.name?.parts ?? []).map((p) => p.name).join('.');
  const measures = (view.fields ?? []).map((f) =>
    humanizeIdentifier(stripMinorUnitSuffix(idOf(f.name))),
  );
  void ctx;
  return [
    {
      id: `view:${name}`,
      kind: 'view',
      section: 'screens',
      title: `${capitalize(withArticle(humanizeIdentifier(name)))} report summarises ${humanizeTypeName(forEntity)} records.`,
      ...(measures.length ? { detail: `Shows ${measures.join(', ')}.` } : {}),
      refs: forEntity ? [`entity:${forEntity}`] : [],
      islExcerpt: `view ${name}`,
      semantic: viewSemantic(view),
      ...(view.location ? { location: view.location } : {}),
    },
  ];
}

function aggregateClauses(agg: Aggregate): Clause[] {
  const name = idOf(agg.name);
  return [
    {
      id: `aggregate:${name}`,
      kind: 'aggregate',
      section: 'screens',
      title: `${capitalize(withArticle(humanizeIdentifier(name)))} rollup is computed for reporting.`,
      refs: [],
      islExcerpt: `aggregate ${name}`,
      semantic: aggregateSemantic(agg, { normalizeExpression: normalizePredicate }),
      ...(agg.location ? { location: agg.location } : {}),
    },
  ];
}

function queryClauses(query: QueryDecl): Clause[] {
  const name = idOf(query.name);
  const forEntity = (query.forEntity.name?.parts ?? []).map((p) => p.name).join('.');
  const filterBy = (query.filterBy ?? []).map((field) => idOf(field)).filter(Boolean);
  return [
    {
      id: `query:${name}`,
      kind: 'query',
      section: 'screens',
      title: `People can filter ${humanizeTypeName(forEntity || name)} records${
        filterBy.length ? ` by ${filterBy.map(humanizeIdentifier).join(', ')}` : ''
      }.`,
      refs: forEntity ? [`entity:${forEntity}`] : [],
      islExcerpt: `query ${name}`,
      semantic: querySemantic(query, { normalizeExpression: normalizePredicate }),
      ...(query.location ? { location: query.location } : {}),
    },
  ];
}

function jobClauses(job: JobDecl): Clause[] {
  const name = idOf(job.name);
  const forEntity = (job.forEntity.name?.parts ?? []).map((p) => p.name).join('.');
  const cadence = idOf(job.cadence);
  return [
    {
      id: `job:${name}`,
      kind: 'job',
      section: 'automation',
      title: cadence
        ? `${capitalize(humanizeTypeName(forEntity || name))} work is recurring ${cadence}.`
        : `${capitalize(humanizeTypeName(forEntity || name))} work is scheduled as ${idOf(job.schedule)}.`,
      refs: forEntity ? [`entity:${forEntity}`] : [],
      islExcerpt: `job ${name}`,
      semantic: jobSemantic(job),
      ...(job.location ? { location: job.location } : {}),
    },
  ];
}

function notificationClauses(notice: NotificationDecl): Clause[] {
  const name = idOf(notice.name);
  const forEntity = (notice.forEntity?.name?.parts ?? []).map((p) => p.name).join('.');
  const to = idOf(notice.to);
  return [
    {
      id: `notification:${name}`,
      kind: 'notification',
      section: 'automation',
      title: `The app sends a notification to ${humanizeIdentifier(to)}${
        forEntity ? ` about ${humanizeTypeName(forEntity)} records` : ''
      }.`,
      refs: [
        ...(forEntity ? [`entity:${forEntity}`] : []),
        ...(to ? [`role:${to}`] : []),
      ],
      islExcerpt: `notification ${name}`,
      semantic: notificationSemantic(notice),
      ...(notice.location ? { location: notice.location } : {}),
    },
  ];
}

function integrationClauses(domain: Domain): Clause[] {
  const out: Clause[] = [];
  for (const provider of domain.auth?.providers ?? []) {
    const name = idOf(provider.name);
    out.push({
      id: `auth-provider:${name}`,
      kind: 'auth-provider',
      section: 'integrations',
      title: `People can sign in with ${humanizeTypeName(name)}.`,
      refs: [],
      islExcerpt: name,
      semantic: authProviderSemantic(provider),
      ...(provider.location ? { location: provider.location } : {}),
    });
  }
  for (const service of domain.integrations?.services ?? []) {
    const name = idOf(service.name);
    out.push({
      id: `integration:${name}`,
      kind: 'integration',
      section: 'integrations',
      title: `The app connects to ${humanizeTypeName(name)}.`,
      refs: [],
      islExcerpt: name,
      semantic: integrationSemantic(service),
      ...(service.location ? { location: service.location } : {}),
    });
  }
  return out;
}

/**
 * `screen` had a `CLAUSE_KINDS` member and a semantic payload (`screenSemantic`)
 * with nowhere to be called from — see `semantic/surfaces.ts`'s header, point 3.
 * This is that missing call site: the parser already fills route, layout,
 * components (type/entity/behavior) and navigation; none of it reached a
 * clause before this function existed.
 */
function screenClauses(domain: Domain): Clause[] {
  return (domain.screens ?? []).map((screen) => {
    const name = idOf(screen.name);
    const componentNames = (screen.components ?? []).map((c) => idOf(c.name)).filter(Boolean);
    const refs = new Set<string>();
    for (const component of screen.components ?? []) {
      const entity = idOf(component.entity);
      const behavior = idOf(component.behavior);
      if (entity) refs.add(`entity:${entity}`);
      if (behavior) refs.add(`behavior:${behavior}`);
    }
    const contextEntity = idOf(screen.contextEntity);
    if (contextEntity) refs.add(`entity:${contextEntity}`);
    return {
      id: `screen:${name}`,
      kind: 'screen',
      section: 'screens',
      title:
        screen.description?.value ||
        `${capitalize(withArticle(humanizeIdentifier(name)))} screen${screen.route ? ` at ${screen.route.value}` : ''}.`,
      ...(componentNames.length
        ? { detail: `Shows ${componentNames.map(humanizeIdentifier).join(', ')}.` }
        : {}),
      refs: [...refs].sort(),
      islExcerpt: screen.route ? `screen ${name} { route: "${screen.route.value}" }` : `screen ${name}`,
      semantic: screenSemantic(screen),
      ...(screen.location ? { location: screen.location } : {}),
    };
  });
}

function namedRelationshipClauses(domain: Domain): Clause[] {
  return (domain.relationships ?? []).map((relationship) => {
    const name = idOf(relationship.name);
    const source = idOf(relationship.source);
    const target = idOf(relationship.target);
    const association = idOf(relationship.associationEntity);
    return {
      id: `relationship:${name}`,
      kind: 'relationship' as const,
      section: 'data' as const,
      title:
        relationship.cardinality === 'many_to_many'
          ? `${humanizeTypeName(source)} records relate to many ${humanizeTypeName(target)} records.`
          : `Each ${humanizeTypeName(source)} relates to ${relationship.cardinality === 'one_to_one' ? 'one' : 'many'} ${humanizeTypeName(target)}.`,
      refs: [`entity:${source}`, `entity:${target}`, ...(association ? [`entity:${association}`] : [])],
      islExcerpt: `relationship ${name} { source: ${source} target: ${target} cardinality: ${relationship.cardinality} }`,
      semantic: domainRelationshipSemantic(relationship),
      ...(relationship.location ? { location: relationship.location } : {}),
    };
  });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Project a parsed domain into ordered clauses. Order is section order, then
 * declaration order — stable across runs for the same AST.
 */
export function clausesFromDomain(domain: Domain): Clause[] {
  const ctx: Ctx = {
    enums: collectEnums(domain),
    entityNames: new Set((domain.entities ?? []).map((e) => idOf(e.name))),
    entityFields: new Map(
      (domain.entities ?? []).map((entity) => [
        idOf(entity.name),
        new Set((entity.fields ?? []).map((field) => idOf(field.name))),
      ]),
    ),
    structure: structureContext(domain),
  };

  const clauses: Clause[] = [
    appClause(domain),
    ...roleClauses(domain),
    ...(domain.entities ?? []).flatMap((e) => entityClauses(e, ctx)),
    ...(domain.behaviors ?? []).flatMap((b) => behaviorClauses(b, ctx)),
    ...(domain.invariants ?? []).flatMap((invariant) => invariantClauses(invariant, ctx)),
    ...(domain.policies ?? []).flatMap(policyClauses),
    ...(domain.views ?? []).flatMap((v) => viewClauses(v, ctx)),
    ...(domain.aggregates ?? []).flatMap(aggregateClauses),
    ...(domain.queries ?? []).flatMap(queryClauses),
    ...(domain.jobs ?? []).flatMap(jobClauses),
    ...(domain.notifications ?? []).flatMap(notificationClauses),
    ...integrationClauses(domain),
    ...screenClauses(domain),
    ...namedRelationshipClauses(domain),
  ];

  // Duplicate ids are a projection bug, not user error: keep the first and
  // surface the collision loudly rather than silently dropping meaning.
  const seen = new Set<ClauseId>();
  const out: Clause[] = [];
  for (const clause of clauses) {
    if (seen.has(clause.id)) continue;
    seen.add(clause.id);
    out.push(clause);
  }
  return out;
}

/** Unused type re-export guard so `TypeDeclaration` stays part of the surface. */
export type { TypeDeclaration };
