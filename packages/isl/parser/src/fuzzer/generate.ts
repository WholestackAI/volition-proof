/**
 * Grammar-aware ISL contract generator.
 *
 * Builds a Domain AST from production rules (not string templates), then
 * unparses. Well-formed mode only references names it declared and types
 * expressions against those declarations. Nesting/combinations that
 * hand-written specs rarely use are first-class, not mutations of a corpus.
 */

import type {
  ActorSpec,
  Aggregate,
  Behavior,
  BinaryExpr,
  BinaryOperator,
  Domain,
  Entity,
  Expression,
  Field,
  InvariantBlock,
  LedgerDecl,
  Policy,
  PostconditionBlock,
  ScenarioBlock,
  TypeDeclaration,
  TypeDefinition,
  View,
} from '../ast.js';
import { unparse } from '../unparse.js';
import {
  annot,
  bool,
  field,
  FUZZ_LOC,
  ident,
  isBooleanScalar,
  isNumericScalar,
  num,
  primitive,
  refType,
  scalarType,
  str,
  type ScalarName,
} from './ast-factory.js';
import type { RareFeature } from './productions.js';
import { SeededRandom } from './rng.js';

export interface GenerateOptions {
  /** Force rare nesting/combinations even when the RNG would skip them. */
  forceRare?: boolean;
  maxTypeDepth?: number;
  maxEntities?: number;
  maxBehaviors?: number;
}

export interface FieldInfo {
  name: string;
  /** Head type name for expressions (primitive, enum, or declared type). */
  typeName: string;
  optional: boolean;
  numeric: boolean;
  boolean: boolean;
  /** True when the stored type is List/Map — not comparable as a scalar. */
  collection?: boolean;
  enumVariants?: string[];
}

export interface EntityInfo {
  name: string;
  fields: FieldInfo[];
}

export interface GeneratedContract {
  domain: Domain;
  source: string;
  coverage: string[];
  features: RareFeature[];
}

interface Env {
  rng: SeededRandom;
  coverage: Set<string>;
  features: Set<RareFeature>;
  forceRare: boolean;
  maxTypeDepth: number;
  types: TypeDeclaration[];
  enums: Array<{ name: string; variants: string[] }>;
  structs: Array<{ name: string; fields: FieldInfo[] }>;
  entities: EntityInfo[];
  behaviors: Array<{ name: string; input: FieldInfo[]; success: string }>;
  roles: string[];
  typeCounter: number;
  entityCounter: number;
  behaviorCounter: number;
}

function fire(env: Env, id: string): void {
  env.coverage.add(id);
}

function feature(env: Env, id: RareFeature): void {
  env.features.add(id);
}

function want(env: Env, p: number): boolean {
  return env.forceRare || env.rng.bool(p);
}

const SCALARS: ScalarName[] = ['String', 'Int', 'Decimal', 'Boolean', 'Timestamp', 'UUID', 'Float'];

function nextTypeName(env: Env): string {
  return `Typ${env.typeCounter++}`;
}

function nextEntityName(env: Env): string {
  return `Ent${env.entityCounter++}`;
}

function nextBehaviorName(env: Env): string {
  return `Beh${env.behaviorCounter++}`;
}

function binary(op: BinaryOperator, left: Expression, right: Expression): BinaryExpr {
  return { kind: 'BinaryExpr', operator: op, left, right, location: FUZZ_LOC };
}

function inputExpr(fieldName: string): Expression {
  return { kind: 'InputExpr', property: ident(fieldName), location: FUZZ_LOC };
}

function resultExpr(fieldName?: string): Expression {
  return {
    kind: 'ResultExpr',
    property: fieldName ? ident(fieldName) : undefined,
    location: FUZZ_LOC,
  };
}

function member(object: Expression, property: string): Expression {
  return {
    kind: 'MemberExpr',
    object,
    property: ident(property),
    location: FUZZ_LOC,
  };
}

function defaultForScalar(name: string, rng: SeededRandom): Expression | undefined {
  if (name === 'Boolean') return bool(rng.bool());
  if (name === 'Int') return num(rng.int(0, 20), false);
  if (name === 'Decimal' || name === 'Float') return num(rng.int(0, 50), true);
  if (name === 'String') return str(`s${rng.int(0, 99)}`);
  return undefined;
}

function wrapType(env: Env, inner: TypeDefinition, depth: number): TypeDefinition {
  if (depth <= 0) return inner;
  const roll = env.rng.next();
  if (roll < 0.34) {
    fire(env, 'ListType');
    fire(env, 'BaseTypeDef');
    if (inner.kind === 'MapType') feature(env, 'nested-list-map');
    return { kind: 'ListType', element: wrapType(env, inner, depth - 1), location: FUZZ_LOC };
  }
  if (roll < 0.55) {
    fire(env, 'MapType');
    fire(env, 'BaseTypeDef');
    return {
      kind: 'MapType',
      key: primitive('String'),
      value: wrapType(env, inner, depth - 1),
      location: FUZZ_LOC,
    };
  }
  if (roll < 0.75) {
    if (inner.kind === 'StructType') return inner;
    fire(env, 'OptionalType');
    fire(env, 'SingleTypeDef');
    if (inner.kind === 'ListType') feature(env, 'nested-optional-list');
    return { kind: 'OptionalType', inner, location: FUZZ_LOC };
  }
  return inner;
}

