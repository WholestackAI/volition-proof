/**
 * The semantic mutation corpus — the acceptance gate for the typed payload.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS
 * ─────────────────────────────────────────────────────────────────────────────
 * A frozen list of source edits, each one executed against a real fixture and
 * each one recording whether `contractHash` moved. Every row here was RUN, not
 * imagined: the fixture was read, `before` was replaced with `after`, both texts
 * went through `parseAppContract`, and the two hashes were compared.
 *
 * Today most rows report `visibleToday: false`. That is the finding, not a bug
 * in the corpus. A clause's whole semantic content was one string, `islExcerpt`,
 * and for `view`, `aggregate`, `integration`, `auth-provider` and `screen` the
 * projector had nowhere structured to put meaning, so it wrote the construct's
 * NAME. Swapping a report's measure from `sum(amount)` to `count(*)` therefore
 * produced an identical hash and a `diffContracts` result of "No change in
 * meaning."
 *
 * The corpus is the gate that closes that. Wired against the landed
 * `ClauseSemantic` payload, each row asserts:
 *
 *   expectation 'blindness'  → hash MUST move (it does not today)
 *   expectation 'control'    → hash MUST move (it already does)
 *   expectation 'by-design'  → hash MUST NOT move (and must stay that way)
 *
 * The `control` rows are not decoration. A suite whose every case is expected to
 * flip cannot distinguish "the fix worked" from "the harness is broken" — the
 * controls are what prove the harness still detects a change at all.
 *
 * The `by-design` rows are the opposite guard. `semanticNormalForm` sorts
 * clauses by id precisely so that reordering or reformatting a spec is provably
 * a no-op. A payload that makes those visible has broken a stated invariant of
 * the module and is also a regression.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS NOT `vocabulary-blindness.test.ts`
 * ─────────────────────────────────────────────────────────────────────────────
 * `packages/shipgate-typechecker/tests/vocabulary-blindness.test.ts` covers a
 * DIFFERENT blindness: the typechecker recognising lifecycle columns, money
 * fields and authorization surfaces by NAME WHITELIST rather than by shape. That
 * is about what the checker fails to notice in an AST.
 *
 * This corpus is about what the contract fails to HASH. The two do not overlap,
 * and neither replaces the other.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO SHAPE DECISIONS THE DATA FORCED
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. `kind` IS NULLABLE. Three rows delete an `event`, a `workflow`, or a
 *    handler+event+workflow block. Those constructs parse fully into the AST and
 *    reach NO clause kind whatsoever — there is no `'event'` in `CLAUSE_KINDS` to
 *    name. Forcing them onto some adjacent kind would hide exactly the gap they
 *    exist to prove, so `kind` is `null` and `construct` names the ISL syntax.
 *
 * 2. `visibleToday` IS RECORDED, NOT DERIVED. It is a measurement taken against
 *    the pre-payload projector, not a prediction. Once the payload lands these
 *    values become the historical baseline the suite asserts movement away from;
 *    they are deliberately not recomputed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROVENANCE
 * ─────────────────────────────────────────────────────────────────────────────
 * Executed 2026-08-19 against the projector at `from-isl.ts`, via
 * `parseAppContract` from the package entry point. Fixture paths are
 * repo-relative. Anchors are exact: each `before` occurs EXACTLY ONCE in its
 * fixture, and mutation is a single `String.prototype.replace`.
 *
 * Mutations that produced a PARSE ERROR rather than a hash comparison are
 * deliberately absent — a spec the parser rejects is a grammar gap, not an
 * invisible semantic change, and belongs in `ProjectionGap` with reason
 * `not-in-grammar`. Those probes were: view `filter:`, view `sort:`,
 * view `limit:`, view `page_size:`, aggregate `sort:`, aggregate `limit:`,
 * aggregate `cache {}`, and multi-dimension `group_by: a, b`.
 *
 * Pure data. No imports beyond the `ClauseKind` type, no fs, no test framework.
 */

import type { ClauseKind } from './types.js';

/**
 * What the corpus asserts about a row once the typed payload is wired in.
 *
 * `blindness` — meaning-bearing and currently invisible. MUST become visible.
 * `control`   — already visible. MUST stay visible, or the harness is broken.
 * `by-design` — correctly invisible (ordering, dedup). MUST stay invisible.
 */
