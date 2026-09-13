import { describe, expect, it } from 'vitest';
import {
  generateProofCoverageManifest,
  renderProofCoverage,
  type ClauseDefinition,
  type ProofObservation,
} from './index.js';

const clause: ClauseDefinition = {
  id: 'AIV-IMP-002',
  title: 'Assisted actions require dual attribution',
  description: 'Actor, subject, and acting identity are retained.',
  category: 'evidence',
  criticality: 'release_blocking',
  sourceArtifact: 'specs/engines/aivante.engine.isl',
  sourceDeclarationId: 'AIV-IMP-002',
  requiredProofs: ['declared', 'compiled', 'static', 'runtime', 'mutation', 'deployed'],
};

function observation(level: ProofObservation['level']): ProofObservation {
  return {
    clauseId: clause.id,
    level,
    result: 'pass',
    evidenceId: `evidence-${level}`,
    artifactRef: `artifact-${level}`,
  };
}

describe('proof obligation coverage', () => {
  it('does not confuse an ISL declaration with enforcement proof', () => {
    const manifest = generateProofCoverageManifest({
      subject: 'aivante',
      clauses: [clause],
      observations: [observation('declared')],
    });
    expect(manifest.releaseBlockingComplete).toBe(false);
    expect(manifest.clauses[0]?.missingRequiredProofs).toEqual([
      'compiled',
      'static',
      'runtime',
      'mutation',
      'deployed',
    ]);
  });

  it('requires pass evidence at every declared level', () => {
    const observations = [
      observation('declared'),
      observation('compiled'),
      observation('static'),
      observation('runtime'),
      observation('mutation'),
      { ...observation('deployed'), result: 'inconclusive' as const },
    ];
    const manifest = generateProofCoverageManifest({
      subject: 'aivante',
      clauses: [clause],
      observations,
    });
    expect(manifest.incompleteReleaseBlockingClauseIds).toEqual(['AIV-IMP-002']);
    expect(manifest.clauses[0]?.proofs.deployed.result).toBe('inconclusive');
  });

  it('generates deterministic machine and human-readable coverage', () => {
    const manifest = generateProofCoverageManifest({
      subject: 'aivante',
      clauses: [clause],
      observations: [
        observation('mutation'),
        observation('compiled'),
        observation('runtime'),
        observation('declared'),
        observation('deployed'),
        observation('static'),
      ],
    });
    expect(manifest.releaseBlockingComplete).toBe(true);
    expect(renderProofCoverage(manifest)).toContain('PASS AIV-IMP-002');
    expect(renderProofCoverage(manifest)).toContain('Release blocking: COMPLETE');
  });

  it('rejects proof attributed to an undeclared clause', () => {
    expect(() =>
      generateProofCoverageManifest({
        subject: 'aivante',
        clauses: [clause],
        observations: [{ ...observation('runtime'), clauseId: 'AIV-AUTH-999' }],
      }),
    ).toThrow(/undeclared clause AIV-AUTH-999/);
  });
});
