import {
  OBLIGATION_CRITICALITIES,
  ObligationCriticalitySchema,
  ObligationSchema,
  GovernedC2ExceptionSchema,
  SemanticProofObservationSchema,
  SemanticObligationCoverageSchema,
  SemanticProofCoverageManifestSchema,
  SemanticProofCoverageArtifactV1Schema,
  selfExcludingHash,
  type Obligation,
  type ObligationCriticality,
  type GovernedC2Exception,
  type SemanticProofObservation,
  type SemanticObligationCoverage,
  type SemanticProofCoverageManifest,
  type SemanticProofCoverageArtifactV1,
} from '@wholestack/contracts';

export {
  OBLIGATION_CRITICALITIES,
  ObligationCriticalitySchema,
  GovernedC2ExceptionSchema,
  SemanticProofObservationSchema,
  SemanticObligationCoverageSchema,
  SemanticProofCoverageManifestSchema,
  SemanticProofCoverageArtifactV1Schema,
};
export type {
  ObligationCriticality,
  GovernedC2Exception,
  SemanticProofObservation,
  SemanticObligationCoverage,
  SemanticProofCoverageManifest,
  SemanticProofCoverageArtifactV1,
};

/**
 * Canonical C0-C3 release policy. C0/C1 are fail-closed, C2 needs a named
 * governed exception when incomplete, and C3 is visible but nonblocking.
 */
export function generateSemanticProofCoverage(input: {
  subject: string;
  registryVersion: string;
  obligations: readonly Obligation[];
  observations: readonly SemanticProofObservation[];
  c2Exceptions?: readonly GovernedC2Exception[];
}): SemanticProofCoverageManifest {
  const obligations = input.obligations
    .map((obligation) => ObligationSchema.parse(obligation))
    .sort((left, right) => left.obligationId.localeCompare(right.obligationId));
  const obligationById = new Map(
    obligations.map((obligation) => [obligation.obligationId, obligation]),
  );
  if (obligationById.size !== obligations.length) {
    throw new TypeError('Semantic proof denominator contains duplicate obligation ids');
  }
  const observations = input.observations.map((observation) =>
    SemanticProofObservationSchema.parse(observation),
  );
  for (const observation of observations) {
    const obligation = obligationById.get(observation.obligationId);
    if (!obligation) {
      throw new TypeError(
        `Proof ${observation.evidenceId} references undeclared obligation ${observation.obligationId}`,
      );
    }
    if (
      !obligation.proofExpectations.some((item) => item.expectationId === observation.expectationId)
    ) {
      throw new TypeError(
        `Proof ${observation.evidenceId} references undeclared expectation ${observation.expectationId}`,
      );
    }
    const expectation = obligation.proofExpectations.find(
      (item) => item.expectationId === observation.expectationId,
    )!;
    if (
      observation.result === 'pass' &&
      (expectation.deploymentEvidenceRequired || expectation.runtimeMonitorRequired) &&
      (observation.observedAt === undefined || observation.expiresAt === undefined)
    ) {
      throw new TypeError(
        `Proof ${observation.evidenceId} requires fresh observedAt/expiresAt runtime evidence`,
      );
    }
  }
  const exceptions = new Map<string, GovernedC2Exception>();
  for (const raw of input.c2Exceptions ?? []) {
    const exception = GovernedC2ExceptionSchema.parse(raw);
    const obligation = obligationById.get(exception.obligationId);
    if (!obligation)
      throw new TypeError(
        `C2 exception references undeclared obligation ${exception.obligationId}`,
      );
    if (obligation.criticality !== 'C2') {
      throw new TypeError(
        `${obligation.criticality} obligation ${obligation.obligationId} cannot receive a C2 exception`,
      );
    }
    if (exceptions.has(exception.obligationId)) {
      throw new TypeError(`Obligation ${exception.obligationId} has duplicate C2 exceptions`);
    }
    exceptions.set(exception.obligationId, exception);
  }

  const records = obligations.map((obligation): SemanticObligationCoverage => {
    const requiredExpectationIds = obligation.proofExpectations
      .map((item) => item.expectationId)
      .sort();
    const requiredMutantIds = obligation.proofExpectations
      .flatMap((item) => item.mutantIds)
      .filter((id, index, all) => all.indexOf(id) === index)
      .sort();
    const relevant = observations.filter(
      (observation) => observation.obligationId === obligation.obligationId,
    );
    const passedExpectationIds = requiredExpectationIds.filter((expectationId) => {
      const results = relevant.filter((item) => item.expectationId === expectationId);
      return results.length > 0 && results.every((item) => item.result === 'pass');
    });
    const failedExpectationIds = requiredExpectationIds.filter((expectationId) =>
      relevant.some((item) => item.expectationId === expectationId && item.result !== 'pass'),
    );
    const missingExpectationIds = requiredExpectationIds.filter(
      (expectationId) => !relevant.some((item) => item.expectationId === expectationId),
    );
    const detectedMutantIds = unique(relevant.flatMap((item) => item.detectedMutantIds));
    const detected = new Set(detectedMutantIds);
    const missingMutantIds = requiredMutantIds.filter((mutantId) => !detected.has(mutantId));
    const complete =
      obligation.applicability === 'not_applicable' ||
      (obligation.applicability === 'applicable' &&
        requiredExpectationIds.length > 0 &&
        missingExpectationIds.length === 0 &&
        failedExpectationIds.length === 0 &&
        missingMutantIds.length === 0);
    const exception = exceptions.get(obligation.obligationId);
    const releaseDisposition =
      obligation.applicability === 'not_applicable'
        ? ('not_applicable' as const)
        : complete
          ? ('satisfied' as const)
          : obligation.criticality === 'C3'
            ? ('nonblocking_c3' as const)
            : obligation.criticality === 'C2' && exception
              ? ('governed_c2_exception' as const)
              : ('blocked' as const);
    return {
      obligationId: obligation.obligationId,
      criticality: obligation.criticality,
      applicability: obligation.applicability,
      requiredExpectationIds,
      passedExpectationIds,
      failedExpectationIds,
      missingExpectationIds,
      requiredMutantIds,
      detectedMutantIds,
      missingMutantIds,
      evidenceIds: unique(relevant.map((item) => item.evidenceId)),
      artifactRefs: unique(relevant.map((item) => item.artifactRef)),
      ...(exception ? { exceptionId: exception.exceptionId } : {}),
      complete,
      releaseDisposition,
    };
  });
  const releaseBlockingObligationIds = records
    .filter(
      (record) =>
        record.applicability !== 'not_applicable' &&
        (record.criticality === 'C0' || record.criticality === 'C1' || record.criticality === 'C2'),
    )
    .map((record) => record.obligationId);
  const incompleteReleaseBlockingObligationIds = records
    .filter((record) => releaseBlockingObligationIds.includes(record.obligationId))
    .filter((record) => !record.complete && record.releaseDisposition !== 'governed_c2_exception')
    .map((record) => record.obligationId);

  return SemanticProofCoverageManifestSchema.parse({
    schemaVersion: 'wholestack/semantic-proof-coverage/v1',
    subject: input.subject,
    registryVersion: input.registryVersion,
    obligationIds: obligations.map((obligation) => obligation.obligationId),
    records,
    releaseBlockingObligationIds,
    incompleteReleaseBlockingObligationIds,
    governedC2ExceptionIds: unique([...exceptions.values()].map((item) => item.exceptionId)),
    releaseBlockingComplete: incompleteReleaseBlockingObligationIds.length === 0,
  });
}

