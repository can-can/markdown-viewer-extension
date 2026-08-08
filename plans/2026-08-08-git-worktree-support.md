# Git Worktree Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When you open a folder in a git repository, the app finds the other worktrees, shows one tab for the repository, and lets you change worktree from a dropdown in the sidebar.

**Architecture:** The folder list stays flat. Each folder gets `repoKey`, `branch`, and `loaded`. The view groups folders by `repoKey`. The main process reads git through one new module. A worktree is read and watched only when you select it.

**Tech Stack:** Electron, TypeScript, esbuild, `node:test`, Playwright `_electron`, the `git` command.

Spec: `specs/2026-08-08-git-worktree-support-design.md`

## Global Constraints

- **git timeout:** 2000 ms. A slower answer counts as "no worktrees".
- **repoKey:** absolute path of the git common directory. Use `git rev-parse --path-format=absolute --git-common-dir`. Plain `--git-common-dir` returns `.git` from the main worktree and an absolute path from a linked worktree; the two do not match.
- **Lazy rule:** only the folder you select is read and watched. A repository with 10 worktrees uses 1 watcher.
- **Security:** the renderer holds opaque folder ids. `worktree:register` accepts only paths that git reported this run.
- **Dropdown visible only when** `repoKey` is not `null` **and** the repository has 2 or more worktrees.
- **Bare worktrees are dropped.** A bare repository has no files to read.
- **Explicit `.ts` extensions on imports** inside `desktop/`. These modules are bundled by esbuild and also imported directly by `node --test`.
- **Tests:** `node:test` + `node:assert/strict`, run as `node --test test/<file>.test.ts`.
- **Each Electron launch gets its own `--user-data-dir`.** The app writes a session file; a shared directory makes tests restore each other's folders.
- **Select viewer iframes by `data-view-key`, never `data-active`.** The pool can still mark the outgoing view active during a swap.
- **Do not modify `tsconfig.json`.** `npm run typecheck` is broken before this work: line 21 sets `"ignoreDeprecations": "6.0"`, which the installed TypeScript rejects. To check your work, remove that line, run `npx tsc --noEmit`, confirm zero errors whose path starts with `desktop/`, then restore the file exactly.

## File Structure

```
desktop/src/main/
  git-worktrees.ts        NEW  parse git output, run git, compute repoKey
  ipc.ts                  MOD  repoKey on open, worktree list/register, lazy watch
desktop/src/renderer/
  workspace-model.ts      MOD  repoKey/branch/loaded fields, addFolder options, groupByRepo
  folder-tabs.ts          MOD  one tab for each repository
  worktree-select.ts      NEW  the sidebar dropdown
  main.ts                 MOD  find worktrees on open, load one on select
  workspace.css           MOD  dropdown styles
desktop/types/ipc.ts      MOD  WorktreeInfo, new bridge calls
desktop/src/preload/preload.ts  MOD  expose the new calls
test/
  desktop-git-worktrees.test.ts  NEW  parser units + real repository integration
  desktop-workspace-model.test.ts MOD  new field and grouping tests
  desktop-smoke.test.ts           MOD  Electron tests
```

---

### Task 1: The git module

**Files:**
- Create: `desktop/src/main/git-worktrees.ts`
- Test: `test/desktop-git-worktrees.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `WorktreeInfo = { path: string; branch: string | null; detached: boolean; bare: boolean; prunable: boolean }`
  - `parseWorktreeList(stdout: string): WorktreeInfo[]`
  - `listWorktrees(root: string): Promise<WorktreeInfo[]>`
  - `repoKeyOf(root: string): Promise<string | null>`

- [ ] **Step 1: Write the failing test**

Create `test/desktop-git-worktrees.test.ts`:

```ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  parseWorktreeList,
  listWorktrees,
  repoKeyOf,
} from '../desktop/src/main/git-worktrees.ts';