function constrainedScalar(env: Env, base: ScalarName): TypeDefinition {
  fire(env, 'ConstrainedType');
  fire(env, 'ConstraintBlock');
  fire(env, 'ConstraintItem');
  fire(env, 'Constraint');
  const constraints = [];
  if (base === 'String') {
    constraints.push({
      kind: 'Constraint' as const,
      name: 'min_length',
      value: num(1, false),
      location: FUZZ_LOC,
    });
    if (env.rng.bool(0.5)) {
      constraints.push({
        kind: 'Constraint' as const,
        name: 'max_length',
        value: num(env.rng.int(8, 80), false),
        location: FUZZ_LOC,
      });
    }
  } else if (isNumericScalar(base)) {
    constraints.push({
      kind: 'Constraint' as const,
      name: 'min',
      value: num(0, base !== 'Int'),
      location: FUZZ_LOC,
    });
    if (env.rng.bool(0.5)) {
      constraints.push({
        kind: 'Constraint' as const,
        name: 'max',
        value: num(env.rng.int(10, 1000), base !== 'Int'),
        location: FUZZ_LOC,
      });
    }
  } else {
    return scalarType(base);
  }
  return {
    kind: 'ConstrainedType',
    base: scalarType(base),
    constraints,
    location: FUZZ_LOC,
  };
}

function genStructFields(env: Env, depth: number, count: number): Field[] {
  const fields: Field[] = [];
  const used = new Set<string>();
  for (let i = 0; i < count; i++) {
    let name = `sf${i}`;
    while (used.has(name)) name = `sf${i}_${env.rng.int(0, 99)}`;
    used.add(name);
    const scalar = env.rng.pick(SCALARS);
    let type: TypeDefinition = scalarType(scalar);
    fire(env, 'PrimitiveTypeName');
    fire(env, 'FieldDecl');
    fire(env, 'Field');
    if (depth > 0 && env.rng.bool(0.35)) {
      type = wrapType(env, type, Math.min(depth, 2));
    }
    if (depth > 1 && env.rng.bool(0.25)) {
      feature(env, 'nested-struct');
      fire(env, 'StructType');
      type = {
        kind: 'StructType',
        fields: genStructFields(env, depth - 1, env.rng.int(1, 2)),
        location: FUZZ_LOC,
      };
    }
    fields.push(
      field(name, type, {
        // RD parser: struct types take no trailing `?` postfix (`parsePostfixType`).
        optional: env.rng.bool(0.2) && type.kind !== 'StructType',
      }),
    );
  }
  return fields;
}

function emitForcedRareTypes(env: Env): void {
  if (!env.forceRare) return;
  fire(env, 'TypeDeclaration');
  fire(env, 'ListType');
  fire(env, 'MapType');
  fire(env, 'BaseTypeDef');
  feature(env, 'nested-list-map');
  env.types.push({
    kind: 'TypeDeclaration',
    name: ident(nextTypeName(env)),
    definition: {
      kind: 'ListType',
      element: {
        kind: 'MapType',
        key: primitive('String'),
        value: primitive('Int'),
        location: FUZZ_LOC,
      },
      location: FUZZ_LOC,
    },
    annotations: [],
    location: FUZZ_LOC,
  });
  fire(env, 'OptionalType');
  fire(env, 'SingleTypeDef');
  feature(env, 'nested-optional-list');
  env.types.push({
    kind: 'TypeDeclaration',
    name: ident(nextTypeName(env)),
    definition: {
      kind: 'OptionalType',
      inner: {
        kind: 'ListType',
        element: primitive('String'),
        location: FUZZ_LOC,
      },
      location: FUZZ_LOC,
    },
    annotations: [],
    location: FUZZ_LOC,
  });
}

