import { ipcMain, dialog, app, BrowserWindow } from 'electron';
import path from 'node:path';
import { listDir, readFile } from './workspace-fs.ts';
import { startWatching, stopWatching } from './file-watcher.ts';
import { readSession, writeSession, sessionFilePath } from './session-store.ts';
import type {
  DirEntry,
  FileChangeEvent,
  OpenedFolder,
  PersistedSession,
} from '../../types/ipc.ts';

/**
 * folderId → absolute root path.
 *
 * The renderer only ever sees opaque ids, so it cannot ask for a path the user
 * has not opened through the native dialog.
 */
const openFolders = new Map<string, string>();
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

export function registerIpcHandlers(win: BrowserWindow): void {
  const sendFileChange = (event: FileChangeEvent): void => {
    if (!win.isDestroyed()) win.webContents.send('fs:changed', event);
  };

  const register = (root: string): OpenedFolder => {
    const id = `f${++folderIdCounter}`;
    openFolders.set(id, root);
    startWatching(id, root, sendFileChange);
    return { id, path: root, name: path.basename(root) };
  };

  ipcMain.handle('folder:open', async (): Promise<OpenedFolder | null> => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      buttonLabel: 'Open Folder',
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    return register(result.filePaths[0]);
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

  ipcMain.handle('folder:reopen', (_event, folderPath: string): OpenedFolder | null => {
    if (!restorablePaths.has(folderPath)) return null;
    return register(folderPath);
  });

  ipcMain.handle('folder:close', (_event, folderId: string): void => {
    stopWatching(folderId);
    openFolders.delete(folderId);
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
