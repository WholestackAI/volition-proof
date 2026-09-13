import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));
const packages = path.join(root, 'packages');

export default defineConfig({
  resolve: {
    alias: {
      '@isl-lang/parser': path.join(packages, 'isl/parser/src/index.ts'),
      '@wholestack/app-contract': path.join(packages, 'app-contract/src/index.ts'),
      '@wholestack/authority': path.join(packages, 'authority/src/index.ts'),
      '@wholestack/authority-mcp': path.join(packages, 'authority-mcp/src/index.ts'),
      '@wholestack/contracts': path.join(packages, 'contracts/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'packages/authority/src/**/*.test.ts',
      'packages/authority-mcp/src/**/*.test.ts',
      'evals/agent-gauntlet/src/**/*.test.ts',
    ],
    pool: 'forks',
  },
});
