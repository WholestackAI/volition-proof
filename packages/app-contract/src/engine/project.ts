/**
 * App Contract ISL → Engine ISL projection.
 *
 * These are two different languages, not two spellings of one language.
 *
 *  - App Contract ISL (`@isl-lang/parser`) is a *domain* language:
 *    `domain X version "1.0.0"`, flat top-level statements, `name: Type?`,
 *    `[attr, attr: "value"]` field attributes, `lifecycle { A -> B }`,
 *    per-entity `permissions { read: manager | owner }`, standalone
 *    `policy`/`view`/`behavior` blocks.
 *
 *  - Engine ISL (`@openisl/parser`, reached by `loadEngineFromSource`) is an
 *    *operational* language: `isl 1.1` + one `engine "id" { ... }` document,
 *    uniform `key <value>` / `key { ... }` syntax, every identifier a quoted
 *    string. Its lexer has no token for `?`, `-`, or `|` outside a string, so
 *    an App Contract file is not merely semantically foreign to it — it is
 *    lexically unreadable ("Unexpected character").
 *
 * The two models overlap on entities, fields, roles, and lifecycles. They do
 * NOT overlap on authorization. App Contract states authority per entity and
 * per verb, with a first-class `owner` term meaning "the row's owner,
 * whatever their role". Engine ISL has:
 *
 *   - `entity.read { roles [...] scope "tenant"|"owner"|"filter" }` — reads only;
 *   - `commands[].roles [...]` and `permissions { permission { action allow deny } }`
 *     — flat role lists, no row-relationship term;
 *   - transition `guard` — an expression grammar with comparisons and facts,
 *     and no way to say "the caller holds role R".
 *
 * So "manager OR the record owner may write" has no Engine ISL form: the role
 * half only fits a role list, the owner half only fits a guard, and neither
 * construct can express the disjunction of the other. Emitting only the role
 * half would hand downstream a contract STRICTER than the user agreed to;
 * emitting only the owner half would hand it a LOOSER one. Both are lies, and
 * a downstream SHIP verdict against a lie is exactly what Articles 4 and 18
 * forbid.
 *
 * Therefore this module refuses. A construct that carries authority and cannot
 * cross intact produces `status: 'refused'` and NO engine document — never a
 * document plus a warning. Constructs that carry no authority (reports, field
 * attributes, behavior shapes) cross as explicit entries in `dropped`, so the
 * caller can see the whole cost of the trip.
 */

import type { Expression, Entity, Field, Policy, RoleExpr } from '@isl-lang/parser'
import type { AppContract, ClauseId, ClauseKind } from '../canonical/types.js'
import { expressionToIsl } from '../canonical/expression.js'
import { collectEnums, typeToIsl } from '../canonical/from-isl.js'
import { resolveAuthorizationOwnerField } from '../canonical/semantic/owner-field.js'

// ─────────────────────────────────────────────────────────────────────────────
// result types

/**
 * Something the App Contract states that the emitted engine document does not.
 *
 * `behavioral` losses change what the system is verified to DO; `cosmetic`
 * losses change only how a store or screen is shaped. Neither may be an
 * authorization construct — those refuse instead of appearing here.
 */
export interface DroppedConstruct {
  clauseId: ClauseId
  kind: ClauseKind
  severity: 'behavioral' | 'cosmetic'
  islExcerpt: string
  reason: string
}

/** An authorization construct with no faithful Engine ISL form. */
export interface AuthorizationRefusal {
  clauseId: ClauseId
  kind: ClauseKind
  islExcerpt: string
  reason: string
}

export interface EngineProjectionBase {
  /** Every non-authorization construct the engine document does not carry. */
  dropped: DroppedConstruct[]
  /**
   * Authorization clauses that DO have an exact Engine ISL counterpart.
   *
   * Together with `refusals` this partitions every authorization clause in the
   * contract: a clause that is neither carried nor refused would be one that
   * vanished, which is the failure this whole module exists to make
   * impossible. Populated even on a refusal, so the caller can see which
   * grants were fine and which one stopped the trip.
   */
  carriedAuthorization: ClauseId[]
}

