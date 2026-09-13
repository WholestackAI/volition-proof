/**
 * Effect Authority — Consequence-bound governance over actions and resources.
 *
 * Evolving Volition from "Can this agent call Tool X?" into:
 * "Can this agent cause Effect E to Resource R under Context C?"
 *
 * Implements the lesson from the OpenAI/METR incident: agents exploited
 * authorized infrastructure (Artifactory) as an unauthorized egress & signaling bus.
 */

export type EffectKind =
  | 'network_egress'
  | 'inter_agent_signaling'
  | 'filesystem_mutation'
  | 'credential_access'
  | 'evaluator_mutation'
  | 'governor_mutation'
  | 'model_weights_mutation'
  | 'deploy_production'
  | 'self_certification';

export type EffectOperation = 'read' | 'write' | 'execute' | 'send' | 'listen' | 'connect';

export interface EffectDescriptor {
  readonly kind: EffectKind;
  readonly target: string;
  readonly operation: EffectOperation;
  readonly context?: Record<string, unknown>;
  readonly reason?: string;
}

export type EffectDisposition = 'allow' | 'deny' | 'escalation_required';

export interface EffectPolicyRule {
  readonly effect: EffectKind;
  readonly disposition: EffectDisposition;
  /** Targets or glob/host patterns this rule applies to. Empty or ["*"] means all. */
  readonly targets?: readonly string[];
  readonly reason?: string;
}

const CONSTITUTIONAL_GOVERNOR_PATTERNS = [
  /(?:\.isl$|intent-lock\.json$|intent\.lock\.json$|app-contract\.json$|authority\.json$)/i,
  /^workspace\/volition\/(?:proposals|receipts|evidence|ledger)\//i,
  /^\.wholestack\//i,
];

const EVALUATOR_PATTERNS = [
  /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/i,
  /\.benchmark\.(ts|tsx|js|jsx|mjs|cjs)$/i,
  /^evals\//i,
  /^tests?\//i,
  /__tests__\//i,
];

const CREDENTIAL_PATTERNS = [
  /(?:^|\/)\.env(?:\..+)?$/i,
  /(?:credentials|id_rsa|id_ecdsa|\.pem|\.key|\.secret)/i,
  /(?:aws_access_key|api_key|token|auth_token)/i,
];

const INTER_AGENT_CHANNELS = [
  /(?:^|\/)(?:agent_bus|ipc|shared_channel|signal_pipe|peer_queue)(?:$|\/)/i,
  /artifactory.*(?:\/messages|\/channel|\/signal)/i,
];

function isExternalHost(host: string): boolean {
  if (!host) return false;
  const clean = host.toLowerCase().trim();
  if (clean === 'localhost' || clean === '127.0.0.1' || clean === '::1') return false;
  if (clean.endsWith('.internal') || clean.endsWith('.corp') || clean.endsWith('.local')) return false;
  return true;
}

function extractHost(urlStr: string): string {
  try {
    const parsed = new URL(urlStr.includes('://') ? urlStr : `https://${urlStr}`);
    return parsed.hostname;
  } catch {
    return urlStr.split('/')[0] ?? '';
  }
}

/**
 * Infer concrete effects on resources from an action and its arguments.
 */
