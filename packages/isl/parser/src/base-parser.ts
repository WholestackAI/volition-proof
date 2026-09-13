// ============================================================================
// ISL Recursive Descent Parser — Core Infrastructure
// ============================================================================

import type { Token, TokenKind } from './tokens.js';
import type * as AST from './ast.js';
import { ErrorCollector, expectedToken, SYNC_TOKENS, type Diagnostic } from './errors.js';
import { DEFAULT_PARSER_LIMITS, type ParserLimits } from './parser-limits.js';

export interface ParseResult {
  success: boolean;
  domain?: AST.Domain;
  errors: Diagnostic[];
  tokens?: Token[];
  islVersion?: string;
}

export class Parser {
  protected tokens: Token[] = [];
  protected current: number = 0;
  protected filename: string;
  protected errors: ErrorCollector;
  protected _panicMode: boolean = false;
  protected limits: ParserLimits;
  protected parseDepth: number = 0;
  /**
   * >0 while parsing a `-`-bulleted obligation list (preconditions / invariants /
   * postcondition predicates / …). In that context parseAdditive treats a `-` that
   * BEGINS a new line and is followed by an expression-start token as the NEXT
   * bullet rather than a subtraction, so each bulleted line parses as its own
   * clause instead of folding into one `a > 0 - b > 0` chain.
   * See parseBulletedExpression / parseAdditive / isObligationBulletFollower.
   */
  protected bulletedListDepth: number = 0;

  /**
   * Tokens that can start an obligation after a bullet `-`.
   * Must stay aligned with skipOptionalBullet — unparse parenthesizes
   * BinaryExpr, so the common form is `- (expr)` (LPAREN), not `- ident`.
   */
  protected isObligationBulletFollower(token: Token | undefined): boolean {
    if (!token) return false;
    return (
      token.type === 'IDENTIFIER' ||
      token.type === 'KEYWORD' ||
      token.kind === 'LPAREN' ||
      token.kind === 'NOT'
    );
  }

  get inPanicMode(): boolean {
    return this._panicMode;
  }

  constructor(filename: string = '<input>', limits?: ParserLimits) {
    this.filename = filename;
    this.errors = new ErrorCollector();
    this.limits = limits ?? DEFAULT_PARSER_LIMITS;
  }

  protected incrementDepth(): void {
    this.parseDepth++;
  }

  protected decrementDepth(): void {
    this.parseDepth--;
  }

  protected checkDepth(): void {
    if (this.limits.enabled && this.parseDepth >= this.limits.maxDepth) {
      throw new Error('Max parse depth exceeded');
    }
    this.incrementDepth();
  }

  protected currentToken(): Token {
    return this.tokens[this.current] ?? this.eofToken();
  }

  protected previousToken(): Token {
    return this.tokens[this.current - 1] ?? this.eofToken();
  }

  protected peekNextToken(): Token | undefined {
    return this.tokens[this.current + 1];
  }

  protected eofToken(): Token {
    return {
      type: 'EOF',
      kind: 'EOF',
      value: '',
      location: {
        file: this.filename,
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 1,
      },
    };
  }

  protected currentLocation(): AST.SourceLocation {
    return this.currentToken().location;
  }

  protected isAtEnd(): boolean {
    return this.currentToken().kind === 'EOF';
  }

  protected check(kind: TokenKind): boolean {
    if (this.isAtEnd()) return false;
    return this.currentToken().kind === kind;
  }

  protected match(kind: TokenKind): boolean {
    if (this.check(kind)) {
      this.advance();
      return true;
    }
    return false;
  }

  protected advance(): Token {
    if (!this.isAtEnd()) {
      this.current++;
    }
    return this.tokens[this.current - 1] ?? this.eofToken();
  }

  protected expect(kind: TokenKind, message: string): Token {
    if (this.check(kind)) {
      return this.advance();
    }
    throw expectedToken(message, this.currentToken());
  }

  protected synchronize(): void {
    this._panicMode = true;
    this.advance();
    while (!this.isAtEnd()) {
      if (SYNC_TOKENS.has(this.currentToken().kind)) {
        this._panicMode = false;
        return;
      }
      this.advance();
    }
    this._panicMode = false;
  }
}
