#!/usr/bin/env node
/**
 * Stdio JSON-RPC loop. Load contract from WHOLESTACK_AUTHORITY_CONTRACT.
 * Does not write the filesystem unless the host process wires execute.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parseAppContract } from '@wholestack/app-contract';

import { issueMcpCodingLease } from './coding-lease.js';
import { handleJsonRpc, type AuthorityMcpContext, type JsonRpcRequest } from './jsonrpc.js';
import type { ToolCall } from './mediate.js';
import { createWorkspaceExecutor } from './workspace-executor.js';

export interface StdioStreams {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
}

export interface ServerOptions {
  contractPath?: string;
  workspaceRoot?: string;
  actorId?: string;
  roles?: string[];
  tenantId?: string;
  mediateOnly?: boolean;
  live?: boolean;
  execute?: (tool: ToolCall) => unknown;
}

export function parseServerArgs(argv: string[]): ServerOptions {
  const options: ServerOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--contract' || arg === '-c') {
      options.contractPath = argv[++i];
    } else if (arg === '--workspace' || arg === '-w') {
      options.workspaceRoot = argv[++i];
    } else if (arg === '--role' || arg === '-r') {
      const roleArg = argv[++i];
      if (roleArg) {
        options.roles = roleArg.split(',').map((r) => r.trim()).filter(Boolean);
      }
    } else if (arg === '--actor' || arg === '-a') {
      options.actorId = argv[++i];
    } else if (arg === '--tenant') {
      options.tenantId = argv[++i];
    } else if (arg === '--mediate-only' || arg === '--dry-run') {
      options.mediateOnly = true;
    } else if (arg === '--live') {
      options.live = true;
    }
  }
  return options;
}

export function defaultHostExecute(tool: ToolCall): never {
  throw new Error(
    `No host executor wired for ${tool.name}. Mediation held; this server does not open a second filesystem.`,
  );
}

export function loadAuthorityMcpContext(options?: ServerOptions): AuthorityMcpContext {
  const path = options?.contractPath ?? process.env.WHOLESTACK_AUTHORITY_CONTRACT;
  if (!path) {
    throw new Error('WHOLESTACK_AUTHORITY_CONTRACT must point at a sealed .isl file');
  }
  const parsed = parseAppContract(readFileSync(path, 'utf8'));
  if (!parsed.ok || !parsed.contract) {
    throw new Error(parsed.diagnostics.map((d) => d.message).join('; ') || 'ISL parse failed');
  }
  const roles =
    options?.roles && options.roles.length > 0
      ? options.roles
      : (process.env.WHOLESTACK_AUTHORITY_ACTOR_ROLES ?? 'implementer')
          .split(',')
          .map((role) => role.trim())
          .filter(Boolean);
  const actorId = options?.actorId ?? process.env.WHOLESTACK_AUTHORITY_ACTOR_ID ?? 'mcp-actor';
  const tenantId = options?.tenantId ?? process.env.WHOLESTACK_AUTHORITY_TENANT_ID ?? 'factory';
  const hosted = issueMcpCodingLease({
    contract: parsed.contract,
    actorId,
    role: roles[0] ?? 'implementer',
    tenantId,
    startedAt: new Date().toISOString(),
    expiresAt:
      process.env.WHOLESTACK_AUTHORITY_LEASE_EXPIRES_AT ??
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    sessionId: process.env.WHOLESTACK_AUTHORITY_LEASE_ID ?? `lease:${actorId}`,
  });

  const workspaceRoot = options?.workspaceRoot ?? process.env.WHOLESTACK_WORKSPACE_ROOT;
  let execute: (tool: ToolCall) => unknown;
  if (options?.execute) {
    execute = options.execute;
  } else if (options?.mediateOnly) {
    execute = defaultHostExecute;
  } else if (options?.live || workspaceRoot !== undefined || process.env.WHOLESTACK_AUTHORITY_LIVE === 'true') {
    execute = createWorkspaceExecutor({ workspaceRoot });
  } else {
    execute = defaultHostExecute;
  }

  return {
    contract: parsed.contract,
    actor: {
      id: actorId,
      roles: roles.length > 0 ? roles : ['implementer'],
      tenantId: hosted.actor.tenantId,
    },
    execute,
    graph: hosted.graph,
    lease: hosted.lease,
  };
}

function copyBuffer(value: Uint8Array): Buffer {
  const out = Buffer.alloc(value.length);
  out.set(value);
  return out;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return from;
  outer: for (let i = from; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function skipSpace(buffer: Buffer): Buffer {
  let offset = 0;
  while (
    offset < buffer.length &&
    (buffer[offset] === 0x20 || buffer[offset] === 0x09 || buffer[offset] === 0x0a || buffer[offset] === 0x0d)
  ) {
    offset += 1;
  }
  return offset === 0 ? buffer : copyBuffer(buffer.subarray(offset));
}

/**
 * Pull complete JSON-RPC payloads from a stdio buffer.
 * Supports MCP Content-Length framing and newline-delimited JSON.
 */
