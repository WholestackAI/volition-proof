// ============================================================================
// ISL Token Types and Definitions
// ============================================================================

import type { SourceLocation } from './ast.js';

// Token categories
export type TokenType =
  | 'KEYWORD'
  | 'IDENTIFIER'
  | 'STRING'
  | 'NUMBER'
  | 'BOOLEAN'
  | 'OPERATOR'
  | 'PUNCTUATION'
  | 'COMMENT'
  | 'DURATION'
  | 'REGEX'
  | 'WHITESPACE'
  | 'NEWLINE'
  | 'EOF'
  | 'ERROR';

// Specific token kinds for precise parsing
export type TokenKind =
  // Keywords
  | 'DOMAIN'
  | 'VERSION'
  | 'OWNER'
  | 'USE'
  | 'IMPORTS'
  | 'FROM'
  | 'AS'
  | 'TYPE'
  | 'ENUM'
  | 'ENTITY'
  | 'BEHAVIOR'
  | 'VIEW'
  | 'POLICY'
  | 'INVARIANTS'
  | 'SCENARIOS'
  | 'CHAOS'
  | 'COMPOSITION'
  | 'INPUT'
  | 'OUTPUT'
  | 'SUCCESS'
  | 'ERRORS'
  | 'WHEN'
  | 'RETRIABLE'
  | 'RETRY_AFTER'
  | 'RETURNS'
  | 'PRE'
  | 'POST'
  | 'PRECONDITIONS'
  | 'POSTCONDITIONS'
  | 'IMPLIES'
  | 'TEMPORAL'
  | 'EVENTUALLY'
  | 'ALWAYS'
  | 'WITHIN'
  | 'NEVER'
  | 'IMMEDIATELY'
  | 'SECURITY'
  | 'REQUIRES'
  | 'RATE_LIMIT'
  | 'COMPLIANCE'
  | 'OBSERVABILITY'
  | 'METRICS'
  | 'TRACES'
  | 'LOGS'
  | 'SPAN'
  | 'ACTORS'
  | 'MUST'
  | 'DESCRIPTION'
  | 'LIFECYCLE'
  | 'GIVEN'
  | 'THEN'
  | 'INJECT'
  | 'SCENARIO'
  | 'EXPECT'
  | 'WITH'
  | 'FOR'
  | 'FIELDS'
  | 'CONSISTENCY'
  | 'CACHE'
  | 'TTL'
  | 'INVALIDATE_ON'
  | 'SCOPE'
  | 'GLOBAL'
  | 'TRANSACTION'
  | 'APPLIES_TO'
  | 'RULES'
  | 'DEFAULT'
  | 'STEP'
  | 'COMPENSATIONS'
  | 'TIMEOUT'
  | 'ON_FAILURE'
  // API / Endpoints
  | 'API'
  | 'ENDPOINT'
  | 'GET'
  | 'POST_METHOD'
  | 'PUT'
  | 'PATCH'
  | 'DELETE_METHOD'
  | 'WEBSOCKET'
  | 'GRAPHQL'
  | 'QUERY'
  | 'MUTATION'
  | 'SUBSCRIPTION'
  | 'MIDDLEWARE'
  | 'CORS'
  | 'AUTH'
  | 'BODY'
  | 'PARAMS'
  | 'HEADERS'
  | 'RESPONSE'
  // Storage / Persistence
  | 'STORAGE'
  | 'ENGINE'
  | 'TABLE'
  | 'COLLECTION'
  | 'INDEXES'
  | 'UNIQUE_INDEX'
  | 'MIGRATIONS'
  | 'SEEDS'
  // Relationships
  | 'RELATES'
  | 'OWNS'
  | 'BELONGS_TO'
  | 'HAS_MANY'
  | 'HAS_ONE'
  | 'MANY_TO_MANY'
  // Computed fields
  | 'COMPUTED'
  // Workflows
  | 'WORKFLOW'
  | 'PARALLEL'
  | 'AWAIT_KW'
  | 'RETRY'
  | 'ROLLBACK'
  // Events
  | 'EVENT'
  | 'EMITS'
  | 'SUBSCRIBES'
  | 'HANDLER'
  | 'ASYNC_KW'
  // Screens / UI
  | 'SCREEN'
  | 'COMPONENT'
  | 'FORM'
  | 'LAYOUT'
  | 'NAVIGATION'
  | 'SUBMIT'
  | 'VALIDATE'
  // Config / Environment
  | 'CONFIG'
  | 'ENV'
  | 'SECRET'
  | 'DATABASE'
  | 'PORT'
  // Type keywords
  | 'STRING_TYPE'
  | 'INT_TYPE'
  | 'DECIMAL_TYPE'
  | 'BOOLEAN_TYPE'
  | 'TIMESTAMP_TYPE'
  | 'UUID_TYPE'
  | 'DURATION_TYPE'
  | 'LIST'
  | 'MAP'
  // Boolean literals
  | 'TRUE'
  | 'FALSE'
  // Operators
  | 'EQUALS'
  | 'NOT_EQUALS'
  | 'LT'
  | 'GT'
  | 'LTE'
  | 'GTE'
  | 'PLUS'
  | 'MINUS'
  | 'STAR'
  | 'SLASH'
  | 'PERCENT'
  | 'AND'
  | 'OR'
  | 'NOT'
  | 'IN'
  | 'IFF'
  | 'ASSIGN'
  | 'ARROW'
  | 'FAT_ARROW'
  | 'DOUBLE_COLON'
  // Quantifiers
  | 'ALL'
  | 'ANY'
  | 'NONE'
  | 'COUNT'
  | 'SUM'
  | 'FILTER'
  // Special expressions
  | 'OLD'
  | 'RESULT'
  | 'NOW'
  | 'THIS'
  // Punctuation
  | 'LBRACE'
  | 'RBRACE'
  | 'LPAREN'
  | 'RPAREN'
  | 'LBRACKET'
  | 'RBRACKET'
  | 'COMMA'
  | 'COLON'
  | 'SEMICOLON'
  | 'DOT'
  | 'QUESTION'
  | 'PIPE'
  | 'AT'
  // Literals
  | 'IDENTIFIER'
  | 'STRING_LITERAL'
  | 'NUMBER_LITERAL'
  | 'REGEX_LITERAL'
  | 'DURATION_LITERAL'
  // Other
  | 'COMMENT'
  | 'WHITESPACE'
  | 'NEWLINE'
  | 'EOF'
  | 'ERROR'
  // Additional context keywords
  | 'COUNTER'
  | 'GAUGE'
  | 'HISTOGRAM'
  | 'BY'
  | 'ON'
  | 'LEVEL'
  | 'INCLUDE'
  | 'EXCLUDE'
  | 'EVENTUAL'
  | 'STRONG'
  | 'STRONGLY_CONSISTENT'
  | 'PER'
  | 'AUTHENTICATED'
  | 'REFERENCES'
  // Full-stack keywords
  | 'API_KW'
  | 'ENDPOINT_KW'
  | 'STORAGE_KW'
  | 'WORKFLOW_KW'
  | 'EVENT_KW'
  | 'EMITS_KW'
  | 'SCREEN_KW'
  | 'CONFIG_KW'
  | 'COMPUTED_KW'
  | 'HANDLER_KW';

