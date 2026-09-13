// ============================================================================
// ISL Lexer - Tokenization
// ============================================================================

import type { SourceLocation } from './ast.js';
import type { Token, TokenType, TokenKind } from './tokens.js';
import { KEYWORDS, DURATION_UNITS, createToken } from './tokens.js';
import { ErrorCollector, ErrorCode } from './errors.js';

export class Lexer {
  private source: string;
  private filename: string;
  private pos: number = 0;
  private line: number = 1;
  private column: number = 1;
  private tokens: Token[] = [];
  private errors: ErrorCollector;

  constructor(source: string, filename: string = '<input>', errors?: ErrorCollector) {
    this.source = source;
    this.filename = filename;
    this.errors = errors ?? new ErrorCollector();
  }

  tokenize(): { tokens: Token[]; errors: ErrorCollector } {
    this.tokens = [];
    this.pos = 0;
    this.line = 1;
    this.column = 1;

    while (!this.isAtEnd()) {
      const token = this.scanToken();
      if (token) {
        // Skip whitespace and newlines but keep comments for tooling
        if (token.type !== 'WHITESPACE' && token.type !== 'NEWLINE') {
          this.tokens.push(token);
        }
      }
    }

    // Add EOF token
    this.tokens.push(this.makeToken('EOF', 'EOF', ''));
    return { tokens: this.tokens, errors: this.errors };
  }

