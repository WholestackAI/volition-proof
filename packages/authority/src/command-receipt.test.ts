import { describe, expect, it } from 'vitest';

import {
  buildCommandReceipt,
  hashCommandCanonical,
  mandateHashFromContract,
  type BuildCommandReceiptInput,
} from './command-receipt.js';
import type { AuthorityDecision } from './decide-command.js';

const FROZEN_AT = '2026-09-11T14:20:00.000Z';
const CONTRACT_HASH = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function granted(extra: Partial<AuthorityDecision> = {}): AuthorityDecision {
  return {
    status: 'GRANTED',
    allowed: true,
    code: 'GRANTED',
    clauseIds: ['behavior:write_file', 'behavior-security:write_file:role'],
    reason: 'All applicable clauses held.',
    ...extra,
  };
}

function denied(extra: Partial<AuthorityDecision> = {}): AuthorityDecision {
  return {
    status: 'DENIED',
    allowed: false,
    code: 'ROLE_DENIED',
    clauseIds: ['behavior-security:refund:role'],
    reason: 'DENIED — actor roles miss required role finance.',
    ...extra,
  };
}

function baseInput(overrides: Partial<BuildCommandReceiptInput> = {}): BuildCommandReceiptInput {
  return {
    actorId: 'dev-1',
    action: 'write_file',
    args: { path: 'packages/assigned/src/ok.ts', content: 'export const ok = true;\n' },
    contractHash: CONTRACT_HASH,
    decision: granted(),
    at: FROZEN_AT,
    ...overrides,
  };
}

describe('buildCommandReceipt', () => {
  it('hashes the same args to the same argsHash regardless of key order', () => {
    const left = buildCommandReceipt(
      baseInput({ args: { path: 'a.ts', content: 'x' } }),
    );
    const right = buildCommandReceipt(
      baseInput({ args: { content: 'x', path: 'a.ts' } }),
    );
    expect(left.argsHash).toBe(right.argsHash);
    expect(left.argsHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('changes argsHash when args change', () => {
    const left = buildCommandReceipt(baseInput({ args: { amount: 50 } }));
    const right = buildCommandReceipt(baseInput({ args: { amount: 51 } }));
    expect(left.argsHash).not.toBe(right.argsHash);
  });

  it('keeps receiptId stable when only `at` changes', () => {
    const left = buildCommandReceipt(baseInput({ at: FROZEN_AT }));
    const right = buildCommandReceipt(baseInput({ at: '2026-09-11T14:21:00.000Z' }));
    expect(left.receiptId).toBe(right.receiptId);
    expect(left.at).toBe(FROZEN_AT);
    expect(right.at).toBe('2026-09-11T14:21:00.000Z');
  });

  it('records the decideCommand vote slice, not a ShipGate verdict', () => {
    const receipt = buildCommandReceipt(baseInput());
    expect(receipt.decision).toEqual({
      status: 'GRANTED',
      code: 'GRANTED',
      clauseIds: ['behavior:write_file', 'behavior-security:write_file:role'],
      allowed: true,
    });
    expect(receipt).not.toHaveProperty('SHIP');
    expect(JSON.stringify(receipt)).not.toMatch(/\bSHIP\b/);
    expect(receipt.contractHash).toBe(CONTRACT_HASH);
    expect(receipt.actorId).toBe('dev-1');
    expect(receipt.action).toBe('write_file');
  });

  it('forces executed false on DENIED even when the caller claims execution', () => {
    const receipt = buildCommandReceipt(
      baseInput({
        action: 'refund',
        args: { amount: 50 },
        decision: denied(),
        executed: true,
      }),
    );
    expect(receipt.decision.status).toBe('DENIED');
    expect(receipt.decision.allowed).toBe(false);
    expect(receipt.executed).toBe(false);
  });

  it('forces executed false on ESCALATION_REQUIRED', () => {
    const receipt = buildCommandReceipt(
      baseInput({
        decision: {
          status: 'ESCALATION_REQUIRED',
          allowed: false,
          code: 'APPROVAL_REQUIRED',
          clauseIds: ['behavior-security:refund:approval'],
        },
        executed: true,
      }),
    );
    expect(receipt.executed).toBe(false);
  });

  it('defaults GRANTED receipts to executed false — the receipt does not execute', () => {
    const receipt = buildCommandReceipt(baseInput());
    expect(receipt.decision.status).toBe('GRANTED');
    expect(receipt.executed).toBe(false);
  });

  it('sets executed true on GRANTED only when the caller reports execution', () => {
    const proposed = buildCommandReceipt(baseInput({ executed: false }));
    const ran = buildCommandReceipt(baseInput({ executed: true }));
    expect(proposed.executed).toBe(false);
    expect(ran.executed).toBe(true);
    expect(proposed.receiptId).not.toBe(ran.receiptId);
    expect(proposed.argsHash).toBe(ran.argsHash);
  });

  it('freezes the receipt so callers cannot rewrite the vote', () => {
    const receipt = buildCommandReceipt(baseInput());
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.decision)).toBe(true);
    expect(() => {
      (receipt as { executed: boolean }).executed = true;
    }).toThrow();
  });

  it('hashes observed effect and binds it into receiptId', () => {
    const none = buildCommandReceipt(baseInput({ executed: true }));
    const left = buildCommandReceipt(
      baseInput({ executed: true, effect: { result: 'wrote' } }),
    );
    const right = buildCommandReceipt(
      baseInput({ executed: true, effect: { result: 'wrote' } }),
    );
    const other = buildCommandReceipt(
      baseInput({ executed: true, effect: { result: 'other' } }),
    );
    expect(none.effectHash).toBeUndefined();
    expect(left.effectHash).toBe(hashCommandCanonical({ result: 'wrote' }));
    expect(left.effectHash).toBe(right.effectHash);
    expect(left.receiptId).toBe(right.receiptId);
    expect(left.receiptId).not.toBe(none.receiptId);
    expect(left.receiptId).not.toBe(other.receiptId);
  });

  it('binds an explicit mandate hash into receiptId', () => {
    const none = buildCommandReceipt(baseInput());
    const bound = buildCommandReceipt(
      baseInput({ mandateHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
    );
    expect(bound.mandateHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(bound.receiptId).not.toBe(none.receiptId);
    expect(typeof mandateHashFromContract).toBe('function');
  });
});
