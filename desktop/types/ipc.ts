export interface DirEntry {
  name: string;
  /** Path relative to the folder root, POSIX separators, '' for the root itself. */
  relPath: string;
  kind: 'file' | 'directory';
}

export interface OpenedFolder {
  id: string;
  /** Absolute path on disk. The renderer treats this as an opaque identifier. */
  path: string;
  name: string;
}

export type FileChangeKind =
  | 'change'
  | 'add'
  | 'unlink'
  | 'folder-unavailable'
  | 'watcher-error';

export interface FileChangeEvent {
  folderId: string;
  relPath: string;
  kind: FileChangeKind;
  /** Present for tree mutations; status events do not refer to an entry. */
  entryKind?: DirEntry['kind'];
}

export interface DesktopBridge {
  openFolderDialog(): Promise<OpenedFolder | null>;
  closeFolder(folderId: string): Promise<void>;
  /** Re-check an unavailable root and restart its watcher. */
  retryFolder(folderId: string): Promise<DirEntry[]>;
  listDir(folderId: string, relPath: string): Promise<DirEntry[]>;
  readFile(folderId: string, relPath: string, binary: boolean): Promise<string>;
  onFileChanged(handler: (event: FileChangeEvent) => void): () => void;
}

declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}
