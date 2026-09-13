import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorkspaceExecutor, resolveWorkspacePath } from './workspace-executor.js';

describe('workspace executor', () => {
  let tempDir: string;
  let execute: (tool: { name: string; arguments: Record<string, unknown> }) => unknown;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'volition-ws-test-'));
    execute = createWorkspaceExecutor({ workspaceRoot: tempDir });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolveWorkspacePath keeps paths inside root and rejects escapes', () => {
    const inside = resolveWorkspacePath(tempDir, 'src/test.ts');
    expect(inside).toBe(join(tempDir, 'src/test.ts'));

    expect(() => resolveWorkspacePath(tempDir, '../outside.txt')).toThrow(
      /Path traversal outside workspace root is forbidden/,
    );
    expect(() => resolveWorkspacePath(tempDir, '../../etc/passwd')).toThrow(
      /Path traversal outside workspace root is forbidden/,
    );
  });

  it('write_file writes content and creates parent directories', () => {
    const res = execute({
      name: 'write_file',
      arguments: { path: 'packages/assigned/src/index.ts', content: 'export const hello = "world";\n' },
    }) as { path: string; bytesWritten: number; success: boolean };

    expect(res.success).toBe(true);
    expect(existsSync(join(tempDir, 'packages/assigned/src/index.ts'))).toBe(true);
    expect(readFileSync(join(tempDir, 'packages/assigned/src/index.ts'), 'utf8')).toBe(
      'export const hello = "world";\n',
    );
  });

  it('read_file reads file content and throws on missing file', () => {
    execute({
      name: 'write_file',
      arguments: { path: 'readme.txt', content: 'hello world' },
    });

    const readRes = execute({
      name: 'read_file',
      arguments: { path: 'readme.txt' },
    }) as { content: string; bytes: number };

    expect(readRes.content).toBe('hello world');
    expect(readRes.bytes).toBe(11);

    expect(() => execute({ name: 'read_file', arguments: { path: 'does-not-exist.txt' } })).toThrow(
      /File not found/,
    );
  });

  it('edit_file replaces targetContent or overwrites with content', () => {
    execute({
      name: 'write_file',
      arguments: { path: 'code.ts', content: 'const a = 1;\nconst b = 2;\n' },
    });

    execute({
      name: 'edit_file',
      arguments: {
        path: 'code.ts',
        targetContent: 'const a = 1;',
        replacementContent: 'const a = 42;',
      },
    });

    expect(readFileSync(join(tempDir, 'code.ts'), 'utf8')).toBe('const a = 42;\nconst b = 2;\n');

    execute({
      name: 'edit_file',
      arguments: {
        path: 'code.ts',
        content: 'const fresh = true;\n',
      },
    });

    expect(readFileSync(join(tempDir, 'code.ts'), 'utf8')).toBe('const fresh = true;\n');
  });

  it('run_tests, git_commit, and git_push report execution', () => {
    const testRes = execute({
      name: 'run_tests',
      arguments: { path: 'src/test.ts' },
    }) as { success: boolean };
    expect(testRes.success).toBe(true);

    const commitRes = execute({
      name: 'git_commit',
      arguments: { message: 'feat: add module' },
    }) as { success: boolean; committed: boolean };
    expect(commitRes.committed).toBe(true);

    const pushRes = execute({
      name: 'git_push',
      arguments: { ref: 'feature-branch' },
    }) as { success: boolean; pushed: boolean };
    expect(pushRes.pushed).toBe(true);
  });

  it('throws on unsupported tool', () => {
    expect(() => execute({ name: 'drop_database', arguments: {} })).toThrow(/unsupported tool/);
  });
});
