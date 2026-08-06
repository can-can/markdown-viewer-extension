import { ipcMain, dialog, BrowserWindow } from 'electron';
import path from 'node:path';
import { listDir, readFile } from './workspace-fs.ts';
import type { DirEntry, OpenedFolder } from '../../types/ipc.ts';

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
  ipcMain.handle('folder:open', async (): Promise<OpenedFolder | null> => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      buttonLabel: 'Open Folder',
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const root = result.filePaths[0];
    const id = `f${++folderIdCounter}`;
    openFolders.set(id, root);
    return { id, path: root, name: path.basename(root) };
  });

  ipcMain.handle('folder:close', (_event, folderId: string): void => {
    openFolders.delete(folderId);
  });

  ipcMain.handle('fs:listDir', (_event, folderId: string, relPath: string): Promise<DirEntry[]> => {
    return listDir(getFolderRoot(folderId), relPath);
  });

  ipcMain.handle(
    'fs:readFile',
    (_event, folderId: string, relPath: string, binary: boolean): Promise<string> => {
      return readFile(getFolderRoot(folderId), relPath, binary);
    },
  );
}
