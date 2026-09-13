// ============================================================================
// ISL Parser Fuzz Harness
//
// Hardens parser against malicious inputs:
// - No hangs (timeout protection)
// - No OOM (size limits)
// - Graceful errors (no crashes)
// ============================================================================

import { parse, type ParseResult } from './index.js';

/**
 * Performance guards for parser fuzzing
 */
export interface ParserFuzzLimits {
  /** Maximum file size in bytes (default: 1MB) */
  maxFileSize: number;

  /** Maximum number of tokens (default: 100k) */
  maxTokens: number;

  /** Maximum parse depth (default: 1000) */
  maxDepth: number;

  /** Timeout per parse in milliseconds (default: 5s) */
  timeoutMs: number;

  /** Maximum string literal length (default: 100k chars) */
  maxStringLength: number;

  /** Maximum identifier length (default: 10k chars) */
  maxIdentifierLength: number;
}

export const DEFAULT_FUZZ_LIMITS: ParserFuzzLimits = {
  maxFileSize: 1024 * 1024, // 1MB
  maxTokens: 100_000,
  maxDepth: 1000,
  timeoutMs: 5000,
  maxStringLength: 100_000,
  maxIdentifierLength: 10_000,
};

/**
 * Fuzz result for a single input
 */
export interface FuzzParseResult {
  /** Input that was tested */
  input: string;

  /** Whether parsing completed without crashing */
  completed: boolean;

  /** Whether parsing timed out */
  timedOut: boolean;

  /** Whether input exceeded size limits */
  exceededLimits: boolean;

  /** Parse result (if completed) */
  parseResult?: ParseResult;

  /** Error message (if crashed) */
  error?: string;

  /** Stack trace (if crashed) */
  stack?: string;

  /** Duration in milliseconds */
  duration: number;

  /** Input size in bytes */
  inputSize: number;

  /** Number of tokens (if lexed successfully) */
  tokenCount?: number;
}

/**
 * Fuzz the parser with a single input
 */
export async function fuzzParse(
  input: string,
  limits: ParserFuzzLimits = DEFAULT_FUZZ_LIMITS,
): Promise<FuzzParseResult> {
  const startTime = Date.now();
  const inputSize = new TextEncoder().encode(input).length;

  // Check size limits upfront
  if (inputSize > limits.maxFileSize) {
    return {
      input: input.slice(0, 100) + '...',
      completed: false,
      timedOut: false,
      exceededLimits: true,
      duration: Date.now() - startTime,
      inputSize,
    };
  }

  // Check for suspiciously long strings/identifiers
  if (hasExcessiveLengths(input, limits)) {
    return {
      input: input.slice(0, 100) + '...',
      completed: false,
      timedOut: false,
      exceededLimits: true,
      duration: Date.now() - startTime,
      inputSize,
    };
  }

  let parseResult: ParseResult | undefined;
  let error: string | undefined;
  let stack: string | undefined;
  let timedOut = false;
  let completed = false;
  let tokenCount: number | undefined;

  try {
    // Run with timeout
    const result = await Promise.race([
      Promise.resolve(parse(input)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Parse timeout')), limits.timeoutMs),
      ),
    ]);

    parseResult = result;
    completed = true;

    // Count tokens if parsing succeeded
    if (result.tokens) {
      tokenCount = result.tokens.length;

      // Check token limit
      if (tokenCount > limits.maxTokens) {
        return {
          input: input.slice(0, 100) + '...',
          completed: false,
          timedOut: false,
          exceededLimits: true,
          duration: Date.now() - startTime,
          inputSize,
          tokenCount,
        };
      }
    }
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === 'Parse timeout') {
        timedOut = true;
      } else {
        error = err.message;
        stack = err.stack;
      }
    } else {
      error = String(err);
    }
  }

  return {
    input: input.length > 200 ? input.slice(0, 200) + '...' : input,
    completed,
    timedOut,
    exceededLimits: false,
    parseResult,
    error,
    stack,
    duration: Date.now() - startTime,
    inputSize,
    tokenCount,
  };
}

/**
 * Check if input has excessively long strings or identifiers
 */
function hasExcessiveLengths(input: string, limits: ParserFuzzLimits): boolean {
  // Check for very long string literals
  const stringRegex = /(["'])(?:(?=(\\?))\2.)*?\1/g;
  let match;
  while ((match = stringRegex.exec(input)) !== null) {
    if (match[0]!.length > limits.maxStringLength) {
      return true;
    }
  }

  // Check for very long identifiers (sequences of alphanumeric/underscore)
  const identifierRegex = /\b[a-zA-Z_][a-zA-Z0-9_]{1000,}\b/g;
  if (identifierRegex.test(input)) {
    return true;
  }

  return false;
}

/**
 * Batch fuzz multiple inputs
 */
export async function batchFuzzParse(
  inputs: string[],
  limits: ParserFuzzLimits = DEFAULT_FUZZ_LIMITS,
  onProgress?: (result: FuzzParseResult, index: number, total: number) => void,
): Promise<FuzzParseResult[]> {
  const results: FuzzParseResult[] = [];

  for (let i = 0; i < inputs.length; i++) {
    const result = await fuzzParse(inputs[i]!, limits);
    results.push(result);

    if (onProgress) {
      onProgress(result, i, inputs.length);
    }
  }

  return results;
}

/**
 * Generate fuzz report from results
 */
export interface FuzzReport {
  total: number;
  completed: number;
  timedOut: number;
  exceededLimits: number;
  crashed: number;
  passed: number;
  failed: number;
  crashes: Array<{
    input: string;
    error: string;
    stack?: string;
    duration: number;
  }>;
  hangs: Array<{
    input: string;
    duration: number;
  }>;
  limitViolations: Array<{
    input: string;
    reason: string;
  }>;
}

export function generateFuzzReport(results: FuzzParseResult[]): FuzzReport {
  const report: FuzzReport = {
    total: results.length,
    completed: 0,
    timedOut: 0,
    exceededLimits: 0,
    crashed: 0,
    passed: 0,
    failed: 0,
    crashes: [],
    hangs: [],
    limitViolations: [],
  };

  for (const result of results) {
    if (result.exceededLimits) {
      report.exceededLimits++;
      report.limitViolations.push({
        input: result.input,
        reason:
          result.inputSize > DEFAULT_FUZZ_LIMITS.maxFileSize
            ? 'File size exceeded'
            : 'String/identifier length exceeded',
      });
    } else if (result.timedOut) {
      report.timedOut++;
      report.hangs.push({
        input: result.input,
        duration: result.duration,
      });
    } else if (result.completed) {
      report.completed++;
      if (result.parseResult?.success) {
        report.passed++;
      } else {
        report.failed++;
      }
    } else if (result.error) {
      report.crashed++;
      report.crashes.push({
        input: result.input,
        error: result.error,
        stack: result.stack,
        duration: result.duration,
      });
    }
  }

  return report;
}
