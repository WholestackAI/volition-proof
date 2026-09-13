// ============================================================================
// Seed Corpus Builder
//
// Builds a seed corpus from real .isl files in the codebase
// ============================================================================

import { readFile, readdir } from 'fs/promises';
import { join, extname } from 'path';

/**
 * Corpus entry
 */
export interface CorpusEntry {
  /** File path */
  path: string;

  /** File content */
  content: string;

  /** File size in bytes */
  size: number;

  /** Whether parsing succeeded */
  valid: boolean;
}

/**
 * Build corpus from directory
 */
export async function buildCorpusFromDir(
  rootDir: string,
  maxFiles: number = 1000,
): Promise<CorpusEntry[]> {
  const corpus: CorpusEntry[] = [];
  const visited = new Set<string>();

  async function collectFiles(dir: string): Promise<void> {
    if (corpus.length >= maxFiles) {
      return;
    }

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (corpus.length >= maxFiles) {
          break;
        }

        const fullPath = join(dir, entry.name);

        // Skip node_modules, .git, dist, etc.
        if (
          entry.name.startsWith('.') ||
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === 'build' ||
          entry.name === '.turbo'
        ) {
          continue;
        }

        if (entry.isDirectory()) {
          await collectFiles(fullPath);
        } else if (entry.isFile() && extname(entry.name) === '.isl') {
          if (!visited.has(fullPath)) {
            visited.add(fullPath);

            try {
              const content = await readFile(fullPath, 'utf-8');
              corpus.push({
                path: fullPath,
                content,
                size: new TextEncoder().encode(content).length,
                valid: true, // Assume valid, will be validated during fuzzing
              });
            } catch (err) {
              // Skip files that can't be read
              console.warn(`Failed to read ${fullPath}: ${err}`);
            }
          }
        }
      }
    } catch (err) {
      // Skip directories that can't be read
      console.warn(`Failed to read directory ${dir}: ${err}`);
    }
  }

  await collectFiles(rootDir);
  return corpus;
}

/**
 * Save corpus to JSON file
 */
export async function saveCorpus(corpus: CorpusEntry[], outputPath: string): Promise<void> {
  const { writeFile } = await import('fs/promises');
  await writeFile(outputPath, JSON.stringify(corpus, null, 2), 'utf-8');
}

/**
 * Load corpus from JSON file
 */
export async function loadCorpus(inputPath: string): Promise<CorpusEntry[]> {
  const { readFile } = await import('fs/promises');
  const content = await readFile(inputPath, 'utf-8');
  return JSON.parse(content) as CorpusEntry[];
}
