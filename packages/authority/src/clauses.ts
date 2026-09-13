export const PROOF_LEVELS = [
  'declared',
  'compiled',
  'static',
  'runtime',
  'mutation',
  'deployed',
] as const;

export type ProofLevel = (typeof PROOF_LEVELS)[number];

export type ClauseCategory =
  | 'authority'
  | 'permission'
  | 'delegation'
  | 'eligibility'
  | 'persistence'
  | 'orchestration'
  | 'immutability'
  | 'evidence'
  | 'chat_validation'
  | 'retention'
  | 'provider_failure';

export type ClauseCriticality = 'release_blocking' | 'advisory';

/**
 * Stable business clause ids are human-assigned identifiers, not hashes or
 * source locations. Moving an invariant must not change the identifier carried
 * by generated code, denials, audit records, evidence, or ShipGate findings.
 */
export type StableClauseId = string;

const STABLE_CLAUSE_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+){2,}$/;

export function isStableClauseId(value: string): boolean {
  return STABLE_CLAUSE_ID.test(value);
}

export function assertStableClauseId(value: string): asserts value is StableClauseId {
  if (!isStableClauseId(value)) {
    throw new TypeError(
      `Invalid stable clause id "${value}"; expected a permanent id such as AIV-AUTH-001`,
    );
  }
}

export interface ClauseDefinition {
  id: StableClauseId;
  title: string;
  description: string;
  category: ClauseCategory;
  criticality: ClauseCriticality;
  /** Authoritative ISL artifact containing the invariant declaration. */
  sourceArtifact: string;
  /** Exact invariant id expected in the ISL source. */
  sourceDeclarationId: string;
  requiredProofs: readonly ProofLevel[];
}

export interface ClauseLinkedCommandDefinition<Input = unknown> {
  commandId: string;
  input?: Input;
  clauseIds: readonly StableClauseId[];
}

export interface ClauseLinkedAuditRecord<Payload = unknown> {
  auditId: string;
  eventType: string;
  tenantId: string;
  actorId: string;
  subjectId: string;
  actingIdentityId: string;
  clauseIds: readonly StableClauseId[];
  occurredAt: string;
  payload?: Payload;
}

export interface ClauseLinkedEvidenceReceipt<Payload = unknown> {
  receiptId: string;
  eventType: string;
  tenantId: string;
  actorId: string;
  subjectId: string;
  actingIdentityId: string;
  clauseIds: readonly StableClauseId[];
  recordedAt: string;
  payload?: Payload;
}

export interface AuthorityDenial {
  decision: 'deny';
  code: string;
  message: string;
  clauseIds: readonly StableClauseId[];
}

export function defineClauseLinkedCommand<Input>(
  definition: ClauseLinkedCommandDefinition<Input>,
): ClauseLinkedCommandDefinition<Input> {
  assertClauseIds(definition.clauseIds, `command ${definition.commandId}`);
  return {
    ...definition,
    clauseIds: [...new Set(definition.clauseIds)].sort(),
  };
}

export function assertClauseIds(
  clauseIds: readonly StableClauseId[],
  owner = 'clause-linked record',
): void {
  if (clauseIds.length === 0) {
    throw new TypeError(`${owner} must reference at least one stable clause id`);
  }
  for (const clauseId of clauseIds) assertStableClauseId(clauseId);
}
