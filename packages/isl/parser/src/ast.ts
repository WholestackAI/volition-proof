// ============================================================================
// ISL (Intent Specification Language) - Abstract Syntax Tree Types
// Re-exported from master contracts with local definitions for standalone use
// ============================================================================

// ============================================================================
// SOURCE LOCATIONS
// ============================================================================

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface ASTNode {
  kind: string;
  location: SourceLocation;
}

// ============================================================================
// TOP LEVEL
// ============================================================================

export interface Domain extends ASTNode {
  kind: 'Domain';
  name: Identifier;
  version: StringLiteral;
  owner?: StringLiteral;
  description?: StringLiteral;
  /**
   * Tenancy archetype for the generated app's data layer. Absent ⇒ "multi-tenant"
   * (the historical default: shared DB + row-level tenant isolation). "single-tenant"
   * ⇒ a dedicated DB/instance per customer; tenant-isolation RLS is dropped (RBAC
   * RLS is kept) and physical isolation is enforced by provisioning.
   */
  tenancy?: 'multi-tenant' | 'single-tenant';
  uses: UseStatement[];
  imports: Import[];
  types: TypeDeclaration[];
  entities: Entity[];
  behaviors: Behavior[];
  invariants: InvariantBlock[];
  policies: Policy[];
  views: View[];
  /** First-class data-aggregate declarations (count/sum/avg/min/max, optionally grouped). */
  aggregates?: Aggregate[];
  /** Filterable list queries (`query Name { for: Entity filter: true filter_by: status }`). */
  queries?: QueryDecl[];
  /** Scheduled work (`job Name { for: Entity schedule: recurring cadence: weekly }`). */
  jobs?: JobDecl[];
  /** Notification effects (`notification Name { for: Entity to: role }`). */
  notifications?: NotificationDecl[];
  /** Domain-level RBAC role set (`roles { admin, manager, clerk }`). */
  roles?: RolesDecl;
  /** First-class double-entry money ledgers (`ledger Name { account …  movement … }`). */
  ledgers?: LedgerDecl[];
  scenarios: ScenarioBlock[];
  chaos: ChaosBlock[];
  // Full-stack constructs
  apis: ApiBlock[];
  storage: StorageDecl[];
  workflows: WorkflowDecl[];
  events: EventDecl[];
  handlers: HandlerDecl[];
  screens: ScreenDecl[];
  config?: ConfigBlock;
  /** Domain-level OAuth providers (`auth { google, github }`). Each lowers to its `oauth-<name>` recipe (+ `oauth-core`). */
  auth?: AuthDecl;
  /** Domain-level third-party integrations (`integrations { posthog }`). Each lowers to its recipe (e.g. `posthog-analytics`). */
  integrations?: IntegrationsDecl;
  /**
   * Named domain relationships, including pure many-to-many without a join entity.
   * Association entities (relationships with their own attributes) stay as `Entity`.
   */
  relationships?: RelationshipDecl[];
}

/** use stdlib-auth [@ "1.0.0"] [as alias]; module is identifier or string path */
export interface UseStatement extends ASTNode {
  kind: 'UseStatement';
  module: Identifier | StringLiteral;
  version?: StringLiteral;
  alias?: Identifier;
}

export interface Import extends ASTNode {
  kind: 'Import';
  items: ImportItem[];
  from: StringLiteral;
}

export interface ImportItem extends ASTNode {
  kind: 'ImportItem';
  name: Identifier;
  alias?: Identifier;
}

// ============================================================================
// TYPES
// ============================================================================

export interface TypeDeclaration extends ASTNode {
  kind: 'TypeDeclaration';
  name: Identifier;
  definition: TypeDefinition;
  annotations: Annotation[];
}

export type TypeDefinition =
  | PrimitiveType
  | ConstrainedType
  | EnumType
  | StructType
  | UnionType
  | ListType
  | MapType
  | OptionalType
  | ReferenceType;

export interface PrimitiveType extends ASTNode {
  kind: 'PrimitiveType';
  name:
    | 'String'
    | 'Int'
    | 'Decimal'
    | 'Boolean'
    | 'Timestamp'
    | 'UUID'
    | 'Duration'
    | 'Date'
    | 'Money'
    | 'File';
}