  private scanToken(): Token | null {
    const startLine = this.line;
    const startColumn = this.column;
    const c = this.advance();

    // Whitespace
    if (this.isWhitespace(c)) {
      this.skipWhitespace();
      return null;
    }

    // Newlines
    if (c === '\n') {
      this.line++;
      this.column = 1;
      return null;
    }
    if (c === '\r') {
      if (this.peek() === '\n') {
        this.advance();
      }
      this.line++;
      this.column = 1;
      return null;
    }

    // Comments + regex literals (both start with `/`)
    if (c === '/') {
      if (this.peek() === '/') {
        return this.lineComment(startLine, startColumn);
      }
      if (this.peek() === '*') {
        return this.blockComment(startLine, startColumn);
      }
      // Disambiguate regex literal vs division: a `/` begins a regex only in a
      // position where a value cannot already precede it (start of input, or
      // right after an operator/`:`/`(`/`[`/`,`/`{`/`=>`). After an identifier,
      // number, `)`, `]`, or string, `/` is the division operator. ISL spec
      // patterns always appear as `pattern: /.../ ` so they take the regex path.
      if (this.regexAllowed()) {
        return this.regex(startLine, startColumn);
      }
      return this.makeTokenAt('OPERATOR', 'SLASH', '/', startLine, startColumn);
    }

    // Hash comments (Python/Ruby style)
    if (c === '#') {
      return this.lineComment(startLine, startColumn, '#');
    }

    // Strings (double or single quotes)
    if (c === '"' || c === "'") {
      return this.string(startLine, startColumn, c);
    }

    // Numbers - only start with digit, negative numbers are handled as MINUS + NUMBER
    if (this.isDigit(c)) {
      return this.number(startLine, startColumn, c);
    }

    // Identifiers and keywords
    if (this.isAlpha(c) || c === '_') {
      return this.identifier(startLine, startColumn, c);
    }

    // Operators and punctuation
    switch (c) {
      case '{':
        return this.makeTokenAt('PUNCTUATION', 'LBRACE', '{', startLine, startColumn);
      case '}':
        return this.makeTokenAt('PUNCTUATION', 'RBRACE', '}', startLine, startColumn);
      case '(':
        return this.makeTokenAt('PUNCTUATION', 'LPAREN', '(', startLine, startColumn);
      case ')':
        return this.makeTokenAt('PUNCTUATION', 'RPAREN', ')', startLine, startColumn);
      case '[':
        return this.makeTokenAt('PUNCTUATION', 'LBRACKET', '[', startLine, startColumn);
      case ']':
        return this.makeTokenAt('PUNCTUATION', 'RBRACKET', ']', startLine, startColumn);
      case ',':
        return this.makeTokenAt('PUNCTUATION', 'COMMA', ',', startLine, startColumn);
      case ':': {
        if (this.peek() === ':') {
          this.advance();
          return this.makeTokenAt('OPERATOR', 'DOUBLE_COLON', '::', startLine, startColumn);
        }
        return this.makeTokenAt('PUNCTUATION', 'COLON', ':', startLine, startColumn);
      }
      case ';':
        return this.makeTokenAt('PUNCTUATION', 'SEMICOLON', ';', startLine, startColumn);
      case '.':
        return this.makeTokenAt('PUNCTUATION', 'DOT', '.', startLine, startColumn);
      case '?':
        return this.makeTokenAt('PUNCTUATION', 'QUESTION', '?', startLine, startColumn);
      case '|': {
        if (this.peek() === '|') {
          this.advance();
          return this.makeTokenAt('OPERATOR', 'OR', '||', startLine, startColumn);
        }
        return this.makeTokenAt('PUNCTUATION', 'PIPE', '|', startLine, startColumn);
      }
      case '&': {
        if (this.peek() === '&') {
          this.advance();
          return this.makeTokenAt('OPERATOR', 'AND', '&&', startLine, startColumn);
        }
        // Single & is not a valid ISL token - report error
        this.errors.addError(
          `Unexpected character '${c}'`,
          ErrorCode.UNEXPECTED_CHARACTER,
          this.makeLocation(startLine, startColumn, this.line, this.column),
        );
        return null;
      }
      case '@':
        return this.makeTokenAt('PUNCTUATION', 'AT', '@', startLine, startColumn);

      case '=': {
        if (this.peek() === '=') {
          this.advance();
          return this.makeTokenAt('OPERATOR', 'EQUALS', '==', startLine, startColumn);
        }
        if (this.peek() === '>') {
          this.advance();
          return this.makeTokenAt('OPERATOR', 'FAT_ARROW', '=>', startLine, startColumn);
        }
        return this.makeTokenAt('OPERATOR', 'ASSIGN', '=', startLine, startColumn);
      }
      case '!': {
        if (this.peek() === '=') {
          this.advance();
          return this.makeTokenAt('OPERATOR', 'NOT_EQUALS', '!=', startLine, startColumn);
        }
        return this.makeTokenAt('OPERATOR', 'NOT', '!', startLine, startColumn);
      }
      case '<': {
        if (this.peek() === '=') {
          this.advance();
          return this.makeTokenAt('OPERATOR', 'LTE', '<=', startLine, startColumn);
        }
        return this.makeTokenAt('OPERATOR', 'LT', '<', startLine, startColumn);
      }
      case '>': {
        if (this.peek() === '=') {
          this.advance();
          return this.makeTokenAt('OPERATOR', 'GTE', '>=', startLine, startColumn);
        }
        return this.makeTokenAt('OPERATOR', 'GT', '>', startLine, startColumn);
      }
      case '+':
        return this.makeTokenAt('OPERATOR', 'PLUS', '+', startLine, startColumn);
      case '-': {
        if (this.peek() === '>') {
          this.advance();
          return this.makeTokenAt('OPERATOR', 'ARROW', '->', startLine, startColumn);
        }
        return this.makeTokenAt('OPERATOR', 'MINUS', '-', startLine, startColumn);
      }
      case '*':
        return this.makeTokenAt('OPERATOR', 'STAR', '*', startLine, startColumn);
      case '%':
        return this.makeTokenAt('OPERATOR', 'PERCENT', '%', startLine, startColumn);

      default: {
        this.errors.addError(
          `Unexpected character '${c}'`,
          ErrorCode.UNEXPECTED_CHARACTER,
          this.makeLocation(startLine, startColumn, this.line, this.column),
        );
        return null;
      }
    }
  }

  private lineComment(startLine: number, startColumn: number, prefix: string = '//'): Token {
    // For // comments, consume the second slash
    if (prefix === '//') {
      this.advance(); // consume second '/'
    }
    let value = prefix;
    while (!this.isAtEnd() && this.peek() !== '\n') {
      value += this.advance();
    }
    return this.makeTokenAt('COMMENT', 'COMMENT', value, startLine, startColumn);
  }

  private blockComment(startLine: number, startColumn: number): Token {
    this.advance(); // consume '*'
    let value = '/*';
    while (!this.isAtEnd()) {
      if (this.peek() === '*' && this.peekNext() === '/') {
        value += this.advance(); // *
        value += this.advance(); // /
        break;
      }
      const c = this.advance();
      value += c;
      if (c === '\n') {
        this.line++;
        this.column = 1;
      }
    }
    if (!value.endsWith('*/')) {
      this.errors.addError(
        'Unterminated block comment',
        ErrorCode.UNTERMINATED_COMMENT,
        this.makeLocation(startLine, startColumn, this.line, this.column),
      );
    }
    return this.makeTokenAt('COMMENT', 'COMMENT', value, startLine, startColumn);
  }

