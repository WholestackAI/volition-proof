/**
 * Mini-ISL — the human-friendly *authoring projection* over canonical ISL.
 *
 * This is a projection, not a second language: it expands deterministically to
 * the same ISL the parser and every downstream compiler already consume, and
 * `renderMini` in `./mini-render.ts` projects a canonical contract back to it.
 * It moved here from `apps/web/lib/zeta-build/mini-isl.ts` (which now re-exports
 * this module) so the web app, the CLI, and the contract engine share one
 * implementation instead of drifting copies.
 *
 * Original description follows.
 *
 * Mini-ISL — a terse shorthand that expands to full ISL.
 *
 * You write only what's distinctive about your domain; the expander infers all the
 * boilerplate every entity always has (a uuid primary key, an `ownerId` FK to the
 * `User` principal when `owned`, a `createdAt` timestamp), a default `User` entity if
 * you don't declare one, and enum declarations for inline `[a,b,c]` choice fields. The
 * resulting ISL feeds the normal pipeline unchanged — so the auto dashboard, charts,
 * settings, notifications, chat, team + billing surfaces all come for free.
 *
 * Grammar (one entity per line):
 *
 *     app TaskFlow                                   # optional domain name
 *
 *     Task    { title, status:[todo,doing,done], due:date, notes:text? }  owned
 *     Project { name, color }                                             owned
 *     Comment { body }  owned  ->Task                # ->Ref adds a refId FK
 *
 *     roles sales_rep, manager                       # the closed role set
 *     Estimate { title }  owned  read:manager|owner  write:manager
 *
 *   field forms:  name            → String (required)
 *                 name:type       → typed (string/text/int/decimal/money/float/
 *                                    bool/date/datetime/timestamp/uuid/json)
 *                 name:type?      → optional (nullable)
 *                 name:[a,b,c]    → an enum (declared once, defaults to the first)
 *                 name:[a,b] terminal:b   → status enum with end state + lifecycle
 *                 name:[a,b] reopen:b     → status enum with b → a return edge
 *                 name:[a,b,c] terminal:b   → status enum + lifecycle + terminal end state
 *                 name:[a,b,c] reopen:b       → status enum + lifecycle + b→initial reopen arc
 *                 name:int [pay]  → a payable amount (turns on Stripe checkout)
 *   modifiers (after the `}`):  owned      → adds ownerId → User and a deny-by-default
 *                                            per-owner access policy
 *                               ->Entity   → adds a <entity>Id FK (repeatable)
 *                               read|write|delete: <role>|owner
 *                                          → one entity `permissions { }` rule.
 *                                            Roles must appear in a `roles` line
 *                                            first; an undeclared name is dropped
 *                                            with a warning, never emitted, because
 *                                            ISL checks role expressions against
 *                                            the closed role set.
 */

export interface MiniExpandResult {
  /** The expanded full ISL source (empty when `errors` is non-empty and fatal). */
  isl: string;
  /** Non-fatal warnings + fatal errors encountered while expanding. */
  errors: string[];
}

import { isLifecycleFieldName } from '../lifecycle-field.js';

const TYPE_MAP: Record<string, string> = {
  string: 'String',
  str: 'String',
  text: 'Text',
  longtext: 'Text',
  int: 'Int',
  integer: 'Int',
  number: 'Int',
  decimal: 'Decimal',
  money: 'Decimal',
  float: 'Float',
  bool: 'Boolean',
  boolean: 'Boolean',
  date: 'Date',
  datetime: 'Timestamp',
  timestamp: 'Timestamp',
  time: 'Timestamp',
  uuid: 'UUID',
  json: 'JSON',
};

const KNOWN_ANNOTATIONS = new Set(['pay', 'search', 'media', 'file', 'unique', 'indexed']);

function pascal(s: string): string {
  return s.replace(/(^\w|[-_ ]\w)/g, (m) => m.replace(/[-_ ]/, '').toUpperCase());
}
function camel(s: string): string {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
}
function snake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}
function enumVariant(s: string): string {
  return s
    .trim()
    .replace(/[-\s]+/g, '_')
    .toUpperCase();
}