describe('parseWorktreeList', () => {
  it('reads several records and strips refs/heads/', () => {
    const out = [
      'worktree /tmp/repo',
      'HEAD 79bedb8',
      'branch refs/heads/main',
      '',
      'worktree /tmp/feature-a',
      'HEAD 79bedb8',
      'branch refs/heads/feature-a',
      '',
    ].join('\n');

    assert.deepEqual(parseWorktreeList(out), [
      { path: '/tmp/repo', branch: 'main', detached: false, bare: false, prunable: false },
      { path: '/tmp/feature-a', branch: 'feature-a', detached: false, bare: false, prunable: false },
    ]);
  });

  it('gives branch null for a detached record', () => {
    const out = 'worktree /tmp/d\nHEAD 79bedb8\ndetached\n';
    const [record] = parseWorktreeList(out);
    assert.equal(record.branch, null);
    assert.equal(record.detached, true);
  });

  it('marks a bare record', () => {
    const [record] = parseWorktreeList('worktree /tmp/bare\nbare\n');
    assert.equal(record.bare, true);
  });

  it('marks a prunable record and keeps its branch', () => {
    const out = [
      'worktree /tmp/gone',
      'HEAD 79bedb8',
      'branch refs/heads/gone',
      'prunable gitdir file points to non-existent location',
    ].join('\n');
    const [record] = parseWorktreeList(out);
    assert.equal(record.prunable, true);
    assert.equal(record.branch, 'gone');
  });

  it('returns an empty list for empty output', () => {
    assert.deepEqual(parseWorktreeList(''), []);
    assert.deepEqual(parseWorktreeList('\n\n'), []);
  });

  it('ignores lines it does not know', () => {
    const out = 'worktree /tmp/a\nHEAD 79bedb8\nlocked reason here\nsomethingnew\nbranch refs/heads/a\n';
    assert.deepEqual(parseWorktreeList(out), [
      { path: '/tmp/a', branch: 'a', detached: false, bare: false, prunable: false },
    ]);
  });

  it('keeps a record that has no closing blank line', () => {
    assert.equal(parseWorktreeList('worktree /tmp/a\nbranch refs/heads/a').length, 1);
  });

  it('keeps a path that contains a space', () => {
    const [record] = parseWorktreeList('worktree /tmp/my repo\nbranch refs/heads/main\n');
    assert.equal(record.path, '/tmp/my repo');
  });
});

