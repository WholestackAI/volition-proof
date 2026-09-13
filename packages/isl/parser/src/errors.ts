// ============================================================================
// ISL Parser Error Handling
// ============================================================================
//
// This module provides error handling for the ISL parser.
// Standalone implementation without external dependencies.
//
// ============================================================================

import type { SourceLocation } from './ast.js';
import type { Token } from './tokens.js';

// ============================================================================
// Inline Error Definitions (to avoid external dependency)
// ============================================================================

const LEXER_ERRORS = {
  UNEXPECTED_CHARACTER: { code: 'L001' },
  UNTERMINATED_STRING: { code: 'L002' },
  UNTERMINATED_REGEX: { code: 'L003' },
  INVALID_ESCAPE: { code: 'L004' },
  INVALID_NUMBER: { code: 'L005' },
  UNTERMINATED_COMMENT: { code: 'L006' },
};

const PARSER_ERRORS = {
  UNEXPECTED_TOKEN: { code: 'P001' },
  EXPECTED_TOKEN: { code: 'P002' },
  EXPECTED_IDENTIFIER: { code: 'P003' },
  EXPECTED_TYPE: { code: 'P004' },
  EXPECTED_EXPRESSION: { code: 'P005' },
  MISSING_CLOSING_BRACE: { code: 'P006' },
  MISSING_CLOSING_PAREN: { code: 'P007' },
  MISSING_CLOSING_BRACKET: { code: 'P008' },
  DUPLICATE_FIELD: { code: 'P009' },
  DUPLICATE_ENTITY: { code: 'P010' },
  DUPLICATE_BEHAVIOR: { code: 'P011' },
  DUPLICATE_TYPE: { code: 'P012' },
  MISSING_VERSION: { code: 'P013' },
  INVALID_CONSTRAINT: { code: 'P014' },
  INVALID_ANNOTATION: { code: 'P015' },
  INVALID_LIFECYCLE: { code: 'P016' },
  EXPECTED_STATEMENT: { code: 'P017' },
  INVALID_OPERATOR: { code: 'P018' },
  UNCLOSED_BLOCK: { code: 'P019' },
};

// ISL keywords for suggestions
const ISL_KEYWORDS = [
  'domain',
  'entity',
  'behavior',
  'type',
  'enum',
  'view',
  'policy',
  'invariants',
  'scenarios',
  'chaos',
  'input',
  'output',
  'success',
  'errors',
  'preconditions',
  'postconditions',
  'temporal',
  'security',
  'version',
  'owner',
  'use',
  'imports',
  'from',
  'lifecycle',
  'actors',
  'description',
  'when',
  'retriable',
  'retry_after',
  'eventually',
  'always',
  'within',
  'never',
  'immediately',
  'requires',
  'rate_limit',
  'compliance',
  'given',
  'then',
  'inject',
  // Full-stack keywords
  'api',
  'endpoint',
  'storage',
  'workflow',
  'event',
  'handler',
  'screen',
  'config',
  'middleware',
  'auth',
  'params',
  'headers',
  'body',
  'engine',
  'table',
  'indexes',
  'form',
  'component',
  'navigation',
  'env',
  'secret',
  'emits',
  'subscribes',
  'step',
  'parallel',
  'await',
  'retry',
  'rollback',
  'submit',
  'layout',
];

/**
 * Find similar strings using Levenshtein distance
 */
function findSimilar(
  target: string,
  candidates: string[],
  options: { maxDistance?: number } = {},
): Array<{ value: string; distance: number }> {
  const maxDistance = options.maxDistance ?? 3;
  const results: Array<{ value: string; distance: number }> = [];

  for (const candidate of candidates) {
    const distance = levenshteinDistance(target.toLowerCase(), candidate.toLowerCase());
    if (distance <= maxDistance) {
      results.push({ value: candidate, distance });
    }
  }

  return results.sort((a, b) => a.distance - b.distance);
}

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1, // deletion
        matrix[i]![j - 1]! + 1, // insertion
        matrix[i - 1]![j - 1]! + cost, // substitution
      );
    }
  }

  return matrix[b.length]![a.length]!;
}

