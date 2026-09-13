/**
 * JSON-RPC 2.0 handler for the authority MCP surface.
 *
 * No extra npm deps. Complete mediation only for MEDIATED_TOOLS.
 * Host supplies `execute` — this module does not open a second filesystem.
 */
import { deriveAutonomy, projectMandate, type AppContract } from '@wholestack/app-contract';
import type {
  AuthorityLookup,
  CapabilityLease,
  CapabilityLeaseGraph,
  CommandEvidenceLedger,
  DecideCommandActor,
  DecideCommandEvidence,
} from '@wholestack/authority';

import { MEDIATED_TOOLS, mediateToolCall, type ToolCall } from './mediate.js';

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export interface AuthorityMcpContext {
  contract: AppContract;
  actor: DecideCommandActor;
  execute: (tool: ToolCall) => unknown;
  evidence?: DecideCommandEvidence;
  state?: Record<string, unknown>;
  lease?: CapabilityLease;
  graph?: CapabilityLeaseGraph & AuthorityLookup;
  requireLease?: boolean;
  ledger?: CommandEvidenceLedger;
}

const PROTOCOL = '2024-11-05';
const SERVER_INFO = { name: 'wholestack-authority-mcp', version: '0.0.0' } as const;

function rpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: '2.0' as const, id: id ?? null, result };
}

function rpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
) {
  return { jsonrpc: '2.0' as const, id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toolDescriptors() {
  return MEDIATED_TOOLS.map((name) => ({
    name,
    description: `Mediated ${name}. decideCommand votes before execute.`,
    inputSchema: { type: 'object', additionalProperties: true },
  }));
}

function isNotification(request: JsonRpcRequest, method: string): boolean {
  return request.id === undefined || method.startsWith('notifications/');
}

export function handleJsonRpc(request: JsonRpcRequest, ctx: AuthorityMcpContext) {
  const id = request.id;
  const method = request.method ?? '';

  if (isNotification(request, method)) {
    return null;
  }

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: PROTOCOL,
      serverInfo: { ...SERVER_INFO },
      capabilities: { tools: {} },
      autonomy: deriveAutonomy(projectMandate(ctx.contract)),
    });
  }

  if (method === 'tools/list' || method === 'list_tools') {
    return rpcResult(id, { tools: toolDescriptors() });
  }

  if (method === 'tools/call' || method === 'call_tool') {
    const params = asRecord(request.params);
    const name = typeof params.name === 'string' ? params.name : '';
    const rawArgs = asRecord(params.arguments ?? params.args);
    const evidenceArg = asRecord(params.evidence ?? params._evidence);
    const boundProposalHash =
      typeof params.boundProposalHash === 'string'
        ? params.boundProposalHash
        : typeof rawArgs.boundProposalHash === 'string'
          ? rawArgs.boundProposalHash
          : typeof rawArgs._boundProposalHash === 'string'
            ? rawArgs._boundProposalHash
            : undefined;

    const cleanArgs = { ...rawArgs };
    delete cleanArgs.boundProposalHash;
    delete cleanArgs._boundProposalHash;
    delete cleanArgs._evidence;

    const mergedEvidence: DecideCommandEvidence = {
      ...ctx.evidence,
      ...evidenceArg,
      ...(boundProposalHash ? { boundProposalHash } : {}),
    };

    const mediated = mediateToolCall({
      contract: ctx.contract,
      actor: ctx.actor,
      tool: { name, arguments: cleanArgs },
      execute: ctx.execute,
      evidence: mergedEvidence,
      state: ctx.state,
      lease: ctx.lease,
      graph: ctx.graph,
      requireLease: ctx.requireLease,
      ledger: ctx.ledger,
    });
    const decision = {
      status: mediated.status,
      code: mediated.code,
      allowed: mediated.allowed,
      clauseIds: mediated.clauseIds,
    };
    if (!mediated.allowed) {
      return rpcResult(id, {
        isError: true,
        content: [{ type: 'text', text: mediated.reason }],
        decision,
        commandReceipt: mediated.commandReceipt,
      });
    }
    if (mediated.executeError) {
      return rpcResult(id, {
        isError: true,
        content: [{ type: 'text', text: mediated.executeError }],
        decision,
        commandReceipt: mediated.commandReceipt,
      });
    }
    return rpcResult(id, {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(mediated.result ?? null) }],
      decision,
      commandReceipt: mediated.commandReceipt,
    });
  }

  return rpcError(id, -32601, `Unknown method ${method}`);
}