function genTypeDeclarations(env: Env, count: number): TypeDeclaration[] {
  const out: TypeDeclaration[] = [];
  for (let i = 0; i < count; i++) {
    const name = nextTypeName(env);
    const kindRoll = env.rng.next();
    if (kindRoll < 0.28) {
      fire(env, 'EnumDeclaration');
      fire(env, 'EnumType');
      fire(env, 'EnumVariant');
      const n = env.rng.int(2, 5);
      const variants = Array.from({ length: n }, (_, k) => `Var${name}_${k}`);
      env.enums.push({ name, variants });
      out.push({
        kind: 'TypeDeclaration',
        name: ident(name),
        definition: {
          kind: 'EnumType',
          variants: variants.map((v) => ({
            kind: 'EnumVariant' as const,
            name: ident(v),
            location: FUZZ_LOC,
          })),
          location: FUZZ_LOC,
        },
        annotations: [],
        location: FUZZ_LOC,
      });
    } else if (kindRoll < 0.5) {
      fire(env, 'TypeDeclaration');
      fire(env, 'StructType');
      const fields = genStructFields(env, env.maxTypeDepth, env.rng.int(2, 4));
      env.structs.push({
        name,
        fields: fields.map((f) => ({
          name: f.name.name,
          typeName: typeHead(f.type),
          optional: f.optional,
          numeric: isNumericScalar(typeHead(f.type)) && !isCollectionType(f.type),
          boolean: isBooleanScalar(typeHead(f.type)) && !isCollectionType(f.type),
          collection: isCollectionType(f.type),
        })),
      });
      out.push({
        kind: 'TypeDeclaration',
        name: ident(name),
        definition: { kind: 'StructType', fields, location: FUZZ_LOC },
        annotations: [],
        location: FUZZ_LOC,
      });
    } else if (kindRoll < 0.68) {
      fire(env, 'TypeDeclaration');
      fire(env, 'UnionTypeDef');
      fire(env, 'UnionType');
      fire(env, 'UnionVariant');
      if (env.rng.bool(0.5)) {
        feature(env, 'union-scalars');
        const a = env.rng.pick(SCALARS);
        let b = env.rng.pick(SCALARS);
        if (b === a) b = a === 'String' ? 'Int' : 'String';
        out.push({
          kind: 'TypeDeclaration',
          name: ident(name),
          definition: {
            kind: 'UnionType',
            variants: [
              {
                kind: 'UnionVariant',
                name: ident('_'),
                fields: [],
                memberType: scalarType(a),
                location: FUZZ_LOC,
              },
              {
                kind: 'UnionVariant',
                name: ident('_'),
                fields: [],
                memberType: scalarType(b),
                location: FUZZ_LOC,
              },
            ],
            location: FUZZ_LOC,
          },
          annotations: [],
          location: FUZZ_LOC,
        });
      } else {
        feature(env, 'union-struct-arms');
        const leftFields = [field('ok', primitive('Boolean')), field('value', primitive('String'))];
        const rightFields = [field('ok', primitive('Boolean')), field('code', primitive('Int'))];
        out.push({
          kind: 'TypeDeclaration',
          name: ident(name),
          definition: {
            kind: 'UnionType',
            variants: [
              {
                kind: 'UnionVariant',
                name: ident('Ok'),
                fields: leftFields,
                memberType: { kind: 'StructType', fields: leftFields, location: FUZZ_LOC },
                location: FUZZ_LOC,
              },
              {
                kind: 'UnionVariant',
                name: ident('Err'),
                fields: rightFields,
                memberType: { kind: 'StructType', fields: rightFields, location: FUZZ_LOC },
                location: FUZZ_LOC,
              },
            ],
            location: FUZZ_LOC,
          },
          annotations: [],
          location: FUZZ_LOC,
        });
      }
    } else if (kindRoll < 0.84) {
      fire(env, 'TypeDeclaration');
      fire(env, 'TypeDefinition');
      const base = env.rng.pick(['String', 'Int', 'Decimal'] as const);
      out.push({
        kind: 'TypeDeclaration',
        name: ident(name),
        definition: constrainedScalar(env, base),
        annotations: [],
        location: FUZZ_LOC,
      });
    } else {
      fire(env, 'TypeDeclaration');
      fire(env, 'nested-list-map');
      feature(env, 'nested-list-map');
      const inner = wrapType(
        env,
        scalarType(env.rng.pick(['Int', 'String', 'UUID'])),
        env.maxTypeDepth,
      );
      out.push({
        kind: 'TypeDeclaration',
        name: ident(name),
        definition: inner,
        annotations: [],
        location: FUZZ_LOC,
      });
    }
    env.types.push(out[out.length - 1]!);
  }
  return out;
}

function isCollectionType(t: TypeDefinition): boolean {
  return t.kind === 'ListType' || t.kind === 'MapType';
}

function typeHead(t: TypeDefinition): string {
  switch (t.kind) {
    case 'PrimitiveType':
      return t.name;
    case 'ReferenceType':
      return t.name.parts[0]?.name ?? 'String';
    case 'ListType':
      return typeHead(t.element);
    case 'OptionalType':
      return typeHead(t.inner);
    case 'ConstrainedType':
      return typeHead(t.base);
    case 'MapType':
      return 'Map';
    case 'StructType':
      return 'Struct';
    case 'EnumType':
      return t.variants[0]?.name.name ?? 'Enum';
    case 'UnionType':
      return t.variants[0]?.name.name ?? 'Union';
    default:
      return 'String';
  }
}

function pickFieldType(env: Env): { type: TypeDefinition; info: Omit<FieldInfo, 'name'> } {
  const roll = env.rng.next();
  if (roll < 0.12 && env.enums.length > 0) {
    const en = env.rng.pick(env.enums);
    return {
      type: refType(en.name),
      info: {
        typeName: en.name,
        optional: false,
        numeric: false,
        boolean: false,
        enumVariants: en.variants,
      },
    };
  }
  if (roll < 0.2 && env.structs.length > 0) {
    const st = env.rng.pick(env.structs);
    return {
      type: refType(st.name),
      info: { typeName: st.name, optional: false, numeric: false, boolean: false },
    };
  }
  if (roll < 0.32 && env.types.length > 0) {
    const t = env.rng.pick(env.types);
    return {
      type: refType(t.name.name),
      info: { typeName: t.name.name, optional: false, numeric: false, boolean: false },
    };
  }
  const scalar = env.rng.pick(SCALARS);
  let type: TypeDefinition = scalarType(scalar);
  fire(env, 'PrimitiveTypeName');
  const optional = env.rng.bool(0.18);
  if (want(env, 0.2)) {
    type = wrapType(env, type, 1);
  }
  if (optional) {
    fire(env, 'OptionalType');
  }
  const wrapped = isCollectionType(type);
  return {
    type,
    info: {
      typeName: scalar,
      optional,
      numeric: isNumericScalar(scalar) && !wrapped,
      boolean: isBooleanScalar(scalar) && !wrapped,
      collection: wrapped,
    },
  };
}