export function pullStdioMessages(buffer: Uint8Array): {
  messages: string[];
  rest: Buffer;
  usedFraming: boolean;
} {
  const messages: string[] = [];
  let rest = copyBuffer(buffer);
  let usedFraming = false;

  while (rest.length > 0) {
    rest = skipSpace(rest);
    if (rest.length === 0) {
      rest = Buffer.alloc(0);
      break;
    }

    const pulled = pullOne(rest);
    if (!pulled) break;
    rest = pulled.rest;
    if (pulled.skip) continue;
    messages.push(pulled.raw);
    if (pulled.framed) usedFraming = true;
  }

  return { messages, rest: copyBuffer(rest), usedFraming };
}

function pullOne(buffer: Buffer): { raw: string; rest: Buffer; framed: boolean; skip?: boolean } | null {
  if (buffer.length === 0) return null;

  if (buffer[0] === 0x7b) {
    const nl = buffer.indexOf(0x0a);
    if (nl === -1) return null;
    const raw = buffer.subarray(0, nl).toString('utf8').replace(/\r$/, '');
    return { raw, rest: copyBuffer(buffer.subarray(nl + 1)), framed: false };
  }

  const first = buffer[0];
  const maybeHeader = first === 0x43 || first === 0x63; // C or c
  if (!maybeHeader) {
    const nl = buffer.indexOf(0x0a);
    if (nl === -1) return null;
    return { raw: '', rest: copyBuffer(buffer.subarray(nl + 1)), framed: false, skip: true };
  }

  const crlf = indexOfBytes(buffer, Buffer.from('\r\n\r\n'));
  const lf = indexOfBytes(buffer, Buffer.from('\n\n'));
  let headerEnd = -1;
  let sep = 0;
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    headerEnd = crlf;
    sep = 4;
  } else if (lf !== -1) {
    headerEnd = lf;
    sep = 2;
  } else {
    return null;
  }

  const headers = buffer.subarray(0, headerEnd).toString('utf8');
  const match = /content-length:\s*(\d+)/i.exec(headers);
  if (!match) {
    return { raw: '', rest: copyBuffer(buffer.subarray(headerEnd + sep)), framed: true, skip: true };
  }
  const length = Number(match[1]);
  const bodyStart = headerEnd + sep;
  if (buffer.length < bodyStart + length) return null;
  const raw = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
  return { raw, rest: copyBuffer(buffer.subarray(bodyStart + length)), framed: true };
}

export function encodeStdioFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
  return copyBuffer(Buffer.concat([header, body]));
}

export function startStdioServer(
  ctx: AuthorityMcpContext = loadAuthorityMcpContext(),
  streams: StdioStreams = { stdin: process.stdin, stdout: process.stdout },
): void {
  let buffer: Uint8Array = new Uint8Array(0);
  let framedOut = false;

  const write = (payload: unknown) => {
    if (framedOut) {
      streams.stdout.write(encodeStdioFrame(payload));
    } else {
      streams.stdout.write(`${JSON.stringify(payload)}\n`);
    }
  };

  streams.stdin.on('data', (chunk: Buffer | string) => {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = copyBuffer(Buffer.concat([copyBuffer(buffer), piece]));
    const pulled = pullStdioMessages(buffer);
    buffer = pulled.rest;
    if (pulled.usedFraming) framedOut = true;
    for (const raw of pulled.messages) {
      if (!raw.trim()) continue;
      let request: unknown;
      try {
        request = JSON.parse(raw) as JsonRpcRequest;
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      try {
        const response = handleJsonRpc(request as JsonRpcRequest, ctx);
        if (response) write(response);
      } catch (error) {
        const id = (request as JsonRpcRequest).id ?? null;
        write({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  });
}

function isDirectServerEntry(): boolean {
  if (process.env.VITEST) return false;
  const entry = process.argv[1];
  if (!entry) return false;
  const normalized = entry.replace(/\\/g, '/');
  if (/(?:^|\/)vitest(?:\/|$)/i.test(normalized) || normalized.endsWith('/vitest')) return false;
  try {
    if (import.meta.url === pathToFileURL(realpathSync(entry)).href) return true;
  } catch {
    // argv[1] may be a missing path; fall through.
  }
  try {
    if (import.meta.url === pathToFileURL(entry).href) return true;
  } catch {
    // ignore invalid paths
  }
  return normalized.endsWith('server.js') || normalized.endsWith('server.ts');
}

if (isDirectServerEntry()) {
  const cliOptions = parseServerArgs(process.argv.slice(2));
  if (!cliOptions.mediateOnly) {
    cliOptions.live = true;
  }
  startStdioServer(loadAuthorityMcpContext(cliOptions));
}
