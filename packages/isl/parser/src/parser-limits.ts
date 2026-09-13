// ============================================================================
// Parser Performance Guards
//
// Enforces limits to prevent hangs, OOM, and excessive resource usage
// ============================================================================

/**
 * Parser limits configuration
 */
export interface ParserLimits {
  /** Maximum file size in bytes */
  maxFileSize: number;

  /** Maximum number of tokens */
  maxTokens: number;

  /** Maximum parse depth (recursion depth) */
  maxDepth: number;

  /** Maximum string literal length */
  maxStringLength: number;

  /** Maximum identifier length */
  maxIdentifierLength: number;

  /** Enable limits (set to false to disable for trusted inputs) */
  enabled: boolean;
}

export const DEFAULT_PARSER_LIMITS: ParserLimits = {
  maxFileSize: 10 * 1024 * 1024, // 10MB (more lenient for normal use)
  maxTokens: 1_000_000,
  maxDepth: 10_000,
  maxStringLength: 1_000_000,
  maxIdentifierLength: 100_000,
  enabled: true,
};

/**
 * Parser limit violation error
 */
export class ParserLimitError extends Error {
  constructor(
    public readonly limit: keyof ParserLimits,
    public readonly value: number,
    public readonly max: number,
    message?: string,
  ) {
    super(message ?? `Parser limit exceeded: ${limit} = ${value} (max: ${max})`);
    this.name = 'ParserLimitError';
  }
}

/**
 * Check if input exceeds limits
 */
export function checkParserLimits(
  input: string,
  limits: ParserLimits = DEFAULT_PARSER_LIMITS,
): void {
  if (!limits.enabled) {
    return;
  }

  const size = new TextEncoder().encode(input).length;
  if (size > limits.maxFileSize) {
    throw new ParserLimitError(
      'maxFileSize',
      size,
      limits.maxFileSize,
      `Input size ${size} bytes exceeds maximum ${limits.maxFileSize} bytes`,
    );
  }

  // Check for excessively long strings
  const stringRegex = /(["'])(?:(?=(\\?))\2.)*?\1/g;
  let match;
  while ((match = stringRegex.exec(input)) !== null) {
    const strLength = match[0]!.length - 2; // Exclude quotes
    if (strLength > limits.maxStringLength) {
      throw new ParserLimitError(
        'maxStringLength',
        strLength,
        limits.maxStringLength,
        `String literal length ${strLength} exceeds maximum ${limits.maxStringLength}`,
      );
    }
  }

  // Check for excessively long identifiers
  const identifierRegex = /\b[a-zA-Z_][a-zA-Z0-9_]{1000,}\b/g;
  if (identifierRegex.test(input)) {
    throw new ParserLimitError(
      'maxIdentifierLength',
      -1,
      limits.maxIdentifierLength,
      'Identifier length exceeds maximum',
    );
  }
}
