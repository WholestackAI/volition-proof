import { z } from 'zod';

const FAMILY_KEYS = [
  'application_identity_and_scope',
  'outcomes_kpis_and_product_truth',
  'glossary_and_semantic_identity',
  'stakeholders_and_actors',
  'organization_tenancy_and_ownership',
  'resources_and_entities',
  'field_and_value_semantics',
  'relationships_and_referential_behavior',
  'lifecycle_and_state_machines',
  'commands',
  'queries',
  'events',
  'workflows_and_sagas',
  'business_rules_decisions_and_policies',
  'invariants',
  'calculations_and_derived_values',
  'money_semantics',
  'time_semantics',
  'quantity_inventory_and_capacity_semantics',
  'identity_and_authentication',
  'authorization_and_policy_enforcement',
  'data_access_and_row_isolation',
  'privacy_and_data_classification',
  'content_files_and_media',
  'search_and_discovery',
  'notifications_and_communication',
  'external_integrations',
  'webhooks',
  'background_jobs_and_schedules',
  'real_time_and_collaborative_behavior',
  'ai_and_agent_behavior',
  'frontend_surfaces_and_route_model',
  'forms_and_input_experiences',
  'navigation_and_information_architecture',
  'design_system_and_visual_grammar',
  'accessibility',
  'localization_and_internationalization',
  'api_contract',
  'backend_boundaries',
  'database_and_persistence',
  'transactions_concurrency_and_idempotency',
  'caching',
  'failure_retry_and_compensation',
  'security',
  'abuse_fraud_and_misuse',
  'performance_budgets',
  'scalability_and_capacity',
  'observability',
  'audit_and_evidence',
  'product_analytics_and_experimentation',
  'testing_and_proof',
  'configuration_secrets_and_environments',
  'migrations_and_data_evolution',
  'deployment_and_release_engineering',
  'backups_recovery_and_continuity',
  'operations_and_support',
  'documentation',
  'legal_policy_and_compliance_behavior',
  'economic_and_provider_controls',
  'retirement_and_decommissioning',
] as const;

const FAMILY_IDS = [
  'AGF-001',
  'AGF-002',
  'AGF-003',
  'AGF-004',
  'AGF-005',
  'AGF-006',
  'AGF-007',
  'AGF-008',
  'AGF-009',
  'AGF-010',
  'AGF-011',
  'AGF-012',
  'AGF-013',
  'AGF-014',
  'AGF-015',
  'AGF-016',
  'AGF-017',
  'AGF-018',
  'AGF-019',
  'AGF-020',
  'AGF-021',
  'AGF-022',
  'AGF-023',
  'AGF-024',
  'AGF-025',
  'AGF-026',
  'AGF-027',
  'AGF-028',
  'AGF-029',
  'AGF-030',
  'AGF-031',
  'AGF-032',
  'AGF-033',
  'AGF-034',
  'AGF-035',
  'AGF-036',
  'AGF-037',
  'AGF-038',
  'AGF-039',
  'AGF-040',
  'AGF-041',
  'AGF-042',
  'AGF-043',
  'AGF-044',
  'AGF-045',
  'AGF-046',
  'AGF-047',
  'AGF-048',
  'AGF-049',
  'AGF-050',
  'AGF-051',
  'AGF-052',
  'AGF-053',
  'AGF-054',
  'AGF-055',
  'AGF-056',
  'AGF-057',
  'AGF-058',
  'AGF-059',
  'AGF-060',
] as const;

export const APPLICATION_GENOME_FAMILY_IDS = Object.freeze(FAMILY_IDS);
export const APPLICATION_GENOME_FAMILY_KEYS = Object.freeze(FAMILY_KEYS);

export const APPLICATION_GENOME_FAMILIES = Object.freeze(
  FAMILY_IDS.map((familyId, index) =>
    Object.freeze({
      familyId,
      familyKey: FAMILY_KEYS[index]!,
      standardSection: `AGF-${String(index + 1).padStart(3, '0')}`,
    }),
  ),
);

export const GenomeFamilyIdSchema = z.enum(FAMILY_IDS);
export const GenomeFamilyKeySchema = z.enum(FAMILY_KEYS);

export const GenomeFamilyDescriptorSchema = z
  .object({
    familyId: GenomeFamilyIdSchema,
    familyKey: GenomeFamilyKeySchema,
    standardSection: z.string().min(1),
  })
  .strict();

export type GenomeFamilyId = z.infer<typeof GenomeFamilyIdSchema>;
export type GenomeFamilyKey = z.infer<typeof GenomeFamilyKeySchema>;
export type GenomeFamilyDescriptor = z.infer<typeof GenomeFamilyDescriptorSchema>;

const FAMILY_KEY_BY_ID = new Map(
  APPLICATION_GENOME_FAMILIES.map((family) => [family.familyId, family.familyKey]),
);

export function genomeFamilyKeyForId(familyId: GenomeFamilyId): GenomeFamilyKey {
  return FAMILY_KEY_BY_ID.get(familyId)!;
}