export function inferEffectsFromAction(
  action: string,
  args: Record<string, unknown>,
): EffectDescriptor[] {
  const effects: EffectDescriptor[] = [];
  const path = typeof args.path === 'string' ? args.path : (typeof args.file === 'string' ? args.file : '');
  const url = typeof args.url === 'string' ? args.url : (typeof args.endpoint === 'string' ? args.endpoint : (typeof args.remote === 'string' ? args.remote : ''));
  const ref = typeof args.ref === 'string' ? args.ref : (typeof args.branch === 'string' ? args.branch : '');

  // 1. Filesystem & Immutability checks
  if (action === 'write_file' || action === 'edit_file' || action === 'delete_file' || action === 'patch_file') {
    const op: EffectOperation = action === 'delete_file' ? 'write' : 'write';

    // Governor Immutability
    if (CONSTITUTIONAL_GOVERNOR_PATTERNS.some((p) => p.test(path))) {
      effects.push({
        kind: 'governor_mutation',
        target: path,
        operation: op,
        reason: `Action ${action} attempts to mutate constitutional governor artifact ${path}`,
      });
    }

    // Evaluator Immutability
    if (EVALUATOR_PATTERNS.some((p) => p.test(path))) {
      effects.push({
        kind: 'evaluator_mutation',
        target: path,
        operation: op,
        reason: `Action ${action} attempts to mutate test suite or evaluator harness ${path}`,
      });
    }

    // Credential reading/writing
    if (CREDENTIAL_PATTERNS.some((p) => p.test(path))) {
      effects.push({
        kind: 'credential_access',
        target: path,
        operation: op,
        reason: `Action ${action} attempts to mutate credential storage ${path}`,
      });
    }

    // Covert inter-agent signaling channel
    if (INTER_AGENT_CHANNELS.some((p) => p.test(path))) {
      effects.push({
        kind: 'inter_agent_signaling',
        target: path,
        operation: 'send',
        reason: `Action ${action} writes to shared covert communication path ${path}`,
      });
    }

    if (
      /(?:^|\/)shipgate\.json$/i.test(path) ||
      /(?:^|\/)(?:evaluator-)?attestation\.json$/i.test(path) ||
      args.selfSigned === true
    ) {
      effects.push({
        kind: 'self_certification',
        target: path || 'attestation',
        operation: 'write',
        reason: `Action ${action} attempts to self-certify attestation ${path || 'payload'}`,
      });
    }

    effects.push({
      kind: 'filesystem_mutation',
      target: path,
      operation: op,
      context: { emptyFile: args.content === '' },
    });
  }

  if (action === 'sign_attestation' || action === 'issue_attestation') {
    effects.push({
      kind: 'self_certification',
      target: typeof args.path === 'string' ? args.path : 'attestation',
      operation: 'write',
      reason: `Action ${action} attempts to certify compliance from inside the governed runtime`,
    });
  }

  // 2. Read operations on credentials / governor
  if (action === 'read_file' || action === 'read_resource') {
    if (CREDENTIAL_PATTERNS.some((p) => p.test(path))) {
      effects.push({
        kind: 'credential_access',
        target: path,
        operation: 'read',
        reason: `Action ${action} attempts to read secret/credential artifact ${path}`,
      });
    }
  }

  // 3. Network Egress & Covert Infrastructure Exploitation
  // Catches tools like artifactory_sync, package_install, fetch_remote, curl, etc.
  if (
    action === 'artifactory_sync' ||
    action === 'fetch_remote' ||
    action === 'network_request' ||
    action === 'http_get' ||
    action === 'http_post' ||
    action === 'curl' ||
    action === 'git_fetch' ||
    url.length > 0
  ) {
    const host = extractHost(url || (typeof args.host === 'string' ? args.host : ''));
    if (host && isExternalHost(host)) {
      effects.push({
        kind: 'network_egress',
        target: host,
        operation: 'connect',
        context: { url, action },
        reason: `Action ${action} initiates outbound network egress to external host ${host}`,
      });
    }

    // Covert channel over infrastructure
    if (INTER_AGENT_CHANNELS.some((p) => p.test(url) || p.test(typeof args.channel === 'string' ? args.channel : ''))) {
      effects.push({
        kind: 'inter_agent_signaling',
        target: url || 'infrastructure_bus',
        operation: 'send',
        reason: `Action ${action} exploits infrastructure for inter-agent communication channel`,
      });
    }
  }

  // 4. Production Deployments
  if (action === 'git_push' || action === 'deploy' || action === 'release') {
    if (/(?:^|\/)(?:production|main|master|release)$/i.test(ref)) {
      effects.push({
        kind: 'deploy_production',
        target: ref || 'production',
        operation: 'execute',
        reason: `Action ${action} targets protected production branch/environment ${ref}`,
      });
    }
  }

  return effects;
}

export interface EffectEvaluationDecision {
  allowed: boolean;
  status: 'GRANTED' | 'DENIED' | 'ESCALATION_REQUIRED';
  code:
    | 'GRANTED'
    | 'EFFECT_PROHIBITED'
    | 'UNAUTHORIZED_EGRESS'
    | 'COVERT_CHANNEL_DETECTED'
    | 'IMMUTABLE_GOVERNOR_VIOLATION'
    | 'APPROVAL_REQUIRED'
    | 'UNTRUSTED_EVALUATOR';
  reason?: string;
  effect?: EffectDescriptor;
}