export interface ConstrainedType extends ASTNode {
  kind: 'ConstrainedType';
  base: TypeDefinition;
  constraints: Constraint[];
}

export interface Constraint extends ASTNode {
  kind: 'Constraint';
  name: string;
  value: Expression;
}

export interface EnumType extends ASTNode {
  kind: 'EnumType';
  variants: EnumVariant[];
}

export interface EnumVariant extends ASTNode {
  kind: 'EnumVariant';
  name: Identifier;
  value?: Literal;
}

export interface StructType extends ASTNode {
  kind: 'StructType';
  fields: Field[];
}

export interface Field extends ASTNode {
  kind: 'Field';
  name: Identifier;
  type: TypeDefinition;
  optional: boolean;
  annotations: Annotation[];
  defaultValue?: Expression;
}

export interface UnionType extends ASTNode {
  kind: 'UnionType';
  variants: UnionVariant[];
}

export interface UnionVariant extends ASTNode {
  kind: 'UnionVariant';
  name: Identifier;
  fields: Field[];
  /** Full variant type for round-trip (unparse); legacy parses may omit this. */
  memberType?: TypeDefinition;
}

export interface ListType extends ASTNode {
  kind: 'ListType';
  element: TypeDefinition;
}

export interface MapType extends ASTNode {
  kind: 'MapType';
  key: TypeDefinition;
  value: TypeDefinition;
}

export interface OptionalType extends ASTNode {
  kind: 'OptionalType';
  inner: TypeDefinition;
}

export interface ReferenceType extends ASTNode {
  kind: 'ReferenceType';
  name: QualifiedName;
}

export interface Annotation extends ASTNode {
  kind: 'Annotation';
  name: Identifier;
  value?: Expression;
}

// ============================================================================
// ENTITIES
// ============================================================================

export interface Entity extends ASTNode {
  kind: 'Entity';
  name: Identifier;
  annotations: Annotation[];
  fields: Field[];
  invariants: Expression[];
  lifecycle?: LifecycleSpec;
  /** Entity-level RBAC permissions (`permissions { read|write|delete: <roleExpr> }`). */
  permissions?: PermissionsBlock;
}

// ─────────────────────────────────────────────────────────────────────────────
// RBAC — domain role set + per-entity permission rules
// ─────────────────────────────────────────────────────────────────────────────

/** A domain-level closed role set: `roles { admin, manager, clerk }`. */
export interface RolesDecl extends ASTNode {
  kind: 'RolesDecl';
  roles: RoleDecl[];
}

export interface RoleDecl extends ASTNode {
  kind: 'RoleDecl';
  name: Identifier;
}

/** Domain-level OAuth providers (`auth { google, github }`). Each name lowers to its `oauth-<name>` recipe. */
export interface AuthDecl extends ASTNode {
  kind: 'AuthDecl';
  providers: ProviderDecl[];
}

/** Domain-level third-party integrations (`integrations { posthog }`). Each name lowers to its recipe. */
export interface IntegrationsDecl extends ASTNode {
  kind: 'IntegrationsDecl';
  services: ProviderDecl[];
}

/** A single named provider/service inside an `auth {}` or `integrations {}` block. */
export interface ProviderDecl extends ASTNode {
  kind: 'ProviderDecl';
  name: Identifier;
  /** Integration class: accounting, webhook, payments, api, … Absent on name-only providers. */
  type?: Identifier;
  /** inbound | outbound | bidirectional */
  direction?: Identifier;
  capability?: StringLiteral;
  /** Configuration keys the integration requires (credentials, endpoint, …). */
  requires?: Identifier[];
  event?: StringLiteral;
  action?: Identifier;
}

/** Cardinality for a first-class domain relationship. */
export type RelationshipCardinality =
  | 'one_to_one'
  | 'one_to_many'
  | 'many_to_one'
  | 'many_to_many';

/**
 * Named relationship between two entities.
 *
 * Pure many-to-many does **not** invent a join entity. When the relationship
 * itself has attributes, `associationEntity` names the domain entity that
 * holds those attributes.
 */
export interface RelationshipDecl extends ASTNode {
  kind: 'RelationshipDecl';
  name: Identifier;
  source: Identifier;
  target: Identifier;
  cardinality: RelationshipCardinality;
  optional: boolean;
  sourceField?: Identifier;
  targetField?: Identifier;
  associationEntity?: Identifier;
}

