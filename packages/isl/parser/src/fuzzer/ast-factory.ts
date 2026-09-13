/**
 * Tiny AST constructors. Locations are synthetic — unparse ignores them;
 * the parser re-emits real ones on the round-trip.
 */

import type {
  Annotation,
  BooleanLiteral,
  Expression,
  Field,
  Identifier,
  NullLiteral,
  NumberLiteral,
  PrimitiveType,
  QualifiedName,
  ReferenceType,
  SourceLocation,
  StringLiteral,
  TypeDefinition,
} from '../ast.js';

export const FUZZ_LOC: SourceLocation = {
  file: '<fuzz>',
  line: 1,
  column: 1,
  endLine: 1,
  endColumn: 1,
};

export function ident(name: string): Identifier {
  return { kind: 'Identifier', name, location: FUZZ_LOC };
}

export function str(value: string): StringLiteral {
  return { kind: 'StringLiteral', value, location: FUZZ_LOC };
}

export function num(value: number, isFloat = !Number.isInteger(value)): NumberLiteral {
  return { kind: 'NumberLiteral', value, isFloat, location: FUZZ_LOC };
}

export function bool(value: boolean): BooleanLiteral {
  return { kind: 'BooleanLiteral', value, location: FUZZ_LOC };
}

export function nul(): NullLiteral {
  return { kind: 'NullLiteral', location: FUZZ_LOC };
}

export function primitive(name: PrimitiveType['name']): PrimitiveType {
  return { kind: 'PrimitiveType', name, location: FUZZ_LOC };
}

export function refType(name: string): ReferenceType {
  return {
    kind: 'ReferenceType',
    name: qname(name),
    location: FUZZ_LOC,
  };
}

export function qname(dotted: string): QualifiedName {
  return {
    kind: 'QualifiedName',
    parts: dotted.split('.').map(ident),
    location: FUZZ_LOC,
  };
}

export function field(
  name: string,
  type: TypeDefinition,
  opts: { optional?: boolean; annotations?: Annotation[]; defaultValue?: Expression } = {},
): Field {
  return {
    kind: 'Field',
    name: ident(name),
    type,
    optional: opts.optional ?? false,
    annotations: opts.annotations ?? [],
    defaultValue: opts.defaultValue,
    location: FUZZ_LOC,
  };
}

export function annot(name: string, value?: Expression): Annotation {
  return {
    kind: 'Annotation',
    name: ident(name),
    value,
    location: FUZZ_LOC,
  };
}

export const PARSER_PRIMITIVES: readonly PrimitiveType['name'][] = [
  'String',
  'Int',
  'Decimal',
  'Boolean',
  'Timestamp',
  'UUID',
  'Duration',
  'Date',
  'Money',
  'File',
];

/** Extra scalars codegen accepts; emitted as ReferenceType so the RD parser keeps them. */
export const EXTENDED_SCALARS = ['Float', 'Text', 'JSON'] as const;

export type ScalarName = PrimitiveType['name'] | (typeof EXTENDED_SCALARS)[number];

export function scalarType(name: ScalarName): TypeDefinition {
  if ((PARSER_PRIMITIVES as readonly string[]).includes(name)) {
    return primitive(name as PrimitiveType['name']);
  }
  return refType(name);
}

export function isNumericScalar(name: string): boolean {
  return name === 'Int' || name === 'Decimal' || name === 'Float' || name === 'Duration';
}

export function isBooleanScalar(name: string): boolean {
  return name === 'Boolean';
}
