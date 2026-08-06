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

export type FileChangeKind = 'change' | 'add' | 'unlink';

export interface FileChangeEvent {
  folderId: string;
  relPath: string;
  kind: FileChangeKind;
}

export interface DesktopBridge {
  openFolderDialog(): Promise<OpenedFolder | null>;
  closeFolder(folderId: string): Promise<void>;
  listDir(folderId: string, relPath: string): Promise<DirEntry[]>;
  readFile(folderId: string, relPath: string, binary: boolean): Promise<string>;
  onFileChanged(handler: (event: FileChangeEvent) => void): () => void;
}

declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}
