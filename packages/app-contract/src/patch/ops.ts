/**
 * Typed semantic edit operations.
 *
 * A patch is a list of these — never a source-string rewrite and never a file
 * diff. Every surface (Blueprint inline edit, natural-language command, CLI,
 * agent API) produces the same op shapes, so validation, locking, diffing and
 * impact analysis are written once.
 */

export interface AddEntityOp {
  op: 'add-entity';
  /** Whole `entity X { … }` block in ISL. */
  isl: string;
}

export interface RemoveEntityOp {
  op: 'remove-entity';
  entity: string;
}

export interface AddFieldOp {
  op: 'add-field';
  entity: string;
  /** One field line in ISL, e.g. `approvedBy: UUID? [references: "User.id"]`. */
  isl: string;
}

export interface RemoveFieldOp {
  op: 'remove-field';
  entity: string;
  field: string;
}

export interface AddRoleOp {
  op: 'add-role';
  role: string;
}

export interface RemoveRoleOp {
  op: 'remove-role';
  role: string;
}

export interface SetPermissionOp {
  op: 'set-permission';
  entity: string;
  action: 'read' | 'write' | 'delete';
  /** Declared roles allowed. */
  roles: string[];
  /** Whether the record owner is allowed regardless of role. */
  owner?: boolean;
  /** Counterparty FK columns allowed (`related(buyerId)`). */
  related?: string[];
}

export interface RemovePermissionOp {
  op: 'remove-permission';
  entity: string;
  action: 'read' | 'write' | 'delete';
}

export interface AddStatusOp {
  op: 'add-status';
  entity: string;
  field: string;
  /** Enum variant name, e.g. `PENDING_APPROVAL`. */
  status: string;
  /** Insert after this existing variant; appended when absent. */
  after?: string;
}

export interface SetTerminalOp {
  op: 'set-terminal';
  entity: string;
  field: string;
  /** Enum variants that end the record's life. Replaces any existing `[terminal:]`. */
  statuses: string[];
}

export interface AddTransitionOp {
  op: 'add-transition';
  entity: string;
  from: string;
  to: string;
}

export interface RemoveTransitionOp {
  op: 'remove-transition';
  entity: string;
  from: string;
  to: string;
}

export interface AddPreconditionOp {
  op: 'add-precondition';
  behavior: string;
  /** Boolean ISL expression. */
  expression: string;
}

export interface RemovePreconditionOp {
  op: 'remove-precondition';
  behavior: string;
  /** Canonical ISL text of the precondition to drop (as shown in the Code lens). */
  expression: string;
}

export interface AddBehaviorOp {
  op: 'add-behavior';
  /** Whole `behavior X { … }` block in ISL. */
  isl: string;
}

export interface RemoveBehaviorOp {
  op: 'remove-behavior';
  behavior: string;
}

export interface SetBehaviorRoleOp {
  op: 'set-behavior-role';
  behavior: string;
  /** `null` removes the role gate. */
  role: string | null;
}

export interface AddInvariantOp {
  op: 'add-invariant';
  /** Whole `invariant X { … }` block in ISL. */
  isl: string;
}

export interface RemoveInvariantOp {
  op: 'remove-invariant';
  invariant: string;
}

export interface SetAppDescriptionOp {
  op: 'set-app-description';
  description: string;
}

export type ContractOp =
  | AddEntityOp
  | RemoveEntityOp
  | AddFieldOp
  | RemoveFieldOp
  | AddRoleOp
  | RemoveRoleOp
  | SetPermissionOp
  | RemovePermissionOp
  | AddStatusOp
  | SetTerminalOp
  | AddTransitionOp
  | RemoveTransitionOp
  | AddPreconditionOp
  | RemovePreconditionOp
  | AddBehaviorOp
  | RemoveBehaviorOp
  | SetBehaviorRoleOp
  | AddInvariantOp
  | RemoveInvariantOp
  | SetAppDescriptionOp;

export const CONTRACT_OP_NAMES = [
  'add-entity',
  'remove-entity',
  'add-field',
  'remove-field',
  'add-role',
  'remove-role',
  'set-permission',
  'remove-permission',
  'add-status',
  'set-terminal',
  'add-transition',
  'remove-transition',
  'add-precondition',
  'remove-precondition',
  'add-behavior',
  'remove-behavior',
  'set-behavior-role',
  'add-invariant',
  'remove-invariant',
  'set-app-description',
] as const satisfies readonly ContractOp['op'][];

/** A validated, reviewable change to the contract. */
export interface SemanticPatch {
  /** Stable id so a proposal can be shown, approved, and applied later. */
  id: string;
  /** One-line plain-English summary shown before the change is applied. */
  title: string;
  /** Why this change exists — the user's words when it came from a request. */
  rationale?: string;
  /** The user's original request text, preserved as provenance. */
  originalText?: string;
  /** Where the change came from; stamped onto every clause it creates. */
  origin: 'user' | 'inferred' | 'template' | 'imported' | 'system';
  ops: ContractOp[];
}

/** Ops that can only remove or narrow meaning. Used to decide review-before-apply. */
export function isDestructive(op: ContractOp): boolean {
  switch (op.op) {
    case 'remove-entity':
    case 'remove-field':
    case 'remove-role':
    case 'remove-permission':
    case 'remove-transition':
    case 'remove-precondition':
    case 'remove-behavior':
    case 'remove-invariant':
      return true;
    case 'set-permission':
    case 'set-terminal':
    case 'set-behavior-role':
    case 'set-app-description':
      // Replaces an existing statement — treated as review-worthy, not additive.
      return true;
    default:
      return false;
  }
}

export function patchIsDestructive(patch: SemanticPatch): boolean {
  return patch.ops.some(isDestructive);
}
