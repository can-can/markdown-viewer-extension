import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);

/** A slow git command must not hold up the folder that you opened. */
const GIT_TIMEOUT_MS = 2000;

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  prunable: boolean;
}

/**
 * Read `git worktree list --porcelain`.
 *
 * One record for each worktree. A blank line separates the records. A record
 * has a `worktree <path>` line, and then optional lines: `HEAD <sha>`,
 * `branch refs/heads/<name>`, `detached`, `bare`, `prunable <reason>`,
 * `locked <reason>`.
 */
export function parseWorktreeList(stdout: string): WorktreeInfo[] {
  const records: WorktreeInfo[] = [];
  let current: WorktreeInfo | null = null;

  const close = (): void => {
    if (current) records.push(current);
    current = null;
  };

  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd();
    if (line === '') {
      close();
      continue;
    }

    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    // A path can contain a space, so take the rest of the line unchanged.
    const value = space === -1 ? '' : line.slice(space + 1);

    switch (key) {
      case 'worktree':
        close();
        current = {
          path: value,
          branch: null,
          detached: false,
          bare: false,
          prunable: false,
        };
        break;
      case 'branch':
        if (current) current.branch = value.replace(/^refs\/heads\//, '');
        break;
      case 'detached':
        if (current) current.detached = true;
        break;
      case 'bare':
        if (current) current.bare = true;
        break;
      case 'prunable':
        if (current) current.prunable = true;
        break;
      default:
        // HEAD, locked, and any line a newer git adds.
        break;
    }
  }

  close();
  return records;
}

/** Run git in a folder. Return null for any failure, including a timeout. */
async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout;
  } catch {
    // git absent, folder is not a repository, or git was too slow.
    return null;
  }
}

export async function listWorktrees(root: string): Promise<WorktreeInfo[]> {
  const stdout = await git(root, ['worktree', 'list', '--porcelain']);
  return stdout === null ? [] : parseWorktreeList(stdout);
}

export async function repoKeyOf(root: string): Promise<string | null> {
  const absolute = await git(root, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (absolute !== null && absolute.trim() !== '') return path.resolve(absolute.trim());

  // Older git has no --path-format. It answers '.git' in the main worktree and
  // an absolute path in a linked worktree, so resolve against the folder.
  const legacy = await git(root, ['rev-parse', '--git-common-dir']);
  if (legacy === null || legacy.trim() === '') return null;
  return path.resolve(root, legacy.trim());
}