/** An entity-level `permissions { read: …, write: …, delete: … }` block. */
export interface PermissionsBlock extends ASTNode {
  kind: 'PermissionsBlock';
  rules: PermissionRule[];
}

/** One `read|write|delete: <roleExpr>` rule. */
export interface PermissionRule extends ASTNode {
  kind: 'PermissionRule';
  action: 'read' | 'write' | 'delete';
  allow: RoleExpr;
}

/** A `|`-disjunction over declared role names, `owner`, `tenant`, `related(field)`, and `none`. */
export interface RoleExpr extends ASTNode {
  kind: 'RoleExpr';
  roles: Identifier[];
  owner: boolean;
  /** Counterparty FKs: `related(buyerId)` ⇒ that column = session user. */
  related?: Identifier[];
  /** Organization / tenant-scoped access (`read: tenant`). */
  tenant?: boolean;
  /** Explicit denial (`write: none`). */
  none?: boolean;
}

export interface LifecycleSpec extends ASTNode {
  kind: 'LifecycleSpec';
  transitions: LifecycleTransition[];
}

export interface LifecycleTransition extends ASTNode {
  kind: 'LifecycleTransition';
  from: Identifier;
  to: Identifier;
  /** `forbid FROM -> TO` — a forbidden hop, not an allowed one. */
  forbidden?: boolean;
}

// ============================================================================
// BEHAVIORS
// ============================================================================

export interface Behavior extends ASTNode {
  kind: 'Behavior';
  name: Identifier;
  /** Leading behavior annotations, e.g. `behavior Withdraw [action: "account"]
   *  [setField: "balance = balance - input.amount"] { … }`. Optional + additive:
   *  parsed identically to entity/field annotations (parseAnnotations → [] when
   *  none), so a behavior without a leading `[` is byte-identical to before. */
  annotations?: Annotation[];
  description?: StringLiteral;
  actors?: ActorSpec[];
  input: InputSpec;
  output: OutputSpec;
  preconditions: Expression[];
  postconditions: PostconditionBlock[];
  invariants: Expression[];
  temporal: TemporalSpec[];
  security: SecuritySpec[];
  compliance: ComplianceSpec[];
  observability?: ObservabilitySpec;
}

export interface ActorSpec extends ASTNode {
  kind: 'ActorSpec';
  name: Identifier;
  constraints: Expression[];
}

export interface InputSpec extends ASTNode {
  kind: 'InputSpec';
  fields: Field[];
}

export interface OutputSpec extends ASTNode {
  kind: 'OutputSpec';
  success: TypeDefinition;
  errors: ErrorSpec[];
}

export interface ErrorSpec extends ASTNode {
  kind: 'ErrorSpec';
  name: Identifier;
  when?: StringLiteral;
  retriable: boolean;
  retryAfter?: Expression;
  returns?: TypeDefinition;
}

export interface PostconditionBlock extends ASTNode {
  kind: 'PostconditionBlock';
  condition: Identifier | 'success' | 'any_error';
  predicates: Expression[];
}

export interface TemporalSpec extends ASTNode {
  kind: 'TemporalSpec';
  operator: 'eventually' | 'always' | 'within' | 'never' | 'immediately' | 'response';
  predicate: Expression;
  duration?: DurationLiteral;
  percentile?: number;
}

export interface SecuritySpec extends ASTNode {
  kind: 'SecuritySpec';
  type: 'requires' | 'rate_limit' | 'fraud_check';
  details: Expression;
}

export interface ComplianceSpec extends ASTNode {
  kind: 'ComplianceSpec';
  standard: Identifier;
  requirements: Expression[];
}

export interface ObservabilitySpec extends ASTNode {
  kind: 'ObservabilitySpec';
  metrics: MetricSpec[];
  traces: TraceSpec[];
  logs: LogSpec[];
}

export interface MetricSpec extends ASTNode {
  kind: 'MetricSpec';
  name: Identifier;
  type: 'counter' | 'gauge' | 'histogram';
  labels: Identifier[];
}

export interface TraceSpec extends ASTNode {
  kind: 'TraceSpec';
  name: StringLiteral;
}

export interface LogSpec extends ASTNode {
  kind: 'LogSpec';
  condition: 'success' | 'error' | 'always';
  level: 'debug' | 'info' | 'warn' | 'error';
  include: Identifier[];
  exclude: Identifier[];
}

