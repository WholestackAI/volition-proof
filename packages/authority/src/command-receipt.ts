/**
 * Volition command receipt — causal record of proposal → vote → optional execution.
 *
 * This is not ShipGate. A runtime vote is not proof of reality. The receipt
 * never returns SHIP and never executes the action; `executed` is only a
 * caller-supplied flag, and only GRANTED votes may carry it as true.
 */
import { createHash } from 'node:crypto';

import { projectMandate, type AppContract } from '@wholestack/app-contract';

import type {
  AuthorityDecision,
  AuthorityDecisionCode,
  AuthorityDecisionStatus,
} from './decide-command.js';

export interface CommandReceiptDecision {
  status: AuthorityDecisionStatus;
  code: AuthorityDecisionCode;
  clauseIds: readonly string[];
  allowed: boolean;
}

export interface CommandReceipt {
  readonly receiptId: string;
  readonly at: string;
  readonly actorId: string;
  readonly action: string;
  readonly argsHash: string;
  readonly contractHash: string;
  /** Hash of `projectMandate(contract)`. Same contract, same mandate. Not a second language. */
  readonly mandateHash?: string;
  readonly decision: CommandReceiptDecision;
  readonly executed: boolean;
  /** Hash of observed pre/post or tool result. Absent means no claimed change. */
  readonly effectHash?: string;
}

export interface BuildCommandReceiptInput {
  actorId: string;
  action: string;
  args: Record<string, unknown>;
  contractHash: string;
  decision: Pick<AuthorityDecision, 'status' | 'code' | 'clauseIds' | 'allowed'>;
  /** Recorded timestamp. Excluded from `receiptId` so identity is clock-stable. */
  at?: string;
  /** Caller reports that the tool ran. Ignored unless the vote is GRANTED. */
  executed?: boolean;
  /** `projectMandate` hash. Optional so existing vote tests stay contract-bound. */
  mandateHash?: string;
  /** Observed effect (pre/post, tool result). Hashed; never stored raw. */
  effect?: Record<string, unknown>;
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

export function hashCommandCanonical(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex')}`;
}

/** Bind a receipt to the Agent Mandate view of a sealed contract. */
export function mandateHashFromContract(contract: AppContract): string {
  return hashCommandCanonical(projectMandate(contract));
}

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} is required`);
  }
  return value;
}

function sliceDecision(
  decision: Pick<AuthorityDecision, 'status' | 'code' | 'clauseIds' | 'allowed'>,
): CommandReceiptDecision {
  if (
    decision.status !== 'GRANTED' &&
    decision.status !== 'DENIED' &&
    decision.status !== 'ESCALATION_REQUIRED'
  ) {
    throw new TypeError('decision.status must be a decideCommand vote');
  }
  if (typeof decision.code !== 'string' || decision.code.length === 0) {
    throw new TypeError('decision.code is required');
  }
  if (typeof decision.allowed !== 'boolean') {
    throw new TypeError('decision.allowed must be a boolean');
  }
  if (!Array.isArray(decision.clauseIds)) {
    throw new TypeError('decision.clauseIds must be an array');
  }
  return {
    status: decision.status,
    code: decision.code,
    clauseIds: Object.freeze([...decision.clauseIds]),
    allowed: decision.allowed,
  };
}

function mayMarkExecuted(decision: CommandReceiptDecision, requested: boolean | undefined): boolean {
  return requested === true && decision.status === 'GRANTED' && decision.allowed === true;
}

/**
 * Build an immutable causal receipt. Does not call tools. Does not attest SHIP.
 * `receiptId` is a content hash of canonical fields excluding `at`.
 */
export function buildCommandReceipt(input: BuildCommandReceiptInput): CommandReceipt {
  const actorId = requireNonEmpty(input.actorId, 'actorId');
  const action = requireNonEmpty(input.action, 'action');
  const contractHash = requireNonEmpty(input.contractHash, 'contractHash');
  if (!input.args || typeof input.args !== 'object' || Array.isArray(input.args)) {
    throw new TypeError('args must be a record');
  }
  const decision = sliceDecision(input.decision);
  const executed = mayMarkExecuted(decision, input.executed);
  const argsHash = hashCommandCanonical(input.args);
  const mandateHash =
    input.mandateHash === undefined ? undefined : requireNonEmpty(input.mandateHash, 'mandateHash');
  if (input.effect !== undefined) {
    if (!input.effect || typeof input.effect !== 'object' || Array.isArray(input.effect)) {
      throw new TypeError('effect must be a record');
    }
  }
  const effectHash = input.effect ? hashCommandCanonical(input.effect) : undefined;
  const at = input.at ?? new Date().toISOString();
  const receiptId = hashCommandCanonical({
    actorId,
    action,
    argsHash,
    contractHash,
    mandateHash: mandateHash ?? null,
    decision: {
      status: decision.status,
      code: decision.code,
      clauseIds: decision.clauseIds,
      allowed: decision.allowed,
    },
    executed,
    effectHash: effectHash ?? null,
  });

  return Object.freeze({
    receiptId,
    at,
    actorId,
    action,
    argsHash,
    contractHash,
    ...(mandateHash ? { mandateHash } : {}),
    decision: Object.freeze(decision),
    executed,
    ...(effectHash ? { effectHash } : {}),
  });
}
