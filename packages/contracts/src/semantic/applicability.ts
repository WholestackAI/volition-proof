import { z } from 'zod';
import { ObligationCriticalitySchema } from './lifecycle.js';
import {
  hasPositiveNotApplicableProvenance,
  ProvenanceRefSchema,
  type ProvenanceRef,
} from './provenance.js';

export const ApplicabilitySchema = z.enum(['applicable', 'not_applicable', 'unresolved']);
export type Applicability = z.infer<typeof ApplicabilitySchema>;

const RequirementSlotSpecifiedSchema = z
  .object({
    status: z.literal('specified'),
    value: z.unknown(),
    provenance: z.array(ProvenanceRefSchema).min(1),
    obligationIds: z.array(z.string().min(1)),
  })
  .strict()
  .refine((slot) => Object.prototype.hasOwnProperty.call(slot, 'value'), {
    message: 'specified requirement slot must contain value',
  });

const RequirementSlotNotApplicableSchema = z
  .object({
    status: z.literal('not_applicable'),
    rationale: z.string().trim().min(1),
    provenance: z.array(ProvenanceRefSchema).min(1),
    obligationIds: z.array(z.string().min(1)),
  })
  .strict()
  .refine((slot) => hasPositiveNotApplicableProvenance(slot.provenance), {
    message:
      'not_applicable requires positive provenance from a registry rule or approved product decision',
    path: ['provenance'],
  });

const RequirementSlotUnresolvedSchema = z
  .object({
    status: z.literal('unresolved'),
    questionId: z.string().min(1),
    criticality: ObligationCriticalitySchema,
    provenance: z.array(ProvenanceRefSchema).min(1),
    obligationIds: z.array(z.string().min(1)),
  })
  .strict();

export const RequirementSlotSchema = z.union([
  RequirementSlotSpecifiedSchema,
  RequirementSlotNotApplicableSchema,
  RequirementSlotUnresolvedSchema,
]);

export type RequirementSlot<T = unknown> =
  | {
      status: 'specified';
      value: T;
      provenance: ProvenanceRef[];
      obligationIds: string[];
    }
  | z.infer<typeof RequirementSlotNotApplicableSchema>
  | z.infer<typeof RequirementSlotUnresolvedSchema>;

export function requirementSlotSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.union([
    z
      .object({
        status: z.literal('specified'),
        value: valueSchema,
        provenance: z.array(ProvenanceRefSchema).min(1),
        obligationIds: z.array(z.string().min(1)),
      })
      .strict(),
    RequirementSlotNotApplicableSchema,
    RequirementSlotUnresolvedSchema,
  ]);
}