// ============================================================================
// INVARIANTS & POLICIES
// ============================================================================

export interface InvariantBlock extends ASTNode {
  kind: 'InvariantBlock';
  name: Identifier;
  description?: StringLiteral;
  scope: 'global' | 'transaction';
  predicates: Expression[];
}

export interface Policy extends ASTNode {
  kind: 'Policy';
  name: Identifier;
  appliesTo: PolicyTarget;
  rules: PolicyRule[];
}

export interface PolicyTarget extends ASTNode {
  kind: 'PolicyTarget';
  target: 'all' | Identifier[];
}

export interface PolicyRule extends ASTNode {
  kind: 'PolicyRule';
  condition?: Expression;
  action: Expression;
}

// ============================================================================
// VIEWS
// ============================================================================

export interface View extends ASTNode {
  kind: 'View';
  name: Identifier;
  forEntity: ReferenceType;
  fields: ViewField[];
  consistency: ConsistencySpec;
  cache?: CacheSpec;
  /**
   * Optional presentation hint (`display:`/`ui:` member) that lets a spec opt a
   * view into a bespoke generated surface (e.g. "budget-board", "kanban",
   * "comparison") instead of the default stat-cards / GROUP BY table. Advisory:
   * codegen falls back to structural inference, then the default table, when the
   * hint is absent or doesn't fit the view's shape.
   */
  display?: string;
}

export interface ViewField extends ASTNode {
  kind: 'ViewField';
  name: Identifier;
  type: TypeDefinition;
  computation: Expression;
}

export interface ConsistencySpec extends ASTNode {
  kind: 'ConsistencySpec';
  mode: 'strong' | 'eventual';
  maxDelay?: DurationLiteral;
  strongFields?: Identifier[];
}

export interface CacheSpec extends ASTNode {
  kind: 'CacheSpec';
  ttl: DurationLiteral;
  invalidateOn: Expression[];
}

// ============================================================================
// AGGREGATES (first-class data-aggregate construct)
// ============================================================================

/**
 * A first-class data-aggregate declaration:
 *
 *   aggregate <Name> {
 *     for: <Entity>
 *     measure: count | sum(<field>) | avg(<field>) | min(<field>) | max(<field>) [, ...]
 *     group_by: <field>?
 *     filter: <expr>?
 *   }
 *
 * Lowered by the mappers to the SAME owner-scoped aggregate query + dashboard card
 * the `view` aggregate path produces (see lib/zeta-build/mappers/isl-to-react.ts).
 */
export interface Aggregate extends ASTNode {
  kind: 'Aggregate';
  name: Identifier;
  /** The entity the aggregate ranges over (`for: Entity`). */
  forEntity: ReferenceType;
  /** One or more measures (`measure: count, sum(amount)`); at least one is required. */
  measures: AggregateMeasure[];
  /** Optional grouping dimension (`group_by: category`). */
  groupBy?: Identifier;
  /** Optional row filter (`filter: status == "ACTIVE"`). */
  filter?: Expression;
}

/**
 * A filterable list query over an entity:
 *
 *   query RoofJobList {
 *     for: RoofJob
 *     filter: true
 *     filter_by: status
 *   }
 *
 * Distinct from `aggregate.filter` (a rollup predicate) and from `view`
 * (computed fields). Soft keyword — only a domain-level `query Name {` enters.
 */
export interface QueryDecl extends ASTNode {
  kind: 'QueryDecl';
  name: Identifier;
  forEntity: ReferenceType;
  /** Boolean predicate over the entity (`filter: true` means unconstrained). */
  filter?: Expression;
  /** Entity fields that may constrain the list. */
  filterBy: Identifier[];
}

/**
 * A scheduled / recurring job:
 *
 *   job AnnualInspection {
 *     for: Inspection
 *     schedule: recurring
 *     cadence: annually
 *   }
 */
export interface JobDecl extends ASTNode {
  kind: 'JobDecl';
  name: Identifier;
  forEntity: ReferenceType;
  /** `recurring` or `once`. */
  schedule: Identifier;
  /** `hourly` | `daily` | `weekly` | `monthly` | `quarterly` | `annually` | `yearly`. */
  cadence?: Identifier;
  /** Optional behavior this job invokes. */
  action?: Identifier;
}

