/**
 * Expression rendering — two projections of the same ISL expression AST.
 *
 * `expressionToIsl` produces canonical ISL text (parenthesised, deterministic)
 * used for clause identity and the Code lens. `expressionToEnglish` produces a
 * readable sentence fragment for the Blueprint. Both are pure functions of the
 * AST — no AI, no lookup tables keyed to any one app.
 */

import type { Expression } from '@isl-lang/parser';

type Node = Record<string, unknown>;

/** Widen an expression AST node so kind-switches can index fields the parser unions don't share. */
function asNode(value: unknown): Node {
  return value as Node;
}

function esc(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Canonical ISL text for an expression. Fully parenthesised, stable ordering. */
export function expressionToIsl(e: Expression | undefined): string {
  if (!e || typeof e !== 'object') return '';
  const x = asNode(e);
  switch (x.kind) {
    case 'Identifier':
      return (x.name as string) ?? '';
    case 'QualifiedName':
      return ((x.parts as { name: string }[]) ?? []).map((p) => p.name).join('.');
    case 'StringLiteral':
      return `"${esc(x.value as string)}"`;
    case 'NumberLiteral':
      return String(x.value);
    case 'BooleanLiteral':
      return x.value ? 'true' : 'false';
    case 'NullLiteral':
      return 'null';
    case 'DurationLiteral':
      return `${x.value}.${x.unit}`;
    case 'RegexLiteral':
      return `/${x.pattern}/${x.flags ?? ''}`;
    case 'BinaryExpr':
      return `(${expressionToIsl(x.left as Expression)} ${x.operator} ${expressionToIsl(x.right as Expression)})`;
    case 'UnaryExpr':
      return `(${x.operator} ${expressionToIsl(x.operand as Expression)})`;
    case 'MemberExpr':
      return `${expressionToIsl(x.object as Expression)}.${(x.property as { name: string })?.name}`;
    case 'CallExpr':
      return `${expressionToIsl(x.callee as Expression)}(${((x.arguments as Expression[]) ?? []).map(expressionToIsl).join(', ')})`;
    case 'IndexExpr':
      return `${expressionToIsl(x.object as Expression)}[${expressionToIsl(x.index as Expression)}]`;
    case 'OldExpr':
      return `old(${expressionToIsl(x.expression as Expression)})`;
    case 'ResultExpr':
      return x.property ? `result.${(x.property as { name: string }).name}` : 'result';
    case 'InputExpr':
      return `input.${(x.property as { name: string })?.name}`;
    case 'QuantifierExpr': {
      const v = x.variable as { name: string } | undefined;
      return `${x.quantifier}(${expressionToIsl(x.collection as Expression)}, ${v?.name ?? '_'} => ${expressionToIsl(x.predicate as Expression)})`;
    }
    case 'ConditionalExpr':
      return `(${expressionToIsl(x.condition as Expression)} ? ${expressionToIsl(x.thenBranch as Expression)} : ${expressionToIsl(x.elseBranch as Expression)})`;
    case 'LambdaExpr':
      return `(${((x.params as { name: string }[]) ?? []).map((p) => p.name).join(', ')}) => ${expressionToIsl(x.body as Expression)}`;
    case 'ListExpr':
      return `[${((x.elements as Expression[]) ?? []).map(expressionToIsl).join(', ')}]`;
    case 'MapExpr':
      return `{ ${((x.entries as { key: Expression; value: Expression }[]) ?? [])
        .map((en) => `${expressionToIsl(en.key)}: ${expressionToIsl(en.value)}`)
        .join(', ')} }`;
    default:
      return `[${String(x.kind)}]`;
  }
}

const BINARY_ENGLISH: Record<string, string> = {
  '==': 'is',
  '!=': 'is not',
  '<': 'is less than',
  '>': 'is more than',
  '<=': 'is at most',
  '>=': 'is at least',
  '+': 'plus',
  '-': 'minus',
  '*': 'times',
  '/': 'divided by',
  '%': 'modulo',
  and: 'and',
  or: 'or',
  implies: 'means that',
  iff: 'exactly when',
  in: 'is one of',
};

/** Split camelCase / snake_case identifiers into readable words. */
export function humanizeIdentifier(name: string): string {
  if (!name) return '';
  const spaced = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
  return spaced.toLowerCase();
}

/** Title-case a type or entity name for prose: `FollowUp` → `Follow up`. */
export function humanizeTypeName(name: string): string {
  const words = humanizeIdentifier(name);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `SummitRoofing` → `Summit Roofing`. Keeps each word capitalised, unlike `humanizeTypeName`. */
export function titleCaseName(name: string): string {
  return humanizeIdentifier(name)
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** `a`/`an` by leading sound (vowel-letter heuristic; good enough for identifiers). */
export function article(word: string): string {
  return /^[aeiou]/i.test(word.trim()) ? 'an' : 'a';
}

/** `a Estimate` is wrong in every locale we ship. */
export function withArticle(word: string): string {
  return `${article(word)} ${word}`;
}

/**
 * Money is stored in minor units by convention (`amountCents`, `priceCents`).
 * The Blueprint must never say "amount cents" to a business owner.
 */
export function isMinorUnitField(fieldName: string): boolean {
  return /cents$/i.test(fieldName);
}

/** `amountCents` → `amount`; anything else is unchanged. */
export function stripMinorUnitSuffix(fieldName: string): string {
  return isMinorUnitField(fieldName) ? fieldName.replace(/cents$/i, '') : fieldName;
}

/**
 * Money-ish field names get rendered as currency in English so a threshold of
 * `2000000` on `amountCents` reads as `$20,000` instead of two million.
 */
function centsFieldName(e: Expression | undefined): boolean {
  const text = expressionToIsl(e);
  return /cents$/i.test(text);
}

function formatMoneyCents(value: number): string {
  const dollars = value / 100;
  return `$${dollars.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

/** Readable sentence fragment for an expression. Never emits braces. */
export function expressionToEnglish(e: Expression | undefined): string {
  return renderEnglish(e, undefined);
}

function renderEnglish(e: Expression | undefined, siblingForUnits: Expression | undefined): string {
  if (!e || typeof e !== 'object') return '';
  const x = asNode(e);
  switch (x.kind) {
    case 'Identifier':
      return humanizeIdentifier(x.name as string);
    case 'QualifiedName':
      return ((x.parts as { name: string }[]) ?? [])
        .map((p) => humanizeIdentifier(p.name))
        .join(' ');
    case 'StringLiteral':
      return `“${x.value as string}”`;
    case 'NumberLiteral': {
      const n = x.value as number;
      if (siblingForUnits && centsFieldName(siblingForUnits)) return formatMoneyCents(n);
      return n.toLocaleString('en-US');
    }
    case 'BooleanLiteral':
      return x.value ? 'yes' : 'no';
    case 'NullLiteral':
      return 'empty';
    case 'DurationLiteral':
      return `${x.value} ${x.unit}`;
    case 'BinaryExpr': {
      const op = x.operator as string;
      const left = x.left as Expression;
      const right = x.right as Expression;
      const word = BINARY_ENGLISH[op] ?? op;
      return `${renderEnglish(left, right)} ${word} ${renderEnglish(right, left)}`;
    }
    case 'UnaryExpr':
      return x.operator === 'not'
        ? `it is not the case that ${renderEnglish(x.operand as Expression, undefined)}`
        : `-${renderEnglish(x.operand as Expression, undefined)}`;
    case 'MemberExpr': {
      // `amountCents` reads as "amount" here for the same reason its value
      // renders as `$20,000`: minor units are a storage detail, not intent.
      const prop = (x.property as { name: string })?.name ?? '';
      return `${renderEnglish(x.object as Expression, undefined)} ${humanizeIdentifier(stripMinorUnitSuffix(prop))}`.trim();
    }
    case 'InputExpr':
      return humanizeIdentifier(stripMinorUnitSuffix((x.property as { name: string })?.name ?? ''));
    case 'ResultExpr':
      return x.property
        ? `the resulting ${humanizeIdentifier((x.property as { name: string }).name)}`
        : 'the result';
    case 'OldExpr':
      return `the previous ${renderEnglish(x.expression as Expression, undefined)}`;
    case 'CallExpr': {
      const callee = expressionToIsl(x.callee as Expression);
      const args = ((x.arguments as Expression[]) ?? []).map((a) => renderEnglish(a, undefined));
      if (callee === 'exists') return `there is ${args.join(' ')}`;
      return `${humanizeIdentifier(callee)}${args.length ? ` of ${args.join(' and ')}` : ''}`;
    }
    case 'ConditionalExpr':
      return `if ${renderEnglish(x.condition as Expression, undefined)} then ${renderEnglish(x.thenBranch as Expression, undefined)}, otherwise ${renderEnglish(x.elseBranch as Expression, undefined)}`;
    case 'QuantifierExpr': {
      const q = x.quantifier as string;
      const coll = renderEnglish(x.collection as Expression, undefined);
      const pred = renderEnglish(x.predicate as Expression, undefined);
      if (q === 'all') return `every ${coll} satisfies ${pred}`;
      if (q === 'any') return `at least one ${coll} satisfies ${pred}`;
      if (q === 'none') return `no ${coll} satisfies ${pred}`;
      return `${q} of ${coll} where ${pred}`;
    }
    case 'ListExpr':
      return ((x.elements as Expression[]) ?? [])
        .map((el) => renderEnglish(el, undefined))
        .join(', ');
    default:
      return expressionToIsl(e);
  }
}
