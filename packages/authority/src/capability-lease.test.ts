import { describe, expect, it } from 'vitest';

import {
  AuthorityGraph,
  issueCapabilityLease,
  verifyCapabilityLease,
} from './index.js';

const CONTRACT = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function graphWithDev() {
  const graph = new AuthorityGraph();
  graph.register({
    id: 'dev-1',
    identityId: 'identity-dev-1',
    tenantId: 'tenant-1',
    role: 'implementer',
    entitlements: { allowedAgents: [], permissions: ['write_file', 'read_file'] },
  });
  return graph;
}

describe('capability lease', () => {
  it('issues a hash-bound lease that verifies against the graph session', () => {
    const graph = graphWithDev();
    const lease = issueCapabilityLease({
      graph,
      principalId: 'dev-1',
      tenantId: 'tenant-1',
      commands: ['write_file'],
      contractHash: CONTRACT,
      startedAt: '2026-09-11T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      sessionId: 'lease-dev-write',
    });
    const verified = verifyCapabilityLease({ lease, graph, contractHash: CONTRACT });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.session.authorizedCommands).toEqual(['write_file']);
      expect(verified.session.tenantId).toBe('tenant-1');
    }
  });

  it('refuses a lease bound to a different contract', () => {
    const graph = graphWithDev();
    const lease = issueCapabilityLease({
      graph,
      principalId: 'dev-1',
      tenantId: 'tenant-1',
      commands: ['write_file'],
      contractHash: CONTRACT,
      expiresAt: '2099-01-01T00:00:00.000Z',
      sessionId: 'lease-other-contract',
    });
    const verified = verifyCapabilityLease({ lease, graph, contractHash: OTHER });
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.decision.code).toBe('COMMAND_NOT_LEASED');
      expect(verified.decision.reason).toMatch(/not bound/);
    }
  });

  it('refuses a tampered lease hash', () => {
    const graph = graphWithDev();
    const lease = issueCapabilityLease({
      graph,
      principalId: 'dev-1',
      tenantId: 'tenant-1',
      commands: ['write_file'],
      contractHash: CONTRACT,
      expiresAt: '2099-01-01T00:00:00.000Z',
      sessionId: 'lease-tamper',
    });
    const verified = verifyCapabilityLease({
      lease: { ...lease, leaseHash: `${lease.leaseHash}ff` },
      graph,
      contractHash: CONTRACT,
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.decision.code).toBe('COMMAND_NOT_LEASED');
      expect(verified.decision.reason).toMatch(/hash mismatch/);
    }
  });

  it('refuses an unknown session id', () => {
    const graph = graphWithDev();
    const lease = issueCapabilityLease({
      graph,
      principalId: 'dev-1',
      tenantId: 'tenant-1',
      commands: ['read_file'],
      contractHash: CONTRACT,
      expiresAt: '2099-01-01T00:00:00.000Z',
      sessionId: 'lease-known',
    });
    const verified = verifyCapabilityLease({
      lease: { ...lease, sessionId: 'lease-forged' },
      graph,
      contractHash: CONTRACT,
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.decision.code).toBe('COMMAND_NOT_LEASED');
  });

  it('refuses a revoked graph session even if the client omits revokedAt', () => {
    const graph = graphWithDev();
    const lease = issueCapabilityLease({
      graph,
      principalId: 'dev-1',
      tenantId: 'tenant-1',
      commands: ['write_file'],
      contractHash: CONTRACT,
      expiresAt: '2099-01-01T00:00:00.000Z',
      sessionId: 'lease-revoke',
    });
    graph.revokeSession({
      sessionId: lease.sessionId,
      revokedAt: '2026-09-11T12:00:00.000Z',
      reason: 'operator revoke',
    });
    const verified = verifyCapabilityLease({ lease, graph, contractHash: CONTRACT });
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.decision.code).toBe('EXPIRED_LEASE');
      expect(verified.decision.reason).toMatch(/revoked/);
    }
  });

  it('refuses an expired graph session', () => {
    const graph = graphWithDev();
    const lease = issueCapabilityLease({
      graph,
      principalId: 'dev-1',
      tenantId: 'tenant-1',
      commands: ['write_file'],
      contractHash: CONTRACT,
      startedAt: '2020-01-01T00:00:00.000Z',
      expiresAt: '2020-01-02T00:00:00.000Z',
      sessionId: 'lease-expired',
    });
    const verified = verifyCapabilityLease({
      lease,
      graph,
      contractHash: CONTRACT,
      now: new Date('2026-09-11T00:00:00.000Z'),
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.decision.code).toBe('EXPIRED_LEASE');
  });

  it('refuses commands that exceed the principal', () => {
    const graph = graphWithDev();
    expect(() =>
      issueCapabilityLease({
        graph,
        principalId: 'dev-1',
        tenantId: 'tenant-1',
        commands: ['write_file', 'git_push'],
        contractHash: CONTRACT,
        expiresAt: '2099-01-01T00:00:00.000Z',
        sessionId: 'lease-excess',
      }),
    ).toThrow(/exceeds principal/);
  });
});
