import {
  PROOF_LEVELS,
  assertClauseIds,
  assertStableClauseId,
  type ClauseDefinition,
  type ProofLevel,
  type StableClauseId,
} from './clauses.js';
import { z } from 'zod';

export type ProofResult = 'pass' | 'fail' | 'inconclusive';

export interface ProofObservation {
  clauseId: StableClauseId;
  level: ProofLevel;
  result: ProofResult;
  evidenceId: string;
  artifactRef: string;
  recordedAt?: string;
}

export interface ProofLevelCoverage {
  required: boolean;
  result: ProofResult | 'missing';
  evidenceIds: string[];
  artifactRefs: string[];
}

export interface ClauseCoverageRecord {
  clauseId: StableClauseId;
  title: string;
  category: ClauseDefinition['category'];
  criticality: ClauseDefinition['criticality'];
  sourceArtifact: string;
  sourceDeclarationId: string;
  proofs: Record<ProofLevel, ProofLevelCoverage>;
  missingRequiredProofs: ProofLevel[];
  complete: boolean;
}

export interface ProofCoverageManifest {
  schemaVersion: 'wholestack/proof-coverage/v1';
  subject: string;
  clauses: ClauseCoverageRecord[];
  releaseBlockingClauseIds: StableClauseId[];
  incompleteReleaseBlockingClauseIds: StableClauseId[];
  releaseBlockingComplete: boolean;
}

export const ProofLevelSchema = z.enum(PROOF_LEVELS);
export const ProofLevelCoverageSchema = z.object({
  required: z.boolean(),
  result: z.enum(['pass', 'fail', 'inconclusive', 'missing']),
  evidenceIds: z.array(z.string().min(1)),
  artifactRefs: z.array(z.string().min(1)),
});
export const ClauseCoverageRecordSchema = z
  .object({
    clauseId: z.string().regex(/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+){2,}$/),
    title: z.string().min(1),
    category: z.enum([
      'authority',
      'permission',
      'delegation',
      'eligibility',
      'persistence',
      'orchestration',
      'immutability',
      'evidence',
      'chat_validation',
      'retention',
      'provider_failure',
    ]),
    criticality: z.enum(['release_blocking', 'advisory']),
    sourceArtifact: z.string().min(1),
    sourceDeclarationId: z.string().min(1),
    proofs: z.object({
      declared: ProofLevelCoverageSchema,
      compiled: ProofLevelCoverageSchema,
      static: ProofLevelCoverageSchema,
      runtime: ProofLevelCoverageSchema,
      mutation: ProofLevelCoverageSchema,
      deployed: ProofLevelCoverageSchema,
    }),
    missingRequiredProofs: z.array(ProofLevelSchema),
    complete: z.boolean(),
  })
  .superRefine((record, context) => {
    if (record.sourceDeclarationId !== record.clauseId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceDeclarationId'],
        message: 'ISL source declaration id must equal the permanent clause id',
      });
    }
  });
const StableClauseIdSchema = z.string().regex(/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+){2,}$/);
export const ProofCoverageManifestSchema = z
  .object({
    schemaVersion: z.literal('wholestack/proof-coverage/v1'),
    subject: z.string().min(1),
    clauses: z.array(ClauseCoverageRecordSchema),
    releaseBlockingClauseIds: z.array(StableClauseIdSchema),
    incompleteReleaseBlockingClauseIds: z.array(StableClauseIdSchema),
    releaseBlockingComplete: z.boolean(),
  })
  .superRefine((manifest, context) => {
    const ids = manifest.clauses.map((clause) => clause.clauseId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clauses'],
        message: 'Clause coverage manifest contains duplicate clause ids',
      });
    }
  });

export function parseProofCoverageManifest(input: unknown): ProofCoverageManifest {
  return ProofCoverageManifestSchema.parse(input) as ProofCoverageManifest;
}

function bestResult(observations: readonly ProofObservation[]): ProofResult | 'missing' {
  if (observations.length === 0) return 'missing';
  if (observations.some((observation) => observation.result === 'fail')) return 'fail';
  if (observations.some((observation) => observation.result === 'inconclusive')) {
    return 'inconclusive';
  }
  return 'pass';
}

function sortUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Generates the release denominator from declarations plus concrete evidence.
 * A declaration only satisfies `declared`; it cannot imply compilation,
 * runtime, mutation, or deployment proof.
 */
export function generateProofCoverageManifest(input: {
  subject: string;
  clauses: readonly ClauseDefinition[];
  observations: readonly ProofObservation[];
}): ProofCoverageManifest {
  const definitions = new Map<string, ClauseDefinition>();
  for (const clause of input.clauses) {
    assertStableClauseId(clause.id);
    if (definitions.has(clause.id)) throw new TypeError(`Duplicate clause id ${clause.id}`);
    if (clause.sourceDeclarationId !== clause.id) {
      throw new TypeError(
        `Clause ${clause.id} must use the same permanent id in its ISL invariant declaration`,
      );
    }
    assertClauseIds([clause.id], 'clause definition');
    definitions.set(clause.id, clause);
  }

  for (const observation of input.observations) {
    assertStableClauseId(observation.clauseId);
    if (!definitions.has(observation.clauseId)) {
      throw new TypeError(
        `Proof ${observation.evidenceId} references undeclared clause ${observation.clauseId}`,
      );
    }
    if (!PROOF_LEVELS.includes(observation.level)) {
      throw new TypeError(`Unknown proof level ${String(observation.level)}`);
    }
    if (!observation.evidenceId || !observation.artifactRef) {
      throw new TypeError('Proof observations require evidenceId and artifactRef');
    }
  }

  const clauses = [...definitions.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((definition): ClauseCoverageRecord => {
      const proofs = Object.fromEntries(
        PROOF_LEVELS.map((level) => {
          const observations = input.observations.filter(
            (observation) => observation.clauseId === definition.id && observation.level === level,
          );
          const coverage: ProofLevelCoverage = {
            required: definition.requiredProofs.includes(level),
            result: bestResult(observations),
            evidenceIds: sortUnique(observations.map((observation) => observation.evidenceId)),
            artifactRefs: sortUnique(observations.map((observation) => observation.artifactRef)),
          };
          return [level, coverage];
        }),
      ) as Record<ProofLevel, ProofLevelCoverage>;
      const missingRequiredProofs = definition.requiredProofs.filter(
        (level) => proofs[level].result !== 'pass',
      );
      return {
        clauseId: definition.id,
        title: definition.title,
        category: definition.category,
        criticality: definition.criticality,
        sourceArtifact: definition.sourceArtifact,
        sourceDeclarationId: definition.sourceDeclarationId,
        proofs,
        missingRequiredProofs: [...missingRequiredProofs],
        complete: missingRequiredProofs.length === 0,
      };
    });

  const releaseBlockingClauseIds = clauses
    .filter((clause) => clause.criticality === 'release_blocking')
    .map((clause) => clause.clauseId);
  const incompleteReleaseBlockingClauseIds = clauses
    .filter((clause) => clause.criticality === 'release_blocking' && !clause.complete)
    .map((clause) => clause.clauseId);

  return parseProofCoverageManifest({
    schemaVersion: 'wholestack/proof-coverage/v1',
    subject: input.subject,
    clauses,
    releaseBlockingClauseIds,
    incompleteReleaseBlockingClauseIds,
    releaseBlockingComplete: incompleteReleaseBlockingClauseIds.length === 0,
  });
}

export function renderProofCoverage(manifest: ProofCoverageManifest): string {
  const lines = [
    `Clause coverage: ${manifest.subject}`,
    `Release blocking: ${manifest.releaseBlockingComplete ? 'COMPLETE' : 'INCOMPLETE'}`,
  ];
  for (const clause of manifest.clauses) {
    const proofSummary = PROOF_LEVELS.map(
      (level) => `${level}=${clause.proofs[level].result}`,
    ).join(' ');
    lines.push(
      `${clause.complete ? 'PASS' : 'BLOCK'} ${clause.clauseId} ${clause.title} | ${proofSummary}`,
    );
  }
  return lines.join('\n');
}
