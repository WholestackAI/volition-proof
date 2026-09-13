import { describe, expect, it } from 'vitest';
import {
  AuthorityError,
  AuthorityGraph,
  authorityDenialFromError,
  createClauseLinkedAuditRecord,
  createClauseLinkedEvidenceReceipt,
  type AuthorityPolicyClauses,
} from './index.js';

const clauses: AuthorityPolicyClauses = {
  tenantIsolation: 'AIV-AUTH-001',
  childSubset: 'AIV-PERM-001',
  reductionCascade: 'AIV-PERM-003',
  additionDoesNotCascade: 'AIV-PERM-004',
  affectedSessionRevocation: 'AIV-PERM-005',
  assistedSessionRequired: 'AIV-IMP-001',
  delegationDuration: 'AIV-IMP-003',
  noDelegationRefresh: 'AIV-IMP-004',
  dualAttribution: 'AIV-IMP-002',
  sameTenantReassignment: 'AIV-AUTH-002',
  historicalAttribution: 'AIV-AUTH-003',
};

const NOW = '2026-08-01T12:00:00.000Z';

function sampleGraph(): AuthorityGraph {
  const graph = new AuthorityGraph({ clauses });
  graph.register({
    id: 'firm-1',
    identityId: 'identity-firm-1',
    tenantId: 'tenant-1',
    role: 'financial_planner_group',
    entitlements: {
      allowedAgents: ['A01', 'A02', 'A03'],
      permissions: ['impersonate_start', 'run_illustration'],
    },
  });
  graph.register({
    id: 'planner-1',
    identityId: 'identity-planner-1',
    tenantId: 'tenant-1',
    role: 'financial_planner',
    parentId: 'firm-1',
    subsetClauseId: 'AIV-PERM-002',
    entitlements: {
      allowedAgents: ['A01', 'A02'],
      permissions: ['impersonate_start', 'run_illustration'],
    },
  });
  graph.register({
    id: 'planner-2',
    identityId: 'identity-planner-2',
    tenantId: 'tenant-1',
    role: 'financial_planner',
    parentId: 'firm-1',
    subsetClauseId: 'AIV-PERM-002',
    entitlements: {
      allowedAgents: ['A01', 'A02'],
      permissions: ['impersonate_start', 'run_illustration'],
    },
  });
  graph.register({
    id: 'client-1',
    identityId: 'identity-client-1',
    tenantId: 'tenant-1',
    role: 'user',
    parentId: 'planner-1',
    subsetClauseId: 'AIV-PERM-001',
    entitlements: {
      allowedAgents: ['A01', 'A02'],
      permissions: ['run_illustration'],
    },
  });
  graph.register({
    id: 'foreign-client',
    identityId: 'identity-foreign-client',
    tenantId: 'tenant-2',
    role: 'user',
    entitlements: { allowedAgents: ['A01'], permissions: ['run_illustration'] },
  });
  return graph;
}

function expectClause(run: () => unknown, clauseId: string): void {
  try {
    run();
    throw new Error('expected authority denial');
  } catch (error) {
    expect(error).toBeInstanceOf(AuthorityError);
    expect((error as AuthorityError).clauseIds).toContain(clauseId);
  }
}

function startDelegation(graph: AuthorityGraph, durationMinutes = 60) {
  return graph.startDelegation({
    delegationId: 'delegation-1',
    sessionId: 'assisted-session-1',
    actorId: 'planner-1',
    subjectId: 'client-1',
    tenantId: 'tenant-1',
    allowedCommands: ['run_illustration'],
    allowedResources: ['client:client-1'],
    allowedCapabilities: ['A02'],
    startedAt: NOW,
    durationMinutes,
    consentReference: 'consent-1',
    evidenceReceiptId: 'receipt-delegation-1',
  });
}

