import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAppContract, type AppContract, type Clause } from '@wholestack/app-contract';
import { describe, expect, it } from 'vitest';

import { decideCommand, type AuthorityLookup, type DecideCommandInput } from './decide-command.js';
import { AuthorityGraph } from './index.js';
import { SwarmEnvelope } from './swarm-authority.js';

const root = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(root, '../../../fixtures/isl-specs/coding-agent-jurisdiction.isl');

function loadContract(): AppContract {
  const parsed = parseAppContract(readFileSync(FIXTURE, 'utf8'));
  expect(parsed.ok, parsed.diagnostics.map((d) => d.message).join('; ')).toBe(true);
  return parsed.contract!;
}

function decide(
  contract: AppContract,
  action: string,
  args: Record<string, unknown>,
  extra: Partial<DecideCommandInput> = {},
) {
  return decideCommand({
    contract,
    actor: extra.actor ?? { id: 'dev-1', roles: ['implementer'] },
    action,
    args,
    ...extra,
  });
}

describe('decideCommand', () => {
  it('parses the coding-agent jurisdiction fixture', () => {
    const contract = loadContract();
    expect(contract.clauses.some((c) => c.kind === 'behavior' && c.semantic?.kind === 'behavior' && c.semantic.behavior === 'write_file')).toBe(true);
    expect(contract.clauses.some((c) => c.kind === 'precondition')).toBe(true);
  });

  it('grants a legitimate write under the assigned glob', () => {
    const result = decide(loadContract(), 'write_file', {
      path: 'packages/assigned/src/ok.ts',
      content: 'export const ok = true;\n',
    });
    expect(result.status).toBe('GRANTED');
    expect(result.allowed).toBe(true);
  });

  it('denies an unknown action', () => {
    const result = decide(loadContract(), 'delete_file', { path: 'packages/assigned/src/ok.ts' });
    expect(result.status).toBe('DENIED');
    expect(result.code).toBe('UNKNOWN_ACTION');
  });

  it('denies a role miss', () => {
    const result = decide(
      loadContract(),
      'refund',
      { amount: 50 },
      { actor: { id: 'dev-1', roles: ['implementer'] } },
    );
    expect(result.status).toBe('DENIED');
    expect(result.code).toBe('ROLE_DENIED');
    expect(result.reason).toMatch(/implementer/);
  });

  it('denies an over-cap refund with numbers in the reason', () => {
    const result = decide(
      loadContract(),
      'refund',
      { amount: 1400 },
      { actor: { id: 'fin-1', roles: ['finance'] } },
    );
    expect(result.status).toBe('DENIED');
    expect(result.code).toBe('REFUND_LIMIT_EXCEEDED');
    expect(result.reason).toMatch(/requested:\s*1400/);
    expect(result.reason).toMatch(/maximum:\s*1000/);
    expect(result.requested).toBe(1400);
    expect(result.maximum).toBe(1000);
  });

  it('denies writes to locked authority artifacts', () => {
    const result = decide(loadContract(), 'write_file', {
      path: 'fixtures/isl-specs/coding-agent-jurisdiction.isl',
      content: 'domain Tamper { version: "1.0.0" }\n',
    });
    expect(result.status).toBe('DENIED');
    expect(result.code).toBe('LOCKED_PATH');
  });

  it('escalates when approval evidence is missing', () => {
    const result = decide(loadContract(), 'create_migration', { name: 'add_column' });
    expect(result.status).toBe('ESCALATION_REQUIRED');
    expect(result.code).toBe('APPROVAL_REQUIRED');
  });

  it('grants an approved migration when a proposal hash is bound', () => {
    const result = decide(
      loadContract(),
      'create_migration',
      { name: 'add_column' },
      { evidence: { boundProposalHash: 'sha256:abc' } },
    );
    expect(result.status).toBe('GRANTED');
  });

  it('fails closed on an unrepresented predicate', () => {
    const contract = loadContract();
    const host = contract.clauses.find((c) => c.kind === 'behavior' && c.id === 'behavior:write_file');
    expect(host).toBeTruthy();
    const injected: Clause = {
      id: 'precondition:write_file:unrepresented',
      kind: 'precondition',
      section: 'rules',
      title: 'unrepresented',
      refs: ['behavior:write_file'],
      islExcerpt: 'exists x in items { x.flag }',
      semantic: {
        kind: 'precondition',
        behavior: 'write_file',
        predicate: { node: 'unrepresented', astKind: 'QuantifierExpr' },
        gaps: [],
      },
    };
    const result = decide(
      { ...contract, clauses: [...contract.clauses, injected] },
      'write_file',
      { path: 'packages/assigned/src/ok.ts', content: 'ok' },
    );
    expect(result.status).toBe('DENIED');
    expect(result.code).toBe('UNREPRESENTED_PREDICATE');
  });

  it('denies emptying a test file', () => {
    const result = decide(loadContract(), 'write_file', {
      path: 'packages/assigned/src/ok.test.ts',
      content: '',
    });
    expect(result.status).toBe('DENIED');
    expect(result.code).toBe('TEST_MANIPULATION');
  });

  it('refuses a coerced-down transfer the prompted amount would have blocked (Volition 9001)', () => {
    const result = decide(
      loadContract(),
      'transfer',
      { amount: 1000, accountId: 'acct-1', recipient: 'carrier' },
      {
        actor: { id: 'fin-1', roles: ['finance'] },
        evidence: { prompted: { amount: 15000 } },
      },
    );
    expect(result.status).toBe('DENIED');
    expect(result.code).toBe('COERCED_INTENT');
    expect(result.reason).toMatch(/15000|2500|Prompted/i);
  });

  it('denies a graph tenant mismatch', () => {
    const graph = new AuthorityGraph();
    graph.register({
      id: 'fin-1',
      identityId: 'identity-fin-1',
      tenantId: 'tenant-1',
      role: 'finance',
      entitlements: { allowedAgents: [], permissions: ['refund'] },
    });
    const result = decide(
      loadContract(),
      'refund',
      { amount: 50 },
      { actor: { id: 'fin-1', roles: ['finance'], tenantId: 'tenant-2' }, graph },
    );
    expect(result.status).toBe('DENIED');
    expect(result.code).toBe('TENANT_DENIED');
    expect(result.allowed).toBe(false);
  });

  it('merges the graph role onto the actor', () => {
    const graph = new AuthorityGraph();
    graph.register({
      id: 'fin-1',
      identityId: 'identity-fin-1',
      tenantId: 'tenant-1',
      role: 'finance',
      entitlements: { allowedAgents: [], permissions: ['refund'] },
    });
    const result = decide(
      loadContract(),
      'refund',
      { amount: 50 },
      { actor: { id: 'fin-1', roles: ['implementer'], tenantId: 'tenant-1' }, graph },
    );
    expect(result.status).toBe('GRANTED');
    expect(result.allowed).toBe(true);
  });

  it('does not let claimed roles exceed the graph lookup', () => {
    const graph: AuthorityLookup = {
      get(id) {
        return id === 'dev-1' ? { tenantId: 'tenant-1', role: 'implementer' } : undefined;
      },
    };
    const result = decide(
      loadContract(),
      'refund',
      { amount: 50 },
      { actor: { id: 'dev-1', roles: ['finance'], tenantId: 'tenant-1' }, graph },
    );
    expect(result.status).toBe('DENIED');
    expect(result.code).toBe('ROLE_DENIED');
  });

  it('denies an expired leaseExpiresAt', () => {
    const result = decide(
      loadContract(),
      'write_file',
      { path: 'packages/assigned/src/ok.ts', content: 'export const ok = true;\n' },
      { evidence: { leaseExpiresAt: '2020-01-01T00:00:00.000Z' } },
    );
    expect(result.status).toBe('DENIED');
    expect(result.code).toBe('EXPIRED_LEASE');
    expect(result.reason).toMatch(/EXPIRED_LEASE/);
  });

  it('denies an expired graph session', () => {
    const graph = new AuthorityGraph();
    graph.register({
      id: 'dev-1',
      identityId: 'identity-dev-1',
      tenantId: 'tenant-1',
      role: 'implementer',
      entitlements: { allowedAgents: [], permissions: ['write_file'] },
    });
    const session = graph.registerSession({
      sessionId: 'lease-expired',
      principalId: 'dev-1',
      tenantId: 'tenant-1',
      authorizedCapabilities: [],
      authorizedCommands: ['write_file'],
      startedAt: '2020-01-01T00:00:00.000Z',
      expiresAt: '2020-01-02T00:00:00.000Z',
    });
    const result = decide(
      loadContract(),
      'write_file',
      { path: 'packages/assigned/src/ok.ts', content: 'export const ok = true;\n' },
      {
        actor: { id: 'dev-1', roles: ['implementer'], tenantId: 'tenant-1' },
        graph,
        evidence: { session },
      },
    );
    expect(result.status).toBe('DENIED');
    expect(result.code).toBe('EXPIRED_LEASE');
  });

  it('denies a revoked session even when expiresAt is in the future', () => {
    const result = decide(
      loadContract(),
      'write_file',
      { path: 'packages/assigned/src/ok.ts', content: 'export const ok = true;\n' },
      {
        evidence: {
          session: {
            expiresAt: '2099-01-01T00:00:00.000Z',
            revokedAt: '2026-01-01T00:00:00.000Z',
            authorizedCommands: ['write_file'],
          },
        },
      },
    );
    expect(result.status).toBe('DENIED');
    expect(result.code).toBe('EXPIRED_LEASE');
    expect(result.reason).toMatch(/revoked/);
  });

  it('grants when the lease is still live', () => {
    const result = decide(
      loadContract(),
      'write_file',
      { path: 'packages/assigned/src/ok.ts', content: 'export const ok = true;\n' },
      { evidence: { leaseExpiresAt: '2099-01-01T00:00:00.000Z' } },
    );
    expect(result.status).toBe('GRANTED');
  });

  it('denies a session command the lookup did not grant', () => {
    const graph: AuthorityLookup = {
      get(id) {
        return id === 'fin-1'
          ? {
              tenantId: 'tenant-1',
              role: 'finance',
              entitlements: { permissions: ['read_file'] },
            }
          : undefined;
      },
    };
    const result = decide(
      loadContract(),
      'refund',
      { amount: 50 },
      {
        actor: { id: 'fin-1', roles: ['finance'], tenantId: 'tenant-1' },
        graph,
        evidence: {
          session: {
            expiresAt: '2099-01-01T00:00:00.000Z',
            authorizedCommands: ['refund'],
          },
        },
      },
    );
    expect(result.status).toBe('DENIED');
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('COMMAND_NOT_LEASED');
    expect(result.reason).toMatch(/lookup|leased command/i);
  });

  it('denies a child whose commands exceed the parent', () => {
    const graph = new AuthorityGraph();
    graph.register({
      id: 'owner-1',
      identityId: 'identity-owner-1',
      tenantId: 'tenant-1',
      role: 'owner',
      entitlements: { allowedAgents: [], permissions: ['write_file'] },
    });
    graph.register({
      id: 'child-1',
      identityId: 'identity-child-1',
      tenantId: 'tenant-1',
      role: 'implementer',
      parentId: 'owner-1',
      entitlements: { allowedAgents: [], permissions: ['write_file', 'refund'] },
    });
    const result = decide(
      loadContract(),
      'write_file',
      { path: 'packages/assigned/src/ok.ts', content: 'export const ok = true;\n' },
      { actor: { id: 'child-1', roles: ['implementer'], tenantId: 'tenant-1' }, graph },
    );
    expect(result.status).toBe('DENIED');
    expect(result.code).toBe('COMMAND_NOT_LEASED');
    expect(result.reason).toMatch(/exceed parent/i);
  });

  it('denies a child action the parent never granted', () => {
    const graph = new AuthorityGraph();
    graph.register({
      id: 'owner-1',
      identityId: 'identity-owner-1',
      tenantId: 'tenant-1',
      role: 'owner',
      entitlements: { allowedAgents: [], permissions: ['write_file'] },
    });
    graph.register({
      id: 'child-1',
      identityId: 'identity-child-1',
      tenantId: 'tenant-1',
      role: 'implementer',
      parentId: 'owner-1',
      entitlements: { allowedAgents: [], permissions: ['write_file'] },
    });
    const result = decide(
      loadContract(),
      'refund',
      { amount: 50 },
      { actor: { id: 'child-1', roles: ['finance'], tenantId: 'tenant-1' }, graph },
    );
    expect(result.status).toBe('DENIED');
    expect(result.code).toBe('COMMAND_NOT_LEASED');
    expect(result.reason).toMatch(/not granted by the authority graph/i);
  });

  it('grants a child action that remains a subset of the parent', () => {
    const graph = new AuthorityGraph();
    graph.register({
      id: 'owner-1',
      identityId: 'identity-owner-1',
      tenantId: 'tenant-1',
      role: 'owner',
      entitlements: { allowedAgents: [], permissions: ['write_file', 'read_file'] },
    });
    graph.register({
      id: 'child-1',
      identityId: 'identity-child-1',
      tenantId: 'tenant-1',
      role: 'implementer',
      parentId: 'owner-1',
      entitlements: { allowedAgents: [], permissions: ['write_file'] },
    });
    const result = decide(
      loadContract(),
      'write_file',
      { path: 'packages/assigned/src/ok.ts', content: 'export const ok = true;\n' },
      { actor: { id: 'child-1', roles: ['implementer'], tenantId: 'tenant-1' }, graph },
    );
    expect(result.status).toBe('GRANTED');
    expect(result.allowed).toBe(true);
  });

  it('denies an action outside the leased command set', () => {
    const result = decide(
      loadContract(),
      'refund',
      { amount: 50 },
      {
        actor: { id: 'fin-1', roles: ['finance'] },
        evidence: {
          session: {
            expiresAt: '2099-01-01T00:00:00.000Z',
            authorizedCommands: ['read_file'],
          },
        },
      },
    );
    expect(result.status).toBe('DENIED');
    expect(result.code).toBe('COMMAND_NOT_LEASED');
    expect(result.reason).toMatch(/leased command/);
  });

  it('denies artifactory_sync to huggingface as UNAUTHORIZED_EGRESS, not UNKNOWN_ACTION', () => {
    const result = decide(loadContract(), 'artifactory_sync', {
      url: 'https://huggingface.co/api/models/exfiltrate',
    });
    expect(result.status).toBe('DENIED');
    expect(result.code).toBe('UNAUTHORIZED_EGRESS');
    expect(result.reason).toMatch(/huggingface\.co/);
  });

  it('denies a hidden egress URL on an otherwise granted write', () => {
    const result = decide(loadContract(), 'write_file', {
      path: 'packages/assigned/src/ok.ts',
      content: 'export const ok = true;\n',
      url: 'https://huggingface.co/api/models/exfiltrate',
    });
    expect(result.status).toBe('DENIED');
    expect(result.code).toBe('UNAUTHORIZED_EGRESS');
  });

  it('denies writing shipgate.json as UNTRUSTED_EVALUATOR', () => {
    const result = decide(loadContract(), 'write_file', {
      path: 'shipgate.json',
      content: '{"attestation":"SHIP","selfSigned":true}',
    });
    expect(result.status).toBe('DENIED');
    expect(result.code).toBe('UNTRUSTED_EVALUATOR');
  });

  it('denies swarm pooling that would pass each individual cap', () => {
    const envelope = new SwarmEnvelope('sha256:test', [{ metric: 'refund_amount', ceiling: 1000 }]);
    const first = decide(
      loadContract(),
      'refund',
      { amount: 800 },
      { actor: { id: 'fin-1', roles: ['finance'] }, swarm: { envelope, budgetMetric: 'refund_amount' } },
    );
    expect(first.status).toBe('GRANTED');
    const second = decide(
      loadContract(),
      'refund',
      { amount: 800 },
      { actor: { id: 'fin-2', roles: ['finance'] }, swarm: { envelope, budgetMetric: 'refund_amount' } },
    );
    expect(second.status).toBe('DENIED');
    expect(second.code).toBe('SWARM_AMPLIFICATION_DENIED');
  });
});
