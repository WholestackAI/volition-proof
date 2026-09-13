// ============================================================================
// ISL Parser - Public API
// ============================================================================

import * as fs from 'fs/promises';
import { Parser, type ParseResult } from './parser.js';

// Re-export types
export * from './ast.js';
export * from './tokens.js';
export * from './errors.js';
export { Parser, type ParseResult } from './parser.js';
export { Lexer, tokenize } from './lexer.js';
export * from './fuzz-harness.js';
export {
  parseFuzzy,
  type FuzzyParseResult,
  type ParseWarning,
  type PartialNode,
} from './fuzzy-parser.js';
export * from './parser-limits.js';
export * from './build-corpus.js';

// Peggy-based parser (dual-mode transition)
export { parsePeggy, type PeggyParseResult } from './grammar/index.js';

// Versioning system
export * from './versioning.js';

// Unparse (AST → ISL source) for round-trip tests
export { unparse } from './unparse.js';

// Grammar-aware contract generator (AST productions → unparse, not template mutation)
export {
  SeededRandom,
  createRng,
  deriveSeed,
  generateIslContract,
  generateIslContractFromSeed,
  PEGGY_GENERATIVE_RULES,
  AST_KINDS,
  RARE_FEATURES,
  FUZZ_LOC,
  ident,
  str,
  num,
  bool,
  nul,
  primitive,
  refType,
  field,
  annot,
  scalarType,
} from './fuzzer/index.js';
export type {
  GenerateOptions,
  GeneratedContract,
  PeggyGenerativeRule,
  AstKind,
  RareFeature,
} from './fuzzer/index.js';

// ============================================================================
// PARSER API (matches contracts/api.ts)
// ============================================================================

export interface ParserAPI {
  /** Parse ISL source code into an AST */
  parse(source: string, filename?: string): ParseResult;

  /** Parse an ISL file from disk */
  parseFile(path: string): Promise<ParseResult>;
}

/**
 * Parse ISL source code into an AST (hand-written recursive descent parser).
 * This is the current default parser.
 * @param source - ISL source code
 * @param filename - Optional filename for error reporting
 * @returns ParseResult with success status, domain AST, errors, and tokens
 */
export function parse(source: string, filename?: string): ParseResult {
  const parser = new Parser(filename);
  return parser.parse(source);
}

/**
 * Legacy parser alias — calls the hand-written recursive descent parser.
 * Use this explicitly when you need guaranteed compatibility with the original parser.
 */
export const parseLegacy = parse;

/**
 * Parse an ISL file from disk
 * @param path - Path to the ISL file
 * @returns Promise<ParseResult> with parsed domain
 */
export async function parseFile(path: string): Promise<ParseResult> {
  try {
    const source = await fs.readFile(path, 'utf-8');
    return parse(source, path);
  } catch (error) {
    return {
      success: false,
      errors: [
        {
          severity: 'error',
          code: 'E001',
          message: error instanceof Error ? error.message : 'Failed to read file',
          location: {
            file: path,
            line: 1,
            column: 1,
            endLine: 1,
            endColumn: 1,
          },
          source: 'parser',
        },
      ],
    };
  }
}

/**
 * Create a ParserAPI instance
 * @returns ParserAPI implementation
 */
export function createParser(): ParserAPI {
  return {
    parse,
    parseFile,
  };
}

// Default export
export default {
  parse,
  parseFile,
  createParser,
};
