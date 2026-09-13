import {
  assertClauseIds,
  type ClauseLinkedAuditRecord,
  type ClauseLinkedEvidenceReceipt,
  type AuthorityDenial,
  type StableClauseId,
} from './clauses.js';

export * from './clauses.js';
export * from './proof-obligations.js';
export * from './semantic-proof-coverage.js';
export {
  commandRequiresApproval,
  decideCommand,
  type AuthorityDecision,
  type AuthorityDecisionCode,
  type AuthorityDecisionStatus,
  type AuthorityLookup,
  type DecideCommandActor,
  type DecideCommandEvidence,
  type DecideCommandInput,
  type DecideCommandSession,
} from './decide-command.js';
export {
  capabilityLeaseHash,
  issueCapabilityLease,
  verifyCapabilityLease,
  type CapabilityLease,
  type CapabilityLeaseGraph,
  type CapabilityLeaseSession,
  type IssueCapabilityLeaseInput,
  type VerifyCapabilityLeaseResult,
} from './capability-lease.js';
export {
  buildCommandReceipt,
  hashCommandCanonical,
  mandateHashFromContract,
  type BuildCommandReceiptInput,
  type CommandReceipt,
  type CommandReceiptDecision,
} from './command-receipt.js';
export { CommandEvidenceLedger } from './command-ledger.js';
export * from './effect-authority.js';
export * from './swarm-authority.js';
export * from './external-evaluator.js';

export const AUTHORITY_PACKAGE = '@wholestack/authority' as const;

/** Roles are domain values; the authority compiler does not own a role enum. */
export type AuthorityRole = string;

export interface AuthorityEntitlements {
  /** Capability ids this principal may invoke (subset of parent when hierarchical). */
  allowedAgents: readonly string[];
  permissions: readonly string[];
}

export interface AuthorityPrincipal {
  id: string;
  identityId: string;
  tenantId: string;
  /** Role of the authenticated actor. */
  role: AuthorityRole;
  parentId?: string;
  /** Stable ISL clause governing this particular hierarchy edge. */
  subsetClauseId?: StableClauseId;
  entitlements: AuthorityEntitlements;
}

export interface AuthoritySession {
  sessionId: string;
  principalId: string;
  tenantId: string;
  authorizedCapabilities: readonly string[];
  authorizedCommands: readonly string[];
  startedAt: string;
  expiresAt: string;
  revokedAt?: string;
  revocationReason?: string;
  delegationId?: string;
}

export interface DelegationRecord {
  delegationId: string;
  sessionId: string;
  actorId: string;
  subjectId: string;
  tenantId: string;
  allowedCommands: readonly string[];
  allowedResources: readonly string[];
  allowedCapabilities: readonly string[];
  startedAt: string;
  expiresAt: string;
  revokedAt?: string;
  revocationReason?: string;
  consentReference: string;
  evidenceReceiptId: string;
}

export interface AuthorityContext {
  actorId: string;
  actorIdentityId: string;
  subjectId: string;
  subjectIdentityId: string;
  /** Identity actively operating the command; never inferred from the subject. */
  actingIdentityId: string;
  tenantId: string;
  /** Role of the authenticated actor. */
  role: AuthorityRole;
  /** Role of the governed subject, authorized separately by Control Programs. */
  subjectRole: AuthorityRole;
  /** Effective subject permissions; delegated command scope remains in `delegation`. */
  permissions: readonly string[];
  /** `allowedAgents` is the canonical effective capability set for this subject. */
  entitlements: AuthorityEntitlements;
  session?: AuthoritySession;
  delegation?: DelegationRecord;
  /** Backward-compatible attribution alias. */
  delegatedFrom?: string;
}

export interface AuthorityPolicyClauses {
  tenantIsolation: StableClauseId;
  childSubset: StableClauseId;
  reductionCascade: StableClauseId;
  additionDoesNotCascade: StableClauseId;
  affectedSessionRevocation: StableClauseId;
  assistedSessionRequired: StableClauseId;
  delegationDuration: StableClauseId;
  noDelegationRefresh: StableClauseId;
  dualAttribution: StableClauseId;
  sameTenantReassignment: StableClauseId;
  historicalAttribution: StableClauseId;
}

