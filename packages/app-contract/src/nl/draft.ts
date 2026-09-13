/**
 * Natural-language intake — the strict boundary the model writes into.
 *
 * A model never writes ISL, code, or files. It fills in this schema and nothing
 * else. Everything after this point is deterministic: normalisation,
 * contradiction detection, ISL emission, parsing, validation. Malformed model
 * output is rejected here and can never reach canonical project state.
 *
 * Every element carries its own `source` and `confidence`, so an inferred
 * entity is distinguishable from one the user actually asked for — for the
 * lifetime of the project, not just during intake.
 */

import { z } from 'zod';

/** Field types the intake layer accepts. Deliberately small and business-facing. */
export const DRAFT_FIELD_TYPES = [
  'text',
  'long-text',
  'number',
  'money',
  'yes-no',
  'date',
  'date-time',
  'choice',
] as const;
export type DraftFieldType = (typeof DRAFT_FIELD_TYPES)[number];

const identifier = z
  .string()
  .min(1)
  .max(60)
  .regex(
    /^[A-Za-z][A-Za-z0-9 _-]*$/,
    'must start with a letter and contain only letters, numbers, spaces, - or _',
  );

export const DraftOriginSchema = z.enum(['user', 'inferred', 'template', 'imported', 'system']);

const provenance = {
  source: DraftOriginSchema.default('inferred'),
  confidence: z.number().min(0).max(1).default(0.6),
  /** The user's own words that produced this element, when quotable. */
  originalText: z.string().max(2000).optional(),
};

export const DraftFieldSchema = z.object({
  name: identifier,
  type: z.enum(DRAFT_FIELD_TYPES),
  optional: z.boolean().default(false),
  searchable: z.boolean().default(false),
  /** Required when `type` is `choice`; the ordered stages or options. */
  choices: z.array(identifier).max(24).default([]),
  /** Choices that end the workflow. Must be a subset of `choices`. */
  endStates: z.array(identifier).max(8).default([]),
  ...provenance,
});
export type DraftField = z.infer<typeof DraftFieldSchema>;

export const DraftEntitySchema = z.object({
  name: identifier,
  /** One-line plain-English description of what this record is. */
  description: z.string().max(300).default(''),
  fields: z.array(DraftFieldSchema).min(1).max(40),
  /** Each record belongs to the person who created it. */
  ownedByUser: z.boolean().default(true),
  /** Other entity names this record links to. */
  linksTo: z.array(identifier).max(8).default([]),
  ...provenance,
});
export type DraftEntity = z.infer<typeof DraftEntitySchema>;

export const DraftRoleSchema = z.object({
  name: identifier,
  description: z.string().max(300).default(''),
  ...provenance,
});
export type DraftRole = z.infer<typeof DraftRoleSchema>;

export const DraftReportSchema = z.object({
  name: identifier,
  entity: identifier,
  /** `count`, or `sum(field)` / `avg(field)` / `min(field)` / `max(field)`. */
  measures: z.array(z.string().max(60)).min(1).max(6),
  groupBy: identifier.optional(),
  ...provenance,
});
export type DraftReport = z.infer<typeof DraftReportSchema>;

/**
 * A rule the user stated in words. Intake deliberately does NOT compile these:
 * a rule becomes a contract clause only through a validated semantic patch the
 * user has seen. Keeping them as text here is what stops a hallucinated
 * predicate from silently becoming enforcement.
 */
export const DraftRuleSchema = z.object({
  statement: z.string().min(3).max(400),
  ...provenance,
});
export type DraftRule = z.infer<typeof DraftRuleSchema>;

