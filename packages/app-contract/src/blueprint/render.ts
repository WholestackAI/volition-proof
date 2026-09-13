/**
 * Blueprint rendering — the plain-English view of the contract.
 *
 * This is a pure projection of `AppContract`: no state of its own, so the
 * Blueprint, the raw ISL editor, and the compiler cannot disagree. Every
 * rendered line carries its clause id, which is how a click in the Blueprint
 * navigates to the ISL, the generated code, and the proof for that same clause.
 */

import { titleCaseName } from '../canonical/expression.js';
import type {
  AppContract,
  BlueprintSection,
  Clause,
  ClauseId,
  ClauseMeta,
} from '../canonical/types.js';
import { BLUEPRINT_SECTIONS } from '../canonical/types.js';

export interface BlueprintLine {
  clauseId: ClauseId;
  text: string;
  detail?: string;
  /** Where this clause came from. `inferred` renders with an assumption marker. */
  source: ClauseMeta['source'];
  confidence: number;
  confirmed: boolean;
  locked: boolean;
  /** Compiler plumbing; hidden unless the reader asks for detail. */
  plumbing: boolean;
  islExcerpt: string;
  rationale?: string;
  originalText?: string;
}

export interface BlueprintSectionView {
  section: BlueprintSection;
  heading: string;
  /** Shown when the section is empty, instead of a blank panel. */
  emptyState: string;
  lines: BlueprintLine[];
}

export interface Blueprint {
  appName: string;
  title: string;
  contractHash: string;
  revision: number;
  sections: BlueprintSectionView[];
  /** Inferred, unconfirmed clauses — the honest "we guessed this" list. */
  assumptions: BlueprintLine[];
  counts: { clauses: number; assumptions: number; locked: number };
}

const HEADINGS: Record<BlueprintSection, string> = {
  overview: 'What this app does',
  people: 'People and roles',
  data: 'Data and records',
  workflows: 'Workflows and statuses',
  rules: 'Business rules',
  permissions: 'Permissions',
  screens: 'Screens and actions',
  integrations: 'Integrations and resources',
  automation: 'Notifications and automation',
  assumptions: 'Assumptions',
  proof: 'Proof requirements',
};

const EMPTY_STATES: Record<BlueprintSection, string> = {
  overview: 'Describe what this app is for.',
  people: 'Everyone signs in as the same kind of user. Add a role to separate what people can do.',
  data: 'No records yet. Add the things this business keeps track of.',
  workflows: 'Nothing moves through stages yet. Add a status to track progress.',
  rules: 'No business rules yet. Add one to say what must never happen.',
  permissions: 'Everyone who signs in can do everything. Add a permission to narrow that.',
  screens: 'No actions yet.',
  integrations: 'Not connected to anything outside this app.',
  automation: 'Nothing happens automatically yet.',
  assumptions: 'Nothing was assumed — every rule here came from you.',
  proof: 'Nothing has been proven yet. Build the app to generate evidence.',
};

function toLine(clause: Clause, meta: ClauseMeta | undefined): BlueprintLine {
  return {
    clauseId: clause.id,
    text: clause.title,
    ...(clause.detail ? { detail: clause.detail } : {}),
    source: meta?.source ?? 'system',
    confidence: meta?.confidence ?? 1,
    confirmed: meta?.confirmed ?? false,
    locked: meta?.locked ?? false,
    plumbing: clause.plumbing === true,
    islExcerpt: clause.islExcerpt,
    ...(meta?.rationale ? { rationale: meta.rationale } : {}),
    ...(meta?.originalText ? { originalText: meta.originalText } : {}),
  };
}

export interface RenderBlueprintOptions {
  /** Include surrogate keys and audit stamps. Off by default. */
  includePlumbing?: boolean;
}

export function renderBlueprint(
  contract: AppContract,
  options: RenderBlueprintOptions = {},
): Blueprint {
  const lines = contract.clauses
    .filter((c) => options.includePlumbing || !c.plumbing)
    .map((c) => toLine(c, contract.meta.clauses[c.id]));

  const sections = BLUEPRINT_SECTIONS.filter((s) => s !== 'assumptions').map((section) => ({
    section,
    heading: HEADINGS[section],
    emptyState: EMPTY_STATES[section],
    lines: lines.filter((l) => byId(contract, l.clauseId)?.section === section),
  }));

  const assumptions = lines.filter((l) => l.source === 'inferred' && !l.confirmed);

  return {
    appName: contract.appName,
    title: titleCaseName(contract.appName),
    contractHash: contract.contractHash,
    revision: contract.meta.revision,
    sections,
    assumptions,
    counts: {
      clauses: lines.length,
      assumptions: assumptions.length,
      locked: lines.filter((l) => l.locked).length,
    },
  };
}

function byId(contract: AppContract, id: ClauseId): Clause | undefined {
  return contract.clauses.find((c) => c.id === id);
}

/** Plain-text Blueprint — what `zeta blueprint` prints and what a doc export contains. */
export function renderBlueprintText(blueprint: Blueprint): string {
  const out: string[] = [blueprint.title, '='.repeat(blueprint.title.length), ''];
  for (const section of blueprint.sections) {
    if (!section.lines.length) continue;
    out.push(section.heading, '-'.repeat(section.heading.length));
    for (const line of section.lines) {
      const markers = [
        line.source === 'inferred' && !line.confirmed ? 'assumed' : '',
        line.locked ? 'locked' : '',
      ].filter(Boolean);
      out.push(`- ${line.text}${markers.length ? `  (${markers.join(', ')})` : ''}`);
      if (line.detail) out.push(`    ${line.detail}`);
    }
    out.push('');
  }
  if (blueprint.assumptions.length) {
    out.push(HEADINGS.assumptions, '-'.repeat(HEADINGS.assumptions.length));
    for (const line of blueprint.assumptions) {
      out.push(`- ${line.text}`);
      if (line.rationale) out.push(`    Why: ${line.rationale}`);
    }
    out.push('');
  }
  out.push(`Contract ${blueprint.contractHash} · revision ${blueprint.revision}`);
  return out.join('\n');
}