export type MutationExpectation = 'blindness' | 'control' | 'by-design';

export interface SemanticMutation {
  /** Stable probe id from the original inventory run, e.g. 'V1', 'A3', 'S5'. */
  readonly id: string;
  /**
   * The clause kind this exercises, or `null` when the ISL construct reaches no
   * clause kind at all. `null` is itself the finding — see `construct`.
   */
  readonly kind: ClauseKind | null;
  /** The ISL construct, named when `kind` is null or when it aids reading. */
  readonly construct?: string;
  /** Repo-relative fixture path. */
  readonly fixture: string;
  /** Exact source text to find. Occurs exactly once in `fixture`. */
  readonly before: string;
  /** Exact replacement. Empty string means "delete this block". */
  readonly after: string;
  /** The clause expected to change, when one exists. */
  readonly clauseId?: string;
  /** Path into `ClauseSemantic` that should carry this, e.g. `measures[0].fn`. */
  readonly semanticPath?: string;
  /** What behavior changes if this ships unnoticed. One sentence. */
  readonly consequence: string;
  /** What the corpus asserts once the payload is wired in. */
  readonly expectation: MutationExpectation;
  /** Whether `contractHash` moves TODAY. Nearly all are false; that is the point. */
  readonly visibleToday: boolean;
}

const CRM = 'fixtures/interview-archetypes/sales-crm/contract.isl';
const AGG = 'apps/web/templates/isl-specs/aggregate-metrics.isl';
const AIVANTE = 'fixtures/golden-projects/aivante/aivante.isl';
const SCREEN_API = 'packages/shipgate-typechecker/conformance/extras/tenancy-screen-api.isl';
const AUTH_PROVIDERS = 'packages/shipgate-typechecker/conformance/extras/auth-providers.isl';

