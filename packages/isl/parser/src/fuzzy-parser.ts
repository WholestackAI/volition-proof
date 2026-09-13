// ============================================================================
// ISL Fuzzy Parser Mode
// ============================================================================
//
// Wraps the strict parser with:
// - Pre-processing pass that normalizes common AI-generated patterns
// - Error recovery: on parse failure, skip failing blocks, collect as PartialNode
// - Returns FuzzyParseResult with ast, errors, warnings, coverage
//
// ============================================================================

import type { SourceLocation } from './ast.js';
import type { Domain } from './ast.js';
import type { Diagnostic } from './errors.js';
import { parse, type ParseResult } from './parser.js';

// ============================================================================
// Types
// ============================================================================

export interface ParseWarning {
  code: string;
  message: string;
  location: SourceLocation;
  /** What was normalized (e.g. "string | number" -> "String | Int") */
  suggestion?: string;
}

export interface PartialNode {
  kind: 'PartialNode';
  rawText: string;
  error: {
    message: string;
    code: string;
    location: SourceLocation;
  };
  /** Approximate block type (entity, behavior, etc.) if detectable */
  blockKind?: string;
}

export interface FuzzyParseResult {
  /** Parsed AST (partial or full). May have _partialNodes for failed blocks. */
  ast: Domain | null;
  errors: Diagnostic[];
  warnings: ParseWarning[];
  /** Partial nodes for blocks that failed to parse */
  partialNodes: PartialNode[];
  /** Fraction of input successfully parsed (0-1) */
  coverage: number;
  /** Whether the full parse succeeded without recovery */
  success: boolean;
}

// ============================================================================
// Pre-processing: Normalize AI-generated patterns
// ============================================================================

interface PreprocessResult {
  normalized: string;
  warnings: ParseWarning[];
}

function preprocessSource(source: string, filename: string): PreprocessResult {
  const warnings: ParseWarning[] = [];
  let normalized = source;

  // 1. Add missing version: field if domain has no version
  const domainMatch = normalized.match(/domain\s+(\w+)\s*\{/);
  if (domainMatch) {
    const afterBrace = normalized.indexOf('{', normalized.indexOf(domainMatch[0]!)) + 1;
    const domainBody = normalized.slice(afterBrace);
    if (!/^\s*version\s*[:"]/m.test(domainBody) && !/^\s*version\s+/m.test(domainBody)) {
      const insertPos = normalized.indexOf('{', normalized.indexOf(domainMatch[0]!)) + 1;
      normalized =
        normalized.slice(0, insertPos) + '\n  version: "1.0.0"\n' + normalized.slice(insertPos);
      warnings.push({
        code: 'F001',
        message: 'Added missing version field (default: "1.0.0")',
        location: { file: filename, line: 1, column: 1, endLine: 1, endColumn: 1 },
        suggestion: 'Add version: "x.y.z" explicitly',
      });
    }
  }

  // 2. Normalize union type shorthands: string | number -> String | Int, etc.
  const typeShorthands: Array<{ from: RegExp; to: string; name: string }> = [
    { from: /\bstring\b(?=[\s|}\],)]|$)/g, to: 'String', name: 'string' },
    { from: /\bnumber\b(?=[\s|}\],)]|$)/g, to: 'Int', name: 'number' },
    { from: /\bboolean\b(?=[\s|}\],)]|$)/g, to: 'Boolean', name: 'boolean' },
    { from: /\bobject\b(?=[\s|}\],)]|$)/g, to: 'Struct', name: 'object' },
  ];
  for (const { from, to, name } of typeShorthands) {
    const matches = normalized.match(from);
    if (matches) {
      normalized = normalized.replace(from, to);
      warnings.push({
        code: 'F002',
        message: `Normalized type shorthand: ${name} -> ${to}`,
        location: { file: filename, line: 1, column: 1, endLine: 1, endColumn: 1 },
        suggestion: `Use ISL primitive: ${to}`,
      });
    }
  }

  // 3. Convert inline [format: email] annotations to constraint block format
  //    email: String [format: email] -> email: String { format: "email" }
  normalized = normalized.replace(
    /(\w+)\s*:\s*(\w+)\s*\[\s*format\s*:\s*(\w+)\s*\]/g,
    (_, fieldName, typeName, format) => {
      warnings.push({
        code: 'F003',
        message: `Normalized inline annotation [format: ${format}] to constraint block`,
        location: { file: filename, line: 1, column: 1, endLine: 1, endColumn: 1 },
        suggestion: `Use { format: "${format}" } constraint`,
      });
      return `${fieldName}: ${typeName} { format: "${format}" }`;
    },
  );

  // 4. Remove commas between members (strict ISL lists fields on newlines without commas — common AI mistake)
  normalized = normalized.replace(/,(\s*\n\s*)(?=[a-zA-Z_]\w*\s*:|\})/g, '$1');

  // 5. Remove trailing commas before } or )
  normalized = normalized.replace(/,(\s*[}\]])/g, '$1');

  // 6. Normalize inconsistent indentation (tabs to 2 spaces)
  const lines = normalized.split('\n');
  const hasTabs = lines.some((l) => l.startsWith('\t'));
  if (hasTabs) {
    normalized = lines.map((l) => l.replace(/^\t+/, (m) => '  '.repeat(m.length))).join('\n');
    warnings.push({
      code: 'F004',
      message: 'Normalized tabs to spaces',
      location: { file: filename, line: 1, column: 1, endLine: 1, endColumn: 1 },
    });
  }

  return { normalized, warnings };
}

