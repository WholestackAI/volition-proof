/**
 * AST fragment construction by parsing, never by hand.
 *
 * Every node a patch inserts is produced by running the real ISL parser over a
 * synthetic host document and lifting the node out. That keeps one grammar in
 * the system: a patch that would produce ungrammatical ISL fails here, at
 * construction, instead of surfacing later as a corrupt spec.
 */

import {
  parse as parseIsl,
  type Behavior,
  type Entity,
  type Expression,
  type Field,
} from '@isl-lang/parser';

export class FragmentError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = 'FragmentError';
  }
}

function parseHost(source: string, what: string) {
  const result = parseIsl(source, `patch-fragment/${what}.isl`);
  const errors = (result.errors ?? []).filter((d) => d.severity === 'error');
  if (!result.success || !result.domain || errors.length) {
    throw new FragmentError(
      `Could not read ${what} as ISL.`,
      errors.map((e) => `${e.code}: ${e.message}`).join('; ') || 'parser returned no domain',
    );
  }
  return result.domain;
}

/** Parse a boolean expression (a rule condition) into an `Expression` node. */
export function expressionFragment(islExpression: string): Expression {
  const domain = parseHost(
    `domain PatchHost version "1.0.0"\n\nbehavior PatchHostBehavior {\n  input { }\n  output { success: Boolean }\n  preconditions {\n    - ${islExpression}\n  }\n}\n`,
    'expression',
  );
  const expression = domain.behaviors?.[0]?.preconditions?.[0];
  if (!expression) throw new FragmentError('Could not read that condition.', islExpression);
  return expression;
}

/** Parse a single entity field line (`amountCents: Int [indexed]`). */
export function fieldFragment(islField: string): Field {
  const domain = parseHost(
    `domain PatchHost version "1.0.0"\n\nentity PatchHostEntity {\n  ${islField}\n}\n`,
    'field',
  );
  const field = domain.entities?.[0]?.fields?.[0];
  if (!field) throw new FragmentError('Could not read that field.', islField);
  return field;
}

/** Parse a whole `entity X { … }` block. */
export function entityFragment(islEntity: string): Entity {
  const domain = parseHost(`domain PatchHost version "1.0.0"\n\n${islEntity}\n`, 'entity');
  const entity = domain.entities?.[0];
  if (!entity) throw new FragmentError('Could not read that record type.', islEntity);
  return entity;
}

/** Parse a whole `behavior X { … }` block. */
export function behaviorFragment(islBehavior: string): Behavior {
  const domain = parseHost(`domain PatchHost version "1.0.0"\n\n${islBehavior}\n`, 'behavior');
  const behavior = domain.behaviors?.[0];
  if (!behavior) throw new FragmentError('Could not read that action.', islBehavior);
  return behavior;
}

/** Parse an `invariants X { description: "…"  - <predicate> }` block. */
export function invariantFragment(islInvariant: string) {
  const domain = parseHost(`domain PatchHost version "1.0.0"\n\n${islInvariant}\n`, 'invariant');
  const invariant = domain.invariants?.[0];
  if (!invariant) throw new FragmentError('Could not read that rule.', islInvariant);
  return invariant;
}

/** Parse an `enum X { A B }` declaration into a type declaration node. */
export function enumFragment(name: string, variants: string[]) {
  const domain = parseHost(
    `domain PatchHost version "1.0.0"\n\nenum ${name} { ${variants.join(' ')} }\n`,
    'enum',
  );
  const decl = domain.types?.[0];
  if (!decl) throw new FragmentError('Could not read that status list.', name);
  return decl;
}
