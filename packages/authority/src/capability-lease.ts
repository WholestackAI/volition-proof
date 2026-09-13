/**
 * Hash-bound capability lease. Child commands ⊆ the graph session.
 * Not ShipGate. Not a second vote beside decideCommand.
 */
import { createHash } from 'node:crypto';

import type { AuthorityDecision } from './decide-command.js';
import type { DecideCommandSession } from './decide-command.js';

export interface CapabilityLeaseSession {
  sessionId: string;
  principalId: string;
  tenantId: string;
  authorizedCommands: readonly string[];
  startedAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface CapabilityLeaseGraph {
  registerSession(session: {
    sessionId: string;
    principalId: string;
    tenantId: string;
    authorizedCapabilities: readonly string[];
    authorizedCommands: readonly string[];
    startedAt: string;
    expiresAt: string;
  }): CapabilityLeaseSession;
  getSession(id: string): CapabilityLeaseSession | undefined;
}

export interface CapabilityLease {
  readonly sessionId: string;
  readonly contractHash: string;
  readonly leaseHash: string;
}

export interface IssueCapabilityLeaseInput {
  graph: CapabilityLeaseGraph;
  principalId: string;
  tenantId: string;
  commands: readonly string[];
  contractHash: string;
  expiresAt: string;
  startedAt?: string;
  sessionId?: string;
  capabilities?: readonly string[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex')}`;
}

function deny(code: 'COMMAND_NOT_LEASED' | 'EXPIRED_LEASE', reason: string): AuthorityDecision {
  return {
    status: 'DENIED',
    allowed: false,
    code,
    clauseIds: [],
    reason,
  };
}

function requireHash(value: string, label: string): string {
  if (typeof value !== 'string' || !value.startsWith('sha256:') || value.length < 15) {
    throw new TypeError(`${label} must be a sha256 digest`);
  }
  return value;
}

export function capabilityLeaseHash(input: {
  sessionId: string;
  principalId: string;
  tenantId: string;
  authorizedCommands: readonly string[];
  startedAt: string;
  expiresAt: string;
  contractHash: string;
}): string {
  return sha256({
    sessionId: input.sessionId,
    principalId: input.principalId,
    tenantId: input.tenantId,
    authorizedCommands: [...input.authorizedCommands].sort(),
    startedAt: input.startedAt,
    expiresAt: input.expiresAt,
    contractHash: input.contractHash,
  });
}

export function issueCapabilityLease(input: IssueCapabilityLeaseInput): CapabilityLease {
  const contractHash = requireHash(input.contractHash, 'contractHash');
  const startedAt = input.startedAt ?? new Date().toISOString();
  const sessionId = input.sessionId ?? `lease:${input.principalId}:${startedAt}`;
  const session = input.graph.registerSession({
    sessionId,
    principalId: input.principalId,
    tenantId: input.tenantId,
    authorizedCapabilities: input.capabilities ?? [],
    authorizedCommands: input.commands,
    startedAt,
    expiresAt: input.expiresAt,
  });
  return Object.freeze({
    sessionId: session.sessionId,
    contractHash,
    leaseHash: capabilityLeaseHash({
      sessionId: session.sessionId,
      principalId: session.principalId,
      tenantId: session.tenantId,
      authorizedCommands: session.authorizedCommands,
      startedAt: session.startedAt,
      expiresAt: session.expiresAt,
      contractHash,
    }),
  });
}

export type VerifyCapabilityLeaseResult =
  | { ok: true; session: DecideCommandSession }
  | { ok: false; decision: AuthorityDecision };

export function verifyCapabilityLease(input: {
  lease: CapabilityLease;
  graph: CapabilityLeaseGraph;
  contractHash: string;
  now?: Date;
}): VerifyCapabilityLeaseResult {
  if (input.lease.contractHash !== input.contractHash) {
    return {
      ok: false,
      decision: deny(
        'COMMAND_NOT_LEASED',
        'DENIED COMMAND_NOT_LEASED — lease is not bound to this contract.',
      ),
    };
  }
  const session = input.graph.getSession(input.lease.sessionId);
  if (!session) {
    return {
      ok: false,
      decision: deny(
        'COMMAND_NOT_LEASED',
        `DENIED COMMAND_NOT_LEASED — unknown lease session ${input.lease.sessionId}.`,
      ),
    };
  }
  const expected = capabilityLeaseHash({
    sessionId: session.sessionId,
    principalId: session.principalId,
    tenantId: session.tenantId,
    authorizedCommands: session.authorizedCommands,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
    contractHash: input.contractHash,
  });
  if (expected !== input.lease.leaseHash) {
    return {
      ok: false,
      decision: deny('COMMAND_NOT_LEASED', 'DENIED COMMAND_NOT_LEASED — lease hash mismatch.'),
    };
  }
  if (session.revokedAt) {
    return {
      ok: false,
      decision: deny('EXPIRED_LEASE', `DENIED EXPIRED_LEASE — session revoked at ${session.revokedAt}.`),
    };
  }
  const nowMs = (input.now ?? new Date()).getTime();
  const expiresMs = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiresMs) || nowMs >= expiresMs) {
    return {
      ok: false,
      decision: deny('EXPIRED_LEASE', `DENIED EXPIRED_LEASE — lease expired at ${session.expiresAt}.`),
    };
  }
  return {
    ok: true,
    session: {
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
      authorizedCommands: session.authorizedCommands,
      tenantId: session.tenantId,
    },
  };
}
