import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAppContract } from '@wholestack/app-contract';
import { describe, expect, it } from 'vitest';

import { handleJsonRpc } from './jsonrpc.js';
import { MEDIATED_TOOLS } from './mediate.js';
import { issueMcpCodingLease } from './coding-lease.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/isl-specs/coding-agent-jurisdiction.isl',
);

function ctx(execute: (tool: { name: string; arguments: Record<string, unknown> }) => unknown) {
  const parsed = parseAppContract(readFileSync(FIXTURE, 'utf8'));
  expect(parsed.ok).toBe(true);
  const host = issueMcpCodingLease({ contract: parsed.contract!, actorId: 'dev-1' });
  return {
    contract: parsed.contract!,
    actor: host.actor,
    execute,
    graph: host.graph,
    lease: host.lease,
  };
}

describe('authority-mcp JSON-RPC', () => {
  it('completes the initialize handshake', () => {
    const response = handleJsonRpc(
      {
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-host', version: '0.0.0' },
        },
      },
      ctx(() => null),
    );
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 0,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'wholestack-authority-mcp', version: '0.0.0' },
        capabilities: { tools: {} },
        autonomy: {
          level: 'A3',
          reason: 'Ungated behaviors exist and preconditions bound them.',
        },
      },
    });
    expect(handleJsonRpc({ method: 'notifications/initialized' }, ctx(() => null))).toBeNull();
  });

  it('returns null for notifications', () => {
    const context = ctx(() => {
      throw new Error('notifications must not execute');
    });
    expect(handleJsonRpc({ method: 'notifications/initialized' }, context)).toBeNull();
    expect(handleJsonRpc({ method: 'notifications/cancelled' }, context)).toBeNull();
    expect(handleJsonRpc({ jsonrpc: '2.0', method: 'notifications/progress' }, context)).toBeNull();
  });

  it('lists the six mediated tools', () => {
    const listed = handleJsonRpc({ id: 1, method: 'tools/list' }, ctx(() => null));
    expect(listed).toMatchObject({ jsonrpc: '2.0', id: 1 });
    const tools = (listed as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual([...MEDIATED_TOOLS]);
  });

  it('refuses an unlisted tool without executing', () => {
    let ran = false;
    const response = handleJsonRpc(
      { id: 2, method: 'tools/call', params: { name: 'delete_file', arguments: { path: 'x' } } },
      ctx(() => {
        ran = true;
        return 'deleted';
      }),
    );
    expect(ran).toBe(false);
    expect(response).toMatchObject({
      result: {
        isError: true,
        decision: { allowed: false, code: 'UNLISTED_TOOL' },
      },
    });
  });

  it('wraps write_file through decideCommand', () => {
    let grantedRan = 0;
    const granted = handleJsonRpc(
      {
        id: 3,
        method: 'tools/call',
        params: {
          name: 'write_file',
          arguments: { path: 'packages/assigned/src/ok.ts', content: 'export {}\n' },
        },
      },
      ctx(() => {
        grantedRan += 1;
        return 'wrote';
      }),
    );
    expect(grantedRan).toBe(1);
    expect(granted).toMatchObject({
      result: { isError: false, decision: { allowed: true, status: 'GRANTED' } },
    });
    expect(
      (granted as { result: { commandReceipt?: { executed?: boolean } } }).result.commandReceipt
        ?.executed,
    ).toBe(true);

    let lockedRan = 0;
    const locked = handleJsonRpc(
      {
        id: 4,
        method: 'tools/call',
        params: { name: 'write_file', arguments: { path: 'intent-lock.json', content: '{}' } },
      },
      ctx(() => {
        lockedRan += 1;
        return 'wrote';
      }),
    );
    expect(lockedRan).toBe(0);
    expect(locked).toMatchObject({
      result: { isError: true, decision: { allowed: false, code: 'LOCKED_PATH' } },
    });
  });

  it('does not execute a tools/call sent as a JSON-RPC notification', () => {
    let ran = false;
    const response = handleJsonRpc(
      {
        method: 'tools/call',
        params: {
          name: 'write_file',
          arguments: { path: 'packages/assigned/src/ok.ts', content: 'export {}\n' },
        },
      },
      ctx(() => {
        ran = true;
        return 'wrote';
      }),
    );
    expect(response).toBeNull();
    expect(ran).toBe(false);
  });

  it('escalates on approval-required action and grants when boundProposalHash is supplied', () => {
    let pushed = false;
    const escalated = handleJsonRpc(
      {
        id: 5,
        method: 'tools/call',
        params: {
          name: 'git_push',
          arguments: { ref: 'feature-branch' },
        },
      },
      ctx(() => {
        pushed = true;
        return 'pushed';
      }),
    );
    expect(pushed).toBe(false);
    expect(escalated).toMatchObject({
      result: {
        isError: true,
        decision: { status: 'ESCALATION_REQUIRED', code: 'APPROVAL_REQUIRED', allowed: false },
      },
    });

    const granted = handleJsonRpc(
      {
        id: 6,
        method: 'tools/call',
        params: {
          name: 'git_push',
          arguments: { ref: 'feature-branch' },
          boundProposalHash: 'approval-token-123',
        },
      },
      ctx(() => {
        pushed = true;
        return 'pushed';
      }),
    );
    expect(pushed).toBe(true);
    expect(granted).toMatchObject({
      result: {
        isError: false,
        decision: { status: 'GRANTED', allowed: true },
      },
    });
  });
});
