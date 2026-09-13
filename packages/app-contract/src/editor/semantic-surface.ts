/**
 * The semantic surface — the contract projected into stable, selectable
 * provenance nodes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * APP-AS-EDITOR: the running application should be a semantic editing surface.
 * When a founder selects "Estimate Amount" in their live app they must get
 * MEANING — `type: Money`, `object: Estimate`, used by which rules, bound to
 * which proofs — not a CSS property sheet.
 *
 * The only honest way to get that is to emit it during compilation. The
 * compiler already knows, at emit time, that a rendered column is
 * `field:Estimate.amount`; guessing it back out of the DOM after the fact is
 * exactly the brittle path this module exists to make unnecessary. So:
 *
 *   1. Emitters stamp generated controls with the STABLE clause id
 *      (`data-ws-prov="field:Estimate.amount"`).
 *   2. This module projects the same contract into the manifest those ids
 *      resolve against — meaning, reverse dependencies (usedBy), and any proof
 *      obligations the build bound to the clause.
 *   3. A runtime selection (a click in the preview) carries only ids; the
 *      parent resolves them here and renders what they MEAN.
 *
 * The id scheme is {@link CLAUSE_ID_SCHEME} — name-derived, deterministic, and
 * already the identity every other surface (App Map, Blueprint, patches,
 * lockfile) addresses clauses by. A selection in the app and a node on the map
 * are therefore the SAME node; no second addressing scheme is introduced.
 *
 * PURE — no fs, no network, no model. Deterministic: the same contract always
 * yields the same surface, so it can be hashed, diffed, and sealed like any
 * other derived artifact (frozen law 7).
 */
import type {
  AppContract,
  BlueprintSection,
  Clause,
  ClauseId,
  ClauseKind,
} from '../canonical/types.js';
import { humanizeTypeName, isMinorUnitField } from '../canonical/expression.js';
import type { ClauseSemantic } from '../canonical/semantic.js';

/** Bumped when the surface shape changes incompatibly (sidecar consumers key on it). */
export const SEMANTIC_SURFACE_SCHEMA_VERSION = 'semantic-surface/1' as const;
export type SemanticSurfaceSchemaVersion = typeof SEMANTIC_SURFACE_SCHEMA_VERSION;

/**
 * How a selected control's VALUE behaves — declared-truth classification.
 *
 * Derived ONLY from what the contract states (the field's declared type, its
 * type arguments, or the repo-wide minor-units convention applied to the DECLARED
 * field name at compile time). Never from sample data, never from the DOM.
 */
export type SemanticValueClass =
  'money' | 'count' | 'flag' | 'date' | 'text' | 'reference' | 'unknown';

/**
 * A screen region the compiler can bind — one component of a `screen` clause.
 *
 * Region ids are stable and name-derived (`screen:TaskBoard#ApprovalsBoard`), so
 * an experience region selected in the running app resolves to the exact clause
 * component that emitted it.
 */
export interface SemanticRegion {
  /** Stable region id: `<clauseId>#<ComponentName>`. */
  id: string;
  /** The screen component's declared name. */
  component: string;
  /** Entity this region presents, when the contract binds one. */
  entity: string | null;
  /** Behavior (action) this region invokes, when the contract binds one. */
  behavior: string | null;
}

/** One selectable unit of meaning — a clause as the app-as-editor sees it. */
export interface ProvenanceNode {
  /** Stable clause id — the value emitters stamp into `data-ws-prov`. */
  id: ClauseId;
  kind: ClauseKind;
  section: BlueprintSection;
  /** Human label from the declared identifier, never from the sentence prose. */
  label: string;
  /** The clause's own plain-English sentence. */
  title: string;