// ============================================================================
// Block extraction for error recovery
// ============================================================================

const DOMAIN_MEMBER_KEYWORDS = [
  'version',
  'owner',
  'use',
  'imports',
  'import',
  'type',
  'enum',
  'entity',
  'behavior',
  'invariants',
  'policy',
  'view',
  'scenarios',
  'scenario',
  'chaos',
  'api',
  'storage',
  'workflow',
  'event',
  'handler',
  'screen',
  'config',
];

interface ExtractedBlock {
  kind: string;
  start: number;
  end: number;
  text: string;
  line: number;
}

function extractBlocks(source: string): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = [];
  const domainMatch = source.match(/domain\s+(\w+)\s*\{/);
  if (!domainMatch) return blocks;

  const domainStart = source.indexOf(domainMatch[0]!);
  const bodyStart = source.indexOf('{', domainStart) + 1;
  const body = source.slice(bodyStart);

  let pos = 0;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();
    const lineStart = pos;

    for (const kw of DOMAIN_MEMBER_KEYWORDS) {
      const kwRegex = new RegExp(`^${kw}\\s|^${kw}\\s*[=:{]`);
      if (kwRegex.test(trimmed)) {
        const blockStart = bodyStart + lineStart;
        const blockText = extractBlockBody(source, blockStart);
        if (blockText) {
          blocks.push({
            kind: kw,
            start: blockStart,
            end: blockStart + blockText.length,
            text: blockText,
            line: i + 2,
          });
        }
        break;
      }
    }
    pos += line.length + 1;
  }

  return blocks;
}

