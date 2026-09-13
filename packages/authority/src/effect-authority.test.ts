import { describe, expect, it } from 'vitest';
import {
  evaluateEffectPolicies,
  inferEffectsFromAction,
  type EffectDescriptor,
} from './effect-authority.js';

describe('Effect Authority (Consequence Governance)', () => {
  it('infers network egress and halts external host communication without rule', () => {
    const effects = inferEffectsFromAction('artifactory_sync', {
      url: 'https://huggingface.co/api/models',
    });
    expect(effects.some((e) => e.kind === 'network_egress')).toBe(true);

    const decision = evaluateEffectPolicies(effects);
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe('DENIED');
    expect(decision.code).toBe('UNAUTHORIZED_EGRESS');
    expect(decision.reason).toContain('huggingface.co');
  });

  it('allows network egress when explicitly whitelisted by authority contract', () => {
    const effects = inferEffectsFromAction('artifactory_sync', {
      url: 'https://packages.internal.corp/repo/npm',
    });
    // .internal is classified as internal, not external
    expect(effects.some((e) => e.kind === 'network_egress')).toBe(false);

    const extEffects: EffectDescriptor[] = [
      { kind: 'network_egress', target: 'allowed.vendor.com', operation: 'connect' },
    ];
    const decision = evaluateEffectPolicies(extEffects, [
      { effect: 'network_egress', disposition: 'allow', targets: ['allowed.vendor.com'] },
    ]);
    expect(decision.allowed).toBe(true);
    expect(decision.status).toBe('GRANTED');
  });

  it('detects covert inter-agent signaling over infrastructure or shared files', () => {
    const effects = inferEffectsFromAction('write_file', {
      path: '/tmp/agent_bus/peer_signal_12.dat',
      content: 'attack payload',
    });
    expect(effects.some((e) => e.kind === 'inter_agent_signaling')).toBe(true);

    const decision = evaluateEffectPolicies(effects);
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe('DENIED');
    expect(decision.code).toBe('COVERT_CHANNEL_DETECTED');
  });

  it('enforces immutable evaluator rule: halts editing tests or benchmarks', () => {
    const effects = inferEffectsFromAction('write_file', {
      path: 'evals/agent-gauntlet/src/gauntlet.test.ts',
      content: 'test.skip()',
    });
    expect(effects.some((e) => e.kind === 'evaluator_mutation')).toBe(true);

    const decision = evaluateEffectPolicies(effects);
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe('DENIED');
    expect(decision.code).toBe('IMMUTABLE_GOVERNOR_VIOLATION');
  });

  it('enforces immutable governor rule: halts modifying ISL contracts or ledgers', () => {
    const effects = inferEffectsFromAction('edit_file', {
      path: 'workspace/volition/jurisdictions/coding-agent-jurisdiction.isl',
      content: 'allow all',
    });
    expect(effects.some((e) => e.kind === 'governor_mutation')).toBe(true);

    const decision = evaluateEffectPolicies(effects);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('IMMUTABLE_GOVERNOR_VIOLATION');
  });

  it('halts credential and secret store reading', () => {
    const effects = inferEffectsFromAction('read_file', {
      path: '.env.production',
    });
    expect(effects.some((e) => e.kind === 'credential_access')).toBe(true);

    const decision = evaluateEffectPolicies(effects);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('EFFECT_PROHIBITED');
  });

  it('escalates production push unless operator voucher is present', () => {
    const effects = inferEffectsFromAction('git_push', {
      ref: 'refs/heads/main',
    });
    expect(effects.some((e) => e.kind === 'deploy_production')).toBe(true);

    const unapproved = evaluateEffectPolicies(effects);
    expect(unapproved.allowed).toBe(false);
    expect(unapproved.status).toBe('ESCALATION_REQUIRED');
    expect(unapproved.code).toBe('APPROVAL_REQUIRED');

    const approved = evaluateEffectPolicies(effects, [], { boundProposalHash: 'voucher-123' });
    expect(approved.allowed).toBe(true);
    expect(approved.status).toBe('GRANTED');
  });
});
