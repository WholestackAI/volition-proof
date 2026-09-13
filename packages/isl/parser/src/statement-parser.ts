// ============================================================================
// ISL Statement Parser
// ============================================================================

import { ExpressionParser } from './expression-parser.js';
import { type ParseResult } from './base-parser.js';
import * as AST from './ast.js';
import { isPrimitiveType } from './tokens.js';
import { ErrorCode, expectedToken, unexpectedToken } from './errors.js';
import { Lexer } from './lexer.js';
import { checkParserLimits } from './parser-limits.js';

export class StatementParser extends ExpressionParser {
  /** Extra `{` skipped after inner behavior annotations; matching `}` consumed at close. */
  private behaviorExtraCloses = 0;

  parse(source: string): ParseResult {
    try {
      checkParserLimits(source, this.limits);
    } catch (err) {
      if (err instanceof Error) {
        this.errors.addError(err.message, ErrorCode.UNEXPECTED_TOKEN, {
          file: this.filename,
          line: 1,
          column: 1,
          endLine: 1,
          endColumn: 1,
        });
        return { success: false, errors: this.errors.getAll() };
      }
    }

    const islVersion = this.extractISLVersion(source);
    this.parseDepth = 0;

    const lexer = new Lexer(source, this.filename, this.errors);
    const { tokens } = lexer.tokenize();

    if (this.limits.enabled && tokens.length > this.limits.maxTokens) {
      this.errors.addError(
        `Token count ${tokens.length} exceeds maximum ${this.limits.maxTokens}`,
        ErrorCode.UNEXPECTED_TOKEN,
        { file: this.filename, line: 1, column: 1, endLine: 1, endColumn: 1 },
      );
      return { success: false, errors: this.errors.getAll(), tokens, islVersion };
    }

    this.tokens = tokens.filter((t) => t.type !== 'COMMENT');
    this.current = 0;

    try {
      this.skipOptionalVersionPragma();
      const domain = this.parseDomain();
      return {
        success: !this.errors.hasErrors(),
        domain,
        errors: this.errors.getAll(),
        tokens,
        islVersion,
      };
    } catch (e) {
      if (e instanceof Error) {
        this.errors.addError(e.message, ErrorCode.UNEXPECTED_TOKEN, this.currentLocation());
      }
      return {
        success: false,
        errors: this.errors.getAll(),
        tokens,
        islVersion,
      };
    }
  }

  protected extractISLVersion(source: string): string | undefined {
    const lines = source.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      const hashMatch = trimmed.match(/^#\s*islVersion\s+["']([^"']+)["']/i);
      if (hashMatch) {
        return hashMatch[1];
      }
      const directMatch = trimmed.match(/^islVersion\s+["']([^"']+)["']/i);
      if (directMatch) {
        return directMatch[1];
      }
      if (trimmed.startsWith('domain ')) {
        break;
      }
    }
    return undefined;
  }

  protected skipOptionalVersionPragma(): void {
    const t = this.currentToken();
    if (t.type === 'IDENTIFIER' && t.value === 'islVersion') {
      this.advance();
      if (this.check('STRING_LITERAL')) {
        this.advance();
      }
    }
  }

  protected parseDomain(): AST.Domain {
    const start = this.currentToken();
    this.checkDepth();
    try {
      this.expect('DOMAIN', "Expected 'domain'");
      // Domain names may be qualified/dotted (e.g. `domain Auth.Session`). Parse
      // all dotted segments and collapse to a single Identifier holding the full
      // dotted name, so the AST `name: Identifier` contract is preserved.
      const name = this.parseDottedDomainName();

      // Support both braced syntax: domain Name { ... }
      // and brace-less syntax: domain Name\nversion "1.0.0"\n...
      const useBraces = this.check('LBRACE');
      if (useBraces) {
        this.advance(); // consume '{'
      }

      const domain: AST.Domain = {
        kind: 'Domain',
        name,
        version: { kind: 'StringLiteral', value: '', location: name.location },
        uses: [],
        imports: [],
        types: [],
        entities: [],
        behaviors: [],
        invariants: [],
        policies: [],
        views: [],
        aggregates: [],
        queries: [],
        jobs: [],
        notifications: [],
        scenarios: [],
        chaos: [],
        // Full-stack constructs
        apis: [],
        storage: [],
        workflows: [],
        events: [],
        handlers: [],
        screens: [],
        relationships: [],
        config: undefined,
        location: start.location,
      };

      // Parse until RBRACE (braced) or EOF (brace-less)
      const shouldContinue = () =>
        useBraces ? !this.check('RBRACE') && !this.isAtEnd() : !this.isAtEnd();

      while (shouldContinue()) {
        try {
          this.parseDomainMember(domain);
        } catch (e) {
          // Report the error before synchronizing
          if (e instanceof Error) {
            this.errors.addError(e.message, ErrorCode.UNEXPECTED_TOKEN, this.currentLocation());
          }
          this.synchronize();
        }
      }

      if (useBraces) {
        const endToken = this.expect('RBRACE', "Expected '}'");
        domain.location = AST.mergeLocations(start.location, endToken.location);
      } else {
        // For brace-less syntax, extend location to last parsed item
        const lastLocation = this.previousToken().location;
        domain.location = AST.mergeLocations(start.location, lastLocation);
      }

      // Validate required fields
      if (domain.version.value === '') {
        this.errors.addError(
          'Missing required field: version',
          ErrorCode.MISSING_VERSION,
          domain.location,
        );
      }

      return domain;
    } finally {
      this.decrementDepth();
    }
  }

  /**
   * Parse a (possibly dotted) domain name like `Auth.Session` and collapse it
   * to one Identifier whose `name` is the full dotted string. Keeps the AST
   * `Domain.name: Identifier` contract while accepting namespaced domains.
   */
  protected parseDottedDomainName(): AST.Identifier {
    const first = this.parseIdentifier();
    let name = first.name;
    let lastLoc = first.location;
    while (this.check('DOT')) {
      this.advance();
      const seg = this.parseIdentifier();
      name += '.' + seg.name;
      lastLoc = seg.location;
    }
    return {
      kind: 'Identifier',
      name,
      location: AST.mergeLocations(first.location, lastLoc),
    };
  }

  protected parseDomainMember(domain: AST.Domain): void {
    const token = this.currentToken();

    switch (token.kind) {
      case 'VERSION':
        domain.version = this.parseVersionField();
        break;
      case 'OWNER':
        domain.owner = this.parseOwnerField();
        break;
      case 'DESCRIPTION':
        domain.description = this.parseDescriptionField();
        break;
      case 'USE':
        domain.uses.push(this.parseUseStatement());
        break;
      case 'IMPORTS':
        domain.imports.push(...this.parseImports());
        break;
      case 'TYPE':
        domain.types.push(this.parseTypeDeclaration());
        break;
      case 'ENUM':
        domain.types.push(this.parseEnumDeclaration());
        break;
      case 'ENTITY':
        domain.entities.push(this.parseEntity());
        break;
      case 'BEHAVIOR':
        domain.behaviors.push(this.parseBehavior());
        break;
      case 'INVARIANTS':
        domain.invariants.push(this.parseInvariantBlock());
        break;
      case 'POLICY':
        domain.policies.push(this.parsePolicy());
        break;
      case 'VIEW':
        domain.views.push(this.parseView());
        break;
      case 'QUERY':
        (domain.queries ??= []).push(this.parseQuery());
        break;
      case 'SCENARIOS':
        domain.scenarios.push(this.parseScenarioBlock());
        break;
      case 'SCENARIO':
        domain.scenarios.push(this.parseStandaloneScenario());
        break;
      case 'CHAOS':
        domain.chaos.push(this.parseChaosBlock());
        break;
      // Full-stack constructs
      case 'API':
        domain.apis.push(this.parseApiBlock());
        break;
      case 'STORAGE':
        domain.storage.push(this.parseStorageDecl());
        break;
      case 'WORKFLOW':
        domain.workflows.push(this.parseWorkflowDecl());
        break;
      case 'EVENT':
        domain.events.push(this.parseEventDecl());
        break;
      case 'HANDLER':
        domain.handlers.push(this.parseHandlerDecl());
        break;
      case 'SCREEN':
        domain.screens.push(this.parseScreenDecl());
        break;
      case 'CONFIG':
        domain.config = this.parseConfigBlock();
        break;
      case 'AUTH': {
        // Domain-level OAuth providers `auth { google, github }`. `auth` is a
        // reserved keyword (used in api/middleware), so it arrives here as the AUTH
        // token kind (not IDENTIFIER); the `{ … }` body is the domain-level block.
        // Each provider lowers to its `oauth-<name>` recipe (+ oauth-core).
        const decl = this.parseAuthDecl();
        if (domain.auth) domain.auth.providers.push(...decl.providers);
        else domain.auth = decl;
        break;
      }
      default:
        if (token.type === 'IDENTIFIER' && token.value === 'import') {
          domain.imports.push(this.parseSingularImport());
          break;
        }
        // First-class `aggregate <Name> { ... }` construct. Dispatched on the
        // identifier value (NOT a reserved keyword) so it is strictly additive:
        // existing specs that use `aggregate` as a plain identifier elsewhere are
        // unaffected, and only a domain-level `aggregate Name {` enters this path.
        if (token.type === 'IDENTIFIER' && token.value === 'aggregate') {
          (domain.aggregates ??= []).push(this.parseAggregate());
          break;
        }
        if (token.type === 'IDENTIFIER' && token.value === 'query') {
          (domain.queries ??= []).push(this.parseQuery());
          break;
        }
        if (token.type === 'IDENTIFIER' && token.value === 'job') {
          (domain.jobs ??= []).push(this.parseJob());
          break;
        }
        if (token.type === 'IDENTIFIER' && token.value === 'notification') {
          (domain.notifications ??= []).push(this.parseNotification());
          break;
        }
        // Domain-level RBAC role set `roles { admin, manager, clerk }`. Dispatched
        // on the identifier value + `{` lookahead, strictly additive (a field/use
        // literally named `roles` elsewhere is unaffected). Multiple blocks merge.
        if (
          token.type === 'IDENTIFIER' &&
          token.value === 'roles' &&
          this.peekNextToken()?.kind === 'LBRACE'
        ) {
          const decl = this.parseRolesDecl();
          if (domain.roles) domain.roles.roles.push(...decl.roles);
          else domain.roles = decl;
          break;
        }
        // Domain-level third-party integrations `integrations { posthog }`. Soft
        // keyword + `{` lookahead, strictly additive; each name lowers to its recipe.
        if (
          token.type === 'IDENTIFIER' &&
          token.value === 'integrations' &&
          this.peekNextToken()?.kind === 'LBRACE'
        ) {
          const decl = this.parseIntegrationsDecl();
          if (domain.integrations) domain.integrations.services.push(...decl.services);
          else domain.integrations = decl;
          break;
        }
        // Named domain relationships, including pure many-to-many.
        // Soft keyword + identifier + `{` so a field named `relationship` is unaffected.
        if (
          token.type === 'IDENTIFIER' &&
          token.value === 'relationship' &&
          this.peekNextToken()?.kind === 'IDENTIFIER'
        ) {
          (domain.relationships ??= []).push(this.parseRelationshipDecl());
          break;
        }
        // First-class double-entry `ledger <Name> { account …  movement … }`
        // construct. Dispatched on the identifier value + `{` lookahead, strictly
        // additive (a field/use literally named `ledger` elsewhere is unaffected).
        if (
          token.type === 'IDENTIFIER' &&
          token.value === 'ledger' &&
          this.peekNextToken()?.kind === 'IDENTIFIER'
        ) {
          (domain.ledgers ??= []).push(this.parseLedger());
          break;
        }
        // Tenancy archetype `tenancy: "single-tenant"`. Soft keyword (dispatched on
        // the identifier value + `:` lookahead) so `tenancy` stays usable as a plain
        // identifier/field name elsewhere — strictly additive, default multi-tenant.
        if (
          token.type === 'IDENTIFIER' &&
          token.value === 'tenancy' &&
          this.peekNextToken()?.kind === 'COLON'
        ) {
          domain.tenancy = this.parseTenancyField();
          break;
        }
        throw unexpectedToken(token, 'domain member');
    }
  }

  /** Parse singular import: import Identifier from "path" */
  protected parseSingularImport(): AST.Import {
    const start = this.advance(); // consume 'import'
    const name = this.parseIdentifier();
    this.expect('FROM', "Expected 'from'");
    const from = this.parseStringLiteral();
    return {
      kind: 'Import',
      items: [{ kind: 'ImportItem', name, alias: undefined, location: name.location }],
      from,
      location: AST.mergeLocations(start.location, from.location),
    };
  }

  protected parseVersionField(): AST.StringLiteral {
    this.advance(); // consume 'version'
    // Support both `version: "1.0.0"` and `version "1.0.0"` (brace-less)
    this.match('COLON');
    return this.parseStringLiteral();
  }

  protected parseOwnerField(): AST.StringLiteral {
    this.advance(); // consume 'owner'
    // Support both `owner: "Acme"` and `owner "Acme"` (brace-less)
    this.match('COLON');
    return this.parseStringLiteral();
  }

  // ============================================================================
  // USE STATEMENTS
  // ============================================================================