/** Extract a single block (matching braces) from source starting at pos */
function extractBlockBody(source: string, start: number): string | null {
  const segment = source.slice(start);
  const open = segment.indexOf('{');

  if (open === -1) {
    const eq = segment.indexOf('=');
    const colon = segment.indexOf(':');
    const nl = segment.indexOf('\n');
    const end = nl === -1 ? segment.length : nl;
    if (eq !== -1 || colon !== -1) {
      return segment.slice(0, end).trim();
    }
    return null;
  }

  let depth = 1;
  let i = open + 1;
  while (i < segment.length && depth > 0) {
    const c = segment[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return segment.slice(0, i);
}
// ============================================================================
// Error recovery: parse blocks individually
// ============================================================================

function tryParseBlock(block: string, filename: string): ParseResult {
  const wrapped = `domain __FuzzyTemp__ { version: "1.0.0" ${block} }`;
  return parse(wrapped, filename);
}

function getLineColumn(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset);
  const lines = before.split('\n');
  return {
    line: lines.length,
    column: (lines[lines.length - 1] ?? '').length + 1,
  };
}

// ============================================================================
// Main Fuzzy Parse
// ============================================================================

/**
 * Parse ISL with fuzzy mode: pre-processing + error recovery.
 * Use for AI-generated or loosely-formatted ISL.
 */
export function parseFuzzy(source: string, filename: string = '<input>'): FuzzyParseResult {
  const allWarnings: ParseWarning[] = [];
  const allErrors: Diagnostic[] = [];
  const partialNodes: PartialNode[] = [];

  // 1. Pre-process
  const { normalized, warnings } = preprocessSource(source, filename);
  allWarnings.push(...warnings);

  // 2. Try strict parse first
  const strictResult = parse(normalized, filename);

  if (strictResult.success && strictResult.domain) {
    return {
      ast: strictResult.domain,
      errors: strictResult.errors,
      warnings: allWarnings,
      partialNodes: [],
      coverage: 1,
      success: true,
    };
  }

  // 3. Error recovery: block-by-block parsing
  const totalChars = source.length;
  let parsedChars = 0;

  const domainMatch = normalized.match(/domain\s+(\w+)\s*\{/);
  if (!domainMatch) {
    return {
      ast: null,
      errors: strictResult.errors,
      warnings: allWarnings,
      partialNodes: [],
      coverage: 0,
      success: false,
    };
  }

  const domainName = domainMatch[1]!;
  const blocks = extractBlocks(normalized);

  // Build minimal domain and try parsing each member
  const emptyDomain: Domain = {
    kind: 'Domain',
    name: {
      kind: 'Identifier',
      name: domainName,
      location: { file: filename, line: 1, column: 1, endLine: 1, endColumn: 1 },
    },
    version: {
      kind: 'StringLiteral',
      value: '1.0.0',
      location: { file: filename, line: 1, column: 1, endLine: 1, endColumn: 1 },
    },
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
    apis: [],
    storage: [],
    workflows: [],
    events: [],
    handlers: [],
    screens: [],
    location: { file: filename, line: 1, column: 1, endLine: 1, endColumn: 1 },
  };

  for (const block of blocks) {
    const blockResult = tryParseBlock(block.text, filename);
    if (blockResult.success && blockResult.domain) {
      const d = blockResult.domain;
      parsedChars += block.text.length;
      if (d.entities.length) emptyDomain.entities.push(...d.entities);
      if (d.behaviors.length) emptyDomain.behaviors.push(...d.behaviors);
      if (d.types.length) emptyDomain.types.push(...d.types);
      if (d.invariants.length) emptyDomain.invariants.push(...d.invariants);
      if (d.policies.length) emptyDomain.policies.push(...d.policies);
      if (d.views.length) emptyDomain.views.push(...d.views);
      if (d.scenarios.length) emptyDomain.scenarios.push(...d.scenarios);
      if (d.chaos.length) emptyDomain.chaos.push(...d.chaos);
      if (d.imports.length) emptyDomain.imports.push(...d.imports);
      if (d.uses.length) emptyDomain.uses.push(...d.uses);
      if (d.version.value) emptyDomain.version = d.version;
      if (d.owner) emptyDomain.owner = d.owner;
    } else {
      const loc = getLineColumn(normalized, block.start);
      partialNodes.push({
        kind: 'PartialNode',
        rawText: block.text,
        error: {
          message: blockResult.errors[0]?.message ?? 'Parse failed',
          code: blockResult.errors[0]?.code ?? 'P001',
          location: {
            file: filename,
            line: loc.line,
            column: loc.column,
            endLine: loc.line,
            endColumn: loc.column + block.text.length,
          },
        },
        blockKind: block.kind,
      });
      allErrors.push(...blockResult.errors);
    }
  }

  const coverage = totalChars > 0 ? Math.min(1, parsedChars / totalChars) : 0;

  return {
    ast: emptyDomain,
    errors: allErrors.length > 0 ? allErrors : strictResult.errors,
    warnings: allWarnings,
    partialNodes,
    coverage,
    success:
      partialNodes.length === 0 &&
      (emptyDomain.entities.length > 0 ||
        emptyDomain.behaviors.length > 0 ||
        emptyDomain.types.length > 0),
  };
}
