import { z } from 'zod';

export const OBLIGATION_CRITICALITIES = Object.freeze(['C0', 'C1', 'C2', 'C3'] as const);
export const ObligationCriticalitySchema = z.enum(OBLIGATION_CRITICALITIES);
export type ObligationCriticality = z.infer<typeof ObligationCriticalitySchema>;

/**
 * Immutable artifact progression. Advancing state creates a superseding record;
 * it never mutates a content-addressed semantic artifact in place.
 */
export const ARTIFACT_LIFECYCLE_STATES = Object.freeze([
  'draft',
  'specified',
  'expanded',
  'sealed',
  'implemented',
  'verified',
  'released',
  'deployed',
  'operating',
  'superseded',
  'retired',
] as const);

export const ArtifactLifecycleStateSchema = z.enum(ARTIFACT_LIFECYCLE_STATES);
export type ArtifactLifecycleState = z.infer<typeof ArtifactLifecycleStateSchema>;
