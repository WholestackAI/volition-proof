/**
 * Layered diagnostics.
 *
 * A compiler diagnostic answers "what is malformed". A person needs four more
 * answers: why it matters, where it is in *their* words, what the safest fix
 * is, and what that fix will change. This module adds those layers on top of
 * the real diagnostic — it never replaces or suppresses it. The original
 * compiler text is always carried in `advanced`.
 *
 * Explanations are keyed on stable diagnostic codes from `@isl-lang/parser` and
 * `@isl-lang/typechecker`. An unknown code degrades to the raw message rather
 * than inventing an explanation.
 */

import type { Diagnostic } from '@isl-lang/parser';
import { humanizeIdentifier } from '../canonical/expression.js';
import type { AppContract, ClauseId } from '../canonical/types.js';
import type { ContractOp } from '../patch/ops.js';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface SuggestedFix {
  id: string;
  title: string;
  /**
   * `true` when the repair is computed from the contract itself. `false` marks
   * an AI suggestion, which must still go through patch validation and is
   * labelled differently in the interface.
   */
  deterministic: boolean;
  /** One line describing the consequence, shown before the user accepts. */
  willChange: string;
  /** Ops to apply. Empty when the fix needs a decision the system cannot make. */
  ops: ContractOp[];
}

export interface FriendlyDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  /** What is wrong, in the user's vocabulary. */
  what: string;
  /** Why it matters. */
  why: string;
  where: { line: number; column: number; clauseId?: ClauseId };
  fixes: SuggestedFix[];
  /** Verbatim compiler output, behind a disclosure control. */
  advanced: string;
}

interface Explanation {
  what: (d: Diagnostic) => string;
  why: string;
}

/**
 * Only codes we can honestly explain are listed. Everything else falls through
 * to the compiler's own message — a wrong explanation is worse than none.
 */
const EXPLANATIONS: Record<string, Explanation> = {
  ISL_T011: {
    what: (d) => `This refers to a record type that does not exist: ${quoted(d)}.`,
    why: 'The app cannot store or show something it has no definition for, so nothing downstream can be generated for it.',
  },
  ISL_T012: {
    what: (d) => `This refers to a field that does not exist: ${quoted(d)}.`,
    why: 'A rule that reads a field the record does not have can never be checked, so it would silently never fire.',
  },
  ISL_T015: {
    what: (d) => `This uses a status that is not in the list of stages: ${quoted(d)}.`,
    why: 'Stages are a closed list. A stage that is not declared cannot be reached, so the step you described would be dead.',
  },
  ISL_T021: {
    what: (d) => `Two record types have the same name: ${quoted(d)}.`,
    why: 'Names are how screens, tables and permissions are matched up, so duplicates make the result ambiguous.',
  },
  ISL_T022: {
    what: (d) => `A record lists the same field twice: ${quoted(d)}.`,
    why: 'The database column can only be created once, so the second definition would be dropped without warning.',
  },
  ISL_T051: {
    what: () => 'This step moves a record to a stage it cannot reach from where it is.',
    why: 'Workflow steps are enforced on the server. An unreachable step means the button exists but the action always fails.',
  },
  ISL_T052: {
    what: (d) => `This step names a stage that does not exist: ${quoted(d)}.`,
    why: 'Add the stage or point the step at one that already exists — otherwise the workflow has a dead end.',
  },
  ISL_T121: {
    what: () => 'This record has no rule saying who is allowed to read or change it.',
    why: 'With nothing declared, the safe default is used and nobody outside the owner can see it. If that is not what you meant, say who should.',
  },
  ISL_T122: {
    what: () => 'This record is owned by a person, but there is nobody for it to belong to.',
    why: 'Ownership is what every per-person visibility rule is checked against; without it, those rules cannot be enforced.',
  },
  ISL_T130: {
    what: () => 'An amount of money is stored as a decimal that cannot represent cents exactly.',
    why: 'Rounding errors in money are permanent once written. Amounts are stored in whole cents instead.',
  },
  ISL_T133: {
    what: () => 'A payable amount is not stored in cents.',
    why: 'The payment processor charges in minor units. A mismatch here charges the customer the wrong amount.',
  },
  E0201: {
    what: (d) => `This uses a type the app does not know: ${quoted(d)}.`,
    why: 'Every field needs a type the database and the interface both understand.',
  },
  E0300: {
    what: (d) => `This refers to something that is not defined anywhere: ${quoted(d)}.`,
    why: 'Nothing can be generated for a name with no definition behind it.',
  },
};

