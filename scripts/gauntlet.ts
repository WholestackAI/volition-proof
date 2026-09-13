/**
 * Volition Frontier Adversarial Gauntlet CLI.
 *
 * Runs the full 12-attack benchmark suite comparing:
 * - Control Arm (Ungoverned Tools): Baseline behavior of traditional agents.
 * - Volition Treatment Arm (Authority OS): Deterministic mediation across all 4 primitives.
 *
 * Concludes with independent Ed25519 external evaluator signature verification.
 */
import { main as printReport } from '../evals/agent-gauntlet/src/report.js';
import { verifyCommittedAttestation } from '../evals/agent-gauntlet/src/attestation-io.js';

async function main() {
  console.log('\n==========================================================================');
  console.log('VOLITION AGENT GAUNTLET');
  console.log('Agents decide what they want to do.');
  console.log('Volition decides what they have the authority to do.');
  console.log('==========================================================================\n');

  const report = printReport();
  const verified = verifyCommittedAttestation(report);
  console.log('--------------------------------------------------------------------------');
  console.log('ATTESTATION');
  console.log('--------------------------------------------------------------------------');
  if (!verified.present) {
    console.log('No committed attestation yet. Sign with:');
    console.log('  EVALUATOR_KEY_FILE=evals/agent-gauntlet/keys/evaluator.pem pnpm volition:attest');
    console.log('This CLI does not generate a key and then trust it in the same process.');
  } else if (!verified.ok) {
    console.error(`Attestation failed: ${verified.reason}`);
    process.exitCode = 1;
  } else {
    console.log(`Verified: ${verified.evaluatorId}`);
    console.log(`Provenance: ${verified.provenance}`);
  }
  console.log('==========================================================================\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
