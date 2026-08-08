import { createWorkspaceModel, viewKey, type TreeNode } from './workspace-model.ts';
import { renderFolderTabs } from './folder-tabs.ts';
import { renderFileTree } from './file-tree.ts';
import { renderFileTabs } from './file-tabs.ts';
import { createViewerPool } from './viewer-pool.ts';
import { createIframeView } from './viewer-view.ts';
import type { FileChangeEvent, PersistedSession } from '../../types/ipc.ts';

const model = createWorkspaceModel();

const $landing = document.getElementById('landing')!;
const $workspace = document.getElementById('workspace')!;
const $folderTabs = document.getElementById('folder-tabs')!;
const $fileTree = document.getElementById('file-tree')!;
const $fileTabs = document.getElementById('file-tabs')!;
const $openFolder = document.getElementById('open-folder')!;
const $viewerHost = document.getElementById('viewer-host')!;

const pool = createViewerPool({
  capacity: 8,
  createView: (key) => {
    const [folderId, ...pathSegments] = key.split(':');
    return createIframeView($viewerHost, folderId, pathSegments.join(':'), key);
  },
});

const watcherNotices = new Map<string, string>();
const fileNotices = new Map<string, string>();
const reloadRuns = new Map<string, number>();

async function openFolder(): Promise<void> {
  const folder = await window.desktop.openFolderDialog();
  if (!folder) return;
  model.addFolder(folder);

  try {
    const entries = await window.desktop.listDir(folder.id, '');
    model.setTree(folder.id, entries);
  } catch {
    model.setFolderStatus(folder.id, 'unavailable');
  }
}

function closeFolder(folderId: string): void {
  void window.desktop.closeFolder(folderId);
  pool.evictFolder(folderId);
  watcherNotices.delete(folderId);
  for (const key of [...fileNotices.keys()]) {
    if (key.startsWith(`${folderId}:`)) fileNotices.delete(key);
  }
  for (const key of [...reloadRuns.keys()]) {
    if (key.startsWith(`${folderId}:`)) reloadRuns.delete(key);
  }
  model.removeFolder(folderId);
}

async function retryFolder(folderId: string): Promise<void> {
  const wasUnavailable = model.getFolder(folderId)?.status === 'unavailable';
  try {
    const entries = await window.desktop.retryFolder(folderId);
    watcherNotices.delete(folderId);
    if (wasUnavailable) {
      for (const tab of model.getFolder(folderId)?.tabs ?? []) {
        fileNotices.delete(viewKey(folderId, tab.relPath));
        // Rendering notifications are harmless while the folder is still in
        // its unavailable state; the final status change performs the read.
        model.markDirty(folderId, tab.relPath, true);
      }
    }
    model.setTree(folderId, entries);
    model.setFolderStatus(folderId, 'ready');
  } catch {
    model.setFolderStatus(folderId, 'unavailable');
  }
  refreshViewerBanner();
}

async function toggleDir(folderId: string, relPath: string): Promise<void> {
  const folder = model.getFolder(folderId);
  const node = folder ? findTreeNode(folder.tree, relPath) : null;

  // Load children the first time a directory is expanded, then reuse them.
  if (node && node.kind === 'directory' && !node.childrenLoaded) {
    try {
      const entries = await window.desktop.listDir(folderId, relPath);
      model.setChildren(folderId, relPath, entries);
    } catch {
      model.setFolderStatus(folderId, 'unavailable');
      return;
    }
  }

  model.toggleExpanded(folderId, relPath);
}

function render(): void {
  const { folders } = model.getState();
  const hasFolders = folders.length > 0;
  $landing.hidden = hasFolders;
  $workspace.hidden = !hasFolders;

  renderFolderTabs($folderTabs, model, {
    onActivate: (folderId) => model.activateFolder(folderId),
    onClose: closeFolder,
    onAdd: () => { void openFolder(); },
  });

  renderFileTree($fileTree, model, {
    onOpenFile: (folderId, relPath) => model.openTab(folderId, relPath),
    onToggleDir: (folderId, relPath) => { void toggleDir(folderId, relPath); },
    onRetryFolder: (folderId) => { void retryFolder(folderId); },
  });

  renderFileTabs($fileTabs, model, {
    onActivate: (folderId, relPath) => model.activateTab(folderId, relPath),
    onClose: closeFileTab,
  });

  refreshViewerBanner();
  void activateActiveTab();
}

let lastActivatedKey: string | null = null;
let activationRun = 0;

