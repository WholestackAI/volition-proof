import { z } from 'zod';
import { ContentHashSchema, selfExcludingHash } from '../common.js';
import { GenomeFamilyIdSchema } from './application-families.js';
import { ApplicabilitySchema } from './applicability.js';
import { ArtifactLifecycleStateSchema, ObligationCriticalitySchema } from './lifecycle.js';

export const DerivationRecordSchema = z
  .object({
    sourceClauseIds: z.array(z.string().min(1)).min(1),
    parentObligationIds: z.array(z.string().min(1)),
    registryRuleId: z.string().min(1),
    registryRuleVersion: z.string().min(1),
    triggerFacts: z.array(z.string().min(1)).min(1),
    rationale: z.string().min(1),
    fixedPointIteration: z.number().int().nonnegative(),
  })
  .strict();

export const ImplementationResponsibilitySchema = z
  .object({
    responsibilityId: z.string().min(1),
    layer: z.enum([
      'frontend',
      'backend',
      'database',
      'integration',
      'worker',
      'infrastructure',
      'operations',
      'cross_layer',
    ]),
    statement: z.string().min(1),
  })
  .strict();

export const ProofExpectationSchema = z
  .object({
    expectationId: z.string().min(1),
    targetBehavior: z.string().min(1),
    trigger: z.string().min(1),
    oracle: z.string().min(1),
    requiredPostconditions: z.array(z.string().min(1)).min(1),
    minimumCorpus: z.number().int().positive(),
    prohibitedMockBoundaries: z.array(z.string().min(1)),
    proofKind: z.enum([
      'unit',
      'property',
      'integration',
      'contract',
      'end_to_end',
      'security',
      'performance',
      'migration',
      'deployment',
      'runtime',
      'human_review',
    ]),
    requiredLifecyclePoint: ArtifactLifecycleStateSchema,
    mutantIds: z.array(z.string().min(1)),
    deploymentEvidenceRequired: z.boolean(),
    runtimeMonitorRequired: z.boolean(),
  })
  .strict();

export const NonVacuityRequirementSchema = z
  .object({
    requirementId: z.string().min(1),
    statement: z.string().min(1),
    minimumSubjects: z.number().int().positive(),
  })
  .strict();

export const RuntimeSignalRequirementSchema = z
  .object({
    requirementId: z.string().min(1),
    signal: z.string().min(1),
    condition: z.string().min(1),
  })
  .strict();

const ObligationObjectSchema = z
  .object({
    obligationId: z.string().min(1),
    familyId: GenomeFamilyIdSchema,
    title: z.string().min(1),
    normativeStatement: z.string().min(1),
    criticality: ObligationCriticalitySchema,
    lifecycleState: ArtifactLifecycleStateSchema,
    applicability: ApplicabilitySchema,
    sourceClauseIds: z.array(z.string().min(1)).min(1),
    derivation: DerivationRecordSchema,
    requiresHumanDecision: z.boolean(),
    decisionQuestionIds: z.array(z.string().min(1)),
    assumptionIds: z.array(z.string().min(1)),
    conflictIds: z.array(z.string().min(1)),
    dependsOnObligationIds: z.array(z.string().min(1)),
    implementationResponsibilities: z.array(ImplementationResponsibilitySchema),
    proofExpectations: z.array(ProofExpectationSchema),
    nonVacuityRequirements: z.array(NonVacuityRequirementSchema),
    runtimeSignalRequirements: z.array(RuntimeSignalRequirementSchema),
    contentHash: ContentHashSchema,
  })
  .strict();

export const ObligationSchema = ObligationObjectSchema.superRefine((obligation, context) => {
  if (obligation.sourceClauseIds.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceClauseIds'],
      message: 'obligation requires source provenance',
    });
  }
  if (
    obligation.applicability === 'applicable' &&
    (obligation.criticality === 'C0' || obligation.criticality === 'C1')
  ) {
    if (obligation.implementationResponsibilities.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['implementationResponsibilities'],
        message: 'applicable C0/C1 obligation requires an implementation responsibility',
      });
    }
    if (obligation.proofExpectations.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proofExpectations'],
        message: 'applicable C0/C1 obligation requires a proof expectation',
      });
    }
    if (obligation.nonVacuityRequirements.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nonVacuityRequirements'],
        message: 'applicable C0/C1 obligation requires a non-vacuity requirement',
      });
    }
  }
  if (selfExcludingHash(obligation) !== obligation.contentHash) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contentHash'],
      message: 'SEMANTIC_CONTENT_HASH_MISMATCH: obligation contentHash does not match body',
    });
  }
});

export type DerivationRecord = z.infer<typeof DerivationRecordSchema>;
export type ImplementationResponsibility = z.infer<typeof ImplementationResponsibilitySchema>;
export type ProofExpectation = z.infer<typeof ProofExpectationSchema>;
export type NonVacuityRequirement = z.infer<typeof NonVacuityRequirementSchema>;
export type RuntimeSignalRequirement = z.infer<typeof RuntimeSignalRequirementSchema>;
export type Obligation = z.infer<typeof ObligationSchema>;

export function obligationContentHash(obligation: Obligation): string {
  return selfExcludingHash(obligation);
}

export function verifyObligation(obligation: Obligation): boolean {
  return obligation.contentHash === obligationContentHash(obligation);
}
