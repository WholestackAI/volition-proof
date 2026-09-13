import { describe, expect, it } from 'vitest';
import { SwarmEnvelope } from './swarm-authority.js';

describe('Non-Composable Swarm Authority', () => {
  it('enforces that child agent cannot synthesize or amplify permissions parent lacks', () => {
    const envelope = new SwarmEnvelope('sha256:contract-root', []);

    // Parent has read_file and write_file
    const parentRes = envelope.registerAgentSession({
      sessionId: 'sess:parent-agent',
      authorizedCommands: ['read_file', 'write_file'],
    });
    expect(parentRes.ok).toBe(true);

    // Child attempts to claim git_push (parent lacks git_push)
    const childRes = envelope.registerAgentSession({
      sessionId: 'sess:child-agent-1',
      parentSessionId: 'sess:parent-agent',
      authorizedCommands: ['read_file', 'git_push'],
    });
    expect(childRes.ok).toBe(false);
    if (!childRes.ok) {
      expect(childRes.code).toBe('SWARM_AMPLIFICATION_DENIED');
      expect(childRes.reason).toContain('git_push');
    }
  });

  it('allows valid attenuated child delegation (child ⊆ parent)', () => {
    const envelope = new SwarmEnvelope('sha256:contract-root', []);

    envelope.registerAgentSession({
      sessionId: 'sess:lead-agent',
      authorizedCommands: ['read_file', 'write_file', 'run_tests'],
    });

    const childRes = envelope.registerAgentSession({
      sessionId: 'sess:worker-agent',
      parentSessionId: 'sess:lead-agent',
      authorizedCommands: ['read_file', 'run_tests'],
    });
    expect(childRes.ok).toBe(true);
  });

  it('enforces collective swarm budget ceiling across multiple concurrent agents', () => {
    // Enclosing contract specifies collective transfer cap of 2500 across all agents
    const envelope = new SwarmEnvelope('sha256:contract-root', [
      { metric: 'transfer_amount', ceiling: 2500 },
    ]);

    // Agent A executes 1500
    const a1 = envelope.consumeBudget('transfer_amount', 1500);
    expect(a1.ok).toBe(true);
    if (a1.ok) {
      expect(a1.remaining).toBe(1000);
    }

    // Agent B attempts 1200 (1500 + 1200 = 2700 > 2500 cap)
    const a2 = envelope.consumeBudget('transfer_amount', 1200);
    expect(a2.ok).toBe(false);
    if (!a2.ok) {
      expect(a2.code).toBe('SWARM_AMPLIFICATION_DENIED');
      expect(a2.reason).toContain('collective swarm consumption');
    }

    // Agent B attempts 800 (1500 + 800 = 2300 <= 2500 cap)
    const a3 = envelope.consumeBudget('transfer_amount', 800);
    expect(a3.ok).toBe(true);
    if (a3.ok) {
      expect(a3.remaining).toBe(200);
    }
  });
});
