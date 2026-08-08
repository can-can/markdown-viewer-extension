# Git Worktree Support — Design

**Date:** 2026-08-08
**Status:** Approved, ready for implementation planning

## Summary

When you open a folder that is part of a git repository, the desktop app finds
the other worktrees of that repository. The top row keeps one tab for each
repository. A dropdown at the top of the sidebar changes the worktree.

Each worktree keeps its own file tabs, its own tree, and its own scroll
position. The app reads a worktree and starts its file watcher only when you
select it.

Related design: `specs/2026-08-04-desktop-app-design.md`

## Motivation

A git worktree lets you keep more than one branch on disk at the same time. A
person who uses worktrees usually reads the same documents on different
branches.

Today the app treats each worktree as an unrelated folder. You must open each
one by hand, and the tabs show folder names such as `repo` and `repo-2`. Those
names do not tell you which branch you read.

## Decisions

| Decision | Choice |
|---|---|
| Top row | One tab for each repository, not for each worktree |
| Worktree control | A dropdown at the top of the sidebar |
| Plain folder | The dropdown is hidden |
| File tabs | Each worktree keeps its own file tabs |
| Read and watch | Only when you select the worktree |
| Repository tab label | The folder name of the main worktree |

## Layout

```
┌──────────────────────────────────────────────┐
│ [ docu.md ] [ notes ]                    [+] │ repositories
├────────────┬─────────────────────────────────┤
│ ⎇ main   ▾ │ README.md │ api.md          ✕  │ worktree + files
├────────────┤─────────────────────────────────┤
│ FILES      │                                 │
│ ▾ src      │   # API Reference               │
│   api.md   │                                 │
│ README.md  │                                 │
└────────────┴─────────────────────────────────┘

Open dropdown:
┌────────────────┐
│ ✓ ⎇ main       │
│   ⎇ feature-a  │
│   ⎇ detached   │
│   ⎇ old (gone) │
└────────────────┘
```

The dropdown is hidden when `repoKey` is `null`, and when the repository has
only one worktree.

## Data model

The folder list stays flat. This is the smallest change. The file tabs, the
viewer pool, the file watcher, and the session all work for each folder
already. Only the view groups the folders.

Each `FolderState` gets three new fields:

| Field | Type | Meaning |
|---|---|---|
| `repoKey` | `string \| null` | Absolute git common directory. All worktrees of one repository share it. `null` for a plain folder. |
| `branch` | `string \| null` | The branch name. `null` when the worktree has no branch. |
| `loaded` | `boolean` | `true` after the app reads the tree and starts the watcher. |

The top row shows one tab for each different `repoKey`. Folders with
`repoKey: null` each get their own tab. The dropdown shows the folders that
share the active `repoKey`.

### Only a worktree root joins a repository group

A folder gets a `repoKey` only when the folder path is itself a worktree root,
that is, when git reports that exact path in `git worktree list`.

`git rev-parse --git-common-dir` answers for **any** folder inside a
repository, because git walks up the directory tree. A folder inside a
repository is not a worktree. Without this rule, two unrelated subfolders of
one repository would collapse into a single repository tab, and the dropdown
would offer the repository root as if it were their sibling.

A folder inside a repository keeps `repoKey: null`. It gets its own tab and no
dropdown, exactly as before this feature.

git reports resolved paths. The app compares the folder path and its resolved
path against the worktree list, so a path through a symbolic link still
matches.

The repository tab label is the folder name of the main worktree. Git always
reports the main worktree first in `git worktree list --porcelain`.

## New module: git-worktrees.ts

`desktop/src/main/git-worktrees.ts` runs in the main process.

```ts
export interface WorktreeInfo {
  path: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  prunable: boolean;
}

export function parseWorktreeList(stdout: string): WorktreeInfo[];
export function listWorktrees(root: string): Promise<WorktreeInfo[]>;
export function repoKeyOf(root: string): Promise<string | null>;
```

`parseWorktreeList` is a pure function. It has no dependency on git, so the
tests do not need a repository.

### Record format

