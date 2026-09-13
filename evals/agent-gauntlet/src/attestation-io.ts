/**
 * Load/verify gauntlet attestation against a committed trusted-evaluator set.
 * Signing happens in a separate process with a key this tree does not contain.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  verifyEvaluatorAttestation,
  type AttestationEvidencePayload,
  type SignedAttestation,
  type TrustedEvaluatorSet,
} from '../../../packages/authority/src/index.js';
import type { GauntletReport } from './report.js';

const here = dirname(fileURLToPath(import.meta.url));
export const GAUNTLET_ROOT = join(here, '..');
export const EVIDENCE_DIR = join(GAUNTLET_ROOT, 'evidence');
export const TRUSTED_EVALUATORS_PATH = join(GAUNTLET_ROOT, 'trusted-evaluators.json');
export const ATTESTATION_PATH = join(EVIDENCE_DIR, 'volition-gauntlet-attestation.json');
export const REPORT_PATH = join(EVIDENCE_DIR, 'volition-gauntlet-benchmark.json');
export const CONTRACT_PATH = join(here, '../../../fixtures/isl-specs/coding-agent-jurisdiction.isl');

export function sha256File(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

export function loadTrustedEvaluators(): TrustedEvaluatorSet {
  if (!existsSync(TRUSTED_EVALUATORS_PATH)) {
    return { evaluators: [] };
  }
  const parsed = JSON.parse(readFileSync(TRUSTED_EVALUATORS_PATH, 'utf8')) as TrustedEvaluatorSet;
  if (!parsed || !Array.isArray(parsed.evaluators)) {
    throw new Error('trusted-evaluators.json must contain { evaluators: [...] }');
  }
  return parsed;
}

export function loadCommittedAttestation(): SignedAttestation | null {
  if (!existsSync(ATTESTATION_PATH)) return null;
  return JSON.parse(readFileSync(ATTESTATION_PATH, 'utf8')) as SignedAttestation;
}

export function attestationPayloadFromReport(report: GauntletReport): AttestationEvidencePayload {
  return {
    contractHash: sha256File(CONTRACT_PATH),
    receiptsHash: sha256File(REPORT_PATH),
    benchmarkSummary: {
      totalAttacks: report.totalAttacks,
      breaches: report.treatmentTotalBreaches,
      containmentRate: report.containmentRate / 100,
    },
    timestamp: report.timestamp,
  };
}

export function verifyCommittedAttestation(report?: GauntletReport): {
  present: boolean;
  ok: boolean;
  reason?: string;
  evaluatorId?: string;
  provenance?: string;
} {
  const attestation = loadCommittedAttestation();
  if (!attestation) {
    return { present: false, ok: false, reason: 'NO_ATTESTATION' };
  }
  const trusted = loadTrustedEvaluators();
  const keys = trusted.evaluators.map((evaluator) => evaluator.publicKeyPem);
  const verified = verifyEvaluatorAttestation(attestation, keys);
  const match = trusted.evaluators.find(
    (evaluator) => evaluator.publicKeyPem.trim() === attestation.evaluatorPublicKeyPem.trim(),
  );
  if (!verified.verified) {
    return {
      present: true,
      ok: false,
      reason: verified.reason,
      evaluatorId: attestation.evaluatorId,
      provenance: match?.provenance,
    };
  }
  if (report) {
    const expected = attestationPayloadFromReport(report);
    if (
      expected.contractHash !== attestation.payload.contractHash ||
      expected.benchmarkSummary.totalAttacks !== attestation.payload.benchmarkSummary.totalAttacks ||
      expected.benchmarkSummary.breaches !== attestation.payload.benchmarkSummary.breaches
    ) {
      return {
        present: true,
        ok: false,
        reason: 'ATTESTATION_STALE — payload no longer matches the current report/contract.',
        evaluatorId: attestation.evaluatorId,
        provenance: match?.provenance,
      };
    }
  }
  return {
    present: true,
    ok: true,
    evaluatorId: attestation.evaluatorId,
    provenance: match?.provenance,
  };
}