export const DEFAULT_AUTHORITY_POLICY_CLAUSES: AuthorityPolicyClauses = {
  tenantIsolation: 'WS-AUTH-001',
  childSubset: 'WS-PERM-001',
  reductionCascade: 'WS-PERM-002',
  additionDoesNotCascade: 'WS-PERM-003',
  affectedSessionRevocation: 'WS-PERM-004',
  assistedSessionRequired: 'WS-DELEG-001',
  delegationDuration: 'WS-DELEG-002',
  noDelegationRefresh: 'WS-DELEG-003',
  dualAttribution: 'WS-DELEG-004',
  sameTenantReassignment: 'WS-AUTH-002',
  historicalAttribution: 'WS-AUTH-003',
};

export class AuthorityError extends Error {
  readonly code: string;
  readonly clauseIds: readonly StableClauseId[];

  constructor(code: string, message: string, clauseIds: readonly StableClauseId[]) {
    super(message);
    this.name = 'AuthorityError';
    this.code = code;
    this.clauseIds = [...new Set(clauseIds)].sort();
    assertClauseIds(this.clauseIds, `authority denial ${code}`);
  }
}

export function authorityDenialFromError(error: AuthorityError): AuthorityDenial {
  return {
    decision: 'deny',
    code: error.code,
    message: error.message,
    clauseIds: [...error.clauseIds],
  };
}

export interface EntitlementChangeImpact {
  dryRun: true;
  tenantId: string;
  targetId: string;
  removedCapabilities: string[];
  addedCapabilities: string[];
  removedPermissions: string[];
  addedPermissions: string[];
  principalUpdates: Array<{
    principalId: string;
    before: AuthorityEntitlements;
    after: AuthorityEntitlements;
    clauseIds: StableClauseId[];
  }>;
  affectedSessionIds: string[];
  affectedDelegationIds: string[];
  clauseIds: StableClauseId[];
}

export interface AttributionSnapshot {
  attributionId: string;
  tenantId: string;
  actorId: string;
  subjectId: string;
  actingIdentityId: string;
  subjectParentId?: string;
  occurredAt: string;
  clauseIds: readonly StableClauseId[];
}

export interface ReassignmentRecord {
  reassignmentId: string;
  tenantId: string;
  principalId: string;
  previousParentId?: string;
  newParentId: string;
  occurredAt: string;
  clauseIds: readonly StableClauseId[];
}

function sortUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizedEntitlements(value: AuthorityEntitlements): AuthorityEntitlements {
  return {
    allowedAgents: sortUnique(value.allowedAgents),
    permissions: sortUnique(value.permissions),
  };
}

function clonePrincipal(principal: AuthorityPrincipal): AuthorityPrincipal {
  return { ...principal, entitlements: normalizedEntitlements(principal.entitlements) };
}

function cloneSession(session: AuthoritySession): AuthoritySession {
  return {
    ...session,
    authorizedCapabilities: [...session.authorizedCapabilities],
    authorizedCommands: [...session.authorizedCommands],
  };
}

function cloneDelegation(delegation: DelegationRecord): DelegationRecord {
  return {
    ...delegation,
    allowedCommands: [...delegation.allowedCommands],
    allowedResources: [...delegation.allowedResources],
    allowedCapabilities: [...delegation.allowedCapabilities],
  };
}

function isoMillis(value: string, label: string): number {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new TypeError(`${label} must be an ISO timestamp`);
  return millis;
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  const set = new Set(left);
  return right.some((value) => set.has(value));
}

function removed(before: readonly string[], after: readonly string[]): string[] {
  const next = new Set(after);
  return before.filter((value) => !next.has(value)).sort();
}

function added(before: readonly string[], after: readonly string[]): string[] {
  const prior = new Set(before);
  return after.filter((value) => !prior.has(value)).sort();
}

export class AuthorityGraph {
  private readonly principals = new Map<string, AuthorityPrincipal>();
  private readonly sessions = new Map<string, AuthoritySession>();
  private readonly delegations = new Map<string, DelegationRecord>();
  private readonly attributionRecords: AttributionSnapshot[] = [];
  private readonly reassignmentRecords: ReassignmentRecord[] = [];
  readonly clauses: AuthorityPolicyClauses;

