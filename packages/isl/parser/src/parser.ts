// ============================================================================
// ISL Recursive Descent Parser
// ============================================================================
//
// This file is the public entry point. The implementation is split across:
//   - base-parser.ts      : token stream and core infrastructure
//   - expression-parser.ts : expressions, literals, operators
//   - statement-parser.ts : domain, entity, behavior, type declarations
//   - ast-builder.ts      : AST node construction helpers
//

export { StatementParser as Parser } from './statement-parser.js';
export { ExpressionParser } from './expression-parser.js';
export { StatementParser } from './statement-parser.js';
export type { ParseResult } from './base-parser.js';

import { StatementParser } from './statement-parser.js';
import type { ParseResult } from './base-parser.js';

export function parse(source: string, filename?: string): ParseResult {
  const parser = new StatementParser(filename);
  return parser.parse(source);
}
