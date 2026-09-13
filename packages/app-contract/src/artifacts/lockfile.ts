/**
 * Portable intent artifacts.
 *
 * A generated app that cannot say what was asked for, what was assumed, and
 * which code satisfies which rule is just code. These three files travel with
 * the app so any later reader — a new developer, an auditor, a buyer, CI — can
 * answer those questions without the conversation that produced them.
 *
 *   app.isl                  the contract, authoritative and human-editable
 *   intent.lock.json         normalized semantics + provenance + hash
 *   implementation-map.json  clause → the files that implement it
 *
 * Proof evidence is NOT duplicated here. ShipGate already owns the proof
 * format; `proofObligations` names the clauses that need evidence and leaves
 * the verdict to ShipGate.
 */

import { semanticNormalForm, stableStringify } from '../canonical/normalize.js'
import { sha256Hex } from '../canonical/hash.js'
import type { AppContract, ClauseId, ClauseLayer, ClauseMeta } from '../canonical/types.js'
import type { ClauseSemantic } from '../canonical/semantic.js'

export const INTENT_LOCK_VERSION = 'intent-lock/1' as const

export interface IntentLockClause {
  id: ClauseId
  kind: string
  section: string
  /** The plain-English sentence, so the lockfile is readable without tooling. */
  statement: string
  isl: string
  /**
   * The clause's typed payload, when the projector has one for its kind.
   *
   * Without this, `verifyLockHash` could only ever reconstruct the LEGACY
   * `islExcerpt`-hashing form — which is exactly the blindness the typed
   * payload replaced — and would report every migrated kind's lock as broken.
   * A lockfile that cannot self-verify is not portable; see the module header.
   */
  semantic?: ClauseSemantic
  source: ClauseMeta['source']
  confidence: number
  confirmed: boolean
  locked: boolean
  originalText?: string
  rationale?: string
  createdRevision: number
  modifiedRevision: number
  moduleId?: string
  moduleVersion?: string
  moduleSourceHash?: string
  layer?: ClauseLayer
}

export interface IntentLock {
  lockVersion: typeof INTENT_LOCK_VERSION
  contractSchemaVersion: string
  app: string
  revision: number
  contractHash: string
  /** Digest of the ISL text, to detect an edit that never went through a patch. */
  sourceHash: string
  clauses: IntentLockClause[]
  assumptions: { clauseId: ClauseId; statement: string; rationale?: string; confidence: number }[]
  lockedClauses: ClauseId[]
  proofObligations: ClauseId[]
}

/** Clause kinds that must carry proof evidence before an app can ship. */
export const PROVABLE_CLAUSE_KINDS = [
  'permission',
  'policy',
  'behavior-security',
  'precondition',
  'postcondition',
  'invariant',
  'transition',
  'audit',
  'compliance',
  'temporal',
  'integration',
] as const;

export type ProvableClauseKind = (typeof PROVABLE_CLAUSE_KINDS)[number];

export const PROVABLE_KINDS = new Set<string>(PROVABLE_CLAUSE_KINDS);

export function buildIntentLock(contract: AppContract): IntentLock {
  const clauses: IntentLockClause[] = contract.clauses.map((clause) => {
    const meta = contract.meta.clauses[clause.id]
    return {
      id: clause.id,
      kind: clause.kind,
      section: clause.section,
      statement: clause.title,
      isl: clause.islExcerpt,
      ...(clause.semantic ? { semantic: clause.semantic } : {}),
      source: meta?.source ?? 'system',
      confidence: meta?.confidence ?? 1,
      confirmed: meta?.confirmed ?? false,
      locked: meta?.locked ?? false,
      ...(meta?.originalText ? { originalText: meta.originalText } : {}),
      ...(meta?.rationale ? { rationale: meta.rationale } : {}),
      createdRevision: meta?.createdRevision ?? 0,
      modifiedRevision: meta?.modifiedRevision ?? 0,
      ...(meta?.moduleId ? { moduleId: meta.moduleId } : {}),
      ...(meta?.moduleVersion ? { moduleVersion: meta.moduleVersion } : {}),
      ...(meta?.moduleSourceHash ? { moduleSourceHash: meta.moduleSourceHash } : {}),
      ...(meta?.layer ? { layer: meta.layer } : {}),
    }
  })

  return {
    lockVersion: INTENT_LOCK_VERSION,
    contractSchemaVersion: contract.schemaVersion,
    app: contract.appName,
    revision: contract.meta.revision,
    contractHash: contract.contractHash,
    sourceHash: `sha256:${sha256Hex(contract.islSource)}`,
    clauses,
    assumptions: clauses
      .filter((c) => c.source === 'inferred' && !c.confirmed)
      .map((c) => ({
        clauseId: c.id,
        statement: c.statement,
        ...(c.rationale ? { rationale: c.rationale } : {}),
        confidence: c.confidence,
      })),
    lockedClauses: clauses.filter((c) => c.locked).map((c) => c.id),
    proofObligations: clauses.filter((c) => PROVABLE_KINDS.has(c.kind)).map((c) => c.id),
  }
}

export const IMPLEMENTATION_MAP_VERSION = 'implementation-map/1' as const