export interface ProjectedEngine extends EngineProjectionBase {
  status: 'projected'
  /** Engine ISL source. Loads under `loadEngineFromSource` with no diagnostics. */
  engineIsl: string
  refusals: readonly []
}

export interface RefusedProjection extends EngineProjectionBase {
  status: 'refused'
  /** Non-empty. Each entry is an authorization construct that cannot cross. */
  refusals: AuthorizationRefusal[]
}

export type EngineProjection = ProjectedEngine | RefusedProjection

export interface ProjectEngineOptions {
  /**
   * Engine domain. Engine ISL requires one from a closed vocabulary owned by
   * `@wholestack/engines` (`ENGINE_DOMAINS`); App Contract ISL has no such
   * concept, so the caller must supply it. It is not inferred: an inferred
   * domain would be a fact no one stated. An unknown value is rejected by the
   * engine loader, which is the sole authority on that vocabulary.
   */
  engineDomain: string
  /** Engine id. Defaults to the App Contract domain name. */
  engineId?: string
  /** Engine `intent`. Defaults to the app clause's sentence. */
  intent?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers

function idOf(node: { name: string } | undefined): string {
  return node?.name ?? ''
}

function annotation(field: Field, name: string): Expression | undefined {
  return field.annotations?.find((a) => idOf(a.name) === name)?.value
}

function annotationText(field: Field, name: string): string | undefined {
  const value = annotation(field, name)
  if (!value) return undefined
  const text = expressionToIsl(value)
  return text.startsWith('"') ? text.slice(1, -1) : text
}

function hasAnnotation(field: Field, name: string): boolean {
  return Boolean(field.annotations?.some((a) => idOf(a.name) === name))
}

function roleExprToIsl(expr: RoleExpr | undefined): string {
  if (!expr) return ''
  return [
    ...(expr.roles ?? []).map((r) => idOf(r)),
    ...(expr.owner ? ['owner'] : []),
    ...(expr.related ?? []).map((r) => `related(${idOf(r)})`),
  ].join(' | ')
}

/** Engine strings are quoted; refuse to emit anything that could break out. */
function q(value: string): string {
  return JSON.stringify(String(value))
}

function strArray(values: readonly string[]): string {
  return `[${values.map(q).join(', ')}]`
}

/**
 * App Contract type → Engine ISL `type` string.
 *
 * Engine field types are free-form strings validated only where they matter
 * (`enum:` members, numeric ordering), so the mapping is lossless for every
 * type these contracts use. Optionality moves from the `?` suffix — which the
 * engine lexer cannot read at all — onto `required`.
 */
const PRIMITIVE_TYPES: Record<string, string> = {
  UUID: 'uuid',
  String: 'string',
  Text: 'text',
  Int: 'int',
  Decimal: 'decimal',
  Float: 'float',
  Boolean: 'boolean',
  Timestamp: 'timestamp',
  Date: 'date',
  JSON: 'json',
}

function engineFieldType(field: Field, enums: Map<string, string[]>): string {
  const isl = typeToIsl(field.type)
  const bare = isl.endsWith('?') ? isl.slice(0, -1) : isl
  const variants = enums.get(bare)
  if (variants && variants.length > 0) return `enum:${variants.join('|')}`
  return PRIMITIVE_TYPES[bare] ?? bare.toLowerCase()
}

/**
 * The column an `owner` grant is checked against.
 *
 * Same bind as the App Contract permission payload: `owner_user_id`, else a
 * historical ownerId/userId that references a principal. A business Owner
 * FK named `owner_id` is not a bind.
 */
function resolveOwnerField(entity: Entity): string | undefined {
  return resolveAuthorizationOwnerField(entity) ?? undefined
}

/** Field attributes with no Engine ISL counterpart, and what each one meant. */
const DROPPED_FIELD_ATTRIBUTES: Record<string, { severity: DroppedConstruct['severity']; why: string }> = {
  primary: { severity: 'cosmetic', why: 'primary key selection is not an Engine ISL concept' },
  unique: { severity: 'behavioral', why: 'uniqueness is an integrity constraint Engine ISL cannot state' },
  indexed: { severity: 'cosmetic', why: 'indexing is a storage concern Engine ISL does not model' },
  immutable: { severity: 'behavioral', why: 'immutability is an integrity constraint Engine ISL cannot state' },
  search: { severity: 'cosmetic', why: 'searchability is a surface concern Engine ISL does not model' },
  default: { severity: 'behavioral', why: 'field defaults survive only for a lifecycle field, as state_machine `initial`' },
  onDelete: { severity: 'behavioral', why: 'referential delete behavior has no Engine ISL form' },
  references: { severity: 'cosmetic', why: 'recovered as an entity `relationship`, without the target column' },
  terminal: { severity: 'cosmetic', why: 'recovered as state_machine `terminal_states`' },
}

// ─────────────────────────────────────────────────────────────────────────────
// projection

interface EmittedEntity {
  id: string
  lines: string[]
}

/**
 * Project an App Contract onto Engine ISL, or refuse.
 *
 * Refuses — returning no document at all — when any construct that carries
 * authority cannot cross intact. Succeeds only when every authorization clause
 * in the contract has an exact Engine ISL counterpart in the emitted document.
 */
export function projectToEngineIsl(
  contract: AppContract,
  options: ProjectEngineOptions,
): EngineProjection {
  const domain = contract.domain
  const enums = collectEnums(domain)
  const refusals: AuthorizationRefusal[] = []
  const dropped: DroppedConstruct[] = []
  const carriedAuthorization: ClauseId[] = []

  const appName = idOf(domain.name)
  const engineId = options.engineId ?? appName
  const roleIds = (domain.roles?.roles ?? []).map((r) => idOf(r.name))
  const roleSet = new Set(roleIds)

  const entities: EmittedEntity[] = []
  const stateMachines: string[] = []
  const commands: string[] = []
  const permissions: string[] = []

  for (const entity of domain.entities ?? []) {
    const entityName = idOf(entity.name)
    const entityClauseId = `entity:${entityName}`
    const lines: string[] = []

    // ── fields ───────────────────────────────────────────────────────────
    for (const field of entity.fields ?? []) {
      const fieldName = idOf(field.name)
      const isl = typeToIsl(field.type)
      const required = !(field.optional || isl.endsWith('?'))
      lines.push(
        `      field ${q(fieldName)} { type ${q(engineFieldType(field, enums))} required ${q(String(required))} }`,
      )
      for (const ann of field.annotations ?? []) {
        const name = idOf(ann.name)
        const spec = DROPPED_FIELD_ATTRIBUTES[name]
        if (!spec) continue
        dropped.push({
          clauseId: `field:${entityName}.${fieldName}`,
          kind: 'field',
          severity: spec.severity,
          islExcerpt: ann.value ? `${name}: ${expressionToIsl(ann.value)}` : name,
          reason: `[${name}] on ${entityName}.${fieldName}: ${spec.why}`,
        })
      }
    }

    // ── relationships (from `[references: "Target.column"]`) ─────────────
    for (const field of entity.fields ?? []) {
      const ref = annotationText(field, 'references')
      if (!ref) continue
      const target = ref.split('.')[0]
      if (!target || target === entityName) continue
      lines.push(
        `      relationship ${q(idOf(field.name))} { target ${q(target)} cardinality "one" }`,
      )
    }

    // ── read authority ───────────────────────────────────────────────────
    const ownerField = resolveOwnerField(entity)
    for (const rule of entity.permissions?.rules ?? []) {
      const clauseId = `permission:${entityName}:${rule.action}`
      const excerpt = `${rule.action}: ${roleExprToIsl(rule.allow)}`
      const allow = rule.allow as RoleExpr | undefined
      const grantedRoles = (allow?.roles ?? []).map((r) => idOf(r))
      const wantsOwner = Boolean(allow?.owner)
      const related = (allow?.related ?? []).map((r) => idOf(r))

      const unknownRole = grantedRoles.find((role) => !roleSet.has(role))
      if (unknownRole !== undefined) {
        refusals.push({
          clauseId,
          kind: 'permission',
          islExcerpt: excerpt,
          reason: `grants ${rule.action} to role "${unknownRole}", which the contract never declares; an engine role list may only name declared roles`,
        })
        continue
      }

      if (related.length > 0) {
        refusals.push({
          clauseId,
          kind: 'permission',
          islExcerpt: excerpt,
          reason: `grants ${rule.action} through the related record(s) ${related.join(', ')}; Engine ISL's only relationship-scoped grant is a read rule with scope "filter", which requires a filter expression the App Contract does not state — and it would cover reads only`,
        })
        continue
      }

      if (rule.action === 'read') {
        if (wantsOwner && ownerField === undefined) {
          refusals.push({
            clauseId,
            kind: 'permission',
            islExcerpt: excerpt,
            reason: `grants read to the record owner, but ${entityName} declares no ownerId column for an engine read rule to check`,
          })
          continue
        }
        if (grantedRoles.length > 0) {
          lines.push(
            `      read ${q(`${entityName}_read_roles`)} { roles ${strArray(grantedRoles)} scope "tenant" }`,
          )
        }
        if (wantsOwner) {
          lines.push(
            `      read ${q(`${entityName}_read_owner`)} { roles ${strArray(roleIds)} scope "owner" owner_field ${q(ownerField!)} }`,
          )
        }
        if (grantedRoles.length === 0 && !wantsOwner) {
          refusals.push({
            clauseId,
            kind: 'permission',
            islExcerpt: excerpt,
            reason: `grants read to nobody; Engine ISL reads an entity with no read rules as "the document says nothing", which downstream treats as unconstrained — the opposite of what this clause states`,
          })
          continue
        }
        carriedAuthorization.push(clauseId)
        continue
      }

      // write / delete
      if (wantsOwner) {
        refusals.push({
          clauseId,
          kind: 'permission',
          islExcerpt: excerpt,
          reason: `grants ${rule.action} to "${grantedRoles.join(' | ')}${grantedRoles.length ? ' | ' : ''}owner". Engine ISL expresses non-read authority only as a flat role list on a command, and its guard grammar has no term for role membership, so the disjunction "a named role OR the row's owner" has no faithful form. Emitting the role half alone would verify a stricter contract than the user agreed to; emitting the owner half alone, a weaker one`,
        })
        continue
      }
      if (grantedRoles.length === 0) {
        refusals.push({
          clauseId,
          kind: 'permission',
          islExcerpt: excerpt,
          reason: `grants ${rule.action} to nobody; Engine ISL has no construct that denies an action outright`,
        })
        continue
      }
      const commandId = `${entityName}_${rule.action}`
      commands.push(
        `    command ${q(commandId)} { label ${q(`${rule.action} ${entityName}`)} roles ${strArray(grantedRoles)} entity ${q(entityName)} }`,
      )
      permissions.push(
        `    permission ${q(`${entityName}_${rule.action}`)} { action ${q(commandId)} allow ${strArray(grantedRoles)} }`,
      )
      carriedAuthorization.push(clauseId)
    }

    entities.push({ id: entityName, lines })

    // ── lifecycle → state_machine ────────────────────────────────────────
    const transitions = entity.lifecycle?.transitions ?? []
    if (transitions.length > 0) {
      const lifecycleField = (entity.fields ?? []).find((field) => {
        const bare = typeToIsl(field.type).replace(/\?$/, '')
        return enums.has(bare) && hasAnnotation(field, 'default')
      })
      if (!lifecycleField) {
        dropped.push({
          clauseId: entityClauseId,
          kind: 'entity',
          severity: 'behavioral',
          islExcerpt: `lifecycle { ${transitions.length} transitions }`,
          reason: `${entityName} declares a lifecycle but no enum field with a [default:], so no engine state_machine initial state could be named`,
        })
      } else {
        const bare = typeToIsl(lifecycleField.type).replace(/\?$/, '')
        const states = enums.get(bare) ?? []
        const initial = annotationText(lifecycleField, 'default') ?? states[0] ?? ''
        const terminal = (annotationText(lifecycleField, 'terminal') ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const body = [
          `    state_machine ${q(`${entityName}_lifecycle`)} {`,
          `      entity ${q(entityName)}`,
          `      initial ${q(initial)}`,
          `      states ${strArray(states)}`,
          `      terminal_states ${strArray(terminal)}`,
        ]
        for (const t of transitions) {
          const from = idOf(t.from)
          const to = idOf(t.to)
          // No `command` is bound on purpose. The App Contract never says who
          // may perform a transition, and inventing a role list here would be
          // fabricating an authorization the user never granted. An engine
          // transition with no command grants nobody anything, which is the
          // one reading that adds no authority.
          body.push(`      transition ${q(`${from}_to_${to}`)} { from ${q(from)} to ${q(to)} }`)
        }
        body.push('    }')
        stateMachines.push(body.join('\n'))
        dropped.push({
          clauseId: `entity:${entityName}`,
          kind: 'transition',
          severity: 'behavioral',
          islExcerpt: `lifecycle { ... }`,
          reason: `${entityName} transitions are projected with no bound command: neither dialect states who may perform them, so no role is granted. Downstream cannot derive an actor for this lifecycle`,
        })
      }
    }
  }

  // ── policies: no Engine ISL counterpart at all ─────────────────────────
  for (const policy of domain.policies ?? []) {
    refusals.push(policyRefusal(policy))
  }

  // ── behavior-level authorization ───────────────────────────────────────
  for (const behavior of domain.behaviors ?? []) {
    const name = idOf(behavior.name)
    for (const sec of behavior.security ?? []) {
      refusals.push({
        clauseId: `behavior-security:${name}`,
        kind: 'behavior-security',
        islExcerpt: JSON.stringify(sec),
        reason: `${name} declares a security requirement. Engine ISL attaches authority to commands, and a behavior's declared input/output shape has no engine command form, so the requirement would have nothing to attach to`,
      })
    }
    for (const ann of behavior.annotations ?? []) {
      if (idOf(ann.name) !== 'requireRole' || !ann.value) continue
      refusals.push({
        clauseId: `behavior-security:${name}`,
        kind: 'behavior-security',
        islExcerpt: `requireRole: ${expressionToIsl(ann.value)}`,
        reason: `${name} is gated on a role. Engine ISL has no behavior construct to carry that gate`,
      })
    }
    for (const pre of behavior.preconditions ?? []) {
      refusals.push({
        clauseId: `precondition:${name}`,
        kind: 'precondition',
        islExcerpt: expressionToIsl(pre),
        reason: `${name} declares a precondition. Engine ISL evaluates guards only on state-machine transitions, so this gate has no engine home and would silently stop gating`,
      })
    }
    // Everything else about a behavior is shape, not authority.
    dropped.push({
      clauseId: `behavior:${name}`,
      kind: 'behavior',
      severity: 'behavioral',
      islExcerpt: `behavior ${name}`,
      reason: `Engine ISL commands carry no input or output schema, so ${name}'s declared arguments and result type do not cross`,
    })
    for (const block of behavior.postconditions ?? []) {
      for (const pred of block.predicates ?? []) {
        dropped.push({
          clauseId: `behavior:${name}`,
          kind: 'postcondition',
          severity: 'behavioral',
          islExcerpt: expressionToIsl(pred),
          reason: `${name} postcondition: Engine ISL has no postcondition construct`,
        })
      }
    }
  }

  // ── reporting and integration constructs ───────────────────────────────
  for (const view of domain.views ?? []) {
    dropped.push({
      clauseId: `view:${idOf(view.name)}`,
      kind: 'view',
      severity: 'cosmetic',
      islExcerpt: `view ${idOf(view.name)}`,
      reason: 'Engine ISL has no view, aggregation, or cache construct',
    })
  }
  for (const agg of domain.aggregates ?? []) {
    dropped.push({
      clauseId: `aggregate:${idOf(agg.name)}`,
      kind: 'aggregate',
      severity: 'cosmetic',
      islExcerpt: `aggregate ${idOf(agg.name)}`,
      reason: 'Engine ISL has no aggregate construct',
    })
  }
  for (const inv of domain.invariants ?? []) {
    dropped.push({
      clauseId: `invariant:${idOf(inv.name)}`,
      kind: 'invariant',
      severity: 'behavioral',
      islExcerpt: `invariant ${idOf(inv.name)}`,
      reason:
        'Engine ISL invariants carry a single opaque `expression` string; the App Contract predicate list has no equivalent and is not re-expressible without reinterpretation',
    })
  }
  for (const provider of domain.auth?.providers ?? []) {
    dropped.push({
      clauseId: `auth-provider:${idOf(provider.name)}`,
      kind: 'auth-provider',
      severity: 'behavioral',
      islExcerpt: idOf(provider.name),
      reason: 'Engine ISL does not model authentication providers',
    })
  }
  for (const service of domain.integrations?.services ?? []) {
    dropped.push({
      clauseId: `integration:${idOf(service.name)}`,
      kind: 'integration',
      severity: 'behavioral',
      islExcerpt: idOf(service.name),
      reason: 'Engine ISL does not model external integrations',
    })
  }

  if (refusals.length > 0) return { status: 'refused', refusals, dropped, carriedAuthorization }

  const engineIsl = renderEngineDocument({
    engineId,
    version: domain.version?.value ?? '1.0.0',
    name: appName,
    intent: options.intent ?? contract.clauses.find((c) => c.id === 'app')?.title ?? appName,
    engineDomain: options.engineDomain,
    roleIds,
    entities,
    commands,
    stateMachines,
    permissions,
  })

  return { status: 'projected', engineIsl, dropped, carriedAuthorization, refusals: [] as const }
}

function policyRefusal(policy: Policy): AuthorizationRefusal {
  const name = idOf(policy.name)
  const target = policy.appliesTo?.target
  const targets =
    target === 'all' ? 'every entity' : (target ?? []).map((t) => idOf(t)).join(', ')
  const rules = (policy.rules ?? [])
    .map((rule) =>
      rule.condition
        ? `${expressionToIsl(rule.condition)}: ${expressionToIsl(rule.action)}`
        : `default: ${expressionToIsl(rule.action)}`,
    )
    .join('  ')
  return {
    clauseId: `policy:${name}`,
    kind: 'policy',
    islExcerpt: `policy ${name} { applies_to: ${targets}  rules { ${rules} } }`,
    reason: `Engine ISL has no policy construct. Its nearest form, an entity read rule, constrains reads only, so projecting this policy would silently drop its authority over writes and deletes on ${targets} while appearing to have carried it`,
  }
}

function renderEngineDocument(input: {
  engineId: string
  version: string
  name: string
  intent: string
  engineDomain: string
  roleIds: readonly string[]
  entities: readonly EmittedEntity[]
  commands: readonly string[]
  stateMachines: readonly string[]
  permissions: readonly string[]
}): string {
  const entityBlocks = input.entities.map((entity) =>
    [`    entity ${q(entity.id)} {`, ...entity.lines, '    }'].join('\n'),
  )
  const roleBlocks = input.roleIds.map((role) => `    role ${q(role)} { permissions [] }`)
  return `isl 1.1
engine ${q(input.engineId)} {
  version ${q(input.version)}
  name ${q(input.name)}
  intent ${q(input.intent)}
  domain ${q(input.engineDomain)}
  safety {}
  entities {
${entityBlocks.join('\n')}
  }
  capabilities {}
  commands {
${input.commands.join('\n')}
  }
  state_machines {
${input.stateMachines.join('\n')}
  }
  events {}
  invariants {}
  roles {
${roleBlocks.join('\n')}
  }
  permissions {
${input.permissions.join('\n')}
  }
  evidence {}
  proofs {}
  dependencies {}
  composition {
    emits []
    consumes []
    exports []
    callable []
    conflicts []
    proof_level "standard"
    isolation "tenant"
  }
  experience {}
  exports {}
}
`
}
