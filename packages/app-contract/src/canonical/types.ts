/**
 * Canonical App Contract types.
 *
 * The canonical semantic document is the ISL source. Everything here is a
 * deterministic *projection* of that source plus one additive sidecar
 * (`ContractMeta`) that records what ISL cannot express: where a clause came
 * from, how confident we are, whether the user confirmed it, and whether it is
 * locked against silent modification.
 *
 * There is exactly one source of truth. Drop the sidecar and the app still
 * compiles identically — provenance is metadata, never semantics.
 */

import type { Domain, SourceLocation } from '@isl-lang/parser';

/** Bumped only when the clause-id scheme or meta shape changes incompatibly. */
export const APP_CONTRACT_SCHEMA_VERSION = 'app-contract/1' as const;
export type AppContractSchemaVersion = typeof APP_CONTRACT_SCHEMA_VERSION;

/** Stable, name-derived identity for one unit of meaning in the contract. */
export type ClauseId = string;

import type { ClauseSemantic } from './semantic.js';

/**
 * Blueprint sections, in reading order. These are the headings a nontechnical
 * reader sees; every clause belongs to exactly one.
 */
export const BLUEPRINT_SECTIONS = [
  'overview',
  'people',
  'data',
  'workflows',
  'rules',
  'permissions',
  'screens',
  'integrations',
  'automation',
  'assumptions',
  'proof',
] as const;
export type BlueprintSection = (typeof BLUEPRINT_SECTIONS)[number];

/**
 * Clause kinds. One kind per addressable piece of meaning. Kept flat and
 * closed so patch validation, diff, and impact analysis can switch on it
 * exhaustively.
 */
export const CLAUSE_KINDS = [
  'app',
  'role',
  'entity',
  'field',
  'relationship',
  'status-set',
  'transition',
  'audit',
  'permission',
  'behavior',
  'precondition',
  'postcondition',
  'behavior-security',
  'invariant',
  'policy',
  'view',
  'aggregate',
  'compliance',
  'temporal',
  'integration',
  'auth-provider',
  'screen',
  'query',
  'job',
  'notification',
] as const;
export type ClauseKind = (typeof CLAUSE_KINDS)[number];

/** Where a clause came from. Never inferred silently — always displayed. */
export type ClauseSource = 'user' | 'inferred' | 'template' | 'imported' | 'system';

/**
 * Composition layer that declared this clause. Sidecar only — never hashed.
 * Matches `@wholestack/engines` EngineLayer without taking a package dependency.
 */
export const CLAUSE_LAYERS = ['engine', 'vertical', 'niche', 'application'] as const;
export type ClauseLayer = (typeof CLAUSE_LAYERS)[number];

/** Additive provenance sidecar for one clause. */
export interface ClauseMeta {
  source: ClauseSource;
  /** 0..1. Only meaningful for `inferred`; deterministic sources are 1. */
  confidence: number;
  /** The user explicitly accepted this clause (or wrote it). */
  confirmed: boolean;
  /** Locked clauses cannot be modified or removed without an explicit diff. */
  locked: boolean;
  /** The user's own words that produced this clause, when known. */
  originalText?: string;
  /** Why an inferred clause exists — shown verbatim in the Assumptions section. */
  rationale?: string;
  createdRevision: number;
  modifiedRevision: number;
  /** Engine / vertical / niche module that owns this clause, when composed. */
  moduleId?: string;
  moduleVersion?: string;
  moduleSourceHash?: string;
  layer?: ClauseLayer;
}

export interface ContractMeta {
  schemaVersion: AppContractSchemaVersion;
  /** Monotonic; every accepted patch increments it. */
  revision: number;
  clauses: Record<ClauseId, ClauseMeta>;
}

/** One addressable unit of meaning, rendered as an English sentence. */
export interface Clause {
  id: ClauseId;
  kind: ClauseKind;
  section: BlueprintSection;
  /** Plain-English sentence. Never contains braces or compiler jargon. */
  title: string;
  /** Optional second line of plain-English detail. */
  detail?: string;
  /** Other clause ids this one depends on (entity for a field, etc.). */
  refs: ClauseId[];
  /**
   * Verbatim ISL fragment this clause projects from, for the Code lens.
   *
   * DISPLAY ONLY. This was the entire semantic identity of a clause until the
   * typed payload landed, and for seven of the nineteen kinds it held only the
   * construct's NAME — so inverting an access policy or negating a spend guard
   * left `contractHash` byte-identical. Read {@link Clause.semantic} for meaning.
   */
  islExcerpt: string;
  /**
   * What this clause MEANS, as data. The unit of hashing and diffing.
   *
   * Optional only while the projector migrates kind by kind: a clause without
   * one still falls back to `islExcerpt` in the normal form, so the fallback is
   * a migration state and not a design. It becomes required once every kind is
   * projected, and the fallback is deleted with it.
   */
  semantic?: ClauseSemantic;
  /** Source span in the ISL document (1-based lines), when the parser gave one. */
  location?: SourceLocation;
  /**
   * Machine plumbing the compiler needs but a business reader never asked for
   * (surrogate keys, created-at stamps). Hidden from the Blueprint by default,
   * always visible in the Code lens.
   */
  plumbing?: boolean;
}

/**
 * A parsed, projected contract. `islSource` is authoritative; `clauses` and
 * `domain` are derived and must never be edited independently.
 */
export interface AppContract {
  schemaVersion: AppContractSchemaVersion;
  /** Canonical ISL source — the source of truth. */
  islSource: string;
  /** Parsed AST. Present only when the source parsed without error-severity diagnostics. */
  domain: Domain;
  /** Deterministic projection of `domain`. */
  clauses: Clause[];
  /** Provenance sidecar, keyed by clause id. */
  meta: ContractMeta;
  /** Content hash of the normalized semantic form (formatting-insensitive). */
  contractHash: string;
  appName: string;
}

export function defaultClauseMeta(
  source: ClauseSource,
  revision: number,
  overrides: Partial<ClauseMeta> = {},
): ClauseMeta {
  return {
    source,
    confidence: source === 'inferred' ? 0.6 : 1,
    confirmed: source === 'user',
    locked: false,
    createdRevision: revision,
    modifiedRevision: revision,
    ...overrides,
  };
}

export function emptyContractMeta(): ContractMeta {
  return { schemaVersion: APP_CONTRACT_SCHEMA_VERSION, revision: 0, clauses: {} };
}
