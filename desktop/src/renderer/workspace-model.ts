import type { DirEntry, OpenedFolder } from '../../types/ipc.ts';

export interface TreeNode extends DirEntry {
  children?: TreeNode[];
  childrenLoaded?: boolean;
}

export interface Tab {
  relPath: string;
  name: string;
  /** Last known scroll line, restored when an evicted view is recreated. */
  scrollLine: number;
  /** Changed on disk while the view was evicted; re-read on next activation. */
  dirty: boolean;
}

export type FolderStatus = 'ready' | 'unavailable';

export interface FolderState {
  id: string;
  path: string;
  name: string;
  tree: TreeNode[];
  tabs: Tab[];
  activeRelPath: string | null;
  expandedPaths: Set<string>;
  status: FolderStatus;
}

export interface WorkspaceState {
  folders: FolderState[];
  activeFolderId: string | null;
}

export function viewKey(folderId: string, relPath: string): string {
  return `${folderId}:${relPath}`;
}

function basename(relPath: string): string {
  const index = relPath.lastIndexOf('/');
  return index === -1 ? relPath : relPath.slice(index + 1);
}

function parentPath(relPath: string): string {
  const index = relPath.lastIndexOf('/');
  return index === -1 ? '' : relPath.slice(0, index);
}

/** Depth-first search for a node by relative path. */
function findNode(nodes: TreeNode[], relPath: string): TreeNode | null {
  for (const node of nodes) {
    if (node.relPath === relPath) return node;
    if (node.children) {
      const found = findNode(node.children, relPath);
      if (found) return found;
    }
  }
  return null;
}

/** Directories first, then files, each alphabetical — mirrors listDir. */
function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

export interface WorkspaceModel {
  getState(): WorkspaceState;
  getFolder(folderId: string): FolderState | null;
  getActiveFolder(): FolderState | null;
  subscribe(listener: () => void): () => void;

  addFolder(folder: OpenedFolder): void;
  removeFolder(folderId: string): void;
  activateFolder(folderId: string): void;
  setFolderStatus(folderId: string, status: FolderStatus): void;

  openTab(folderId: string, relPath: string): void;
  closeTab(folderId: string, relPath: string): void;
  activateTab(folderId: string, relPath: string): void;
  markDirty(folderId: string, relPath: string, dirty: boolean): void;
  setScrollLine(folderId: string, relPath: string, line: number): void;

  setTree(folderId: string, nodes: DirEntry[]): void;
  setChildren(folderId: string, relPath: string, nodes: DirEntry[]): void;
  toggleExpanded(folderId: string, relPath: string): void;
  addNode(folderId: string, entry: DirEntry): void;
  removeNode(folderId: string, relPath: string): void;
}

export function createWorkspaceModel(): WorkspaceModel {
  const state: WorkspaceState = { folders: [], activeFolderId: null };
  const listeners = new Set<() => void>();

  const notify = (): void => { for (const listener of listeners) listener(); };
  const find = (folderId: string): FolderState | null =>
    state.folders.find((f) => f.id === folderId) ?? null;

  /** Siblings of relPath, or null when the parent has not been loaded. */
  const siblingsOf = (folder: FolderState, relPath: string): TreeNode[] | null => {
    const parent = parentPath(relPath);
    if (parent === '') return folder.tree;
    return findNode(folder.tree, parent)?.children ?? null;
  };

  return {
    getState: () => state,
    getFolder: find,
    getActiveFolder: () => (state.activeFolderId ? find(state.activeFolderId) : null),

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    addFolder(folder) {
      const existing = state.folders.find((f) => f.path === folder.path);
      if (existing) {
        state.activeFolderId = existing.id;
        notify();
        return;
      }
      state.folders.push({
        id: folder.id,
        path: folder.path,
        name: folder.name,
        tree: [],
        tabs: [],
        activeRelPath: null,
        expandedPaths: new Set(),
        status: 'ready',
      });
      state.activeFolderId = folder.id;
      notify();
    },

    removeFolder(folderId) {
      const index = state.folders.findIndex((f) => f.id === folderId);
      if (index === -1) return;
      state.folders.splice(index, 1);
      if (state.activeFolderId === folderId) {
        // Prefer the folder that shifted into this slot, else the one to its left.
        const neighbor = state.folders[index] ?? state.folders[index - 1] ?? null;
        state.activeFolderId = neighbor?.id ?? null;
      }
      notify();
    },

    activateFolder(folderId) {
      if (!find(folderId)) return;
      state.activeFolderId = folderId;
      notify();
    },

    setFolderStatus(folderId, status) {
      const folder = find(folderId);
      if (!folder) return;
      folder.status = status;
      notify();
    },

    openTab(folderId, relPath) {
      const folder = find(folderId);
      if (!folder) return;
      if (!folder.tabs.some((t) => t.relPath === relPath)) {
        folder.tabs.push({ relPath, name: basename(relPath), scrollLine: 1, dirty: false });
      }
      folder.activeRelPath = relPath;
      notify();
    },

    closeTab(folderId, relPath) {
      const folder = find(folderId);
      if (!folder) return;
      const index = folder.tabs.findIndex((t) => t.relPath === relPath);
      if (index === -1) return;
      folder.tabs.splice(index, 1);
      if (folder.activeRelPath === relPath) {
        // Prefer the right neighbor, fall back to the left.
        const neighbor = folder.tabs[index] ?? folder.tabs[index - 1] ?? null;
        folder.activeRelPath = neighbor?.relPath ?? null;
      }
      notify();
    },

    activateTab(folderId, relPath) {
      const folder = find(folderId);
      if (!folder || !folder.tabs.some((t) => t.relPath === relPath)) return;
      folder.activeRelPath = relPath;
      notify();
    },

    markDirty(folderId, relPath, dirty) {
      const tab = find(folderId)?.tabs.find((t) => t.relPath === relPath);
      if (!tab) return;
      tab.dirty = dirty;
      notify();
    },

    setScrollLine(folderId, relPath, line) {
      const tab = find(folderId)?.tabs.find((t) => t.relPath === relPath);
      if (!tab) return;
      // Deliberately no notify: scroll fires continuously and must not re-render.
      tab.scrollLine = line;
    },

    setTree(folderId, nodes) {
      const folder = find(folderId);
      if (!folder) return;
      folder.tree = nodes.map((n) => ({ ...n }));
      notify();
    },

    setChildren(folderId, relPath, nodes) {
      const folder = find(folderId);
      if (!folder) return;
      const node = findNode(folder.tree, relPath);
      if (!node) return;
      node.children = nodes.map((n) => ({ ...n }));
      node.childrenLoaded = true;
      notify();
    },

    toggleExpanded(folderId, relPath) {
      const folder = find(folderId);
      if (!folder) return;
      if (folder.expandedPaths.has(relPath)) folder.expandedPaths.delete(relPath);
      else folder.expandedPaths.add(relPath);
      notify();
    },

    addNode(folderId, entry) {
      const folder = find(folderId);
      if (!folder) return;
      // An unloaded parent needs no patch; its children load fresh on expand.
      const siblings = siblingsOf(folder, entry.relPath);
      if (!siblings) return;
      if (siblings.some((n) => n.relPath === entry.relPath)) return;
      siblings.push({ ...entry });
      sortNodes(siblings);
      notify();
    },

    removeNode(folderId, relPath) {
      const folder = find(folderId);
      if (!folder) return;
      const siblings = siblingsOf(folder, relPath);
      if (!siblings) return;
      const index = siblings.findIndex((n) => n.relPath === relPath);
      if (index === -1) return;
      siblings.splice(index, 1);
      notify();
    },
  };
}
