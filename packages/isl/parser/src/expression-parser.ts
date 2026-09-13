// ============================================================================
// ISL Expression Parser
// ============================================================================

import { Parser } from './base-parser.js';
import * as AST from './ast.js';
import { expectedToken, unexpectedToken } from './errors.js';

export class ExpressionParser extends Parser {
  protected parseExpression(): AST.Expression {
    this.checkDepth();
    try {
      return this.parseTernary();
    } finally {
      this.decrementDepth();
    }
  }

  /** C-style ternary `cond ? a : b`, lower precedence than everything else. */
  protected parseTernary(): AST.Expression {
    const condition = this.parseOr();
    if (this.check('QUESTION')) {
      this.advance(); // '?'
      const thenBranch = this.parseTernary();
      this.expect('COLON', "Expected ':'");
      const elseBranch = this.parseTernary();
      return {
        kind: 'ConditionalExpr',
        condition,
        thenBranch,
        elseBranch,
        location: AST.mergeLocations(condition.location, elseBranch.location),
      };
    }
    return condition;
  }

  protected parseOr(): AST.Expression {
    let left = this.parseAnd();

    while (this.check('OR') || this.currentToken().value === 'or') {
      this.advance();
      const right = this.parseAnd();
      left = {
        kind: 'BinaryExpr',
        operator: 'or',
        left,
        right,
        location: AST.mergeLocations(left.location, right.location),
      };
    }

    return left;
  }

  protected parseAnd(): AST.Expression {
    let left = this.parseImplies();

    while (this.check('AND') || this.currentToken().value === 'and') {
      this.advance();
      const right = this.parseImplies();
      left = {
        kind: 'BinaryExpr',
        operator: 'and',
        left,
        right,
        location: AST.mergeLocations(left.location, right.location),
      };
    }

    return left;
  }

  protected parseImplies(): AST.Expression {
    let left = this.parseEquality();

    while (
      this.check('IMPLIES') ||
      this.currentToken().value === 'implies' ||
      this.check('IFF') ||
      this.currentToken().value === 'iff'
    ) {
      const op = this.currentToken().value === 'iff' ? 'iff' : 'implies';
      this.advance();
      const right = this.parseEquality();
      left = {
        kind: 'BinaryExpr',
        operator: op,
        left,
        right,
        location: AST.mergeLocations(left.location, right.location),
      };
    }

    return left;
  }

  protected parseEquality(): AST.Expression {
    let left = this.parseComparison();

    while (this.check('EQUALS') || this.check('NOT_EQUALS') || this.currentToken().value === 'is') {
      const op = this.currentToken().kind === 'NOT_EQUALS' ? '!=' : '==';
      this.advance();
      const right = this.parseComparison();
      left = {
        kind: 'BinaryExpr',
        operator: op,
        left,
        right,
        location: AST.mergeLocations(left.location, right.location),
      };
    }

    return left;
  }

  protected parseComparison(): AST.Expression {
    let left = this.parseAdditive();

    while (
      this.check('LT') ||
      this.check('GT') ||
      this.check('LTE') ||
      this.check('GTE') ||
      this.check('IN') ||
      this.currentToken().value === 'in'
    ) {
      let op: AST.BinaryOperator;
      switch (this.currentToken().kind) {
        case 'LT':
          op = '<';
          break;
        case 'GT':
          op = '>';
          break;
        case 'LTE':
          op = '<=';
          break;
        case 'GTE':
          op = '>=';
          break;
        default:
          op = 'in';
          break;
      }
      this.advance();
      const right = this.parseAdditive();
      left = {
        kind: 'BinaryExpr',
        operator: op,
        left,
        right,
        location: AST.mergeLocations(left.location, right.location),
      };
    }

    return left;
  }

  protected parseAdditive(): AST.Expression {
    let left = this.parseMultiplicative();

    while (this.check('PLUS') || this.check('MINUS')) {
      // Inside a bulleted obligation list, a `-` that begins a NEW LINE and is
      // followed by an expression-start token is the next bullet (same shape
      // skipOptionalBullet / isObligationBulletFollower recognises), NOT a
      // subtraction. Unparse emits `- (a > 0)` so LPAREN must count — otherwise
      // consecutive parenthesized bullets fold into `Boolean - Boolean`.
      // Same-line arithmetic (`balance - fee`, `balance - (fee)`) is unaffected.
      if (this.check('MINUS') && this.bulletedListDepth > 0) {
        const newlineLed = this.currentToken().location.line > this.previousToken().location.line;
        if (newlineLed && this.isObligationBulletFollower(this.peekNextToken())) {
          break;
        }
      }
      const op = this.currentToken().kind === 'PLUS' ? '+' : '-';
      this.advance();
      const right = this.parseMultiplicative();
      left = {
        kind: 'BinaryExpr',
        operator: op,
        left,
        right,
        location: AST.mergeLocations(left.location, right.location),
      };
    }

    return left;
  }

