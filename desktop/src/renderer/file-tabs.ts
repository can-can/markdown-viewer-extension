import { getFileIcon } from '../../../chrome/src/workspace/file-icons.ts';
import type { WorkspaceModel } from './workspace-model.ts';

export interface FileTabHandlers {
  onActivate(folderId: string, relPath: string): void;
  onClose(folderId: string, relPath: string): void;
}

export function renderFileTabs(
  container: HTMLElement,
  model: WorkspaceModel,
  handlers: FileTabHandlers,
): void {
  container.replaceChildren();
  const folder = model.getActiveFolder();
  if (!folder) return;

  for (const tab of folder.tabs) {
    const isActive = folder.activeRelPath === tab.relPath;

    const el = document.createElement('div');
    el.className = 'file-tab';
    el.dataset.relPath = tab.relPath;
    el.dataset.active = String(isActive);
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(isActive));
    el.title = tab.relPath;

    const icon = document.createElement('span');
    icon.className = 'file-tab-icon';
    icon.innerHTML = getFileIcon(tab.name);

    const label = document.createElement('span');
    label.className = 'file-tab-label';
    label.textContent = tab.name;

    el.append(icon, label);
    el.addEventListener('click', () => handlers.onActivate(folder.id, tab.relPath));
    // Middle-click closes, matching browser and editor convention.
    el.addEventListener('auxclick', (event) => {
      if (event.button === 1) handlers.onClose(folder.id, tab.relPath);
    });

    const close = document.createElement('button');
    close.className = 'file-tab-close';
    close.type = 'button';
    close.textContent = '✕';
    close.setAttribute('aria-label', `Close ${tab.name}`);
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      handlers.onClose(folder.id, tab.relPath);
    });

    el.append(close);
    container.append(el);
  }
}
