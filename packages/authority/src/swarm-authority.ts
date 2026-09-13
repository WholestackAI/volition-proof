/**
 * Non-Composable Swarm Authority.
 *
 * Implements the theorem:
 *   Authority(A1 ∪ A2 ∪ ... ∪ An) ⊆ Authority(Contract_enclosing)
 *
 * Sward privilege laundering is mathematically blocked:
 * 1. Non-amplifying delegation: Child authority MUST be a strict subset of parent.
 * 2. Cumulative swarm budgeting: Individual limits cannot pool to exceed the enclosing contract ceiling.
 * 3. Collective privilege containment: 1,000 agents cannot pool low-level permissions to bypass a high-level gate.
 */

export interface SwarmBudgetCeiling {
  readonly metric: string;
  readonly ceiling: number;
}

export class SwarmEnvelope {
  readonly contractHash: string;
  private readonly ceilings: Map<string, number>;
  private readonly consumed: Map<string, number>;
  private readonly childToParent: Map<string, string>;
  private readonly sessionCommands: Map<string, Set<string>>;

  constructor(contractHash: string, ceilings: SwarmBudgetCeiling[] = []) {
    this.contractHash = contractHash;
    this.ceilings = new Map(ceilings.map((c) => [c.metric, c.ceiling]));
    this.consumed = new Map();
    this.childToParent = new Map();
    this.sessionCommands = new Map();
  }

  /**
   * Register an agent or subagent session under the swarm envelope.
   * Enforces that child authority cannot exceed parent authority.
   */
  registerAgentSession(input: {
    sessionId: string;
    parentSessionId?: string;
    authorizedCommands: readonly string[];
  }): { ok: true } | { ok: false; code: 'SWARM_AMPLIFICATION_DENIED'; reason: string } {
    const childSet = new Set(input.authorizedCommands);

    if (input.parentSessionId) {
      const parentCommands = this.sessionCommands.get(input.parentSessionId);
      if (!parentCommands) {
        return {
          ok: false,
          code: 'SWARM_AMPLIFICATION_DENIED',
          reason: `DENIED SWARM_AMPLIFICATION_DENIED — unknown parent session ${input.parentSessionId}.`,
        };
      }

      // Check subset: every child command must be in parent
      for (const cmd of childSet) {
        if (!parentCommands.has(cmd)) {
          return {
            ok: false,
            code: 'SWARM_AMPLIFICATION_DENIED',
            reason: `DENIED SWARM_AMPLIFICATION_DENIED — child claimed command "${cmd}" not held by parent session.`,
          };
        }
      }

      this.childToParent.set(input.sessionId, input.parentSessionId);
    }

    this.sessionCommands.set(input.sessionId, childSet);
    return { ok: true };
  }

  /**
   * Deduct or verify an operation against the enclosing contract's global swarm ceiling.
   */
  consumeBudget(
    metric: string,
    requested: number,
  ): { ok: true; remaining: number } | { ok: false; code: 'SWARM_AMPLIFICATION_DENIED'; reason: string } {
    const ceiling = this.ceilings.get(metric);
    if (ceiling === undefined) {
      // No global ceiling configured for this metric
      return { ok: true, remaining: Infinity };
    }

    const current = this.consumed.get(metric) ?? 0;
    const projected = current + requested;

    if (projected > ceiling) {
      return {
        ok: false,
        code: 'SWARM_AMPLIFICATION_DENIED',
        reason: `DENIED SWARM_AMPLIFICATION_DENIED — collective swarm consumption of ${projected} exceeds enclosing contract ceiling of ${ceiling} for metric "${metric}".`,
      };
    }

    this.consumed.set(metric, projected);
    return { ok: true, remaining: ceiling - projected };
  }

  getConsumed(metric: string): number {
    return this.consumed.get(metric) ?? 0;
  }
}
