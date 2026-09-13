/**
 * Observation → proposed ISL, deterministically.
 *
 * A validated `ObservedIntent` projects through the same Mini-ISL expander the
 * natural-language path uses — an imported app and a described app land on
 * identical ISL constructs, so there is no second lowering to maintain or
 * distrust. Two things ride on top:
 *
 *   1. Alignment patches. The expander synthesizes lifecycle edges, and the
 *      draft schema cannot carry permission grants. Wherever the implementation
 *      was actually observed, governed patches force the proposal to match the
 *      observation exactly — synthesized guesses never survive contact with
 *      real evidence.
 *
 *   2. Ambiguity derivation. Every unknown the observations leave open is
 *      derived here by fixed rules, scored by how much the answer changes the
 *      contract (permissions > data model > workflow > invariants). Only
 *      materially consequential unknowns become questions; cosmetic ones are
 *      recorded as assumptions and never interrupt the user.
 *
 * No ruling logic lives here. This module proposes; the seal decides.
 */

import {
  validateIntentDraft,
  type DraftEntity,
  type DraftField,
  type DraftFieldType,
  type IntentDraft,
} from '../nl/draft.js';
import { IMPACT_WEIGHTS } from '../nl/questions.js';
import { applyPatch } from '../patch/apply.js';
import type { ContractOp } from '../patch/ops.js';
import { draftToContract } from '../nl/to-isl.js';
import type { AppContract, ClauseId } from '../canonical/types.js';
import {
  LOW_CONFIDENCE_FLOOR,
  OBSERVED_INTENT_SCHEMA_VERSION,
  ObservedIntentError,
  ObservedIntentSchema,
  SurfacedAmbiguitySchema,
  isMaterialImpact,
  type ObservedEntity,
  type ObservedEvidence,
  type ObservedField,
  type ObservedIntent,
  type ObservedPermission,
  type SurfacedAmbiguity,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// naming

function pascal(value: string): string {
  return value
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

function camel(value: string): string {
  const p = pascal(value);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

function snake(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/** Mirror of the NL layer's minor-unit convention: money fields gain `Cents`. */
export function storageFieldName(name: string, type: DraftFieldType): string {
  if (type !== 'money') return name;
  return /cents$/i.test(name) ? name : `${name}Cents`;
}

function sameShape(a: ObservedField, b: ObservedField): boolean {
  return (
    a.type === b.type &&
    a.optional === b.optional &&
    a.searchable === b.searchable &&
    a.choices.join(',') === b.choices.join(',') &&
    a.endStates.join(',') === b.endStates.join(',')
  );
}

const key = (...parts: string[]): string => parts.join(':');

// ─────────────────────────────────────────────────────────────────────────────
// normalization

/** One observation per fact, normalized, with conflicts resolved conservatively. */
export interface CleanObservation {
  observed: ObservedIntent;
  /** Effective row per entity+action after collapsing sightings. */
  permissionRows: Map<string, ObservedPermission>;
  /** Entity.field keys where two evidences disagreed (first sighting kept). */
  conflictedFields: Map<string, true>;
}

/**
 * Normalize identifiers to the conventions downstream identity derives from,
 * fold exact duplicates (one fact seen in many files), and resolve conflicting
 * observations to their most restrictive reading. Every resolution becomes
 * either a surfaced ambiguity or a recorded assumption — never a silent pick.
 */
export function cleanObservedIntent(raw: ObservedIntent): CleanObservation {
  const entities: ObservedEntity[] = [];
  const conflictedFields = new Map<string, true>();

  for (const entity of raw.entities) {
    const name = pascal(entity.name);
    const fields: ObservedField[] = [];
    const seen = new Map<string, ObservedField>();
    for (const field of entity.fields) {
      const fieldName = camel(field.name);
      const normalized: ObservedField = {
        ...field,
        name: fieldName,
        choices: field.choices.map(snake).filter(Boolean),
        endStates: field.endStates
          .map((s) => snake(s))
          .filter((s) => field.choices.map(snake).includes(s)),
      };
      const prior = seen.get(fieldName.toLowerCase());
      if (!prior) {
        seen.set(fieldName.toLowerCase(), normalized);
        fields.push(normalized);
        continue;
      }
      if (sameShape(prior, normalized)) continue; // exact duplicate — one fact, many files
      // Conflicting shapes: keep the first (the default), surface the fight.
      conflictedFields.set(key(name, fieldName), true);
    }
    entities.push({
      ...entity,
      name,
      fields,
      linksTo: entity.linksTo.map(pascal),
    });
  }

  const roles = raw.roles.map((role) => ({ ...role, name: snake(role.name) }));
  const transitions = raw.transitions.map((t) => ({
    ...t,
    entity: pascal(t.entity),
    from: snake(t.from),
    to: snake(t.to),
  }));

  // Permission sightings collapse to one row per entity+action: identical
  // duplicates fold; disagreeing rows resolve to the intersection of grants,
  // with the ownership term surviving only when every sighting included it.
  const permissionRows = new Map<string, ObservedPermission>();
  for (const row of raw.permissions) {
    const rowKey = key(pascal(row.entity), row.action);
    const normalizedRow: ObservedPermission = {
      ...row,
      entity: pascal(row.entity),
      roles: row.roles.map(snake),
    };
    const prior = permissionRows.get(rowKey);
    if (!prior) {
      permissionRows.set(rowKey, normalizedRow);
      continue;
    }
    const mergedRoles = prior.roles.filter((r) => normalizedRow.roles.includes(r));
    const mergedOwner =
      prior.owner === null && normalizedRow.owner === null
        ? null
        : prior.owner === true && normalizedRow.owner === true
          ? true
          : false;
    permissionRows.set(rowKey, {
      ...prior,
      roles: mergedRoles,
      owner: mergedOwner,
      confidence: Math.min(prior.confidence, normalizedRow.confidence),
    });
  }

  // A grant naming an unlisted role registers that role — the implementation
  // demonstrably has it; failing here would misdescribe the observed world.
  for (const row of permissionRows.values()) {
    for (const role of row.roles) {
      if (!roles.some((r) => r.name === role)) {
        roles.push({ name: role, evidence: row.evidence, confidence: row.confidence });
      }
    }
  }

  return {
    observed: { ...raw, entities, roles, transitions, permissions: [...permissionRows.values()] },
    permissionRows,
    conflictedFields,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// evidence stamping

function refOf(e: ObservedEvidence): string {
  return `${e.kind} ${e.ref}`;
}

function evidenceText(anchor: string, evidence: ObservedEvidence[]): string {
  const full = `Observed in ${anchor} — ${evidence.map(refOf).join('; ')}`;
  return full.length > 380 ? `${full.slice(0, 377)}…` : full;
}

/**
 * Stamp every non-system clause with where its meaning came from: the
 * observation's evidence trail. Confidence stays the observation's, never the
 * projection's — the projection is deterministic; the seeing was not.
 */
function restampProvenance(contract: AppContract, observation: CleanObservation): void {
  const anchor = observation.observed.observedFrom;
  const entityByName = new Map(observation.observed.entities.map((e) => [e.name, e]));
  const fieldByPath = new Map<string, ObservedField>();
  for (const entity of observation.observed.entities) {
    for (const field of entity.fields) fieldByPath.set(`${entity.name}.${field.name}`, field);
  }

  for (const clause of contract.clauses) {
    const meta = contract.meta.clauses[clause.id];
    if (!meta || meta.source === 'system') continue;

    let confidence = meta.confidence;
    let evidence: ObservedEvidence[] | undefined;

    const entityMatch = /^entity:([A-Za-z_]\w*)$/.exec(clause.id);
    const fieldMatch = /^(?:field|status-set|relationship):([A-Za-z_]\w*)\.([^->]+)/.exec(
      clause.id,
    );
    const roleMatch = /^role:([a-z0-9_]+)$/.exec(clause.id);
    const transitionMatch = /^transition:([A-Za-z_]\w*):(.+)>(.+)$/.exec(clause.id);
    const permissionMatch = /^permission:([A-Za-z_]\w*):(read|write|delete)$/.exec(clause.id);

    if (entityMatch) {
      const entity = entityByName.get(entityMatch[1]!);
      if (entity) {
        confidence = entity.confidence;
        evidence = entity.evidence;
      }
    } else if (fieldMatch) {
      const field = fieldByPath.get(`${fieldMatch[1]}.${camel(fieldMatch[2]!)}`);
      if (field) {
        confidence = field.confidence;
        evidence = field.evidence;
      } else {
        const owner = entityByName.get(fieldMatch[1]!);
        if (owner) {
          confidence = owner.confidence;
          evidence = owner.evidence;
        }
      }
    } else if (roleMatch) {
      const role = observation.observed.roles.find((r) => r.name === roleMatch[1]);
      if (role) {
        confidence = role.confidence;
        evidence = role.evidence;
      }
    } else if (transitionMatch) {
      const t = observation.observed.transitions.find(
        (c) =>
          c.entity === transitionMatch[1] &&
          c.from === transitionMatch[2]!.toLowerCase() &&
          c.to === transitionMatch[3]!.toLowerCase(),
      );
      if (t) {
        confidence = t.confidence;
        evidence = t.evidence;
      }
    } else if (permissionMatch) {
      const row = observation.permissionRows.get(key(permissionMatch[1]!, permissionMatch[2]!));
      if (row) {
        confidence = row.confidence;
        evidence = row.evidence;
      }
    }

    contract.meta.clauses[clause.id] = {
      ...meta,
      source: 'imported',
      confirmed: false,
      confidence,
      rationale: evidence ? evidenceText(anchor, evidence) : `Observed in ${anchor}.`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// projection

type EnumTypeRef = { kind?: string; variants?: { name: { name: string } }[] };

function enumVariantsOf(contract: AppContract, typeName: string): string[] {
  if (!typeName) return [];
  const decl = contract.domain.types?.find((t) => t.name.name === typeName);
  const def = decl?.definition as EnumTypeRef | undefined;
  if (def?.kind !== 'EnumType') return [];
  return (def.variants ?? []).map((v) => v.name.name);
}

function typeNameOf(fieldType: unknown): string {
  const parts = (fieldType as { name?: { parts?: { name?: string }[] } })?.name?.parts;
  return (parts ?? []).map((p) => p.name).join('.');
}

/**
 * Ops that force each projected lifecycle to match the observed edges exactly —
 * synthesized edges the implementation never showed are removed, observed ones
 * added. Edges naming states outside the entity's enums fail closed.
 */
function lifecycleAlignmentOps(
  observedTransitions: ObservedIntent['transitions'],
  contract: AppContract,
): ContractOp[] {
  const ops: ContractOp[] = [];

  for (const entity of contract.domain.entities ?? []) {
    const entityName = entity.name.name;
    const seen = observedTransitions.filter((t) => t.entity === entityName);
    if (!seen.length) continue;

    const states = new Set<string>();
    for (const field of entity.fields ?? []) {
      for (const variant of enumVariantsOf(contract, typeNameOf(field.type))) states.add(variant);
    }

    const canonicalState = new Map([...states].map((state) => [state.toLowerCase(), state]));
    const invalid = seen.filter(
      (t) => !canonicalState.has(t.from.toLowerCase()) || !canonicalState.has(t.to.toLowerCase()),
    );
    if (invalid.length) {
      throw new ObservedIntentError(
        `Observed transitions on ${entityName} reference states the implementation does not define`,
        invalid.map((t) => `${t.from} → ${t.to}`),
      );
    }

    const current = new Set(
      (entity.lifecycle?.transitions ?? []).map((t) => key(t.from.name, t.to.name)),
    );
    const canonicalSeen = seen.map((t) => ({
      ...t,
      from: canonicalState.get(t.from.toLowerCase())!,
      to: canonicalState.get(t.to.toLowerCase())!,
    }));
    const target = new Set(canonicalSeen.map((t) => key(t.from, t.to)));

    for (const edge of current) {
      if (target.has(edge)) continue;
      const [from, to] = edge.split(':');
      ops.push({ op: 'remove-transition', entity: entityName, from: from!, to: to! });
    }
    for (const t of canonicalSeen) {
      if (current.has(key(t.from, t.to))) continue;
      ops.push({ op: 'add-transition', entity: entityName, from: t.from, to: t.to });
    }
  }
  return ops;
}

interface BuildOptions {
  /**
   * Ruled-out observation keys (`transition:E:f>t`, `perm:E:action`). Rejected
   * observations must not leak back in through the alignment pass.
   */
  excluded?: ReadonlySet<string>;
}

/**
 * Project a validated draft into ISL and force the result to match every
 * observation that survived rulings. Deterministic: same draft, same
 * observation, same output hash.
 */
export function buildProposalContract(
  draft: IntentDraft,
  observation: CleanObservation,
  options: BuildOptions = {},
): { contract: AppContract; islSource: string; mini: string; warnings: string[] } {
  const projected = draftToContract(draft);
  if (!projected.ok) {
    throw new ObservedIntentError(
      'The observed structure does not project to ISL',
      projected.errors,
    );
  }

  let contract = projected.contract;
  const excluded = options.excluded ?? new Set<string>();

  // Rejecting an inferred edge graph keeps the choice field but removes every
  // synthesized transition. Mini-ISL otherwise regenerates its forward-path
  // default even after endStates is cleared.
  const suppressedLifecycleEntities = new Set(
    [...excluded]
      .filter((entry) => entry.startsWith('lifecycle:'))
      .map((entry) => entry.split(':')[1])
      .filter((entity): entity is string => Boolean(entity)),
  );
  if (suppressedLifecycleEntities.size) {
    const ops: ContractOp[] = [];
    for (const entity of contract.domain.entities ?? []) {
      if (!suppressedLifecycleEntities.has(entity.name.name)) continue;
      for (const transition of entity.lifecycle?.transitions ?? []) {
        ops.push({
          op: 'remove-transition',
          entity: entity.name.name,
          from: transition.from.name,
          to: transition.to.name,
        });
      }
    }
    if (ops.length) {
      const result = applyPatch(contract, {
        id: 'observed-base:rejected-lifecycle',
        title: 'Remove rejected inferred workflow edges',
        origin: 'imported',
        rationale:
          'The observer did not see these synthesized transition edges and the user rejected them.',
        ops,
      });
      if (!result.ok) {
        throw new ObservedIntentError('Rejected workflow edges could not be removed', [
          result.message,
          ...(result.detail ? [result.detail] : []),
        ]);
      }
      contract = result.contract;
    }
  }

  // Lifecycle: exact observed edges replace synthesized ones.
  const observedTransitions = observation.observed.transitions.filter(
    (t) =>
      !suppressedLifecycleEntities.has(t.entity) &&
      !excluded.has(key('transition', t.entity, `${t.from}>${t.to}`)),
  );
  if (observedTransitions.length) {
    const ops = lifecycleAlignmentOps(observedTransitions, contract);
    if (ops.length) {
      const result = applyPatch(contract, {
        id: 'observed-base:lifecycle',
        title: 'Carry observed workflow edges',
        origin: 'imported',
        rationale: 'Transition edges seen in the implementation replace synthesized defaults.',
        ops,
      });
      if (!result.ok) {
        throw new ObservedIntentError(
          'Observed transitions could not be carried into the proposal',
          [result.message, ...(result.detail ? [result.detail] : [])],
        );
      }
      contract = result.contract;
    }
  }

  // Permissions: observed grants become explicit rules.
  const grants = observation.observed.permissions.filter(
    (row) => !excluded.has(key('perm', row.entity, row.action)),
  );
  if (grants.length) {
    const ops: ContractOp[] = grants.map((row) => ({
      op: 'set-permission',
      entity: row.entity,
      action: row.action,
      roles: row.roles,
      ...(row.owner === true ? { owner: true } : {}),
    }));
    for (let i = 0; i < ops.length; i += 40) {
      const result = applyPatch(contract, {
        id: i === 0 ? 'observed-base:permissions' : `observed-base:permissions/${i}`,
        title: 'Carry observed authorization',
        origin: 'imported',
        rationale: 'Authorization grants read out of the implementation.',
        ops: ops.slice(i, i + 40),
      });
      if (!result.ok) {
        throw new ObservedIntentError(
          'Observed permissions could not be carried into the proposal',
          [result.message, ...(result.detail ? [result.detail] : [])],
        );
      }
      contract = result.contract;
    }
  }

  restampProvenance(contract, observation);

  return {
    contract,
    islSource: contract.islSource,
    mini: projected.mini,
    warnings: [...projected.warnings],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ambiguity derivation

function makeItem(input: {
  id: string;
  topic: keyof typeof IMPACT_WEIGHTS;
  question: string;
  why: string;
  defaultResolution: string;
  subjectClauseIds: string[];
  rejectable: boolean;
  conflictBoost?: boolean;
  scoreAdjustment?: number;
}): SurfacedAmbiguity {
  const score =
    IMPACT_WEIGHTS[input.topic] + (input.conflictBoost ? 5 : 0) + (input.scoreAdjustment ?? 0);
  return SurfacedAmbiguitySchema.parse({
    id: input.id,
    topic: input.topic,
    score,
    material: true, // immaterial unknowns are recorded, never surfaced
    question: input.question,
    why: input.why,
    defaultResolution: input.defaultResolution,
    subjectClauseIds: [...new Set(input.subjectClauseIds)],
    rejectable: input.rejectable,
  });
}

function isStatusField(field: DraftField): boolean {
  return field.type === 'choice' && field.choices.length >= 2 && field.endStates.length >= 1;
}

/**
 * Derive every ambiguity the observations leave open. Deterministic order:
 * highest impact first, conflicts over defaults, then stable id order.
 */
export function deriveAmbiguities(
  draft: IntentDraft,
  observation: CleanObservation,
  contract: AppContract,
): SurfacedAmbiguity[] {
  const items: SurfacedAmbiguity[] = [];
  const observed = observation.observed;
  const exists = (id: ClauseId) => Boolean(contract.meta.clauses[id]);

  // 1. Ownership — decides every row-level check in the rebuilt app.
  for (const entity of observed.entities) {
    if (entity.ownedByUser !== null) continue;
    items.push(
      makeItem({
        id: key('own', entity.name),
        topic: 'permissions',
        question: `Should each person see only their own ${entity.name.toLowerCase()} records?`,
        why: 'This decides what each person can view or change, enforced on the server — the wrong guess exposes someone’s data.',
        defaultResolution: `Yes — ${entity.name} records belong to the person who created them.`,
        subjectClauseIds: [`entity:${entity.name}`].filter(exists),
        rejectable: true,
      }),
    );
  }

  // 2. Workflow edges. A list of stages is not a graph.
  const entitiesWithEdges = new Set(observed.transitions.map((t) => t.entity));
  for (const entity of observed.entities) {
    if (entitiesWithEdges.has(entity.name)) continue;
    for (const field of entity.fields) {
      if (!isStatusField(field as unknown as DraftField)) continue;
      const stored = storageFieldName(field.name, field.type);
      items.push(
        makeItem({
          id: key('edges', `${entity.name}.${stored}`),
          topic: 'workflow',
          question: `${entity.name} moves through ${field.choices.join(', ')} — which steps are allowed?`,
          why: 'The allowed steps are what the server enforces; guessing them changes what the rebuilt system permits.',
          defaultResolution: `Forward path only: each stage advances to the next, ending at ${field.endStates.join(', ')}.`,
          subjectClauseIds: [
            `status-set:${entity.name}.${stored}`,
            `field:${entity.name}.${stored}`,
          ].filter(exists),
          rejectable: true,
        }),
      );
    }
  }

  // 3. Roles. Without them there is one undifferentiated user and no gates.
  if (!draft.roles.length) {
    items.push(
      makeItem({
        id: 'roles',
        topic: 'permissions',
        question: 'Does everyone using this app do the same job?',
        why: 'Separate roles are what let you approve, restrict, or hand off work after the rebuild.',
        defaultResolution: 'One shared role for now; visibility stays owner-scoped.',
        subjectClauseIds: [],
        rejectable: false,
      }),
    );
  }

  // 4. Approval over money. Cheap to decide now, expensive to retrofit.
  for (const entity of observed.entities) {
    const hasMoney = entity.fields.some((f) => f.type === 'money');
    const hasWorkflow = entity.fields.some((f) => isStatusField(f as unknown as DraftField));
    if (!hasMoney || !hasWorkflow) continue;
    if (observed.rules.some((r) => /approv/i.test(r.statement))) continue;
    items.push(
      makeItem({
        id: key('approve', entity.name),
        topic: 'invariant',
        question: `Does a large ${entity.name.toLowerCase()} need someone else to approve it before it completes?`,
        why: 'An approval step adds a stage, a permission, and a server-enforced rule.',
        defaultResolution: 'No approval step — whoever owns it can complete it.',
        subjectClauseIds: [],
        rejectable: false,
      }),
    );
  }

  // 5. Destructive gaps. Delete paths are the least visible and most dangerous.
  for (const entity of observed.entities) {
    if (observation.permissionRows.has(key(entity.name, 'delete'))) continue;
    const authzSeen = [...observation.permissionRows.keys()].some((k) =>
      k.startsWith(`${entity.name}:`),
    );
    if (!authzSeen && entity.ownedByUser !== true) continue;
    items.push(
      makeItem({
        id: key('grant', entity.name, 'delete'),
        topic: 'permissions',
        question: `Who may delete ${entity.name.toLowerCase()} records?`,
        why: 'Deletion destroys history; the rebuild will not invent a grant nobody confirmed.',
        defaultResolution: 'Nobody may delete until you say otherwise.',
        subjectClauseIds: [],
        rejectable: false,
      }),
    );
  }

  // 6. Conflicting evidence.
  for (const conflictKey of observation.conflictedFields.keys()) {
    const separator = conflictKey.indexOf(':');
    const entityName = conflictKey.slice(0, separator);
    const fieldName = conflictKey.slice(separator + 1);
    const type =
      observed.entities.find((e) => e.name === entityName)?.fields.find((f) => f.name === fieldName)
        ?.type ?? 'text';
    items.push(
      makeItem({
        id: key('conflict', 'field', `${entityName}.${storageFieldName(fieldName, type)}`),
        topic: 'data-model',
        question: `Two parts of the implementation describe ${entityName}.${fieldName} differently — which is right?`,
        why: 'The two readings produce different columns and different validation.',
        defaultResolution: 'Kept the first sighting; the other was set aside.',
        subjectClauseIds: [`field:${entityName}.${storageFieldName(fieldName, type)}`].filter(
          exists,
        ),
        rejectable: true,
        conflictBoost: true,
      }),
    );
  }

  // 7. Low-confidence sightings.
  for (const entity of observed.entities) {
    if (entity.confidence < LOW_CONFIDENCE_FLOOR) {
      items.push(
        makeItem({
          id: key('lowconf', 'entity', entity.name),
          topic: 'data-model',
          question: `Only weak evidence shows a ${entity.name} record type — keep it?`,
          why: 'A wrong record type spreads through every screen, table, and rule downstream.',
          defaultResolution: `Keep ${entity.name} as observed.`,
          subjectClauseIds: [`entity:${entity.name}`].filter(exists),
          rejectable: true,
          scoreAdjustment: -25,
        }),
      );
    }
    for (const field of entity.fields) {
      if (field.confidence >= LOW_CONFIDENCE_FLOOR) continue;
      const stored = storageFieldName(field.name, field.type);
      items.push(
        makeItem({
          id: key('lowconf', 'field', `${entity.name}.${stored}`),
          topic: 'data-model',
          question: `Keep the ${fieldNameLabel(field)} field on ${entity.name}? The evidence for it is thin.`,
          why: 'Fields drive tables, forms, and permissions; a guess here compounds.',
          defaultResolution: `Keep ${stored} as observed.`,
          subjectClauseIds: [`field:${entity.name}.${stored}`].filter(exists),
          rejectable: true,
          scoreAdjustment: -25,
        }),
      );
    }
  }
  for (const role of observed.roles) {
    if (role.confidence >= LOW_CONFIDENCE_FLOOR) continue;
    items.push(
      makeItem({
        id: key('lowconf', 'role', role.name),
        topic: 'permissions',
        question: `Keep the “${role.name.replace(/_/g, ' ')}” role? The evidence for it is thin.`,
        why: 'Roles decide who may do what; a phantom role quietly widens access.',
        defaultResolution: `Keep ${role.name} as observed.`,
        subjectClauseIds: [`role:${role.name}`].filter(exists),
        rejectable: true,
        scoreAdjustment: -25,
      }),
    );
  }
  for (const row of observed.permissions) {
    if (row.confidence >= LOW_CONFIDENCE_FLOOR) continue;
    items.push(
      makeItem({
        id: key('lowconf', 'perm', row.entity, row.action),
        topic: 'permissions',
        question: `Keep the observed ${row.action} access on ${row.entity}, exactly as seen?`,
        why: 'Carrying an uncertain grant forward bakes it into the rebuilt server.',
        defaultResolution: `Keep ${row.action} exactly as observed.`,
        subjectClauseIds: [`permission:${row.entity}:${row.action}`].filter(exists),
        rejectable: true,
        scoreAdjustment: -25,
      }),
    );
  }
  for (const t of observed.transitions) {
    if (t.confidence >= LOW_CONFIDENCE_FLOOR) continue;
    items.push(
      makeItem({
        id: key('lowconf', 'transition', t.entity, `${t.from}>${t.to}`),
        topic: 'workflow',
        question: `Keep the ${t.from} → ${t.to} step on ${t.entity}? The evidence is thin.`,
        why: 'Every allowed step is something the server will permit forever.',
        defaultResolution: `Keep ${t.from} → ${t.to} as observed.`,
        subjectClauseIds: [`transition:${t.entity}:${t.from}>${t.to}`].filter(exists),
        rejectable: false,
        scoreAdjustment: -25,
      }),
    );
  }

  return items.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}

function fieldNameLabel(field: ObservedField): string {
  return field.name
    .replace(/Cents$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// entry point

export type ProposeResult =
  | {
      ok: true;
      observed: ObservedIntent;
      draft: IntentDraft;
      islSource: string;
      mini: string;
      warnings: string[];
      contract: AppContract;
      ambiguities: SurfacedAmbiguity[];
    }
  | { ok: false; errors: string[] };

/**
 * Turn a validated observation into the proposed contract plus the ranked
 * ambiguity list. Pure: same input, same proposal, same hashes.
 */
export function proposeFromObservation(raw: unknown): ProposeResult {
  const parsed = ObservedIntentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }

  const observation = cleanObservedIntent(parsed.data);

  const draft: IntentDraft = {
    appName: observation.observed.appName,
    purpose: observation.observed.purpose,
    roles: observation.observed.roles.map((role) => ({
      name: role.name,
      description: '',
      source: 'imported' as const,
      confidence: role.confidence,
    })),
    entities: observation.observed.entities.map((entity): DraftEntity => ({
      name: entity.name,
      description: entity.description,
      ownedByUser: entity.ownedByUser ?? true,
      linksTo: entity.linksTo,
      source: 'imported' as const,
      confidence: entity.confidence,
      fields: entity.fields.map((field): DraftField => ({
        name: field.name,
        type: field.type,
        optional: field.optional,
        searchable: field.searchable,
        choices: field.choices,
        endStates: field.endStates,
        source: 'imported' as const,
        confidence: field.confidence,
      })),
    })),
    reports: [],
    rules: observation.observed.rules.map((rule) => ({
      statement: rule.statement,
      source: 'imported' as const,
      confidence: rule.confidence,
    })),
    integrations: [],
    assumptions: [],
  };

  const validated = validateIntentDraft(draft);
  if (!validated.ok) return { ok: false, errors: validated.errors };

  let built;
  try {
    built = buildProposalContract(validated.draft, observation);
  } catch (error) {
    if (error instanceof ObservedIntentError)
      return { ok: false, errors: error.reasons as string[] };
    throw error;
  }

  const ambiguities = deriveAmbiguities(validated.draft, observation, built.contract);

  return {
    ok: true,
    observed: observation.observed,
    draft: validated.draft,
    islSource: built.islSource,
    mini: built.mini,
    warnings: [...built.warnings, ...validated.warnings],
    contract: built.contract,
    ambiguities,
  };
}