export const DraftAssumptionSchema = z.object({
  about: z.string().max(120),
  statement: z.string().min(3).max(400),
  rationale: z.string().max(400).default(''),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type DraftAssumption = z.infer<typeof DraftAssumptionSchema>;

export const IntentDraftSchema = z.object({
  appName: identifier,
  purpose: z.string().min(3).max(400),
  roles: z.array(DraftRoleSchema).max(12).default([]),
  entities: z.array(DraftEntitySchema).min(1).max(24),
  reports: z.array(DraftReportSchema).max(12).default([]),
  rules: z.array(DraftRuleSchema).max(24).default([]),
  integrations: z.array(identifier).max(12).default([]),
  assumptions: z.array(DraftAssumptionSchema).max(24).default([]),
});
export type IntentDraft = z.infer<typeof IntentDraftSchema>;

/** JSON Schema handed to the model as the response format. Versioned. */
export const INTENT_DRAFT_SCHEMA_VERSION = 'intent-draft/1' as const;

export type DraftValidation =
  { ok: true; draft: IntentDraft; warnings: string[] } | { ok: false; errors: string[] };

/**
 * Parse and normalise raw model output. Rejects anything the schema does not
 * accept; repairs only things that are unambiguously mechanical (casing,
 * duplicate names, whitespace).
 */
export function validateIntentDraft(raw: unknown): DraftValidation {
  const parsed = IntentDraftSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    };
  }
  return normalizeDraft(parsed.data);
}