async function activateActiveTab(): Promise<void> {
  const run = ++activationRun;
  const folder = model.getActiveFolder();
  if (!folder || !folder.activeRelPath) {
    pool.deactivate();
    lastActivatedKey = null;
    refreshViewerBanner();
    return;
  }

  const relPath = folder.activeRelPath;
  const key = viewKey(folder.id, relPath);
  const tab = folder.tabs.find((candidate) => candidate.relPath === relPath);
  if (folder.status === 'unavailable' || fileNotices.has(key)) {
    pool.deactivate();
    lastActivatedKey = null;
    refreshViewerBanner();
    return;
  }

  const needsRead = !pool.has(key) || tab?.dirty || lastActivatedKey !== key;
  if (!needsRead) {
    refreshViewerBanner();
    return;
  }

  let content: string;
  try {
    content = await window.desktop.readFile(folder.id, relPath, false);
  } catch (error) {
    const activeFolder = model.getActiveFolder();
    if (
      run !== activationRun
      || activeFolder?.id !== folder.id
      || activeFolder.activeRelPath !== relPath
    ) {
      return;
    }
    fileNotices.set(key, fileReadErrorMessage(relPath, error));
    pool.deactivate();
    lastActivatedKey = null;
    refreshViewerBanner();
    return;
  }

  const activeFolder = model.getActiveFolder();
  if (
    run !== activationRun
    || activeFolder?.id !== folder.id
    || activeFolder.activeRelPath !== relPath
  ) {
    return;
  }

  fileNotices.delete(key);
  pool.activate(key, {
    content,
    filename: tab?.name ?? relPath,
    workspaceName: folder.name,
    workspaceFilePath: relPath,
    scrollLine: tab?.scrollLine,
  });
  // Set this before markDirty(), which notifies subscribers synchronously.
  lastActivatedKey = key;
  model.markDirty(folder.id, relPath, false);
}

function closeFileTab(folderId: string, relPath: string): void {
  fileNotices.delete(viewKey(folderId, relPath));
  model.closeTab(folderId, relPath);
}

function retryFile(folderId: string, relPath: string): void {
  fileNotices.delete(viewKey(folderId, relPath));
  model.markDirty(folderId, relPath, true);
}

function handleFileChanged(event: FileChangeEvent): void {
  const folder = model.getFolder(event.folderId);
  if (!folder) return;

  if (event.kind === 'folder-unavailable') {
    model.setFolderStatus(event.folderId, 'unavailable');
    return;
  }

  if (event.kind === 'watcher-error') {
    watcherNotices.set(
      event.folderId,
      `Live reload is unavailable for ${folder.name}. Files can still be opened normally.`,
    );
    refreshViewerBanner();
    return;
  }

  const entryKind = event.entryKind ?? 'file';
  const key = viewKey(event.folderId, event.relPath);
  const tab = folder.tabs.find((candidate) => candidate.relPath === event.relPath);

  if (event.kind === 'add') {
    fileNotices.delete(key);
    model.addNode(event.folderId, {
      name: event.relPath.split('/').pop() ?? event.relPath,
      relPath: event.relPath,
      kind: entryKind,
    });

    if (entryKind === 'directory' || !tab) return;
    if (pool.has(key)) void reloadView(event.folderId, event.relPath, key);
    else model.markDirty(event.folderId, event.relPath, true);
    return;
  }

  if (event.kind === 'unlink') {
    if (entryKind === 'file' && tab) {
      fileNotices.set(key, `${event.relPath} no longer exists on disk.`);
      model.markDirty(event.folderId, event.relPath, true);
      const active = model.getActiveFolder();
      if (active?.id === event.folderId && active.activeRelPath === event.relPath) {
        pool.deactivate();
        lastActivatedKey = null;
      }
    }
    model.removeNode(event.folderId, event.relPath);
    refreshViewerBanner();
    return;
  }

  // Some editors emit add→change in one debounce window for a newly created
  // file. addNode is idempotent, so a final change event can safely repair a
  // missing tree entry without rebuilding the tree.
  model.addNode(event.folderId, {
    name: event.relPath.split('/').pop() ?? event.relPath,
    relPath: event.relPath,
    kind: 'file',
  });

  if (!tab) return;
  if (!pool.has(key)) {
    // Evicted: re-read on next activation instead of paying for it now.
    model.markDirty(event.folderId, event.relPath, true);
    return;
  }

  void reloadView(event.folderId, event.relPath, key);
}

async function reloadView(folderId: string, relPath: string, key: string): Promise<void> {
  const folder = model.getFolder(folderId);
  const tab = folder?.tabs.find((candidate) => candidate.relPath === relPath);
  if (!folder || !tab) return;

  const run = (reloadRuns.get(key) ?? 0) + 1;
  reloadRuns.set(key, run);

  let content: string;
  try {
    content = await window.desktop.readFile(folderId, relPath, false);
  } catch (error) {
    if (reloadRuns.get(key) !== run) return;
    fileNotices.set(key, fileReadErrorMessage(relPath, error));
    const active = model.getActiveFolder();
    if (active?.id === folderId && active.activeRelPath === relPath) {
      pool.deactivate();
      lastActivatedKey = null;
      refreshViewerBanner();
    }
    return;
  }

  if (reloadRuns.get(key) !== run) return;
  const currentFolder = model.getFolder(folderId);
  const currentTab = currentFolder?.tabs.find((candidate) => candidate.relPath === relPath);
  const view = pool.acquire(key);
  if (!currentFolder || !currentTab || !view) return;

  fileNotices.delete(key);
  // Same document key means the iframe bridge sends UPDATE_CONTENT, preserving
  // viewer identity and scroll position.
  view.sync({
    content,
    filename: currentTab.name,
    workspaceName: currentFolder.name,
    workspaceFilePath: relPath,
  });
  model.markDirty(folderId, relPath, false);
  refreshViewerBanner();
}

