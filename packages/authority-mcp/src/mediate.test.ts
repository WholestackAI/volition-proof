import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAppContract } from '@wholestack/app-contract';
import { describe, expect, it } from 'vitest';

import { MEDIATED_TOOLS, mediateToolCall } from './mediate.js';
import { issueMcpCodingLease } from './coding-lease.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/isl-specs/coding-agent-jurisdiction.isl',
);

function contract() {
  const parsed = parseAppContract(readFileSync(FIXTURE, 'utf8'));
  expect(parsed.ok).toBe(true);
  return parsed.contract!;
}

const actor = { id: 'dev-1', roles: ['implementer'] };

function hosted() {
  return issueMcpCodingLease({ contract: contract(), actorId: actor.id });
}

describe('authority-mcp', () => {
  it('exposes the six coding tools', () => {
    expect([...MEDIATED_TOOLS]).toEqual([
      'write_file',
      'edit_file',
      'read_file',
      'run_tests',
      'git_commit',
      'git_push',
    ]);
  });

  it('denies an unlisted tool without executing', () => {
    let ran = false;
    const result = mediateToolCall({
      contract: contract(),
      actor,
      tool: { name: 'delete_file', arguments: { path: 'packages/assigned/x.ts' } },
      execute: () => {
        ran = true;
        return 'deleted';
      },
    });
    expect(result.status).toBe('DENIED');
    expect(result.code).toBe('UNLISTED_TOOL');
    expect(result.executed).toBe(false);
    expect(ran).toBe(false);
  });

  it('does not mediate contract behaviors outside the listed tools', () => {
    let ran = false;
    const result = mediateToolCall({
      contract: contract(),
      actor: { id: 'fin-1', roles: ['finance'] },
      tool: { name: 'refund', arguments: { amount: 10 } },
      execute: () => {
        ran = true;
        return 'refunded';
      },
    });
    expect(result.code).toBe('UNLISTED_TOOL');
    expect(result.executed).toBe(false);
    expect(ran).toBe(false);
  });

  it('wraps write_file and executes only when GRANTED', () => {
    const host = hosted();
    let grantedRan = 0;
    const granted = mediateToolCall({
      contract: contract(),
      actor: host.actor,
      graph: host.graph,
      lease: host.lease,
      tool: {
        name: 'write_file',
        arguments: { path: 'packages/assigned/src/ok.ts', content: 'export {}\n' },
      },
      execute: () => {
        grantedRan += 1;
        return 'wrote';
      },
    });
    expect(granted.status).toBe('GRANTED');
    expect(granted.executed).toBe(true);
    expect(granted.result).toBe('wrote');
    expect(grantedRan).toBe(1);
    expect(granted.commandReceipt?.executed).toBe(true);
    expect(granted.commandReceipt?.decision.status).toBe('GRANTED');
    expect(granted.commandReceipt?.effectHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(granted.commandReceipt?.mandateHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    let deniedRan = 0;
    const denied = mediateToolCall({
      contract: contract(),
      actor: host.actor,
      graph: host.graph,
      lease: host.lease,
      tool: {
        name: 'write_file',
        arguments: { path: 'intent-lock.json', content: '{}' },
      },
      execute: () => {
        deniedRan += 1;
        return 'wrote';
      },
    });
    expect(denied.status).toBe('DENIED');
    expect(denied.code).toBe('LOCKED_PATH');
    expect(denied.executed).toBe(false);
    expect(deniedRan).toBe(0);
    expect(denied.commandReceipt?.executed).toBe(false);
    expect(denied.commandReceipt?.decision.code).toBe('LOCKED_PATH');
    expect(denied.commandReceipt?.effectHash).toBeUndefined();
  });

  it('refuses a listed tool without a lease', () => {
    let ran = false;
    const result = mediateToolCall({
      contract: contract(),
      actor,
      tool: {
        name: 'write_file',
        arguments: { path: 'packages/assigned/src/ok.ts', content: 'export {}\n' },
      },
      execute: () => {
        ran = true;
        return 'wrote';
      },
    });
    expect(result.code).toBe('COMMAND_NOT_LEASED');
    expect(result.executed).toBe(false);
    expect(ran).toBe(false);
  });

  it('refuses a listed tool outside the leased command set', () => {
    const sealed = contract();
    const host = issueMcpCodingLease({
      contract: sealed,
      actorId: actor.id,
      commands: ['read_file'],
      sessionId: 'lease-read-only',
    });
    let ran = false;
    const result = mediateToolCall({
      contract: sealed,
      actor: host.actor,
      graph: host.graph,
      lease: host.lease,
      tool: {
        name: 'write_file',
        arguments: { path: 'packages/assigned/src/ok.ts', content: 'export {}\n' },
      },
      execute: () => {
        ran = true;
        return 'wrote';
      },
    });
    expect(result.code).toBe('COMMAND_NOT_LEASED');
    expect(result.executed).toBe(false);
    expect(ran).toBe(false);
  });
});
