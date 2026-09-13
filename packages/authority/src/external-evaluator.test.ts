import { describe, expect, it } from 'vitest';
import {
  generateEvaluatorKeyPair,
  signEvaluatorAttestation,
  verifyEvaluatorAttestation,
  type AttestationEvidencePayload,
} from './external-evaluator.js';

describe('Decoupled External Proof & Attestation', () => {
  const validPayload: AttestationEvidencePayload = {
    contractHash: 'sha256:24e795194e4b48f0e5b0c95...',
    receiptsHash: 'sha256:1fc1fda443be7d4888ed...',
    benchmarkSummary: {
      totalAttacks: 11,
      breaches: 0,
      containmentRate: 1.0,
    },
    timestamp: '2026-09-13T01:50:00.000Z',
  };

  it('signs and verifies attestation with external evaluator keypair', () => {
    const evaluator = generateEvaluatorKeyPair('evaluator_metr_frontier');
    const signRes = signEvaluatorAttestation(validPayload, evaluator);
    expect(signRes.ok).toBe(true);

    if (signRes.ok) {
      const verifyRes = verifyEvaluatorAttestation(signRes.attestation, [
        evaluator.publicKeyPem,
      ]);
      expect(verifyRes.verified).toBe(true);
    }
  });

  it('fails closed if an attestation has breaches (evaluator refuses to sign)', () => {
    const evaluator = generateEvaluatorKeyPair('evaluator_metr_frontier');
    const breachedPayload: AttestationEvidencePayload = {
      ...validPayload,
      benchmarkSummary: {
        totalAttacks: 11,
        breaches: 2,
        containmentRate: 0.81,
      },
    };
    const signRes = signEvaluatorAttestation(breachedPayload, evaluator);
    expect(signRes.ok).toBe(false);
    if (!signRes.ok) {
      expect(signRes.reason).toContain('Evaluator refuses to sign');
      expect(signRes.reason).toContain('2 breaches observed');
    }
  });

  it('rejects self-signed attestation when key is not in trusted evaluator allowlist', () => {
    const untrustedAgentSelfKey = generateEvaluatorKeyPair('rogue_agent_self');
    const signRes = signEvaluatorAttestation(validPayload, untrustedAgentSelfKey);
    expect(signRes.ok).toBe(true);

    if (signRes.ok) {
      const trustedOfficialKey = generateEvaluatorKeyPair('official_auditor_authority');
      const verifyRes = verifyEvaluatorAttestation(signRes.attestation, [
        trustedOfficialKey.publicKeyPem,
      ]);
      expect(verifyRes.verified).toBe(false);
      expect(verifyRes.reason).toContain('UNTRUSTED_EVALUATOR');
    }
  });

  it('rejects tampered attestation payloads (digest mismatch)', () => {
    const evaluator = generateEvaluatorKeyPair('evaluator_metr_frontier');
    const signRes = signEvaluatorAttestation(validPayload, evaluator);
    expect(signRes.ok).toBe(true);

    if (signRes.ok) {
      const tampered = {
        ...signRes.attestation,
        payload: {
          ...signRes.attestation.payload,
          contractHash: 'sha256:TAMPERED_HASH',
        },
      };
      const verifyRes = verifyEvaluatorAttestation(tampered, [evaluator.publicKeyPem]);
      expect(verifyRes.verified).toBe(false);
      expect(verifyRes.reason).toContain('DIGEST_MISMATCH');
    }
  });
});
