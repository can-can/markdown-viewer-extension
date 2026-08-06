import type { WorkspaceModel } from './workspace-model.ts';

export interface FolderTabHandlers {
  onActivate(folderId: string): void;
  onClose(folderId: string): void;
  onAdd(): void;
}

export function renderFolderTabs(
  container: HTMLElement,
  model: WorkspaceModel,
  handlers: FolderTabHandlers,
): void {
  const { folders, activeFolderId } = model.getState();
  container.replaceChildren();

  for (const folder of folders) {
    const tab = document.createElement('div');
    tab.className = 'folder-tab';
    tab.dataset.folderId = folder.id;
    tab.dataset.active = String(folder.id === activeFolderId);
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(folder.id === activeFolderId));
    tab.title = folder.path;

    const label = document.createElement('span');
    label.className = 'folder-tab-label';
    label.textContent = folder.name;
    if (folder.status === 'unavailable') {
      tab.dataset.status = 'unavailable';
      tab.title = `${folder.path} (unavailable)`;
    }
    label.addEventListener('click', () => handlers.onActivate(folder.id));

    const close = document.createElement('button');
    close.className = 'folder-tab-close';
    close.type = 'button';
    close.textContent = '✕';
    close.setAttribute('aria-label', `Close ${folder.name}`);
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      handlers.onClose(folder.id);
    });

    tab.append(label, close);
    container.append(tab);
  }

  const add = document.createElement('button');
  add.className = 'folder-tab-add';
  add.id = 'folder-tab-add';
  add.type = 'button';
  add.textContent = '+';
  add.setAttribute('aria-label', 'Open folder');
  add.addEventListener('click', () => handlers.onAdd());
  container.append(add);
}
