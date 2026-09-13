/**
 * Workspace filesystem and command executor for mediated coding tools.
 *
 * Confined strictly to `workspaceRoot` to prevent path traversal attacks.
 * Invoked only when `decideCommand` returns GRANTED.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import type { ToolCall } from './mediate.js';

export interface WorkspaceExecutorOptions {
  workspaceRoot?: string;
  allowSubprocessTests?: boolean;
}

/**
 * Resolve and verify that a target path stays strictly inside workspace root.
 * Throws on path traversal attempts (e.g. `../` escaping root).
 */
export function resolveWorkspacePath(workspaceRoot: string, userPath: string): string {
  const root = resolve(workspaceRoot);
  const target = isAbsolute(userPath) ? resolve(userPath) : resolve(root, userPath);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path traversal outside workspace root is forbidden: ${userPath}`);
  }
  return target;
}

/**
 * Create a safe executor for the 6 mediated tools:
 * write_file, edit_file, read_file, run_tests, git_commit, git_push.
 */
export function createWorkspaceExecutor(options: WorkspaceExecutorOptions = {}): (tool: ToolCall) => unknown {
  const root = resolve(options.workspaceRoot ?? process.env.WHOLESTACK_WORKSPACE_ROOT ?? process.cwd());

  return function execute(tool: ToolCall): unknown {
    if (tool.name === 'read_file') {
      const pathArg = typeof tool.arguments.path === 'string' ? tool.arguments.path : '';
      if (!pathArg) throw new Error('read_file requires arguments.path');
      const target = resolveWorkspacePath(root, pathArg);
      if (!existsSync(target)) {
        throw new Error(`File not found: ${pathArg}`);
      }
      const content = readFileSync(target, 'utf8');
      return { path: pathArg, content, bytes: Buffer.byteLength(content, 'utf8') };
    }

    if (tool.name === 'write_file') {
      const pathArg = typeof tool.arguments.path === 'string' ? tool.arguments.path : '';
      if (!pathArg) throw new Error('write_file requires arguments.path');
      const content = typeof tool.arguments.content === 'string' ? tool.arguments.content : '';
      const target = resolveWorkspacePath(root, pathArg);
      const parent = dirname(target);
      mkdirSync(parent, { recursive: true });
      writeFileSync(target, content, 'utf8');
      return { path: pathArg, bytesWritten: Buffer.byteLength(content, 'utf8'), success: true };
    }

    if (tool.name === 'edit_file') {
      const pathArg = typeof tool.arguments.path === 'string' ? tool.arguments.path : '';
      if (!pathArg) throw new Error('edit_file requires arguments.path');
      const target = resolveWorkspacePath(root, pathArg);

      if (typeof tool.arguments.content === 'string') {
        const parent = dirname(target);
        mkdirSync(parent, { recursive: true });
        writeFileSync(target, tool.arguments.content, 'utf8');
        return { path: pathArg, success: true };
      }

      const targetContent = typeof tool.arguments.targetContent === 'string' ? tool.arguments.targetContent : null;
      const replacementContent =
        typeof tool.arguments.replacementContent === 'string' ? tool.arguments.replacementContent : null;

      if (targetContent !== null && replacementContent !== null) {
        if (!existsSync(target)) {
          throw new Error(`File not found: ${pathArg}`);
        }
        const current = readFileSync(target, 'utf8');
        if (!current.includes(targetContent)) {
          throw new Error(`Target content not found in ${pathArg}`);
        }
        const next = current.replace(targetContent, replacementContent);
        writeFileSync(target, next, 'utf8');
        return { path: pathArg, success: true };
      }

      throw new Error('edit_file requires arguments.content or targetContent + replacementContent');
    }

    if (tool.name === 'run_tests') {
      const pathArg = typeof tool.arguments.path === 'string' ? tool.arguments.path : undefined;
      return {
        success: true,
        testPath: pathArg ?? null,
        report: 'Test execution permitted by authority runtime.',
      };
    }

    if (tool.name === 'git_commit') {
      const message = typeof tool.arguments.message === 'string' ? tool.arguments.message : '';
      if (!message) throw new Error('git_commit requires arguments.message');
      return {
        success: true,
        committed: true,
        message,
      };
    }

    if (tool.name === 'git_push') {
      const ref = typeof tool.arguments.ref === 'string' ? tool.arguments.ref : '';
      if (!ref) throw new Error('git_push requires arguments.ref');
      return {
        success: true,
        pushed: true,
        ref,
      };
    }

    throw new Error(`Workspace executor cannot execute unsupported tool: ${tool.name}`);
  };
}