describe('listWorktrees and repoKeyOf against a real repository', () => {
  let base: string;
  let repo: string;
  let linked: string;

  before(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'docmd-git-')));
    repo = path.join(base, 'repo');
    linked = path.join(base, 'feature-a');

    const git = (cwd: string, ...args: string[]): void => {
      execFileSync('git', args, { cwd, stdio: 'ignore' });
    };
    await fs.mkdir(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    await fs.writeFile(path.join(repo, 'README.md'), '# Main\n', 'utf8');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'feature-a');
  });

  after(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('reports both worktrees, main first', async () => {
    const list = await listWorktrees(repo);
    assert.deepEqual(list.map((w) => w.path), [repo, linked]);
    assert.deepEqual(list.map((w) => w.branch), ['main', 'feature-a']);
  });

  it('reports the same list from the linked worktree', async () => {
    assert.deepEqual(
      (await listWorktrees(linked)).map((w) => w.path),
      [repo, linked],
    );
  });

  it('gives the same repoKey from both worktrees', async () => {
    const fromMain = await repoKeyOf(repo);
    const fromLinked = await repoKeyOf(linked);
    assert.equal(fromMain, path.join(repo, '.git'));
    assert.equal(fromLinked, fromMain, 'both worktrees must group under one tab');
  });

  it('returns nothing for a folder that is not a repository', async () => {
    const plain = path.join(base, 'plain');
    await fs.mkdir(plain, { recursive: true });
    assert.deepEqual(await listWorktrees(plain), []);
    assert.equal(await repoKeyOf(plain), null);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/desktop-git-worktrees.test.ts`
Expected: FAIL — cannot find module `git-worktrees.ts`.

- [ ] **Step 3: Write the module**

Create `desktop/src/main/git-worktrees.ts`:

```ts
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
    if (line === '') { close(); continue; }

    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    // A path can contain a space, so take the rest of the line unchanged.
    const value = space === -1 ? '' : line.slice(space + 1);

    switch (key) {
      case 'worktree':
        close();
        current = { path: value, branch: null, detached: false, bare: false, prunable: false };
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
  const absolute = await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (absolute !== null && absolute.trim() !== '') return path.resolve(absolute.trim());

  // Older git has no --path-format. It answers '.git' in the main worktree and
  // an absolute path in a linked worktree, so resolve against the folder.
  const legacy = await git(root, ['rev-parse', '--git-common-dir']);
  if (legacy === null || legacy.trim() === '') return null;
  return path.resolve(root, legacy.trim());
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/desktop-git-worktrees.test.ts`
Expected: PASS — 12 assertions.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/git-worktrees.ts test/desktop-git-worktrees.test.ts
git commit -m "feat(desktop): read git worktrees in the main process"
```

---

### Task 2: Model fields and repository grouping

**Files:**
- Modify: `desktop/src/renderer/workspace-model.ts`
- Test: `test/desktop-workspace-model.test.ts`

**Interfaces:**
- Consumes: `OpenedFolder` from `desktop/types/ipc.ts`.
- Produces:
  - `FolderState` gains `repoKey: string | null`, `branch: string | null`, `loaded: boolean`
  - `addFolder(folder, options?: AddFolderOptions)` where
    `AddFolderOptions = { activate?: boolean; repoKey?: string | null; branch?: string | null; loaded?: boolean }`
  - `setFolderLoaded(folderId: string, loaded: boolean): void`
  - `RepoGroup = { key: string; label: string; folders: FolderState[] }`
  - `groupByRepo(folders: FolderState[]): RepoGroup[]`

`addFolder` today always sets the new folder active. A worktree added in the
background must not take focus, so `activate` defaults to `true` and the
worktree path passes `false`.

- [ ] **Step 1: Write the failing test**

Append to `test/desktop-workspace-model.test.ts`:

```ts
describe('worktree fields', () => {
  let model: WorkspaceModel;
  beforeEach(() => { model = createWorkspaceModel(); });

  it('defaults to no repository and loaded true', () => {
    model.addFolder(alpha);
    const folder = model.getFolder('f1')!;
    assert.equal(folder.repoKey, null);
    assert.equal(folder.branch, null);
    assert.equal(folder.loaded, true);
  });

  it('stores repoKey, branch, and loaded from the options', () => {
    model.addFolder(alpha, { repoKey: '/r/.git', branch: 'main', loaded: false });
    const folder = model.getFolder('f1')!;
    assert.equal(folder.repoKey, '/r/.git');
    assert.equal(folder.branch, 'main');
    assert.equal(folder.loaded, false);
  });

  it('does not activate a folder added with activate false', () => {
    model.addFolder(alpha);
    model.addFolder(beta, { activate: false });
    assert.equal(model.getState().activeFolderId, 'f1');
    assert.equal(model.getState().folders.length, 2);
  });

  it('sets the loaded flag later', () => {
    model.addFolder(alpha, { loaded: false });
    model.setFolderLoaded('f1', true);
    assert.equal(model.getFolder('f1')!.loaded, true);
  });

  it('ignores setFolderLoaded for an unknown folder', () => {
    assert.doesNotThrow(() => model.setFolderLoaded('nope', true));
  });
});

describe('groupByRepo', () => {
  const make = (id: string, folderPath: string, repoKey: string | null): FolderState => ({
    id,
    path: folderPath,
    name: folderPath.split('/').pop()!,
    tree: [],
    tabs: [],
    activeRelPath: null,
    expandedPaths: new Set(),
    status: 'ready',
    repoKey,
    branch: null,
    loaded: true,
  });

  it('puts worktrees of one repository in one group', () => {
    const groups = groupByRepo([
      make('f1', '/code/repo', '/code/repo/.git'),
      make('f2', '/code/feature-a', '/code/repo/.git'),
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].folders.map((f) => f.id), ['f1', 'f2']);
  });

  it('names the group after the main worktree, not the folder you opened', () => {
    // repoKey is <main worktree>/.git, so its parent directory names the group.
    const groups = groupByRepo([make('f2', '/code/feature-a', '/code/repo/.git')]);
    assert.equal(groups[0].label, 'repo');
  });

  it('gives a plain folder its own group named after the folder', () => {
    const groups = groupByRepo([make('f1', '/code/notes', null)]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].label, 'notes');
  });

  it('keeps two plain folders apart', () => {
    const groups = groupByRepo([
      make('f1', '/code/notes', null),
      make('f2', '/code/other', null),
    ]);
    assert.equal(groups.length, 2);
  });

  it('keeps two repositories apart', () => {
    const groups = groupByRepo([
      make('f1', '/a/repo', '/a/repo/.git'),
      make('f2', '/b/repo', '/b/repo/.git'),
    ]);
    assert.equal(groups.length, 2);
  });

  it('keeps the order in which the folders were added', () => {
    const groups = groupByRepo([
      make('f1', '/code/notes', null),
      make('f2', '/code/repo', '/code/repo/.git'),
      make('f3', '/code/feature-a', '/code/repo/.git'),
    ]);
    assert.deepEqual(groups.map((g) => g.label), ['notes', 'repo']);
  });
});
```

Add `groupByRepo` and the `FolderState` type to the import at the top of the
file:

```ts
import {
  createWorkspaceModel,
  groupByRepo,
  viewKey,
  type FolderState,
  type WorkspaceModel,
} from '../desktop/src/renderer/workspace-model.ts';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/desktop-workspace-model.test.ts`
Expected: FAIL — `groupByRepo` is not exported.

- [ ] **Step 3: Add the fields and the grouping**

In `desktop/src/renderer/workspace-model.ts`, add to `FolderState` after `status`:

```ts
  /** Absolute git common directory. Worktrees of one repository share it. */
  repoKey: string | null;
  /** Branch name, or null when the worktree has no branch. */
  branch: string | null;
  /** True after the app read the tree and started the watcher. */
  loaded: boolean;
```

Add the options type and the group type near the top:

```ts
export interface AddFolderOptions {
  /** A worktree added in the background must not take focus. */
  activate?: boolean;
  repoKey?: string | null;
  branch?: string | null;
  loaded?: boolean;
}

export interface RepoGroup {
  key: string;
  label: string;
  folders: FolderState[];
}
```

Add the pure grouping function beside the other helpers:

```ts
function basename(pathValue: string): string {
  const index = pathValue.lastIndexOf('/');
  return index === -1 ? pathValue : pathValue.slice(index + 1);
}

/**
 * One group for each repository, and one group for each plain folder.
 *
 * repoKey is `<main worktree>/.git`, so the parent directory of repoKey names
 * the repository. This stays correct when you open a linked worktree first.
 */
export function groupByRepo(folders: FolderState[]): RepoGroup[] {
  const groups: RepoGroup[] = [];
  const byKey = new Map<string, RepoGroup>();

  for (const folder of folders) {
    const key = folder.repoKey ?? `folder:${folder.id}`;
    let group = byKey.get(key);
    if (!group) {
      const label = folder.repoKey
        ? basename(folder.repoKey.replace(/\/\.git\/?$/, '').replace(/\/[^/]+$/, (m) => m)) || folder.name
        : folder.name;
      group = { key, label, folders: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.folders.push(folder);
  }

  return groups;
}
```

The label expression above is hard to read. Use this instead:

```ts
function repoLabel(repoKey: string): string {
  // repoKey is '<main worktree>/.git'. Remove the last segment to get the
  // main worktree directory, then take its name.
  const withoutGitDir = repoKey.replace(/\/\.git\/?$/, '');
  return basename(withoutGitDir);
}
```

and in `groupByRepo`:

```ts
      const label = folder.repoKey ? repoLabel(folder.repoKey) : folder.name;
```

Change the `WorkspaceModel` interface entry and the implementation of
`addFolder`, and add `setFolderLoaded`:

```ts
  addFolder(folder: OpenedFolder, options?: AddFolderOptions): void;
  setFolderLoaded(folderId: string, loaded: boolean): void;
```

```ts
    addFolder(folder, options) {
      const existing = state.folders.find((f) => f.path === folder.path);
      if (existing) {
        if (options?.activate !== false) state.activeFolderId = existing.id;
        notify();
        return;
      }
      state.folders.push({
        id: folder.id,
        path: folder.path,
        name: folder.name,
        tree: [],
        tabs: [],
        activeRelPath: null,
        expandedPaths: new Set(),
        status: 'ready',
        repoKey: options?.repoKey ?? null,
        branch: options?.branch ?? null,
        loaded: options?.loaded ?? true,
      });
      if (options?.activate !== false) state.activeFolderId = folder.id;
      notify();
    },

    setFolderLoaded(folderId, loaded) {
      const folder = find(folderId);
      if (!folder) return;
      folder.loaded = loaded;
      notify();
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/desktop-workspace-model.test.ts`
Expected: PASS — the earlier assertions and 11 new ones.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/renderer/workspace-model.ts test/desktop-workspace-model.test.ts
git commit -m "feat(desktop): add worktree fields and repository grouping to the model"
```

---

### Task 3: Main process calls

**Files:**
- Modify: `desktop/src/main/ipc.ts`
- Modify: `desktop/types/ipc.ts`
- Modify: `desktop/src/preload/preload.ts`
- Modify: `test/desktop-smoke.test.ts`

**Interfaces:**
- Consumes: `listWorktrees`, `repoKeyOf`, `WorktreeInfo` from Task 1.
- Produces on `window.desktop`:
  - `listWorktrees(folderId: string): Promise<WorktreeInfo[]>` — bare records removed
  - `registerWorktree(folderPath: string): Promise<OpenedFolder | null>` — no watcher
  - `loadFolder(folderId: string): Promise<DirEntry[]>` — start the watcher, read the root
  - `OpenedFolder` gains `repoKey: string | null` and `branch: string | null`

- [ ] **Step 1: Extend the contract**

In `desktop/types/ipc.ts`, add to `OpenedFolder`:

```ts
  /** Absolute git common directory, or null when the folder is not a repository. */
  repoKey: string | null;
  /** Branch name, or null when there is no branch. */
  branch: string | null;
```

Add the record type and the three calls:

```ts
export interface WorktreeInfo {
  path: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  prunable: boolean;
}
```

```ts
  /** Worktrees of the repository that holds this folder. Bare records removed. */
  listWorktrees(folderId: string): Promise<WorktreeInfo[]>;
  /**
   * Register a worktree without a watcher and without reading its tree.
   * Accepts only a path that git reported this run.
   */
  registerWorktree(folderPath: string): Promise<OpenedFolder | null>;
  /** Start the watcher for a registered folder and read its root. */
  loadFolder(folderId: string): Promise<DirEntry[]>;
```

- [ ] **Step 2: Write the main process handlers**

In `desktop/src/main/ipc.ts`, add the import:

```ts
import { listWorktrees, repoKeyOf } from './git-worktrees.ts';
import type { WorktreeInfo } from '../../types/ipc.ts';
```

Add beside `restorablePaths`:

```ts
/**
 * Worktree paths that git reported this run.
 *
 * registerWorktree accepts only these. Without the check the renderer could
 * name any path and defeat the opaque-id rule that folder:open enforces.
 */
const knownWorktreePaths = new Set<string>();
```

Replace `register` so a caller can hold back the watcher, and add the git
fields:

```ts
  const register = async (root: string, watch = true): Promise<OpenedFolder> => {
    const id = `f${++folderIdCounter}`;
    openFolders.set(id, root);
    if (watch) startWatching(id, root, sendFileChange);
    return {
      id,
      path: root,
      name: path.basename(root),
      repoKey: await repoKeyOf(root),
      branch: (await listWorktrees(root)).find((w) => w.path === root)?.branch ?? null,
    };
  };
```

Every existing `register(...)` call now needs `await`. Update `folder:open`
and `folder:reopen`:

```ts
  ipcMain.handle('folder:open', async (): Promise<OpenedFolder | null> => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      buttonLabel: 'Open Folder',
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    return register(result.filePaths[0]);
  });

  ipcMain.handle('folder:reopen', async (_event, folderPath: string): Promise<OpenedFolder | null> => {
    if (!restorablePaths.has(folderPath)) return null;
    return register(folderPath);
  });
```

Add the three new handlers:

```ts
  ipcMain.handle('worktree:list', async (_event, folderId: string): Promise<WorktreeInfo[]> => {
    // A bare repository has no files to read, so it is never a folder.
    const found = (await listWorktrees(getFolderRoot(folderId))).filter((w) => !w.bare);
    for (const worktree of found) knownWorktreePaths.add(worktree.path);
    return found;
  });

  ipcMain.handle('worktree:register', async (_event, folderPath: string): Promise<OpenedFolder | null> => {
    if (!knownWorktreePaths.has(folderPath)) return null;
    return register(folderPath, false);
  });

  ipcMain.handle('folder:load', async (_event, folderId: string): Promise<DirEntry[]> => {
    const root = getFolderRoot(folderId);
    // Read the root first. A failure then leaves no watcher behind.
    const entries = await listDir(root, '');
    startWatching(folderId, root, sendFileChange);
    return entries;
  });
```

- [ ] **Step 3: Expose the calls in the preload**

In `desktop/src/preload/preload.ts`, add `WorktreeInfo` to the type import, and
add to `bridge`:

```ts
  listWorktrees: (folderId: string): Promise<WorktreeInfo[]> =>
    ipcRenderer.invoke('worktree:list', folderId),

  registerWorktree: (folderPath: string): Promise<OpenedFolder | null> =>
    ipcRenderer.invoke('worktree:register', folderPath),

  loadFolder: (folderId: string): Promise<DirEntry[]> =>
    ipcRenderer.invoke('folder:load', folderId),
```

- [ ] **Step 4: Update the bridge key test**

In `test/desktop-smoke.test.ts`, the test named
`exposes the filesystem bridge to the renderer` asserts the exact key list.
Replace its expected array with:

```ts
    assert.deepEqual(keys, [
      'closeFolder',
      'listDir',
      'listWorktrees',
      'loadFolder',
      'loadSession',
      'onFileChanged',
      'openFolderDialog',
      'readFile',
      'registerWorktree',
      'reopenFolder',
      'retryFolder',
      'saveSession',
    ]);
```

- [ ] **Step 5: Add an Electron test for the new calls**

Append to `test/desktop-smoke.test.ts`, before the final `export` line. The
test builds a real repository, so it does not need a committed fixture:

```ts
describe('worktree bridge calls', () => {
  let app: ElectronApplication;
  let window: Page;
  let base: string;
  let repo: string;
  let linked: string;

  before(async () => {
    const { execFileSync } = await import('node:child_process');
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'docmd-wt-')));
    repo = path.join(base, 'repo');
    linked = path.join(base, 'feature-a');

    const git = (cwd: string, ...args: string[]): void => {
      execFileSync('git', args, { cwd, stdio: 'ignore' });
    };
    await fs.mkdir(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    await fs.writeFile(path.join(repo, 'README.md'), '# Repo main\n', 'utf8');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'feature-a');

    app = await launchApp();
    window = await app.firstWindow();
    await window.waitForSelector('#landing', { state: 'visible' });
    await stubFolderPaths(app, [repo]);
  });

  after(async () => {
    await app?.close();
    await fs.rm(base, { recursive: true, force: true });
  });

  it('reports repoKey and branch when the folder opens', async () => {
    const folder = await window.evaluate(() => window.desktop.openFolderDialog());
    assert.equal(folder?.branch, 'main');
    assert.ok(folder?.repoKey?.endsWith('/.git'), 'repoKey should be the git common directory');
  });

  it('lists both worktrees and registers one without a watcher', async () => {
    const result = await window.evaluate(async (linkedPath) => {
      const folder = await window.desktop.openFolderDialog();
      const list = await window.desktop.listWorktrees(folder!.id);
      const registered = await window.desktop.registerWorktree(linkedPath);
      return {
        branches: list.map((w) => w.branch),
        registeredBranch: registered?.branch ?? null,
      };
    }, linked);

    assert.deepEqual(result.branches, ['main', 'feature-a']);
    assert.equal(result.registeredBranch, 'feature-a');
  });

  it('refuses a path that git did not report', async () => {
    const refused = await window.evaluate(
      (target) => window.desktop.registerWorktree(target),
      path.join(fixtures, 'alpha'),
    );
    assert.equal(refused, null, 'renderer must not name an arbitrary path');
  });

  it('reads the root only when loadFolder runs', async () => {
    const names = await window.evaluate(async (linkedPath) => {
      const registered = await window.desktop.registerWorktree(linkedPath);
      const entries = await window.desktop.loadFolder(registered!.id);
      return entries.map((entry) => entry.name);
    }, linked);

    assert.deepEqual(names, ['README.md']);
  });
});
```

- [ ] **Step 6: Build and run**

Run: `npm run build:desktop && node --test test/desktop-smoke.test.ts`
Expected: PASS — the earlier tests and the four new ones.

- [ ] **Step 7: Commit**

```bash
git add desktop/src/main/ipc.ts desktop/types/ipc.ts desktop/src/preload/preload.ts test/desktop-smoke.test.ts
git commit -m "feat(desktop): expose worktree list, register, and lazy load over IPC"
```

---

### Task 4: The user interface

**Files:**
- Modify: `desktop/src/renderer/folder-tabs.ts`
- Create: `desktop/src/renderer/worktree-select.ts`
- Modify: `desktop/src/renderer/main.ts`
- Modify: `desktop/src/renderer/index.html`
- Modify: `desktop/src/renderer/workspace.css`
- Modify: `test/desktop-smoke.test.ts`

**Interfaces:**
- Consumes: `groupByRepo`, `RepoGroup`, `setFolderLoaded`, `addFolder` options from Task 2; `listWorktrees`, `registerWorktree`, `loadFolder` from Task 3.
- Produces: `renderWorktreeSelect(container, model, handlers)` where
  `handlers = { onSelect(folderId: string): void }`.

- [ ] **Step 1: Add the dropdown container to the page**

In `desktop/src/renderer/index.html`, put the dropdown above the file tree:

```html
      <div id="sidebar" class="sidebar">
        <div id="worktree-select" class="worktree-select" hidden></div>
        <div id="file-tree" class="file-tree"></div>
      </div>
