import fs from 'node:fs/promises';
import path from 'node:path';
// Explicit .ts extensions: this module is both bundled by esbuild and imported
// directly by node:test, and Node's ESM resolver requires them.
import { ALL_SUPPORTED_EXTENSIONS } from '../../../src/types/formats.ts';
import type { DirEntry } from '../../types/ipc.ts';

const SUPPORTED = new Set(ALL_SUPPORTED_EXTENSIONS.map((ext) => ext.toLowerCase()));

/** Directories never worth walking, matching the watcher's ignore list. */
const SKIP_DIRS = new Set(['.git', 'node_modules']);

export function resolveWithin(root: string, relPath: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relPath);
  // The separator check matters: '/tmp/alpha-other' has '/tmp/alpha' as a
  // string prefix but is not inside it.
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`EPATHESCAPE: ${relPath} escapes ${root}`);
  }
  return target;
}

function isSupportedFile(name: string): boolean {
  // path.extname returns the final segment, so 'deck.slides.md' matches on '.md'.
  const ext = path.extname(name).toLowerCase();
  return ext !== '' && SUPPORTED.has(ext);
}

export async function listDir(root: string, relPath: string): Promise<DirEntry[]> {
  const dir = resolveWithin(root, relPath);
  const dirents = await fs.readdir(dir, { withFileTypes: true });

  const entries: DirEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue;
    if (dirent.isDirectory()) {
      if (SKIP_DIRS.has(dirent.name)) continue;
      entries.push({
        name: dirent.name,
        relPath: path.posix.join(relPath, dirent.name),
        kind: 'directory',
      });
    } else if (dirent.isFile() && isSupportedFile(dirent.name)) {
      entries.push({
        name: dirent.name,
        relPath: path.posix.join(relPath, dirent.name),
        kind: 'file',
      });
    }
  }

  // Directories first, then files, each alphabetical and case-insensitive.
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return entries;
}

export async function readFile(root: string, relPath: string, binary: boolean): Promise<string> {
  const target = resolveWithin(root, relPath);
  const buffer = await fs.readFile(target);
  return binary ? buffer.toString('base64') : buffer.toString('utf8');
}