/**
 * A notification effect:
 *
 *   notification InvoiceDueNotice {
 *     for: Invoice
 *     to: customer
 *   }
 */
export interface NotificationDecl extends ASTNode {
  kind: 'NotificationDecl';
  name: Identifier;
  forEntity?: ReferenceType;
  /** Declared role that receives the notification. */
  to: Identifier;
  event?: Identifier;
}

/** A single measure within an aggregate: a function over an optional field. */
export interface AggregateMeasure extends ASTNode {
  kind: 'AggregateMeasure';
  /** `count` takes no field; sum/avg/min/max take a field. */
  fn: 'count' | 'sum' | 'avg' | 'min' | 'max';
  /** The aggregated field (omitted for `count`, which is the row count). */
  field?: Identifier;
}

/**
 * A first-class double-entry money LEDGER: `ledger Name { account a, b, c
 * movement m { debit: a, credit: b } }`. Strictly additive — a domain-level
 * `ledger Name {` enters the parse path; a plain identifier `ledger` is
 * unaffected. Each ledger declares named accounts and the movements that shift
 * value between exactly two of them. The codegen lowers every movement to an
 * idempotent server action that posts a BALANCED pair into transaction_ledger,
 * and the conservation invariant (sum(debits) == sum(credits)) is proven.
 */
export interface LedgerDecl extends ASTNode {
  kind: 'LedgerDecl';
  name: Identifier;
  /** The named accounts value flows between (`account a, b, c`). */
  accounts: Identifier[];
  /** The declared value movements (`movement m { debit: a, credit: b }`). */
  movements: LedgerMovement[];
}

/** One movement within a ledger: shifts value FROM `credit` TO `debit`. */
export interface LedgerMovement extends ASTNode {
  kind: 'LedgerMovement';
  name: Identifier;
  /** Account that GAINS value (the positive posting). */
  debit: Identifier;
  /** Account that LOSES value (the negative posting). */
  credit: Identifier;
}

// ============================================================================
// SCENARIOS & CHAOS
// ============================================================================

export interface ScenarioBlock extends ASTNode {
  kind: 'ScenarioBlock';
  behaviorName: Identifier;
  scenarios: Scenario[];
}

export interface Scenario extends ASTNode {
  kind: 'Scenario';
  name: StringLiteral;
  given: Statement[];
  when: Statement[];
  then: Expression[];
}

export interface ChaosBlock extends ASTNode {
  kind: 'ChaosBlock';
  behaviorName: Identifier;
  scenarios: ChaosScenario[];
}

export interface ChaosScenario extends ASTNode {
  kind: 'ChaosScenario';
  name: StringLiteral;
  inject: Injection[];
  when: Statement[];
  then: Expression[];
  /** Granular injections (mirrors inject for isl-core compatibility) */
  injections?: ChaosInjection[];
  /** Parsed expect { } blocks merged with then-derived expectations */
  expectations: ChaosExpectation[];
  /** Scenario-level with-clause (e.g. retries, timeout) */
  withClause?: ChaosWithClause;
  /** @deprecated Use withClause instead */
  withClauses?: ChaosWithClause[];
}

export interface ChaosInjection extends ASTNode {
  kind: 'ChaosInjection';
  type: Identifier;
  arguments: ChaosArgument[];
}

export interface ChaosExpectation extends ASTNode {
  kind: 'ChaosExpectation';
  condition: Expression;
  description?: StringLiteral;
  /** @deprecated Use condition instead. Populated for backward compatibility. */
  expression?: Expression;
}

export interface ChaosArgument extends ASTNode {
  kind: 'ChaosArgument';
  name: Identifier;
  value: Expression;
}

export interface ChaosWithClause extends ASTNode {
  kind: 'ChaosWithClause';
  args: ChaosArgument[];
}

export interface Injection extends ASTNode {
  kind: 'Injection';
  type: InjectionType;
  target: Expression;
  parameters: InjectionParam[];
}

export type InjectionType =
  | 'database_failure'
  | 'network_latency'
  | 'network_partition'
  | 'service_unavailable'
  | 'cpu_pressure'
  | 'memory_pressure'
  | 'clock_skew'
  | 'concurrent_requests';

