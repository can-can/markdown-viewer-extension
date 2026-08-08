import { groupByRepo, type WorkspaceModel } from './workspace-model.ts';

export interface WorktreeSelectHandlers {
  onSelect(folderId: string): void;
}

function labelFor(branch: string | null, name: string): string {
  return branch ?? `${name} (no branch)`;
}

export function renderWorktreeSelect(
  container: HTMLElement,
  model: WorkspaceModel,
  handlers: WorktreeSelectHandlers,
): void {
  container.replaceChildren();

  const active = model.getActiveFolder();
  const group = active
    ? groupByRepo(model.getState().folders).find(
      (candidate) => candidate.folders.some((folder) => folder.id === active.id),
    )
    : undefined;

  // Hide for a plain folder, and for a repository with one worktree.
  if (!active || !active.repoKey || !group || group.folders.length < 2) {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  const select = document.createElement('select');
  select.id = 'worktree-select-control';
  select.className = 'worktree-select-control';
  select.setAttribute('aria-label', 'Change worktree');

  for (const folder of group.folders) {
    const option = document.createElement('option');
    option.value = folder.id;
    option.textContent = labelFor(folder.branch, folder.name);
    option.selected = folder.id === active.id;
    if (folder.status === 'unavailable') {
      option.textContent = `${option.textContent} (unavailable)`;
    }
    select.append(option);
  }

  select.addEventListener('change', () => handlers.onSelect(select.value));
  container.append(select);
}
