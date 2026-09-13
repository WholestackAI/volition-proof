/**
 * `@wholestack/app-contract` — the canonical intent layer over ISL.
 *
 * One semantic document (the ISL source) with one deterministic projection
 * (clauses) and one additive provenance sidecar. Every surface — the Blueprint
 * workspace, the raw ISL editor, natural-language commands, the Zeta CLI, and
 * agent APIs — reads and writes through this package, so none of them can
 * become a second source of truth.
 *
 * Nothing here calls a model. The natural-language layer defines the *schema* a
 * model must fill in and the deterministic machinery that validates it; the
 * call itself belongs to the host.
 */

// Canonical model
export {
  APP_CONTRACT_SCHEMA_VERSION,
  BLUEPRINT_SECTIONS,
  CLAUSE_KINDS,
  CLAUSE_LAYERS,
  defaultClauseMeta,
  emptyContractMeta,
  type AppContract,
  type AppContractSchemaVersion,
  type BlueprintSection,
  type Clause,
  type ClauseId,
  type ClauseKind,
  type ClauseLayer,
  type ClauseMeta,
  type ClauseSource,
  type ContractMeta,
} from './canonical/types.js';
export type { ClauseSemantic, CompareOp, NormalizedExpression } from './canonical/semantic.js';
export {
  contractFromDomain,
  parseAppContract,
  semanticallyEqual,
  type ClauseProvenanceStamp,
  type ParseContractOptions,
  type ParseContractResult,
} from './canonical/parse.js';
export {
  CLAUSE_ID_SCHEME,
  clausesFromDomain,
  collectEnums,
  referenceTarget,
  typeToEnglish,
  typeToIsl,
} from './canonical/from-isl.js';
export {
  hashNormalForm,
  semanticNormalForm,
  stableStringify,
  type SemanticNormalForm,
} from './canonical/normalize.js';
export { sha256Hex, shortDigest } from './canonical/hash.js';
export {
  article,
  expressionToEnglish,
  expressionToIsl,
  humanizeIdentifier,
  humanizeTypeName,
  isMinorUnitField,
  stripMinorUnitSuffix,
  titleCaseName,
  withArticle,
} from './canonical/expression.js';

// Blueprint
export {
  renderBlueprint,
  renderBlueprintText,
  type Blueprint,
  type BlueprintLine,
  type BlueprintSectionView,
  type RenderBlueprintOptions,
} from './blueprint/render.js';
export { expandMiniIsl, type MiniExpandResult } from './blueprint/mini.js';
export {
  renderMini,
  renderMiniFromDomain,
  type MiniRenderResult,
} from './blueprint/mini-render.js';

// Patches
export {
  CONTRACT_OP_NAMES,
  isDestructive,
  patchIsDestructive,
  type ContractOp,
  type SemanticPatch,
} from './patch/ops.js';
export {
  applyPatch,
  PatchError,
  previewPatch,
  type ApplyOptions,
  type ApplyResult,
} from './patch/apply.js';
export {
  ContractOpSchema,
  PatchProposalSchema,
  SemanticPatchSchema,
  validatePatchProposal,
  type PatchProposal,
  type PatchValidation,
} from './patch/op-schema.js';
export {
  confirmClause,
  isLocked,
  lockClause,
  openAssumptions,
  unlockClause,
} from './patch/locks.js';
export {
  behaviorFragment,
  entityFragment,
  expressionFragment,
  fieldFragment,
  FragmentError,
  invariantFragment,
} from './patch/fragment.js';

// Diff and impact
export {
  diffContracts,
  summarizeDiff,
  type SemanticChange,
  type SemanticChangeKind,
  type SemanticDiff,
} from './diff/semantic-diff.js';
export {
  analyzeImpact,
  impactLines,
  type ImpactArea,
  type ImpactReport,
  type ImpactRisk,
} from './diff/impact.js';

// Natural-language intake
export {
  DRAFT_FIELD_TYPES,
  DraftEntitySchema,
  DraftFieldSchema,
  DraftReportSchema,
  DraftRoleSchema,
  DraftRuleSchema,
  detectContradictions,
  INTENT_DRAFT_SCHEMA_VERSION,
  IntentDraftSchema,
  normalizeDraft,
  validateIntentDraft,
  type DraftAssumption,
  type DraftContradiction,
  type DraftEntity,
  type DraftField,
  type DraftFieldType,
  type DraftReport,
  type DraftRole,
  type DraftRule,
  type DraftValidation,
  type IntentDraft,
} from './nl/draft.js';
export { draftToContract, draftToMini, type DraftToContractResult } from './nl/to-isl.js';
export {
  applyClarifications,
  IMPACT_WEIGHTS,
  rankClarifications,
  type AnsweredClarifications,
  type ClarificationAnswer,
  type ClarificationOption,
  type ClarificationQuestion,
  type QuestionImpact,
} from './nl/questions.js';

// Engine ISL projection
export {
  projectToEngineIsl,
  type AuthorizationRefusal,
  type DroppedConstruct,
  type EngineProjection,
  type ProjectEngineOptions,
  type ProjectedEngine,
  type RefusedProjection,
} from './engine/project.js';

// Agent Mandate — projection of sealed AppContract (not a second language)
export {
  AUTONOMY_LEVELS,
  deriveAutonomy,
  projectMandate,
  type AutonomyLevel,
  type DerivedAutonomy,
  type MandateLimit,
  type MandateView,
} from './mandate-view.js';

// Diagnostics
export {
  explainDiagnostic,
  explainDiagnostics,
  hasExplanation,
  type DiagnosticSeverity,
  type FriendlyDiagnostic,
  type SuggestedFix,
} from './diagnostics/explain.js';

// Portable artifacts
export {
  buildImplementationMap,
  buildIntentLock,
  detectDrift,
  IMPLEMENTATION_MAP_VERSION,
  INTENT_LOCK_VERSION,
  serializeImplementationMap,
  serializeIntentLock,
  verifyLockHash,
  type DriftKind,
  type DriftReport,
  type ImplementationEntry,
  type ImplementationEvidence,
  type ImplementationMap,
  type IntentLock,
  type IntentLockClause,
  PROVABLE_CLAUSE_KINDS,
  PROVABLE_KINDS,
  type ProvableClauseKind,
} from './artifacts/lockfile.js';

// Volition CAS atomic proposals
export {
  ContractProposalSchema,
  ProposalSourceSchema,
  ProposalStatusSchema,
  commitProposal,
  createContractProposal,
  dryRunProposal,
  hashProposalBody,
  rejectProposal,
  type CommitProposalResult,
  type ContractProposal,
  type CreateProposalInput,
  type ProposalSource,
  type ProposalStatus,
} from './proposal/proposal-runner.js';
