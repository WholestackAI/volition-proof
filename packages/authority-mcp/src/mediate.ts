/**
 * Thin MCP adapter around decideCommand.
 *
 * Honest scope: complete mediation only for tools this server exposes.
 * A client with a second ungoverned filesystem is out of contract.
 * Do not claim 100% mediation.
 */
import {
  buildCommandReceipt,
  decideCommand,
  mandateHashFromContract,
  verifyCapabilityLease,
  type AuthorityDecision,
  type AuthorityLookup,
  type CapabilityLease,
  type CapabilityLeaseGraph,
  type CommandEvidenceLedger,
  type CommandReceipt,
  type DecideCommandActor,
  type DecideCommandEvidence,
} from '@wholestack/authority';
import type { AppContract } from '@wholestack/app-contract';

export const MEDIATED_TOOLS = [
  'write_file',
  'edit_file',
  'read_file',
  'run_tests',
  'git_commit',
  'git_push',
] as const;

export type MediatedToolName = (typeof MEDIATED_TOOLS)[number];

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface MediateInput {
  contract: AppContract;
  actor: DecideCommandActor;
  tool: ToolCall;
  execute: (tool: ToolCall) => unknown;
  state?: Record<string, unknown>;
  evidence?: DecideCommandEvidence;
  /** Hash-bound lease. Required unless `requireLease` is false. */
  lease?: CapabilityLease;
  graph?: CapabilityLeaseGraph & AuthorityLookup;
  /** MCP live path defaults to true. In-process decideCommand stays lease-optional. */
  requireLease?: boolean;
  /** Append-only Volition command ledger. Not ShipGate. */
  ledger?: CommandEvidenceLedger;
}

export type MediateResult = AuthorityDecision & {
  executed: boolean;
  result?: unknown;
  executeError?: string;
  commandReceipt?: CommandReceipt;
};

function isMediated(name: string): name is MediatedToolName {
  return (MEDIATED_TOOLS as readonly string[]).includes(name);
}

function recordVote(
  input: MediateInput,
  decision: AuthorityDecision,
  extra?: { executed?: boolean; effect?: Record<string, unknown> },
): CommandReceipt {
  const receipt = buildCommandReceipt({
    actorId: input.actor.id,
    action: input.tool.name,
    args: input.tool.arguments,
    contractHash: input.contract.contractHash,
    mandateHash: mandateHashFromContract(input.contract),
    decision,
    executed: extra?.executed,
    effect: extra?.effect,
  });
  input.ledger?.append(receipt);
  return receipt;
}

export function mediateToolCall(input: MediateInput): MediateResult {
  if (!isMediated(input.tool.name)) {
    const decision: AuthorityDecision = {
      status: 'DENIED',
      allowed: false,
      code: 'UNLISTED_TOOL',
      clauseIds: [],
      reason: `DENIED UNLISTED_TOOL — ${input.tool.name} is not in the mediated set.`,
    };
    return { ...decision, executed: false, commandReceipt: recordVote(input, decision) };
  }

  const requireLease = input.requireLease !== false;
  let evidence = input.evidence;
  if (requireLease) {
    if (!input.lease || !input.graph) {
      const decision: AuthorityDecision = {
        status: 'DENIED',
        allowed: false,
        code: 'COMMAND_NOT_LEASED',
        clauseIds: [],
        reason: 'DENIED COMMAND_NOT_LEASED — MCP requires a capability lease.',
      };
      return { ...decision, executed: false, commandReceipt: recordVote(input, decision) };
    }
    const verified = verifyCapabilityLease({
      lease: input.lease,
      graph: input.graph,
      contractHash: input.contract.contractHash,
    });
    if (!verified.ok) {
      return {
        ...verified.decision,
        executed: false,
        commandReceipt: recordVote(input, verified.decision),
      };
    }
    evidence = { ...evidence, session: verified.session };
  }

  const decision = decideCommand({
    contract: input.contract,
    actor: input.actor,
    action: input.tool.name,
    args: input.tool.arguments,
    state: input.state,
    evidence,
    graph: input.graph,
  });

  if (!decision.allowed) {
    return { ...decision, executed: false, commandReceipt: recordVote(input, decision) };
  }

  try {
    const result = input.execute(input.tool);
    return {
      ...decision,
      executed: true,
      result,
      commandReceipt: recordVote(input, decision, {
        executed: true,
        effect: { result },
      }),
    };
  } catch (error) {
    const executeError = error instanceof Error ? error.message : String(error);
    return {
      ...decision,
      executed: false,
      executeError,
      commandReceipt: recordVote(input, decision, { effect: { executeError } }),
    };
  }
}