export interface ImplementationEntry {
  clauseId: ClauseId
  /** Repo-relative paths generated because this clause exists. */
  files: string[]
  /** Database objects: tables, columns, enums, policies. */
  schema: string[]
  /** HTTP routes whose behavior this clause governs. */
  routes: string[]
  /** Screens that render or enforce it. */
  screens: string[]
  /** Test files that exercise it. */
  tests: string[]
}

export interface ImplementationMap {
  mapVersion: typeof IMPLEMENTATION_MAP_VERSION
  app: string
  contractHash: string
  entries: ImplementationEntry[]
  /** Clauses with no implementation recorded. Non-empty is a real gap. */
  unmapped: ClauseId[]
}

export interface ImplementationEvidence {
  clauseId: ClauseId
  files?: string[]
  schema?: string[]
  routes?: string[]
  screens?: string[]
  tests?: string[]
}

/**
 * Assemble the clause → implementation map from evidence the codegen reported.
 * Evidence is supplied by the generator, never guessed here: an unmapped clause
 * must show up as unmapped rather than be quietly credited to a nearby file.
 */
export function buildImplementationMap(
  contract: AppContract,
  evidence: ImplementationEvidence[],
): ImplementationMap {
  const byClause = new Map<ClauseId, ImplementationEvidence[]>()
  for (const item of evidence) {
    const list = byClause.get(item.clauseId) ?? []
    list.push(item)
    byClause.set(item.clauseId, list)
  }

  const entries: ImplementationEntry[] = []
  const unmapped: ClauseId[] = []

  for (const clause of contract.clauses) {
    if (clause.plumbing) continue
    const items = byClause.get(clause.id)
    if (!items?.length) {
      unmapped.push(clause.id)
      continue
    }
    entries.push({
      clauseId: clause.id,
      files: unique(items.flatMap((i) => i.files ?? [])),
      schema: unique(items.flatMap((i) => i.schema ?? [])),
      routes: unique(items.flatMap((i) => i.routes ?? [])),
      screens: unique(items.flatMap((i) => i.screens ?? [])),
      tests: unique(items.flatMap((i) => i.tests ?? [])),
    })
  }

  return {
    mapVersion: IMPLEMENTATION_MAP_VERSION,
    app: contract.appName,
    contractHash: contract.contractHash,
    entries,
    unmapped,
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

/** Canonical JSON for an artifact — stable key order so diffs stay readable. */
export function serializeIntentLock(lock: IntentLock): string {
  return `${JSON.stringify(lock, null, 2)}\n`
}

export function serializeImplementationMap(map: ImplementationMap): string {
  return `${JSON.stringify(map, null, 2)}\n`
}

export type DriftKind = 'none' | 'source-edited' | 'semantics-changed' | 'schema-mismatch'

export interface DriftReport {
  kind: DriftKind
  message: string
  /** Clauses present in the lock but gone from the contract. */
  removed: ClauseId[]
  /** Clauses in the contract that the lock never recorded. */
  added: ClauseId[]
  /** Locked clauses whose text no longer matches the lock. */
  brokenLocks: ClauseId[]
}

/**
 * Compare a contract against its lockfile. This is what CI runs to catch a spec
 * that was edited outside the governed path, and what a buyer runs to check
 * that the code they received still matches the contract they were sold.
 */
export function detectDrift(contract: AppContract, lock: IntentLock): DriftReport {
  if (lock.contractSchemaVersion !== contract.schemaVersion) {
    return {
      kind: 'schema-mismatch',
      message: `This lockfile was written for ${lock.contractSchemaVersion} but the contract is ${contract.schemaVersion}. Regenerate it.`,
      removed: [],
      added: [],
      brokenLocks: [],
    }
  }

  const lockClauses = new Map(lock.clauses.map((c) => [c.id, c]))
  const current = new Map(contract.clauses.map((c) => [c.id, c]))
  const removed = [...lockClauses.keys()].filter((id) => !current.has(id))
  const added = [...current.keys()].filter((id) => !lockClauses.has(id))
  const brokenLocks = lock.lockedClauses.filter((id) => {
    const before = lockClauses.get(id)
    const after = current.get(id)
    if (!before) return false
    if (!after) return true
    return collapse(before.isl) !== collapse(after.islExcerpt)
  })

  if (contract.contractHash !== lock.contractHash) {
    return {
      kind: 'semantics-changed',
      message: 'The contract no longer means what the lockfile recorded.',
      removed,
      added,
      brokenLocks,
    }
  }
  if (`sha256:${sha256Hex(contract.islSource)}` !== lock.sourceHash) {
    return {
      kind: 'source-edited',
      message: 'The spec text changed but its meaning did not — safe to re-lock.',
      removed,
      added,
      brokenLocks,
    }
  }
  return { kind: 'none', message: 'The contract matches its lockfile.', removed, added, brokenLocks }
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Recompute the lock hash independently, for callers that want to verify it. */
export function verifyLockHash(lock: IntentLock): boolean {
  const form = semanticNormalForm(
    lock.app,
    lock.clauses.map((c) => ({
      id: c.id,
      kind: c.kind as never,
      section: c.section as never,
      title: c.statement,
      refs: [],
      islExcerpt: c.isl,
      ...(c.semantic ? { semantic: c.semantic } : {}),
    })),
    lock.contractSchemaVersion,
  )
  return lock.contractHash === `sha256:${sha256Hex(stableStringify(form))}`
}
