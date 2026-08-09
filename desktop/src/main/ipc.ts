import { ipcMain, dialog, app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { listDir, readFile } from './workspace-fs.ts';
import { startWatching, stopWatching } from './file-watcher.ts';
import { listWorktrees, repoKeyOf } from './git-worktrees.ts';
import { readSession, writeSession, sessionFilePath } from './session-store.ts';
import type {
  DirEntry,
  FileChangeEvent,
  OpenedFolder,
  PersistedSession,
  WorktreeInfo,
} from '../../types/ipc.ts';

/**
 * folderId → absolute root path.
 *
 * The renderer only ever sees opaque ids, so it cannot ask for a path the user
 * has not opened through the native dialog.
 */
const openFolders = new Map<string, string>();
const folderRepoKeys = new Map<string, string | null>();
let folderIdCounter = 0;

export function getFolderRoot(folderId: string): string {
  const root = openFolders.get(folderId);
  if (!root) throw new Error(`ENOFOLDER: ${folderId}`);
  return root;
}

/**
 * Paths read from the session file at start.
 *
 * folder:reopen accepts only these. Without the check, a compromised renderer
 * could name any path on disk and defeat the opaque-id rule that folder:open
 * enforces.
 */
const restorablePaths = new Set<string>();

/**
 * Worktree paths that git reported this run.
 *
 * registerWorktree accepts only these. Without the check the renderer could
 * name any path and defeat the opaque-id rule that folder:open enforces.
 */
const knownWorktrees = new Map<string, { repoKey: string | null; branch: string | null }>();

export function registerIpcHandlers(win: BrowserWindow): void {
  const sendFileChange = (event: FileChangeEvent): void => {
    if (!win.isDestroyed()) win.webContents.send('fs:changed', event);
  };

  const register = async (
    root: string,
    watch = true,
    fallback?: { repoKey: string | null; branch: string | null },
  ): Promise<OpenedFolder> => {
    // Canonicalise once, here. git always reports resolved paths, so an
    // unresolved path from the dialog (for example /tmp vs /private/tmp) would
    // never match the worktree list, and the folder would be added a second
    // time as its own sibling.
    const canonical = await fs.realpath(root).catch(() => root);
    const id = `f${++folderIdCounter}`;
    openFolders.set(id, canonical);
    if (watch) startWatching(id, canonical, sendFileChange);
    // Only a worktree ROOT joins a repository group.
    //
    // A folder that merely sits inside a repository is not a worktree. Without
    // this check, two unrelated subfolders of one repository would collapse
    // into a single repository tab, and the dropdown would offer the repository
    // root as if it were their sibling.
    const self = (await listWorktrees(canonical)).find((w) => w.path === canonical);

    // A deleted worktree cannot run git. The caller then supplies what git
    // reported earlier, so the folder keeps its group instead of splitting off.
    const repoKey = self ? await repoKeyOf(canonical) : (fallback?.repoKey ?? null);
    const branch = self?.branch ?? fallback?.branch ?? null;
    folderRepoKeys.set(id, repoKey);
    return {
      id,
      path: canonical,
      name: path.basename(canonical),
      repoKey,
      branch,
    };
  };

  ipcMain.handle('folder:open', async (): Promise<OpenedFolder | null> => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      buttonLabel: 'Open Folder',
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    return await register(result.filePaths[0]);
  });

  ipcMain.handle('session:load', async (): Promise<PersistedSession> => {
    const state = await readSession(sessionFilePath(app.getPath('userData')));
    restorablePaths.clear();
    for (const folder of state?.folders ?? []) restorablePaths.add(folder.path);

    return {
      folders: state?.folders ?? [],
      activeFolderPath: state?.activeFolderPath ?? null,
    };
  });

  ipcMain.handle('session:save', async (_event, session: PersistedSession): Promise<void> => {
    // Keep restorable paths in step, so a folder opened this run can be
    // reopened after a reload without a fresh start.
    for (const folder of session.folders) restorablePaths.add(folder.path);

    await writeSession(sessionFilePath(app.getPath('userData')), {
      version: 1,
      folders: session.folders,
      activeFolderPath: session.activeFolderPath,
    });
  });

  ipcMain.handle('folder:reopen', async (
    _event,
    folderPath: string,
  ): Promise<OpenedFolder | null> => {
    if (!restorablePaths.has(folderPath)) return null;
    return await register(folderPath);
  });

  ipcMain.handle('worktree:list', async (
    _event,
    folderId: string,
  ): Promise<WorktreeInfo[]> => {
    // A bare repository has no files to read, so it is never a folder.
    const found = (await listWorktrees(getFolderRoot(folderId))).filter((w) => !w.bare);
    const repoKey = folderRepoKeys.get(folderId) ?? null;
    for (const worktree of found) {
      knownWorktrees.set(worktree.path, { repoKey, branch: worktree.branch });
    }
    return found;
  });

  ipcMain.handle('worktree:register', async (
    _event,
    folderPath: string,
  ): Promise<OpenedFolder | null> => {
    const known = knownWorktrees.get(folderPath);
    if (!known) return null;
    // The fallback keeps a prunable worktree grouped with its repository even
    // though git can no longer run inside the missing worktree directory.
    return await register(folderPath, false, known);
  });

  ipcMain.handle('folder:load', async (_event, folderId: string): Promise<DirEntry[]> => {
    const root = getFolderRoot(folderId);
    // Read the root first. A failure then leaves no watcher behind.
    const entries = await listDir(root, '');
    startWatching(folderId, root, sendFileChange);
    return entries;
  });

  ipcMain.handle('folder:close', (_event, folderId: string): void => {
    stopWatching(folderId);
    openFolders.delete(folderId);
    folderRepoKeys.delete(folderId);
  });

  ipcMain.handle('folder:retry', async (_event, folderId: string): Promise<DirEntry[]> => {
    const root = getFolderRoot(folderId);
    // Prove the root is readable before replacing a possibly degraded watcher.
    const entries = await listDir(root, '');
    startWatching(folderId, root, sendFileChange);
    return entries;
  });

  ipcMain.handle('fs:listDir', async (_event, folderId: string, relPath: string): Promise<DirEntry[]> => {
    try {
      return await listDir(getFolderRoot(folderId), relPath);
    } catch (error) {
      // A failed root listing means the open folder was removed, unmounted, or
      // became unreadable. Nested-directory races do not poison the folder.
      if (relPath === '') {
        sendFileChange({ folderId, relPath: '', kind: 'folder-unavailable' });
      }
      throw error;
    }
  });

  ipcMain.handle(
    'fs:readFile',
    (_event, folderId: string, relPath: string, binary: boolean): Promise<string> => {
      return readFile(getFolderRoot(folderId), relPath, binary);
    },
  );
}