  protected parseUseStatement(): AST.UseStatement {
    const start = this.advance(); // consume 'use'
    let importModule: AST.Identifier | AST.StringLiteral;
    if (this.check('STRING_LITERAL')) {
      importModule = this.parseStringLiteral();
    } else {
      const first = this.parseIdentifier();
      let name = first.name;
      let endLoc = first.location;
      while (this.match('MINUS') && this.check('IDENTIFIER')) {
        const next = this.parseIdentifier();
        name += '-' + next.name;
        endLoc = next.location;
      }
      importModule = {
        kind: 'Identifier',
        name,
        location: AST.mergeLocations(first.location, endLoc),
      };
    }
    let version: AST.StringLiteral | undefined;
    if (this.match('AT')) {
      version = this.parseStringLiteral();
    }
    let alias: AST.Identifier | undefined;
    if (this.match('AS')) {
      alias = this.parseIdentifier();
    }
    const end = alias ?? version ?? importModule;
    return {
      kind: 'UseStatement',
      module: importModule,
      version,
      alias,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  // ============================================================================
  // IMPORTS
  // ============================================================================

  protected parseImports(): AST.Import[] {
    this.advance(); // consume 'imports'
    this.expect('LBRACE', "Expected '{'");

    // Form: imports { { A, B } from "path" , { C } from "other" } — a block of
    // grouped entries. Each entry is a braced item list followed by its own
    // `from "path"`, so one `imports` block can pull from several modules while
    // still naming each module's items as a group. Detected by the `{` that
    // immediately follows the block's own `{`; every other form starts with an
    // import item, so this stays unambiguous.
    if (this.check('LBRACE')) {
      const grouped: AST.Import[] = [];
      while (!this.check('RBRACE') && !this.isAtEnd()) {
        grouped.push(this.parseImportEntry());
        this.match('COMMA'); // optional separator between entries
      }
      this.expect('RBRACE', "Expected '}'");
      return grouped;
    }

    const firstItem = this.parseImportItem();
    if (this.check('FROM')) {
      // Form: imports { A from "path1", B from "path2" } — multiple Import declarations
      const imports: AST.Import[] = [];
      this.advance(); // consume 'from'
      const from = this.parseStringLiteral();
      imports.push({
        kind: 'Import',
        items: [firstItem],
        from,
        location: AST.mergeLocations(firstItem.location, from.location),
      });
      while (!this.check('RBRACE') && !this.isAtEnd()) {
        this.match('COMMA'); // optional comma between entries
        if (this.check('RBRACE')) break;
        const item = this.parseImportItem();
        this.expect('FROM', "Expected 'from'");
        const nextFrom = this.parseStringLiteral();
        imports.push({
          kind: 'Import',
          items: [item],
          from: nextFrom,
          location: AST.mergeLocations(item.location, nextFrom.location),
        });
      }
      this.expect('RBRACE', "Expected '}'");
      return imports;
    }

    // Form: imports { A, B as C } from "path" — single Import with multiple items
    const items: AST.ImportItem[] = [firstItem];
    while (this.match('COMMA') && !this.check('RBRACE')) {
      items.push(this.parseImportItem());
    }
    this.expect('RBRACE', "Expected '}'");
    this.expect('FROM', "Expected 'from'");
    const from = this.parseStringLiteral();
    return [
      {
        kind: 'Import',
        items,
        from,
        location: AST.mergeLocations(firstItem.location, from.location),
      },
    ];
  }

  /**
   * One import entry: an item list — braced (`{ A, B }`) or bare (`A, B`) —
   * followed by `from "path"`. Used for the grouped `imports { … }` block form.
   */
  protected parseImportEntry(): AST.Import {
    const start = this.currentToken();
    const items: AST.ImportItem[] = [];

    const hasBraces = this.match('LBRACE');
    if (hasBraces) {
      while (!this.check('RBRACE') && !this.isAtEnd()) {
        items.push(this.parseImportItem());
        this.match('COMMA');
      }
      this.expect('RBRACE', "Expected '}'");
    } else {
      const item = this.parseImportItem();
      items.push(item);
      while (this.match('COMMA')) {
        if (this.check('FROM')) break;
        items.push(this.parseImportItem());
      }
    }

    this.expect('FROM', "Expected 'from'");
    const from = this.parseStringLiteral();

    return {
      kind: 'Import',
      items,
      from,
      location: AST.mergeLocations(start.location, from.location),
    };
  }

  protected parseImportItem(): AST.ImportItem {
    const name = this.parseIdentifier();
    let alias: AST.Identifier | undefined;

    if (this.match('AS')) {
      alias = this.parseIdentifier();
    }

    return {
      kind: 'ImportItem',
      name,
      alias,
      location: alias ? AST.mergeLocations(name.location, alias.location) : name.location,
    };
  }

  // ============================================================================
  // TYPE DECLARATIONS
  // ============================================================================

  protected parseTypeDeclaration(): AST.TypeDeclaration {
    const start = this.advance(); // consume 'type'
    const name = this.parseIdentifier();
    // `type Name = Definition` is the canonical form, but a struct shorthand
    // `type Name { field: T ... }` (no `=`) is also accepted — when a `{`
    // immediately follows the name, skip the required `=`.
    if (!this.check('LBRACE')) {
      this.expect('ASSIGN', "Expected '='");
    }

    const definition = this.parseTypeDefinition();
    const bracketAnnotations = this.parseAnnotations();
    const inlineAnnotations = this.parseInlineAnnotations();
    const annotations = bracketAnnotations.length > 0 ? bracketAnnotations : inlineAnnotations;

    return {
      kind: 'TypeDeclaration',
      name,
      definition,
      annotations,
      location: AST.mergeLocations(start.location, definition.location),
    };
  }

  /** Parse zero or more @name or @name(expr) annotations (e.g. @format("email")). */
  protected parseInlineAnnotations(): AST.Annotation[] {
    const annotations: AST.Annotation[] = [];
    while (this.check('AT')) {
      this.advance(); // consume '@'
      const name = this.parseIdentifier();
      let value: AST.Expression | undefined;
      if (this.match('LPAREN')) {
        value = this.parseExpression();
        this.expect('RPAREN', "Expected ')'");
      }
      annotations.push({
        kind: 'Annotation',
        name,
        value,
        location: value ? AST.mergeLocations(name.location, value.location) : name.location,
      });
    }
    return annotations;
  }

  protected parseEnumDeclaration(): AST.TypeDeclaration {
    const start = this.advance(); // consume 'enum'
    const name = this.parseIdentifier();
    this.expect('LBRACE', "Expected '{'");

    const variants: AST.EnumVariant[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      variants.push(this.parseEnumVariant());
      this.match('COMMA'); // variants may be comma- or newline-separated
    }

    const end = this.expect('RBRACE', "Expected '}'");

    const enumType: AST.EnumType = {
      kind: 'EnumType',
      variants,
      location: AST.mergeLocations(start.location, end.location),
    };

    return {
      kind: 'TypeDeclaration',
      name,
      definition: enumType,
      annotations: [],
      location: enumType.location,
    };
  }

  protected parseEnumVariant(): AST.EnumVariant {
    const name = this.parseIdentifier();
    let value: AST.Literal | undefined;

    if (this.match('ASSIGN')) {
      value = this.parseLiteral() as AST.Literal;
    }

    return {
      kind: 'EnumVariant',
      name,
      value,
      location: value ? AST.mergeLocations(name.location, value.location) : name.location,
    };
  }

  protected parseTypeDefinition(): AST.TypeDefinition {
    // Union type with leading pipe (e.g. "| A | B")
    if (this.check('PIPE')) {
      return this.parseUnionType();
    }

    const first = this.parsePostfixType();
    if (!this.check('PIPE')) {
      return first;
    }

    const variants: AST.UnionVariant[] = [this.typeToUnionVariant(first)];
    while (this.match('PIPE')) {
      variants.push(this.parseUnionArm());
    }
    return {
      kind: 'UnionType',
      variants,
      location: AST.mergeLocations(variants[0]!.location, variants[variants.length - 1]!.location),
    };
  }

  /**
   * One arm of a union: either `VariantName { field: Type, ... }` or any postfix type (String | List<...>).
   */
  protected parseUnionArm(): AST.UnionVariant {
    const cur = this.currentToken();
    const next = this.peekNextToken();
    const canBeNamedVariant =
      (cur.type === 'IDENTIFIER' || cur.type === 'KEYWORD') &&
      next?.kind === 'LBRACE' &&
      cur.value !== 'List' &&
      cur.value !== 'Map' &&
      !isPrimitiveType(cur.value);

    if (canBeNamedVariant) {
      const name = this.parseIdentifier();
      this.expect('LBRACE', "Expected '{'");
      const fields: AST.Field[] = [];
      while (!this.check('RBRACE') && !this.isAtEnd()) {
        fields.push(this.parseField());
        this.match('COMMA');
      }
      const end = this.expect('RBRACE', "Expected '}'");
      const struct: AST.StructType = {
        kind: 'StructType',
        fields,
        location: AST.mergeLocations(name.location, end.location),
      };
      return {
        kind: 'UnionVariant',
        name,
        fields,
        memberType: struct,
        location: struct.location,
      };
    }

    return this.typeToUnionVariant(this.parsePostfixType());
  }

  /** Parse struct, collection, primitive/ref, then optional `?` and/or constraint `{ ... }`. */
  protected parsePostfixType(): AST.TypeDefinition {
    // Struct types are self-delimited (`{ ... }`) and take no trailing postfix.
    if (this.check('LBRACE')) {
      return this.parseStructType();
    }

    // String-literal singleton type, e.g. a `"asc" | "desc"` union member.
    // Represented as a ReferenceType named by the literal value (MVP — the AST
    // has no dedicated literal-type node).
    if (this.check('STRING_LITERAL')) {
      const lit = this.advance();
      return {
        kind: 'ReferenceType',
        name: {
          kind: 'QualifiedName',
          parts: [{ kind: 'Identifier', name: lit.value, location: lit.location }],
          location: lit.location,
        },
        location: lit.location,
      };
    }

    // Parse the base type — including generics like List<T> / Map<K,V> — then
    // apply trailing postfix uniformly. Collections previously returned early
    // and never reached the optional/constraint handling, so `List<T>?` and
    // `Map<K,V>?` failed to parse; routing them through here fixes that.
    let baseType: AST.TypeDefinition;
    const token = this.currentToken();
    if (token.kind === 'LPAREN') {
      // Function type: `(A, B) -> R`. Parse param types + arrow + return type;
      // represent it as a ReferenceType named 'Function' (MVP — callable shape
      // captured structurally, signature parsed for well-formedness).
      this.advance(); // '('
      while (!this.check('RPAREN') && !this.isAtEnd()) {
        this.parseTypeDefinition();
        if (!this.match('COMMA')) break;
      }
      this.expect('RPAREN', "Expected ')'");
      this.expect('ARROW', "Expected '->'");
      const ret = this.parseTypeDefinition();
      baseType = {
        kind: 'ReferenceType',
        name: {
          kind: 'QualifiedName',
          parts: [{ kind: 'Identifier', name: 'Function', location: token.location }],
          location: token.location,
        },
        location: AST.mergeLocations(token.location, ret.location),
      };
    } else if (token.kind === 'LIST') {
      baseType = this.parseListType();
    } else if (token.kind === 'MAP') {
      baseType = this.parseMapType();
    } else {
      baseType = this.parseBaseType();
    }

    // Suffix array form `T[]` (and `T[][]`): wrap the base in ListType for each
    // trailing EMPTY `[]`. Only fires when `[` is immediately followed by `]` —
    // a non-empty `[immutable, unique]` is a field/type annotation, not an array
    // suffix, and must be left for the annotation parser.
    while (this.check('LBRACKET') && this.peekNextToken()?.kind === 'RBRACKET') {
      this.advance(); // '['
      const close = this.advance(); // ']'
      baseType = {
        kind: 'ListType',
        element: baseType,
        location: AST.mergeLocations(baseType.location, close.location),
      };
    }

    if (this.check('QUESTION')) {
      this.advance();
      baseType = {
        kind: 'OptionalType',
        inner: baseType,
        location: baseType.location,
      };
    }

    // A constraint block may follow the (optionally-marked) type, e.g.
    // `Duration? { default: 1000 }` or `Int { min: 0 }`.
    if (this.check('LBRACE')) {
      return this.parseConstrainedType(baseType);
    }

    return baseType;
  }

  protected typeToUnionVariant(t: AST.TypeDefinition): AST.UnionVariant {
    const name = this.syntheticUnionVariantName(t);
    const fields = t.kind === 'StructType' ? t.fields : [];
    return {
      kind: 'UnionVariant',
      name,
      fields,
      memberType: t,
      location: t.location,
    };
  }

  protected syntheticUnionVariantName(t: AST.TypeDefinition): AST.Identifier {
    switch (t.kind) {
      case 'PrimitiveType':
        return { kind: 'Identifier', name: t.name, location: t.location };
      case 'ReferenceType': {
        const p0 = t.name.parts[0];
        return p0 ?? { kind: 'Identifier', name: 'unknown', location: t.location };
      }
      case 'StructType':
        return { kind: 'Identifier', name: '_', location: t.location };
      default:
        return { kind: 'Identifier', name: '_', location: t.location };
    }
  }

  protected parseBaseType(): AST.TypeDefinition {
    const token = this.currentToken();

    // Check for primitive types
    if (isPrimitiveType(token.value)) {
      this.advance();
      return {
        kind: 'PrimitiveType',
        name: token.value as AST.PrimitiveType['name'],
        location: token.location,
      };
    }

    // Reference type (identifier or qualified name), with optional generic
    // arguments: `Array<T>`, `Result<{a: T}, E>`. The args (which may be
    // anonymous structs or further generics) are parsed for well-formedness and
    // discarded — the MVP type system keeps the outer ReferenceType.
    const name = this.parseQualifiedName();
    if (this.check('LT')) {
      this.advance(); // '<'

      while (true) {
        this.parseTypeDefinition(); // accepts structs `{...}`, nested generics, etc.
        if (this.match('COMMA')) continue;
        break;
      }
      this.expect('GT', "Expected '>'");
    }
    return {
      kind: 'ReferenceType',
      name,
      location: name.location,
    };
  }

  protected parseListType(): AST.ListType {
    const start = this.advance(); // consume 'List'
    this.expect('LT', "Expected '<'");
    const element = this.parseTypeDefinition();
    const end = this.expect('GT', "Expected '>'");

    return {
      kind: 'ListType',
      element,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseMapType(): AST.MapType {
    const start = this.advance(); // consume 'Map'
    this.expect('LT', "Expected '<'");
    const key = this.parseTypeDefinition();
    this.expect('COMMA', "Expected ','");
    const value = this.parseTypeDefinition();
    const end = this.expect('GT', "Expected '>'");

    return {
      kind: 'MapType',
      key,
      value,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseStructType(): AST.StructType {
    const start = this.expect('LBRACE', "Expected '{'");
    const fields: AST.Field[] = [];

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      // A struct may carry an `invariants { - expr ... }` block (e.g. inside a
      // `type DatasetSpec { ... invariants { ... } }`). Parse and discard — the
      // StructType AST has no invariants slot, but the contract still parses.
      if (this.check('INVARIANTS')) {
        this.parseEntityInvariants();
        this.match('COMMA');
        continue;
      }
      fields.push(this.parseField());
      this.match('COMMA'); // struct fields may be comma- or newline-separated
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'StructType',
      fields,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseUnionType(): AST.UnionType {
    const start = this.currentToken();
    const variants: AST.UnionVariant[] = [];

    while (this.match('PIPE')) {
      variants.push(this.parseUnionArm());
    }

    if (variants.length === 0) {
      this.errors.addError("Expected type after '|'", ErrorCode.UNEXPECTED_TOKEN, start.location);
      return {
        kind: 'UnionType',
        variants: [],
        location: start.location,
      };
    }

    return {
      kind: 'UnionType',
      variants,
      location: AST.mergeLocations(start.location, variants[variants.length - 1]!.location),
    };
  }

  protected parseConstrainedType(base: AST.TypeDefinition): AST.ConstrainedType {
    this.expect('LBRACE', "Expected '{'");
    const constraints: AST.Constraint[] = [];

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      constraints.push(this.parseConstraint());
      this.match('COMMA'); // constraints may be comma- or newline-separated
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'ConstrainedType',
      base,
      constraints,
      location: AST.mergeLocations(base.location, end.location),
    };
  }

  protected parseConstraint(): AST.Constraint {
    const name = this.parseIdentifier();
    // Two constraint forms:
    //   `name: value`            (e.g. `pattern: /.../`, `max_length: 64`)
    //   `name <op> value`        (e.g. `length <= 64`, `value > 0`) — a bare
    //                            comparison; capture the operator + RHS as a
    //                            BinaryExpr over the constraint name.
    if (this.check('COLON')) {
      this.advance();
      const value = this.parseExpression();
      return {
        kind: 'Constraint',
        name: name.name,
        value,
        location: AST.mergeLocations(name.location, value.location),
      };
    }
    // Comparison form: rebuild `name <op> rhs` as an expression.
    const opTok = this.currentToken();
    this.advance(); // consume the comparison operator
    const rhs = this.parseExpression();
    const value: AST.Expression = {
      kind: 'BinaryExpr',
      operator: opTok.value as AST.BinaryExpr['operator'],
      left: { kind: 'Identifier', name: name.name, location: name.location },
      right: rhs,
      location: AST.mergeLocations(name.location, rhs.location),
    };
    return {
      kind: 'Constraint',
      name: name.name,
      value,
      location: AST.mergeLocations(name.location, rhs.location),
    };
  }

  // ============================================================================
  // ENTITIES
  // ============================================================================

  /**
   * Skip an optional generic type-parameter list `<T>` / `<K, V>` after a
   * declaration name. The params are parsed and discarded (the MVP type system
   * is monomorphic), so `entity QueueItem<T> { ... }` is accepted structurally.
   */
  protected skipOptionalTypeParams(): void {
    if (!this.check('LT')) return;
    this.advance(); // '<'
    let depth = 1;
    while (depth > 0 && !this.isAtEnd()) {
      if (this.check('LT')) depth++;
      else if (this.check('GT')) depth--;
      this.advance();
    }
  }

  protected parseEntity(): AST.Entity {
    const start = this.advance(); // consume 'entity'
    const name = this.parseIdentifier();
    this.skipOptionalTypeParams(); // generic entities: `entity QueueItem<T> { ... }`
    // Optional entity-level annotations: `entity Dashboard [canvas, audit] { … }`.
    // Mirrors field annotations; parseAnnotations() returns [] when no '[' follows.
    const annotations = this.parseAnnotations();
    this.expect('LBRACE', "Expected '{'");

    const fields: AST.Field[] = [];
    const invariants: AST.Expression[] = [];
    let lifecycle: AST.LifecycleSpec | undefined;
    let permissions: AST.PermissionsBlock | undefined;

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      if (this.check('INVARIANTS')) {
        invariants.push(...this.parseEntityInvariants());
      } else if (this.check('LIFECYCLE')) {
        lifecycle = this.parseLifecycle();
      } else if (
        // Entity-level RBAC `permissions { read: …, write: …, delete: … }`.
        // Dispatched on the identifier value followed by `{` — additive, so a
        // field literally named `permissions` (with a `:` type) is unaffected.
        this.currentToken().type === 'IDENTIFIER' &&
        this.currentToken().value === 'permissions' &&
        this.peekNextToken()?.kind === 'LBRACE'
      ) {
        permissions = this.parseEntityPermissions();
      } else {
        fields.push(this.parseField());
      }
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'Entity',
      name,
      annotations,
      fields,
      invariants,
      lifecycle,
      permissions,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  /**
   * Parse a domain-level `roles { admin, manager, clerk }` block. Comma- and/or
   * newline-separated identifiers. Strictly additive sugar; the role names become
   * the closed RBAC set used by per-role RLS lowering and the per-role proof.
   */
  protected parseRolesDecl(): AST.RolesDecl {
    const start = this.advance(); // consume the 'roles' identifier
    this.expect('LBRACE', "Expected '{'");
    const roles: AST.RoleDecl[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const name = this.parseIdentifier();
      roles.push({ kind: 'RoleDecl', name, location: name.location });
      this.match('COMMA');
    }
    const end = this.expect('RBRACE', "Expected '}'");
    return {
      kind: 'RolesDecl',
      roles,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  /**
   * Parse a domain-level `auth { google, github }` block — a brace list of
   * OAuth provider identifiers (comma or newline separated). Strictly additive
   * sugar; each provider lowers to its `oauth-<name>` recipe at codegen time.
   */
  protected parseAuthDecl(): AST.AuthDecl {
    const start = this.advance(); // consume the 'auth' identifier
    this.expect('LBRACE', "Expected '{'");
    const providers: AST.ProviderDecl[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const name = this.parseIdentifier();
      providers.push({ kind: 'ProviderDecl', name, location: name.location });
      this.match('COMMA');
    }
    const end = this.expect('RBRACE', "Expected '}'");
    return {
      kind: 'AuthDecl',
      providers,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  /**
   * Parse a domain-level `integrations { posthog }` block — a brace list of
   * third-party service identifiers, optionally with a configuration body:
   *
   *   QuickBooks {
   *     type: accounting
   *     direction: inbound
   *     capability: "payment event"
   *     requires { endpoint_url, signing_secret }
   *     event: "invoice.paid"
   *   }
   *
   * Name-only members remain valid. Strictly additive.
   */
  protected parseIntegrationsDecl(): AST.IntegrationsDecl {
    const start = this.advance(); // consume the 'integrations' identifier
    this.expect('LBRACE', "Expected '{'");
    const services: AST.ProviderDecl[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const name = this.parseIdentifier();
      if (this.check('LBRACE')) {
        services.push(this.parseProviderBody(name));
      } else {
        services.push({ kind: 'ProviderDecl', name, location: name.location });
      }
      this.match('COMMA');
    }
    const end = this.expect('RBRACE', "Expected '}'");
    return {
      kind: 'IntegrationsDecl',
      services,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseProviderBody(name: AST.Identifier): AST.ProviderDecl {
    this.expect('LBRACE', "Expected '{'");
    let type: AST.Identifier | undefined;
    let direction: AST.Identifier | undefined;
    let capability: AST.StringLiteral | undefined;
    let requires: AST.Identifier[] | undefined;
    let event: AST.StringLiteral | undefined;
    let action: AST.Identifier | undefined;
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const key = this.parseIdentifier();
      this.expect('COLON', "Expected ':'");
      if (key.name === 'type') {
        type = this.parseIdentifier();
      } else if (key.name === 'direction') {
        direction = this.parseIdentifier();
      } else if (key.name === 'capability') {
        capability = this.parseStringLiteral();
      } else if (key.name === 'requires') {
        requires = this.parseIdentifierSet();
      } else if (key.name === 'event') {
        event = this.parseStringLiteral();
      } else if (key.name === 'action') {
        action = this.parseIdentifier();
      } else {
        this.parseExpression();
      }
      this.match('COMMA');
    }
    const end = this.expect('RBRACE', "Expected '}'");
    return {
      kind: 'ProviderDecl',
      name,
      ...(type === undefined ? {} : { type }),
      ...(direction === undefined ? {} : { direction }),
      ...(capability === undefined ? {} : { capability }),
      ...(requires === undefined || requires.length === 0 ? {} : { requires }),
      ...(event === undefined ? {} : { event }),
      ...(action === undefined ? {} : { action }),
      location: AST.mergeLocations(name.location, end.location),
    };
  }

  /** `{ a, b }` or `[a, b]` identifier sets. */
  protected parseIdentifierSet(): AST.Identifier[] {
    const items: AST.Identifier[] = [];
    const opening = this.check('LBRACE') ? 'LBRACE' : this.check('LBRACKET') ? 'LBRACKET' : undefined;
    if (opening === undefined) {
      items.push(this.parseIdentifier());
      return items;
    }
    this.advance();
    const closing = opening === 'LBRACE' ? 'RBRACE' : 'RBRACKET';
    while (!this.check(closing) && !this.isAtEnd()) {
      items.push(this.parseIdentifier());
      this.match('COMMA');
    }
    this.expect(closing, opening === 'LBRACE' ? "Expected '}'" : "Expected ']'");
    return items;
  }

  /**
   * `relationship name { source: A  target: B  cardinality: many_to_many }`
   */
  protected parseRelationshipDecl(): AST.RelationshipDecl {
    const start = this.advance(); // consume 'relationship'
    const name = this.parseIdentifier();
    this.expect('LBRACE', "Expected '{'");
    let source: AST.Identifier | undefined;
    let target: AST.Identifier | undefined;
    let cardinality: AST.RelationshipCardinality = 'many_to_many';
    let optional = false;
    let sourceField: AST.Identifier | undefined;
    let targetField: AST.Identifier | undefined;
    let associationEntity: AST.Identifier | undefined;
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const key = this.parseIdentifier();
      this.expect('COLON', "Expected ':'");
      if (key.name === 'source') source = this.parseIdentifier();
      else if (key.name === 'target') target = this.parseIdentifier();
      else if (key.name === 'cardinality') {
        const value = this.parseIdentifier();
        if (
          value.name === 'one_to_one' ||
          value.name === 'one_to_many' ||
          value.name === 'many_to_one' ||
          value.name === 'many_to_many'
        ) {
          cardinality = value.name;
        }
      } else if (key.name === 'optional') {
        const value = this.advance();
        optional = value.value === 'true' || value.kind === 'TRUE';
      } else if (key.name === 'source_field' || key.name === 'sourceField') {
        sourceField = this.parseIdentifier();
      } else if (key.name === 'target_field' || key.name === 'targetField') {
        targetField = this.parseIdentifier();
      } else if (key.name === 'association' || key.name === 'association_entity' || key.name === 'associationEntity') {
        associationEntity = this.parseIdentifier();
      } else {
        this.parseExpression();
      }
      this.match('COMMA');
    }
    const end = this.expect('RBRACE', "Expected '}'");
    if (source === undefined || target === undefined) {
      throw unexpectedToken(this.previousToken(), 'relationship source and target');
    }
    return {
      kind: 'RelationshipDecl',
      name,
      source,
      target,
      cardinality,
      optional,
      ...(sourceField === undefined ? {} : { sourceField }),
      ...(targetField === undefined ? {} : { targetField }),
      ...(associationEntity === undefined ? {} : { associationEntity }),
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  /**
   * Parse an entity-level `permissions { read: <roleExpr>, write: …, delete: … }`
   * block. Each key is one of read|write|delete; each RHS is a `|`-separated role
   * expression over declared role names plus the literal `owner`. Lowers to
   * per-role RESTRICTIVE RLS + per-action server-action role guards.
   */
  protected parseEntityPermissions(): AST.PermissionsBlock {
    const start = this.advance(); // consume the 'permissions' identifier
    this.expect('LBRACE', "Expected '{'");
    const rules: AST.PermissionRule[] = [];
    const VALID = new Set(['read', 'write', 'delete']);
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const keyTok = this.parseIdentifier();
      const action = keyTok.name;
      if (!VALID.has(action)) {
        throw unexpectedToken(this.previousToken(), 'permission action (read|write|delete)');
      }
      this.expect('COLON', "Expected ':'");
      const allow = this.parseRoleExpr();
      rules.push({
        kind: 'PermissionRule',
        action: action as AST.PermissionRule['action'],
        allow,
        location: AST.mergeLocations(keyTok.location, allow.location),
      });
      this.match('COMMA');
    }
    const end = this.expect('RBRACE', "Expected '}'");
    return {
      kind: 'PermissionsBlock',
      rules,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  /** Parse `admin | owner | tenant | related(buyerId) | none`. */
  protected parseRoleExpr(): AST.RoleExpr {
    const roles: AST.Identifier[] = [];
    const related: AST.Identifier[] = [];
    let owner = false;
    let tenant = false;
    let none = false;
    const first = this.parseRoleExprTerm(roles, related, {
      setOwner: (isOwner) => {
        if (isOwner) owner = true;
      },
      setTenant: (isTenant) => {
        if (isTenant) tenant = true;
      },
      setNone: (isNone) => {
        if (isNone) none = true;
      },
    });
    let lastLoc = first;
    while (this.match('PIPE')) {
      lastLoc = this.parseRoleExprTerm(roles, related, {
        setOwner: (isOwner) => {
          if (isOwner) owner = true;
        },
        setTenant: (isTenant) => {
          if (isTenant) tenant = true;
        },
        setNone: (isNone) => {
          if (isNone) none = true;
        },
      });
    }
    return {
      kind: 'RoleExpr',
      roles,
      owner,
      related: related.length > 0 ? related : undefined,
      ...(tenant ? { tenant: true } : {}),
      ...(none ? { none: true } : {}),
      location: AST.mergeLocations(first, lastLoc),
    };
  }

  /** One RoleExpr atom. `related(` starts a counterparty; bare `related` stays a role name. */
  protected parseRoleExprTerm(
    roles: AST.Identifier[],
    related: AST.Identifier[],
    flags: {
      setOwner: (owner: boolean) => void;
      setTenant: (tenant: boolean) => void;
      setNone: (none: boolean) => void;
    },
  ): AST.SourceLocation {
    const tok = this.parseIdentifier();
    if (tok.name === 'owner') {
      flags.setOwner(true);
      return tok.location;
    }
    if (tok.name === 'tenant') {
      flags.setTenant(true);
      return tok.location;
    }
    if (tok.name === 'none') {
      flags.setNone(true);
      return tok.location;
    }
    if (tok.name === 'related' && this.check('LPAREN')) {
      this.advance();
      const field = this.parseIdentifier();
      this.expect('RPAREN', "Expected ')' after related(");
      related.push(field);
      return AST.mergeLocations(tok.location, field.location);
    }
    roles.push(tok);
    return tok.location;
  }

  protected parseField(): AST.Field {
    // Optional `computed` modifier: `computed name: Type = expr` declares a
    // derived field. Consume the marker; the `= expr` is captured as defaultValue.
    if (this.currentToken().value === 'computed' && this.peekNextToken()?.kind !== 'COLON') {
      this.advance();
    }
    const name = this.parseIdentifier();
    this.expect('COLON', "Expected ':'");

    const type = this.parseTypeDefinition();
    let optional = false;

    // Check for optional suffix on field name
    if (type.kind === 'OptionalType') {
      optional = true;
    }

    const bracketAnnotations = this.parseAnnotations();
    const inlineAnnotations = this.parseInlineAnnotations();
    const annotations = bracketAnnotations.length > 0 ? bracketAnnotations : inlineAnnotations;
    let defaultValue: AST.Expression | undefined;

    if (this.match('ASSIGN')) {
      defaultValue = this.parseExpression();
    }

    return {
      kind: 'Field',
      name,
      type,
      optional,
      annotations,
      defaultValue,
      location: AST.mergeLocations(name.location, type.location),
    };
  }

  protected parseAnnotations(): AST.Annotation[] {
    const annotations: AST.Annotation[] = [];

    if (!this.check('LBRACKET')) {
      return annotations;
    }

    this.advance(); // consume '['

    while (!this.check('RBRACKET') && !this.isAtEnd()) {
      const annotation = this.parseAnnotation();
      annotations.push(annotation);
      this.match('COMMA'); // optional comma
    }

    this.expect('RBRACKET', "Expected ']'");
    return annotations;
  }

  protected parseAnnotation(): AST.Annotation {
    const name = this.parseIdentifier();
    let value: AST.Expression | undefined;

    if (this.match('COLON')) {
      value = this.parseExpression();
    }

    return {
      kind: 'Annotation',
      name,
      value,
      location: value ? AST.mergeLocations(name.location, value.location) : name.location,
    };
  }

  protected parseEntityInvariants(): AST.Expression[] {
    this.advance(); // consume 'invariants'
    this.expect('LBRACE', "Expected '{'");

    const invariants: AST.Expression[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      invariants.push(this.parseBulletedExpression());
    }

    this.expect('RBRACE', "Expected '}'");
    return invariants;
  }

  protected parseLifecycle(): AST.LifecycleSpec {
    const start = this.advance(); // consume 'lifecycle'
    this.expect('LBRACE', "Expected '{'");

    const transitions: AST.LifecycleTransition[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      // Tolerate a richer lifecycle form:
      //   initial: STATE
      //   transitions { A -> B   B -> C }
      // alongside the flat `A -> B` list. The `initial:` value and the nested
      // `transitions { }` wrapper are accepted; transitions are collected from
      // wherever they appear.
      // Lifecycle metadata fields `key: value` (e.g. `initial: PENDING`,
      // `terminal: [DONE, FAILED]`) — accepted for well-formedness, not stored
      // (no AST slot). The value is any expression (identifier, list, etc.).
      if (
        (this.currentToken().type === 'IDENTIFIER' || this.currentToken().type === 'KEYWORD') &&
        this.peekNextToken()?.kind === 'COLON'
      ) {
        this.advance(); // key
        this.advance(); // ':'
        this.parseExpression(); // value
        this.match('COMMA');
        continue;
      }
      if (this.currentToken().value === 'transitions' && this.peekNextToken()?.kind === 'LBRACE') {
        this.advance(); // 'transitions'
        this.advance(); // '{'
        while (!this.check('RBRACE') && !this.isAtEnd()) {
          transitions.push(...this.parseLifecycleTransition());
        }
        this.expect('RBRACE', "Expected '}'");
        continue;
      }
      transitions.push(...this.parseLifecycleTransition());
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'LifecycleSpec',
      transitions,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseLifecycleTransition(): AST.LifecycleTransition[] {
    const forbidden =
      this.currentToken().value === 'forbid' || this.currentToken().value === 'forbidden';
    if (forbidden) this.advance();
    const from = this.parseIdentifier();
    this.expect('ARROW', "Expected '->'");
    const to = this.parseIdentifier();

    // Handle chained transitions: A -> B -> C -> ...; every hop is returned,
    // in order, as its own LifecycleTransition (A->B, B->C, ...).
    const transitions: AST.LifecycleTransition[] = [
      {
        kind: 'LifecycleTransition',
        from,
        to,
        ...(forbidden ? { forbidden: true } : {}),
        location: AST.mergeLocations(from.location, to.location),
      },
    ];

    while (this.match('ARROW')) {
      const nextTo = this.parseIdentifier();
      const prevTo = transitions[transitions.length - 1]?.to;
      if (prevTo) {
        transitions.push({
          kind: 'LifecycleTransition',
          from: prevTo,
          to: nextTo,
          location: AST.mergeLocations(prevTo.location, nextTo.location),
        });
      }
    }

    return transitions;
  }

  // ============================================================================
  // BEHAVIORS
  // ============================================================================

  protected parseBehavior(): AST.Behavior {
    const start = this.advance(); // consume 'behavior'
    const name = this.parseIdentifier();
    // Optional leading behavior annotations. Accepts BOTH the idiomatic single
    // comma-separated block (`[action: "account", setField: "…"]`) and multiple
    // consecutive blocks (`[action: "account"] [setField: "…"]`) — the loop is the
    // only departure from parseEntity, making the carrier forgiving of either form
    // the spec-writer emits. parseAnnotations() returns [] when no '[' follows, so a
    // behavior with no leading annotation is byte-identical to before.
    const annotations: AST.Annotation[] = [];
    while (this.check('LBRACKET')) annotations.push(...this.parseAnnotations());
    this.expect('LBRACE', "Expected '{'");
    this.behaviorExtraCloses = 0;

    const behavior: AST.Behavior = {
      kind: 'Behavior',
      name,
      annotations,
      input: { kind: 'InputSpec', fields: [], location: name.location },
      output: {
        kind: 'OutputSpec',
        success: { kind: 'PrimitiveType', name: 'Boolean', location: name.location },
        errors: [],
        location: name.location,
      },
      preconditions: [],
      postconditions: [],
      invariants: [],
      temporal: [],
      security: [],
      compliance: [],
      location: start.location,
    };

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      this.parseBehaviorMember(behavior);
    }

    const end = this.expect('RBRACE', "Expected '}'");
    // Writer form `behavior X { [annots] { members } }` — extra inner `{`
    // skipped in parseBehaviorMember. Consume the matching extra `}` when
    // present; Drawing-style specs emit the extra open without a second close.
    while (this.behaviorExtraCloses > 0 && this.check('RBRACE')) {
      this.advance();
      this.behaviorExtraCloses--;
    }
    this.behaviorExtraCloses = 0;
    behavior.location = AST.mergeLocations(start.location, end.location);

    return behavior;
  }

  protected parseBehaviorMember(behavior: AST.Behavior): void {
    const token = this.currentToken();

    switch (token.kind) {
      case 'DESCRIPTION':
        behavior.description = this.parseDescriptionField();
        break;
      case 'ACTORS':
        behavior.actors = this.parseActors();
        break;
      case 'INPUT':
        behavior.input = this.parseInput();
        break;
      case 'OUTPUT':
        behavior.output = this.parseOutput();
        break;
      // Shorthand syntax: pre { }
      case 'PRE':
        behavior.preconditions = this.parsePreconditions();
        break;
      // Legacy verbose syntax: preconditions { }
      case 'PRECONDITIONS':
        behavior.preconditions = this.parsePreconditions();
        break;
      // Shorthand syntax: post success { }, post ErrorName { }
      case 'POST':
        behavior.postconditions.push(this.parsePostShorthand());
        break;
      // Legacy verbose syntax: postconditions { success implies { } }
      case 'POSTCONDITIONS':
        behavior.postconditions = this.parsePostconditions();
        break;
      case 'INVARIANTS':
        behavior.invariants = this.parseInvariants();
        break;
      case 'TEMPORAL':
        behavior.temporal = this.parseTemporalSpecs();
        break;
      case 'SECURITY':
        behavior.security = this.parseSecuritySpecs();
        break;
      case 'COMPLIANCE':
        behavior.compliance = this.parseComplianceSpecs();
        break;
      case 'OBSERVABILITY':
        behavior.observability = this.parseObservability();
        break;
      case 'LBRACKET':
        // Inner behavior annotations placed inside the body:
        // `behavior foo { [action: "X"] description: "…" }`
        // plus the extra-brace writer form `behavior foo { [annots] { members } }`.
        behavior.annotations = behavior.annotations ?? [];
        behavior.annotations.push(...this.parseAnnotations());
        if (this.check('LBRACE')) {
          this.advance();
          this.behaviorExtraCloses++;
        }
        break;
      default:
        // Singular aliases written as identifiers: `precondition { }` /
        // `postcondition { }` / `invariant { }`. parse*() consume the leading
        // word, so routing by value works.
        if (token.value === 'precondition') {
          behavior.preconditions = this.parsePreconditions();
          break;
        }
        if (token.value === 'postcondition') {
          behavior.postconditions = this.parsePostconditions();
          break;
        }
        if (token.value === 'invariant') {
          behavior.invariants = this.parseInvariants();
          break;
        }
        throw unexpectedToken(token, 'behavior member');
    }
  }

  protected parseDescriptionField(): AST.StringLiteral {
    this.advance(); // consume 'description'
    this.expect('COLON', "Expected ':'");
    return this.parseStringLiteral();
  }

  /**
   * `tenancy: "multi-tenant" | "single-tenant"` — domain-header soft keyword.
   * Unknown values fail-closed to "multi-tenant" (the safe default) rather than
   * throwing, so a typo never breaks a build's data isolation.
   */
  protected parseTenancyField(): 'multi-tenant' | 'single-tenant' {
    this.advance(); // consume 'tenancy'
    this.expect('COLON', "Expected ':'");
    const lit = this.parseStringLiteral();
    if (lit.value !== 'single-tenant' && lit.value !== 'multi-tenant') {
      this.errors.addError(
        `tenancy must be "multi-tenant" or "single-tenant", not "${lit.value}" — failing closed to multi-tenant`,
        ErrorCode.INVALID_CONSTRAINT,
        lit.location,
      );
    }
    return lit.value === 'single-tenant' ? 'single-tenant' : 'multi-tenant';
  }

  protected parseActors(): AST.ActorSpec[] {
    this.advance(); // consume 'actors'
    this.expect('LBRACE', "Expected '{'");

    const actors: AST.ActorSpec[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      actors.push(this.parseActorSpec());
    }

    this.expect('RBRACE', "Expected '}'");
    return actors;
  }

  protected parseActorSpec(): AST.ActorSpec {
    const name = this.parseIdentifier();
    this.expect('LBRACE', "Expected '{'");

    const constraints: AST.Expression[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      if (this.check('MUST')) {
        this.advance();
        this.expect('COLON', "Expected ':'");
      }
      constraints.push(this.parseExpression());
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'ActorSpec',
      name,
      constraints,
      location: AST.mergeLocations(name.location, end.location),
    };
  }

  protected parseInput(): AST.InputSpec {
    const start = this.advance(); // consume 'input'
    this.expect('LBRACE', "Expected '{'");

    const fields: AST.Field[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      fields.push(this.parseField());
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'InputSpec',
      fields,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseOutput(): AST.OutputSpec {
    const start = this.advance(); // consume 'output'
    this.expect('LBRACE', "Expected '{'");

    let success: AST.TypeDefinition = {
      kind: 'PrimitiveType',
      name: 'Boolean',
      location: start.location,
    };
    const errors: AST.ErrorSpec[] = [];

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      if (this.check('SUCCESS')) {
        this.advance();
        this.expect('COLON', "Expected ':'");
        success = this.parseTypeDefinition();
      } else if (this.check('ERRORS')) {
        this.advance();
        this.expect('LBRACE', "Expected '{'");
        while (!this.check('RBRACE') && !this.isAtEnd()) {
          errors.push(this.parseErrorSpec());
        }
        this.expect('RBRACE', "Expected '}'");
      } else if (this.check('PIPE')) {
        // Union-type output: `output { | A { ... } | B { ... } }` — the success
        // value is a tagged union of result variants (parseTypeDefinition reads
        // the leading-pipe union form).
        success = this.parseTypeDefinition();
      } else {
        throw unexpectedToken(this.currentToken(), 'output member');
      }
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'OutputSpec',
      success,
      errors,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseErrorSpec(): AST.ErrorSpec {
    const name = this.parseIdentifier();
    this.expect('LBRACE', "Expected '{'");

    let when: AST.StringLiteral | undefined;
    let retriable = false;
    let retryAfter: AST.Expression | undefined;
    let returns: AST.TypeDefinition | undefined;

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.kind === 'WHEN') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        when = this.parseStringLiteral();
      } else if (token.kind === 'RETRIABLE') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        retriable = this.parseBooleanLiteral().value;
      } else if (token.kind === 'RETRY_AFTER') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        retryAfter = this.parseExpression();
      } else if (token.kind === 'RETURNS') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        returns = this.parseTypeDefinition();
      } else if (
        (token.type === 'IDENTIFIER' || token.type === 'KEYWORD') &&
        this.peekNextToken()?.kind === 'COLON'
      ) {
        // Tolerate additional/aliased error-spec members written as `key: value`
        // (e.g. `retryAfter:` in camelCase vs the `retry_after` keyword, or
        // forward-compatible fields). Recognize known aliases, else parse-and-skip.
        const key = token.value;
        this.advance(); // key
        this.advance(); // ':'
        const value = this.parseExpression();
        if (key === 'retryAfter') retryAfter = value;
      } else {
        throw unexpectedToken(token, 'error spec member');
      }
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'ErrorSpec',
      name,
      when,
      retriable,
      retryAfter,
      returns,
      location: AST.mergeLocations(name.location, end.location),
    };
  }

  protected parsePreconditions(): AST.Expression[] {
    this.advance(); // consume 'preconditions'
    this.expect('LBRACE', "Expected '{'");

    const preconditions: AST.Expression[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      preconditions.push(this.parseBulletedExpression());
    }

    this.expect('RBRACE', "Expected '}'");
    return preconditions;
  }

  /**
   * Skip optional bullet point prefix (- ) before expressions in lists.
   * This supports the shorthand syntax: `- User.exists(id)`
   * instead of just `User.exists(id)`.
   */
  protected skipOptionalBullet(): void {
    // Skip `-` when followed by an identifier (not a number literal)
    // This allows `- expr` as a bullet point marker
    if (this.check('MINUS') && this.isObligationBulletFollower(this.peekNextToken())) {
      this.advance(); // consume the bullet `-`
    }
  }

  /**
   * Parse ONE obligation from a `-`-bulleted list: consume the leading bullet, then parse the
   * expression with `bulletedListDepth` raised so parseAdditive won't swallow the NEXT line's
   * bullet `-` as a subtraction. This is what makes each `- expr` line its own clause instead of
   * folding `- a > 0` + `- b > 0` into a single chained expression.
   */
  protected parseBulletedExpression(): AST.Expression {
    this.skipOptionalBullet();
    this.bulletedListDepth++;
    try {
      return this.parseExpression();
    } finally {
      this.bulletedListDepth--;
    }
  }

  protected parsePostconditions(): AST.PostconditionBlock[] {
    this.advance(); // consume 'postconditions'
    this.expect('LBRACE', "Expected '{'");

    const blocks: AST.PostconditionBlock[] = [];
    const flatPredicates: AST.Expression[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      // Two postcondition forms inside the block:
      //   `success implies { ... }` — a guarded block (parsePostconditionBlock)
      //   `- expr` / `expr` bullets   — a flat predicate list (e.g.
      //                                 `result is Connected implies ...`)
      // Detect a guard block only when a `<cond> implies {` pattern leads.
      if (this.isPostconditionGuardAhead()) {
        blocks.push(this.parsePostconditionBlock());
      } else {
        flatPredicates.push(this.parseBulletedExpression());
      }
    }

    this.expect('RBRACE', "Expected '}'");
    if (flatPredicates.length > 0) {
      blocks.push({
        kind: 'PostconditionBlock',
        condition: 'success',
        predicates: flatPredicates,
        location: flatPredicates[0]!.location,
      });
    }
    return blocks;
  }

  /**
   * True if the upcoming tokens form a `<cond> implies {` or `<cond> {` guard
   * block. `implies` is optional — the reference grammar spells the entry
   * `PostconditionCondition _ ("implies" _)? "{"` (see
   * `src/grammar/isl.peggy` → `PostconditionEntry`), so `success { … }` is the
   * same clause as `success implies { … }`.
   */
  protected isPostconditionGuardAhead(): boolean {
    const t0 = this.currentToken();
    const nextKind = this.peekNextToken()?.kind;
    // `success` / `any_error` guards always start a block.
    if (t0.kind === 'SUCCESS' || t0.value === 'success' || t0.value === 'any_error') {
      return nextKind === 'IMPLIES' || nextKind === 'LBRACE';
    }
    // `Identifier implies {` / `Identifier {` — a named-error guard. Distinguish
    // from a flat predicate that merely contains `implies` by requiring the `{`
    // right after. A bare identifier followed by `{` is not a single expression
    // in this grammar, so the brace-only form is unambiguous too.
    if (t0.type === 'IDENTIFIER' && (nextKind === 'IMPLIES' || nextKind === 'LBRACE')) {
      return true;
    }
    return false;
  }

  protected parsePostconditionBlock(): AST.PostconditionBlock {
    let condition: AST.Identifier | 'success' | 'any_error';
    const start = this.currentToken();

    if (this.check('SUCCESS') || this.currentToken().value === 'success') {
      condition = 'success';
      this.advance();
    } else if (this.check('ANY') || this.currentToken().value === 'any_error') {
      condition = 'any_error';
      this.advance();
    } else {
      condition = this.parseIdentifier();
    }

    // `implies` is optional: `success { … }` and `success implies { … }` are
    // the same clause (grammar rule `PostconditionEntry` in isl.peggy).
    this.match('IMPLIES');
    this.expect('LBRACE', "Expected '{'");

    const predicates: AST.Expression[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      predicates.push(this.parseBulletedExpression());
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'PostconditionBlock',
      condition,
      predicates,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  /**
   * Parse shorthand postcondition syntax: post success { } or post ErrorName { }
   * This is the canonical syntax (preferred over verbose postconditions { success implies { } })
   */
  protected parsePostShorthand(): AST.PostconditionBlock {
    const start = this.advance(); // consume 'post'

    let condition: AST.Identifier | 'success' | 'any_error';

    if (this.check('SUCCESS') || this.currentToken().value === 'success') {
      condition = 'success';
      this.advance();
    } else if (this.check('ANY') || this.currentToken().value === 'any_error') {
      condition = 'any_error';
      this.advance();
    } else if (this.currentToken().value === 'failure') {
      // 'failure' is an alias for 'any_error'
      condition = 'any_error';
      this.advance();
    } else {
      condition = this.parseIdentifier();
    }

    this.expect('LBRACE', "Expected '{'");

    const predicates: AST.Expression[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      predicates.push(this.parseBulletedExpression());
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'PostconditionBlock',
      condition,
      predicates,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseInvariants(): AST.Expression[] {
    this.advance(); // consume 'invariants'
    this.expect('LBRACE', "Expected '{'");

    const invariants: AST.Expression[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      invariants.push(this.parseBulletedExpression());
    }

    this.expect('RBRACE', "Expected '}'");
    return invariants;
  }

  protected parseTemporalSpecs(): AST.TemporalSpec[] {
    this.advance(); // consume 'temporal'
    this.expect('LBRACE', "Expected '{'");

    const specs: AST.TemporalSpec[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      specs.push(this.parseTemporalSpec());
    }

    this.expect('RBRACE', "Expected '}'");
    return specs;
  }

  protected parseTemporalSpec(): AST.TemporalSpec {
    const start = this.currentToken();
    let operator: AST.TemporalSpec['operator'] = 'eventually';
    let duration: AST.DurationLiteral | undefined;
    let percentile: number | undefined;

    // Parse operator: response, eventually, always, within, never, immediately
    if (this.currentToken().value === 'response') {
      operator = 'response';
      this.advance();
    } else if (this.check('EVENTUALLY')) {
      operator = 'eventually';
      this.advance();
    } else if (this.check('ALWAYS')) {
      operator = 'always';
      this.advance();
    } else if (this.check('WITHIN')) {
      operator = 'within';
      this.advance();
    } else if (this.check('NEVER')) {
      operator = 'never';
      this.advance();
    } else if (this.check('IMMEDIATELY') || this.currentToken().value === 'immediately') {
      operator = 'immediately';
      this.advance();
    }

    // Parse "within duration" if present
    if (this.check('WITHIN') || this.currentToken().value === 'within') {
      this.advance();
      duration = this.parseDurationLiteral();
    }

    // Parse percentile if present: (p50), (p99)
    if (this.check('LPAREN')) {
      this.advance();
      const pValue = this.currentToken().value;
      if (pValue.startsWith('p')) {
        percentile = parseInt(pValue.slice(1), 10);
        this.advance();
      }
      this.expect('RPAREN', "Expected ')'");
    }

    // Parse colon and predicate
    if (this.check('COLON')) {
      this.advance();
    }

    const predicate = this.parseExpression();

    return {
      kind: 'TemporalSpec',
      operator,
      predicate,
      duration,
      percentile,
      location: AST.mergeLocations(start.location, predicate.location),
    };
  }

  protected parseSecuritySpecs(): AST.SecuritySpec[] {
    this.advance(); // consume 'security'
    this.expect('LBRACE', "Expected '{'");

    const specs: AST.SecuritySpec[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      specs.push(this.parseSecuritySpec());
    }

    this.expect('RBRACE', "Expected '}'");
    return specs;
  }

  protected parseSecuritySpec(): AST.SecuritySpec {
    const start = this.currentToken();
    let type: AST.SecuritySpec['type'] = 'requires';

    if (this.check('REQUIRES') || this.currentToken().value === 'requires') {
      type = 'requires';
      this.advance();
    } else if (this.check('RATE_LIMIT') || this.currentToken().value === 'rate_limit') {
      type = 'rate_limit';
      this.advance();
    } else if (this.currentToken().value === 'fraud_check') {
      type = 'fraud_check';
      this.advance();
    }

    const details = this.parseExpression();

    return {
      kind: 'SecuritySpec',
      type,
      details,
      location: AST.mergeLocations(start.location, details.location),
    };
  }

  protected parseComplianceSpecs(): AST.ComplianceSpec[] {
    this.advance(); // consume 'compliance'
    this.expect('LBRACE', "Expected '{'");

    const specs: AST.ComplianceSpec[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      specs.push(this.parseComplianceSpec());
    }

    this.expect('RBRACE', "Expected '}'");
    return specs;
  }

  protected parseComplianceSpec(): AST.ComplianceSpec {
    const standard = this.parseIdentifier();
    this.expect('LBRACE', "Expected '{'");

    const requirements: AST.Expression[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      requirements.push(this.parseExpression());
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'ComplianceSpec',
      standard,
      requirements,
      location: AST.mergeLocations(standard.location, end.location),
    };
  }

  protected parseObservability(): AST.ObservabilitySpec {
    const start = this.advance(); // consume 'observability'
    this.expect('LBRACE', "Expected '{'");

    const metrics: AST.MetricSpec[] = [];
    const traces: AST.TraceSpec[] = [];
    const logs: AST.LogSpec[] = [];

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.kind === 'METRICS') {
        this.advance();
        this.expect('LBRACE', "Expected '{'");
        while (!this.check('RBRACE') && !this.isAtEnd()) {
          metrics.push(this.parseMetricSpec());
        }
        this.expect('RBRACE', "Expected '}'");
      } else if (token.kind === 'TRACES') {
        this.advance();
        this.expect('LBRACE', "Expected '{'");
        while (!this.check('RBRACE') && !this.isAtEnd()) {
          traces.push(this.parseTraceSpec());
        }
        this.expect('RBRACE', "Expected '}'");
      } else if (token.kind === 'LOGS') {
        this.advance();
        this.expect('LBRACE', "Expected '{'");
        while (!this.check('RBRACE') && !this.isAtEnd()) {
          logs.push(this.parseLogSpec());
        }
        this.expect('RBRACE', "Expected '}'");
      } else {
        throw unexpectedToken(token, 'observability member');
      }
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'ObservabilitySpec',
      metrics,
      traces,
      logs,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseMetricSpec(): AST.MetricSpec {
    const name = this.parseIdentifier();
    this.expect('LPAREN', "Expected '('");
    const typeToken = this.currentToken();
    let metricType: AST.MetricSpec['type'] = 'counter';
    if (typeToken.value === 'counter' || typeToken.kind === 'COUNTER') {
      metricType = 'counter';
    } else if (typeToken.value === 'gauge' || typeToken.kind === 'GAUGE') {
      metricType = 'gauge';
    } else if (typeToken.value === 'histogram' || typeToken.kind === 'HISTOGRAM') {
      metricType = 'histogram';
    }
    this.advance();
    this.expect('RPAREN', "Expected ')'");

    const labels: AST.Identifier[] = [];
    if (this.check('BY') || this.currentToken().value === 'by') {
      this.advance();
      this.expect('LBRACKET', "Expected '['");
      while (!this.check('RBRACKET') && !this.isAtEnd()) {
        labels.push(this.parseIdentifier());
        this.match('COMMA');
      }
      this.expect('RBRACKET', "Expected ']'");
    }

    return {
      kind: 'MetricSpec',
      name,
      type: metricType,
      labels,
      location: name.location,
    };
  }

  protected parseTraceSpec(): AST.TraceSpec {
    if (this.check('SPAN') || this.currentToken().value === 'span') {
      this.advance();
    }
    const name = this.parseStringLiteral();

    return {
      kind: 'TraceSpec',
      name,
      location: name.location,
    };
  }

  protected parseLogSpec(): AST.LogSpec {
    let condition: AST.LogSpec['condition'] = 'always';
    let level: AST.LogSpec['level'] = 'info';
    const include: AST.Identifier[] = [];
    const exclude: AST.Identifier[] = [];

    // Parse "on success/error" or "always"
    if (this.check('ON') || this.currentToken().value === 'on') {
      this.advance();
      const condToken = this.currentToken().value;
      if (condToken === 'success') {
        condition = 'success';
      } else if (condToken === 'error') {
        condition = 'error';
      }
      this.advance();
    }

    this.expect('COLON', "Expected ':'");

    // Parse level and include/exclude
    while (!this.check('ON') && !this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.kind === 'LEVEL' || token.value === 'level') {
        this.advance();
        const levelToken = this.currentToken().value;
        if (['debug', 'info', 'warn', 'error'].includes(levelToken)) {
          level = levelToken as AST.LogSpec['level'];
          this.advance();
        }
      } else if (token.kind === 'INCLUDE' || token.value === 'include') {
        this.advance();
        this.expect('LBRACKET', "Expected '['");
        while (!this.check('RBRACKET') && !this.isAtEnd()) {
          include.push(this.parseIdentifier());
          this.match('COMMA');
        }
        this.expect('RBRACKET', "Expected ']'");
      } else if (token.kind === 'EXCLUDE' || token.value === 'exclude') {
        this.advance();
        this.expect('LBRACKET', "Expected '['");
        while (!this.check('RBRACKET') && !this.isAtEnd()) {
          exclude.push(this.parseIdentifier());
          this.match('COMMA');
        }
        this.expect('RBRACKET', "Expected ']'");
      } else if (token.kind === 'COMMA') {
        this.advance();
      } else {
        break;
      }
    }

    return {
      kind: 'LogSpec',
      condition,
      level,
      include,
      exclude,
      location: this.currentLocation(),
    };
  }

  // ============================================================================
  // INVARIANTS, POLICIES, VIEWS
  // ============================================================================

  protected parseInvariantBlock(): AST.InvariantBlock {
    const start = this.advance(); // consume 'invariants'
    // The block name is optional: `invariants Name { ... }` or anonymous
    // `invariants { ... }`.
    const name = this.check('LBRACE')
      ? { kind: 'Identifier' as const, name: '', location: start.location }
      : this.parseIdentifier();
    this.expect('LBRACE', "Expected '{'");

    let description: AST.StringLiteral | undefined;
    let scope: 'global' | 'transaction' = 'global';
    const predicates: AST.Expression[] = [];

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.kind === 'DESCRIPTION') {
        description = this.parseDescriptionField();
      } else if (token.kind === 'SCOPE') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        const scopeToken = this.currentToken().value;
        if (scopeToken === 'global' || scopeToken === 'transaction') {
          scope = scopeToken;
        }
        this.advance();
      } else if (token.kind === 'ALWAYS' || token.value === 'always') {
        this.advance();
        this.expect('LBRACE', "Expected '{'");
        while (!this.check('RBRACE') && !this.isAtEnd()) {
          predicates.push(this.parseBulletedExpression());
        }
        this.expect('RBRACE', "Expected '}'");
      } else {
        predicates.push(this.parseBulletedExpression());
      }
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'InvariantBlock',
      name,
      description,
      scope,
      predicates,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parsePolicy(): AST.Policy {
    const start = this.advance(); // consume 'policy'
    const name = this.parseIdentifier();
    this.expect('LBRACE', "Expected '{'");

    const appliesTo: AST.PolicyTarget = {
      kind: 'PolicyTarget',
      target: 'all',
      location: name.location,
    };
    const rules: AST.PolicyRule[] = [];

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.kind === 'APPLIES_TO' || token.value === 'applies_to') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        if (this.currentToken().value === 'all') {
          this.advance();
          if (this.currentToken().value === 'behaviors') {
            this.advance();
          }
        } else {
          const targets: AST.Identifier[] = [];
          while (!this.check('RULES') && !this.check('RBRACE') && !this.isAtEnd()) {
            targets.push(this.parseIdentifier());
            this.match('COMMA');
          }
          appliesTo.target = targets;
        }
      } else if (token.kind === 'RULES' || token.value === 'rules') {
        this.advance();
        this.expect('LBRACE', "Expected '{'");
        while (!this.check('RBRACE') && !this.isAtEnd()) {
          rules.push(this.parsePolicyRule());
        }
        this.expect('RBRACE', "Expected '}'");
      } else {
        throw unexpectedToken(token, 'policy member');
      }
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'Policy',
      name,
      appliesTo,
      rules,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parsePolicyRule(): AST.PolicyRule {
    const start = this.currentToken();
    let condition: AST.Expression | undefined;

    // Check for "default:" or condition
    if (this.check('DEFAULT') || this.currentToken().value === 'default') {
      this.advance();
    } else {
      condition = this.parseExpression();
    }

    this.expect('COLON', "Expected ':'");
    const action = this.parseExpression();

    return {
      kind: 'PolicyRule',
      condition,
      action,
      location: AST.mergeLocations(start.location, action.location),
    };
  }

  protected parseView(): AST.View {
    const start = this.advance(); // consume 'view'
    const name = this.parseIdentifier();
    this.expect('LBRACE', "Expected '{'");

    let forEntity: AST.ReferenceType | undefined;
    const fields: AST.ViewField[] = [];
    let consistency: AST.ConsistencySpec = {
      kind: 'ConsistencySpec',
      mode: 'eventual',
      location: name.location,
    };
    let cache: AST.CacheSpec | undefined;
    let display: string | undefined;

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.value === 'display' || token.value === 'ui') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        display = this.parseStringLiteral().value;
      } else if (token.kind === 'FOR' || token.value === 'for') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        const entityName = this.parseQualifiedName();
        forEntity = {
          kind: 'ReferenceType',
          name: entityName,
          location: entityName.location,
        };
      } else if (token.kind === 'FIELDS' || token.value === 'fields') {
        this.advance();
        this.expect('LBRACE', "Expected '{'");
        while (!this.check('RBRACE') && !this.isAtEnd()) {
          fields.push(this.parseViewField());
        }
        this.expect('RBRACE', "Expected '}'");
      } else if (token.kind === 'CONSISTENCY' || token.value === 'consistency') {
        this.advance();
        this.expect('LBRACE', "Expected '{'");
        consistency = this.parseConsistencySpec();
        this.expect('RBRACE', "Expected '}'");
      } else if (token.kind === 'CACHE' || token.value === 'cache') {
        this.advance();
        this.expect('LBRACE', "Expected '{'");
        cache = this.parseCacheSpec();
        this.expect('RBRACE', "Expected '}'");
      } else {
        throw unexpectedToken(token, 'view member');
      }
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'View',
      name,
      forEntity: forEntity ?? {
        kind: 'ReferenceType',
        name: { kind: 'QualifiedName', parts: [], location: name.location },
        location: name.location,
      },
      fields,
      consistency,
      cache,
      display,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseViewField(): AST.ViewField {
    const name = this.parseIdentifier();
    this.expect('COLON', "Expected ':'");
    const type = this.parseTypeDefinition();
    this.expect('ASSIGN', "Expected '='");
    const computation = this.parseExpression();

    return {
      kind: 'ViewField',
      name,
      type,
      computation,
      location: AST.mergeLocations(name.location, computation.location),
    };
  }

  // ============================================================================
  // AGGREGATES (first-class data-aggregate construct)
  // ============================================================================

  /**
   * Parse a first-class aggregate declaration:
   *
   *   aggregate <Name> {
   *     for: <Entity>
   *     measure: count | sum(<field>) | avg(<field>) | min(<field>) | max(<field>) [, ...]
   *     group_by: <field>?
   *     filter: <expr>?
   *   }
   *
   * `aggregate`, `measure`, `group_by` and `filter` are NOT reserved keywords — this
   * member is reached only via the identifier-valued dispatch in parseDomainMember,
   * so the grammar stays strictly additive.
   */
  protected parseAggregate(): AST.Aggregate {
    const start = this.advance(); // consume the 'aggregate' identifier
    const name = this.parseIdentifier();
    this.expect('LBRACE', "Expected '{'");

    let forEntity: AST.ReferenceType | undefined;
    const measures: AST.AggregateMeasure[] = [];
    let groupBy: AST.Identifier | undefined;
    let filter: AST.Expression | undefined;

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.kind === 'FOR' || token.value === 'for') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        const entityName = this.parseQualifiedName();
        forEntity = {
          kind: 'ReferenceType',
          name: entityName,
          location: entityName.location,
        };
      } else if (token.value === 'measure' || token.value === 'measures') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        // One or more comma-separated measures.
        measures.push(this.parseAggregateMeasure());
        while (this.match('COMMA')) {
          if (this.check('RBRACE')) break;
          measures.push(this.parseAggregateMeasure());
        }
      } else if (token.value === 'group_by') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        groupBy = this.parseIdentifier();
      } else if (token.value === 'filter') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        filter = this.parseExpression();
      } else {
        throw unexpectedToken(token, 'aggregate member');
      }
    }

    const end = this.expect('RBRACE', "Expected '}'");

    if (measures.length === 0) {
      this.errors.addError(
        `Aggregate '${name.name}' requires at least one measure`,
        ErrorCode.UNEXPECTED_TOKEN,
        AST.mergeLocations(start.location, end.location),
      );
    }

    return {
      kind: 'Aggregate',
      name,
      forEntity: forEntity ?? {
        kind: 'ReferenceType',
        name: { kind: 'QualifiedName', parts: [], location: name.location },
        location: name.location,
      },
      measures,
      groupBy,
      filter,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseForEntityRef(): AST.ReferenceType {
    const entityName = this.parseQualifiedName();
    return {
      kind: 'ReferenceType',
      name: entityName,
      location: entityName.location,
    };
  }

  /**
   * query Name { for: Entity filter: <expr>? filter_by: field, ... }
   * Soft keyword — only domain-level `query Name {` enters this path.
   */
  protected parseQuery(): AST.QueryDecl {
    const start = this.advance();
    const name = this.parseIdentifier();
    this.expect('LBRACE', "Expected '{'");

    let forEntity: AST.ReferenceType | undefined;
    let filter: AST.Expression | undefined;
    const filterBy: AST.Identifier[] = [];

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.kind === 'FOR' || token.value === 'for') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        forEntity = this.parseForEntityRef();
      } else if (token.value === 'filter') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        filter = this.parseExpression();
      } else if (token.value === 'filter_by') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        filterBy.push(this.parseIdentifier());
        while (this.match('COMMA')) {
          if (this.check('RBRACE')) break;
          filterBy.push(this.parseIdentifier());
        }
      } else {
        throw unexpectedToken(token, 'query member (for, filter, filter_by)');
      }
    }

    const end = this.expect('RBRACE', "Expected '}'");
    if (!forEntity) {
      this.errors.addError(
        `Query '${name.name}' requires for: <Entity>`,
        ErrorCode.UNEXPECTED_TOKEN,
        AST.mergeLocations(start.location, end.location),
      );
    }
    if (!filter && filterBy.length === 0) {
      this.errors.addError(
        `Query '${name.name}' requires filter: or filter_by:`,
        ErrorCode.UNEXPECTED_TOKEN,
        AST.mergeLocations(start.location, end.location),
      );
    }

    return {
      kind: 'QueryDecl',
      name,
      forEntity: forEntity ?? {
        kind: 'ReferenceType',
        name: { kind: 'QualifiedName', parts: [], location: name.location },
        location: name.location,
      },
      ...(filter === undefined ? {} : { filter }),
      filterBy,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  /**
   * job Name { for: Entity schedule: recurring cadence: weekly action: Behavior? }
   */
  protected parseJob(): AST.JobDecl {
    const start = this.advance();
    const name = this.parseIdentifier();
    this.expect('LBRACE', "Expected '{'");

    let forEntity: AST.ReferenceType | undefined;
    let schedule: AST.Identifier | undefined;
    let cadence: AST.Identifier | undefined;
    let action: AST.Identifier | undefined;

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.kind === 'FOR' || token.value === 'for') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        forEntity = this.parseForEntityRef();
      } else if (token.value === 'schedule') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        schedule = this.parseIdentifier();
      } else if (token.value === 'cadence') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        cadence = this.parseIdentifier();
      } else if (token.value === 'action') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        action = this.parseIdentifier();
      } else {
        throw unexpectedToken(token, 'job member (for, schedule, cadence, action)');
      }
    }

    const end = this.expect('RBRACE', "Expected '}'");
    if (!forEntity) {
      this.errors.addError(
        `Job '${name.name}' requires for: <Entity>`,
        ErrorCode.UNEXPECTED_TOKEN,
        AST.mergeLocations(start.location, end.location),
      );
    }
    if (!schedule) {
      this.errors.addError(
        `Job '${name.name}' requires schedule: recurring | once`,
        ErrorCode.UNEXPECTED_TOKEN,
        AST.mergeLocations(start.location, end.location),
      );
    }

    return {
      kind: 'JobDecl',
      name,
      forEntity: forEntity ?? {
        kind: 'ReferenceType',
        name: { kind: 'QualifiedName', parts: [], location: name.location },
        location: name.location,
      },
      schedule: schedule ?? { kind: 'Identifier', name: 'recurring', location: name.location },
      ...(cadence === undefined ? {} : { cadence }),
      ...(action === undefined ? {} : { action }),
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  /**
   * notification Name { for: Entity? to: role event: Event? }
   */
  protected parseNotification(): AST.NotificationDecl {
    const start = this.advance();
    const name = this.parseIdentifier();
    this.expect('LBRACE', "Expected '{'");

    let forEntity: AST.ReferenceType | undefined;
    let to: AST.Identifier | undefined;
    let event: AST.Identifier | undefined;

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.kind === 'FOR' || token.value === 'for') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        forEntity = this.parseForEntityRef();
      } else if (token.value === 'to') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        to = this.parseIdentifier();
      } else if (token.value === 'event') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        event = this.parseIdentifier();
      } else {
        throw unexpectedToken(token, 'notification member (for, to, event)');
      }
    }

    const end = this.expect('RBRACE', "Expected '}'");
    if (!to) {
      this.errors.addError(
        `Notification '${name.name}' requires to: <role>`,
        ErrorCode.UNEXPECTED_TOKEN,
        AST.mergeLocations(start.location, end.location),
      );
    }

    return {
      kind: 'NotificationDecl',
      name,
      ...(forEntity === undefined ? {} : { forEntity }),
      to: to ?? { kind: 'Identifier', name: 'staff', location: name.location },
      ...(event === undefined ? {} : { event }),
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  /**
   * Parse a double-entry money ledger:
   *
   *   ledger Wallet {
   *     account cash, user_balance, fees
   *     movement deposit  { debit: user_balance, credit: cash }
   *     movement withdraw { debit: cash,         credit: user_balance }
   *   }
   *
   * `account a, b, c` declares the named accounts (one or more `account` lines,
   * comma-separated). Each `movement m { debit: x, credit: y }` shifts value FROM
   * `credit` TO `debit`. Both endpoints must be declared accounts (validated in
   * codegen so a re-parse stays lossless).
   */
  protected parseLedger(): AST.LedgerDecl {
    const start = this.advance(); // consume the 'ledger' identifier
    const name = this.parseIdentifier();
    this.expect('LBRACE', "Expected '{'");

    const accounts: AST.Identifier[] = [];
    const movements: AST.LedgerMovement[] = [];

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.value === 'account' || token.value === 'accounts') {
        this.advance();
        accounts.push(this.parseIdentifier());
        while (this.match('COMMA')) {
          if (this.check('RBRACE')) break;
          accounts.push(this.parseIdentifier());
        }
      } else if (token.value === 'movement') {
        movements.push(this.parseLedgerMovement());
      } else {
        throw unexpectedToken(token, 'ledger member (account, movement)');
      }
    }

    const end = this.expect('RBRACE', "Expected '}'");

    if (accounts.length < 2) {
      this.errors.addError(
        `Ledger '${name.name}' requires at least two accounts`,
        ErrorCode.UNEXPECTED_TOKEN,
        AST.mergeLocations(start.location, end.location),
      );
    }
    if (movements.length === 0) {
      this.errors.addError(
        `Ledger '${name.name}' requires at least one movement`,
        ErrorCode.UNEXPECTED_TOKEN,
        AST.mergeLocations(start.location, end.location),
      );
    }

    return {
      kind: 'LedgerDecl',
      name,
      accounts,
      movements,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  /** Parse one movement: `movement m { debit: a, credit: b }`. */
  protected parseLedgerMovement(): AST.LedgerMovement {
    const start = this.advance(); // consume 'movement'
    const name = this.parseIdentifier();
    this.expect('LBRACE', "Expected '{'");

    let debit: AST.Identifier | undefined;
    let credit: AST.Identifier | undefined;

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const key = this.currentToken().value;
      if (key === 'debit') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        debit = this.parseIdentifier();
      } else if (key === 'credit') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        credit = this.parseIdentifier();
      } else {
        throw unexpectedToken(this.currentToken(), 'movement member (debit, credit)');
      }
      this.match('COMMA');
    }

    const end = this.expect('RBRACE', "Expected '}'");

    if (!debit || !credit) {
      this.errors.addError(
        `Movement '${name.name}' requires both a debit and a credit account`,
        ErrorCode.UNEXPECTED_TOKEN,
        AST.mergeLocations(start.location, end.location),
      );
    }
    const fallback = name; // keep a valid Identifier when a side is missing
    return {
      kind: 'LedgerMovement',
      name,
      debit: debit ?? fallback,
      credit: credit ?? fallback,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  /** Parse one measure: `count`, or `sum|avg|min|max(<field>)`. */
  protected parseAggregateMeasure(): AST.AggregateMeasure {
    const fnToken = this.currentToken();
    const fnName = fnToken.value.toLowerCase();
    const valid = ['count', 'sum', 'avg', 'min', 'max'];
    if (!valid.includes(fnName)) {
      throw unexpectedToken(fnToken, 'aggregate measure (count, sum, avg, min, max)');
    }
    this.advance();
    const fn = fnName as AST.AggregateMeasure['fn'];

    let field: AST.Identifier | undefined;
    // count may be bare (`count`) or take a field (`count(field)`); the others
    // require a field argument.
    if (this.check('LPAREN')) {
      this.advance();
      // Accept a bare field (`amount`) or a member access (`Entity.amount`); keep
      // only the trailing field name to match the view-aggregate lowering.
      const qn = this.parseQualifiedName();
      field = qn.parts[qn.parts.length - 1];
      this.expect('RPAREN', "Expected ')'");
    } else if (fn !== 'count') {
      throw expectedToken("'(' (measure requires a field)", this.currentToken());
    }

    return {
      kind: 'AggregateMeasure',
      fn,
      field,
      location: field ? AST.mergeLocations(fnToken.location, field.location) : fnToken.location,
    };
  }

  protected parseConsistencySpec(): AST.ConsistencySpec {
    const start = this.currentToken();
    let mode: 'strong' | 'eventual' = 'eventual';
    let maxDelay: AST.DurationLiteral | undefined;
    const strongFields: AST.Identifier[] = [];

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.kind === 'EVENTUAL' || token.value === 'eventual') {
        mode = 'eventual';
        this.advance();
        if (this.check('WITHIN') || this.currentToken().value === 'within') {
          this.advance();
          maxDelay = this.parseDurationLiteral();
        }
      } else if (token.kind === 'STRONG' || token.value === 'strong') {
        mode = 'strong';
        this.advance();
      } else if (token.kind === 'STRONGLY_CONSISTENT' || token.value === 'strongly_consistent') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        this.expect('LBRACKET', "Expected '['");
        while (!this.check('RBRACKET') && !this.isAtEnd()) {
          strongFields.push(this.parseIdentifier());
          this.match('COMMA');
        }
        this.expect('RBRACKET', "Expected ']'");
      } else {
        break;
      }
    }

    return {
      kind: 'ConsistencySpec',
      mode,
      maxDelay,
      strongFields: strongFields.length > 0 ? strongFields : undefined,
      location: start.location,
    };
  }

  protected parseCacheSpec(): AST.CacheSpec {
    const start = this.currentToken();
    let ttl: AST.DurationLiteral = {
      kind: 'DurationLiteral',
      value: 0,
      unit: 'seconds',
      location: start.location,
    };
    const invalidateOn: AST.Expression[] = [];

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.kind === 'TTL' || token.value === 'ttl') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        ttl = this.parseDurationLiteral();
      } else if (token.kind === 'INVALIDATE_ON' || token.value === 'invalidate_on') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        this.expect('LBRACKET', "Expected '['");
        while (!this.check('RBRACKET') && !this.isAtEnd()) {
          invalidateOn.push(this.parseExpression());
          this.match('COMMA');
        }
        this.expect('RBRACKET', "Expected ']'");
      } else {
        break;
      }
    }

    return {
      kind: 'CacheSpec',
      ttl,
      invalidateOn,
      location: start.location,
    };
  }

  // ============================================================================
  // SCENARIOS & CHAOS
  // ============================================================================

  protected parseScenarioBlock(): AST.ScenarioBlock {
    const start = this.advance(); // consume 'scenarios'
    const behaviorName = this.parseIdentifier();
    this.expect('LBRACE', "Expected '{'");

    const scenarios: AST.Scenario[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      scenarios.push(this.parseScenario());
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'ScenarioBlock',
      behaviorName,
      scenarios,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseScenario(): AST.Scenario {
    this.expect('SCENARIO', "Expected 'scenario'");
    const name = this.parseStringLiteral();
    this.expect('LBRACE', "Expected '{'");

    const given: AST.Statement[] = [];
    const when: AST.Statement[] = [];
    const then: AST.Expression[] = [];

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.kind === 'GIVEN' || token.value === 'given') {
        this.advance();
        this.expect('LBRACE', "Expected '{'");
        while (!this.check('RBRACE') && !this.isAtEnd()) {
          given.push(this.parseStatement());
        }
        this.expect('RBRACE', "Expected '}'");
      } else if (token.kind === 'WHEN') {
        this.advance();
        this.expect('LBRACE', "Expected '{'");
        while (!this.check('RBRACE') && !this.isAtEnd()) {
          when.push(this.parseStatement());
        }
        this.expect('RBRACE', "Expected '}'");
      } else if (token.kind === 'THEN') {
        this.advance();
        this.expect('LBRACE', "Expected '{'");
        while (!this.check('RBRACE') && !this.isAtEnd()) {
          then.push(this.parseExpression());
        }
        this.expect('RBRACE', "Expected '}'");
      } else {
        throw unexpectedToken(token, 'scenario block');
      }
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'Scenario',
      name,
      given,
      when,
      then,
      location: AST.mergeLocations(name.location, end.location),
    };
  }

  protected parseStandaloneScenario(): AST.ScenarioBlock {
    const start = this.currentToken();
    const scenario = this.parseScenario();

    return {
      kind: 'ScenarioBlock',
      behaviorName: { kind: 'Identifier', name: 'global', location: start.location },
      scenarios: [scenario],
      location: scenario.location,
    };
  }

  protected parseChaosBlock(): AST.ChaosBlock {
    const start = this.advance(); // consume 'chaos'
    const behaviorName = this.parseIdentifier();
    this.expect('LBRACE', "Expected '{'");

    const scenarios: AST.ChaosScenario[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      scenarios.push(this.parseChaosScenario());
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'ChaosBlock',
      behaviorName,
      scenarios,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseChaosScenario(): AST.ChaosScenario {
    // Accept both 'chaos' and 'scenario' keywords inside chaos blocks
    if (this.check('CHAOS')) {
      this.advance();
    } else if (this.check('SCENARIO')) {
      this.advance();
    } else {
      throw expectedToken("'chaos' or 'scenario'", this.currentToken());
    }

    const name = this.parseStringLiteral();
    this.expect('LBRACE', "Expected '{'");

    const inject: AST.Injection[] = [];
    const when: AST.Statement[] = [];
    const then: AST.Expression[] = [];
    const expectBlock: AST.ChaosExpectation[] = [];
    let withClause: AST.ChaosWithClause | undefined;

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.kind === 'INJECT' || token.value === 'inject') {
        this.advance(); // consume 'inject'
        if (this.check('LBRACE')) {
          // Old block syntax: inject { ... }
          this.advance(); // consume '{'
          while (!this.check('RBRACE') && !this.isAtEnd()) {
            inject.push(this.parseInjection());
          }
          this.expect('RBRACE', "Expected '}'");
        } else {
          // New inline syntax: inject <type> on <target> [with { ... }]
          inject.push(this.parseChaosInlineInjection());
        }
      } else if (token.kind === 'EXPECT' || token.value === 'expect') {
        this.advance(); // consume 'expect'
        this.expect('LBRACE', "Expected '{'");
        while (!this.check('RBRACE') && !this.isAtEnd()) {
          expectBlock.push(this.parseChaosExpectation());
        }
        this.expect('RBRACE', "Expected '}'");
      } else if (token.kind === 'WHEN') {
        this.advance();
        this.expect('LBRACE', "Expected '{'");
        while (!this.check('RBRACE') && !this.isAtEnd()) {
          when.push(this.parseStatement());
        }
        this.expect('RBRACE', "Expected '}'");
      } else if (token.kind === 'THEN') {
        this.advance();
        this.expect('LBRACE', "Expected '{'");
        while (!this.check('RBRACE') && !this.isAtEnd()) {
          then.push(this.parseExpression());
        }
        this.expect('RBRACE', "Expected '}'");
      } else if (token.kind === 'WITH' || token.value === 'with') {
        withClause = this.parseChaosWithClause();
      } else {
        throw unexpectedToken(token, 'chaos scenario block');
      }
    }

    const end = this.expect('RBRACE', "Expected '}'");

    // Populate granular ChaosInjection nodes for isl-core compatibility
    const injections: AST.ChaosInjection[] = inject.map((inj): AST.ChaosInjection => ({
      kind: 'ChaosInjection',
      type: {
        kind: 'Identifier',
        name: typeof inj.type === 'string' ? inj.type : 'database_failure',
        location: inj.location,
      },
      arguments: inj.parameters.map((p): AST.ChaosArgument => ({
        kind: 'ChaosArgument',
        name: p.name,
        value: p.value,
        location: p.location,
      })),
      location: inj.location,
    }));

    // Bridge: derive expectations from then expressions for backward compat
    const thenExpectations: AST.ChaosExpectation[] = then.map((expr): AST.ChaosExpectation => ({
      kind: 'ChaosExpectation',
      condition: expr,
      expression: expr,
      location: expr.location,
    }));

    // Merge direct expect-block expectations with then-derived expectations
    const expectations: AST.ChaosExpectation[] = [...expectBlock, ...thenExpectations];

    return {
      kind: 'ChaosScenario',
      name,
      inject,
      when,
      then,
      injections,
      expectations,
      withClause,
      withClauses: withClause ? [withClause] : [],
      location: AST.mergeLocations(name.location, end.location),
    };
  }

  /**
   * Parse inline chaos injection: inject <type> on <target> [with { key: value, ... }]
   * Called after 'inject' has been consumed.
   */
  protected parseChaosInlineInjection(): AST.Injection {
    const startLoc = this.previousToken().location; // location of consumed 'inject'

    const typeId = this.parseIdentifier();

    // Expect 'on' keyword
    if (this.check('ON') || this.currentToken().value === 'on') {
      this.advance();
    } else {
      throw expectedToken("'on'", this.currentToken());
    }

    const target = this.parseExpression();

    // Optional with { ... } clause for injection parameters
    const parameters: AST.InjectionParam[] = [];
    if (this.check('WITH') || this.currentToken().value === 'with') {
      this.advance(); // consume 'with'
      this.expect('LBRACE', "Expected '{'");
      while (!this.check('RBRACE') && !this.isAtEnd()) {
        const paramName = this.parseIdentifier();
        this.expect('COLON', "Expected ':'");
        const paramValue = this.parseExpression();
        parameters.push({
          kind: 'InjectionParam',
          name: paramName,
          value: paramValue,
          location: AST.mergeLocations(paramName.location, paramValue.location),
        });
        this.match('COMMA'); // optional trailing comma
      }
      this.expect('RBRACE', "Expected '}'");
    }

    return {
      kind: 'Injection',
      type: typeId.name as AST.InjectionType,
      target,
      parameters,
      location: AST.mergeLocations(startLoc, this.previousToken().location),
    };
  }

  /**
   * Parse a single expectation expression inside an expect { } block.
   */
  protected parseChaosExpectation(): AST.ChaosExpectation {
    const condition = this.parseExpression();

    // Optional description string after the condition expression
    let description: AST.StringLiteral | undefined;
    if (this.check('STRING_LITERAL')) {
      description = this.parseStringLiteral();
    }

    return {
      kind: 'ChaosExpectation',
      condition,
      description,
      expression: condition,
      location: description
        ? AST.mergeLocations(condition.location, description.location)
        : condition.location,
    };
  }

  /**
   * Parse scenario-level with { key: value, ... } clause → ChaosWithClause.
   */
  protected parseChaosWithClause(): AST.ChaosWithClause {
    const start = this.advance(); // consume 'with'
    this.expect('LBRACE', "Expected '{'");

    const args: AST.ChaosArgument[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      args.push(this.parseChaosArgument());
      this.match('COMMA'); // optional trailing comma
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'ChaosWithClause',
      args,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  /**
   * Parse a single key: value argument inside a with { } clause → ChaosArgument.
   */
  protected parseChaosArgument(): AST.ChaosArgument {
    const name = this.parseIdentifier();
    this.expect('COLON', "Expected ':'");
    const value = this.parseExpression();

    return {
      kind: 'ChaosArgument',
      name,
      value,
      location: AST.mergeLocations(name.location, value.location),
    };
  }

  // ============================================================================
  // FULL-STACK CONSTRUCTS
  // ============================================================================

  // --- API / ENDPOINTS ---

  protected parseApiBlock(): AST.ApiBlock {
    const start = this.advance(); // consume 'api'
    let name: AST.Identifier | undefined;
    let basePath: AST.StringLiteral | undefined;

    // Optional name
    if (this.check('IDENTIFIER')) {
      name = this.parseIdentifier();
    }

    this.expect('LBRACE', "Expected '{'");

    const endpoints: AST.EndpointDecl[] = [];
    const middleware: AST.Expression[] = [];

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.value === 'base' || token.value === 'basePath') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        basePath = this.parseStringLiteral();
      } else if (token.kind === 'MIDDLEWARE' || token.value === 'middleware') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        middleware.push(this.parseExpression());
      } else if (token.kind === 'ENDPOINT' || token.value === 'endpoint') {
        endpoints.push(this.parseEndpointDecl());
      } else if (
        token.kind === 'GET' ||
        token.kind === 'POST_METHOD' ||
        token.kind === 'PUT' ||
        token.kind === 'PATCH' ||
        token.kind === 'DELETE_METHOD' ||
        token.kind === 'WEBSOCKET'
      ) {
        endpoints.push(this.parseEndpointDecl());
      } else {
        throw unexpectedToken(token, 'api block member');
      }
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'ApiBlock',
      name,
      basePath,
      endpoints,
      middleware,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseEndpointDecl(): AST.EndpointDecl {
    const start = this.currentToken();

    // Consume optional 'endpoint' keyword
    if (this.check('ENDPOINT') || this.currentToken().value === 'endpoint') {
      this.advance();
    }

    // Parse HTTP method
    const methodToken = this.currentToken();
    let method: AST.EndpointDecl['method'] = 'GET';
    switch (methodToken.kind) {
      case 'GET':
        method = 'GET';
        this.advance();
        break;
      case 'POST_METHOD':
        method = 'POST';
        this.advance();
        break;
      case 'PUT':
        method = 'PUT';
        this.advance();
        break;
      case 'PATCH':
        method = 'PATCH';
        this.advance();
        break;
      case 'DELETE_METHOD':
        method = 'DELETE';
        this.advance();
        break;
      case 'WEBSOCKET':
        method = 'WEBSOCKET';
        this.advance();
        break;
      default:
        // Try value-based matching for case-insensitive
        if (methodToken.value === 'GET' || methodToken.value === 'get') {
          method = 'GET';
          this.advance();
        } else if (methodToken.value === 'POST' || methodToken.value === 'post') {
          method = 'POST';
          this.advance();
        } else if (methodToken.value === 'PUT' || methodToken.value === 'put') {
          method = 'PUT';
          this.advance();
        } else if (methodToken.value === 'PATCH' || methodToken.value === 'patch') {
          method = 'PATCH';
          this.advance();
        } else if (methodToken.value === 'DELETE' || methodToken.value === 'delete') {
          method = 'DELETE';
          this.advance();
        } else {
          throw unexpectedToken(methodToken, 'HTTP method');
        }
    }

    // Parse path
    const path = this.parseStringLiteral();

    // Optional -> BehaviorName
    let behavior: AST.Identifier | undefined;
    if (this.match('ARROW')) {
      behavior = this.parseIdentifier();
    }

    // Optional block with details
    let description: AST.StringLiteral | undefined;
    let auth: AST.Expression | undefined;
    const middlewareList: AST.Expression[] = [];
    const params: AST.Field[] = [];
    const headers: AST.Field[] = [];
    let body: AST.TypeDefinition | undefined;
    let response: AST.TypeDefinition | undefined;

    if (this.check('LBRACE')) {
      this.advance();
      while (!this.check('RBRACE') && !this.isAtEnd()) {
        const token = this.currentToken();
        if (token.kind === 'DESCRIPTION' || token.value === 'description') {
          description = this.parseDescriptionField();
        } else if (token.kind === 'AUTH' || token.value === 'auth') {
          this.advance();
          this.expect('COLON', "Expected ':'");
          auth = this.parseExpression();
        } else if (token.kind === 'MIDDLEWARE' || token.value === 'middleware') {
          this.advance();
          this.expect('COLON', "Expected ':'");
          middlewareList.push(this.parseExpression());
        } else if (token.kind === 'PARAMS' || token.value === 'params') {
          this.advance();
          this.expect('LBRACE', "Expected '{'");
          while (!this.check('RBRACE') && !this.isAtEnd()) {
            params.push(this.parseField());
          }
          this.expect('RBRACE', "Expected '}'");
        } else if (token.kind === 'HEADERS' || token.value === 'headers') {
          this.advance();
          this.expect('LBRACE', "Expected '{'");
          while (!this.check('RBRACE') && !this.isAtEnd()) {
            headers.push(this.parseField());
          }
          this.expect('RBRACE', "Expected '}'");
        } else if (token.kind === 'BODY' || token.value === 'body') {
          this.advance();
          this.expect('COLON', "Expected ':'");
          body = this.parseTypeDefinition();
        } else if (token.value === 'response') {
          this.advance();
          this.expect('COLON', "Expected ':'");
          response = this.parseTypeDefinition();
        } else {
          throw unexpectedToken(token, 'endpoint member');
        }
      }
      this.expect('RBRACE', "Expected '}'");
    }

    return {
      kind: 'EndpointDecl',
      method,
      path,
      behavior,
      description,
      auth,
      middleware: middlewareList,
      params,
      headers,
      body,
      response,
      location: AST.mergeLocations(start.location, this.previousToken().location),
    };
  }

  // --- STORAGE / PERSISTENCE ---

  protected parseStorageDecl(): AST.StorageDecl {
    const start = this.advance(); // consume 'storage'
    const entity = this.parseIdentifier();
    this.expect('LBRACE', "Expected '{'");

    let engine: AST.StringLiteral = {
      kind: 'StringLiteral',
      value: 'postgres',
      location: entity.location,
    };
    let table: AST.StringLiteral | undefined;
    let collection: AST.StringLiteral | undefined;
    const indexes: AST.IndexDecl[] = [];
    const migrations: AST.MigrationDecl[] = [];
    const seeds: AST.SeedDecl[] = [];

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.kind === 'ENGINE' || token.value === 'engine') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        engine = this.parseStringLiteral();
      } else if (token.kind === 'TABLE' || token.value === 'table') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        table = this.parseStringLiteral();
      } else if (token.kind === 'COLLECTION' || token.value === 'collection') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        collection = this.parseStringLiteral();
      } else if (token.kind === 'INDEXES' || token.value === 'indexes') {
        this.advance();
        this.expect('LBRACE', "Expected '{'");
        while (!this.check('RBRACE') && !this.isAtEnd()) {
          indexes.push(this.parseIndexDecl());
        }
        this.expect('RBRACE', "Expected '}'");
      } else if (token.kind === 'MIGRATIONS' || token.value === 'migrations') {
        this.advance();
        this.expect('LBRACE', "Expected '{'");
        while (!this.check('RBRACE') && !this.isAtEnd()) {
          migrations.push(this.parseMigrationDecl());
        }
        this.expect('RBRACE', "Expected '}'");
      } else if (token.kind === 'SEEDS' || token.value === 'seeds') {
        this.advance();
        this.expect('LBRACE', "Expected '{'");
        while (!this.check('RBRACE') && !this.isAtEnd()) {
          seeds.push(this.parseSeedDecl());
        }
        this.expect('RBRACE', "Expected '}'");
      } else {
        throw unexpectedToken(token, 'storage member');
      }
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'StorageDecl',
      entity,
      engine,
      table,
      collection,
      indexes,
      migrations,
      seeds,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseIndexDecl(): AST.IndexDecl {
    const fields: AST.Identifier[] = [];
    let unique = false;

    // Check for 'unique' prefix
    if (this.currentToken().value === 'unique') {
      unique = true;
      this.advance();
    }

    // Parse field name(s)
    fields.push(this.parseIdentifier());
    while (this.match('COMMA')) {
      fields.push(this.parseIdentifier());
    }

    return {
      kind: 'IndexDecl',
      fields,
      unique,
      location: fields[0]!.location,
    };
  }

  protected parseMigrationDecl(): AST.MigrationDecl {
    const version = this.parseStringLiteral();
    this.expect('LBRACE', "Expected '{'");

    let description: AST.StringLiteral | undefined;
    const up: AST.Expression[] = [];
    const down: AST.Expression[] = [];

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.kind === 'DESCRIPTION' || token.value === 'description') {
        description = this.parseDescriptionField();
      } else if (token.value === 'up') {
        this.advance();
        this.expect('LBRACE', "Expected '{'");
        while (!this.check('RBRACE') && !this.isAtEnd()) {
          up.push(this.parseBulletedExpression());
        }
        this.expect('RBRACE', "Expected '}'");
      } else if (token.value === 'down') {
        this.advance();
        this.expect('LBRACE', "Expected '{'");
        while (!this.check('RBRACE') && !this.isAtEnd()) {
          down.push(this.parseBulletedExpression());
        }
        this.expect('RBRACE', "Expected '}'");
      } else {
        throw unexpectedToken(token, 'migration member');
      }
    }

    this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'MigrationDecl',
      version,
      description,
      up,
      down,
      location: version.location,
    };
  }

  protected parseSeedDecl(): AST.SeedDecl {
    const name = this.parseStringLiteral();
    this.expect('LBRACE', "Expected '{'");

    const data: AST.Expression[] = [];
    while (!this.check('RBRACE') && !this.isAtEnd()) {
      data.push(this.parseBulletedExpression());
    }

    this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'SeedDecl',
      name,
      data,
      location: name.location,
    };
  }

  // --- WORKFLOWS ---

  protected parseWorkflowDecl(): AST.WorkflowDecl {
    const start = this.advance(); // consume 'workflow'
    const name = this.parseIdentifier();
    this.expect('LBRACE', "Expected '{'");

    let description: AST.StringLiteral | undefined;
    const steps: AST.WorkflowStep[] = [];
    let onFailure: AST.Expression | undefined;
    let timeout: AST.DurationLiteral | undefined;
    let input: AST.InputSpec | undefined;
    let stepOrder = 1;

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.kind === 'DESCRIPTION' || token.value === 'description') {
        description = this.parseDescriptionField();
      } else if (token.kind === 'INPUT' || token.value === 'input') {
        // Optional typed entry contract for the workflow (reuses the behavior input
        // parser) — the data a caller supplies, against which the DAG data-flow proof
        // checks each step's required inputs.
        input = this.parseInput();
      } else if (token.kind === 'STEP' || token.value === 'step') {
        this.advance();
        // Optional step number
        let order = stepOrder++;
        if (this.check('NUMBER_LITERAL')) {
          order = parseInt(this.advance().value, 10);
          this.match('COLON'); // optional colon after step number
        }
        const action = this.parseExpression();

        const step: AST.WorkflowStep = {
          kind: 'WorkflowStep',
          order,
          action,
          location: action.location,
        };

        // Optional step modifiers on same line or in block
        if (this.check('LBRACE')) {
          this.advance();
          while (!this.check('RBRACE') && !this.isAtEnd()) {
            const mod = this.currentToken();
            if (mod.kind === 'TIMEOUT' || mod.value === 'timeout') {
              this.advance();
              this.expect('COLON', "Expected ':'");
              step.timeout = this.parseDurationLiteral();
            } else if (mod.kind === 'RETRY' || mod.value === 'retry') {
              this.advance();
              this.expect('COLON', "Expected ':'");
              // Two forms: `retry: 3` (max attempts) or a config object
              // `retry: { strategy: EXPONENTIAL, maxRetries: 3 }`.
              if (this.check('LBRACE')) {
                const blkStart = this.advance(); // '{'
                let maxAttempts = 3;
                while (!this.check('RBRACE') && !this.isAtEnd()) {
                  const key = this.currentToken().value;
                  this.advance(); // key
                  this.match('COLON');
                  const valTok = this.currentToken();
                  const val = this.parseExpression();
                  if (key === 'maxRetries' || key === 'maxAttempts') {
                    const n = parseInt(valTok.value, 10);
                    if (!isNaN(n)) maxAttempts = n;
                  }
                  this.match('COMMA');
                }
                this.expect('RBRACE', "Expected '}'");
                step.retry = { kind: 'RetrySpec', maxAttempts, location: blkStart.location };
              } else {
                const maxAttempts = parseInt(this.advance().value, 10);
                step.retry = {
                  kind: 'RetrySpec',
                  maxAttempts: isNaN(maxAttempts) ? 3 : maxAttempts,
                  location: this.previousToken().location,
                };
              }
            } else if (mod.kind === 'ROLLBACK' || mod.value === 'rollback') {
              this.advance();
              this.expect('COLON', "Expected ':'");
              step.rollback = this.parseExpression();
            } else if (mod.kind === 'PARALLEL' || mod.value === 'parallel') {
              this.advance();
              step.parallel = true;
            } else if (mod.value === 'foreach') {
              this.advance();
              this.expect('COLON', "Expected ':'");
              step.foreach = this.parseExpression();
            } else if (mod.kind === 'AWAIT_KW' || mod.value === 'await') {
              this.advance();
              step.awaitCondition = this.parseExpression();
              if (this.check('WITHIN') || this.currentToken().value === 'within') {
                this.advance();
                step.awaitTimeout = this.parseDurationLiteral();
              }
            } else if (
              (mod.type === 'IDENTIFIER' || mod.type === 'KEYWORD') &&
              (mod.value === 'dependsOn' || mod.value === 'needs' || mod.value === 'after') &&
              this.peekNextToken()?.kind === 'COLON'
            ) {
              // Explicit DAG edges: `dependsOn: [1, 2]` (also `needs:` / `after:`) — the
              // step orders that must complete before this step runs. ≥2 ⇒ a join/merge.
              // Parsed as a list of step-order NUMBER literals (order is a step's identity),
              // collected onto step.dependsOn for the topological liveness proof + runner.
              this.advance(); // key
              this.advance(); // ':'
              const deps: number[] = [];
              const pushNum = (raw: string): void => {
                const n = parseInt(raw, 10);
                if (!isNaN(n) && !deps.includes(n)) deps.push(n);
              };
              if (this.check('LBRACKET')) {
                this.advance(); // '['
                while (!this.check('RBRACKET') && !this.isAtEnd()) {
                  if (this.check('NUMBER_LITERAL')) pushNum(this.advance().value);
                  else this.advance(); // tolerate/skip stray tokens (commas, etc.)
                }
                this.expect('RBRACKET', "Expected ']'");
              } else if (this.check('NUMBER_LITERAL')) {
                pushNum(this.advance().value);
              }
              if (deps.length > 0) step.dependsOn = deps;
            } else if (
              (mod.type === 'IDENTIFIER' || mod.type === 'KEYWORD') &&
              this.peekNextToken()?.kind === 'COLON'
            ) {
              // Tolerate additional `key: value` step modifiers (e.g. `condition:`)
              // — parse the value for well-formedness; map `condition` to the
              // step's await/guard condition, discard other forward-compat keys.
              const key = mod.value;
              this.advance(); // key
              this.advance(); // ':'
              const value = this.parseExpression();
              if (key === 'condition') step.awaitCondition = value;
            } else {
              throw unexpectedToken(mod, 'workflow step modifier');
            }
          }
          this.expect('RBRACE', "Expected '}'");
        }

        steps.push(step);
      } else if (token.kind === 'ON_FAILURE' || token.value === 'on_failure') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        onFailure = this.parseExpression();
      } else if (token.kind === 'TIMEOUT' || token.value === 'timeout') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        timeout = this.parseDurationLiteral();
      } else {
        throw unexpectedToken(token, 'workflow member');
      }
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'WorkflowDecl',
      name,
      description,
      steps,
      onFailure,
      timeout,
      input,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  // --- EVENTS ---

  protected parseEventDecl(): AST.EventDecl {
    const start = this.advance(); // consume 'event'
    const name = this.parseIdentifier();
    this.expect('LBRACE', "Expected '{'");

    let description: AST.StringLiteral | undefined;
    const payload: AST.Field[] = [];

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.kind === 'DESCRIPTION' || token.value === 'description') {
        description = this.parseDescriptionField();
      } else {
        payload.push(this.parseField());
      }
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'EventDecl',
      name,
      description,
      payload,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseHandlerDecl(): AST.HandlerDecl {
    const start = this.advance(); // consume 'handler'

    // Optional 'async' modifier
    let isAsync = false;
    if (this.check('ASYNC_KW') || this.currentToken().value === 'async') {
      isAsync = true;
      this.advance();
    }

    // Event name
    const event = this.parseIdentifier();

    // Optional -> handlerName
    let name: AST.Identifier | undefined;
    if (this.match('ARROW')) {
      name = this.parseIdentifier();
    }

    this.expect('LBRACE', "Expected '{'");

    // Parse action as expression
    const action = this.parseExpression();

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'HandlerDecl',
      event,
      name,
      action,
      async: isAsync,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  // --- SCREENS / UI ---

  protected parseScreenDecl(): AST.ScreenDecl {
    const start = this.advance(); // consume 'screen'
    const name = this.parseIdentifier();
    this.expect('LBRACE', "Expected '{'");

    let description: AST.StringLiteral | undefined;
    let route: AST.StringLiteral | undefined;
    let layout: AST.Identifier | undefined;
    const components: AST.ComponentDecl[] = [];
    const navigation: AST.NavigationDecl[] = [];
    let audience: AST.Identifier | undefined;
    let authentication: AST.Identifier | undefined;
    let visibility: AST.Identifier | undefined;
    let contextEntity: AST.Identifier | undefined;
    let allowedActions: AST.Identifier[] | undefined;

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.kind === 'DESCRIPTION' || token.value === 'description') {
        description = this.parseDescriptionField();
      } else if (token.value === 'route') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        route = this.parseStringLiteral();
      } else if (token.kind === 'LAYOUT' || token.value === 'layout') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        layout = this.parseIdentifier();
      } else if (token.value === 'audience') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        audience = this.parseIdentifier();
      } else if (token.value === 'authentication') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        authentication = this.parseIdentifier();
      } else if (token.value === 'visibility') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        visibility = this.parseIdentifier();
      } else if (token.value === 'entity' || token.value === 'context') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        contextEntity = this.parseIdentifier();
      } else if (token.value === 'allowed_actions' || token.value === 'allowedActions') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        allowedActions = this.parseIdentifierSet();
      } else if (token.kind === 'COMPONENT' || token.value === 'component') {
        components.push(this.parseComponentDecl());
      } else if (token.kind === 'FORM' || token.value === 'form') {
        components.push(this.parseFormComponent());
      } else if (token.kind === 'NAVIGATION' || token.value === 'navigation') {
        this.advance();
        this.expect('LBRACE', "Expected '{'");
        while (!this.check('RBRACE') && !this.isAtEnd()) {
          navigation.push(this.parseNavigationDecl());
        }
        this.expect('RBRACE', "Expected '}'");
      } else {
        throw unexpectedToken(token, 'screen member');
      }
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'ScreenDecl',
      name,
      description,
      route,
      layout,
      components,
      navigation,
      ...(audience === undefined ? {} : { audience }),
      ...(authentication === undefined ? {} : { authentication }),
      ...(visibility === undefined ? {} : { visibility }),
      ...(contextEntity === undefined ? {} : { contextEntity }),
      ...(allowedActions === undefined || allowedActions.length === 0 ? {} : { allowedActions }),
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseComponentDecl(): AST.ComponentDecl {
    this.advance(); // consume 'component'
    const name = this.parseIdentifier();
    this.expect('LBRACE', "Expected '{'");

    let type: AST.ComponentDecl['type'] = 'custom';
    let behavior: AST.Identifier | undefined;
    let entity: AST.Identifier | undefined;
    const fields: AST.ScreenFieldDecl[] = [];
    let submit: AST.StringLiteral | undefined;
    const actions: AST.Expression[] = [];

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.kind === 'TYPE' || token.value === 'type') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        type = this.advance().value as AST.ComponentDecl['type'];
      } else if (token.kind === 'BEHAVIOR' || token.value === 'behavior') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        behavior = this.parseIdentifier();
      } else if (token.kind === 'ENTITY' || token.value === 'entity') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        entity = this.parseIdentifier();
      } else if (token.kind === 'FIELDS' || token.value === 'fields') {
        this.advance();
        this.expect('LBRACE', "Expected '{'");
        while (!this.check('RBRACE') && !this.isAtEnd()) {
          fields.push(this.parseScreenFieldDecl());
        }
        this.expect('RBRACE', "Expected '}'");
      } else if (token.kind === 'SUBMIT' || token.value === 'submit') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        submit = this.parseStringLiteral();
      } else {
        throw unexpectedToken(token, 'component member');
      }
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'ComponentDecl',
      name,
      type,
      behavior,
      entity,
      fields,
      submit,
      actions,
      location: AST.mergeLocations(name.location, end.location),
    };
  }

  protected parseFormComponent(): AST.ComponentDecl {
    const start = this.advance(); // consume 'form'
    const name = this.parseIdentifier();

    // Optional -> BehaviorName
    let behavior: AST.Identifier | undefined;
    if (this.match('ARROW')) {
      behavior = this.parseIdentifier();
    }

    this.expect('LBRACE', "Expected '{'");

    const fields: AST.ScreenFieldDecl[] = [];
    let submit: AST.StringLiteral | undefined;

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      const token = this.currentToken();
      if (token.kind === 'SUBMIT' || token.value === 'submit') {
        this.advance();
        this.expect('COLON', "Expected ':'");
        submit = this.parseStringLiteral();
      } else {
        fields.push(this.parseScreenFieldDecl());
      }
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'ComponentDecl',
      name,
      type: 'form',
      behavior,
      fields,
      submit,
      actions: [],
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseScreenFieldDecl(): AST.ScreenFieldDecl {
    const name = this.parseIdentifier();
    this.expect('COLON', "Expected ':'");

    let inputType: AST.StringLiteral | undefined;
    let label: AST.StringLiteral | undefined;
    let validation: AST.Expression | undefined;
    let required: boolean | undefined;

    // Parse field type or properties
    if (this.check('STRING_LITERAL')) {
      inputType = this.parseStringLiteral();
    } else if (this.check('IDENTIFIER') || this.check('STRING_TYPE') || this.check('INT_TYPE')) {
      inputType = {
        kind: 'StringLiteral',
        value: this.advance().value,
        location: this.previousToken().location,
      };
    }

    // Optional annotations in brackets
    if (this.check('LBRACKET')) {
      this.advance();
      while (!this.check('RBRACKET') && !this.isAtEnd()) {
        const annot = this.currentToken();
        if (annot.value === 'required') {
          required = true;
          this.advance();
        } else if (annot.value === 'label') {
          this.advance();
          this.expect('COLON', "Expected ':'");
          label = this.parseStringLiteral();
        } else if (annot.value === 'validate' || annot.kind === 'VALIDATE') {
          this.advance();
          this.expect('COLON', "Expected ':'");
          validation = this.parseExpression();
        } else {
          this.advance(); // skip unknown annotations
        }
        this.match('COMMA');
      }
      this.expect('RBRACKET', "Expected ']'");
    }

    return {
      kind: 'ScreenFieldDecl',
      name,
      inputType,
      label,
      validation,
      required,
      location: name.location,
    };
  }

  protected parseNavigationDecl(): AST.NavigationDecl {
    const label = this.parseStringLiteral();
    this.expect('ARROW', "Expected '->'");

    let target: AST.Identifier | AST.StringLiteral;
    if (this.check('STRING_LITERAL')) {
      target = this.parseStringLiteral();
    } else {
      target = this.parseIdentifier();
    }

    return {
      kind: 'NavigationDecl',
      label,
      target,
      location: label.location,
    };
  }

  // --- CONFIG / ENVIRONMENT ---

  protected parseConfigBlock(): AST.ConfigBlock {
    const start = this.advance(); // consume 'config'

    let name: AST.Identifier | undefined;
    if (this.check('IDENTIFIER')) {
      name = this.parseIdentifier();
    }

    this.expect('LBRACE', "Expected '{'");

    const entries: AST.ConfigEntry[] = [];

    while (!this.check('RBRACE') && !this.isAtEnd()) {
      entries.push(this.parseConfigEntry());
    }

    const end = this.expect('RBRACE', "Expected '}'");

    return {
      kind: 'ConfigBlock',
      name,
      entries,
      location: AST.mergeLocations(start.location, end.location),
    };
  }

  protected parseConfigEntry(): AST.ConfigEntry {
    const key = this.parseIdentifier();
    this.expect('COLON', "Expected ':'");

    // Parse source: env("VAR"), secret("VAR"), or literal default
    let source: AST.ConfigEntry['source'] = 'default';
    let reference: AST.StringLiteral;
    let defaultValue: AST.Expression | undefined;
    let required = true;

    const token = this.currentToken();
    if (token.kind === 'ENV' || token.value === 'env') {
      source = 'env';
      this.advance();
      this.expect('LPAREN', "Expected '('");
      reference = this.parseStringLiteral();
      this.expect('RPAREN', "Expected ')'");
    } else if (token.kind === 'SECRET' || token.value === 'secret') {
      source = 'secret';
      this.advance();
      this.expect('LPAREN', "Expected '('");
      reference = this.parseStringLiteral();
      this.expect('RPAREN', "Expected ')'");
    } else if (token.kind === 'STRING_LITERAL') {
      source = 'default';
      reference = this.parseStringLiteral();
      required = false;
    } else {
      // Non-string default literal (number / boolean / enum value), e.g.
      // `snapshot_threshold: 50` or `enable_compression: true`. Capture it as the
      // defaultValue expression; `reference` carries an empty placeholder.
      source = 'default';
      const value = this.parseExpression();
      reference = { kind: 'StringLiteral', value: '', location: value.location };
      defaultValue = value;
      required = false;
    }

    // Optional default value
    if (this.match('ASSIGN')) {
      defaultValue = this.parseExpression();
      required = false;
    }

    // Optional [required] annotation
    if (this.check('LBRACKET')) {
      this.advance();
      if (this.currentToken().value === 'required') {
        required = true;
        this.advance();
      } else if (this.currentToken().value === 'optional') {
        required = false;
        this.advance();
      }
      this.expect('RBRACKET', "Expected ']'");
    }

    return {
      kind: 'ConfigEntry',
      key,
      source,
      reference,
      defaultValue,
      required,
      location: key.location,
    };
  }

  protected parseInjection(): AST.Injection {
    const start = this.currentToken();
    const typeExpr = this.parseExpression();

    // Extract injection type from call expression
    let injectionType: AST.InjectionType = 'database_failure';
    const parameters: AST.InjectionParam[] = [];

    if (typeExpr.kind === 'CallExpr') {
      const callee = typeExpr.callee;
      if (callee.kind === 'Identifier') {
        injectionType = callee.name as AST.InjectionType;
      }
      // Parse arguments as parameters
      for (const arg of typeExpr.arguments) {
        if (arg.kind === 'BinaryExpr' && arg.operator === '==') {
          // key: value style
        }
      }
    }

    return {
      kind: 'Injection',
      type: injectionType,
      target: typeExpr,
      parameters,
      location: AST.mergeLocations(start.location, typeExpr.location),
    };
  }

  protected parseStatement(): AST.Statement {
    const start = this.currentToken();

    // Check for assignment: identifier = expression
    // Note: identifiers can be IDENTIFIER type or KEYWORD type (for reserved words used as names)
    const tokenType = this.currentToken().type;
    if (
      (tokenType === 'IDENTIFIER' || tokenType === 'KEYWORD') &&
      this.peekNextToken()?.kind === 'ASSIGN'
    ) {
      const target = this.parseIdentifier();
      this.expect('ASSIGN', "Expected '='");
      const value = this.parseExpression();

      return {
        kind: 'AssignmentStmt',
        target,
        value,
        location: AST.mergeLocations(start.location, value.location),
      };
    }

    // Otherwise it's a call statement
    const expr = this.parseExpression();
    if (expr.kind === 'CallExpr') {
      return {
        kind: 'CallStmt',
        call: expr,
        location: expr.location,
      };
    }

    // Wrap non-call expressions in call statement
    return {
      kind: 'CallStmt',
      call: {
        kind: 'CallExpr',
        callee: expr,
        arguments: [],
        location: expr.location,
      },
      location: expr.location,
    };
  }

  // ============================================================================
  // EXPRESSIONS
  // ============================================================================
}