  constructor(options: { clauses?: Partial<AuthorityPolicyClauses> } = {}) {
    this.clauses = { ...DEFAULT_AUTHORITY_POLICY_CLAUSES, ...options.clauses };
    assertClauseIds(Object.values(this.clauses), 'authority policy');
  }

  register(principal: AuthorityPrincipal): void {
    if (!principal.id || !principal.identityId || !principal.tenantId) {
      throw new TypeError('Authority principal requires id, identityId, and tenantId');
    }
    if (principal.parentId === principal.id)
      throw new TypeError('Authority principal cannot parent itself');
    if (this.principals.has(principal.id)) {
      throw new TypeError(`Authority principal ${principal.id} is already registered`);
    }
    this.principals.set(principal.id, clonePrincipal(principal));
  }

  get(id: string): AuthorityPrincipal | undefined {
    const principal = this.principals.get(id);
    return principal ? clonePrincipal(principal) : undefined;
  }

  getSession(id: string): AuthoritySession | undefined {
    const session = this.sessions.get(id);
    return session ? cloneSession(session) : undefined;
  }

  getDelegation(id: string): DelegationRecord | undefined {
    const delegation = this.delegations.get(id);
    return delegation ? cloneDelegation(delegation) : undefined;
  }

  attributions(): AttributionSnapshot[] {
    return this.attributionRecords.map((record) => ({
      ...record,
      clauseIds: [...record.clauseIds],
    }));
  }

  reassignments(): ReassignmentRecord[] {
    return this.reassignmentRecords.map((record) => ({
      ...record,
      clauseIds: [...record.clauseIds],
    }));
  }

  private requirePrincipal(id: string): AuthorityPrincipal {
    const principal = this.principals.get(id);
    if (!principal) {
      throw new AuthorityError('principal_not_found', `Unknown authority principal ${id}`, [
        this.clauses.tenantIsolation,
      ]);
    }
    return principal;
  }

  private assertTenant(principal: AuthorityPrincipal, tenantId: string): void {
    if (principal.tenantId !== tenantId) {
      throw new AuthorityError(
        'cross_tenant_access',
        `Principal ${principal.id} belongs to tenant ${principal.tenantId}, not ${tenantId}`,
        [this.clauses.tenantIsolation],
      );
    }
  }

  private childIds(parentId: string): string[] {
    return [...this.principals.values()]
      .filter((principal) => principal.parentId === parentId)
      .map((principal) => principal.id)
      .sort();
  }

  private descendantIds(parentId: string): string[] {
    const descendants: string[] = [];
    const pending = this.childIds(parentId);
    while (pending.length > 0) {
      const next = pending.shift();
      if (!next || descendants.includes(next)) continue;
      descendants.push(next);
      pending.push(...this.childIds(next));
    }
    return descendants.sort();
  }

  /** Child capabilities and permissions must remain subsets of the parent. */
  assertChildSubsetOfParent(childId: string): void {
    const child = this.requirePrincipal(childId);
    if (!child.parentId) return;
    const parent = this.requirePrincipal(child.parentId);
    const clauseId = child.subsetClauseId ?? this.clauses.childSubset;
    if (child.tenantId !== parent.tenantId) {
      throw new AuthorityError('cross_tenant_hierarchy', 'Hierarchy edges cannot cross tenants', [
        this.clauses.tenantIsolation,
        clauseId,
      ]);
    }
    const parentAgents = new Set(parent.entitlements.allowedAgents);
    const excessAgent = child.entitlements.allowedAgents.find((agent) => !parentAgents.has(agent));
    if (excessAgent) {
      throw new AuthorityError(
        'capability_exceeds_parent',
        `Child ${childId} capability ${excessAgent} exceeds parent ${parent.id}`,
        [clauseId],
      );
    }
    const parentPermissions = new Set(parent.entitlements.permissions);
    const excessPermission = child.entitlements.permissions.find(
      (permission) => !parentPermissions.has(permission),
    );
    if (excessPermission) {
      throw new AuthorityError(
        'permission_exceeds_parent',
        `Child ${childId} permission ${excessPermission} exceeds parent ${parent.id}`,
        [clauseId],
      );
    }
  }

  cascadeValidate(): void {
    for (const id of [...this.principals.keys()].sort()) this.assertChildSubsetOfParent(id);
  }

