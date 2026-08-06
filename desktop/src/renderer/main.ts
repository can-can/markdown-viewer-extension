import { createWorkspaceModel, viewKey, type TreeNode } from './workspace-model.ts';
import { renderFolderTabs } from './folder-tabs.ts';
import { renderFileTree } from './file-tree.ts';
import { renderFileTabs } from './file-tabs.ts';
import { createViewerPool } from './viewer-pool.ts';
import { createIframeView } from './viewer-view.ts';
import '../../types/ipc.ts';

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
  model.removeFolder(folderId);
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
  });

  renderFileTabs($fileTabs, model, {
    onActivate: (folderId, relPath) => model.activateTab(folderId, relPath),
    onClose: (folderId, relPath) => model.closeTab(folderId, relPath),
  });

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
    return;
  }

  const relPath = folder.activeRelPath;
  const key = viewKey(folder.id, relPath);
  const tab = folder.tabs.find((candidate) => candidate.relPath === relPath);
  const needsRead = !pool.has(key) || tab?.dirty || lastActivatedKey !== key;
  if (!needsRead) return;

  const content = await window.desktop.readFile(folder.id, relPath, false);
  const activeFolder = model.getActiveFolder();
  if (
    run !== activationRun
    || activeFolder?.id !== folder.id
    || activeFolder.activeRelPath !== relPath
  ) {
    return;
  }

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

model.subscribe(render);
$openFolder.addEventListener('click', () => { void openFolder(); });
$viewerHost.addEventListener('desktop-viewer-navigate', (event) => {
  const { folderId, relPath } = (event as CustomEvent<{
    folderId: string;
    relPath: string;
  }>).detail;
  model.openTab(folderId, relPath);
});

render();
