/**
 * Factory coding-agent lease for the MCP host.
 * Principal permissions are the mediated tool names — child ⊆ that set.
 */
import {
  AuthorityGraph,
  issueCapabilityLease,
  type CapabilityLease,
  type DecideCommandActor,
} from '@wholestack/authority';
import type { AppContract } from '@wholestack/app-contract';

import { MEDIATED_TOOLS } from './mediate.js';

export function issueMcpCodingLease(input: {
  contract: AppContract;
  actorId?: string;
  tenantId?: string;
  role?: string;
  commands?: readonly string[];
  startedAt?: string;
  expiresAt?: string;
  sessionId?: string;
}): { graph: AuthorityGraph; lease: CapabilityLease; actor: DecideCommandActor } {
  const actorId = input.actorId ?? 'dev-1';
  const tenantId = input.tenantId ?? 'factory';
  const role = input.role ?? 'implementer';
  const commands = input.commands ?? [...MEDIATED_TOOLS];
  const graph = new AuthorityGraph();
  graph.register({
    id: actorId,
    identityId: `identity-${actorId}`,
    tenantId,
    role,
    entitlements: { allowedAgents: [], permissions: [...commands] },
  });
  const lease = issueCapabilityLease({
    graph,
    principalId: actorId,
    tenantId,
    commands,
    contractHash: input.contract.contractHash,
    startedAt: input.startedAt ?? '2026-09-11T00:00:00.000Z',
    expiresAt: input.expiresAt ?? '2099-01-01T00:00:00.000Z',
    sessionId: input.sessionId ?? `lease:${actorId}`,
  });
  return {
    graph,
    lease,
    actor: { id: actorId, roles: [role], tenantId },
  };
}