export interface InjectionParam extends ASTNode {
  kind: 'InjectionParam';
  name: Identifier;
  value: Expression;
}

// ============================================================================
// EXPRESSIONS
// ============================================================================

export type Expression =
  | Identifier
  | QualifiedName
  | Literal
  | StringLiteral
  | NumberLiteral
  | BooleanLiteral
  | NullLiteral
  | DurationLiteral
  | RegexLiteral
  | BinaryExpr
  | UnaryExpr
  | CallExpr
  | MemberExpr
  | IndexExpr
  | QuantifierExpr
  | ConditionalExpr
  | OldExpr
  | ResultExpr
  | InputExpr
  | LambdaExpr
  | ListExpr
  | MapExpr;

export interface Identifier extends ASTNode {
  kind: 'Identifier';
  name: string;
}

export interface QualifiedName extends ASTNode {
  kind: 'QualifiedName';
  parts: Identifier[];
}

export interface Literal extends ASTNode {
  kind: 'Literal';
  litKind: 'string' | 'number' | 'boolean' | 'null' | 'duration' | 'regex';
}

export interface StringLiteral extends ASTNode {
  kind: 'StringLiteral';
  value: string;
}

export interface NumberLiteral extends ASTNode {
  kind: 'NumberLiteral';
  value: number;
  isFloat: boolean;
}

export interface BooleanLiteral extends ASTNode {
  kind: 'BooleanLiteral';
  value: boolean;
}

export interface NullLiteral extends ASTNode {
  kind: 'NullLiteral';
}

export interface DurationLiteral extends ASTNode {
  kind: 'DurationLiteral';
  value: number;
  unit: 'ms' | 'seconds' | 'minutes' | 'hours' | 'days';
}

export interface RegexLiteral extends ASTNode {
  kind: 'RegexLiteral';
  pattern: string;
  flags: string;
}

export interface BinaryExpr extends ASTNode {
  kind: 'BinaryExpr';
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
}

export type BinaryOperator =
  | '=='
  | '!='
  | '<'
  | '>'
  | '<='
  | '>='
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | 'and'
  | 'or'
  | 'implies'
  | 'iff'
  | 'in';

export interface UnaryExpr extends ASTNode {
  kind: 'UnaryExpr';
  operator: UnaryOperator;
  operand: Expression;
}

export type UnaryOperator = 'not' | '-';

export interface CallExpr extends ASTNode {
  kind: 'CallExpr';
  callee: Expression;
  arguments: Expression[];
}

export interface MemberExpr extends ASTNode {
  kind: 'MemberExpr';
  object: Expression;
  property: Identifier;
}

export interface IndexExpr extends ASTNode {
  kind: 'IndexExpr';
  object: Expression;
  index: Expression;
}

export interface QuantifierExpr extends ASTNode {
  kind: 'QuantifierExpr';
  quantifier: 'all' | 'any' | 'none' | 'count' | 'sum' | 'filter';
  variable: Identifier;
  collection: Expression;
  predicate: Expression;
}

export interface ConditionalExpr extends ASTNode {
  kind: 'ConditionalExpr';
  condition: Expression;
  thenBranch: Expression;
  elseBranch: Expression;
}

export interface OldExpr extends ASTNode {
  kind: 'OldExpr';
  expression: Expression;
}

export interface ResultExpr extends ASTNode {
  kind: 'ResultExpr';
  property?: Identifier;
}

export interface InputExpr extends ASTNode {
  kind: 'InputExpr';
  property: Identifier;
}

export interface LambdaExpr extends ASTNode {
  kind: 'LambdaExpr';
  params: Identifier[];
  body: Expression;
}

export interface ListExpr extends ASTNode {
  kind: 'ListExpr';
  elements: Expression[];
}

export interface MapExpr extends ASTNode {
  kind: 'MapExpr';
  entries: MapEntry[];
}

export interface MapEntry extends ASTNode {
  kind: 'MapEntry';
  key: Expression;
  value: Expression;
}

// ============================================================================
// STATEMENTS (for scenarios)
// ============================================================================

export type Statement = AssignmentStmt | CallStmt | LoopStmt;

export interface AssignmentStmt extends ASTNode {
  kind: 'AssignmentStmt';
  target: Identifier;
  value: Expression;
}

