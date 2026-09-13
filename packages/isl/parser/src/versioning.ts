// ============================================================================
// ISL Versioning System
// ============================================================================

/**
 * Current ISL language version
 */
export const CURRENT_ISL_VERSION = '0.2';

/**
 * Supported ISL language versions
 */
export const SUPPORTED_VERSIONS = ['0.1', '0.2'] as const;

export type ISLVersion = (typeof SUPPORTED_VERSIONS)[number];

/**
 * Version compatibility information
 */
export interface VersionCompatibility {
  version: ISLVersion;
  compatibleWith: ISLVersion[];
  migrationRequired: boolean;
  migrationNotes?: string;
}

/**
 * Version compatibility matrix
 */
export const VERSION_COMPATIBILITY: Record<ISLVersion, VersionCompatibility> = {
  '0.1': {
    version: '0.1',
    compatibleWith: ['0.1', '0.2'],
    migrationRequired: true,
    migrationNotes: 'v0.1 specs should be migrated to v0.2 for best compatibility',
  },
  '0.2': {
    version: '0.2',
    compatibleWith: ['0.2'],
    migrationRequired: false,
  },
};

/**
 * Check if a version is supported
 */
export function isSupportedVersion(version: string | undefined): version is ISLVersion {
  if (!version) return false;
  return SUPPORTED_VERSIONS.includes(version as ISLVersion);
}

/**
 * Check if two versions are compatible
 */
export function areVersionsCompatible(
  sourceVersion: string | undefined,
  targetVersion: ISLVersion,
): boolean {
  if (!sourceVersion) {
    // No version specified - assume current version
    return true;
  }

  if (!isSupportedVersion(sourceVersion)) {
    return false;
  }

  const compat = VERSION_COMPATIBILITY[sourceVersion];
  return compat.compatibleWith.includes(targetVersion);
}

/**
 * Get migration warnings for a version
 */
export function getMigrationWarnings(
  sourceVersion: string | undefined,
  targetVersion: ISLVersion = CURRENT_ISL_VERSION,
): string[] {
  const warnings: string[] = [];

  if (!sourceVersion) {
    warnings.push(
      `No islVersion directive found. Assuming version ${CURRENT_ISL_VERSION}. ` +
        `Consider adding '#islVersion "${CURRENT_ISL_VERSION}"' at the top of your spec.`,
    );
    return warnings;
  }

  if (!isSupportedVersion(sourceVersion)) {
    warnings.push(
      `Unknown ISL version "${sourceVersion}". Supported versions: ${SUPPORTED_VERSIONS.join(', ')}`,
    );
    return warnings;
  }

  const compat = VERSION_COMPATIBILITY[sourceVersion];
  if (compat.migrationRequired && sourceVersion !== targetVersion) {
    warnings.push(
      `ISL version ${sourceVersion} migration to ${targetVersion} recommended. ` +
        (compat.migrationNotes ?? ''),
    );
  }

  return warnings;
}

/**
 * Migration rule for transforming ISL code between versions
 */
export interface MigrationRule {
  fromVersion: ISLVersion;
  toVersion: ISLVersion;
  description: string;
  transform: (content: string) => string;
}

/**
 * Migration rules for v0.1 -> v0.2
 */
const MIGRATION_RULES_V01_TO_V02: MigrationRule[] = [
  {
    fromVersion: '0.1',
    toVersion: '0.2',
    description: 'Add islVersion directive if missing',
    transform: (content: string) => {
      // Check if islVersion already exists
      if (content.match(/^#?\s*islVersion\s+["']/im)) {
        return content;
      }

      // Add islVersion directive at the top
      const lines = content.split('\n');
      let insertIndex = 0;

      // Skip shebang and empty lines
      while (insertIndex < lines.length) {
        const line = lines[insertIndex]?.trim() ?? '';
        if (line && !line.startsWith('#!') && !line.match(/^#\s*islVersion/i)) {
          break;
        }
        insertIndex++;
      }

      lines.splice(insertIndex, 0, '#islVersion "0.2"');
      return lines.join('\n');
    },
  },
  {
    fromVersion: '0.1',
    toVersion: '0.2',
    description: 'Update deprecated syntax patterns',
    transform: (content: string) => {
      // Example: Replace old syntax patterns if any
      // This is a placeholder for actual migration rules
      return content;
    },
  },
];

/**
 * Migrate ISL content from one version to another
 */
export function migrateISL(
  content: string,
  fromVersion: string | undefined,
  toVersion: ISLVersion = CURRENT_ISL_VERSION,
): { migrated: string; appliedRules: string[] } {
  if (!fromVersion || fromVersion === toVersion) {
    return { migrated: content, appliedRules: [] };
  }

  if (!isSupportedVersion(fromVersion)) {
    throw new Error(`Unsupported source version: ${fromVersion}`);
  }

  const appliedRules: string[] = [];
  let migrated = content;

  // Apply migration rules sequentially
  if (fromVersion === '0.1' && toVersion === '0.2') {
    for (const rule of MIGRATION_RULES_V01_TO_V02) {
      const before = migrated;
      migrated = rule.transform(migrated);
      if (before !== migrated) {
        appliedRules.push(rule.description);
      }
    }
  }

  return { migrated, appliedRules };
}