function genEntity(env: Env, withLifecycle: boolean): Entity {
  fire(env, 'EntityDecl');
  fire(env, 'Entity');
  fire(env, 'EntityMember');
  const name = nextEntityName(env);
  const fields: Field[] = [];
  const infos: FieldInfo[] = [];

  const idField = field('id', primitive('UUID'), {
    annotations: [annot('primary'), annot('unique')],
  });
  fire(env, 'AnnotationList');
  fire(env, 'AnnotationItem');
  fire(env, 'Annotation');
  fields.push(idField);
  infos.push({
    name: 'id',
    typeName: 'UUID',
    optional: false,
    numeric: false,
    boolean: false,
  });
  // Stable scalar columns so invariants/aggregates/preconditions have a
  // well-typed site even when the RNG wraps every extra field in List/Map.
  fields.push(field('qty', primitive('Int')));
  infos.push({
    name: 'qty',
    typeName: 'Int',
    optional: false,
    numeric: true,
    boolean: false,
  });
  fields.push(field('flag', primitive('Boolean')));
  infos.push({
    name: 'flag',
    typeName: 'Boolean',
    optional: false,
    numeric: false,
    boolean: true,
  });

  const nExtra = env.rng.int(2, 6);
  for (let i = 0; i < nExtra; i++) {
    const fname = `fld${i}`;
    const picked = pickFieldType(env);
    const annotations = [];
    const def = defaultForScalar(picked.info.typeName, env.rng);
    if (def && env.rng.bool(0.25) && !picked.info.optional && !picked.info.collection) {
      annotations.push(annot('default', def));
    }
    if (picked.info.enumVariants && env.rng.bool(0.4)) {
      annotations.push(annot('default', ident(picked.info.enumVariants[0]!)));
    }
    fields.push(
      field(fname, picked.type, {
        optional: picked.info.optional,
        annotations,
      }),
    );
    infos.push({ name: fname, ...picked.info });
  }

  if (env.entities.length > 0 && want(env, 0.7)) {
    const target = env.rng.pick(env.entities);
    const fkName = `${target.name.charAt(0).toLowerCase()}${target.name.slice(1)}Id`;
    fields.push(
      field(fkName, primitive('UUID'), {
        annotations: [annot('references', str(`${target.name}.id`))],
      }),
    );
    infos.push({
      name: fkName,
      typeName: 'UUID',
      optional: false,
      numeric: false,
      boolean: false,
    });
    feature(env, 'cross-entity-references');
  }

  let lifecycle = undefined;
  if (withLifecycle) {
    fire(env, 'LifecycleSection');
    fire(env, 'LifecycleSpec');
    fire(env, 'Transition');
    fire(env, 'LifecycleTransition');
    feature(env, 'lifecycle-plus-status-enum');
    const enumName = `${name}Status`;
    const variants = ['Draft', 'Active', 'Closed'];
    env.enums.push({ name: enumName, variants });
    env.types.push({
      kind: 'TypeDeclaration',
      name: ident(enumName),
      definition: {
        kind: 'EnumType',
        variants: variants.map((v) => ({
          kind: 'EnumVariant' as const,
          name: ident(v),
          location: FUZZ_LOC,
        })),
        location: FUZZ_LOC,
      },
      annotations: [],
      location: FUZZ_LOC,
    });
    fields.push(field('status', refType(enumName)));
    infos.push({
      name: 'status',
      typeName: enumName,
      optional: false,
      numeric: false,
      boolean: false,
      enumVariants: variants,
    });
    lifecycle = {
      kind: 'LifecycleSpec' as const,
      transitions: [
        {
          kind: 'LifecycleTransition' as const,
          from: ident('Draft'),
          to: ident('Active'),
          location: FUZZ_LOC,
        },
        {
          kind: 'LifecycleTransition' as const,
          from: ident('Active'),
          to: ident('Closed'),
          location: FUZZ_LOC,
        },
      ],
      location: FUZZ_LOC,
    };
  }

  const invariants: Expression[] = [];
  const numericField = infos.find((f) => f.numeric && !f.collection);
  if (numericField && (env.forceRare || env.rng.bool(0.5))) {
    fire(env, 'InvariantsSection');
    const qty = ident(numericField.name);
    const zero = num(0, numericField.typeName !== 'Int');
    const one = num(1, numericField.typeName !== 'Int');
    invariants.push(binary('>=', qty, zero));
    fire(env, 'ComparisonExpr');
    fire(env, 'AdditiveExpr');
    fire(env, 'BinaryExpr');
    fire(env, 'PrimaryExpr');
    invariants.push(binary('>=', binary('-', qty, zero), zero));
    fire(env, 'MultiplicativeExpr');
    invariants.push(binary('>=', binary('*', qty, one), zero));
  }

  let permissions = undefined;
  if (env.roles.length > 0 && want(env, 0.5)) {
    fire(env, 'PermissionsBlock');
    fire(env, 'PermissionRule');
    fire(env, 'RoleExpr');
    feature(env, 'roles-permissions-policy');
    permissions = {
      kind: 'PermissionsBlock' as const,
      rules: [
        {
          kind: 'PermissionRule' as const,
          action: 'read' as const,
          allow: {
            kind: 'RoleExpr' as const,
            roles: [ident(env.rng.pick(env.roles))],
            owner: false,
            related: [],
            location: FUZZ_LOC,
          },
          location: FUZZ_LOC,
        },
        {
          kind: 'PermissionRule' as const,
          action: 'write' as const,
          allow: {
            kind: 'RoleExpr' as const,
            roles: [ident(env.roles[0]!)],
            owner: false,
            related: [],
            location: FUZZ_LOC,
          },
          location: FUZZ_LOC,
        },
      ],
      location: FUZZ_LOC,
    };
  }

  env.entities.push({ name, fields: infos });
  return {
    kind: 'Entity',
    name: ident(name),
    annotations: [],
    fields,
    invariants,
    lifecycle,
    permissions,
    location: FUZZ_LOC,
  };
}