  /**
   * The object this node belongs to or acts on: an owning entity for a
   * field/permission/transition, the constrained entity for an invariant, the
   * presented entity for a view/screen component. Null when the contract names
   * none — absent is honest, guessed is not.
   */
  object: string | null;
  /**
   * Canonical declared value type for fields. Generic arguments are absent when
   * the parser could validate but not retain them. Null for every other kind.
   */
  valueType: string | null;
  /** Declared-value classification (see {@link SemanticValueClass}). */
  valueClass: SemanticValueClass;
  /** Lifecycle states this node declares or moves between, in declaration order. */
  states: string[];
  /** Roles this node grants to or requires of, sorted. */
  roles: string[];

  /** Clause ids this node depends on (declared refs). */
  refs: ClauseId[];
  /** Clause ids that depend on this node — computed reverse index. */
  usedBy: ClauseId[];
  /**
   * Proof obligation ids the build bound to this clause. Empty unless the
   * caller supplied bindings; never inferred here.
   */
  affectedProofs: string[];
  /** Screen components this clause emits (screens only). */
  regions: SemanticRegion[];
}

export interface SemanticSurface {
  schemaVersion: SemanticSurfaceSchemaVersion;
  appName: string;
  contractHash: string;
  /** Every non-plumbing clause, in contract order — the resolution index. */
  nodes: ProvenanceNode[];
}

export interface BuildSemanticSurfaceOptions {
  /**
   * Proof obligation ids keyed by clause id (from the build's proof-obligation
   * planner). Optional: a contract resolved outside a build simply has empty
   * `affectedProofs` rather than invented ones.
   */
  proofsByClause?: Readonly<Record<string, readonly string[]>>;
}

// ---------------------------------------------------------------------------
// Value classification (declared truth only)
// ---------------------------------------------------------------------------

const MONEY_TYPE = /^money(\b|<)/i;
const FLAG_TYPES = /^(bool|boolean)$/i;
const DATE_TYPES = /^(date|datetime|timestamp)\b/i;
const NUMERIC_TYPES = /^(int|integer|float|double|decimal|number|numeric|bigint|smallint)\b/i;

