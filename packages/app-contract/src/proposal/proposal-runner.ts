/**
 * Volition CAS Atomic Proposal Runner.
 *
 * Implements the atomic Compare-And-Swap proposal pattern for contract patches.
 *
 * Proposals are immutable intent bundles formed against a base contract hash:
 * - CAS verification ensures concurrent changes are detected and refused fail-closed.
 * - Dry-runs execute in-memory against AST clones with full syntax and impact diffs.
 * - Commit is all-or-nothing: either all ops apply cleanly or the contract remains untouched.
 */

import { z } from 'zod';
import { sha256Hex } from '../canonical/hash.js';
import type { AppContract } from '../canonical/types.js';
import { applyPatch, type ApplyOptions, type ApplyResult } from '../patch/apply.js';
import { ContractOpSchema } from '../patch/op-schema.js';
import type { ContractOp, SemanticPatch } from '../patch/ops.js';

export const ProposalStatusSchema = z.enum([
  'proposed',
  'accepted',
  'rejected',
  'expired',
  'cancelled',
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const ProposalSourceSchema = z.enum([
  'user',
  'voice',
  'text-harness',
  'zeta-proposal',
  'system',
]);
export type ProposalSource = z.infer<typeof ProposalSourceSchema>;

export const ContractProposalSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  summary: z.string().max(1000).optional(),
  source: ProposalSourceSchema.default('system'),
  status: ProposalStatusSchema,
  baseDocumentHash: z.string().min(1),
  ops: z.array(ContractOpSchema).min(1).max(40),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string().optional(),
  contentHash: z.string(),
});
export type ContractProposal = z.infer<typeof ContractProposalSchema>;

export function hashProposalBody(body: Omit<ContractProposal, 'contentHash'>): string {
  return sha256Hex(JSON.stringify(body, Object.keys(body).sort()));
}

export interface CreateProposalInput {
  id?: string;
  title: string;
  summary?: string;
  source?: ProposalSource;
  baseContract: AppContract;
  ops: readonly ContractOp[];
  expiresAt?: string;
  now?: string;
}

/** Helper to create a new proposal bound to a base contract hash. */
export function createContractProposal(input: CreateProposalInput): ContractProposal {
  const now = input.now ?? new Date().toISOString();
  const id = input.id ?? `prop_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  const draft: Omit<ContractProposal, 'contentHash'> = {
    id,
    title: input.title,
    summary: input.summary,
    source: input.source ?? 'system',
    status: 'proposed',
    baseDocumentHash: input.baseContract.contractHash,
    ops: [...input.ops] as ContractOp[],
    createdAt: now,
    updatedAt: now,
    expiresAt: input.expiresAt,
  };
  const contentHash = hashProposalBody(draft);
  return ContractProposalSchema.parse({ ...draft, contentHash });
}

function toSemanticPatch(proposal: ContractProposal): SemanticPatch {
  return {
    id: proposal.id,
    title: proposal.title,
    rationale: proposal.summary,
    origin: proposal.source === 'user' ? 'user' : 'system',
    ops: [...proposal.ops],
  };
}

/** Previews a proposal without mutating or requiring CAS verification. */
export function dryRunProposal(
  contract: AppContract,
  proposal: ContractProposal,
  options?: ApplyOptions,
): ApplyResult {
  return applyPatch(contract, toSemanticPatch(proposal), options);
}

export type CommitProposalResult =
  | {
      ok: true;
      contract: AppContract;
      proposal: ContractProposal;
      diff: Extract<ApplyResult, { ok: true }>['diff'];
      impact: Extract<ApplyResult, { ok: true }>['impact'];
    }
  | {
      ok: false;
      reason: 'cas-mismatch' | 'invalid-status' | 'expired' | 'invalid-op' | 'unparseable' | 'locked';
      message: string;
      detail?: string;
      lockViolations?: string[];
      proposal?: ContractProposal;
    };

/**
 * Commits a proposal atomically with CAS enforcement.
 *
 * Refuses if:
 * 1. The proposal is not in `proposed` status.
 * 2. The proposal has passed its expiry time.
 * 3. The base contract's contractHash does not match `baseDocumentHash` (concurrent modification).
 * 4. Patch application fails (syntax, locked clause, semantic violation).
 */
export function commitProposal(
  contract: AppContract,
  proposal: ContractProposal,
  options?: ApplyOptions & { now?: string },
): CommitProposalResult {
  if (proposal.status !== 'proposed') {
    return {
      ok: false,
      reason: 'invalid-status',
      message: `Proposal ${proposal.id} is in '${proposal.status}' state; only 'proposed' can be committed.`,
      proposal,
    };
  }

  const nowMs = Date.parse(options?.now ?? new Date().toISOString());
  if (proposal.expiresAt && Date.parse(proposal.expiresAt) <= nowMs) {
    const expiredProposal: ContractProposal = {
      ...proposal,
      status: 'expired',
      updatedAt: options?.now ?? new Date().toISOString(),
    };
    return {
      ok: false,
      reason: 'expired',
      message: `Proposal ${proposal.id} has expired.`,
      proposal: expiredProposal,
    };
  }

  if (proposal.baseDocumentHash !== contract.contractHash) {
    return {
      ok: false,
      reason: 'cas-mismatch',
      message: `CAS base mismatch: proposal expected ${proposal.baseDocumentHash}, but contract hash is ${contract.contractHash}.`,
      proposal,
    };
  }

  const applyResult = applyPatch(contract, toSemanticPatch(proposal), options);
  if (!applyResult.ok) {
    return {
      ok: false,
      reason: applyResult.reason,
      message: applyResult.message,
      detail: applyResult.detail,
      lockViolations: applyResult.lockViolations,
      proposal,
    };
  }

  const now = options?.now ?? new Date().toISOString();
  const acceptedDraft: Omit<ContractProposal, 'contentHash'> = {
    ...proposal,
    status: 'accepted',
    updatedAt: now,
  };
  const acceptedProposal = ContractProposalSchema.parse({
    ...acceptedDraft,
    contentHash: hashProposalBody(acceptedDraft),
  });

  return {
    ok: true,
    contract: applyResult.contract,
    proposal: acceptedProposal,
    diff: applyResult.diff,
    impact: applyResult.impact,
  };
}

/** Rejects a proposal with an optional explanation. */
export function rejectProposal(
  proposal: ContractProposal,
  reason?: string,
  now?: string,
): ContractProposal {
  const timestamp = now ?? new Date().toISOString();
  const updatedSummary = reason
    ? `${proposal.summary ? proposal.summary + ' — ' : ''}Rejected: ${reason}`
    : proposal.summary;
  const draft: Omit<ContractProposal, 'contentHash'> = {
    ...proposal,
    status: 'rejected',
    summary: updatedSummary,
    updatedAt: timestamp,
  };
  return ContractProposalSchema.parse({
    ...draft,
    contentHash: hashProposalBody(draft),
  });
}