  protected parseMultiplicative(): AST.Expression {
    let left = this.parseUnary();

    while (this.check('STAR') || this.check('SLASH') || this.check('PERCENT')) {
      let op: AST.BinaryOperator;
      switch (this.currentToken().kind) {
        case 'STAR':
          op = '*';
          break;
        case 'SLASH':
          op = '/';
          break;
        default:
          op = '%';
          break;
      }
      this.advance();
      const right = this.parseUnary();
      left = {
        kind: 'BinaryExpr',
        operator: op,
        left,
        right,
        location: AST.mergeLocations(left.location, right.location),
      };
    }

    return left;
  }

  protected parseUnary(): AST.Expression {
    if (this.check('NOT') || this.currentToken().value === 'not') {
      const start = this.advance();
      const operand = this.parseUnary();
      return {
        kind: 'UnaryExpr',
        operator: 'not',
        operand,
        location: AST.mergeLocations(start.location, operand.location),
      };
    }

    if (this.check('MINUS')) {
      const start = this.advance();
      const operand = this.parseUnary();
      return {
        kind: 'UnaryExpr',
        operator: '-',
        operand,
        location: AST.mergeLocations(start.location, operand.location),
      };
    }

    return this.parsePostfix();
  }

  protected parsePostfix(): AST.Expression {
    let expr = this.parsePrimary();

    while (true) {
      // Optional chaining `a?.b` tokenizes as QUESTION DOT — treat it as a
      // member access (null-safety is a runtime concern, not a shape change).
      if (this.check('QUESTION') && this.peekNextToken()?.kind === 'DOT') {
        this.advance(); // '?'
        this.advance(); // '.'
        const property = this.parseIdentifier();
        expr = {
          kind: 'MemberExpr',
          object: expr,
          property,
          location: AST.mergeLocations(expr.location, property.location),
        };
      } else if (this.check('DOT')) {
        this.advance();
        const property = this.parseIdentifier();
        expr = {
          kind: 'MemberExpr',
          object: expr,
          property,
          location: AST.mergeLocations(expr.location, property.location),
        };
      } else if (this.check('LPAREN')) {
        this.advance();
        const args: AST.Expression[] = [];
        while (!this.check('RPAREN') && !this.isAtEnd()) {
          // Handle named arguments: name: value
          // Note: named argument names can be IDENTIFIER or KEYWORD type
          const argToken = this.currentToken();
          if (
            (argToken.type === 'IDENTIFIER' || argToken.type === 'KEYWORD') &&
            this.peekNextToken()?.kind === 'COLON'
          ) {
            this.advance(); // name
            this.advance(); // :
          }
          // Bare single-param lambda in argument position: `coll.all(x => expr)`.
          // (Parenthesized lambdas `(x) => expr` are handled in parsePrimary.)
          if (
            (argToken.type === 'IDENTIFIER' || argToken.type === 'KEYWORD') &&
            this.peekNextToken()?.kind === 'FAT_ARROW'
          ) {
            const param = this.parseIdentifier();
            this.advance(); // consume '=>'
            const body = this.parseExpression();
            args.push({
              kind: 'LambdaExpr',
              params: [param],
              body,
              location: AST.mergeLocations(param.location, body.location),
            });
          } else {
            args.push(this.parseExpression());
          }
          this.match('COMMA');
        }
        const end = this.expect('RPAREN', "Expected ')'");
        expr = {
          kind: 'CallExpr',
          callee: expr,
          arguments: args,
          location: AST.mergeLocations(expr.location, end.location),
        };
      } else if (this.check('LBRACKET')) {
        this.advance();
        const index = this.parseExpression();
        const end = this.expect('RBRACKET', "Expected ']'");
        expr = {
          kind: 'IndexExpr',
          object: expr,
          index,
          location: AST.mergeLocations(expr.location, end.location),
        };
      } else {
        break;
      }
    }

    return expr;
  }

