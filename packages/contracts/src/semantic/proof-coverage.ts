import { z } from 'zod';
import { ContentHashSchema, IsoDateTimeSchema, selfExcludingHash } from '../common.js';
import { ObligationCriticalitySchema } from './lifecycle.js';

export const GovernedC2ExceptionSchema = z
  .object({
    exceptionId: z.string().min(1),
    obligationId: z.string().min(1),
    ownerActorId: z.string().min(1),
    deadline: z.string().datetime({ offset: true }),
    impact: z.string().min(1),
    compensatingControl: z.string().min(1),
    approvedByActorId: z.string().min(1),
    approvedAt: z.string().datetime({ offset: true }),
    status: z.literal('approved'),
  })
  .strict();

export const SemanticProofObservationSchema = z
  .object({
    obligationId: z.string().min(1),
    expectationId: z.string().min(1),
    result: z.enum(['pass', 'fail', 'inconclusive']),
    evidenceId: z.string().min(1),
    artifactRef: z.string().min(1),
    detectedMutantIds: z.array(z.string().min(1)),
    observedAt: IsoDateTimeSchema.optional(),
    expiresAt: IsoDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.expiresAt !== undefined && observation.observedAt === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['observedAt'],
        message: 'Expiring semantic proof requires observedAt',
      });
    }
    if (
      observation.observedAt !== undefined &&
      observation.expiresAt !== undefined &&
      Date.parse(observation.expiresAt) <= Date.parse(observation.observedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Semantic proof expiresAt must be later than observedAt',
      });
    }
  });

export const SemanticObligationCoverageSchema = z
  .object({
    obligationId: z.string().min(1),
    criticality: ObligationCriticalitySchema,
    applicability: z.enum(['applicable', 'not_applicable', 'unresolved']),
    requiredExpectationIds: z.array(z.string().min(1)),
    passedExpectationIds: z.array(z.string().min(1)),
    failedExpectationIds: z.array(z.string().min(1)),
    missingExpectationIds: z.array(z.string().min(1)),
    requiredMutantIds: z.array(z.string().min(1)),
    detectedMutantIds: z.array(z.string().min(1)),
    missingMutantIds: z.array(z.string().min(1)),
    evidenceIds: z.array(z.string().min(1)),
    artifactRefs: z.array(z.string().min(1)),
    exceptionId: z.string().min(1).optional(),
    complete: z.boolean(),
    releaseDisposition: z.enum([
      'satisfied',
      'blocked',
      'governed_c2_exception',
      'nonblocking_c3',
      'not_applicable',
    ]),
  })
  .strict();

export const SemanticProofCoverageManifestSchema = z
  .object({
    schemaVersion: z.literal('wholestack/semantic-proof-coverage/v1'),
    subject: z.string().min(1),
    registryVersion: z.string().min(1),
    obligationIds: z.array(z.string().min(1)),
    records: z.array(SemanticObligationCoverageSchema),
    releaseBlockingObligationIds: z.array(z.string().min(1)),
    incompleteReleaseBlockingObligationIds: z.array(z.string().min(1)),
    governedC2ExceptionIds: z.array(z.string().min(1)),
    releaseBlockingComplete: z.boolean(),
  })
  .strict();

const SemanticProofCoverageArtifactV1ObjectSchema = z
  .object({
    schemaVersion: z.literal('wholestack/semantic-proof-coverage-artifact/v1'),
    subject: z
      .object({
        projectId: z.string().min(1),
        projectVersion: z.number().int().positive(),
        pipelineRunId: z.string().min(1),
        buildId: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/),
        expandedIslHash: ContentHashSchema,
        proofDenominatorHash: ContentHashSchema,
      })
      .strict(),
    manifest: SemanticProofCoverageManifestSchema,
    observations: z.array(SemanticProofObservationSchema),
    observedAt: IsoDateTimeSchema,
    contentHash: ContentHashSchema,
  })
  .strict();

/** Durable, run-bound proof artifact consumed by release-scope ShipGate. */
export const SemanticProofCoverageArtifactV1Schema =
  SemanticProofCoverageArtifactV1ObjectSchema.superRefine((artifact, context) => {
    const expectedSubject = `${artifact.subject.projectId}@${artifact.subject.projectVersion}`;
    if (artifact.manifest.subject !== expectedSubject) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['manifest', 'subject'],
        message: 'Semantic proof manifest does not bind the artifact project revision',
      });
    }
    const manifestIds = [...artifact.manifest.obligationIds].sort();
    const recordIds = artifact.manifest.records.map((record) => record.obligationId).sort();
    if (
      manifestIds.length !== new Set(manifestIds).size ||
      recordIds.length !== new Set(recordIds).size ||
      manifestIds.length !== recordIds.length ||
      manifestIds.some((id, index) => id !== recordIds[index])
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['manifest', 'records'],
        message: 'Semantic proof records must cover the exact unique obligation denominator',
      });
    }
    if (selfExcludingHash(artifact) !== artifact.contentHash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contentHash'],
        message: 'SEMANTIC_CONTENT_HASH_MISMATCH: proof coverage artifact hash does not match body',
      });
    }
  });

export type GovernedC2Exception = z.infer<typeof GovernedC2ExceptionSchema>;
export type SemanticProofObservation = z.infer<typeof SemanticProofObservationSchema>;
export type SemanticObligationCoverage = z.infer<typeof SemanticObligationCoverageSchema>;
export type SemanticProofCoverageManifest = z.infer<typeof SemanticProofCoverageManifestSchema>;
export type SemanticProofCoverageArtifactV1 = z.infer<typeof SemanticProofCoverageArtifactV1Schema>;

export function semanticProofCoverageArtifactContentHash(
  artifact: SemanticProofCoverageArtifactV1,
): string {
  return selfExcludingHash(artifact);
}
