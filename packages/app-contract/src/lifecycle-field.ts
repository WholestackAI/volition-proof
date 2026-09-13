/**
 * The one predicate that decides whether a field name is a lifecycle column.
 *
 * The Mini-ISL writer and the canonical reader used to disagree: the writer
 * emitted a `lifecycle { }` block only for a field named exactly `status`,
 * while the reader accepted any `/status|stage|state/i` name. A column called
 * `stage`, `state` or `phase` therefore round-tripped as a plain enum with no
 * transitions and no workflow surface — the writer never wrote the block the
 * reader was looking for.
 *
 * Both sides import this. A name is a lifecycle to everyone or to no one.
 */
const LIFECYCLE_FIELD_NAME = /status|stage|state|phase/i;

export function isLifecycleFieldName(name: string): boolean {
  return LIFECYCLE_FIELD_NAME.test(name);
}
