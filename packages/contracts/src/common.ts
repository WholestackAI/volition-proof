import { z } from 'zod';
import { sha256HexSync } from './sha256.js';

/**
 * Canonical JSON for content addressing: compact, recursively key-sorted.
 *
 * This lives in contracts because every package that hashes a record depends on
 * contracts, and four independent copies of "canonical JSON" is how two packages
 * end up disagreeing about the hash of the same object. It is byte-identical to
 * the `compactStableStringify` that `@wholestack/isl` already used for
 * compilation provenance, so existing ISL and seal hashes are unchanged.
 *
 * `undefined` serializes as `null` rather than being dropped. That is the prior
 * behavior and it matters: hashing `{...record, contentHash: undefined}` is how
 * every content hash here excludes its own field, and the excluded key must
 * serialize the same way every time.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return (JSON.stringify(value) as string | undefined) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${(value as unknown[]).map(canonicalStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
    .join(',')}}`;
}

/** sha256 hex of the canonical form. Matches ContentHashSchema. */
export function canonicalHashHex(value: unknown): string {
  return sha256HexSync(canonicalStringify(value));
}

/**
 * Content hash of a record, excluding its own `contentHash` field — the pattern
 * every hashed artifact in this system uses.
 */
export function selfExcludingHash<T extends { contentHash: string }>(record: T): string {
  return canonicalHashHex({ ...record, contentHash: undefined });
}

export const ContentHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'contentHash must be sha256 hex');

export type ContentHash = z.infer<typeof ContentHashSchema>;

/** ISO-8601 datetime with timezone offset (e.g. 2026-07-19T20:00:00+00:00) */
export const IsoDateTimeSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'invalid datetime');

export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

export const ActorSchema = z.object({
  actorId: z.string().min(1),
  actorType: z.enum(['user', 'system', 'agent', 'service']),
  displayName: z.string().optional(),
});

export type Actor = z.infer<typeof ActorSchema>;