// Re-export types for backward compatibility
export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';
export type DiagnosticTag = 'unnecessary' | 'deprecated';

export interface RelatedInformation {
  message: string;
  location: SourceLocation;
}

export interface CodeFix {
  title: string;
  edits: TextEdit[];
  isPreferred?: boolean;
}

export interface TextEdit {
  range: { start: Position; end: Position };
  newText: string;
}

export interface Position {
  line: number;
  character: number;
}

// Legacy Diagnostic interface for backward compatibility
export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  location: SourceLocation;
  source: string;
  relatedInformation?: RelatedInformation[];
  fix?: CodeFix;
  tags?: DiagnosticTag[];
  /** Notes for additional context (new) */
  notes?: string[];
  /** Help suggestions (new) */
  help?: string[];
}

// ============================================================================
// Error Codes - Map to new unified codes
// ============================================================================

// Legacy code mapping for backward compatibility
export const ErrorCode = {
  // Lexer errors (E0001-E0099)
  UNEXPECTED_CHARACTER: LEXER_ERRORS.UNEXPECTED_CHARACTER.code,
  UNTERMINATED_STRING: LEXER_ERRORS.UNTERMINATED_STRING.code,
  UNTERMINATED_REGEX: LEXER_ERRORS.UNTERMINATED_REGEX.code,
  INVALID_ESCAPE: LEXER_ERRORS.INVALID_ESCAPE.code,
  INVALID_NUMBER: LEXER_ERRORS.INVALID_NUMBER.code,
  UNTERMINATED_COMMENT: LEXER_ERRORS.UNTERMINATED_COMMENT.code,

  // Parser errors (E0100-E0199)
  UNEXPECTED_TOKEN: PARSER_ERRORS.UNEXPECTED_TOKEN.code,
  EXPECTED_TOKEN: PARSER_ERRORS.EXPECTED_TOKEN.code,
  EXPECTED_IDENTIFIER: PARSER_ERRORS.EXPECTED_IDENTIFIER.code,
  EXPECTED_TYPE: PARSER_ERRORS.EXPECTED_TYPE.code,
  EXPECTED_EXPRESSION: PARSER_ERRORS.EXPECTED_EXPRESSION.code,
  MISSING_CLOSING_BRACE: PARSER_ERRORS.MISSING_CLOSING_BRACE.code,
  MISSING_CLOSING_PAREN: PARSER_ERRORS.MISSING_CLOSING_PAREN.code,
  MISSING_CLOSING_BRACKET: PARSER_ERRORS.MISSING_CLOSING_BRACKET.code,
  DUPLICATE_FIELD: PARSER_ERRORS.DUPLICATE_FIELD.code,
  DUPLICATE_ENTITY: PARSER_ERRORS.DUPLICATE_ENTITY.code,
  DUPLICATE_BEHAVIOR: PARSER_ERRORS.DUPLICATE_BEHAVIOR.code,
  DUPLICATE_TYPE: PARSER_ERRORS.DUPLICATE_TYPE.code,
  MISSING_VERSION: PARSER_ERRORS.MISSING_VERSION.code,
  INVALID_CONSTRAINT: PARSER_ERRORS.INVALID_CONSTRAINT.code,
  INVALID_ANNOTATION: PARSER_ERRORS.INVALID_ANNOTATION.code,
  INVALID_LIFECYCLE: PARSER_ERRORS.INVALID_LIFECYCLE.code,
  EXPECTED_STATEMENT: PARSER_ERRORS.EXPECTED_STATEMENT.code,
  INVALID_OPERATOR: PARSER_ERRORS.INVALID_OPERATOR.code,
  UNCLOSED_BLOCK: PARSER_ERRORS.UNCLOSED_BLOCK.code,

  // Legacy semantic codes (deprecated - use typechecker)
  UNDEFINED_TYPE: 'E0201',
  UNDEFINED_REFERENCE: 'E0300',
  TYPE_MISMATCH: 'E0200',
  INVALID_FIELD_REFERENCE: 'E0202',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

// ============================================================================
// ParseError Class
// ============================================================================

/**
 * Parse error class with enhanced formatting support.
 */
export class ParseError extends Error {
  public readonly code: string;
  public readonly location: SourceLocation;
  public readonly related: RelatedInformation[];
  public readonly notes: string[];
  public readonly help: string[];

  constructor(
    message: string,
    code: string,
    location: SourceLocation,
    related: RelatedInformation[] = [],
    notes: string[] = [],
    help: string[] = [],
  ) {
    super(message);
    this.name = 'ParseError';
    this.code = code;
    this.location = location;
    this.related = related;
    this.notes = notes;
    this.help = help;
  }

  toDiagnostic(): Diagnostic {
    return {
      severity: 'error',
      code: this.code,
      message: this.message,
      location: this.location,
      source: 'parser',
      relatedInformation: this.related.length > 0 ? this.related : undefined,
      notes: this.notes.length > 0 ? this.notes : undefined,
      help: this.help.length > 0 ? this.help : undefined,
    };
  }
}

// ============================================================================
// Error Collector
// ============================================================================

/**
 * Collects multiple diagnostics during parsing.
 * Enhanced with better error recovery support.
 */
export class ErrorCollector {
  private diagnostics: Diagnostic[] = [];
  private readonly maxErrors: number;

  constructor(maxErrors: number = 100) {
    this.maxErrors = maxErrors;
  }

  add(diagnostic: Diagnostic): void {
    if (this.diagnostics.length < this.maxErrors) {
      this.diagnostics.push(diagnostic);
    }
  }

  addError(
    message: string,
    code: string,
    location: SourceLocation,
    related?: RelatedInformation[],
    notes?: string[],
    help?: string[],
  ): void {
    this.add({
      severity: 'error',
      code,
      message,
      location,
      source: 'parser',
      relatedInformation: related,
      notes,
      help,
    });
  }

  addWarning(message: string, code: string, location: SourceLocation, help?: string[]): void {
    this.add({
      severity: 'warning',
      code,
      message,
      location,
      source: 'parser',
      help,
    });
  }

  hasErrors(): boolean {
    return this.diagnostics.some((d) => d.severity === 'error');
  }

  getErrors(): Diagnostic[] {
    return this.diagnostics.filter((d) => d.severity === 'error');
  }

  getWarnings(): Diagnostic[] {
    return this.diagnostics.filter((d) => d.severity === 'warning');
  }

  getAll(): Diagnostic[] {
    return [...this.diagnostics];
  }

  clear(): void {
    this.diagnostics = [];
  }

  count(): number {
    return this.diagnostics.length;
  }

  isFull(): boolean {
    return this.diagnostics.length >= this.maxErrors;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create error message from template
 */
export function createErrorMessage(
  template: string,
  values: Record<string, string | number>,
): string {
  let message = template;
  for (const [key, value] of Object.entries(values)) {
    message = message.replace(`{${key}}`, String(value));
  }
  return message;
}

/**
 * Format location for error messages
 */
export function formatLocation(location: SourceLocation): string {
  return `${location.file}:${location.line}:${location.column}`;
}

// ============================================================================
// Error Factory Functions (Enhanced)
// ============================================================================

/**
 * Create unexpected token error with suggestions
 */
export function unexpectedToken(token: Token, expected?: string): ParseError {
  const message = expected
    ? `Unexpected token '${token.value}', expected ${expected}`
    : `Unexpected token '${token.value}'`;

  const help: string[] = [];

  // Check if it looks like a misspelled keyword
  if (token.type === 'IDENTIFIER') {
    const suggestions = findSimilar(token.value, ISL_KEYWORDS, { maxDistance: 2 });
    if (suggestions.length > 0) {
      help.push(`Did you mean '${suggestions[0]!.value}'?`);
    }
  }

  return new ParseError(message, ErrorCode.UNEXPECTED_TOKEN, token.location, [], [], help);
}

/**
 * Create expected token error
 */
export function expectedToken(expected: string, got: Token, location?: SourceLocation): ParseError {
  return new ParseError(
    `Expected ${expected}, got '${got.value}'`,
    ErrorCode.EXPECTED_TOKEN,
    location ?? got.location,
  );
}

/**
 * Create missing closing delimiter error
 */
export function missingClosingDelimiter(
  delimiter: '{' | ')' | ']',
  openLocation: SourceLocation,
  currentLocation: SourceLocation,
): ParseError {
  const codes: Record<string, string> = {
    '{': ErrorCode.MISSING_CLOSING_BRACE,
    ')': ErrorCode.MISSING_CLOSING_PAREN,
    ']': ErrorCode.MISSING_CLOSING_BRACKET,
  };
  const names: Record<string, string> = {
    '{': "'}'",
    ')': "')'",
    ']': "']'",
  };
  const openNames: Record<string, string> = {
    '{': 'brace',
    ')': 'parenthesis',
    ']': 'bracket',
  };

  return new ParseError(
    `Expected ${names[delimiter]} to close block`,
    codes[delimiter] ?? ErrorCode.UNEXPECTED_TOKEN,
    currentLocation,
    [{ message: `Opening ${openNames[delimiter]} here`, location: openLocation }],
    [],
    [`Use an editor with bracket matching to find unmatched ${openNames[delimiter]}s`],
  );
}

/**
 * Create duplicate definition error
 */
export function duplicateDefinition(
  kind: 'entity' | 'behavior' | 'type' | 'field',
  name: string,
  newLocation: SourceLocation,
  originalLocation: SourceLocation,
): ParseError {
  const codes: Record<string, string> = {
    entity: ErrorCode.DUPLICATE_ENTITY,
    behavior: ErrorCode.DUPLICATE_BEHAVIOR,
    type: ErrorCode.DUPLICATE_TYPE,
    field: ErrorCode.DUPLICATE_FIELD,
  };

  return new ParseError(
    `Duplicate ${kind} '${name}'`,
    codes[kind] ?? ErrorCode.UNEXPECTED_TOKEN,
    newLocation,
    [{ message: 'Previously defined here', location: originalLocation }],
    [`Each ${kind} must have a unique name within its scope`],
    [`Rename one of the ${kind}s or remove the duplicate`],
  );
}

/**
 * Create unclosed block error
 */
export function unclosedBlock(
  blockKind: string,
  openLocation: SourceLocation,
  currentLocation: SourceLocation,
): ParseError {
  return new ParseError(
    `Unclosed ${blockKind} block`,
    ErrorCode.UNCLOSED_BLOCK,
    currentLocation,
    [{ message: `Block opened here`, location: openLocation }],
    [`Every '{' must have a matching '}'`],
    [`Add a closing '}' to close the ${blockKind} block`],
  );
}

/**
 * Create unknown keyword error with suggestions
 */
export function unknownKeyword(token: Token, context: string): ParseError {
  const suggestions = findSimilar(token.value, ISL_KEYWORDS, { maxDistance: 3 });
  const help: string[] = [];

  if (suggestions.length > 0) {
    const suggestionList = suggestions.map((s) => `'${s.value}'`).join(', ');
    help.push(`Did you mean ${suggestionList}?`);
  }

  return new ParseError(
    `Unknown keyword '${token.value}' in ${context}`,
    ErrorCode.UNEXPECTED_TOKEN,
    token.location,
    [],
    [],
    help,
  );
}

// ============================================================================
// Synchronization Tokens for Error Recovery
// ============================================================================

/**
 * Tokens that can be used to synchronize after an error.
 * When we encounter an error, we skip tokens until we find one of these.
 */
export const SYNC_TOKENS = new Set([
  'DOMAIN',
  'ENTITY',
  'BEHAVIOR',
  'TYPE',
  'ENUM',
  'VIEW',
  'POLICY',
  'INVARIANTS',
  'SCENARIOS',
  'CHAOS',
  'INPUT',
  'OUTPUT',
  'PRECONDITIONS',
  'POSTCONDITIONS',
  'TEMPORAL',
  'SECURITY',
  'RBRACE',
  'EOF',
]);

/**
 * Secondary sync tokens (less aggressive recovery)
 */
export const SECONDARY_SYNC_TOKENS = new Set(['NEWLINE', 'SEMICOLON', 'COMMA']);
