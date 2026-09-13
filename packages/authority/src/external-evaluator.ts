/**
 * Decoupled External Proof & Attestation.
 *
 * Implements Dario Amodei's "external evaluator" architecture:
 * The governed system CANNOT certify itself.
 *
 * ShipGate attestation manifests must be signed by an independent external
 * evaluator holding an asymmetric keypair outside the agent runtime.
 */
import {
  createHash,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';

export interface EvaluatorKeyPair {
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
  readonly evaluatorId: string;
}

export interface AttestationEvidencePayload {
  readonly contractHash: string;
  readonly receiptsHash: string;
  readonly benchmarkSummary: {
    readonly totalAttacks: number;
    readonly breaches: number;
    readonly containmentRate: number;
  };
  readonly timestamp: string;
}

export interface SignedAttestation {
  readonly payload: AttestationEvidencePayload;
  readonly digest: string;
  readonly signature: string;
  readonly evaluatorId: string;
  readonly evaluatorPublicKeyPem: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function computeAttestationDigest(payload: AttestationEvidencePayload): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)), 'utf8')
    .digest('hex');
}

/**
 * Generate a cryptographically strong Ed25519 keypair for an external evaluator.
 */
export function generateEvaluatorKeyPair(evaluatorId: string): EvaluatorKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  return {
    evaluatorId,
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
  };
}

/**
 * External evaluator signs the attestation manifest.
 * Fails closed if the benchmark shows any breaches or less than 100% containment.
 */
export function signEvaluatorAttestation(
  payload: AttestationEvidencePayload,
  keyPair: EvaluatorKeyPair,
): { ok: true; attestation: SignedAttestation } | { ok: false; reason: string } {
  if (payload.benchmarkSummary.breaches > 0 || payload.benchmarkSummary.containmentRate < 1) {
    return {
      ok: false,
      reason: `REFUSED — Evaluator refuses to sign: ${payload.benchmarkSummary.breaches} breaches observed. Containment must be 100%.`,
    };
  }

  const digest = computeAttestationDigest(payload);
  const sig = sign(null, Buffer.from(digest, 'hex'), keyPair.privateKeyPem).toString('hex');

  return {
    ok: true,
    attestation: {
      payload,
      digest: `sha256:${digest}`,
      signature: sig,
      evaluatorId: keyPair.evaluatorId,
      evaluatorPublicKeyPem: keyPair.publicKeyPem,
    },
  };
}

/**
 * Verify that an attestation is validly signed by an approved external evaluator.
 */
export function verifyEvaluatorAttestation(
  attestation: SignedAttestation,
  trustedEvaluatorPublicKeys: readonly string[],
): { verified: boolean; reason?: string } {
  // Check trusted evaluator allowlist
  const isTrusted = trustedEvaluatorPublicKeys.some(
    (key) => key.trim() === attestation.evaluatorPublicKeyPem.trim(),
  );
  if (!isTrusted) {
    return {
      verified: false,
      reason: `UNTRUSTED_EVALUATOR — Public key for evaluator "${attestation.evaluatorId}" is not in trusted keyset. Self-signed attestations rejected.`,
    };
  }

  // Verify digest integrity
  const expectedDigest = computeAttestationDigest(attestation.payload);
  if (attestation.digest !== `sha256:${expectedDigest}`) {
    return {
      verified: false,
      reason: 'DIGEST_MISMATCH — Attestation payload does not match signed digest.',
    };
  }

  // Cryptographically verify Ed25519 signature
  const isValidSig = verify(
    null,
    Buffer.from(expectedDigest, 'hex'),
    attestation.evaluatorPublicKeyPem,
    Buffer.from(attestation.signature, 'hex'),
  );

  if (!isValidSig) {
    return {
      verified: false,
      reason: 'INVALID_SIGNATURE — Cryptographic signature verification failed.',
    };
  }

  return { verified: true };
}