  registerSession(session: AuthoritySession): AuthoritySession {
    if (this.sessions.has(session.sessionId)) {
      throw new AuthorityError(
        'session_id_reuse_forbidden',
        `Session ${session.sessionId} already exists; issue a new session instead of refreshing it`,
        [this.clauses.noDelegationRefresh],
      );
    }
    const principal = this.requirePrincipal(session.principalId);
    this.assertTenant(principal, session.tenantId);
    if (
      isoMillis(session.expiresAt, 'session.expiresAt') <=
      isoMillis(session.startedAt, 'session.startedAt')
    ) {
      throw new TypeError('Session expiresAt must be after startedAt');
    }
    const principalCapabilities = new Set(principal.entitlements.allowedAgents);
    const principalPermissions = new Set(principal.entitlements.permissions);
    if (session.authorizedCapabilities.some((value) => !principalCapabilities.has(value))) {
      throw new AuthorityError(
        'session_capability_exceeds_principal',
        'Session exceeds principal capabilities',
        [principal.subsetClauseId ?? this.clauses.childSubset],
      );
    }
    if (session.authorizedCommands.some((value) => !principalPermissions.has(value))) {
      throw new AuthorityError(
        'session_command_exceeds_principal',
        'Session exceeds principal permissions',
        [principal.subsetClauseId ?? this.clauses.childSubset],
      );
    }
    const stored = cloneSession({
      ...session,
      authorizedCapabilities: sortUnique(session.authorizedCapabilities),
      authorizedCommands: sortUnique(session.authorizedCommands),
    });
    this.sessions.set(stored.sessionId, stored);
    return cloneSession(stored);
  }