export interface CallStmt extends ASTNode {
  kind: 'CallStmt';
  target?: Identifier;
  call: CallExpr;
}

export interface LoopStmt extends ASTNode {
  kind: 'LoopStmt';
  count: Expression;
  variable?: Identifier;
  body: Statement[];
}

// ============================================================================
// COMPOSITION
// ============================================================================

export interface Composition extends ASTNode {
  kind: 'Composition';
  name: Identifier;
  steps: CompositionStep[];
  compensations: Compensation[];
  timeout?: DurationLiteral;
  onFailure: 'compensate_reverse' | 'compensate_forward' | 'abort';
}

export interface CompositionStep extends ASTNode {
  kind: 'CompositionStep';
  order: number;
  behavior: ReferenceType;
}

export interface Compensation extends ASTNode {
  kind: 'Compensation';
  step: ReferenceType;
  compensatingBehavior: ReferenceType | 'no_action';
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

export function createLocation(
  file: string,
  line: number,
  column: number,
  endLine: number,
  endColumn: number,
): SourceLocation {
  return { file, line, column, endLine, endColumn };
}

export function mergeLocations(start: SourceLocation, end: SourceLocation): SourceLocation {
  return {
    file: start.file,
    line: start.line,
    column: start.column,
    endLine: end.endLine,
    endColumn: end.endColumn,
  };
}

// ============================================================================
// BACKWARD COMPATIBILITY ALIASES
// These aliases maintain compatibility with packages that used @isl-lang/isl-core
// ============================================================================

/** @deprecated Use Domain instead */
export type DomainDeclaration = Domain;

/** @deprecated Use Entity instead */
export type EntityDeclaration = Entity;

/** @deprecated Use Behavior instead */
export type BehaviorDeclaration = Behavior;

/** @deprecated Use Field instead */
export type FieldDeclaration = Field;

/** @deprecated Use TypeDeclaration */
// ============================================================================
// API / ENDPOINTS
// ============================================================================

export interface ApiBlock extends ASTNode {
  kind: 'ApiBlock';
  name?: Identifier;
  basePath?: StringLiteral;
  endpoints: EndpointDecl[];
  middleware: Expression[];
}

export interface EndpointDecl extends ASTNode {
  kind: 'EndpointDecl';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'WEBSOCKET';
  path: StringLiteral;
  behavior?: Identifier;
  description?: StringLiteral;
  auth?: Expression;
  middleware: Expression[];
  params: Field[];
  headers: Field[];
  body?: TypeDefinition;
  response?: TypeDefinition;
}

// ============================================================================
// STORAGE / PERSISTENCE
// ============================================================================

export interface StorageDecl extends ASTNode {
  kind: 'StorageDecl';
  entity: Identifier;
  engine: StringLiteral;
  table?: StringLiteral;
  collection?: StringLiteral;
  indexes: IndexDecl[];
  migrations: MigrationDecl[];
  seeds: SeedDecl[];
}

export interface IndexDecl extends ASTNode {
  kind: 'IndexDecl';
  fields: Identifier[];
  unique: boolean;
  name?: StringLiteral;
}

export interface MigrationDecl extends ASTNode {
  kind: 'MigrationDecl';
  version: StringLiteral;
  description?: StringLiteral;
  up: Expression[];
  down: Expression[];
}

export interface SeedDecl extends ASTNode {
  kind: 'SeedDecl';
  name: StringLiteral;
  data: Expression[];
}

// ============================================================================
// WORKFLOWS
// ============================================================================

export interface WorkflowDecl extends ASTNode {
  kind: 'WorkflowDecl';
  name: Identifier;
  description?: StringLiteral;
  steps: WorkflowStep[];
  onFailure?: Expression;
  timeout?: DurationLiteral;
  /**
   * Optional typed entry contract — `workflow W { input { leadId: UUID, … } … }`. The
   * data a caller must supply. When present, the DAG data-flow proof becomes airtight:
   * a step's required `<entity>Id` input must be a declared input OR produced by a
   * transitive predecessor, else it can never be satisfied (MISSING_DATA_DEP). Absent ⇒
   * the data-flow proof honestly skips (no input contract to check against).
   */
  input?: InputSpec;
}

export interface WorkflowStep extends ASTNode {
  kind: 'WorkflowStep';
  order: number;
  name?: Identifier;
  action: Expression;
  parallel?: boolean;
  timeout?: DurationLiteral;
  retry?: RetrySpec;
  rollback?: Expression;
  awaitCondition?: Expression;
  awaitTimeout?: DurationLiteral;
  foreach?: Expression;
  /**
   * Explicit dependency edges — the step orders that MUST complete before this step
   * runs. Turns the workflow from a plain ordered sequence into a true DAG: a step with
   * ≥2 `dependsOn` entries is a join/merge (it waits on all of them). Absent (or empty)
   * ⇒ the step is governed purely by declared order (the legacy, unchanged behavior).
   * Authored as `dependsOn: [1, 2]` (also `needs:` / `after:`) referencing step orders.
   */
  dependsOn?: number[];
}

export interface RetrySpec extends ASTNode {
  kind: 'RetrySpec';
  maxAttempts: number;
  delay?: DurationLiteral;
  backoff?: 'linear' | 'exponential';
}

// ============================================================================
// EVENTS
// ============================================================================

export interface EventDecl extends ASTNode {
  kind: 'EventDecl';
  name: Identifier;
  description?: StringLiteral;
  payload: Field[];
}

export interface EmitsDecl extends ASTNode {
  kind: 'EmitsDecl';
  event: Identifier;
  condition?: Expression;
}

export interface HandlerDecl extends ASTNode {
  kind: 'HandlerDecl';
  event: Identifier;
  name?: Identifier;
  action: Expression;
  async: boolean;
}

// ============================================================================
// SCREENS / UI
// ============================================================================

export interface ScreenDecl extends ASTNode {
  kind: 'ScreenDecl';
  name: Identifier;
  description?: StringLiteral;
  route?: StringLiteral;
  layout?: Identifier;
  components: ComponentDecl[];
  navigation: NavigationDecl[];
  /** public | customer | employee | admin | staff | anonymous */
  audience?: Identifier;
  /** none | required */
  authentication?: Identifier;
  /** public | authenticated | internal */
  visibility?: Identifier;
  /** Primary entity/context this surface operates on. */
  contextEntity?: Identifier;
  allowedActions?: Identifier[];
}

export interface ComponentDecl extends ASTNode {
  kind: 'ComponentDecl';
  name: Identifier;
  type: 'form' | 'list' | 'detail' | 'chart' | 'custom';
  behavior?: Identifier;
  entity?: Identifier;
  fields: ScreenFieldDecl[];
  submit?: StringLiteral;
  actions: Expression[];
}

export interface ScreenFieldDecl extends ASTNode {
  kind: 'ScreenFieldDecl';
  name: Identifier;
  inputType?: StringLiteral;
  label?: StringLiteral;
  validation?: Expression;
  required?: boolean;
}

export interface NavigationDecl extends ASTNode {
  kind: 'NavigationDecl';
  label: StringLiteral;
  target: Identifier | StringLiteral;
  icon?: StringLiteral;
}

// ============================================================================
// CONFIG / ENVIRONMENT
// ============================================================================

export interface ConfigBlock extends ASTNode {
  kind: 'ConfigBlock';
  name?: Identifier;
  entries: ConfigEntry[];
}

export interface ConfigEntry extends ASTNode {
  kind: 'ConfigEntry';
  key: Identifier;
  type?: TypeDefinition;
  source: 'env' | 'secret' | 'default';
  reference: StringLiteral;
  defaultValue?: Expression;
  required: boolean;
}

// ============================================================================
// DEPRECATED ALIASES
// ============================================================================

export type EnumDeclaration = TypeDeclaration;

/** @deprecated Use Expression instead */
export type ConditionStatement = Expression;

/** @deprecated Use Expression instead */
export type InvariantStatement = Expression;

/** @deprecated Use TypeDefinition instead */
export type TypeExpression = TypeDefinition;

/** @deprecated Use InputSpec instead */
export type InputBlock = InputSpec;

/** @deprecated Use OutputSpec instead */
export type OutputBlock = OutputSpec;

/** @deprecated Use TemporalSpec instead */
export type TemporalBlock = TemporalSpec;

/** @deprecated Use TemporalSpec instead */
export type TemporalRequirement = TemporalSpec;

/** @deprecated Use PostconditionBlock instead */
export type ConditionBlock = PostconditionBlock;