export interface Token {
  type: TokenType;
  kind: TokenKind;
  value: string;
  location: SourceLocation;
}

// Keywords mapping
export const KEYWORDS: Map<string, TokenKind> = new Map([
  // Top-level
  ['domain', 'DOMAIN'],
  ['version', 'VERSION'],
  ['owner', 'OWNER'],
  ['use', 'USE'],
  ['imports', 'IMPORTS'],
  ['from', 'FROM'],
  ['as', 'AS'],

  // Declarations
  ['type', 'TYPE'],
  ['enum', 'ENUM'],
  ['entity', 'ENTITY'],
  ['behavior', 'BEHAVIOR'],
  ['view', 'VIEW'],
  ['policy', 'POLICY'],
  ['invariants', 'INVARIANTS'],
  ['scenarios', 'SCENARIOS'],
  ['chaos', 'CHAOS'],
  ['composition', 'COMPOSITION'],

  // Behavior parts
  ['input', 'INPUT'],
  ['output', 'OUTPUT'],
  ['success', 'SUCCESS'],
  ['errors', 'ERRORS'],
  ['when', 'WHEN'],
  ['retriable', 'RETRIABLE'],
  ['retry_after', 'RETRY_AFTER'],
  ['returns', 'RETURNS'],
  // Shorthand syntax (canonical)
  ['pre', 'PRE'],
  ['post', 'POST'],
  // Verbose syntax (deprecated, but still supported)
  ['preconditions', 'PRECONDITIONS'],
  ['postconditions', 'POSTCONDITIONS'],
  ['implies', 'IMPLIES'],
  ['description', 'DESCRIPTION'],
  ['actors', 'ACTORS'],
  ['must', 'MUST'],
  ['lifecycle', 'LIFECYCLE'],

  // Temporal
  ['temporal', 'TEMPORAL'],
  ['eventually', 'EVENTUALLY'],
  ['always', 'ALWAYS'],
  ['within', 'WITHIN'],
  ['never', 'NEVER'],
  ['immediately', 'IMMEDIATELY'],
  ['response', 'TEMPORAL'], // contextual

  // Security
  ['security', 'SECURITY'],
  ['requires', 'REQUIRES'],
  ['rate_limit', 'RATE_LIMIT'],
  ['compliance', 'COMPLIANCE'],
  ['authentication', 'AUTHENTICATED'],
  ['authenticated', 'AUTHENTICATED'],

  // Observability
  ['observability', 'OBSERVABILITY'],
  ['metrics', 'METRICS'],
  ['traces', 'TRACES'],
  ['logs', 'LOGS'],
  ['span', 'SPAN'],
  ['counter', 'COUNTER'],
  ['gauge', 'GAUGE'],
  ['histogram', 'HISTOGRAM'],
  ['by', 'BY'],
  ['on', 'ON'],
  ['level', 'LEVEL'],
  ['include', 'INCLUDE'],
  ['exclude', 'EXCLUDE'],

  // Scenarios
  ['given', 'GIVEN'],
  ['then', 'THEN'],
  ['inject', 'INJECT'],
  ['scenario', 'SCENARIO'],
  ['expect', 'EXPECT'],
  ['with', 'WITH'],

  // Views
  ['for', 'FOR'],
  ['fields', 'FIELDS'],
  ['consistency', 'CONSISTENCY'],
  ['cache', 'CACHE'],
  ['ttl', 'TTL'],
  ['invalidate_on', 'INVALIDATE_ON'],
  ['eventual', 'EVENTUAL'],
  ['strong', 'STRONG'],
  ['strongly_consistent', 'STRONGLY_CONSISTENT'],

  // Invariants/Policy
  ['scope', 'SCOPE'],
  ['global', 'GLOBAL'],
  ['transaction', 'TRANSACTION'],
  ['applies_to', 'APPLIES_TO'],
  ['rules', 'RULES'],
  ['default', 'DEFAULT'],

  // Composition
  ['step', 'STEP'],
  ['compensations', 'COMPENSATIONS'],
  ['timeout', 'TIMEOUT'],
  ['on_failure', 'ON_FAILURE'],

  // API / Endpoints
  ['api', 'API'],
  ['endpoint', 'ENDPOINT'],
  ['GET', 'GET'],
  ['POST', 'POST_METHOD'],
  ['PUT', 'PUT'],
  ['PATCH', 'PATCH'],
  ['DELETE', 'DELETE_METHOD'],
  ['websocket', 'WEBSOCKET'],
  ['graphql', 'GRAPHQL'],
  ['query', 'QUERY'],
  ['mutation', 'MUTATION'],
  ['subscription', 'SUBSCRIPTION'],
  ['middleware', 'MIDDLEWARE'],
  ['cors', 'CORS'],
  ['auth', 'AUTH'],
  ['body', 'BODY'],
  ['params', 'PARAMS'],
  ['headers', 'HEADERS'],

  // Storage / Persistence
  ['storage', 'STORAGE'],
  ['engine', 'ENGINE'],
  ['table', 'TABLE'],
  ['collection', 'COLLECTION'],
  ['indexes', 'INDEXES'],
  ['migrations', 'MIGRATIONS'],
  ['seeds', 'SEEDS'],

  // Relationships
  ['owns', 'OWNS'],
  ['belongs_to', 'BELONGS_TO'],
  ['has_many', 'HAS_MANY'],
  ['has_one', 'HAS_ONE'],
  ['many_to_many', 'MANY_TO_MANY'],

  // Computed
  ['computed', 'COMPUTED'],

  // Workflows
  ['workflow', 'WORKFLOW'],
  ['parallel', 'PARALLEL'],
  ['await', 'AWAIT_KW'],
  ['retry', 'RETRY'],
  ['rollback', 'ROLLBACK'],

  // Events
  ['event', 'EVENT'],
  ['emits', 'EMITS'],
  ['subscribes', 'SUBSCRIBES'],
  ['handler', 'HANDLER'],
  ['async', 'ASYNC_KW'],

  // Screens / UI
  ['screen', 'SCREEN'],
  ['component', 'COMPONENT'],
  ['form', 'FORM'],
  ['layout', 'LAYOUT'],
  ['navigation', 'NAVIGATION'],
  ['submit', 'SUBMIT'],
  ['validate', 'VALIDATE'],

  // Config / Environment
  ['config', 'CONFIG'],
  ['env', 'ENV'],
  ['secret', 'SECRET'],
  ['database', 'DATABASE'],
  ['port', 'PORT'],

  // Types
  ['String', 'STRING_TYPE'],
  ['Int', 'INT_TYPE'],
  ['Decimal', 'DECIMAL_TYPE'],
  ['Boolean', 'BOOLEAN_TYPE'],
  ['Timestamp', 'TIMESTAMP_TYPE'],
  ['UUID', 'UUID_TYPE'],
  ['Duration', 'DURATION_TYPE'],
  ['List', 'LIST'],
  ['Map', 'MAP'],

  // Boolean
  ['true', 'TRUE'],
  ['false', 'FALSE'],

  // Logical operators
  ['and', 'AND'],
  ['or', 'OR'],
  ['not', 'NOT'],
  ['in', 'IN'],
  ['iff', 'IFF'],

  // Quantifiers
  ['all', 'ALL'],
  ['any', 'ANY'],
  ['none', 'NONE'],
  ['count', 'COUNT'],
  ['sum', 'SUM'],
  ['filter', 'FILTER'],

  // Special expressions
  ['old', 'OLD'],
  ['result', 'RESULT'],
  ['now', 'NOW'],
  ['this', 'THIS'],

  // Other
  ['per', 'PER'],
  ['references', 'REFERENCES'],
  ['is', 'EQUALS'], // contextual equals
  ['error', 'ERROR'],
  ['any_error', 'ANY'],
]);