  private string(startLine: number, startColumn: number, quote: string = '"'): Token {
    let value = '';
    while (!this.isAtEnd() && this.peek() !== quote) {
      const c = this.peek();
      if (c === '\n') {
        this.errors.addError(
          'Unterminated string literal',
          ErrorCode.UNTERMINATED_STRING,
          this.makeLocation(startLine, startColumn, this.line, this.column),
        );
        break;
      }
      if (c === '\\') {
        this.advance();
        const escaped = this.advance();
        switch (escaped) {
          case 'n':
            value += '\n';
            break;
          case 't':
            value += '\t';
            break;
          case 'r':
            value += '\r';
            break;
          case '\\':
            value += '\\';
            break;
          case '"':
            value += '"';
            break;
          case "'":
            value += "'";
            break;
          case '/':
            value += '/';
            break;
          default:
            this.errors.addError(
              `Invalid escape sequence '\\${escaped}'`,
              ErrorCode.INVALID_ESCAPE,
              this.makeLocation(this.line, this.column - 2, this.line, this.column),
            );
            value += escaped;
        }
      } else {
        value += this.advance();
      }
    }
    if (this.peek() === quote) {
      this.advance(); // closing quote
    } else {
      this.errors.addError(
        'Unterminated string literal',
        ErrorCode.UNTERMINATED_STRING,
        this.makeLocation(startLine, startColumn, this.line, this.column),
      );
    }
    return this.makeTokenAt('STRING', 'STRING_LITERAL', value, startLine, startColumn);
  }

  /**
   * A `/` starts a regex literal only where a value cannot already precede it.
   * After a value-producing token (identifier, number, string, regex, `)`, `]`)
   * a `/` is the division operator; everywhere else it opens a regex. This is
   * the standard JS-lexer heuristic, scoped to the tokens ISL emits.
   */
  private regexAllowed(): boolean {
    // Conservative allow-list: a `/` opens a regex ONLY immediately after one of
    // the punctuation tokens where an ISL pattern can begin (`pattern: /.../`,
    // `format: /.../`, inside `( [ , { ` or after `= =>`). Everywhere else —
    // including after an arithmetic operator like `*` (so `* /` stays multiply,
    // divide) or a value token — `/` is the division operator.
    const prev = this.tokens[this.tokens.length - 1];
    if (!prev) return false; // a spec never opens with a bare regex
    const REGEX_PRECEDERS = new Set([
      'COLON',
      'LPAREN',
      'LBRACKET',
      'LBRACE',
      'COMMA',
      'ASSIGN',
      'FAT_ARROW',
    ]);
    return REGEX_PRECEDERS.has(prev.kind as string);
  }

  private regex(startLine: number, startColumn: number): Token {
    let pattern = '';
    while (!this.isAtEnd() && this.peek() !== '/') {
      const c = this.peek();
      if (c === '\n') {
        this.errors.addError(
          'Unterminated regex literal',
          ErrorCode.UNTERMINATED_REGEX,
          this.makeLocation(startLine, startColumn, this.line, this.column),
        );
        break;
      }
      if (c === '\\') {
        pattern += this.advance();
        if (!this.isAtEnd()) {
          pattern += this.advance();
        }
      } else {
        pattern += this.advance();
      }
    }

    if (this.peek() === '/') {
      this.advance(); // closing /
    }

    // Parse flags
    let flags = '';
    while (this.isAlpha(this.peek())) {
      flags += this.advance();
    }

    const value = `/${pattern}/${flags}`;
    return this.makeTokenAt('REGEX', 'REGEX_LITERAL', value, startLine, startColumn);
  }