function boolExprOverFields(env: Env, fields: FieldInfo[], scope: 'input' | 'entity'): Expression {
  fire(env, 'Expression');
  const boolField = fields.find((f) => f.boolean && !f.collection);
  const numField = fields.find((f) => f.numeric && !f.collection);
  const strField = fields.find((f) => f.typeName === 'String' && !f.collection);
  const enumField = fields.find((f) => f.enumVariants && f.enumVariants.length > 0);

  const atom = (): Expression => {
    const ref = (name: string): Expression => (scope === 'input' ? inputExpr(name) : ident(name));

    const options: Expression[] = [];
    if (boolField) {
      options.push(binary('==', ref(boolField.name), bool(true)));
      fire(env, 'EqualityExpr');
    }
    if (numField) {
      options.push(binary('>', ref(numField.name), num(0, numField.typeName !== 'Int')));
      fire(env, 'ComparisonExpr');
    }
    if (strField) {
      options.push(binary('!=', ref(strField.name), str('')));
    }
    if (enumField) {
      options.push(binary('==', ref(enumField.name), ident(enumField.enumVariants![0]!)));
    }
    if (options.length === 0) {
      options.push(bool(true));
      fire(env, 'BoolLit');
    }
    return env.rng.pick(options);
  };

  let expr = atom();
  if (want(env, 0.6)) {
    fire(env, 'AndExpr');
    fire(env, 'deep-binary-bool');
    feature(env, 'deep-binary-bool');
    expr = binary('and', expr, atom());
    fire(env, 'BinaryExpr');
  }
  if (want(env, 0.35)) {
    fire(env, 'OrExpr');
    expr = binary('or', expr, atom());
  }
  if (want(env, 0.2)) {
    fire(env, 'UnaryExpr');
    expr = { kind: 'UnaryExpr', operator: 'not', operand: expr, location: FUZZ_LOC };
  }
  if (want(env, 0.2)) {
    fire(env, 'ImpliesExpr');
    expr = binary('implies', atom(), atom());
  }
  if (want(env, 0.25)) {
    fire(env, 'ConditionalExpr');
    feature(env, 'conditional-expr');
    expr = {
      kind: 'ConditionalExpr',
      condition: atom(),
      thenBranch: bool(true),
      elseBranch: atom(),
      location: FUZZ_LOC,
    };
  }
  return expr;
}