// Duration units - ordered by length (longest first for proper matching)
export const DURATION_UNITS = [
  'seconds',
  'minutes',
  'hours',
  'days',
  'ms',
  's',
  'm',
  'h',
  'd',
] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

// Map short units to canonical form for normalization
export const SHORT_UNIT_MAP: Record<string, string> = {
  s: 'seconds',
  m: 'minutes',
  h: 'hours',
  d: 'days',
  ms: 'ms',
  seconds: 'seconds',
  minutes: 'minutes',
  hours: 'hours',
  days: 'days',
};

// Operator precedence for expression parsing
export const PRECEDENCE: Record<string, number> = {
  or: 1,
  '||': 1,
  and: 2,
  '&&': 2,
  implies: 2,
  iff: 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '>': 4,
  '<=': 4,
  '>=': 4,
  in: 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
  not: 7,
};

// Check if a string is a primitive type
export function isPrimitiveType(name: string): boolean {
  return [
    'String',
    'Int',
    'Decimal',
    'Boolean',
    'Timestamp',
    'UUID',
    'Duration',
    'Date',
    'Money',
    'File',
  ].includes(name);
}

// Create a token helper
export function createToken(
  type: TokenType,
  kind: TokenKind,
  value: string,
  file: string,
  line: number,
  column: number,
  endLine: number,
  endColumn: number,
): Token {
  return {
    type,
    kind,
    value,
    location: { file, line, column, endLine, endColumn },
  };
}
