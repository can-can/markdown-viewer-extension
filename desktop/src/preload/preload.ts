import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopBridge,
  DirEntry,
  FileChangeEvent,
  OpenedFolder,
  PersistedSession,
} from '../../types/ipc.ts';

const bridge: DesktopBridge = {
  openFolderDialog: (): Promise<OpenedFolder | null> => ipcRenderer.invoke('folder:open'),

  closeFolder: (folderId: string): Promise<void> => ipcRenderer.invoke('folder:close', folderId),

  loadSession: (): Promise<PersistedSession> => ipcRenderer.invoke('session:load'),

  saveSession: (session: PersistedSession): Promise<void> =>
    ipcRenderer.invoke('session:save', session),

  reopenFolder: (folderPath: string): Promise<OpenedFolder | null> =>
    ipcRenderer.invoke('folder:reopen', folderPath),

  retryFolder: (folderId: string): Promise<DirEntry[]> =>
    ipcRenderer.invoke('folder:retry', folderId),

  listDir: (folderId: string, relPath: string): Promise<DirEntry[]> =>
    ipcRenderer.invoke('fs:listDir', folderId, relPath),

  readFile: (folderId: string, relPath: string, binary: boolean): Promise<string> =>
    ipcRenderer.invoke('fs:readFile', folderId, relPath, binary),

  onFileChanged: (handler: (event: FileChangeEvent) => void): (() => void) => {
    const listener = (_event: unknown, payload: FileChangeEvent): void => handler(payload);
    ipcRenderer.on('fs:changed', listener);
    return () => {
      ipcRenderer.off('fs:changed', listener);
    };
  },
};

contextBridge.exposeInMainWorld('desktop', bridge);