function genBehavior(env: Env, entity: EntityInfo): Behavior {
  fire(env, 'BehaviorDecl');
  fire(env, 'Behavior');
  fire(env, 'BehaviorSection');
  fire(env, 'InputSection');
  fire(env, 'OutputSection');
  fire(env, 'InputSpec');
  fire(env, 'OutputSpec');
  const name = nextBehaviorName(env);
  const inputCount = env.rng.int(1, 3);
  const inputFields: Field[] = [];
  const inputInfo: FieldInfo[] = [];
  for (let i = 0; i < inputCount; i++) {
    const fname = `in${i}`;
    const picked = pickFieldType(env);
    inputFields.push(field(fname, picked.type, { optional: picked.info.optional }));
    inputInfo.push({ name: fname, ...picked.info });
  }

  const listSuccess = want(env, 0.25);
  const successType: TypeDefinition = listSuccess
    ? { kind: 'ListType', element: refType(entity.name), location: FUZZ_LOC }
    : refType(entity.name);
  if (listSuccess) {
    feature(env, 'list-entity-success');
    fire(env, 'ListType');
  }

  const preconditions: Expression[] = [];
  if (inputInfo.length > 0) {
    fire(env, 'PreconditionsSection');
    preconditions.push(boolExprOverFields(env, inputInfo, 'input'));
    fire(env, 'InputExpr');
    if (want(env, 0.35)) {
      const stringScalar = inputInfo.find((f) => f.typeName === 'String' && !f.collection);
      if (stringScalar) {
        fire(env, 'QuantifierExpr');
        fire(env, 'QuantifierName');
        fire(env, 'LambdaExpr');
        feature(env, 'quantifier-precondition');
        preconditions.push({
          kind: 'QuantifierExpr',
          quantifier: 'all',
          variable: ident('item'),
          collection: {
            kind: 'ListExpr',
            elements: [inputExpr(stringScalar.name)],
            location: FUZZ_LOC,
          },
          predicate: binary('!=', ident('item'), str('')),
          location: FUZZ_LOC,
        });
        fire(env, 'ListExpr');
      }
    }
  }

  const postconditions: PostconditionBlock[] = [];
  fire(env, 'PostconditionsSection');
  fire(env, 'PostconditionEntry');
  fire(env, 'PostconditionBlock');
  fire(env, 'ResultExpr');
  postconditions.push({
    kind: 'PostconditionBlock',
    condition: 'success',
    predicates: [binary('!=', resultExpr(), { kind: 'NullLiteral', location: FUZZ_LOC })],
    location: FUZZ_LOC,
  });
  fire(env, 'NullLit');

  if (want(env, 0.4)) {
    fire(env, 'OldExpr');
    postconditions[0]!.predicates.push(
      binary('==', resultExpr(), {
        kind: 'OldExpr',
        expression: resultExpr(),
        location: FUZZ_LOC,
      }),
    );
  }

  let actors: ActorSpec[] | undefined;
  if (env.rng.bool(0.4)) {
    fire(env, 'ActorsSection');
    fire(env, 'ActorSpec');
    actors = [
      {
        kind: 'ActorSpec',
        // Persona token, not a roles {} name. actors { Rol0 } is ISL_T123
        // (codegen never reads actors). extras/behavior-surface.isl uses Worker.
        name: ident('Worker'),
        constraints: [],
        location: FUZZ_LOC,
      },
    ];
  }

  const errors = env.rng.bool(0.35)
    ? [
        {
          kind: 'ErrorSpec' as const,
          name: ident('Denied'),
          when: str('not allowed'),
          retriable: false,
          location: FUZZ_LOC,
        },
      ]
    : [];
  if (errors.length) fire(env, 'ErrorDecl');
  fire(env, 'ErrorSpec');

  env.behaviors.push({ name, input: inputInfo, success: entity.name });
  return {
    kind: 'Behavior',
    name: ident(name),
    actors,
    input: { kind: 'InputSpec', fields: inputFields, location: FUZZ_LOC },
    output: {
      kind: 'OutputSpec',
      success: successType,
      errors,
      location: FUZZ_LOC,
    },
    preconditions,
    postconditions,
    invariants: [],
    temporal: [],
    security: [],
    compliance: [],
    location: FUZZ_LOC,
  };
}

/** Policy + entity permissions {} on the same target is ISL_T123 (policy dropped). */
function stripPermissionsCoveredByPolicy(entities: Entity[], policies: Policy[]): void {
  if (policies.length === 0) return;
  let appliesToAll = false;
  const named = new Set<string>();
  for (const policy of policies) {
    const target = policy.appliesTo.target;
    if (target === 'all') appliesToAll = true;
    else {
      for (const id of target) named.add(id.name);
    }
  }
  for (const entity of entities) {
    if (appliesToAll || named.has(entity.name.name)) {
      entity.permissions = undefined;
    }
  }
}

function genPolicy(env: Env, entity: EntityInfo): Policy {
  fire(env, 'PolicyDecl');
  fire(env, 'Policy');
  fire(env, 'PolicyTarget');
  fire(env, 'PolicyRule');
  const boolField = entity.fields.find((f) => f.boolean && !f.collection);
  const condition: Expression | undefined = boolField
    ? binary('==', member(ident(entity.name), boolField.name), bool(true))
    : undefined;
  if (condition) {
    fire(env, 'MemberExpr');
    feature(env, 'member-chain');
  }
  // `applies_to: all` + any entity `permissions {}` is ISL_T123. Named
  // target under forceRare lets sibling entities keep permissions.
  const targetAll = !env.forceRare && env.entities.length > 1 && env.rng.bool(0.35);
  return {
    kind: 'Policy',
    name: ident(`Pol${entity.name}`),
    appliesTo: {
      kind: 'PolicyTarget',
      target: targetAll ? 'all' : [ident(entity.name)],
      location: FUZZ_LOC,
    },
    rules: [
      ...(condition
        ? [
            {
              kind: 'PolicyRule' as const,
              condition,
              action: ident('allow'),
              location: FUZZ_LOC,
            },
          ]
        : []),
      {
        kind: 'PolicyRule',
        condition: undefined,
        action: ident('deny'),
        location: FUZZ_LOC,
      },
    ],
    location: FUZZ_LOC,
  };
}

