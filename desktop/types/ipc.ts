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

/** One folder as it was left at the last shutdown. */
export interface PersistedFolder {
  path: string;
  tabs: string[];
  activeRelPath: string | null;
  expandedPaths: string[];
}

export interface PersistedSession {
  folders: PersistedFolder[];
  activeFolderPath: string | null;
}

export interface DesktopBridge {
  openFolderDialog(): Promise<OpenedFolder | null>;
  closeFolder(folderId: string): Promise<void>;
  /** Read the folders that were open at the last shutdown. */
  loadSession(): Promise<PersistedSession>;
  /** Record the current folders and tabs for the next start. */
  saveSession(session: PersistedSession): Promise<void>;
  /**
   * Open a folder from the loaded session without a dialog.
   *
   * The main process accepts only paths that came from the session file it
   * read at start, so the renderer still cannot name an arbitrary path.
   * Returns null if the path was not in that file.
   */
  reopenFolder(folderPath: string): Promise<OpenedFolder | null>;
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