interface StatusLifecycleSpec {
  /** Enum variant names in declaration order (uppercased). */
  variants: string[];
  /** Declared end-of-lifecycle states (ISL `terminal:` annotation). */
  terminals: string[];
  /** States that may transition back to the initial/default variant (`reopen:`). */
  reopen: string[];
}

interface FieldOut {
  /** The emitted ISL field line (without indentation). */
  line: string;
  /** Populated when this field is a status enum with lifecycle metadata. */
  statusLifecycle?: StatusLifecycleSpec;
}
/** One `read:`/`write:`/`delete:` rule parsed off an entity's modifier tail. */
interface PermissionOut {
  action: 'read' | 'write' | 'delete';
  /** Declared role names, in declaration order. */
  roles: string[];
  /** The literal `owner` term — the record's owner is allowed regardless of role. */
  owner: boolean;
}

interface EntityOut {
  name: string;
  owned: boolean;
  permissions: PermissionOut[];
  refs: string[];
  fields: FieldOut[];
  enums: { name: string; variants: string[] }[];
  /** fieldName (lower-cased) → emitted ISL type — lets a view's `by <col>` group
   *  dimension resolve the column's real type. */
  fieldTypes: Map<string, string>;
}

/** A parsed mini view line, expanded after all entities are known (for dim types). */
interface ViewSpec {
  name: string;
  entity: string;
  /** Aggregates: count, or sum/avg/min/max of a column. */
  aggs: { fn: 'count' | 'sum' | 'avg' | 'min' | 'max'; col?: string }[];
  /** Optional GROUP BY dimension column. */
  by?: string;
}

/** Parse `terminal:published` / `terminal:a,b` / `reopen:halted` suffixes on status enums. */
function parseStatusEnumModifiers(
  modStr: string,
  entityName: string,
  fieldName: string,
  errors: string[],
): { terminals: string[]; reopen: string[] } {
  const terminals: string[] = [];
  const reopen: string[] = [];
  for (const part of modStr.split(/\s+/).filter(Boolean)) {
    const tm = part.match(/^terminal:([a-zA-Z0-9_,-]+)$/i);
    if (tm) {
      for (const v of (tm[1] ?? '').split(',')) {
        const ev = enumVariant(v);
        if (ev) terminals.push(ev);
      }
      continue;
    }
    const rm = part.match(/^reopen:([a-zA-Z0-9_,-]+)$/i);
    if (rm) {
      for (const v of (rm[1] ?? '').split(',')) {
        const ev = enumVariant(v);
        if (ev) reopen.push(ev);
      }
      continue;
    }
    errors.push(`unknown status modifier "${part}" on "${fieldName}" in ${entityName} — ignored`);
  }
  return { terminals, reopen };
}

/**
 * Build lifecycle edges for a status enum.
 *
 * Non-terminal states form the forward workflow. Multiple terminal outcomes branch
 * from the final non-terminal state instead of being chained together; a terminal
 * may only have an outgoing edge when the author explicitly declares `reopen:`.
 */