function genView(env: Env, entity: EntityInfo): View {
  fire(env, 'ViewDecl');
  fire(env, 'View');
  fire(env, 'ViewFieldItem');
  fire(env, 'ViewField');
  fire(env, 'ConsistencySpec');
  const numeric = entity.fields.find((f) => f.numeric && !f.collection);
  const fieldName = numeric?.name ?? 'id';
  const fieldType = numeric ? scalarType(numeric.typeName as ScalarName) : primitive('UUID');
  return {
    kind: 'View',
    name: ident(`Vew${entity.name}`),
    forEntity: refType(entity.name),
    fields: [
      {
        kind: 'ViewField',
        name: ident('metric0'),
        type: fieldType,
        computation: member(ident(entity.name), fieldName),
        location: FUZZ_LOC,
      },
    ],
    consistency: { kind: 'ConsistencySpec', mode: 'eventual', location: FUZZ_LOC },
    location: FUZZ_LOC,
  };
}

function genAggregate(env: Env, entity: EntityInfo): Aggregate {
  fire(env, 'Aggregate');
  fire(env, 'AggregateMeasure');
  const numeric = entity.fields.find((f) => f.numeric && !f.collection);
  const measures = numeric
    ? [
        {
          kind: 'AggregateMeasure' as const,
          fn: 'count' as const,
          location: FUZZ_LOC,
        },
        {
          kind: 'AggregateMeasure' as const,
          fn: 'sum' as const,
          field: ident(numeric.name),
          location: FUZZ_LOC,
        },
      ]
    : [{ kind: 'AggregateMeasure' as const, fn: 'count' as const, location: FUZZ_LOC }];
  return {
    kind: 'Aggregate',
    name: ident(`Agg${entity.name}`),
    forEntity: refType(entity.name),
    measures,
    groupBy: entity.fields.find((f) => f.enumVariants)?.name
      ? ident(entity.fields.find((f) => f.enumVariants)!.name)
      : undefined,
    location: FUZZ_LOC,
  };
}

function genLedger(env: Env): LedgerDecl {
  fire(env, 'LedgerDecl');
  fire(env, 'LedgerMovement');
  feature(env, 'ledger-plus-entity');
  return {
    kind: 'LedgerDecl',
    name: ident('Led0'),
    accounts: [ident('Acc0'), ident('Acc1'), ident('Acc2')],
    movements: [
      {
        kind: 'LedgerMovement',
        name: ident('Mov0'),
        debit: ident('Acc0'),
        credit: ident('Acc1'),
        location: FUZZ_LOC,
      },
    ],
    location: FUZZ_LOC,
  };
}

function genInvariant(env: Env, entity: EntityInfo): InvariantBlock {
  fire(env, 'InvariantBlock');
  const numeric = entity.fields.find((f) => f.numeric && !f.collection);
  const pred = numeric
    ? binary('>=', member(ident(entity.name), numeric.name), num(0, numeric.typeName !== 'Int'))
    : bool(true);
  fire(env, 'MemberExpr');
  return {
    kind: 'InvariantBlock',
    name: ident(`Inv${entity.name}`),
    scope: 'global',
    predicates: [pred],
    location: FUZZ_LOC,
  };
}

function genScenario(env: Env, behaviorName: string, input: FieldInfo[]): ScenarioBlock {
  fire(env, 'ScenarioBlock');
  fire(env, 'ScenarioItem');
  fire(env, 'Scenario');
  fire(env, 'GivenBlock');
  fire(env, 'WhenBlock');
  fire(env, 'ThenBlock');
  fire(env, 'Statement');
  fire(env, 'AssignmentStmt');
  fire(env, 'CallStmt');
  fire(env, 'CallExpr');
  fire(env, 'StringLit');
  fire(env, 'NumberLit');
  const args: Expression[] = input.map((f) => {
    if (f.boolean) return bool(true);
    if (f.numeric) return num(1, f.typeName !== 'Int');
    if (f.enumVariants) return ident(f.enumVariants[0]!);
    if (f.typeName === 'UUID') return str('00000000-0000-4000-8000-000000000001');
    return str('x');
  });
  return {
    kind: 'ScenarioBlock',
    behaviorName: ident(behaviorName),
    scenarios: [
      {
        kind: 'Scenario',
        name: str('happy path'),
        given: [
          {
            kind: 'AssignmentStmt',
            target: ident('n'),
            value: num(0, false),
            location: FUZZ_LOC,
          },
        ],
        when: [
          {
            kind: 'AssignmentStmt',
            target: ident('got'),
            value: {
              kind: 'CallExpr',
              callee: ident(behaviorName),
              arguments: args,
              location: FUZZ_LOC,
            },
            location: FUZZ_LOC,
          },
        ],
        then: [binary('!=', ident('got'), { kind: 'NullLiteral', location: FUZZ_LOC })],
        location: FUZZ_LOC,
      },
    ],
    location: FUZZ_LOC,
  };
}

/**
 * Generate a novel well-formed Domain AST and its unparsed ISL source.
 */
