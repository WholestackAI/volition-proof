/**
 * Peggy-based ISL Parser Adapter
 *
 * Wraps the Peggy-generated parser and produces the same Domain AST as the
 * hand-written recursive descent parser in ../parser.ts.
 *
 * Usage:
 *   import { parsePeggy } from './grammar/index.js';
 *   const result = parsePeggy(source, 'auth.isl');
 */

import type { Domain, SourceLocation } from '../ast.js';
import type { Diagnostic } from '../errors.js';

// The Peggy-generated parser is built by `pnpm run build:grammar`
// It exports a `parse(input, options?)` function.
import * as peggyParser from './isl-parser.js';

export interface PeggyParseResult {
  success: boolean;
  domain?: Domain;
  errors: Diagnostic[];
}

/**
 * Parse ISL source using the Peggy grammar.
 *
 * @param source  ISL source code
 * @param filename  Optional filename for error locations
 * @returns PeggyParseResult matching the shape of ParseResult from parser.ts
 */
export function parsePeggy(source: string, filename?: string): PeggyParseResult {
  try {
    const ast = peggyParser.parse(source, {
      filename: filename ?? '<input>',
    }) as Domain;

    return {
      success: true,
      domain: ast,
      errors: [],
    };
  } catch (err: unknown) {
    // Peggy throws SyntaxError with location info
    const peggyErr = err as {
      message?: string;
      location?: {
        start: { line: number; column: number; offset: number };
        end: { line: number; column: number; offset: number };
      };
      expected?: Array<{ type: string; description: string }>;
      found?: string;
    };

    const loc: SourceLocation = peggyErr.location
      ? {
          file: filename ?? '<input>',
          line: peggyErr.location.start.line,
          column: peggyErr.location.start.column,
          endLine: peggyErr.location.end.line,
          endColumn: peggyErr.location.end.column,
        }
      : {
          file: filename ?? '<input>',
          line: 1,
          column: 1,
          endLine: 1,
          endColumn: 1,
        };

    const message = peggyErr.message ?? 'Parse error';

    return {
      success: false,
      domain: undefined,
      errors: [
        {
          severity: 'error',
          code: 'E_PEGGY_PARSE',
          message,
          location: loc,
          source: 'peggy-parser',
        },
      ],
    };
  }
}
