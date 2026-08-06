import { createWorkspaceModel, type TreeNode } from './workspace-model.ts';
import { renderFolderTabs } from './folder-tabs.ts';
import { renderFileTree } from './file-tree.ts';
import { renderFileTabs } from './file-tabs.ts';
import '../../types/ipc.ts';

const model = createWorkspaceModel();

const $landing = document.getElementById('landing')!;
const $workspace = document.getElementById('workspace')!;
const $folderTabs = document.getElementById('folder-tabs')!;
const $fileTree = document.getElementById('file-tree')!;
const $fileTabs = document.getElementById('file-tabs')!;
const $openFolder = document.getElementById('open-folder')!;

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
render();
