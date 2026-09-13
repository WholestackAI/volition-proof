/**
 * Clarification engine.
 *
 * Questions are ranked by how much the answer changes the *shape* of the
 * generated system — data model, permissions, workflow, invariants — not by how
 * easy they are to ask. Cosmetic questions are never asked before structural
 * ones, and no question blocks progress: every one carries a recommended
 * default that is safe to apply.
 *
 * Ranking is deterministic. A model may propose extra questions, but they enter
 * through the same scoring so they cannot jump the queue.
 */

import type { ContractOp } from '../patch/ops.js';
import type { IntentDraft } from './draft.js';

/** What an answer moves. Higher-weighted dimensions get asked first. */
export const IMPACT_WEIGHTS = {
  permissions: 100,
  'data-model': 90,
  workflow: 80,
  invariant: 70,
  integration: 40,
  infrastructure: 30,
  cost: 20,
  cosmetic: 5,
} as const;
export type QuestionImpact = keyof typeof IMPACT_WEIGHTS;

export interface ClarificationOption {
  id: string;
  label: string;
  /** Ops applied when this option is chosen. Empty means "record the answer only". */
  ops: ContractOp[];
  /** Assumption text recorded when this option is the unanswered default. */
  assumption?: string;
}

export interface ClarificationQuestion {
  id: string;
  /** Plain-language question. No jargon, no schema words. */
  question: string;
  /** One line on why the answer matters. Shown under the question. */
  why: string;
  impact: QuestionImpact;
  score: number;
  options: ClarificationOption[];
  /** Option id applied by “Use the recommended answer” and by “Decide later”. */
  recommendedOptionId: string;
}

function titleCase(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The entity most likely to be the business's main record: most fields wins. */
function primaryEntity(draft: IntentDraft) {
  return [...draft.entities].sort((a, b) => b.fields.length - a.fields.length)[0];
}

function moneyEntities(draft: IntentDraft) {
  return draft.entities.filter((e) => e.fields.some((f) => f.type === 'money'));
}

function statusField(entity: IntentDraft['entities'][number]) {
  return entity.fields.find((f) => f.type === 'choice' && f.endStates.length);
}

/**
 * Build the ranked question list for a draft. Returns at most `limit`
 * questions — the mission is two to five, never a questionnaire.
 */
export function rankClarifications(draft: IntentDraft, limit = 5): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];
  const main = primaryEntity(draft);

  // 1. Visibility. Changes every row-level authorization check and the RLS policy.
  if (main && main.ownedByUser) {
    const label = titleCase(main.name);
    questions.push({
      id: 'visibility',
      question: `Who should be able to see every ${label.toLowerCase()}?`,
      why: 'This decides what each person sees when they sign in, and it is enforced on the server, not just hidden in the interface.',
      impact: 'permissions',
      score: IMPACT_WEIGHTS.permissions,
      recommendedOptionId: 'owner-only',
      options: [
        {
          id: 'owner-only',
          label: `Each person sees only the ${label.toLowerCase()}s they own`,
          assumption: `Assumed each person sees only their own ${label.toLowerCase()}s.`,
          ops: [
            { op: 'set-permission', entity: main.name, action: 'read', roles: [], owner: true },
          ],
        },
        {
          id: 'everyone',
          label: `Everyone signed in sees every ${label.toLowerCase()}`,
          ops: [],
        },
        {
          id: 'manager-sees-all',
          label: `Owners see their own; a manager sees all`,
          ops: [
            { op: 'add-role', role: 'manager' },
            {
              op: 'set-permission',
              entity: main.name,
              action: 'read',
              roles: ['manager'],
              owner: true,
            },
          ],
        },
      ],
    });
  }

  // 2. Roles. Without them there is one undifferentiated user and no gates.
  if (!draft.roles.length) {
    questions.push({
      id: 'roles',
      question: 'Does everyone using this app do the same job?',
      why: 'Separate roles are what let you approve, restrict, or hand off work later.',
      impact: 'permissions',
      score: IMPACT_WEIGHTS.permissions - 5,
      recommendedOptionId: 'two-roles',
      options: [
        {
          id: 'two-roles',
          label: 'No — there are staff and someone who oversees them',
          assumption: 'Assumed a staff role and a manager role.',
          ops: [
            { op: 'add-role', role: 'staff' },
            { op: 'add-role', role: 'manager' },
          ],
        },
        { id: 'one-role', label: 'Yes — everyone does the same job', ops: [] },
      ],
    });
  }

  // 3. Approval. Only asked when there is money moving through a workflow.
  for (const entity of moneyEntities(draft)) {
    const status = statusField(entity);
    if (!status) continue;
    const label = titleCase(entity.name).toLowerCase();
    questions.push({
      id: `approval:${entity.name}`,
      question: `Does a large ${label} need someone else to approve it?`,
      why: 'An approval step adds a stage, a permission, and a rule the server enforces — it is much cheaper to decide now than to retrofit.',
      impact: 'invariant',
      score: IMPACT_WEIGHTS.invariant + 5,
      recommendedOptionId: 'no-approval',
      options: [
        {
          id: 'no-approval',
          label: 'No — anyone who owns it can complete it',
          assumption: `Assumed no approval step on ${label}s.`,
          ops: [],
        },
        {
          id: 'manager-approval',
          label: 'Yes — a manager has to approve it first',
          ops: [
            { op: 'add-role', role: 'manager' },
            {
              op: 'add-status',
              entity: entity.name,
              field: status.name,
              status: 'PENDING_APPROVAL',
              after: status.choices[0]?.toUpperCase() ?? '',
            },
          ],
        },
      ],
    });
  }

  // 4. Workflow presence. Changes the data model and every list screen.
  if (main && !statusField(main)) {
    const label = titleCase(main.name).toLowerCase();
    questions.push({
      id: `workflow:${main.name}`,
      question: `Does a ${label} move through stages, or is it either done or not?`,
      why: 'Stages give you a pipeline view and let rules depend on where something is.',
      impact: 'workflow',
      score: IMPACT_WEIGHTS.workflow,
      recommendedOptionId: 'stages',
      options: [
        {
          id: 'stages',
          label: 'It moves through stages',
          assumption: `Assumed ${label}s move through New, In progress and Done.`,
          ops: [],
        },
        { id: 'binary', label: 'It is either open or closed', ops: [] },
      ],
    });
  }

  // 5. History. Cheap to add now, a migration later.
  if (moneyEntities(draft).length) {
    questions.push({
      id: 'history',
      question: 'Do you need a record of who changed what, and when?',
      why: 'An audit trail has to be written as changes happen; it cannot be reconstructed later.',
      impact: 'data-model',
      score: IMPACT_WEIGHTS['data-model'] - 20,
      recommendedOptionId: 'audit-on',
      options: [
        {
          id: 'audit-on',
          label: 'Yes — keep a history of important changes',
          assumption: 'Assumed an audit trail is wanted.',
          ops: [],
        },
        { id: 'audit-off', label: 'No — current state is enough', ops: [] },
      ],
    });
  }

  return questions.sort((a, b) => b.score - a.score).slice(0, limit);
}