describe('AuthorityGraph hierarchical entitlements', () => {
  it('accepts client subset planner subset firm', () => {
    expect(() => sampleGraph().cascadeValidate()).not.toThrow();
  });

  it('names the client subset clause for a client capability violation', () => {
    const graph = sampleGraph();
    graph.register({
      id: 'client-bad',
      identityId: 'identity-client-bad',
      tenantId: 'tenant-1',
      role: 'user',
      parentId: 'planner-2',
      subsetClauseId: 'AIV-PERM-001',
      entitlements: { allowedAgents: ['A99'], permissions: ['run_illustration'] },
    });
    expectClause(() => graph.assertChildSubsetOfParent('client-bad'), 'AIV-PERM-001');
  });

  it('names the planner subset clause for a planner capability violation', () => {
    const graph = sampleGraph();
    graph.register({
      id: 'planner-bad',
      identityId: 'identity-planner-bad',
      tenantId: 'tenant-1',
      role: 'financial_planner',
      parentId: 'firm-1',
      subsetClauseId: 'AIV-PERM-002',
      entitlements: { allowedAgents: ['A99'], permissions: ['run_illustration'] },
    });
    expectClause(() => graph.assertChildSubsetOfParent('planner-bad'), 'AIV-PERM-002');
  });

  it('rejects cross-tenant hierarchy and access with the tenant clause', () => {
    const graph = sampleGraph();
    graph.register({
      id: 'cross-tenant-child',
      identityId: 'identity-cross-tenant',
      tenantId: 'tenant-2',
      role: 'user',
      parentId: 'planner-1',
      subsetClauseId: 'AIV-PERM-001',
      entitlements: { allowedAgents: ['A01'], permissions: ['run_illustration'] },
    });
    expectClause(() => graph.assertChildSubsetOfParent('cross-tenant-child'), 'AIV-AUTH-001');
    expectClause(
      () =>
        graph.createContext({
          actorId: 'planner-1',
          subjectId: 'foreign-client',
          tenantId: 'tenant-1',
          actingIdentityId: 'identity-planner-1',
          now: NOW,
        }),
      'AIV-AUTH-001',
    );
  });

  it('serializes runtime denials with the precise ISL clause id', () => {
    const graph = sampleGraph();
    try {
      graph.createContext({
        actorId: 'planner-1',
        subjectId: 'foreign-client',
        tenantId: 'tenant-1',
        actingIdentityId: 'identity-planner-1',
        now: NOW,
      });
      throw new Error('expected denial');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorityError);
      expect(authorityDenialFromError(error as AuthorityError)).toEqual(
        expect.objectContaining({
          decision: 'deny',
          code: 'cross_tenant_access',
          clauseIds: ['AIV-AUTH-001'],
        }),
      );
    }
  });

  it('dry-runs reduce-only cascades without mutating state', () => {
    const graph = sampleGraph();
    const impact = graph.planEntitlementChange({
      tenantId: 'tenant-1',
      targetId: 'planner-1',
      next: { allowedAgents: ['A01'], permissions: ['impersonate_start', 'run_illustration'] },
    });
    expect(impact.principalUpdates.map((update) => update.principalId)).toEqual([
      'planner-1',
      'client-1',
    ]);
    expect(impact.removedCapabilities).toEqual(['A02']);
    expect(impact.clauseIds).toContain('AIV-PERM-003');
    expect(graph.get('client-1')?.entitlements.allowedAgents).toEqual(['A01', 'A02']);
  });

  it('cascades reductions but never additions', () => {
    const graph = sampleGraph();
    graph.applyEntitlementChange({
      tenantId: 'tenant-1',
      targetId: 'planner-1',
      next: { allowedAgents: ['A01'], permissions: ['impersonate_start', 'run_illustration'] },
      occurredAt: NOW,
      revocationReason: 'firm_removed_A02',
    });
    expect(graph.get('client-1')?.entitlements.allowedAgents).toEqual(['A01']);

    graph.applyEntitlementChange({
      tenantId: 'tenant-1',
      targetId: 'planner-1',
      next: {
        allowedAgents: ['A01', 'A02'],
        permissions: ['impersonate_start', 'run_illustration'],
      },
      occurredAt: '2026-08-01T12:01:00.000Z',
      revocationReason: 'not_used_for_addition',
    });
    expect(graph.get('client-1')?.entitlements.allowedAgents).toEqual(['A01']);
  });

  it('revokes affected sessions and delegations on permission reduction', () => {
    const graph = sampleGraph();
    const delegation = startDelegation(graph);
    graph.registerSession({
      sessionId: 'session-1',
      principalId: 'planner-1',
      tenantId: 'tenant-1',
      authorizedCapabilities: ['A02'],
      authorizedCommands: ['run_illustration'],
      startedAt: NOW,
      expiresAt: '2026-08-01T13:00:00.000Z',
      delegationId: delegation.delegationId,
    });
    const impact = graph.applyEntitlementChange({
      tenantId: 'tenant-1',
      targetId: 'planner-1',
      next: { allowedAgents: ['A01'], permissions: ['impersonate_start', 'run_illustration'] },
      occurredAt: '2026-08-01T12:05:00.000Z',
      revocationReason: 'capability_removed',
    });
    expect(impact.affectedSessionIds).toEqual(['assisted-session-1', 'session-1']);
    expect(impact.affectedDelegationIds).toEqual(['delegation-1']);
    expect(graph.getSession('session-1')?.revocationReason).toBe('capability_removed');
    expect(graph.getDelegation('delegation-1')?.revocationReason).toBe('capability_removed');
  });
});