  protected parsePrimary(): AST.Expression {
    const token = this.currentToken();

    // Conditional expression: `if <cond> then <a> else <b>`.
    if (token.value === 'if' && (token.type === 'IDENTIFIER' || token.type === 'KEYWORD')) {
      this.advance(); // 'if'
      const condition = this.parseExpression();
      // 'then' tokenizes as THEN; tolerate an identifier 'then' too.
      if (this.check('THEN') || this.currentToken().value === 'then') this.advance();
      const thenBranch = this.parseExpression();
      if (this.currentToken().value === 'else') this.advance();
      const elseBranch = this.parseExpression();
      return {
        kind: 'ConditionalExpr',
        condition,
        thenBranch,
        elseBranch,
        location: AST.mergeLocations(token.location, elseBranch.location),
      };
    }

    // Logician quantifiers: `forall v in coll | pred`, `exists v in coll | pred`.
    // (forall → all, exists → any). The `|` separates binder from predicate; a
    // chained `forall a in xs | exists b in ys | p` nests via recursion.
    if (
      (token.value === 'forall' || token.value === 'exists') &&
      (token.type === 'IDENTIFIER' || token.type === 'KEYWORD')
    ) {
      this.advance(); // 'forall' / 'exists'
      const variable = this.parseIdentifier();
      // Support a second binder var `forall c1, c2 ... ` — keep the first.
      while (this.match('COMMA')) this.parseIdentifier();
      // Two binder forms:
      //   `forall v in coll | pred`     — bind over a collection (pipe separator)
      //   `forall v: Type => pred`      — typed binder (arrow separator)
      let collection: AST.Expression;
      if (this.check('COLON')) {
        this.advance(); // ':'
        const typeName = this.parseQualifiedName();
        collection = {
          kind: 'Identifier',
          name: typeName.parts.map((p) => p.name).join('.'),
          location: typeName.location,
        };
      } else {
        if (this.currentToken().value === 'in') this.advance();
        collection = this.parseExpression();
      }
      // Separator: `|` (collection form) or `=>` (typed form).
      if (this.check('PIPE')) this.advance();
      else if (this.check('FAT_ARROW')) this.advance();
      else this.expect('PIPE', "Expected '|' or '=>'");
      const predicate = this.parseExpression();
      return {
        kind: 'QuantifierExpr',
        quantifier: token.value === 'forall' ? 'all' : 'any',
        variable,
        collection,
        predicate,
        location: AST.mergeLocations(token.location, predicate.location),
      };
    }

    // Special expressions
    if (token.kind === 'OLD' || token.value === 'old') {
      return this.parseOldExpr();
    }
    if (token.kind === 'RESULT' || token.value === 'result') {
      return this.parseResultExpr();
    }
    if (token.kind === 'NOW' || token.value === 'now') {
      this.advance();
      return {
        kind: 'CallExpr',
        callee: { kind: 'Identifier', name: 'now', location: token.location },
        arguments: [],
        location: token.location,
      };
    }
    if (token.kind === 'THIS' || token.value === 'this') {
      this.advance();
      return { kind: 'Identifier', name: 'this', location: token.location };
    }

    // Quantifiers - only if followed by '(' (otherwise treat as identifier)
    if (
      (token.kind === 'ALL' ||
        token.kind === 'ANY' ||
        token.kind === 'NONE' ||
        token.kind === 'COUNT' ||
        token.kind === 'SUM' ||
        token.kind === 'FILTER') &&
      this.peekNextToken()?.kind === 'LPAREN'
    ) {
      return this.parseQuantifier();
    }

    // Literals
    if (token.type === 'STRING') {
      return this.parseStringLiteral();
    }
    if (token.type === 'NUMBER') {
      return this.parseNumberLiteral();
    }
    if (token.type === 'BOOLEAN') {
      return this.parseBooleanLiteral();
    }
    if (token.type === 'DURATION') {
      return this.parseDurationLiteral();
    }
    if (token.type === 'REGEX') {
      return this.parseRegexLiteral();
    }

    // List literal
    if (this.check('LBRACKET')) {
      return this.parseListLiteral();
    }

    // Parenthesized expression or lambda
    if (this.check('LPAREN')) {
      return this.parseParenOrLambda();
    }

    // Map literal or block
    if (this.check('LBRACE')) {
      return this.parseMapLiteral();
    }

    // Identifier
    if (token.type === 'IDENTIFIER' || token.type === 'KEYWORD') {
      return this.parseIdentifier();
    }

    throw unexpectedToken(token, 'expression');
  }

