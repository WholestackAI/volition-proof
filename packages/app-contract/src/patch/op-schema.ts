/**
 * Runtime schema for contract operations.
 *
 * This is the wire contract for every untrusted producer of a patch — a model
 * answering a natural-language command, an agent calling the HTTP API, a CLI
 * argument. TypeScript types vanish at runtime; this does not.
 *
 * Rejecting here is the difference between "the model proposed something
 * invalid" and "the model wrote something invalid into the project".
 */

import { z } from 'zod';

const entityName = z
  .string()
  .regex(/^[A-Z][A-Za-z0-9]*$/, 'must be a record type name like Estimate');
const fieldName = z.string().regex(/^[a-z][A-Za-z0-9]*$/, 'must be a field name like amountCents');
const roleName = z.string().regex(/^[a-z][a-z0-9_]*$/, 'must be a role name like sales_rep');
const statusName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be a status like PENDING_APPROVAL');
const islText = z.string().min(1).max(8000);

export const ContractOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add-entity'), isl: islText }),
  z.object({ op: z.literal('remove-entity'), entity: entityName }),
  z.object({ op: z.literal('add-field'), entity: entityName, isl: islText }),
  z.object({ op: z.literal('remove-field'), entity: entityName, field: fieldName }),
  z.object({ op: z.literal('add-role'), role: roleName }),
  z.object({ op: z.literal('remove-role'), role: roleName }),
  z.object({
    op: z.literal('set-permission'),
    entity: entityName,
    action: z.enum(['read', 'write', 'delete']),
    roles: z.array(roleName).max(12).default([]),
    owner: z.boolean().optional(),
    related: z.array(fieldName).max(8).optional(),
  }),
  z.object({
    op: z.literal('remove-permission'),
    entity: entityName,
    action: z.enum(['read', 'write', 'delete']),
  }),
  z.object({
    op: z.literal('add-status'),
    entity: entityName,
    field: fieldName,
    status: statusName,
    after: statusName.optional(),
  }),
  z.object({
    op: z.literal('set-terminal'),
    entity: entityName,
    field: fieldName,
    statuses: z.array(statusName).min(1),
  }),
  z.object({
    op: z.literal('add-transition'),
    entity: entityName,
    from: statusName,
    to: statusName,
  }),
  z.object({
    op: z.literal('remove-transition'),
    entity: entityName,
    from: statusName,
    to: statusName,
  }),
  z.object({ op: z.literal('add-precondition'), behavior: z.string().min(1), expression: islText }),
  z.object({
    op: z.literal('remove-precondition'),
    behavior: z.string().min(1),
    expression: islText,
  }),
  z.object({ op: z.literal('add-behavior'), isl: islText }),
  z.object({ op: z.literal('remove-behavior'), behavior: z.string().min(1) }),
  z.object({
    op: z.literal('set-behavior-role'),
    behavior: z.string().min(1),
    role: roleName.nullable(),
  }),
  z.object({ op: z.literal('add-invariant'), isl: islText }),
  z.object({ op: z.literal('remove-invariant'), invariant: z.string().min(1) }),
  z.object({ op: z.literal('set-app-description'), description: z.string().min(1).max(400) }),
]);

export const SemanticPatchSchema = z.object({
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  rationale: z.string().max(1000).optional(),
  originalText: z.string().max(4000).optional(),
  origin: z.enum(['user', 'inferred', 'template', 'imported', 'system']),
  ops: z.array(ContractOpSchema).min(1).max(40),
});

/** Model output for a natural-language change request. Title and ops only. */
export const PatchProposalSchema = z.object({
  title: z.string().min(1).max(200),
  rationale: z.string().max(1000).default(''),
  ops: z.array(ContractOpSchema).min(1).max(40),
});
export type PatchProposal = z.infer<typeof PatchProposalSchema>;

export type PatchValidation =
  { ok: true; proposal: PatchProposal } | { ok: false; errors: string[] };

export function validatePatchProposal(raw: unknown): PatchValidation {
  const parsed = PatchProposalSchema.safeParse(raw);
  if (parsed.success) return { ok: true, proposal: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}
