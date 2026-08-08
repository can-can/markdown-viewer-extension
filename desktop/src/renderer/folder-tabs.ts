import { groupByRepo, type WorkspaceModel } from './workspace-model.ts';

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

  for (const group of groupByRepo(folders)) {
    // Show the worktree that is active, else the first one in the group.
    const shown = group.folders.find((f) => f.id === activeFolderId) ?? group.folders[0];
    const isActive = group.folders.some((f) => f.id === activeFolderId);

    const tab = document.createElement('div');
    tab.className = 'folder-tab';
    tab.dataset.folderId = shown.id;
    tab.dataset.repoKey = group.key;
    tab.dataset.active = String(isActive);
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(isActive));
    tab.title = shown.path;

    const label = document.createElement('span');
    label.className = 'folder-tab-label';
    label.textContent = group.label;
    if (shown.status === 'unavailable') {
      tab.dataset.status = 'unavailable';
      tab.title = `${shown.path} (unavailable)`;
      label.textContent = `${group.label} (unavailable)`;
    }
    label.addEventListener('click', () => handlers.onActivate(shown.id));

    const close = document.createElement('button');
    close.className = 'folder-tab-close';
    close.type = 'button';
    close.textContent = '✕';
    close.setAttribute('aria-label', `Close ${group.label}`);
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      // Closing a repository closes every worktree in it.
      for (const folder of group.folders) handlers.onClose(folder.id);
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