export const MUTATION_CORPUS: readonly SemanticMutation[] = Object.freeze([
  // ───────────────────────────────────────────────────────────────────────────
  // view — 15 rows. The clause is `view <Name>`; everything else is prose or lost.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'V1',
    kind: 'view',
    fixture: CRM,
    before: 'amountCentsSum: Decimal = sum(Estimate.amountCents)',
    after: 'amountCentsSum: Decimal = count(Estimate)',
    clauseId: 'view:EstimateByStage',
    semanticPath: 'measures[2].fn',
    consequence:
      'The revenue total silently becomes a row count — the dashboard shows 3 where it showed $42,000.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'V2',
    kind: 'view',
    fixture: CRM,
    before: 'amountCentsSum: Decimal = sum(Estimate.amountCents)',
    after: 'amountCentsSum: Decimal = avg(Estimate.amountCents)',
    clauseId: 'view:EstimateByStage',
    semanticPath: 'measures[2].fn',
    consequence:
      'A pipeline total becomes a per-deal average, understating the book by orders of magnitude.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'V3',
    kind: 'view',
    fixture: CRM,
    before: 'amountCentsSum: Decimal = sum(Estimate.amountCents)',
    after: 'amountCentsSum: Decimal = sum(Estimate.id)',
    clauseId: 'view:EstimateByStage',
    semanticPath: 'measures[2].over',
    consequence: 'The report sums a UUID surrogate key instead of the money column.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'V4b',
    kind: 'view',
    fixture: CRM,
    before: 'source: LeadSource = group(Lead.source)',
    after: 'source: LeadSource = group(Lead.name)',
    clauseId: 'view:LeadBySource',
    semanticPath: 'groupBy',
    consequence:
      'The report pivots on lead name — unbounded cardinality — instead of the five-value source enum.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'V5',
    kind: 'view',
    fixture: CRM,
    before:
      '    count: Int = count(Estimate)\n    amountCentsSum: Decimal = sum(Estimate.amountCents)\n',
    after: '    count: Int = count(Estimate)\n',
    clauseId: 'view:EstimateByStage',
    semanticPath: 'measures',
    consequence:
      'The money column disappears from the report entirely; only the clause detail prose moved.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'V6',
    kind: 'view',
    fixture: CRM,
    before:
      'view LeadBySource {\n' +
      '  for: Lead\n' +
      '  fields {\n' +
      '    source: LeadSource = group(Lead.source)\n' +
      '    count: Int = count(Lead)\n' +
      '  }\n' +
      '  cache { ttl: 60s }',
    after:
      'view LeadBySource {\n' +
      '  for: Lead\n' +
      '  fields {\n' +
      '    source: LeadSource = group(Lead.source)\n' +
      '    count: Int = count(Lead)\n' +
      '  }\n' +
      '  cache { ttl: 86400s }',
    clauseId: 'view:LeadBySource',
    semanticPath: 'cacheTtlSeconds',
    consequence: 'Report staleness goes from one minute to twenty-four hours.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'V7',
    kind: 'view',
    fixture: CRM,
    before: 'view EstimateByStage {\n  for: Estimate',
    after: 'view EstimateByStage {\n  for: Lead',
    clauseId: 'view:EstimateByStage',
    semanticPath: 'forEntity',
    consequence:
      'The report reads a different table; only `refs` and the English title moved, neither hashed.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'V8',
    kind: 'view',
    fixture: CRM,
    before: 'view EstimateByStage {',
    after: 'view EstimateByStatus {',
    clauseId: 'view:EstimateByStage',
    semanticPath: 'view',
    consequence:
      'Control — the view name is the one thing already hashed, so this must always be visible.',
    expectation: 'control',
    visibleToday: true,
  },
  {
    id: 'V9',
    kind: 'view',
    fixture: CRM,
    before: 'view LeadBySource {\n  for: Lead',
    after: 'view LeadBySource {\n  display: "kanban"\n  for: Lead',
    clauseId: 'view:LeadBySource',
    semanticPath: 'display',
    consequence: 'Swaps the generated surface from a GROUP BY table to a bespoke board.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'V10b',
    kind: 'view',
    fixture: CRM,
    before: '    count: Int = count(Lead)\n  }\n  cache { ttl: 60s }',
    after: '    count: Int = count(Lead)\n  }\n  consistency { strong }\n  cache { ttl: 60s }',
    clauseId: 'view:LeadBySource',
    semanticPath: 'consistency',
    consequence: 'Flips the read from eventually consistent to strongly consistent.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'V11',
    kind: 'view',
    fixture: CRM,
    before: '    count: Int = count(Lead)\n  }\n  cache { ttl: 60s }',
    after: '    count: Int = count(Lead)\n  }',
    clauseId: 'view:LeadBySource',
    semanticPath: 'cacheTtlSeconds',
    consequence: 'Removes caching entirely, moving every dashboard load onto the primary.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'V16',
    kind: 'view',
    fixture: CRM,
    before: 'amountCentsSum: Decimal = sum(',
    after: 'amountCentsSum: String = sum(',
    clauseId: 'view:EstimateByStage',
    semanticPath: 'measures[2].type',
    consequence:
      'A numeric money measure is declared as text, changing coercion and formatting downstream.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'V17',
    kind: 'view',
    fixture: CRM,
    before:
      'view LeadBySource {\n' +
      '  for: Lead\n' +
      '  fields {\n' +
      '    source: LeadSource = group(Lead.source)\n' +
      '    count: Int = count(Lead)\n' +
      '  }\n' +
      '  cache { ttl: 60s }\n' +
      '}\n',
    after: '',
    clauseId: 'view:LeadBySource',
    consequence:
      'Control — deleting a whole view removes its clause id, which the hash already tracks.',
    expectation: 'control',
    visibleToday: true,
  },

  {
    id: 'V19',
    kind: 'view',
    fixture: CRM,
    before: '    amountCentsSum: Decimal = sum(Estimate.amountCents)',
    after: '    grandTotal: Decimal = sum(Estimate.amountCents)',
    clauseId: 'view:EstimateByStage',
    semanticPath: 'measures[2].name',
    consequence:
      'The measure is relabelled while its computation is untouched — the reported column header changes, which is the only thing a reader of the dashboard sees.',
    expectation: 'blindness',
    visibleToday: false,
  },

  {
    id: 'V20',
    kind: 'view',
    fixture: CRM,
    before: '  cache { ttl: 60s }\n}\n\nview EstimateByStage',
    after: '  cache { ttl: 60s invalidate_on: [CreateLead] }\n}\n\nview EstimateByStage',
    clauseId: 'view:LeadBySource',
    semanticPath: 'cacheInvalidateOn',
    consequence:
      'The report gains an explicit invalidation trigger, changing when stale data is evicted rather than merely how long it lives.',
    expectation: 'blindness',
    visibleToday: false,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // aggregate — 9 rows. Worse than view: the clause has no detail and empty refs.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'A1',
    kind: 'aggregate',
    fixture: AGG,
    before:
      '    measure: count, sum(totalCents), avg(totalCents), min(totalCents), max(totalCents)',
    after: '    measure: count',
    clauseId: 'aggregate:RevenueSummary',
    semanticPath: 'measures',
    consequence: 'Four of five stat cards vanish from the dashboard.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'A2',
    kind: 'aggregate',
    fixture: AGG,
    before: '    measure: sum(totalCents), count',
    after: '    measure: avg(totalCents), count',
    clauseId: 'aggregate:RevenueByStatus',
    semanticPath: 'measures[0].fn',
    consequence: 'Revenue per status becomes average order value per status.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'A3',
    kind: 'aggregate',
    fixture: AGG,
    before: '    group_by: status',
    after: '    group_by: reference',
    clauseId: 'aggregate:RevenueByStatus',
    semanticPath: 'groupBy',
    consequence: 'Pivots on a unique per-row reference, producing one group per order.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'A4',
    kind: 'aggregate',
    fixture: AGG,
    before: '    group_by: status\n',
    after: '',
    clauseId: 'aggregate:RevenueByStatus',
    semanticPath: 'groupBy',
    consequence:
      'Collapses a GROUP BY table into a single stat card — a different generated surface.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'A5',
    kind: 'aggregate',
    fixture: AGG,
    before: '    filter: totalCents > 0',
    after: '    filter: totalCents > 100000',
    clauseId: 'aggregate:RevenueByStatus',
    semanticPath: 'filter',
    consequence: 'Silently excludes every order under $1,000 from the revenue rollup.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'A6',
    kind: 'aggregate',
    fixture: AGG,
    before: '    filter: totalCents > 0\n',
    after: '',
    clauseId: 'aggregate:RevenueByStatus',
    semanticPath: 'filter',
    consequence: 'Drops the WHERE clause, pulling refunds and zero-value rows into the total.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'A7',
    kind: 'aggregate',
    fixture: AGG,
    before: '  aggregate RevenueSummary {\n    for: Order',
    after: '  aggregate RevenueSummary {\n    for: User',
    clauseId: 'aggregate:RevenueSummary',
    semanticPath: 'forEntity',
    consequence:
      'The rollup ranges over the wrong table; unlike a view it does not even reach `refs`.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'A8',
    kind: 'aggregate',
    fixture: AGG,
    before: '    measure: sum(totalCents), count',
    after: '    measure: sum(placedAt), count',
    clauseId: 'aggregate:RevenueByStatus',
    semanticPath: 'measures[0].over',
    consequence: 'Sums a timestamp column instead of the money column.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'A9',
    kind: 'aggregate',
    fixture: AGG,
    before: '  aggregate RevenueSummary {',
    after: '  aggregate RevenueTotals {',
    clauseId: 'aggregate:RevenueSummary',
    semanticPath: 'aggregate',
    consequence: 'Control — the aggregate name is the only hashed content today.',
    expectation: 'control',
    visibleToday: true,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // integration / auth-provider — 7 rows.
  //
  // Note what these rows do NOT contain. `ProviderDecl` has exactly one member,
  // `name` — the grammar is a bare identifier list. There is no config, scope,
  // version or operation to mutate, so no `blindness` row is possible here. The
  // gap is `not-in-grammar`, and closing it is parser work, not projector work.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'I1',
    kind: 'auth-provider',
    fixture: AIVANTE,
    before: '  auth { email }',
    after: '  auth { google }',
    clauseId: 'auth-provider:email',
    semanticPath: 'provider',
    consequence:
      'Control — swapping the provider name changes the clause id, which the hash already tracks.',
    expectation: 'control',
    visibleToday: true,
  },
  {
    id: 'I2',
    kind: 'auth-provider',
    fixture: AIVANTE,
    before: '  auth { email }',
    after: '  auth { email, google }',
    clauseId: 'auth-provider:google',
    semanticPath: 'provider',
    consequence: 'Control — adding a sign-in provider adds a clause and must move the hash.',
    expectation: 'control',
    visibleToday: true,
  },
  {
    id: 'I4',
    kind: 'auth-provider',
    fixture: AIVANTE,
    before: '  auth { email }',
    after: '  auth { email, email }',
    clauseId: 'auth-provider:email',
    consequence:
      'A duplicated provider collapses to one clause via the id-dedup; the typechecker owns duplicates (see conformance/negatives/auth-duplicate-provider.isl), so the contract staying quiet is correct.',
    expectation: 'by-design',
    visibleToday: false,
  },
  {
    id: 'I5',
    kind: 'auth-provider',
    fixture: AIVANTE,
    before: '  auth { email }',
    after: '  auth { email }\n  auth { google }',
    clauseId: 'auth-provider:google',
    semanticPath: 'provider',
    consequence:
      'Control — a second auth block merges into the first, and the added provider must still surface as a new clause.',
    expectation: 'control',
    visibleToday: true,
  },
  {
    id: 'I6',
    kind: 'integration',
    fixture: AIVANTE,
    before: '  auth { email }',
    after: '  auth { email }\n  integrations { stripe, posthog }',
    clauseId: 'integration:stripe',
    semanticPath: 'provider',
    consequence:
      'Control — wiring in two third-party services adds two clauses and must move the hash.',
    expectation: 'control',
    visibleToday: true,
  },
  {
    id: 'I9',
    kind: 'auth-provider',
    fixture: AUTH_PROVIDERS,
    before: '  auth { google, github }',
    after: '  auth { github, google }',
    consequence:
      'Provider declaration order is dropped because the normal form sorts by clause id — the same rule that makes a reformat provably a no-op. Settled 2026-08-19: declaration order carries no meaning, so this MUST stay invisible and a payload that surfaces it is a regression. If that ever reverses, order needs its own field, never a hash that reacts to source order.',
    expectation: 'by-design',
    visibleToday: false,
  },
  {
    id: 'I10',
    kind: 'auth-provider',
    fixture: AUTH_PROVIDERS,
    before: '  auth { google, github }\n  integrations { posthog }',
    after: '  auth { google, github, posthog }\n  integrations { }',
    clauseId: 'auth-provider:posthog',
    semanticPath: 'provider',
    consequence:
      'Control — reclassifying a name from an integration to a sign-in provider swaps `integration:posthog` for `auth-provider:posthog`, and the kind change must be visible.',
    expectation: 'control',
    visibleToday: true,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // screen — 8 rows. `'screen'` is a DECLARED clause kind that no projector ever
  // emits. The AST parses route, layout, components, fields and navigation in
  // full; the clause set is unchanged by any of it. Even the name is invisible.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'S1',
    kind: 'screen',
    fixture: SCREEN_API,
    before: '    route: "/tasks"',
    after: '    route: "/admin/purge"',
    clauseId: 'screen:TaskBoard',
    semanticPath: 'route',
    consequence: 'The screen moves to a different URL with no record in the contract.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'S2',
    kind: 'screen',
    fixture: SCREEN_API,
    before: '      entity: Task\n      behavior: listTasks',
    after: '      entity: User\n      behavior: listTasks',
    clauseId: 'screen:TaskBoard',
    semanticPath: 'components[0].entity',
    consequence: 'The component binds to the user table instead of the task table.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'S3',
    kind: 'screen',
    fixture: SCREEN_API,
    before: '      type: list',
    after: '      type: form',
    clauseId: 'screen:TaskBoard',
    semanticPath: 'components[0].type',
    consequence: 'A read-only list becomes a write surface.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'S4',
    kind: 'screen',
    fixture: SCREEN_API,
    before: '  screen TaskBoard {',
    after: '  screen Dashboard {',
    clauseId: 'screen:TaskBoard',
    semanticPath: 'screen',
    consequence:
      'Renaming the screen is invisible — unlike every other kind, not even the name reaches a clause.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'S5',
    kind: 'screen',
    fixture: SCREEN_API,
    before:
      '  screen TaskBoard {\n' +
      '    route: "/tasks"\n' +
      '    component TaskList {\n' +
      '      type: list\n' +
      '      entity: Task\n' +
      '      behavior: listTasks\n' +
      '      fields {\n' +
      '        title: "text"\n' +
      '      }\n' +
      '    }\n' +
      '  }\n',
    after: '',
    clauseId: 'screen:TaskBoard',
    consequence: 'An entire screen can be deleted with no change to the clause set or the hash.',
    expectation: 'blindness',
    visibleToday: false,
  },

  {
    id: 'S10',
    kind: 'screen',
    fixture: SCREEN_API,
    before: '    route: "/tasks"',
    after: '    route: "/tasks"\n    layout: sidebar',
    clauseId: 'screen:TaskBoard',
    semanticPath: 'layout',
    consequence: 'The screen gains a layout shell, changing the rendered page chrome.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'S11',
    kind: 'screen',
    fixture: SCREEN_API,
    before: '    component TaskList {',
    after: '    component TaskGrid {',
    clauseId: 'screen:TaskBoard',
    semanticPath: 'components[0].name',
    consequence:
      'The component is renamed, which is the handle every downstream reference resolves against.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'S12',
    kind: 'screen',
    fixture: SCREEN_API,
    before: '      entity: Task\n      behavior: listTasks\n',
    after: '      entity: Task\n',
    clauseId: 'screen:TaskBoard',
    semanticPath: 'components[0].behavior',
    consequence:
      'The component is unbound from the behavior it invoked, silently severing the screen from its command.',
    expectation: 'blindness',
    visibleToday: false,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // no clause kind at all — 6 rows. `CLAUSE_KINDS` has no member for
  // `api`/`event`/`workflow`, and the `automation` blueprint section they
  // would occupy is permanently empty as a result.
  //
  // UPDATE 2026-08-19, post-payload: `appSemantic` now counts these
  // declarations (`unprojectedDomainConstructs`) and carries the count as a
  // `ProjectionGap` on the `app` clause, so a WHOLE-BLOCK deletion changes
  // that count and DOES move the hash — S6, S7, S9 and S13 measured visible
  // once `mutation-corpus.test.ts` ran them, contrary to `visibleToday: false`
  // below, which is frozen provenance from before that wiring (see "PROVENANCE"
  // and "visibleToday IS RECORDED, NOT DERIVED" above — deliberately not
  // updated). What the count cannot see is a block that still exists changing
  // shape INSIDE itself: S14 removes one endpoint's `auth:` while the `api {}`
  // block remains, so the count is unchanged and the hash still does not move.
  // S15 is the same shape. Those two are the real remaining gap, and S14 is
  // the sharpest case in it: removing an authorization gate from a DELETE
  // endpoint leaves the contract hash untouched.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'S6',
    kind: null,
    construct: 'workflow',
    fixture: SCREEN_API,
    before:
      '  workflow Sweep {\n' +
      '    input { taskId: UUID }\n' +
      '    step 1 drain() { retry: 3 }\n' +
      '    step 2 prune() { dependsOn: [1] }\n' +
      '  }\n',
    after: '',
    consequence:
      'A whole multi-step workflow with retry and a dependency edge disappears; workflows are proof subjects downstream, so the proof loses its subject silently.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'S7',
    kind: null,
    construct: 'event',
    fixture: SCREEN_API,
    before: '  event TaskChanged {\n    taskId: UUID\n  }\n',
    after: '',
    consequence:
      'The event declaration vanishes; codegen creates the `domain_events` table from these, so the table and its grants disappear with no contract change.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'S9',
    kind: null,
    construct: 'event + handler + workflow',
    fixture: AIVANTE,
    before:
      '  event IllustrationComputed {\n' +
      '    illustrationId: UUID\n' +
      '    userId: UUID\n' +
      '    type: IllustrationType\n' +
      '  }\n' +
      '\n' +
      '  handler async IllustrationComputed -> summarizeIllustration {\n' +
      '    SummarizeIllustration(result)\n' +
      '  }\n' +
      '\n' +
      '  workflow SummarizeIllustration {\n' +
      '    description: "After compute, generate client-facing summary and append audit receipt"\n' +
      '    step saveIllustration(input) { retry: 2 }\n' +
      '    step appendComplianceEvent(input)\n' +
      '    on_failure: alertOps()\n' +
      '  }\n',
    after: '',
    consequence:
      'The entire async pipeline — event, its handler, and the workflow it triggers — is deleted and the contract reports 228 clauses before and 228 after, with an identical hash.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'S13',
    kind: null,
    construct: 'api',
    fixture: SCREEN_API,
    before:
      '  api {\n    basePath: "/api"\n' +
      '    GET "/tasks" -> listTasks {\n      description: "List tasks"\n      auth: authenticated\n    }\n' +
      '    PUT "/tasks/:id" -> listTasks {\n      description: "Replace a task"\n      auth: authenticated\n    }\n' +
      '    PATCH "/tasks/:id" -> listTasks {\n      description: "Patch a task"\n      auth: authenticated\n    }\n' +
      '    DELETE "/tasks/:id" -> listTasks {\n      description: "Delete a task"\n      auth: authenticated\n    }\n' +
      '    websocket "/live" -> listTasks {\n      description: "Live task stream"\n      auth: authenticated\n    }\n  }\n',
    after: '',
    consequence:
      'An entire public HTTP surface — five endpoints including a websocket — is deleted with no change to the clause set.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'S14',
    kind: null,
    construct: 'api.endpoint.auth',
    fixture: SCREEN_API,
    before:
      '    DELETE "/tasks/:id" -> listTasks {\n      description: "Delete a task"\n      auth: authenticated\n    }',
    after: '    DELETE "/tasks/:id" -> listTasks {\n      description: "Delete a task"\n    }',
    consequence:
      'The destructive endpoint stops requiring a signed-in caller. An authorization gate is removed and the contract hash does not move — the most dangerous row in this corpus.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'S15',
    kind: null,
    construct: 'api.endpoint.method',
    fixture: SCREEN_API,
    before: '    GET "/tasks" -> listTasks {',
    after: '    DELETE "/tasks" -> listTasks {',
    consequence: 'A read endpoint becomes a destructive one at the same path.',
    expectation: 'blindness',
    visibleToday: false,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // cross-kind — 3 rows, outside the five kinds this corpus was built from.
  //
  // `semantic.ts` cites these three in its header as measured consequences, but
  // they lived only in that prose. Reproduced here so the claims the design rests
  // on are executable. If another inventory's capture supersedes these, drop them.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'P1',
    kind: 'policy',
    fixture: AGG,
    before: '      row.ownerId == ctx.userId: allow\n      default: deny',
    after: '      row.ownerId == ctx.userId: allow\n      default: allow',
    clauseId: 'policy:per_owner_order',
    semanticPath: 'otherwise',
    consequence:
      'Row-level access inverts from owner-scoped to public. Only the unhashed English title moved: "otherwise deny" became "otherwise allow" while the hash held still.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'N1',
    kind: 'invariant',
    construct: 'entity.invariants',
    fixture: AGG,
    before: '    invariants {\n      - reference.length > 0\n      - totalCents >= 0',
    after: '    invariants {\n      - reference.length > 0\n      - totalCents <= 0',
    semanticPath: 'predicates',
    consequence:
      'A spend guard is negated — totals must now be non-positive instead of non-negative — with zero projection delta. Entity-level invariant blocks reach no clause; only domain-level ones do.',
    expectation: 'blindness',
    visibleToday: false,
  },
  {
    id: 'N2',
    kind: 'invariant',
    construct: 'entity.invariants',
    fixture: AGG,
    before:
      '    invariants {\n      - reference.length > 0\n      - totalCents >= 0\n      - status in [PENDING, PAID, SHIPPED, CANCELLED]\n    }\n',
    after: '',
    semanticPath: 'predicates',
    consequence:
      'Every data-integrity guard on the entity is deleted at once and the contract reports no change.',
    expectation: 'blindness',
    visibleToday: false,
  },
]);
