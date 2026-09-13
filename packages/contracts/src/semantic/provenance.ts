import { z } from 'zod';
import { ContentHashSchema } from '../common.js';

export const ProvenanceKindSchema = z.enum([
  'source_clause',
  'registry_rule',
  'product_decision',
  'assumption',
  'derived_obligation',
  'legacy_alias',
  'system',
]);

export const ProvenanceRefSchema = z
  .object({
    kind: ProvenanceKindSchema,
    refId: z.string().min(1),
    version: z.string().min(1).optional(),
    contentHash: ContentHashSchema.optional(),
    rationale: z.string().min(1),
  })
  .strict();

export type ProvenanceKind = z.infer<typeof ProvenanceKindSchema>;
export type ProvenanceRef = z.infer<typeof ProvenanceRefSchema>;

export const POSITIVE_NOT_APPLICABLE_PROVENANCE_KINDS = Object.freeze([
  'registry_rule',
  'product_decision',
] as const);

export function hasPositiveNotApplicableProvenance(provenance: readonly ProvenanceRef[]): boolean {
  return provenance.some(
    (reference) => reference.kind === 'registry_rule' || reference.kind === 'product_decision',
  );
}