function statusLifecycleEdges(spec: StatusLifecycleSpec): { from: string; to: string }[] {
  const edges: { from: string; to: string }[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string) => {
    const key = `${from}->${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to });
  };
  const { variants, reopen } = spec;
  const terminalSet = new Set(spec.terminals);
  const forwardStates = variants.filter((variant) => !terminalSet.has(variant));

  for (let i = 0; i < forwardStates.length - 1; i++) {
    add(forwardStates[i]!, forwardStates[i + 1]!);
  }

  const terminalBranch = forwardStates.at(-1);
  if (terminalBranch) {
    for (const terminal of variants.filter((variant) => terminalSet.has(variant))) {
      add(terminalBranch, terminal);
    }
  }

  const initial = variants[0];
  for (const r of reopen) {
    if (initial && variants.includes(r) && r !== initial) add(r, initial);
  }
  return edges;
}

/** Parse one `name … ` field token into an ISL field line + any enum it declares.
 *  `entityNames` (lower-cased) lets a `name:Entity` field resolve to a FK column. */
function parseField(
  raw: string,
  entityName: string,
  entityNames: ReadonlySet<string>,
  errors: string[],
): {
  line: string;
  enumDecl?: { name: string; variants: string[] };
  statusLifecycle?: StatusLifecycleSpec;
} | null {
  const s = raw.trim();
  if (!s) return null;

  const colon = s.indexOf(':');
  // Bare field (no type) → String; a trailing `?` makes it optional.
  if (colon === -1) {
    const optional = s.endsWith('?');
    const name = (optional ? s.slice(0, -1) : s).trim();
    if (!/^[a-zA-Z_]\w*$/.test(name)) {
      errors.push(`skipped unparseable field "${raw}" in ${entityName}`);
      return null;
    }
    return { line: `${name}: String${optional ? '?' : ''}` };
  }

  const name = s.slice(0, colon).trim();
  let rest = s.slice(colon + 1).trim();
  if (!/^[a-zA-Z_]\w*$/.test(name)) {
    errors.push(`skipped unparseable field "${raw}" in ${entityName}`);
    return null;
  }

  // Inline enum: name:[a,b,c] [terminal:published] [reopen:halted]
  // → enum + field + optional lifecycle { } with terminal: annotation.
  const enumMatch = rest.match(/^\[([^\]]*)\](?:\s+(.+))?$/);
  if (enumMatch) {
    const variants = (enumMatch[1] ?? '')
      .split(',')
      .map((v) => enumVariant(v))
      .filter(Boolean);
    if (variants.length === 0) {
      errors.push(`empty enum for "${name}" in ${entityName} — treated as String`);
      return { line: `${name}: String` };
    }
    const enumName = pascal(entityName) + pascal(name);
    const mods = enumMatch[2]?.trim()
      ? parseStatusEnumModifiers(enumMatch[2].trim(), entityName, name, errors)
      : { terminals: [] as string[], reopen: [] as string[] };
    const lifecycleSpec: StatusLifecycleSpec = { variants, ...mods };
    const ann: string[] = [`default: "${variants[0]}"`];
    if (mods.terminals.length) ann.push(`terminal: "${mods.terminals.join(', ')}"`);
    // Shared with the canonical reader — see lifecycle-field.ts.
    const isStatusField = isLifecycleFieldName(name);
    return {
      line: `${name}: ${enumName} [${ann.join(', ')}]`,
      enumDecl: { name: enumName, variants },
      ...(isStatusField && variants.length >= 2 ? { statusLifecycle: lifecycleSpec } : {}),
    };
  }

  // Trailing `[annotation]` or `[annotation:"value"]` (e.g. [search], [pay],
  // [ai:"Summarize the body"]). Matched at the END so it never collides with an
  // enum (handled above) or a `[]` array suffix (no letters inside).
  // Pull off trailing `[annotation]` / `[annotation:"value"]` brackets — possibly
  // several (e.g. `email:string [unique] [indexed]`). Each is matched at the END so it
  // never collides with an inline enum (handled above) or a `[]` array suffix (which
  // has no letters inside). `[index]` is accepted as an alias for ISL's `[indexed]`.
  const annotations: string[] = [];
  for (;;) {
    const annMatch = rest.match(/\s*\[([a-zA-Z]+)(?::\s*("(?:[^"\\]|\\.)*"|[^\]]+))?\]\s*$/);
    if (!annMatch) break;
    const ann = (annMatch[1] ?? '').toLowerCase();
    const rawVal = annMatch[2];
    if (ann === 'ai') {
      // [ai] needs an instruction string; quote a bare value, default if absent.
      const instr = rawVal
        ? rawVal.startsWith('"')
          ? rawVal
          : JSON.stringify(rawVal.trim())
        : `"Generate the ${humanizeForAi(name)}"`;
      annotations.unshift(`ai: ${instr}`);
    } else if (ann === 'index') {
      annotations.unshift('indexed');
    } else if (KNOWN_ANNOTATIONS.has(ann)) {
      annotations.unshift(ann);
    } else {
      errors.push(`unknown annotation [${annMatch[1]}] on "${name}" in ${entityName} — ignored`);
    }
    rest = rest.slice(0, annMatch.index).trim();
  }

  // Trailing `?` → optional; trailing `[]` → array.
  const optional = rest.endsWith('?');
  if (optional) rest = rest.slice(0, -1).trim();
  let isArray = false;
  if (rest.endsWith('[]')) {
    isArray = true;
    rest = rest.slice(0, -2).trim();
  }

  // Inline entity-type FK: `assignee:User` → `assigneeId: UUID [references: "User.id"]`.
  const typePascal = pascal(rest);
  if (entityNames.has(typePascal.toLowerCase())) {
    if (isArray) {
      errors.push(
        `array-of-entity "${rest}" on "${name}" in ${entityName} isn't supported (use a join entity) — emitted a single FK`,
      );
    }
    const fkName = /id$/i.test(name) ? name : `${name}Id`;
    return { line: `${fkName}: UUID${optional ? '?' : ''} [references: "${typePascal}.id"]` };
  }

  const islType = TYPE_MAP[rest.toLowerCase()];
  if (!islType) {
    errors.push(`unknown type "${rest}" on "${name}" in ${entityName} — defaulted to String`);
  }
  const annStr = annotations.length ? ` [${annotations.join(', ')}]` : '';
  return {
    line: `${name}: ${islType ?? 'String'}${optional ? '?' : ''}${isArray ? '[]' : ''}${annStr}`,
  };
}