export interface ClarificationAnswer {
  questionId: string;
  /** `null` means "Decide later" — the recommended option is recorded as an assumption. */
  optionId: string | null;
}

export interface AnsweredClarifications {
  ops: ContractOp[];
  /** Assumptions to record for questions the user deferred. */
  assumptions: { questionId: string; statement: string }[];
  /** Questions answered explicitly, so their clauses count as confirmed intent. */
  confirmed: string[];
}

/** Turn answers into ops plus the assumptions that must stay visible. */
export function applyClarifications(
  questions: ClarificationQuestion[],
  answers: ClarificationAnswer[],
): AnsweredClarifications {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const ops: ContractOp[] = [];
  const assumptions: AnsweredClarifications['assumptions'] = [];
  const confirmed: string[] = [];

  for (const answer of answers) {
    const question = byId.get(answer.questionId);
    if (!question) continue;
    const chosenId = answer.optionId ?? question.recommendedOptionId;
    const option = question.options.find((o) => o.id === chosenId);
    if (!option) continue;
    ops.push(...option.ops);
    if (answer.optionId === null) {
      assumptions.push({
        questionId: question.id,
        statement: option.assumption ?? `Assumed: ${option.label}.`,
      });
    } else {
      confirmed.push(question.id);
    }
  }

  // Unanswered questions still produce a visible assumption — silence is never
  // treated as agreement.
  for (const question of questions) {
    if (answers.some((a) => a.questionId === question.id)) continue;
    const option = question.options.find((o) => o.id === question.recommendedOptionId);
    if (!option) continue;
    assumptions.push({
      questionId: question.id,
      statement: option.assumption ?? `Assumed: ${option.label}.`,
    });
  }

  return { ops, assumptions, confirmed };
}