function fileReadErrorMessage(relPath: string, error: unknown): string {
  return String(error).includes('ENOENT')
    ? `${relPath} no longer exists on disk.`
    : `Could not read ${relPath}.`;
}

function refreshViewerBanner(): void {
  const folder = model.getActiveFolder();
  if (!folder) {
    clearViewerBanner();
    return;
  }

  if (folder.status === 'unavailable') {
    showViewerBanner(
      `${folder.name} is no longer available.`,
      { label: 'Retry', run: () => { void retryFolder(folder.id); } },
    );
    return;
  }

  if (folder.activeRelPath) {
    const fileNotice = fileNotices.get(viewKey(folder.id, folder.activeRelPath));
    if (fileNotice) {
      showViewerBanner(
        fileNotice,
        {
          label: 'Retry file',
          run: () => retryFile(folder.id, folder.activeRelPath!),
        },
      );
      return;
    }
  }

  const watcherNotice = watcherNotices.get(folder.id);
  if (watcherNotice) {
    showViewerBanner(
      watcherNotice,
      { label: 'Retry watcher', run: () => { void retryFolder(folder.id); } },
    );
    return;
  }

  clearViewerBanner();
}

function showViewerBanner(
  message: string,
  action?: { label: string; run: () => void },
): void {
  let banner = document.getElementById('viewer-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'viewer-banner';
    banner.className = 'viewer-banner';
    $viewerHost.append(banner);
  }

  const text = document.createElement('span');
  text.className = 'viewer-banner-message';
  text.textContent = message;
  banner.replaceChildren(text);

  if (action) {
    const button = document.createElement('button');
    button.className = 'viewer-banner-action';
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', action.run);
    banner.append(button);
  }
  banner.hidden = false;
}

function clearViewerBanner(): void {
  const banner = document.getElementById('viewer-banner');
  if (banner) banner.hidden = true;
}

function findTreeNode(nodes: TreeNode[], relPath: string): TreeNode | null {
  for (const node of nodes) {
    if (node.relPath === relPath) return node;
    if (node.children) {
      const found = findTreeNode(node.children, relPath);
      if (found) return found;
    }
  }
  return null;
}

// ── Session persistence ─────────────────────────────────────────────

function snapshotSession(): PersistedSession {
  const { folders, activeFolderId } = model.getState();
  return {
    folders: folders.map((folder) => ({
      path: folder.path,
      tabs: folder.tabs.map((tab) => tab.relPath),
      activeRelPath: folder.activeRelPath,
      expandedPaths: [...folder.expandedPaths],
    })),
    activeFolderPath: folders.find((f) => f.id === activeFolderId)?.path ?? null,
  };
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let restoring = false;

function scheduleSessionSave(): void {
  // Restoring replays many mutations. Writing each one back would be noise,
  // and a failure part-way through would persist a half-built session.
  if (restoring) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void window.desktop.saveSession(snapshotSession()); }, 300);
}

/** Depth order, so a parent directory loads before its children. */
function byDepth(a: string, b: string): number {
  return a.split('/').length - b.split('/').length;
}

async function restoreSession(): Promise<void> {
  const session = await window.desktop.loadSession();
  if (session.folders.length === 0) return;

  restoring = true;
  try {
    for (const saved of session.folders) {
      const folder = await window.desktop.reopenFolder(saved.path);
      if (!folder) continue;
      model.addFolder(folder);

      try {
        model.setTree(folder.id, await window.desktop.listDir(folder.id, ''));
      } catch {
        // The folder moved or was unmounted. Task 10's Retry can recover it.
        model.setFolderStatus(folder.id, 'unavailable');
        continue;
      }

      for (const dir of [...new Set(saved.expandedPaths)].sort(byDepth)) {
        try {
          model.setChildren(folder.id, dir, await window.desktop.listDir(folder.id, dir));
          model.toggleExpanded(folder.id, dir);
        } catch {
          // That directory is gone. Leave the rest of the tree alone.
        }
      }

      for (const relPath of saved.tabs) model.openTab(folder.id, relPath);
      if (saved.activeRelPath) model.activateTab(folder.id, saved.activeRelPath);
    }

    const active = model.getState().folders.find((f) => f.path === session.activeFolderPath);
    if (active) model.activateFolder(active.id);
  } finally {
    restoring = false;
  }

  // One write to record whatever actually came back.
  scheduleSessionSave();
}

model.subscribe(render);
model.subscribe(scheduleSessionSave);
window.desktop.onFileChanged(handleFileChanged);
// Best effort flush, so a quit inside the debounce window is not lost.
window.addEventListener('beforeunload', () => {
  clearTimeout(saveTimer);
  void window.desktop.saveSession(snapshotSession());
});
$openFolder.addEventListener('click', () => { void openFolder(); });
$viewerHost.addEventListener('desktop-viewer-navigate', (event) => {
  const { folderId, relPath } = (event as CustomEvent<{
    folderId: string;
    relPath: string;
  }>).detail;
  model.openTab(folderId, relPath);
});

render();
void restoreSession();
