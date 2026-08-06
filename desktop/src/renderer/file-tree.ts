import {
  chevronRight,
  chevronDown,
  folderClosed,
  folderOpen,
  getFileIcon,
} from '../../../chrome/src/workspace/file-icons.ts';
import type { FolderState, TreeNode, WorkspaceModel } from './workspace-model.ts';

export interface FileTreeHandlers {
  onOpenFile(folderId: string, relPath: string): void;
  onToggleDir(folderId: string, relPath: string): void;
}

function renderNode(
  node: TreeNode,
  folder: FolderState,
  depth: number,
  handlers: FileTreeHandlers,
): HTMLElement {
  const expanded = folder.expandedPaths.has(node.relPath);

  const row = document.createElement('div');
  row.className = 'tree-row';
  row.dataset.relPath = node.relPath;
  row.dataset.kind = node.kind;
  row.style.paddingLeft = `${8 + depth * 14}px`;

  const chevron = document.createElement('span');
  chevron.className = 'tree-chevron';
  chevron.innerHTML = node.kind === 'directory' ? (expanded ? chevronDown : chevronRight) : '';

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.innerHTML = node.kind === 'directory'
    ? (expanded ? folderOpen : folderClosed)
    : getFileIcon(node.name);

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = node.name;

  row.append(chevron, icon, label);

  if (node.kind === 'file' && folder.activeRelPath === node.relPath) {
    row.dataset.active = 'true';
  }

  row.addEventListener('click', () => {
    if (node.kind === 'directory') handlers.onToggleDir(folder.id, node.relPath);
    else handlers.onOpenFile(folder.id, node.relPath);
  });

  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node';
  wrapper.append(row);

  if (node.kind === 'directory' && expanded && node.children) {
    for (const child of node.children) {
      wrapper.append(renderNode(child, folder, depth + 1, handlers));
    }
  }

  return wrapper;
}

export function renderFileTree(
  container: HTMLElement,
  model: WorkspaceModel,
  handlers: FileTreeHandlers,
): void {
  container.replaceChildren();
  const folder = model.getActiveFolder();
  if (!folder) return;

  if (folder.status === 'unavailable') {
    const notice = document.createElement('div');
    notice.className = 'tree-notice';
    notice.textContent = 'This folder is no longer available.';
    container.append(notice);
    return;
  }

  for (const node of folder.tree) {
    container.append(renderNode(node, folder, 0, handlers));
  }
}