/**
 * Bind independently produced semantic observations to one immutable build and
 * pipeline run. This is the only persisted shape accepted by the real release
 * worker; an unbound manifest is useful for diagnostics but has no release
 * authority.
 */
export function issueSemanticProofCoverageArtifact(input: {
  projectId: string;
  projectVersion: number;
  pipelineRunId: string;
  buildId: string;
  expandedIslHash: string;
  proofDenominatorHash: string;
  registryVersion: string;
  obligations: readonly Obligation[];
  observations: readonly SemanticProofObservation[];
  c2Exceptions?: readonly GovernedC2Exception[];
  observedAt: string;
}): SemanticProofCoverageArtifactV1 {
  const manifest = generateSemanticProofCoverage({
    subject: `${input.projectId}@${input.projectVersion}`,
    registryVersion: input.registryVersion,
    obligations: input.obligations,
    observations: input.observations,
    ...(input.c2Exceptions === undefined ? {} : { c2Exceptions: input.c2Exceptions }),
  });
  const candidate = {
    schemaVersion: 'wholestack/semantic-proof-coverage-artifact/v1' as const,
    subject: {
      projectId: input.projectId,
      projectVersion: input.projectVersion,
      pipelineRunId: input.pipelineRunId,
      buildId: input.buildId,
      expandedIslHash: input.expandedIslHash,
      proofDenominatorHash: input.proofDenominatorHash,
    },
    manifest,
    observations: input.observations.map((observation) =>
      SemanticProofObservationSchema.parse(observation),
    ),
    observedAt: input.observedAt,
    contentHash: '0'.repeat(64),
  };
  return SemanticProofCoverageArtifactV1Schema.parse({
    ...candidate,
    contentHash: selfExcludingHash(candidate),
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