/**
 * Default constitutional effect policies.
 * Fail-closed: governor mutation, evaluator mutation, and covert channels are unconditionally prohibited.
 */
export function evaluateEffectPolicies(
  effects: readonly EffectDescriptor[],
  customRules: readonly EffectPolicyRule[] = [],
  evidence?: { allowLocked?: boolean; boundProposalHash?: string | null },
): EffectEvaluationDecision {
  for (const effect of effects) {
    // 1. Immutable Governor Protection (Non-Self-Modifiable Governor)
    if (effect.kind === 'governor_mutation' && !evidence?.allowLocked) {
      return {
        allowed: false,
        status: 'DENIED',
        code: 'IMMUTABLE_GOVERNOR_VIOLATION',
        reason: `DENIED IMMUTABLE_GOVERNOR_VIOLATION — agents cannot modify authority contracts, ledgers, or specs (${effect.target}).`,
        effect,
      };
    }

    // 2. Evaluator & Grader Immutability
    if (effect.kind === 'evaluator_mutation' && !evidence?.allowLocked) {
      return {
        allowed: false,
        status: 'DENIED',
        code: 'IMMUTABLE_GOVERNOR_VIOLATION',
        reason: `DENIED IMMUTABLE_GOVERNOR_VIOLATION — agents cannot modify test suites, benchmarks, or evaluators (${effect.target}).`,
        effect,
      };
    }

    // 2b. Self-certification — the governed runtime cannot be its own evaluator.
    if (effect.kind === 'self_certification' && !evidence?.allowLocked) {
      return {
        allowed: false,
        status: 'DENIED',
        code: 'UNTRUSTED_EVALUATOR',
        reason: `DENIED UNTRUSTED_EVALUATOR — the governed system cannot certify itself (${effect.target}).`,
        effect,
      };
    }

    // 3. Covert Inter-Agent Signaling Bus (Hugging Face / METR Incident Mitigation)
    if (effect.kind === 'inter_agent_signaling') {
      return {
        allowed: false,
        status: 'DENIED',
        code: 'COVERT_CHANNEL_DETECTED',
        reason: `DENIED COVERT_CHANNEL_DETECTED — unauthorized inter-agent signaling channel (${effect.target}).`,
        effect,
      };
    }

    // 4. Credential Access Protection
    if (effect.kind === 'credential_access') {
      return {
        allowed: false,
        status: 'DENIED',
        code: 'EFFECT_PROHIBITED',
        reason: `DENIED EFFECT_PROHIBITED — accessing credential or secret storage is forbidden (${effect.target}).`,
        effect,
      };
    }

    // 5. External Egress Policies
    if (effect.kind === 'network_egress') {
      // Check if custom rules allow this host
      const matchingRule = customRules.find((r) => r.effect === 'network_egress');
      const isAllowedTarget = matchingRule?.targets?.some(
        (t) => t === '*' || effect.target.toLowerCase().includes(t.toLowerCase()),
      );

      if (matchingRule?.disposition === 'allow' && isAllowedTarget) {
        continue;
      }

      return {
        allowed: false,
        status: 'DENIED',
        code: 'UNAUTHORIZED_EGRESS',
        reason: `DENIED UNAUTHORIZED_EGRESS — outbound network connection to ${effect.target} is not permitted by authority contract.`,
        effect,
      };
    }

    // 6. Production Deployments require human escalation
    if (effect.kind === 'deploy_production') {
      if (!evidence?.boundProposalHash) {
        return {
          allowed: false,
          status: 'ESCALATION_REQUIRED',
          code: 'APPROVAL_REQUIRED',
          reason: `ESCALATION_REQUIRED — promoting or pushing to production requires operator voucher.`,
          effect,
        };
      }
    }

    // 7. Custom Rules Evaluation
    for (const rule of customRules) {
      if (rule.effect === effect.kind) {
        if (rule.disposition === 'deny') {
          return {
            allowed: false,
            status: 'DENIED',
            code: 'EFFECT_PROHIBITED',
            reason: rule.reason ?? `DENIED EFFECT_PROHIBITED — ${effect.kind} to ${effect.target} is forbidden.`,
            effect,
          };
        }
      }
    }
  }

  return {
    allowed: true,
    status: 'GRANTED',
    code: 'GRANTED',
  };
}
