/**
 * Draft → canonical ISL, deterministically.
 *
 * The model produced a validated `IntentDraft`; this projects it through the
 * same Mini-ISL expander the rest of the system uses, so an AI-authored app and
 * a hand-authored one land on identical ISL constructs. No template strings
 * specific to any vertical, and no second expander.
 */

import { expandMiniIsl } from '../blueprint/mini.js';
import { parseAppContract, type ParseContractResult } from '../canonical/parse.js';
import type { AppContract, ClauseMeta, ContractMeta } from '../canonical/types.js';
import { APP_CONTRACT_SCHEMA_VERSION, defaultClauseMeta } from '../canonical/types.js';
import type { DraftField, IntentDraft } from './draft.js';

const MINI_TYPE: Record<DraftField['type'], string> = {
  text: 'string',
  'long-text': 'text',
  number: 'int',
  money: 'int',
  'yes-no': 'bool',
  date: 'date',
  'date-time': 'timestamp',
  choice: 'choice',
};

/** `amount` + type `money` → `amountCents`, the minor-unit convention the codegen expects. */
function fieldName(field: DraftField): string {
  if (field.type !== 'money') return field.name;
  return /cents$/i.test(field.name) ? field.name : `${field.name}Cents`;
}

function renderField(field: DraftField): string {
  const name = fieldName(field);
  if (field.type === 'choice') {
    const terminal = field.endStates.length ? ` terminal:${field.endStates.join(',')}` : '';
    return `${name}:[${field.choices.join(',')}]${terminal}`;
  }
  const type = MINI_TYPE[field.type];
  const optional = field.optional ? '?' : '';
  const search = field.searchable ? ' [search]' : '';
  return `${name}:${type}${optional}${search}`;
}

/** Project a validated draft into Mini-ISL. */
export function draftToMini(draft: IntentDraft): string {
  const lines: string[] = [`app ${draft.appName}`, ''];
  for (const entity of draft.entities) {
    const fields = entity.fields.map(renderField).join(', ');
    const modifiers = [entity.ownedByUser ? 'owned' : '', ...entity.linksTo.map((l) => `->${l}`)]
      .filter(Boolean)
      .join('  ');
    lines.push(`${entity.name} { ${fields} }${modifiers ? `  ${modifiers}` : ''}`);
  }
  if (draft.reports.length) {
    lines.push('');
    for (const report of draft.reports) {
      const by = report.groupBy ? ` by ${report.groupBy}` : '';
      lines.push(`view ${report.name} = ${report.entity} ${report.measures.join(', ')}${by}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export type DraftToContractResult =
  | { ok: true; contract: AppContract; islSource: string; mini: string; warnings: string[] }
  | { ok: false; errors: string[]; mini: string; islSource: string };

/**
 * Build a canonical contract from a validated draft, stamping provenance from
 * the draft so the Blueprint can show which clauses were inferred.
 */
export function draftToContract(draft: IntentDraft): DraftToContractResult {
  const mini = draftToMini(draft);
  const expanded = expandMiniIsl(mini);
  if (!expanded.isl) {
    return { ok: false, errors: expanded.errors, mini, islSource: '' };
  }
  const parsed: ParseContractResult = parseAppContract(expanded.isl);
  if (!parsed.ok) {
    return {
      ok: false,
      errors: parsed.diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => `${d.code}: ${d.message}`),
      mini,
      islSource: expanded.isl,
    };
  }

  const contract = parsed.contract;
  contract.meta = provenanceFromDraft(draft, contract);
  return { ok: true, contract, islSource: expanded.isl, mini, warnings: expanded.errors };
}

/**
 * Map draft provenance onto clause ids. Anything the draft did not explicitly
 * account for (compiler plumbing, injected principals, derived transitions) is
 * `system` — it was never claimed to be the user's intent.
 */
function provenanceFromDraft(draft: IntentDraft, contract: AppContract): ContractMeta {
  const clauses: Record<string, ClauseMeta> = {};
  const stamp = (id: string, meta: ClauseMeta) => {
    clauses[id] = meta;
  };

  const entityMeta = new Map(
    draft.entities.map((e) => [
      e.name,
      defaultClauseMeta(e.source, 0, {
        confidence: e.confidence,
        confirmed: e.source === 'user',
        ...(e.originalText ? { originalText: e.originalText } : {}),
      }),
    ]),
  );

  for (const clause of contract.clauses) {
    if (clause.id === 'app') {
      stamp(clause.id, defaultClauseMeta('user', 0, { confirmed: true, confidence: 1 }));
      continue;
    }
    const entityMatch = clause.id.match(
      /^(?:entity|field|relationship|status-set|transition|permission):([A-Za-z_]\w*)/,
    );
    const owner = entityMatch ? entityMeta.get(entityMatch[1]!) : undefined;

    if (clause.kind === 'field' || clause.kind === 'status-set') {
      const fieldMatch = clause.id.match(/^(?:field|status-set):([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/);
      const entity = fieldMatch ? draft.entities.find((e) => e.name === fieldMatch[1]) : undefined;
      const field = entity?.fields.find(
        (f) => f.name === fieldMatch?.[2] || `${f.name}Cents` === fieldMatch?.[2],
      );
      if (field) {
        stamp(
          clause.id,
          defaultClauseMeta(field.source, 0, {
            confidence: field.confidence,
            confirmed: field.source === 'user',
            ...(field.originalText ? { originalText: field.originalText } : {}),
          }),
        );
        continue;
      }
    }

    if (owner) {
      stamp(clause.id, { ...owner });
      continue;
    }
    stamp(clause.id, defaultClauseMeta('system', 0));
  }

  for (const role of draft.roles) {
    const id = `role:${role.name}`;
    if (contract.clauses.some((c) => c.id === id)) {
      stamp(
        id,
        defaultClauseMeta(role.source, 0, {
          confidence: role.confidence,
          confirmed: role.source === 'user',
        }),
      );
    }
  }

  return { schemaVersion: APP_CONTRACT_SCHEMA_VERSION, revision: 0, clauses };
}
