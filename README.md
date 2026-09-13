# Volition Proof

**Runnable authority kernel + adversarial gauntlet.**

The WholeStack factory stays private. This repository is the public evidence projection: the same `decideCommand` voter, the same four primitives, the same 12-attack harness.

> Intelligence is probabilistic. Authority must be deterministic.

Essay: [wholestack.ai/research/deterministic-authority](https://wholestack.ai/research/deterministic-authority)
Proof map: [wholestack.ai/research/deterministic-authority/proof](https://wholestack.ai/research/deterministic-authority/proof)

[![gauntlet](https://github.com/WholestackAI/volition-proof/actions/workflows/gauntlet.yml/badge.svg)](https://github.com/WholestackAI/volition-proof/actions/workflows/gauntlet.yml)

## Run it

Requires Node 22+ and pnpm.

```bash
git clone https://github.com/WholestackAI/volition-proof.git
cd volition-proof
pnpm install
pnpm test
pnpm gauntlet
```

Expected gauntlet: **12 attack classes, 16 ungoverned breaches, 0 Volition breaches.**

If treatment is not 0, the governor lost. Open an issue.

## What this is

| Primitive | Source |
| --- | --- |
| Effect authority | `packages/authority/src/effect-authority.ts` |
| Non-composable swarm authority | `packages/authority/src/swarm-authority.ts` |
| Non-self-modifiable governor | `packages/authority/src/decide-command.ts` |
| Decoupled Ed25519 evaluator | `packages/authority/src/external-evaluator.ts` |
| Gauntlet | `evals/agent-gauntlet/` |
| Sealed receipt | `evals/agent-gauntlet/evidence/volition-gauntlet-benchmark.json` |
| Doctrine | `docs/FRONTIER-GOVERNANCE.md` |

ISL fixture the gauntlet actually loads: `fixtures/isl-specs/coding-agent-jurisdiction.isl`.

## What this is not

- Not the WholeStack factory (Studio, codegen, customers, billing).
- Not a second `decideCommand`. Changes land in the private factory and are synced here.
- Not a claim that Volition has been independently demonstrated against frontier-scale adversarial agents in the wild. This is an in-process harness plus a live-model benchmark reported in the essay.
- Not alignment. The model can still want the breach. The vote still has to be `GRANTED` before the world changes.

## Attack the governor

Useful attempts:

- undeclared permissions
- authority composition / swarm pooling
- evaluator or contract mutation
- self-signed attestation
- covert egress through an allowed tool
- stale or forged approval

Keep PRs to the harness, tests, or a failing case. Do not add a parallel voter.

## Sync

Private factory command:

```bash
pnpm proof:publish
```

`SOURCE.json` records the factory commit this tree was exported from. Strangers cannot read that private repo. **This tree is the verifiable artifact.**