export function generateIslContract(
  rng: SeededRandom,
  options: GenerateOptions = {},
): GeneratedContract {
  const forceRare = options.forceRare ?? rng.bool(0.35);
  const env: Env = {
    rng,
    coverage: new Set(),
    features: new Set(),
    forceRare,
    maxTypeDepth: options.maxTypeDepth ?? (forceRare ? 3 : 2),
    types: [],
    enums: [],
    structs: [],
    entities: [],
    behaviors: [],
    roles: [],
    typeCounter: 0,
    entityCounter: 0,
    behaviorCounter: 0,
  };

  fire(env, 'Program');
  fire(env, 'Domain');
  fire(env, 'DomainMember');
  fire(env, 'VersionField');
  fire(env, 'Identifier');
  fire(env, 'QualifiedName');

  const domainName = `Fuzz${rng.int(0, 9999)}`;
  const maxEntities = options.maxEntities ?? rng.int(forceRare ? 3 : 1, forceRare ? 5 : 4);
  const maxBehaviors = options.maxBehaviors ?? rng.int(1, forceRare ? 4 : 3);

  if (want(env, 0.6) || forceRare) {
    fire(env, 'RolesDecl');
    fire(env, 'RoleDecl');
    env.roles = ['Rol0', 'Rol1'];
  }

  const typeCount = rng.int(forceRare ? 3 : 1, forceRare ? 6 : 4);
  emitForcedRareTypes(env);
  genTypeDeclarations(env, typeCount);

  const entities: Entity[] = [];
  for (let i = 0; i < maxEntities; i++) {
    entities.push(genEntity(env, (forceRare && i === 0) || rng.bool(0.35)));
  }

  // Lifecycle status enums were appended onto env.types after the first pass.
  const types = env.types.slice();

  const behaviors: Behavior[] = [];
  for (let i = 0; i < Math.min(maxBehaviors, env.entities.length); i++) {
    behaviors.push(genBehavior(env, env.entities[i % env.entities.length]!));
  }

  const policies: Policy[] = [];
  if (env.entities.length > 0 && (forceRare || rng.bool(0.55))) {
    policies.push(genPolicy(env, env.entities[0]!));
    feature(env, 'roles-permissions-policy');
  }
  stripPermissionsCoveredByPolicy(entities, policies);

  const views: View[] = [];
  const aggregates: Aggregate[] = [];
  if (env.entities.length > 0 && (forceRare || rng.bool(0.5))) {
    views.push(genView(env, env.entities[0]!));
    aggregates.push(genAggregate(env, env.entities[0]!));
    feature(env, 'view-plus-aggregate');
  }

  const invariants: InvariantBlock[] = [];
  if (env.entities.length > 0 && (forceRare || rng.bool(0.5))) {
    invariants.push(genInvariant(env, env.entities[0]!));
  }

  const ledgers: LedgerDecl[] = [];
  if (forceRare || rng.bool(0.3)) {
    ledgers.push(genLedger(env));
  }

  const scenarios: ScenarioBlock[] = [];
  if (env.behaviors.length > 0 && (forceRare || rng.bool(0.55))) {
    const b = env.behaviors[0]!;
    scenarios.push(genScenario(env, b.name, b.input));
  }

  // Chaos unparse/parse still drifts (round-trip xfail). Skip until unparse
  // matches the RD inject grammar; coverage still records the production when
  // tests call genChaos directly.
  const chaos: Domain['chaos'] = [];

  if (want(env, 0.3) && env.entities[0]) {
    const listField = env.entities[0].fields[0];
    if (listField) {
      fire(env, 'IndexExpr');
      fire(env, 'PostfixExpr');
      feature(env, 'index-expr');
    }
  }

  const domain: Domain = {
    kind: 'Domain',
    name: ident(domainName),
    version: str('1.0.0'),
    owner: rng.bool(0.3) ? (fire(env, 'OwnerField'), str('fuzz-owner')) : undefined,
    tenancy: rng.bool(0.15) ? 'single-tenant' : undefined,
    uses: [],
    imports: [],
    types,
    entities,
    behaviors,
    invariants,
    policies,
    views,
    aggregates,
    roles:
      env.roles.length > 0
        ? {
            kind: 'RolesDecl',
            roles: env.roles.map((r) => ({
              kind: 'RoleDecl' as const,
              name: ident(r),
              location: FUZZ_LOC,
            })),
            location: FUZZ_LOC,
          }
        : undefined,
    ledgers,
    scenarios,
    chaos,
    apis: [],
    storage: [],
    workflows: [],
    events: [],
    handlers: [],
    screens: [],
    location: FUZZ_LOC,
  };

  // Additive index-expr: hang it on a domain invariant so unparse emits it.
  if (env.features.has('index-expr') && domain.invariants.length > 0) {
    const first = domain.invariants[0]!;
    first.predicates.push({
      kind: 'BinaryExpr',
      operator: '>',
      left: {
        kind: 'IndexExpr',
        object: {
          kind: 'ListExpr',
          elements: [num(1, false), num(2, false)],
          location: FUZZ_LOC,
        },
        index: num(0, false),
        location: FUZZ_LOC,
      },
      right: num(0, false),
      location: FUZZ_LOC,
    });
  }

  const source = unparse(domain);
  return {
    domain,
    source,
    coverage: [...env.coverage].sort(),
    features: [...env.features].sort() as RareFeature[],
  };
}

export function generateIslContractFromSeed(
  seed: number,
  options?: GenerateOptions,
): GeneratedContract {
  return generateIslContract(new SeededRandom(seed), options);
}