```

- [ ] **Step 2: Group the folder tabs by repository**

In `desktop/src/renderer/folder-tabs.ts`, change the import and the loop. The
tab now stands for a repository. Clicking it activates the folder that was
active in that repository, or the first folder of the group.

```ts
import { groupByRepo, type WorkspaceModel } from './workspace-model.ts';
```

Replace the `for (const folder of folders)` loop with:

```ts
  for (const group of groupByRepo(folders)) {
    // Show the worktree that is active, else the first one in the group.
    const shown = group.folders.find((f) => f.id === activeFolderId) ?? group.folders[0];
    const isActive = group.folders.some((f) => f.id === activeFolderId);

    const tab = document.createElement('div');
    tab.className = 'folder-tab';
    tab.dataset.folderId = shown.id;
    tab.dataset.repoKey = group.key;
    tab.dataset.active = String(isActive);
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(isActive));
    tab.title = shown.path;

    const label = document.createElement('span');
    label.className = 'folder-tab-label';
    label.textContent = group.label;
    if (shown.status === 'unavailable') {
      tab.dataset.status = 'unavailable';
      tab.title = `${shown.path} (unavailable)`;
      label.textContent = `${group.label} (unavailable)`;
    }
    label.addEventListener('click', () => handlers.onActivate(shown.id));

    const close = document.createElement('button');
    close.className = 'folder-tab-close';
    close.type = 'button';
    close.textContent = '✕';
    close.setAttribute('aria-label', `Close ${group.label}`);
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      // Closing a repository closes every worktree in it.
      for (const folder of group.folders) handlers.onClose(folder.id);
    });

    tab.append(label, close);
    container.append(tab);
  }