  revokeSession(input: { sessionId: string; revokedAt: string; reason: string }): AuthoritySession {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      throw new AuthorityError('session_not_found', `Unknown session ${input.sessionId}`, [
        this.clauses.affectedSessionRevocation,
      ]);
    }
    if (session.revokedAt) return cloneSession(session);
    const stored = cloneSession({
      ...session,
      revokedAt: input.revokedAt,
      revocationReason: input.reason,
    });
    this.sessions.set(stored.sessionId, stored);
    return cloneSession(stored);
  }

  planEntitlementChange(input: {
    tenantId: string;
    targetId: string;
    next: AuthorityEntitlements;
  }): EntitlementChangeImpact {
    const target = this.requirePrincipal(input.targetId);
    this.assertTenant(target, input.tenantId);
    const next = normalizedEntitlements(input.next);

    if (target.parentId) {
      const parent = this.requirePrincipal(target.parentId);
      const parentCapabilities = new Set(parent.entitlements.allowedAgents);
      const parentPermissions = new Set(parent.entitlements.permissions);
      const invalidCapability = next.allowedAgents.find((value) => !parentCapabilities.has(value));
      const invalidPermission = next.permissions.find((value) => !parentPermissions.has(value));
      if (invalidCapability || invalidPermission) {
        throw new AuthorityError(
          'entitlement_exceeds_parent',
          `Entitlement ${invalidCapability ?? invalidPermission} exceeds parent ${parent.id}`,
          [target.subsetClauseId ?? this.clauses.childSubset],
        );
      }
    }

    const removedCapabilities = removed(target.entitlements.allowedAgents, next.allowedAgents);
    const addedCapabilities = added(target.entitlements.allowedAgents, next.allowedAgents);
    const removedPermissions = removed(target.entitlements.permissions, next.permissions);
    const addedPermissions = added(target.entitlements.permissions, next.permissions);
    const updates: EntitlementChangeImpact['principalUpdates'] = [
      {
        principalId: target.id,
        before: normalizedEntitlements(target.entitlements),
        after: next,
        clauseIds: [this.clauses.reductionCascade, this.clauses.additionDoesNotCascade],
      },
    ];

    for (const descendantId of this.descendantIds(target.id)) {
      const descendant = this.requirePrincipal(descendantId);
      const after = normalizedEntitlements({
        allowedAgents: descendant.entitlements.allowedAgents.filter(
          (value) => !removedCapabilities.includes(value),
        ),
        permissions: descendant.entitlements.permissions.filter(
          (value) => !removedPermissions.includes(value),
        ),
      });
      if (
        after.allowedAgents.length !== descendant.entitlements.allowedAgents.length ||
        after.permissions.length !== descendant.entitlements.permissions.length
      ) {
        updates.push({
          principalId: descendant.id,
          before: normalizedEntitlements(descendant.entitlements),
          after,
          clauseIds: [this.clauses.reductionCascade],
        });
      }
    }

    const affectedPrincipalIds = new Set(updates.map((update) => update.principalId));
    const affectedSessionIds = [...this.sessions.values()]
      .filter(
        (session) =>
          !session.revokedAt &&
          affectedPrincipalIds.has(session.principalId) &&
          (intersects(session.authorizedCapabilities, removedCapabilities) ||
            intersects(session.authorizedCommands, removedPermissions)),
      )
      .map((session) => session.sessionId)
      .sort();
    const affectedDelegationIds = [...this.delegations.values()]
      .filter(
        (delegation) =>
          !delegation.revokedAt &&
          (affectedPrincipalIds.has(delegation.actorId) ||
            affectedPrincipalIds.has(delegation.subjectId)) &&
          (intersects(delegation.allowedCapabilities, removedCapabilities) ||
            intersects(delegation.allowedCommands, removedPermissions)),
      )
      .map((delegation) => delegation.delegationId)
      .sort();

    return {
      dryRun: true,
      tenantId: input.tenantId,
      targetId: input.targetId,
      removedCapabilities,
      addedCapabilities,
      removedPermissions,
      addedPermissions,
      principalUpdates: updates,
      affectedSessionIds,
      affectedDelegationIds,
      clauseIds: sortUnique([
        this.clauses.reductionCascade,
        this.clauses.additionDoesNotCascade,
        ...(affectedSessionIds.length > 0 || affectedDelegationIds.length > 0
          ? [this.clauses.affectedSessionRevocation]
          : []),
      ]),
    };
  }

  applyEntitlementChange(input: {
    tenantId: string;
    targetId: string;
    next: AuthorityEntitlements;
    occurredAt: string;
    revocationReason: string;
  }): EntitlementChangeImpact {
    const impact = this.planEntitlementChange(input);
    for (const update of impact.principalUpdates) {
      const principal = this.requirePrincipal(update.principalId);
      this.principals.set(principal.id, { ...principal, entitlements: update.after });
    }
    for (const sessionId of impact.affectedSessionIds) {
      const session = this.sessions.get(sessionId);
      if (session) {
        this.sessions.set(sessionId, {
          ...session,
          revokedAt: input.occurredAt,
          revocationReason: input.revocationReason,
        });
      }
    }
    for (const delegationId of impact.affectedDelegationIds) {
      const delegation = this.delegations.get(delegationId);
      if (delegation) {
        this.delegations.set(delegationId, {
          ...delegation,
          revokedAt: input.occurredAt,
          revocationReason: input.revocationReason,
        });
      }
    }
    this.cascadeValidate();
    return impact;
  }

  startDelegation(input: {
    delegationId: string;
    sessionId: string;
    actorId: string;
    subjectId: string;
    tenantId: string;
    allowedCommands: readonly string[];
    allowedResources: readonly string[];
    allowedCapabilities: readonly string[];
    startedAt: string;
    durationMinutes: number;
    consentReference: string;
    evidenceReceiptId: string;
  }): DelegationRecord {
    if (this.delegations.has(input.delegationId) || this.sessions.has(input.sessionId)) {
      throw new AuthorityError(
        'delegation_id_reuse_forbidden',
        'Delegation and session identifiers are single-use; issue new consented authority',
        [this.clauses.noDelegationRefresh],
      );
    }
    const actor = this.requirePrincipal(input.actorId);
    const subject = this.requirePrincipal(input.subjectId);
    this.assertTenant(actor, input.tenantId);
    this.assertTenant(subject, input.tenantId);
    if (input.durationMinutes <= 0 || input.durationMinutes > 60) {
      throw new AuthorityError(
        'delegation_duration_exceeded',
        'Delegated authority must be greater than zero and at most 60 minutes',
        [this.clauses.delegationDuration],
      );
    }
    if (!actor.entitlements.permissions.includes('impersonate_start')) {
      throw new AuthorityError(
        'assisted_session_not_authorized',
        `Actor ${actor.id} lacks impersonate_start`,
        [this.clauses.assistedSessionRequired],
      );
    }
    const actorCapabilities = new Set(actor.entitlements.allowedAgents);
    const subjectCapabilities = new Set(subject.entitlements.allowedAgents);
    const invalidCapability = input.allowedCapabilities.find(
      (capability) => !actorCapabilities.has(capability) || !subjectCapabilities.has(capability),
    );
    if (invalidCapability) {
      throw new AuthorityError(
        'delegation_capability_not_shared',
        `Capability ${invalidCapability} is not held by both actor and subject`,
        [subject.subsetClauseId ?? this.clauses.childSubset],
      );
    }
    const actorCommands = new Set(actor.entitlements.permissions);
    const invalidCommand = input.allowedCommands.find((command) => !actorCommands.has(command));
    if (invalidCommand) {
      throw new AuthorityError(
        'delegation_command_not_held',
        `Command ${invalidCommand} is not held by actor ${actor.id}`,
        [this.clauses.assistedSessionRequired],
      );
    }
    if (!input.consentReference || !input.evidenceReceiptId) {
      throw new AuthorityError(
        'delegation_consent_or_evidence_missing',
        'Delegation requires consent and evidence references',
        [this.clauses.assistedSessionRequired, this.clauses.dualAttribution],
      );
    }
    const startedAt = isoMillis(input.startedAt, 'delegation.startedAt');
    const delegation: DelegationRecord = {
      delegationId: input.delegationId,
      sessionId: input.sessionId,
      actorId: actor.id,
      subjectId: subject.id,
      tenantId: input.tenantId,
      allowedCommands: sortUnique(input.allowedCommands),
      allowedResources: sortUnique(input.allowedResources),
      allowedCapabilities: sortUnique(input.allowedCapabilities),
      startedAt: input.startedAt,
      expiresAt: new Date(startedAt + input.durationMinutes * 60_000).toISOString(),
      consentReference: input.consentReference,
      evidenceReceiptId: input.evidenceReceiptId,
    };
    this.delegations.set(delegation.delegationId, delegation);
    this.registerSession({
      sessionId: input.sessionId,
      principalId: actor.id,
      tenantId: input.tenantId,
      authorizedCapabilities: delegation.allowedCapabilities,
      authorizedCommands: delegation.allowedCommands,
      startedAt: delegation.startedAt,
      expiresAt: delegation.expiresAt,
      delegationId: delegation.delegationId,
    });
    return cloneDelegation(delegation);
  }

  refreshDelegation(_delegationId: string): never {
    throw new AuthorityError(
      'delegation_refresh_forbidden',
      'Delegated authority cannot be silently refreshed; issue a new consented delegation',
      [this.clauses.noDelegationRefresh],
    );
  }

  revokeDelegation(input: { delegationId: string; revokedAt: string; reason: string }): void {
    const delegation = this.delegations.get(input.delegationId);
    if (!delegation) return;
    this.delegations.set(input.delegationId, {
      ...delegation,
      revokedAt: input.revokedAt,
      revocationReason: input.reason,
    });
    for (const [sessionId, session] of this.sessions) {
      if (session.delegationId === input.delegationId && !session.revokedAt) {
        this.sessions.set(sessionId, {
          ...session,
          revokedAt: input.revokedAt,
          revocationReason: input.reason,
        });
      }
    }
  }

  createContext(input: {
    actorId: string;
    subjectId: string;
    tenantId: string;
    actingIdentityId: string;
    now: string;
    sessionId?: string;
    delegationId?: string;
    requiredCommand?: string;
    requiredCapability?: string;
  }): AuthorityContext {
    const actor = this.requirePrincipal(input.actorId);
    const subject = this.requirePrincipal(input.subjectId);
    this.assertTenant(actor, input.tenantId);
    this.assertTenant(subject, input.tenantId);
    const delegated = actor.id !== subject.id;
    let delegation: DelegationRecord | undefined;
    if (delegated) {
      if (!input.delegationId) {
        throw new AuthorityError(
          'assisted_session_required',
          'Actor and subject differ; an active delegated session is required',
          [this.clauses.assistedSessionRequired],
        );
      }
      delegation = this.delegations.get(input.delegationId);
      if (!delegation || delegation.actorId !== actor.id || delegation.subjectId !== subject.id) {
        throw new AuthorityError(
          'delegation_mismatch',
          'Delegation does not bind the requested actor and subject',
          [this.clauses.assistedSessionRequired],
        );
      }
      const now = isoMillis(input.now, 'context.now');
      if (delegation.revokedAt || now >= isoMillis(delegation.expiresAt, 'delegation.expiresAt')) {
        throw new AuthorityError('delegation_inactive', 'Delegation is revoked or expired', [
          this.clauses.assistedSessionRequired,
          this.clauses.delegationDuration,
        ]);
      }
      if (input.requiredCommand && !delegation.allowedCommands.includes(input.requiredCommand)) {
        throw new AuthorityError(
          'delegation_command_denied',
          `Delegation does not allow command ${input.requiredCommand}`,
          [this.clauses.assistedSessionRequired],
        );
      }
      if (
        input.requiredCapability &&
        !delegation.allowedCapabilities.includes(input.requiredCapability)
      ) {
        throw new AuthorityError(
          'delegation_capability_denied',
          `Delegation does not allow capability ${input.requiredCapability}`,
          [subject.subsetClauseId ?? this.clauses.childSubset],
        );
      }
    }

    let session: AuthoritySession | undefined;
    const resolvedSessionId = input.sessionId ?? delegation?.sessionId;
    if (resolvedSessionId) {
      session = this.sessions.get(resolvedSessionId);
      const now = isoMillis(input.now, 'context.now');
      if (
        !session ||
        session.principalId !== actor.id ||
        session.tenantId !== input.tenantId ||
        (delegation !== undefined && session.delegationId !== delegation.delegationId) ||
        session.revokedAt ||
        now >= isoMillis(session.expiresAt, 'session.expiresAt')
      ) {
        throw new AuthorityError(
          'session_inactive',
          'Authority session is missing, revoked, or expired',
          [this.clauses.affectedSessionRevocation],
        );
      }
    }
    if (input.actingIdentityId !== actor.identityId) {
      throw new AuthorityError(
        'acting_identity_mismatch',
        'Acting identity must match the authenticated actor identity',
        [this.clauses.dualAttribution],
      );
    }

    return {
      actorId: actor.id,
      actorIdentityId: actor.identityId,
      subjectId: subject.id,
      subjectIdentityId: subject.identityId,
      actingIdentityId: input.actingIdentityId,
      tenantId: input.tenantId,
      role: actor.role,
      subjectRole: subject.role,
      permissions: [...subject.entitlements.permissions],
      entitlements: normalizedEntitlements(subject.entitlements),
      ...(session ? { session: cloneSession(session) } : {}),
      ...(delegation ? { delegation: cloneDelegation(delegation), delegatedFrom: actor.id } : {}),
    };
  }

  /** Compatibility wrapper that still creates a real, expiring delegation. */
  impersonate(input: {
    actorId: string;
    subjectId: string;
    tenantId: string;
    maxDurationMinutes?: number;
    now?: string;
    delegationId?: string;
    consentReference?: string;
    evidenceReceiptId?: string;
  }): AuthorityContext {
    const now = input.now ?? new Date().toISOString();
    const actor = this.requirePrincipal(input.actorId);
    const subject = this.requirePrincipal(input.subjectId);
    const delegation = this.startDelegation({
      delegationId: input.delegationId ?? `delegation:${actor.id}:${subject.id}:${now}`,
      sessionId: `session:${actor.id}:${subject.id}:${now}`,
      actorId: actor.id,
      subjectId: subject.id,
      tenantId: input.tenantId,
      allowedCommands: actor.entitlements.permissions,
      allowedResources: [`principal:${subject.id}`],
      allowedCapabilities: subject.entitlements.allowedAgents,
      startedAt: now,
      durationMinutes: input.maxDurationMinutes ?? 60,
      consentReference: input.consentReference ?? `consent:${subject.id}`,
      evidenceReceiptId: input.evidenceReceiptId ?? `evidence:${subject.id}:${now}`,
    });
    return this.createContext({
      actorId: actor.id,
      subjectId: subject.id,
      tenantId: input.tenantId,
      actingIdentityId: actor.identityId,
      now,
      delegationId: delegation.delegationId,
    });
  }

  reassignPrincipal(input: {
    reassignmentId: string;
    principalId: string;
    newParentId: string;
    tenantId: string;
    occurredAt: string;
  }): ReassignmentRecord {
    const principal = this.requirePrincipal(input.principalId);
    const newParent = this.requirePrincipal(input.newParentId);
    this.assertTenant(principal, input.tenantId);
    this.assertTenant(newParent, input.tenantId);
    const candidate = { ...principal, parentId: newParent.id };
    this.principals.set(principal.id, candidate);
    try {
      this.assertChildSubsetOfParent(principal.id);
    } catch (error) {
      this.principals.set(principal.id, principal);
      throw error;
    }
    const record: ReassignmentRecord = {
      reassignmentId: input.reassignmentId,
      tenantId: input.tenantId,
      principalId: principal.id,
      ...(principal.parentId ? { previousParentId: principal.parentId } : {}),
      newParentId: newParent.id,
      occurredAt: input.occurredAt,
      clauseIds: [this.clauses.sameTenantReassignment, this.clauses.historicalAttribution],
    };
    this.reassignmentRecords.push(record);
    return { ...record, clauseIds: [...record.clauseIds] };
  }

  recordAttribution(
    input: Omit<AttributionSnapshot, 'subjectParentId' | 'clauseIds'>,
  ): AttributionSnapshot {
    const actor = this.requirePrincipal(input.actorId);
    const subject = this.requirePrincipal(input.subjectId);
    this.assertTenant(actor, input.tenantId);
    this.assertTenant(subject, input.tenantId);
    if (input.actingIdentityId !== actor.identityId) {
      throw new AuthorityError(
        'acting_identity_mismatch',
        'Audit acting identity does not match actor',
        [this.clauses.dualAttribution],
      );
    }
    const record: AttributionSnapshot = {
      ...input,
      ...(subject.parentId ? { subjectParentId: subject.parentId } : {}),
      clauseIds: [this.clauses.dualAttribution, this.clauses.historicalAttribution],
    };
    this.attributionRecords.push(record);
    return { ...record, clauseIds: [...record.clauseIds] };
  }
}