/** A readable phrase for a default [ai] instruction, e.g. `replyDraft` → "reply draft". */
function humanizeForAi(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
}

/** Split a `{ a, b, c }` body on top-level commas (enums use `[ ]`, not `( )`, so a
 *  comma inside `[...]` must NOT split the field). Also keep `terminal:a,b,c` /
 *  `reopen:a,b` modifier value lists intact — otherwise `terminal:won,passed` was
 *  chopped into `terminal:won` + bare field `passed`, dropping the real end state. */
function splitFields(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '[') depth++;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      // Inside `terminal:a,b,c` / `reopen:x,y` — keep commas between variants.
      // Split only when the next token looks like a new `field:type` entry.
      if (/\b(terminal|reopen):[A-Za-z0-9_,-]*$/i.test(cur.trimEnd())) {
        const rest = body.slice(i + 1).trimStart();
        const nextIsField = /^[A-Za-z_]\w*\s*:/.test(rest);
        if (!nextIsField) {
          cur += ch;
          continue;
        }
      }
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.map((f) => f.trim()).filter(Boolean);
}

/**
 * Expand mini-ISL source into full ISL. Always succeeds with SOME ISL (errors carry
 * warnings); returns `isl: ""` only when no entity could be parsed at all.
 */
export function expandMiniIsl(source: string): MiniExpandResult {
  const errors: string[] = [];
  let domainName = 'App';
  const roleNames: string[] = [];
  const entities: EntityOut[] = [];
  const viewSpecs: ViewSpec[] = [];

  const lines = source.split('\n');

  // Pre-pass: collect every entity name (lower-cased) so a `field:Entity` resolves to
  // a FK. Always include the auto-injected `user` principal so `assignee:User` works
  // even when the author never declares User.
  const entityNames = new Set<string>(['user']);
  for (const rawLine of lines) {
    const m = rawLine
      .replace(/\s*(#|\/\/).*$/, '')
      .trim()
      .match(/^([A-Za-z_]\w*)\s*\{/);
    if (m?.[1]) entityNames.add(pascal(m[1]).toLowerCase());
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s*(#|\/\/).*$/, '').trim(); // strip comments
    if (!line) continue;

    const appMatch = line.match(/^app\s+([A-Za-z_]\w*)/i);
    if (appMatch) {
      domainName = pascal(appMatch[1] ?? 'App');
      continue;
    }

    // `roles sales_rep, manager` — the domain's closed role set. Without one,
    // an entity permission naming a role would reference nothing.
    const rolesMatch = line.match(/^roles\s+(.+)$/i);
    if (rolesMatch) {
      for (const raw of (rolesMatch[1] ?? '').split(',')) {
        const role = raw
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, '_');
        if (!role) continue;
        if (!/^[a-z_]\w*$/.test(role)) {
          errors.push(`skipped unusable role name "${raw.trim()}"`);
          continue;
        }
        if (!roleNames.includes(role)) roleNames.push(role);
      }
      continue;
    }

    // View:  view Name = Entity sum(col), count [by dimCol]
    const viewMatch = line.match(/^view\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s+(.+)$/i);
    if (viewMatch) {
      const vname = pascal(viewMatch[1] ?? '');
      const ventity = pascal(viewMatch[2] ?? '');
      let spec = (viewMatch[3] ?? '').trim();
      let by: string | undefined;
      const byMatch = spec.match(/\s+by\s+([A-Za-z_]\w*)\s*$/i);
      if (byMatch) {
        by = byMatch[1];
        spec = spec.slice(0, byMatch.index).trim();
      }
      const aggs: ViewSpec['aggs'] = [];
      for (const a of spec
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)) {
        const fn = a.match(/^(count|sum|avg|min|max)(?:\(\s*([A-Za-z_]\w*)\s*\))?$/i);
        if (!fn) {
          errors.push(`view ${vname}: unrecognized aggregate "${a}"`);
          continue;
        }
        const kind = (fn[1] ?? '').toLowerCase() as ViewSpec['aggs'][number]['fn'];
        if (kind !== 'count' && !fn[2]) {
          errors.push(`view ${vname}: ${kind}() needs a column`);
          continue;
        }
        aggs.push({ fn: kind, ...(fn[2] ? { col: fn[2] } : {}) });
      }
      if (aggs.length === 0) {
        errors.push(`view ${vname}: no valid aggregates — skipped`);
      } else {
        viewSpecs.push({ name: vname, entity: ventity, aggs, ...(by ? { by } : {}) });
      }
      continue;
    }

    // Entity: Name { fields } modifiers
    const ent = line.match(/^([A-Za-z_]\w*)\s*\{([^}]*)\}\s*(.*)$/);
    if (!ent) {
      errors.push(`skipped unrecognized line: ${line}`);
      continue;
    }
    const name = pascal(ent[1] ?? '');
    const body = ent[2] ?? '';
    const mods = (ent[3] ?? '').trim();

    const owned = /\bowned\b/i.test(mods);
    const refs = [...mods.matchAll(/->\s*([A-Za-z_]\w*)/g)].map((m) => pascal(m[1] ?? ''));
    // `read:manager|owner  write:manager` — one rule per action, `|`-separated
    // terms. An undeclared role is dropped with a warning rather than emitted,
    // because ISL role expressions are checked against the closed role set.
    const permissions: PermissionOut[] = [];
    for (const m of mods.matchAll(
      /\b(read|write|delete)\s*:\s*([A-Za-z_|\s]+?)(?=\s+(?:read|write|delete)\s*:|\s*$)/gi,
    )) {
      const action = (m[1] ?? '').toLowerCase() as PermissionOut['action'];
      if (permissions.some((p) => p.action === action)) continue;
      const terms = (m[2] ?? '')
        .split('|')
        .map((t) =>
          t
            .trim()
            .toLowerCase()
            .replace(/[\s-]+/g, '_'),
        )
        .filter(Boolean);
      const rule: PermissionOut = { action, roles: [], owner: false };
      for (const term of terms) {
        if (term === 'owner') {
          rule.owner = true;
        } else if (roleNames.includes(term)) {
          rule.roles.push(term);
        } else {
          errors.push(`${name}: ${action} permission names undeclared role "${term}" — dropped`);
        }
      }
      if (rule.roles.length || rule.owner) permissions.push(rule);
      else errors.push(`${name}: ${action} permission had no usable terms — dropped`);
    }

    const fields: FieldOut[] = [];
    const enums: { name: string; variants: string[] }[] = [];
    for (const f of splitFields(body)) {
      const parsed = parseField(f, name, entityNames, errors);
      if (!parsed) continue;
      fields.push({
        line: parsed.line,
        ...(parsed.statusLifecycle ? { statusLifecycle: parsed.statusLifecycle } : {}),
      });
      if (parsed.enumDecl) enums.push(parsed.enumDecl);
    }
    // Column → ISL type, for resolving a view's `by <col>` group dimension.
    const fieldTypes = new Map<string, string>([
      ['id', 'UUID'],
      ['createdat', 'Timestamp'],
    ]);
    if (owned) fieldTypes.set('ownerid', 'UUID');
    for (const ref of refs) fieldTypes.set(`${camel(ref)}id`.toLowerCase(), 'UUID');
    for (const f of fields) {
      const fm = f.line.match(/^(\w+):\s*([A-Za-z]\w*(?:\[\])?)/);
      if (fm?.[1] && fm[2]) fieldTypes.set(fm[1].toLowerCase(), fm[2]);
    }
    entities.push({ name, owned, permissions, refs, fields, enums, fieldTypes });
  }

  if (entities.length === 0) {
    return { isl: '', errors: [...errors, 'no entities found in mini-ISL'] };
  }

  // Ensure a User principal exists (every owned entity FKs it; the platform surfaces
  // need it). If the author declared one, keep theirs.
  const hasUser = entities.some((e) => e.name.toLowerCase() === 'user');

  const enumDecls = new Map<string, string[]>();
  for (const e of entities) for (const en of e.enums) enumDecls.set(en.name, en.variants);

  const out: string[] = [`domain ${domainName} version "1.0.0"`, ''];

  if (roleNames.length) {
    out.push(`roles { ${roleNames.join(', ')} }`, '');
  }

  for (const [enName, variants] of enumDecls) {
    out.push(`enum ${enName} { ${variants.join(' ')} }`);
  }
  if (enumDecls.size) out.push('');

  if (!hasUser) {
    out.push(
      `entity User {`,
      `  id: UUID [primary, immutable, unique]`,
      `  email: String [unique, indexed]`,
      `  name: String`,
      `  createdAt: Timestamp [immutable]`,
      `}`,
      ``,
    );
  }

  for (const e of entities) {
    out.push(`entity ${e.name} {`);
    out.push(`  id: UUID [primary, immutable, unique]`);
    if (e.owned && e.name.toLowerCase() !== 'user') {
      out.push(`  ownerId: UUID [indexed, references: "User.id", onDelete: "CASCADE"]`);
    }
    for (const ref of e.refs) {
      out.push(`  ${camel(ref)}Id: UUID [references: "${ref}.id"]`);
    }
    for (const f of e.fields) {
      out.push(`  ${f.line}`);
    }
    const lifecycleSpecs = e.fields
      .map((f) => f.statusLifecycle)
      .filter((s): s is StatusLifecycleSpec => s != null);
    if (lifecycleSpecs.length === 1) {
      const edges = statusLifecycleEdges(lifecycleSpecs[0]!);
      if (edges.length) {
        out.push(`  lifecycle {`);
        for (const edge of edges) out.push(`    ${edge.from} -> ${edge.to}`);
        out.push(`  }`);
      }
    } else if (lifecycleSpecs.length > 1) {
      errors.push(
        `entity ${e.name}: multiple status lifecycles in one entity — emitted fields only, no lifecycle block`,
      );
    }
    if (e.permissions.length) {
      out.push(`  permissions {`);
      for (const rule of e.permissions) {
        const terms = [...rule.roles, ...(rule.owner ? ['owner'] : [])];
        out.push(`    ${rule.action}: ${terms.join(' | ')}`);
      }
      out.push(`  }`);
    }
    out.push(`  createdAt: Timestamp [immutable]`);
    out.push(`}`, ``);
  }

  // `owned` is an authorization promise, not just a convenience FK. Emit the
  // canonical deny-by-default policy so the contract, database RLS generator and
  // journey denominator all see the same owner boundary.
  for (const e of entities.filter((entity) => entity.owned)) {
    out.push(
      `policy per_owner_${snake(e.name)} {`,
      `  applies_to: ${e.name}`,
      `  rules { row.ownerId == ctx.userId: allow  default: deny }`,
      `}`,
      ``,
    );
  }

  // Views — each mini view expands to a real ISL `view` over its for-entity. The
  // codegen renders an aggregate-only view as owner-scoped stat cards, and one with a
  // `group(...)` dimension as a GROUP BY table (components/views/<Name>View.tsx).
  const entityByName = new Map(entities.map((e) => [e.name.toLowerCase(), e]));
  for (const v of viewSpecs) {
    const entity = entityByName.get(v.entity.toLowerCase());
    if (!entity) {
      errors.push(`view ${v.name}: unknown entity "${v.entity}" — skipped`);
      continue;
    }
    const fieldLines: string[] = [];
    const seen = new Set<string>();
    if (v.by) {
      const dimType = entity.fieldTypes.get(v.by.toLowerCase());
      if (!dimType) {
        errors.push(`view ${v.name}: unknown group column "${v.by}" on ${entity.name} — skipped`);
        continue;
      }
      fieldLines.push(`    ${v.by}: ${dimType} = group(${entity.name}.${v.by})`);
      seen.add(v.by.toLowerCase());
    }
    for (const a of v.aggs) {
      if (a.fn === 'count') {
        if (seen.has('count')) continue;
        seen.add('count');
        fieldLines.push(`    count: Int = count(${entity.name})`);
      } else {
        const col = a.col as string;
        if (!entity.fieldTypes.has(col.toLowerCase())) {
          errors.push(`view ${v.name}: ${a.fn}(${col}) — no such column on ${entity.name}`);
          continue;
        }
        const fname = `${camel(col)}${pascal(a.fn)}`; // e.g. amountCentsSum
        if (seen.has(fname.toLowerCase())) continue;
        seen.add(fname.toLowerCase());
        fieldLines.push(`    ${fname}: Decimal = ${a.fn}(${entity.name}.${col})`);
      }
    }
    if (fieldLines.length === 0) {
      errors.push(`view ${v.name}: no valid fields — skipped`);
      continue;
    }
    out.push(
      `view ${v.name} {`,
      `  for: ${entity.name}`,
      `  fields {`,
      ...fieldLines,
      `  }`,
      `  cache { ttl: 60s }`,
      `}`,
      ``,
    );
  }

  // Default Create<Entity> behaviors — WITHOUT one a mini app has no create form (the
  // mapper only synthesizes update/delete from an existing entity, never create). The
  // input is the user-providable fields: every declared field + the FK columns, MINUS
  // [ai] fields (generated server-side) and the auto-injected id/owner/tenant/createdAt
  // (injected from the session/defaults). This also wires the [ai] aiGenerate path,
  // which only fires inside a create action.
  for (const e of entities) {
    if (e.name.toLowerCase() === 'user') continue;
    const inputs: string[] = [];
    for (const ref of e.refs) inputs.push(`${camel(ref)}Id: UUID`);
    for (const f of e.fields) {
      if (/\[ai\b/.test(f.line)) continue; // ai fields are generated, never user input
      const m = f.line.match(/^(\w+):\s*([A-Za-z]\w*(?:\[\])?\??)/);
      if (m) inputs.push(`${m[1]}: ${m[2]}`);
    }
    if (inputs.length === 0) continue;
    out.push(
      `behavior Create${e.name} {`,
      `  input { ${inputs.join('  ')} }`,
      `  output { success: ${e.name} }`,
      `}`,
      ``,
    );
  }

  return { isl: out.join('\n').trimEnd() + '\n', errors };
}