`git worktree list --porcelain` writes one record for each worktree. An empty
line separates the records. These lines are verified:

```
worktree /private/tmp/wt-demo/repo
HEAD 79bedb821d75f6fd620e660707e09df72a9fb34d
branch refs/heads/main

worktree /private/tmp/wt-demo/detached
HEAD 79bedb821d75f6fd620e660707e09df72a9fb34d
detached

worktree /private/tmp/wt-demo/feature-b
HEAD 79bedb821d75f6fd620e660707e09df72a9fb34d
branch refs/heads/feature-b
prunable gitdir file points to non-existent location
```

The parser removes the `refs/heads/` prefix from the branch. It sets `branch`
to `null` for a `detached` record. A `bare` record has no `HEAD` line.

### repoKey

`repoKeyOf` runs `git rev-parse --path-format=absolute --git-common-dir`.

The `--path-format=absolute` option is necessary. Plain `--git-common-dir`
returns `.git` from the main worktree, but an absolute path from a linked
worktree. The two values would not match, and the app would show two tabs for
one repository.

### Failure

`listWorktrees` and `repoKeyOf` return an empty result in these conditions:

- git is not installed
- the folder is not a git repository
- git does not answer in 2 seconds

The folder then behaves as it does today.

## How a folder opens

1. You select a folder. The app registers it, starts its watcher, and reads its
   tree. This is the behaviour that exists today. That folder gets
   `loaded: true`.
2. The app asks git for the worktrees of that repository.
3. The app adds every worktree except the one you selected. Each one gets
   `loaded: false`. The app does **not** read the tree. The app does **not**
   start a watcher.
   - The main worktree is one of these. If you select a linked worktree, the
     app adds the main worktree in the same way.
   - A folder that is already open is not added again. The folder list
     already rejects a path that it holds.
4. You select a worktree in the dropdown. Only then does the app read the tree,
   start the watcher, and set `loaded: true`.

A repository with 10 worktrees uses 1 watcher, not 10.

Step 3 runs only when you select a folder yourself. It does not run on session
restore. The Session section states why.

## Security

The renderer must not be able to name any path on disk. The filesystem work
established this rule: the renderer holds opaque folder ids only.

A new call `worktree:register` accepts a path. To keep the rule, the main
process stores the worktree paths that git reported, and accepts only those
paths. This is the same method that the session restore uses for
`folder:reopen`.

## Errors

| Condition | Result |
|---|---|
| git absent, or folder is not a repository | No dropdown. The folder works as today. |
| git does not answer in 2 seconds | The app continues with no worktrees. |
| Worktree folder deleted (prunable) | The dropdown marks it. If you select it, the folder shows the existing unavailable state and its Retry action. |
| Bare repository | The app ignores that record. A bare repository has no files. |
| Worktree deleted after the app opened it | The existing watcher and Retry behaviour applies. |

## Session

The session file keeps the folder paths only. It does not change.

On restart the app asks for `repoKey` for each restored folder, and groups the
tabs again. The app does **not** search for worktrees on restore. A worktree
that you closed stays closed.

## Tests

**Unit — `parseWorktreeList`** (no git needed)
- Many worktrees; the main worktree is first
- A `detached` record gives `branch: null`
- A `bare` record is marked
- A `prunable` record is marked
- Empty output gives an empty list
- Unknown lines do not stop the parse

**Integration — `listWorktrees` and `repoKeyOf`** (temporary repository)
- A repository with two added worktrees reports three records
- `repoKeyOf` returns the same value from the main worktree and from a linked
  worktree
- A folder that is not a repository returns an empty result

**Electron**
- A repository with three worktrees shows a dropdown with three branches
- A plain folder shows no dropdown
- A repository with one worktree shows no dropdown
- Selecting a worktree changes the tree
- Each worktree keeps its own file tabs across a change and back
- Only the selected worktree starts a watcher

## Out of scope

- Compare the same file on two branches at the same time
- Show the git status of a file in the tree
- Create, move, or delete a worktree
- Show the worktree of a repository that the app did not open