  protected parseOldExpr(): AST.OldExpr {
    const start = this.advance(); // consume 'old'
    this.expect('LPAREN', "Expected '('");
    const expression = this.parseExpression();
    const end = this.expect('RPAREN', "Expected ')'");

    return {
      kind: 'OldExpr',
      expression,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseResultExpr(): AST.ResultExpr {
    const start = this.advance(); // consume 'result'
    let property: AST.Identifier | undefined;

    if (this.check('DOT')) {
      this.advance();
      property = this.parseIdentifier();
    }

    return {
      kind: 'ResultExpr',
      property,
      location: property ? AST.mergeLocations(start.location, property.location) : start.location,
    };
  }

  protected parseQuantifier(): AST.QuantifierExpr {
    const start = this.currentToken();
    const quantifier = start.value as AST.QuantifierExpr['quantifier'];
    this.advance();

    this.expect('LPAREN', "Expected '('");

    // Parse collection
    const collection = this.parseExpression();

    // Check for lambda style: all(items, item => predicate)
    let variable: AST.Identifier;
    let predicate: AST.Expression;

    if (this.match('COMMA')) {
      // Lambda style
      variable = this.parseIdentifier();
      this.expect('FAT_ARROW', "Expected '=>'");
      predicate = this.parseExpression();
    } else {
      // Simple style - variable is implicit
      variable = { kind: 'Identifier', name: '_', location: collection.location };
      predicate = collection;
    }

    const end = this.expect('RPAREN', "Expected ')'");

    return {
      kind: 'QuantifierExpr',
      quantifier,
      variable,
      collection,
      predicate,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseListLiteral(): AST.ListExpr {
    const start = this.expect('LBRACKET', "Expected '['");
    const elements: AST.Expression[] = [];

    while (!this.check('RBRACKET') && !this.isAtEnd()) {
      elements.push(this.parseExpression());
      this.match('COMMA');
    }

    const end = this.expect('RBRACKET', "Expected ']'");

    return {
      kind: 'ListExpr',
      elements,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseMapLiteral(): AST.MapExpr {
    const start = this.expect('LBRACE', "Expected '{'");
    const entries: AST.MapEntry[] = [];

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const key = this.parseExpression();
      this.expect('COLON', "Expected ':'");
      const value = this.parseExpression();
      entries.push({
        kind: 'MapEntry',
        key,
        value,
        location: AST.mergeLocations(key.location, value.location),
      });
      this.match('COMMA');
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'MapExpr',
      entries,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseParenOrLambda(): AST.Expression {
    const start = this.expect('LPAREN', "Expected '('");

    // Check for lambda: (x) => expr or (x, y) => expr
    if (this.check('RPAREN')) {
      this.advance();
      if (this.check('FAT_ARROW')) {
        this.advance();
        const body = this.parseExpression();
        return {
          kind: 'LambdaExpr',
          params: [],
          body,
          location: AST.mergeLocations(start.location, body.location),
        };
      }
      // Empty parentheses - not valid
      throw unexpectedToken(this.currentToken(), 'expression');
    }

    const first = this.parseExpression();

    if (this.check('RPAREN')) {
      this.advance();
      if (this.check('FAT_ARROW')) {
        // Single param lambda
        this.advance();
        const body = this.parseExpression();
        const params = first.kind === 'Identifier' ? [first] : [];
        return {
          kind: 'LambdaExpr',
          params,
          body,
          location: AST.mergeLocations(start.location, body.location),
        };
      }
      // Just a parenthesized expression
      return first;
    }

    // Multiple params or tuple
    if (this.check('COMMA')) {
      const params: AST.Identifier[] = first.kind === 'Identifier' ? [first] : [];
      while (this.match('COMMA')) {
        // Check if this was a trailing comma (next token is ')')
        if (this.check('RPAREN')) break;
        const param = this.parseIdentifier();
        params.push(param);
      }
      this.expect('RPAREN', "Expected ')'");
      if (this.check('FAT_ARROW')) {
        this.advance();
        const body = this.parseExpression();
        return {
          kind: 'LambdaExpr',
          params,
          body,
          location: AST.mergeLocations(start.location, body.location),
        };
      }
    }

    this.expect('RPAREN', "Expected ')'");
    return first;
  }

  // ============================================================================
  // LITERAL PARSING
  // ============================================================================

  protected parseIdentifier(): AST.Identifier {
    const token = this.currentToken();
    if (token.type !== 'IDENTIFIER' && token.type !== 'KEYWORD') {
      throw expectedToken('identifier', token);
    }
    this.advance();
    return {
      kind: 'Identifier',
      name: token.value,
      location: token.location,
    };
  }

  protected parseQualifiedName(): AST.QualifiedName {
    const parts: AST.Identifier[] = [this.parseIdentifier()];

    while (this.check('DOT')) {
      this.advance();
      parts.push(this.parseIdentifier());
    }

    const lastPart = parts[parts.length - 1];
    return {
      kind: 'QualifiedName',
      parts,
      location: lastPart
        ? AST.mergeLocations(parts[0]!.location, lastPart.location)
        : parts[0]!.location,
    };
  }

  protected parseStringLiteral(): AST.StringLiteral {
    const token = this.expect('STRING_LITERAL', 'string literal');
    return {
      kind: 'StringLiteral',
      value: token.value,
      location: token.location,
    };
  }

  protected parseNumberLiteral(): AST.NumberLiteral {
    const token = this.currentToken();
    if (token.type !== 'NUMBER') {
      throw expectedToken('number', token);
    }
    this.advance();
    const value = parseFloat(token.value);
    return {
      kind: 'NumberLiteral',
      value,
      isFloat: token.value.includes('.'),
      location: token.location,
    };
  }

  protected parseBooleanLiteral(): AST.BooleanLiteral {
    const token = this.currentToken();
    if (token.type !== 'BOOLEAN') {
      throw expectedToken('boolean', token);
    }
    this.advance();
    return {
      kind: 'BooleanLiteral',
      value: token.value === 'true',
      location: token.location,
    };
  }

  protected parseDurationLiteral(): AST.DurationLiteral {
    const token = this.currentToken();

    // Handle "number.unit" style (e.g., 15.minutes)
    if (token.type === 'NUMBER') {
      const numToken = this.advance();
      if (this.check('DOT')) {
        this.advance();
        const unitToken = this.currentToken();
        const unit = unitToken.value as AST.DurationLiteral['unit'];
        this.advance();
        return {
          kind: 'DurationLiteral',
          value: parseFloat(numToken.value),
          unit,
          location: AST.mergeLocations(numToken.location, unitToken.location),
        };
      }
      // Fall back to number literal interpretation
      return {
        kind: 'DurationLiteral',
        value: parseFloat(numToken.value),
        unit: 'ms',
        location: numToken.location,
      };
    }

    // Handle "numberunit" style (e.g., 200ms, 1s, 15m, 1h, 1d)
    if (token.type === 'DURATION') {
      this.advance();
      // Parse the value and unit from the token - supports both long and short forms
      const match = token.value.match(/^(\d+(?:\.\d+)?)(ms|seconds|minutes|hours|days|s|m|h|d)$/);
      if (match) {
        // Map short units to canonical form
        const unitMap: Record<string, AST.DurationLiteral['unit']> = {
          ms: 'ms',
          s: 'seconds',
          seconds: 'seconds',
          m: 'minutes',
          minutes: 'minutes',
          h: 'hours',
          hours: 'hours',
          d: 'days',
          days: 'days',
        };
        const rawUnit = match[2] ?? 'ms';
        const unit = unitMap[rawUnit] ?? 'ms';
        return {
          kind: 'DurationLiteral',
          value: parseFloat(match[1] ?? '0'),
          unit,
          location: token.location,
        };
      }
    }

    throw expectedToken('duration', token);
  }

  protected parseRegexLiteral(): AST.RegexLiteral {
    const token = this.currentToken();
    if (token.type !== 'REGEX') {
      throw expectedToken('regex', token);
    }
    this.advance();

    // Parse /pattern/flags
    const match = token.value.match(/^\/(.*)\/([a-z]*)$/);
    return {
      kind: 'RegexLiteral',
      pattern: match?.[1] ?? token.value,
      flags: match?.[2] ?? '',
      location: token.location,
    };
  }

  protected parseLiteral(): AST.Expression {
    const token = this.currentToken();
    switch (token.type) {
      case 'STRING':
        return this.parseStringLiteral();
      case 'NUMBER':
        return this.parseNumberLiteral();
      case 'BOOLEAN':
        return this.parseBooleanLiteral();
      case 'DURATION':
        return this.parseDurationLiteral();
      case 'REGEX':
        return this.parseRegexLiteral();
      default:
        throw expectedToken('literal', token);
    }
  }
}
