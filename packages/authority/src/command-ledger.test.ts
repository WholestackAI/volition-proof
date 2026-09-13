import { describe, expect, it } from 'vitest';

import { CommandEvidenceLedger } from './command-ledger.js';
import { buildCommandReceipt, type BuildCommandReceiptInput } from './command-receipt.js';
import type { AuthorityDecision } from './decide-command.js';

const CONTRACT_HASH = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function granted(): AuthorityDecision {
  return {
    status: 'GRANTED',
    allowed: true,
    code: 'GRANTED',
    clauseIds: ['behavior:write_file'],
    reason: 'All applicable clauses held.',
  };
}

function denied(): AuthorityDecision {
  return {
    status: 'DENIED',
    allowed: false,
    code: 'ROLE_DENIED',
    clauseIds: ['behavior-security:refund:role'],
    reason: 'DENIED — actor roles miss required role finance.',
  };
}

function receipt(overrides: Partial<BuildCommandReceiptInput> = {}) {
  return buildCommandReceipt({
    actorId: 'dev-1',
    action: 'write_file',
    args: { path: 'ok.ts' },
    contractHash: CONTRACT_HASH,
    decision: granted(),
    at: '2026-09-11T18:00:00.000Z',
    ...overrides,
  });
}

describe('CommandEvidenceLedger', () => {
  it('appends vote then executed effect in order', () => {
    const ledger = new CommandEvidenceLedger();
    const vote = receipt({ executed: false });
    const ran = receipt({
      executed: true,
      effect: { result: 'wrote' },
    });
    ledger.append(vote);
    ledger.append(ran);
    expect(ledger.records()).toEqual([vote, ran]);
    expect(ran.executed).toBe(true);
    expect(ran.effectHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(vote.receiptId).not.toBe(ran.receiptId);
  });

  it('is idempotent for the same receiptId', () => {
    const ledger = new CommandEvidenceLedger();
    const first = receipt();
    ledger.append(first);
    ledger.append(receipt());
    expect(ledger.records()).toHaveLength(1);
  });

  it('refuses a rewritten receipt with the same id', () => {
    const ledger = new CommandEvidenceLedger();
    const vote = receipt({ executed: false });
    ledger.append(vote);
    expect(() =>
      ledger.append({
        ...vote,
        executed: true,
      }),
    ).toThrow(/different content/);
  });

  it('refuses a receipt that smuggles SHIP', () => {
    const ledger = new CommandEvidenceLedger();
    const vote = receipt({ decision: denied() });
    expect(() =>
      ledger.append({
        ...vote,
        action: 'SHIP',
      }),
    ).toThrow(/SHIP/);
  });
});
