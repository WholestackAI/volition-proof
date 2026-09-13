import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { parseAppContract } from '@wholestack/app-contract';
import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultHostExecute,
  encodeStdioFrame,
  loadAuthorityMcpContext,
  parseServerArgs,
  pullStdioMessages,
  startStdioServer,
} from './server.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/isl-specs/coding-agent-jurisdiction.isl',
);

const ENV_KEYS = [
  'WHOLESTACK_AUTHORITY_CONTRACT',
  'WHOLESTACK_AUTHORITY_ACTOR_ID',
  'WHOLESTACK_AUTHORITY_ACTOR_ROLES',
] as const;

const envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = envSnapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function waitFor(stream: PassThrough): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for stdio output')), 1000);
    stream.once('data', (chunk: Buffer) => {
      clearTimeout(timer);
      resolve(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
  });
}

describe('authority-mcp stdio', () => {
  it('does not bind stdin when the package index is imported under vitest', async () => {
    const before = process.stdin.listenerCount('data');
    await import('./index.js');
    expect(process.stdin.listenerCount('data')).toBe(before);
  });

  it('loads actor identity from WHOLESTACK_AUTHORITY_ACTOR_*', () => {
    process.env.WHOLESTACK_AUTHORITY_CONTRACT = FIXTURE;
    process.env.WHOLESTACK_AUTHORITY_ACTOR_ID = 'agent-9';
    process.env.WHOLESTACK_AUTHORITY_ACTOR_ROLES = 'implementer, reviewer';
    const loaded = loadAuthorityMcpContext();
    expect(loaded.actor).toMatchObject({ id: 'agent-9', roles: ['implementer', 'reviewer'] });
    expect(loaded.lease?.sessionId).toBe('lease:agent-9');
    expect(loaded.graph?.getSession(loaded.lease!.sessionId)?.authorizedCommands).toEqual([
      'edit_file',
      'git_commit',
      'git_push',
      'read_file',
      'run_tests',
      'write_file',
    ]);
    expect(() => defaultHostExecute({ name: 'read_file', arguments: { path: 'x' } })).toThrow(
      /second filesystem/,
    );
    expect(() =>
      loaded.execute({ name: 'write_file', arguments: { path: 'packages/assigned/src/ok.ts' } }),
    ).toThrow(/second filesystem/);
  });

  it('fails closed without WHOLESTACK_AUTHORITY_CONTRACT', () => {
    delete process.env.WHOLESTACK_AUTHORITY_CONTRACT;
    expect(() => loadAuthorityMcpContext()).toThrow(/WHOLESTACK_AUTHORITY_CONTRACT/);
  });

  it('pulls Content-Length frames and newline JSON', () => {
    const framed = encodeStdioFrame({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const lined = Buffer.from('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n', 'utf8');
    const pulledFrame = pullStdioMessages(framed);
    expect(pulledFrame.usedFraming).toBe(true);
    expect(JSON.parse(pulledFrame.messages[0]!)).toMatchObject({ method: 'initialize', id: 1 });
    const pulledLine = pullStdioMessages(lined);
    expect(pulledLine.usedFraming).toBe(false);
    expect(JSON.parse(pulledLine.messages[0]!)).toMatchObject({ method: 'tools/list', id: 2 });
  });

  it('answers initialize over Content-Length stdio', async () => {
    const parsed = parseAppContract(readFileSync(FIXTURE, 'utf8'));
    expect(parsed.ok).toBe(true);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    startStdioServer(
      {
        contract: parsed.contract!,
        actor: { id: 'dev-1', roles: ['implementer'] },
        execute: () => 'nope',
      },
      { stdin, stdout },
    );
    const pending = waitFor(stdout);
    stdin.write(
      encodeStdioFrame({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    );
    const chunk = await pending;
    expect(chunk.toString('utf8')).toMatch(/^Content-Length:\s+\d+\r\n\r\n/);
    const pulled = pullStdioMessages(chunk);
    expect(JSON.parse(pulled.messages[0]!)).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'wholestack-authority-mcp' },
      },
    });
  });

  it('parseServerArgs parses command line arguments accurately', () => {
    const parsed = parseServerArgs([
      '--contract',
      'foo.isl',
      '-w',
      '/path/to/ws',
      '--role',
      'owner,implementer',
      '--actor',
      'agent-custom',
      '--tenant',
      'tenant-99',
      '--live',
    ]);
    expect(parsed).toEqual({
      contractPath: 'foo.isl',
      workspaceRoot: '/path/to/ws',
      roles: ['owner', 'implementer'],
      actorId: 'agent-custom',
      tenantId: 'tenant-99',
      live: true,
    });
  });

  it('loadAuthorityMcpContext wires live workspace executor when workspaceRoot is specified', () => {
    const loaded = loadAuthorityMcpContext({
      contractPath: FIXTURE,
      workspaceRoot: '/tmp',
      actorId: 'test-agent',
      roles: ['implementer'],
      live: true,
    });
    expect(loaded.actor.id).toBe('test-agent');
    expect(loaded.execute).not.toBe(defaultHostExecute);
  });
});