  private number(startLine: number, startColumn: number, firstChar: string): Token {
    // First char is always a digit (negative numbers are MINUS + NUMBER)
    let value = firstChar;

    while (this.isDigit(this.peek())) {
      value += this.advance();
    }

    // Check for decimal
    if (this.peek() === '.' && this.isDigit(this.peekNext())) {
      value += this.advance(); // .
      while (this.isDigit(this.peek())) {
        value += this.advance();
      }
    }

    // Check for duration unit - try longer units first
    const restOfToken = this.peekWord();
    // Sort units by length descending to match longest first
    const sortedUnits = [...DURATION_UNITS].sort((a, b) => b.length - a.length);
    for (const unit of sortedUnits) {
      if (restOfToken.startsWith(unit)) {
        // Check if it's actually the unit and not part of a longer word
        const afterUnit = restOfToken.slice(unit.length);
        const firstCharAfter = afterUnit[0];
        // For short units (s, m, h, d), be more strict - only accept if followed by non-alpha
        if (
          afterUnit === '' ||
          (firstCharAfter !== undefined && !this.isAlpha(firstCharAfter) && firstCharAfter !== '_')
        ) {
          for (let i = 0; i < unit.length; i++) {
            value += this.advance();
          }
          return this.makeTokenAt('DURATION', 'DURATION_LITERAL', value, startLine, startColumn);
        }
      }
    }

    return this.makeTokenAt('NUMBER', 'NUMBER_LITERAL', value, startLine, startColumn);
  }

  private identifier(startLine: number, startColumn: number, firstChar: string): Token {
    let value = firstChar;
    while (this.isAlphaNumeric(this.peek()) || this.peek() === '_') {
      value += this.advance();
    }

    // Check for duration with dot notation (e.g., 15.minutes)
    // This is handled in the parser as member access

    // Check if it's a keyword
    const keyword = KEYWORDS.get(value);
    if (keyword) {
      // Special handling for boolean literals
      if (value === 'true') {
        return this.makeTokenAt('BOOLEAN', 'TRUE', value, startLine, startColumn);
      }
      if (value === 'false') {
        return this.makeTokenAt('BOOLEAN', 'FALSE', value, startLine, startColumn);
      }
      return this.makeTokenAt('KEYWORD', keyword, value, startLine, startColumn);
    }

    return this.makeTokenAt('IDENTIFIER', 'IDENTIFIER', value, startLine, startColumn);
  }

  // Helper methods
  private isAtEnd(): boolean {
    return this.pos >= this.source.length;
  }

  private advance(): string {
    const c = this.source[this.pos] ?? '';
    this.pos++;
    this.column++;
    return c;
  }

  private peek(): string {
    if (this.isAtEnd()) return '\0';
    return this.source[this.pos] ?? '\0';
  }

  private peekNext(): string {
    if (this.pos + 1 >= this.source.length) return '\0';
    return this.source[this.pos + 1] ?? '\0';
  }

  private peekWord(): string {
    let word = '';
    let pos = this.pos;
    while (
      pos < this.source.length &&
      (this.isAlphaNumeric(this.source[pos] ?? '') || this.source[pos] === '_')
    ) {
      word += this.source[pos];
      pos++;
    }
    return word;
  }

  private isWhitespace(c: string): boolean {
    return c === ' ' || c === '\t';
  }

  private skipWhitespace(): void {
    while (this.isWhitespace(this.peek())) {
      this.advance();
    }
  }

  private isDigit(c: string): boolean {
    return c >= '0' && c <= '9';
  }

  private isAlpha(c: string): boolean {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
  }

  private isAlphaNumeric(c: string): boolean {
    return this.isAlpha(c) || this.isDigit(c);
  }

  private makeLocation(
    startLine: number,
    startColumn: number,
    endLine: number,
    endColumn: number,
  ): SourceLocation {
    return {
      file: this.filename,
      line: startLine,
      column: startColumn,
      endLine,
      endColumn,
    };
  }

  private makeToken(type: TokenType, kind: TokenKind, value: string): Token {
    return createToken(
      type,
      kind,
      value,
      this.filename,
      this.line,
      this.column,
      this.line,
      this.column,
    );
  }

  private makeTokenAt(
    type: TokenType,
    kind: TokenKind,
    value: string,
    startLine: number,
    startColumn: number,
  ): Token {
    return createToken(
      type,
      kind,
      value,
      this.filename,
      startLine,
      startColumn,
      this.line,
      this.column,
    );
  }
}

// Convenience function
export function tokenize(
  source: string,
  filename?: string,
): { tokens: Token[]; errors: ErrorCollector } {
  const lexer = new Lexer(source, filename);
  return lexer.tokenize();
}
