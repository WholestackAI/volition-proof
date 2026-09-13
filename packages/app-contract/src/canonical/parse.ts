/**
 * The one entry point that turns ISL text into a canonical `AppContract`.
 *
 * Parsing is deterministic and fail-closed: error-severity diagnostics mean no
 * contract, never a half-built one. The provenance sidecar is reconciled here
 * — clauses that appeared without a recorded origin default to `system`, and
 * meta for clauses that no longer exist is dropped so locks cannot haunt a
 * removed rule.
 */

import { parse as parseIsl, type Diagnostic, type Domain } from '@isl-lang/parser';
import { clausesFromDomain } from './from-isl.js';
import { hashNormalForm, semanticNormalForm } from './normalize.js';
import {
  APP_CONTRACT_SCHEMA_VERSION,
  defaultClauseMeta,
  emptyContractMeta,
  type AppContract,
  type Clause,
  type ClauseLayer,
  type ClauseMeta,
  type ContractMeta,
} from './types.js';

/**
 * Engine-composition stamp. Shape matches engines `ClauseProvenance` without
 * importing that package — app-contract must not depend on engines.
 */
export interface ClauseProvenanceStamp {
  clauseId: string;
  moduleId?: string | null;
  version?: string | null;
  sourceHash?: string | null;
  layer: ClauseLayer;
}

export interface ParseContractOptions {
  /** Existing provenance to carry forward. Missing entries default to `system`. */
  meta?: ContractMeta;
  /** Origin assigned to clauses that have no recorded meta yet. */
  defaultSource?: ClauseMeta['source'];
  filename?: string;
  /**
   * Composition overlay. Stamps matching clause ids (and their children) with
   * module provenance. Sidecar only — does not change `contractHash`.
   */
  clauseProvenance?: readonly ClauseProvenanceStamp[];
}

export type ParseContractResult =
  | { ok: true; contract: AppContract; diagnostics: Diagnostic[] }
  | { ok: false; contract: null; diagnostics: Diagnostic[] };

function isError(d: Diagnostic): boolean {
  return d.severity === 'error';
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function parentStamp(
  clause: Clause,
  byId: Map<string, ClauseProvenanceStamp>,
): ClauseProvenanceStamp | undefined {
  const direct = byId.get(clause.id);
  if (direct) return direct;
  for (const ref of clause.refs) {
    const parent = byId.get(ref);
    if (parent && nonEmpty(parent.moduleId)) return parent;
  }
  const entityChild = /^(field|status-set|relationship|transition|audit|permission|invariant):([^.:]+)/.exec(
    clause.id,
  );
  if (entityChild) {
    const parent = byId.get(`entity:${entityChild[2]}`);
    if (parent && nonEmpty(parent.moduleId)) return parent;
  }
  const behaviorChild = /^(precondition|postcondition|behavior-security):([^:]+)/.exec(clause.id);
  if (behaviorChild) {
    const parent = byId.get(`behavior:${behaviorChild[2]}`);
    if (parent && nonEmpty(parent.moduleId)) return parent;
  }
  return undefined;
}

function applyStamp(base: ClauseMeta, stamp: ClauseProvenanceStamp): ClauseMeta {
  const moduleId = nonEmpty(stamp.moduleId);
  const moduleVersion = nonEmpty(stamp.version);
  const moduleSourceHash = nonEmpty(stamp.sourceHash);
  if (moduleId) {
    return {
      ...base,
      source: 'imported',
      confidence: 1,
      confirmed: true,
      locked: true,
      layer: stamp.layer,
      moduleId,
      ...(moduleVersion ? { moduleVersion } : {}),
      ...(moduleSourceHash ? { moduleSourceHash } : {}),
    };
  }
  return {
    ...base,
    layer: stamp.layer,
  };
}

/** Parse ISL into a canonical contract. Fail-closed on any error diagnostic. */
export function parseAppContract(
  islSource: string,
  options: ParseContractOptions = {},
): ParseContractResult {
  const result = parseIsl(islSource, options.filename ?? 'app.isl');
  const diagnostics = result.errors ?? [];
  if (!result.success || !result.domain || diagnostics.some(isError)) {
    return { ok: false, contract: null, diagnostics };
  }
  return {
    ok: true,
    contract: contractFromDomain(islSource, result.domain, options),
    diagnostics,
  };
}

/** Build a contract from an already-parsed domain (skips a redundant parse). */
export function contractFromDomain(
  islSource: string,
  domain: Domain,
  options: ParseContractOptions = {},
): AppContract {
  const clauses = clausesFromDomain(domain);
  const appName = domain.name?.name ?? 'App';
  const previous = options.meta ?? emptyContractMeta();
  const revision = previous.revision;
  const stamps = new Map<string, ClauseProvenanceStamp>();
  for (const stamp of options.clauseProvenance ?? []) {
    if (!stamps.has(stamp.clauseId)) stamps.set(stamp.clauseId, stamp);
  }

  const clauseMeta: Record<string, ClauseMeta> = {};
  for (const clause of clauses) {
    const base =
      previous.clauses[clause.id] ?? defaultClauseMeta(options.defaultSource ?? 'system', revision);
    const stamp = stamps.size > 0 ? parentStamp(clause, stamps) : undefined;
    clauseMeta[clause.id] = stamp ? applyStamp(base, stamp) : base;
  }

  const meta: ContractMeta = {
    schemaVersion: APP_CONTRACT_SCHEMA_VERSION,
    revision,
    clauses: clauseMeta,
  };

  return {
    schemaVersion: APP_CONTRACT_SCHEMA_VERSION,
    islSource,
    domain,
    clauses,
    meta,
    contractHash: hashNormalForm(semanticNormalForm(appName, clauses, APP_CONTRACT_SCHEMA_VERSION)),
    appName,
  };
}

/** True when two contracts mean the same thing, ignoring formatting and order. */
export function semanticallyEqual(a: AppContract, b: AppContract): boolean {
  return a.contractHash === b.contractHash;
}
