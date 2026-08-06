import { ipcMain, dialog, BrowserWindow } from 'electron';
import path from 'node:path';
import { listDir, readFile } from './workspace-fs.ts';
import { startWatching, stopWatching } from './file-watcher.ts';
import type { DirEntry, FileChangeEvent, OpenedFolder } from '../../types/ipc.ts';

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

export function registerIpcHandlers(win: BrowserWindow): void {
  const sendFileChange = (event: FileChangeEvent): void => {
    if (!win.isDestroyed()) win.webContents.send('fs:changed', event);
  };

  ipcMain.handle('folder:open', async (): Promise<OpenedFolder | null> => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      buttonLabel: 'Open Folder',
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const root = result.filePaths[0];
    const id = `f${++folderIdCounter}`;
    openFolders.set(id, root);
    startWatching(id, root, sendFileChange);
    return { id, path: root, name: path.basename(root) };
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