function quoted(d: Diagnostic): string {
  const match = d.message.match(/["'“]([^"'”]+)["'”]/);
  return match?.[1] ? `“${humanizeIdentifier(match[1])}”` : 'it';
}

function severityOf(d: Diagnostic): DiagnosticSeverity {
  return d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info';
}

/**
 * The first capitalised word in a diagnostic that is actually a record type in
 * this contract. Messages start with words like "Entity" or "Unknown", so
 * taking the first capitalised token alone picks the wrong name.
 */
function entityMentionedIn(message: string, contract: AppContract): string | undefined {
  const known = new Set(
    contract.clauses.filter((c) => c.kind === 'entity').map((c) => c.id.slice('entity:'.length)),
  );
  for (const match of message.matchAll(/\b([A-Z][A-Za-z0-9]*)\b/g)) {
    const name = match[1];
    if (name && known.has(name)) return name;
  }
  return undefined;
}

/**
 * Deterministic repairs. Each one is derived from the contract, so it can be
 * offered as a one-click fix that still goes through `applyPatch` validation.
 */
function deterministicFixes(d: Diagnostic, contract: AppContract | undefined): SuggestedFix[] {
  if (!contract) return [];
  const fixes: SuggestedFix[] = [];

  if (d.code === 'ISL_T052' || d.code === 'ISL_T015') {
    const missing = d.message.match(/["'“]([A-Z_][A-Z0-9_]*)["'”]/)?.[1];
    const entity = entityMentionedIn(d.message, contract);
    const statusClause = contract.clauses.find(
      (c) => c.kind === 'status-set' && (!entity || c.id.startsWith(`status-set:${entity}.`)),
    );
    const field = statusClause?.id.split('.')[1];
    if (missing && entity && field) {
      fixes.push({
        id: 'add-missing-status',
        title: `Add “${humanizeIdentifier(missing)}” as a stage`,
        deterministic: true,
        willChange: `${entity} gains one stage. Existing records keep their current stage.`,
        ops: [{ op: 'add-status', entity, field, status: missing }],
      });
    }
  }

  if (d.code === 'ISL_T121') {
    const entity = entityMentionedIn(d.message, contract);
    if (entity) {
      fixes.push({
        id: 'owner-can-read',
        title: 'Let each person read the records they own',
        deterministic: true,
        willChange: `Adds one visibility rule to ${entity}. Enforced on the server and in the interface.`,
        ops: [{ op: 'set-permission', entity, action: 'read', roles: [], owner: true }],
      });
    }
  }

  return fixes;
}

/** Add the human layers to one diagnostic. */
export function explainDiagnostic(
  diagnostic: Diagnostic,
  contract?: AppContract,
): FriendlyDiagnostic {
  const explanation = EXPLANATIONS[diagnostic.code];
  const line = diagnostic.location?.line ?? 1;
  const clause = contract?.clauses.find(
    (c) => c.location && c.location.line <= line && line <= (c.location.endLine || c.location.line),
  );
  return {
    code: diagnostic.code,
    severity: severityOf(diagnostic),
    what: explanation ? explanation.what(diagnostic) : diagnostic.message,
    why: explanation
      ? explanation.why
      : 'The compiler could not accept this, so nothing was generated from it.',
    where: {
      line,
      column: diagnostic.location?.column ?? 1,
      ...(clause ? { clauseId: clause.id } : {}),
    },
    fixes: deterministicFixes(diagnostic, contract),
    advanced: `${diagnostic.code}: ${diagnostic.message}`,
  };
}

export function explainDiagnostics(
  diagnostics: Diagnostic[],
  contract?: AppContract,
): FriendlyDiagnostic[] {
  return diagnostics.map((d) => explainDiagnostic(d, contract));
}

/** True when we have a real explanation rather than a passthrough. */
export function hasExplanation(code: string): boolean {
  return code in EXPLANATIONS;
}