function classifyField(semantic: Extract<ClauseSemantic, { kind: 'field' }>): SemanticValueClass {
  if (MONEY_TYPE.test(semantic.type) || isMinorUnitField(semantic.field)) return 'money';
  const generic = (semantic.typeArguments[0] ?? '').toLowerCase();
  if (generic === 'entity' || semantic.annotations.some((a) => a.name === 'ref'))
    return 'reference';
  if (FLAG_TYPES.test(semantic.type)) return 'flag';
  if (DATE_TYPES.test(semantic.type)) return 'date';
  if (NUMERIC_TYPES.test(semantic.type)) return 'count';
  if (semantic.type.trim()) return 'text';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Per-kind meaning projection
// ---------------------------------------------------------------------------

interface MeaningProjection {
  object: string | null;
  valueType: string | null;
  valueClass: SemanticValueClass;
  states: string[];
  roles: string[];
}

const UNPROJECTED: MeaningProjection = {
  object: null,
  valueType: null,
  valueClass: 'unknown',
  states: [],
  roles: [],
};

/**
 * Project the typed payload into display facts.
 *
 * A clause without a semantic payload (still mid-migration per
 * `canonical/types.ts`) projects as unprojected rather than guessing from the
 * ISL excerpt — a made-up fact in the inspector would be worse than an empty row.
 */
function projectMeaning(clause: Clause): MeaningProjection {
  const semantic = clause.semantic;
  if (!semantic || semantic.kind !== clause.kind) return UNPROJECTED;

  switch (semantic.kind) {
    case 'field':
      return {
        object: semantic.entity,
        valueType: semantic.typeArguments.length
          ? `${semantic.type}<${semantic.typeArguments.join(', ')}>`
          : semantic.type,
        valueClass: classifyField(semantic),
        states: [],
        roles: [],
      };
    case 'entity':
      return { ...UNPROJECTED, object: semantic.entity };
    case 'status-set':
      return { ...UNPROJECTED, object: semantic.entity, states: [...semantic.states] };
    case 'transition':
      return {
        ...UNPROJECTED,
        object: semantic.entity,
        states: [semantic.from, semantic.to],
        roles: [...semantic.principals],
      };
    case 'permission':
      return {
        ...UNPROJECTED,
        object: semantic.entity,
        roles: [...semantic.roles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      };
    case 'behavior':
      return { ...UNPROJECTED, object: null, roles: [] };
    case 'invariant':
      return { ...UNPROJECTED, object: semantic.entity };
    case 'view':
    case 'aggregate':
    case 'query':
      return { ...UNPROJECTED, object: semantic.forEntity };
    case 'job':
      return { ...UNPROJECTED, object: semantic.forEntity };
    case 'notification':
      return { ...UNPROJECTED, object: semantic.forEntity, roles: semantic.to ? [semantic.to] : [] };
    case 'policy':
      return { ...UNPROJECTED, object: semantic.appliesTo };
    default:
      return UNPROJECTED;
  }
}

function projectRegions(clause: Clause): SemanticRegion[] {
  if (clause.kind !== 'screen') return [];
  const semantic = clause.semantic;
  if (!semantic || semantic.kind !== 'screen') return [];
  return semantic.components.map((component) => ({
    id: `${clause.id}#${component.name}`,
    component: component.name,
    entity: component.entity,
    behavior: component.behavior,
  }));
}

// ---------------------------------------------------------------------------
// Surface builder + resolver
// ---------------------------------------------------------------------------

/** Project a contract into the selectable semantic surface. */
export function buildSemanticSurface(
  contract: AppContract,
  options: BuildSemanticSurfaceOptions = {},
): SemanticSurface {
  const proofsByClause = options.proofsByClause ?? {};

  // Pass 1: nodes with declared meaning.
  const nodes = new Map<ClauseId, ProvenanceNode>();
  for (const clause of contract.clauses) {
    if (clause.plumbing) continue;
    const meaning = projectMeaning(clause);
    // `field:Estimate.amount` labels as "Amount" — the owning entity is already
    // carried on `object`, so repeating it in the label reads twice.
    const suffix =
      clause.kind === 'field'
        ? clause.id.slice(clause.id.indexOf('.') + 1)
        : clause.id.includes(':')
          ? clause.id.slice(clause.id.indexOf(':') + 1)
          : clause.id;
    nodes.set(clause.id, {
      id: clause.id,
      kind: clause.kind,
      section: clause.section,
      label: humanizeTypeName(suffix),
      title: clause.title,
      object: meaning.object,
      valueType: meaning.valueType,
      valueClass: meaning.valueClass,
      states: meaning.states,
      roles: meaning.roles,
      refs: [...clause.refs],
      usedBy: [],
      affectedProofs: [...new Set(proofsByClause[clause.id] ?? [])].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
      regions: projectRegions(clause),
    });
  }

  // Pass 2: reverse edges. Only clauses present as nodes count — a ref to a
  // plumbing clause has nothing selectable to resolve to.
  for (const clause of contract.clauses) {
    if (clause.plumbing || !nodes.has(clause.id)) continue;
    for (const ref of clause.refs) {
      const target = nodes.get(ref);
      if (target && !target.usedBy.includes(clause.id)) target.usedBy.push(clause.id);
    }
  }

  return {
    schemaVersion: SEMANTIC_SURFACE_SCHEMA_VERSION,
    appName: contract.appName,
    contractHash: contract.contractHash,
    nodes: [...nodes.values()],
  };
}

/**
 * Resolve selection ids (as stamped by the compiler) to nodes.
 *
 * Order follows the request; an id the surface does not know resolves to
 * `null` rather than being silently dropped — a stale build's selection must
 * read as "unknown here", never as somebody else's node.
 */
export function resolveSemanticSelection(
  surface: SemanticSurface,
  ids: readonly string[],
): (ProvenanceNode | null)[] {
  const byId = new Map(surface.nodes.map((node) => [node.id, node]));
  return ids.map((id) => byId.get(id) ?? null);
}