```

- [ ] **Step 3: Write the dropdown**

Create `desktop/src/renderer/worktree-select.ts`:

```ts
import { groupByRepo, type WorkspaceModel } from './workspace-model.ts';

export interface WorktreeSelectHandlers {
  onSelect(folderId: string): void;
}

function labelFor(branch: string | null, name: string): string {
  return branch ?? `${name} (no branch)`;
}

export function renderWorktreeSelect(
  container: HTMLElement,
  model: WorkspaceModel,
  handlers: WorktreeSelectHandlers,
): void {
  container.replaceChildren();

  const active = model.getActiveFolder();
  const group = active
    ? groupByRepo(model.getState().folders).find((g) => g.folders.some((f) => f.id === active.id))
    : undefined;

  // Hide for a plain folder, and for a repository with one worktree.
  if (!active || !active.repoKey || !group || group.folders.length < 2) {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  const select = document.createElement('select');
  select.id = 'worktree-select-control';
  select.className = 'worktree-select-control';
  select.setAttribute('aria-label', 'Change worktree');

  for (const folder of group.folders) {
    const option = document.createElement('option');
    option.value = folder.id;
    option.textContent = labelFor(folder.branch, folder.name);
    option.selected = folder.id === active.id;
    if (folder.status === 'unavailable') {
      option.textContent = `${option.textContent} (unavailable)`;
    }
    select.append(option);
  }

  select.addEventListener('change', () => handlers.onSelect(select.value));
  container.append(select);
}
```

- [ ] **Step 4: Style the dropdown**

Append to `desktop/src/renderer/workspace.css`:

```css
.worktree-select {
  padding: 6px 8px;
  border-bottom: 1px solid var(--mv-border, #e1e4e8);
}
.worktree-select-control {
  width: 100%;
  font-size: 12px;
  padding: 4px 6px;
  border: 1px solid var(--mv-border, #e1e4e8);
  border-radius: 6px;
  background: var(--mv-bg, #fff);
  color: var(--mv-text, #1f2328);
}
```

- [ ] **Step 5: Find the worktrees on open, and load one on select**

In `desktop/src/renderer/main.ts`, add the imports:

```ts
import { renderWorktreeSelect } from './worktree-select.ts';
```

Add the DOM reference beside the others:

```ts
const $worktreeSelect = document.getElementById('worktree-select')!;
```

Change `openFolder` so it records the git fields and then adds the other
worktrees:

```ts
async function openFolder(): Promise<void> {
  const folder = await window.desktop.openFolderDialog();
  if (!folder) return;
  model.addFolder(folder, {
    repoKey: folder.repoKey,
    branch: folder.branch,
    loaded: true,
  });

  try {
    const entries = await window.desktop.listDir(folder.id, '');
    model.setTree(folder.id, entries);
  } catch {
    model.setFolderStatus(folder.id, 'unavailable');
  }

  await addSiblingWorktrees(folder.id, folder.path);
}

/**
 * Add the other worktrees of this repository without reading them.
 *
 * Each one gets loaded: false. loadFolderIfNeeded reads the tree and starts the
 * watcher when you select it, so a repository with 10 worktrees uses 1 watcher.
 */
async function addSiblingWorktrees(folderId: string, folderPath: string): Promise<void> {
  const worktrees = await window.desktop.listWorktrees(folderId);
  for (const worktree of worktrees) {
    if (worktree.path === folderPath) continue;
    const registered = await window.desktop.registerWorktree(worktree.path);
    if (!registered) continue;
    model.addFolder(registered, {
      activate: false,
      repoKey: registered.repoKey,
      branch: worktree.branch,
      loaded: false,
    });
    if (worktree.prunable) model.setFolderStatus(registered.id, 'unavailable');
  }
}

async function loadFolderIfNeeded(folderId: string): Promise<void> {
  const folder = model.getFolder(folderId);
  if (!folder || folder.loaded) return;

  try {
    model.setTree(folderId, await window.desktop.loadFolder(folderId));
    model.setFolderLoaded(folderId, true);
  } catch {
    model.setFolderStatus(folderId, 'unavailable');
  }
}
```

Add the dropdown to `render()`, after `renderFileTree(...)`:

```ts
  renderWorktreeSelect($worktreeSelect, model, {
    onSelect: (folderId) => {
      model.activateFolder(folderId);
      void loadFolderIfNeeded(folderId);
    },
  });
```

Change the folder tab handler so activating a repository tab also loads its
worktree:

```ts
  renderFolderTabs($folderTabs, model, {
    onActivate: (folderId) => {
      model.activateFolder(folderId);
      void loadFolderIfNeeded(folderId);
    },
    onClose: closeFolder,
    onAdd: () => { void openFolder(); },
  });
```

Session restore must keep the grouping. In `restoreSession`, pass the git
fields that `reopenFolder` now returns:

```ts
      model.addFolder(folder, {
        repoKey: folder.repoKey,
        branch: folder.branch,
        loaded: true,
      });
```

Do **not** call `addSiblingWorktrees` in `restoreSession`. A worktree that you
closed must stay closed.

- [ ] **Step 6: Write the Electron tests**

Append to `test/desktop-smoke.test.ts`, before the final `export` line:

```ts
describe('worktree user interface', () => {
  let app: ElectronApplication;
  let window: Page;
  let base: string;
  let repo: string;

  before(async () => {
    const { execFileSync } = await import('node:child_process');
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'docmd-wtui-')));
    repo = path.join(base, 'repo');

    const git = (cwd: string, ...args: string[]): void => {
      execFileSync('git', args, { cwd, stdio: 'ignore' });
    };
    await fs.mkdir(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    await fs.writeFile(path.join(repo, 'README.md'), '# Repo main\n', 'utf8');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
    git(repo, 'worktree', 'add', '-q', path.join(base, 'feature-a'), '-b', 'feature-a');
    await fs.writeFile(path.join(base, 'feature-a', 'ONLY-A.md'), '# Only on A\n', 'utf8');

    app = await launchApp();
    window = await app.firstWindow();
    await window.waitForSelector('#landing', { state: 'visible' });
    await stubFolderPaths(app, [repo, path.join(fixtures, 'alpha')]);
  });

  after(async () => {
    await app?.close();
    await fs.rm(base, { recursive: true, force: true });
  });

  it('shows one repository tab for two worktrees', async () => {
    await window.click('#open-folder');
    await window.waitForSelector('.tree-row[data-rel-path="README.md"]');
    await window.waitForSelector('#worktree-select-control');

    assert.equal((await window.$$('.folder-tab')).length, 1, 'two worktrees, one tab');
    assert.equal(await window.textContent('.folder-tab-label'), 'repo');
  });

  it('lists both branches in the dropdown', async () => {
    const options = await window.$$eval('#worktree-select-control option', (nodes) =>
      nodes.map((n) => n.textContent));
    assert.deepEqual(options, ['main', 'feature-a']);
  });

  it('changes the tree when you select the other worktree', async () => {
    // ONLY-A.md exists on feature-a and not on main.
    assert.equal(await window.$('.tree-row[data-rel-path="ONLY-A.md"]'), null);

    await window.selectOption('#worktree-select-control', { label: 'feature-a' });
    await window.waitForSelector('.tree-row[data-rel-path="ONLY-A.md"]');
  });

  it('keeps the file tabs of each worktree apart', async () => {
    await window.click('.tree-row[data-rel-path="ONLY-A.md"]');
    await window.waitForSelector('.file-tab[data-rel-path="ONLY-A.md"]');

    await window.selectOption('#worktree-select-control', { label: 'main' });
    await window.waitForSelector('.tree-row[data-rel-path="README.md"]');
    assert.equal((await window.$$('.file-tab')).length, 0, 'main has no tab open yet');

    await window.selectOption('#worktree-select-control', { label: 'feature-a' });
    await window.waitForSelector('.file-tab[data-rel-path="ONLY-A.md"]');
  });

  it('hides the dropdown for a folder that is not a repository', async () => {
    await window.click('#folder-tab-add');
    await window.waitForSelector('.folder-tab:nth-of-type(2)');
    await window.waitForSelector('.tree-row[data-rel-path="README.md"]');
    assert.equal(await window.isVisible('#worktree-select'), false);
  });
});
```

- [ ] **Step 7: Build and run every desktop test**

Run:

```bash
npm run build:desktop
node --test test/desktop-git-worktrees.test.ts test/desktop-workspace-fs.test.ts \
  test/desktop-workspace-model.test.ts test/desktop-viewer-pool.test.ts \
  test/desktop-file-watcher.test.ts test/desktop-session-store.test.ts \
  test/desktop-smoke.test.ts
```

Expected: PASS, no failures.

- [ ] **Step 8: Check the types and the extension builds**

Run:

```bash
npx tsc --noEmit    # after you remove ignoreDeprecations; restore the file after
npm run build:chrome
```

Expected: zero errors whose path starts with `desktop/`; the Chrome build ends
with `Build complete`.

- [ ] **Step 9: Commit**

```bash
git add desktop/src/renderer desktop/src/renderer/index.html test/desktop-smoke.test.ts
git commit -m "feat(desktop): show one tab for each repository and a worktree dropdown"
```

---

## Self-Review

**Spec coverage.** Layout → Task 4 Steps 1–4. Data model → Task 2. `git-worktrees.ts` → Task 1. Record format and `repoKey` → Task 1 Step 3, including the `--path-format=absolute` reason and an older-git fallback. Open flow steps 1–4 → Task 4 Step 5 (`openFolder`, `addSiblingWorktrees`, `loadFolderIfNeeded`). Security → Task 3 Step 2 (`knownWorktreePaths`) with a test in Task 3 Step 5. Errors: git absent → Task 1 `git()` returns null; prunable → Task 4 Step 5 sets `unavailable`; bare → Task 3 Step 2 filter. Session → Task 4 Step 5 keeps `addSiblingWorktrees` out of `restoreSession`. Tests → Tasks 1, 2, 3, 4.

**Placeholder scan.** No TBD, no "handle errors", no "similar to Task N". Every code step has real code.

**Type consistency.** `WorktreeInfo` has the same five fields in Task 1 and Task 3. `repoKey` is `string | null` everywhere. `addFolder(folder, options)` in Task 2 matches every call in Task 4. `groupByRepo` returns `RepoGroup[]` in Task 2 and is used that way in Task 4. `loadFolder` is the bridge name; `loadFolderIfNeeded` is the renderer helper — different names on purpose, and both appear in the Interfaces blocks.

**Fixed during review.** Task 2 first wrote the group label as one unreadable expression. It now uses a named `repoLabel` helper. Task 3 changed `register` to `async`, so `folder:open` and `folder:reopen` both need `await`; the plan states this rather than leaving it to be discovered.

**One risk to watch.** Task 3 makes `register` call git twice for every folder, including plain folders and every session restore. Each call has a 2000 ms limit. If a restore of many folders feels slow, cache `repoKeyOf` by path inside `ipc.ts`. The plan does not add the cache, because the cost is unmeasured and YAGNI applies until it is.