export function createClauseLinkedAuditRecord<Payload>(input: {
  auditId: string;
  eventType: string;
  context: AuthorityContext;
  clauseIds: readonly StableClauseId[];
  occurredAt: string;
  payload?: Payload;
}): ClauseLinkedAuditRecord<Payload> {
  assertClauseIds(input.clauseIds, `audit ${input.auditId}`);
  if (!input.context.actorId || !input.context.subjectId || !input.context.actingIdentityId) {
    throw new AuthorityError(
      'dual_attribution_missing',
      'Audit records require actor, subject, and acting identity',
      input.clauseIds,
    );
  }
  return {
    auditId: input.auditId,
    eventType: input.eventType,
    tenantId: input.context.tenantId,
    actorId: input.context.actorId,
    subjectId: input.context.subjectId,
    actingIdentityId: input.context.actingIdentityId,
    clauseIds: sortUnique(input.clauseIds),
    occurredAt: input.occurredAt,
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  };
}

export function createClauseLinkedEvidenceReceipt<Payload>(input: {
  receiptId: string;
  eventType: string;
  context: AuthorityContext;
  clauseIds: readonly StableClauseId[];
  recordedAt: string;
  payload?: Payload;
}): ClauseLinkedEvidenceReceipt<Payload> {
  assertClauseIds(input.clauseIds, `evidence receipt ${input.receiptId}`);
  if (!input.context.actorId || !input.context.subjectId || !input.context.actingIdentityId) {
    throw new AuthorityError(
      'dual_attribution_missing',
      'Evidence receipts require actor, subject, and acting identity',
      input.clauseIds,
    );
  }
  return {
    receiptId: input.receiptId,
    eventType: input.eventType,
    tenantId: input.context.tenantId,
    actorId: input.context.actorId,
    subjectId: input.context.subjectId,
    actingIdentityId: input.context.actingIdentityId,
    clauseIds: sortUnique(input.clauseIds),
    recordedAt: input.recordedAt,
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  };
}