function pascal(value: string): string {
  return value
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

function camel(value: string): string {
  const p = pascal(value);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

function snake(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/**
 * Terminology normalisation. Models say "Sales Rep", "sales rep" and
 * "sales_rep" in one response; downstream identity is name-derived, so a single
 * spelling has to win before anything is projected.
 */
export function normalizeDraft(draft: IntentDraft): DraftValidation {
  const warnings: string[] = [];

  const entityNames = new Map<string, string>();
  const entities: DraftEntity[] = [];
  for (const entity of draft.entities) {
    const name = pascal(entity.name);
    if (entityNames.has(name.toLowerCase())) {
      warnings.push(`Dropped a duplicate “${entity.name}” record type.`);
      continue;
    }
    entityNames.set(name.toLowerCase(), name);

    const fieldNames = new Set<string>();
    const fields: DraftField[] = [];
    for (const field of entity.fields) {
      const fieldName = camel(field.name);
      if (fieldNames.has(fieldName.toLowerCase())) {
        warnings.push(`Dropped a duplicate “${field.name}” field on ${name}.`);
        continue;
      }
      fieldNames.add(fieldName.toLowerCase());
      const choices = field.type === 'choice' ? field.choices.map(snake).filter(Boolean) : [];
      const endStates = field.endStates.map(snake).filter((s) => choices.includes(s));
      if (field.type === 'choice' && !choices.length) {
        warnings.push(`“${field.name}” on ${name} had no options and became plain text.`);
        fields.push({ ...field, name: fieldName, type: 'text', choices: [], endStates: [] });
        continue;
      }
      if (field.endStates.length !== endStates.length) {
        warnings.push(
          `Ignored end states on ${name}.${fieldName} that are not in its option list.`,
        );
      }
      fields.push({ ...field, name: fieldName, choices, endStates });
    }
    if (!fields.length) {
      warnings.push(`Dropped “${entity.name}” because it had no usable fields.`);
      continue;
    }
    entities.push({ ...entity, name, fields, linksTo: entity.linksTo.map(pascal) });
  }

  if (!entities.length) {
    return { ok: false, errors: ['The draft has no usable record types.'] };
  }

  // Links must resolve; an unresolved link is a contradiction, not a warning we
  // can compile past.
  const resolvedEntities = entities.map((entity) => {
    const linksTo = entity.linksTo.filter((link) => {
      const known = entityNames.has(link.toLowerCase());
      if (!known)
        warnings.push(`${entity.name} linked to “${link}”, which does not exist — link removed.`);
      return known && link !== entity.name;
    });
    return { ...entity, linksTo };
  });

  const roleNames = new Set<string>();
  const roles: DraftRole[] = [];
  for (const role of draft.roles) {
    const name = snake(role.name);
    if (roleNames.has(name)) {
      warnings.push(`Dropped a duplicate “${role.name}” role.`);
      continue;
    }
    roleNames.add(name);
    roles.push({ ...role, name });
  }

  const reports: DraftReport[] = [];
  for (const report of draft.reports) {
    const entity = entityNames.get(pascal(report.entity).toLowerCase());
    if (!entity) {
      warnings.push(`Dropped the “${report.name}” report — it referenced an unknown record type.`);
      continue;
    }
    const measures = report.measures
      .map((m) => m.trim())
      .filter((m) => /^count$/i.test(m) || /^(sum|avg|min|max)\(\s*[A-Za-z_]\w*\s*\)$/i.test(m));
    if (measures.length !== report.measures.length) {
      warnings.push(
        `The “${report.name}” report had measures that are not count/sum/avg/min/max — they were dropped.`,
      );
    }
    if (!measures.length) continue;
    reports.push({
      ...report,
      name: pascal(report.name),
      entity,
      measures,
      ...(report.groupBy ? { groupBy: camel(report.groupBy) } : {}),
    });
  }

  return {
    ok: true,
    warnings,
    draft: {
      ...draft,
      appName: pascal(draft.appName),
      entities: resolvedEntities,
      roles,
      reports,
    },
  };
}

/**
 * Words that mark the subject of a business rule. A rule almost always reads
 * "<who> <modal|verb> <what>", so the phrase in front of one of these is the
 * actor the rule is about.
 */
const RULE_VERBS =
  /\b([A-Za-z]+(?:[ _][A-Za-z]+)?)\s+(?:can|cannot|can[’']t|must|may|should|needs?|only|sees?|views?|approves?|owns?)\b/gi;

const NOT_ACTORS = new Set([
  // determiners and pronouns
  'the',
  'a',
  'an',
  'this',
  'that',
  'it',
  'they',
  'we',
  'you',
  'who',
  'nobody',
  'anyone',
  'everyone',
  'their',
  'his',
  'her',
  'its',
  'our',
  'your',
  // the marker words themselves — a match can start on one when two appear in a row
  'can',
  'cannot',
  'must',
  'may',
  'should',
  'need',
  'needs',
  'only',
  'see',
  'sees',
  'view',
  'views',
  'approve',
  'approves',
  'own',
  'owns',
]);

/** Singular, snake-cased actor names a rule statement refers to. */
export function actorsMentionedIn(statement: string): string[] {
  const out = new Set<string>();
  for (const match of statement.matchAll(RULE_VERBS)) {
    const words = snake(match[1] ?? '')
      .split('_')
      .filter(Boolean);
    if (!words.length || words.some((w) => NOT_ACTORS.has(w))) continue;
    // Only the head noun is plural: "sales reps" → "sales rep", not "sale rep".
    const head = words[words.length - 1]!;
    const singular =
      head.length > 3 && head.endsWith('s') && !head.endsWith('ss') ? head.slice(0, -1) : head;
    out.add([...words.slice(0, -1), singular].join('_'));
  }
  return [...out];
}

export interface DraftContradiction {
  /** Plain-English statement of the conflict. */
  message: string;
  /** Which part of the draft it concerns. */
  about: string;
  severity: 'blocking' | 'warning';
}

/**
 * Contradictions the deterministic layer can see without an AI call. These are
 * shown before any build, because each one means the draft says two
 * incompatible things about the same business.
 */
export function detectContradictions(draft: IntentDraft): DraftContradiction[] {
  const found: DraftContradiction[] = [];
  const roleNames = new Set(draft.roles.map((r) => r.name.toLowerCase()));

  for (const entity of draft.entities) {
    const statusFields = entity.fields.filter((f) => f.type === 'choice' && f.endStates.length);
    if (statusFields.length > 1) {
      found.push({
        about: entity.name,
        severity: 'warning',
        message: `${entity.name} has more than one field that ends a workflow (${statusFields
          .map((f) => f.name)
          .join(', ')}). Only one status can drive its lifecycle.`,
      });
    }
    for (const field of statusFields) {
      if (field.endStates.length === field.choices.length) {
        found.push({
          about: `${entity.name}.${field.name}`,
          severity: 'blocking',
          message: `Every stage of ${entity.name}.${field.name} is an end state, so a record could never move forward.`,
        });
      }
    }
  }

  for (const rule of draft.rules) {
    for (const candidate of actorsMentionedIn(rule.statement)) {
      if (roleNames.has(candidate)) continue;
      if (draft.entities.some((e) => e.name.toLowerCase() === candidate.replace(/_/g, '')))
        continue;
      found.push({
        about: 'rules',
        severity: 'warning',
        message: `The rule “${rule.statement}” talks about “${candidate.replace(/_/g, ' ')}”, which is not a role in this app yet.`,
      });
    }
  }

  if (draft.roles.length === 0 && draft.entities.some((e) => e.ownedByUser)) {
    found.push({
      about: 'people',
      severity: 'warning',
      message:
        'Records have owners, but no roles are defined, so everyone who signs in has the same access.',
    });
  }

  return found;
}
