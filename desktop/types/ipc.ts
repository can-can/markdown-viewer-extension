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
  /** Absolute git common directory, or null when the folder is not a repository. */
  repoKey: string | null;
  /** Branch name, or null when there is no branch. */
  branch: string | null;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  prunable: boolean;
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

export type MenuAction = 'close-tab' | 'next-tab' | 'previous-tab' | 'open-folder';

export interface DesktopBridge {
  /** Menu commands, including the keyboard accelerators. */
  onMenuAction(handler: (action: MenuAction) => void): () => void;
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
  /** Worktrees of the repository that holds this folder. Bare records removed. */
  listWorktrees(folderId: string): Promise<WorktreeInfo[]>;
  /**
   * Register a worktree without a watcher and without reading its tree.
   * Accepts only a path that git reported this run.
   */
  registerWorktree(folderPath: string): Promise<OpenedFolder | null>;
  /** Start the watcher for a registered folder and read its root. */
  loadFolder(folderId: string): Promise<DirEntry[]>;
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