describe('AuthorityGraph delegated authority', () => {
  it('requires an active assisted session whenever actor and subject differ', () => {
    const graph = sampleGraph();
    expectClause(
      () =>
        graph.createContext({
          actorId: 'planner-1',
          subjectId: 'client-1',
          tenantId: 'tenant-1',
          actingIdentityId: 'identity-planner-1',
          now: NOW,
          requiredCapability: 'A02',
        }),
      'AIV-IMP-001',
    );
  });

  it('caps delegation at 60 minutes and refuses silent refresh', () => {
    const graph = sampleGraph();
    expectClause(() => startDelegation(graph, 61), 'AIV-IMP-003');
    startDelegation(graph, 60);
    expectClause(() => graph.refreshDelegation('delegation-1'), 'AIV-IMP-004');
    expectClause(() => startDelegation(graph, 60), 'AIV-IMP-004');
  });

  it('produces a context with actor, subject, acting identity, tenant, and delegation', () => {
    const graph = sampleGraph();
    const delegation = startDelegation(graph);
    const context = graph.createContext({
      actorId: 'planner-1',
      subjectId: 'client-1',
      tenantId: 'tenant-1',
      actingIdentityId: 'identity-planner-1',
      now: '2026-08-01T12:30:00.000Z',
      delegationId: delegation.delegationId,
      requiredCommand: 'run_illustration',
      requiredCapability: 'A02',
    });
    expect(context).toMatchObject({
      actorId: 'planner-1',
      subjectId: 'client-1',
      actingIdentityId: 'identity-planner-1',
      tenantId: 'tenant-1',
      role: 'financial_planner',
      subjectRole: 'user',
    });
    expect(context.entitlements.allowedAgents).toEqual(['A01', 'A02']);
    expect(context.delegation?.delegationId).toBe('delegation-1');
    expect(context.session?.sessionId).toBe('assisted-session-1');
  });

  it('requires authenticated actor identity for dual attribution', () => {
    const graph = sampleGraph();
    const delegation = startDelegation(graph);
    expectClause(
      () =>
        graph.createContext({
          actorId: 'planner-1',
          subjectId: 'client-1',
          tenantId: 'tenant-1',
          actingIdentityId: 'identity-client-1',
          now: '2026-08-01T12:30:00.000Z',
          delegationId: delegation.delegationId,
        }),
      'AIV-IMP-002',
    );
  });

  it('carries clause ids and dual attribution into audit and evidence', () => {
    const graph = sampleGraph();
    const delegation = startDelegation(graph);
    const context = graph.createContext({
      actorId: 'planner-1',
      subjectId: 'client-1',
      tenantId: 'tenant-1',
      actingIdentityId: 'identity-planner-1',
      now: '2026-08-01T12:30:00.000Z',
      delegationId: delegation.delegationId,
    });
    const audit = createClauseLinkedAuditRecord({
      auditId: 'audit-1',
      eventType: 'illustration_run',
      context,
      clauseIds: ['AIV-IMP-002', 'AIV-CP1-001'],
      occurredAt: NOW,
    });
    const evidence = createClauseLinkedEvidenceReceipt({
      receiptId: 'receipt-1',
      eventType: 'illustration_run',
      context,
      clauseIds: ['AIV-IMP-002', 'AIV-CP1-001'],
      recordedAt: NOW,
    });
    expect(audit).toMatchObject({ actorId: 'planner-1', subjectId: 'client-1' });
    expect(evidence.actingIdentityId).toBe('identity-planner-1');
    expect(evidence.clauseIds).toContain('AIV-IMP-002');
  });
});

describe('AuthorityGraph reassignment and immutable attribution', () => {
  it('rejects reassignment across firms/tenants', () => {
    const graph = sampleGraph();
    expectClause(
      () =>
        graph.reassignPrincipal({
          reassignmentId: 'reassign-cross-tenant',
          principalId: 'client-1',
          newParentId: 'foreign-client',
          tenantId: 'tenant-1',
          occurredAt: NOW,
        }),
      'AIV-AUTH-001',
    );
  });

  it('reassigns within a firm without rewriting historical attribution', () => {
    const graph = sampleGraph();
    graph.recordAttribution({
      attributionId: 'attribution-before',
      tenantId: 'tenant-1',
      actorId: 'planner-1',
      subjectId: 'client-1',
      actingIdentityId: 'identity-planner-1',
      occurredAt: NOW,
    });
    graph.reassignPrincipal({
      reassignmentId: 'reassign-1',
      principalId: 'client-1',
      newParentId: 'planner-2',
      tenantId: 'tenant-1',
      occurredAt: '2026-08-01T12:10:00.000Z',
    });
    expect(graph.get('client-1')?.parentId).toBe('planner-2');
    expect(graph.attributions()[0]?.subjectParentId).toBe('planner-1');
    expect(graph.reassignments()[0]?.clauseIds).toContain('AIV-AUTH-003');
  });
});
