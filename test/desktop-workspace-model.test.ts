import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkspaceModel,
  groupByRepo,
  viewKey,
  type FolderState,
  type WorkspaceModel,
} from '../desktop/src/renderer/workspace-model.ts';

const alpha = { id: 'f1', path: '/tmp/alpha', name: 'alpha' };
const beta = { id: 'f2', path: '/tmp/beta', name: 'beta' };

describe('viewKey', () => {
  it('joins folder id and relative path', () => {
    assert.equal(viewKey('f1', 'docs/api.md'), 'f1:docs/api.md');
  });
});

describe('folders', () => {
  let model: WorkspaceModel;
  beforeEach(() => { model = createWorkspaceModel(); });

  it('starts empty with no active folder', () => {
    assert.deepEqual(model.getState().folders, []);
    assert.equal(model.getState().activeFolderId, null);
  });

  it('activates the first folder added', () => {
    model.addFolder(alpha);
    assert.equal(model.getState().activeFolderId, 'f1');
  });

  it('activates each newly added folder', () => {
    model.addFolder(alpha);
    model.addFolder(beta);
    assert.equal(model.getState().activeFolderId, 'f2');
    assert.deepEqual(model.getState().folders.map((f) => f.id), ['f1', 'f2']);
  });

  it('ignores a folder path that is already open, activating it instead', () => {
    model.addFolder(alpha);
    model.addFolder(beta);
    model.addFolder({ id: 'f3', path: '/tmp/alpha', name: 'alpha' });
    assert.deepEqual(model.getState().folders.map((f) => f.id), ['f1', 'f2']);
    assert.equal(model.getState().activeFolderId, 'f1');
  });

  it('activates the neighbor when the active folder is removed', () => {
    model.addFolder(alpha);
    model.addFolder(beta);
    model.removeFolder('f2');
    assert.equal(model.getState().activeFolderId, 'f1');
  });

  it('clears the active folder when the last one is removed', () => {
    model.addFolder(alpha);
    model.removeFolder('f1');
    assert.equal(model.getState().activeFolderId, null);
    assert.deepEqual(model.getState().folders, []);
  });

  it('leaves the active folder alone when a different folder is removed', () => {
    model.addFolder(alpha);
    model.addFolder(beta);
    model.activateFolder('f2');
    model.removeFolder('f1');
    assert.equal(model.getState().activeFolderId, 'f2');
  });
});

describe('tabs', () => {
  let model: WorkspaceModel;
  beforeEach(() => {
    model = createWorkspaceModel();
    model.addFolder(alpha);
    model.addFolder(beta);
  });

  it('opens a tab and makes it active', () => {
    model.openTab('f1', 'README.md');
    const folder = model.getFolder('f1')!;
    assert.deepEqual(folder.tabs.map((t) => t.relPath), ['README.md']);
    assert.equal(folder.activeRelPath, 'README.md');
  });

  it('derives the tab name from the relative path', () => {
    model.openTab('f1', 'docs/api.md');
    assert.equal(model.getFolder('f1')!.tabs[0].name, 'api.md');
  });

  it('activates the existing tab instead of duplicating', () => {
    model.openTab('f1', 'a.md');
    model.openTab('f1', 'b.md');
    model.openTab('f1', 'a.md');
    const folder = model.getFolder('f1')!;
    assert.deepEqual(folder.tabs.map((t) => t.relPath), ['a.md', 'b.md']);
    assert.equal(folder.activeRelPath, 'a.md');
  });

  it('keeps tabs isolated per folder', () => {
    model.openTab('f1', 'a.md');
    model.openTab('f2', 'z.md');
    assert.deepEqual(model.getFolder('f1')!.tabs.map((t) => t.relPath), ['a.md']);
    assert.deepEqual(model.getFolder('f2')!.tabs.map((t) => t.relPath), ['z.md']);
  });

  it('preserves each folder tab state across folder switches', () => {
    model.openTab('f1', 'a.md');
    model.openTab('f1', 'b.md');
    model.openTab('f2', 'z.md');
    model.activateFolder('f1');
    assert.equal(model.getFolder('f1')!.activeRelPath, 'b.md');
    model.activateFolder('f2');
    assert.equal(model.getFolder('f2')!.activeRelPath, 'z.md');
  });

  it('activates the right neighbor when the active tab is closed', () => {
    model.openTab('f1', 'a.md');
    model.openTab('f1', 'b.md');
    model.openTab('f1', 'c.md');
    model.activateTab('f1', 'b.md');
    model.closeTab('f1', 'b.md');
    assert.equal(model.getFolder('f1')!.activeRelPath, 'c.md');
  });

  it('activates the left neighbor when the last tab is closed', () => {
    model.openTab('f1', 'a.md');
    model.openTab('f1', 'b.md');
    model.closeTab('f1', 'b.md');
    assert.equal(model.getFolder('f1')!.activeRelPath, 'a.md');
  });

  it('clears the active tab when the only tab is closed', () => {
    model.openTab('f1', 'a.md');
    model.closeTab('f1', 'a.md');
    assert.equal(model.getFolder('f1')!.activeRelPath, null);
    assert.deepEqual(model.getFolder('f1')!.tabs, []);
  });

  it('leaves the active tab alone when a non-active tab is closed', () => {
    model.openTab('f1', 'a.md');
    model.openTab('f1', 'b.md');
    model.closeTab('f1', 'a.md');
    assert.equal(model.getFolder('f1')!.activeRelPath, 'b.md');
  });

  it('ignores activateTab for a file with no open tab', () => {
    model.openTab('f1', 'a.md');
    model.activateTab('f1', 'ghost.md');
    assert.equal(model.getFolder('f1')!.activeRelPath, 'a.md');
  });

  it('records a scroll line without notifying subscribers', () => {
    model.openTab('f1', 'a.md');
    let calls = 0;
    model.subscribe(() => { calls += 1; });
    model.setScrollLine('f1', 'a.md', 42);
    assert.equal(model.getFolder('f1')!.tabs[0].scrollLine, 42);
    assert.equal(calls, 0, 'scroll updates are high-frequency and must not re-render');
  });
});

describe('tree', () => {
  let model: WorkspaceModel;
  beforeEach(() => {
    model = createWorkspaceModel();
    model.addFolder(alpha);
    model.setTree('f1', [
      { name: 'docs', relPath: 'docs', kind: 'directory' },
      { name: 'README.md', relPath: 'README.md', kind: 'file' },
    ]);
  });

  it('stores the root tree', () => {
    assert.deepEqual(model.getFolder('f1')!.tree.map((n) => n.name), ['docs', 'README.md']);
  });

  it('attaches children to a directory node and marks it loaded', () => {
    model.setChildren('f1', 'docs', [{ name: 'api.md', relPath: 'docs/api.md', kind: 'file' }]);
    const docs = model.getFolder('f1')!.tree[0];
    assert.deepEqual(docs.children?.map((n) => n.name), ['api.md']);
    assert.equal(docs.childrenLoaded, true);
  });

  it('toggles expansion state', () => {
    assert.equal(model.getFolder('f1')!.expandedPaths.has('docs'), false);
    model.toggleExpanded('f1', 'docs');
    assert.equal(model.getFolder('f1')!.expandedPaths.has('docs'), true);
    model.toggleExpanded('f1', 'docs');
    assert.equal(model.getFolder('f1')!.expandedPaths.has('docs'), false);
  });

  it('preserves expansion state when a sibling node is added', () => {
    model.setChildren('f1', 'docs', [{ name: 'api.md', relPath: 'docs/api.md', kind: 'file' }]);
    model.toggleExpanded('f1', 'docs');
    model.addNode('f1', { name: 'CHANGELOG.md', relPath: 'CHANGELOG.md', kind: 'file' });
    assert.equal(model.getFolder('f1')!.expandedPaths.has('docs'), true);
    assert.deepEqual(
      model.getFolder('f1')!.tree.map((n) => n.name),
      ['docs', 'CHANGELOG.md', 'README.md'],
    );
  });

  it('adds a node into a loaded subdirectory', () => {
    model.setChildren('f1', 'docs', [{ name: 'api.md', relPath: 'docs/api.md', kind: 'file' }]);
    model.addNode('f1', { name: 'spec.md', relPath: 'docs/spec.md', kind: 'file' });
    assert.deepEqual(
      model.getFolder('f1')!.tree[0].children?.map((n) => n.name),
      ['api.md', 'spec.md'],
    );
  });

  it('ignores a node whose parent has not been loaded yet', () => {
    // 'docs' children are unloaded, so they will load fresh on expand anyway.
    assert.doesNotThrow(() =>
      model.addNode('f1', { name: 'api.md', relPath: 'docs/api.md', kind: 'file' }));
    assert.equal(model.getFolder('f1')!.tree[0].children, undefined);
  });

  it('ignores a duplicate node', () => {
    model.addNode('f1', { name: 'README.md', relPath: 'README.md', kind: 'file' });
    assert.equal(model.getFolder('f1')!.tree.length, 2);
  });

  it('removes a node without rebuilding the tree', () => {
    model.setChildren('f1', 'docs', [
      { name: 'api.md', relPath: 'docs/api.md', kind: 'file' },
      { name: 'spec.md', relPath: 'docs/spec.md', kind: 'file' },
    ]);
    model.removeNode('f1', 'docs/api.md');
    assert.deepEqual(
      model.getFolder('f1')!.tree[0].children?.map((n) => n.name),
      ['spec.md'],
    );
  });

  it('removes a root-level node', () => {
    model.removeNode('f1', 'README.md');
    assert.deepEqual(model.getFolder('f1')!.tree.map((n) => n.name), ['docs']);
  });
});

describe('dirty tracking', () => {
  it('marks and clears the dirty flag on a tab', () => {
    const model = createWorkspaceModel();
    model.addFolder(alpha);
    model.openTab('f1', 'a.md');
    assert.equal(model.getFolder('f1')!.tabs[0].dirty, false);
    model.markDirty('f1', 'a.md', true);
    assert.equal(model.getFolder('f1')!.tabs[0].dirty, true);
    model.markDirty('f1', 'a.md', false);
    assert.equal(model.getFolder('f1')!.tabs[0].dirty, false);
  });

  it('ignores a dirty mark for a file with no open tab', () => {
    const model = createWorkspaceModel();
    model.addFolder(alpha);
    assert.doesNotThrow(() => model.markDirty('f1', 'ghost.md', true));
  });
});

describe('folder status', () => {
  it('flips a folder to unavailable', () => {
    const model = createWorkspaceModel();
    model.addFolder(alpha);
    assert.equal(model.getFolder('f1')!.status, 'ready');
    model.setFolderStatus('f1', 'unavailable');
    assert.equal(model.getFolder('f1')!.status, 'unavailable');
  });
});

describe('worktree fields', () => {
  let model: WorkspaceModel;
  beforeEach(() => { model = createWorkspaceModel(); });

  it('defaults to no repository and loaded true', () => {
    model.addFolder(alpha);
    const folder = model.getFolder('f1')!;
    assert.equal(folder.repoKey, null);
    assert.equal(folder.branch, null);
    assert.equal(folder.loaded, true);
  });

  it('stores repoKey, branch, and loaded from the options', () => {
    model.addFolder(alpha, { repoKey: '/r/.git', branch: 'main', loaded: false });
    const folder = model.getFolder('f1')!;
    assert.equal(folder.repoKey, '/r/.git');
    assert.equal(folder.branch, 'main');
    assert.equal(folder.loaded, false);
  });

  it('does not activate a folder added with activate false', () => {
    model.addFolder(alpha);
    model.addFolder(beta, { activate: false });
    assert.equal(model.getState().activeFolderId, 'f1');
    assert.equal(model.getState().folders.length, 2);
  });

  it('sets the loaded flag later', () => {
    model.addFolder(alpha, { loaded: false });
    model.setFolderLoaded('f1', true);
    assert.equal(model.getFolder('f1')!.loaded, true);
  });

  it('ignores setFolderLoaded for an unknown folder', () => {
    assert.doesNotThrow(() => model.setFolderLoaded('nope', true));
  });
});

describe('groupByRepo', () => {
  const make = (id: string, folderPath: string, repoKey: string | null): FolderState => ({
    id,
    path: folderPath,
    name: folderPath.split('/').pop()!,
    tree: [],
    tabs: [],
    activeRelPath: null,
    expandedPaths: new Set(),
    status: 'ready',
    repoKey,
    branch: null,
    loaded: true,
  });

  it('puts worktrees of one repository in one group', () => {
    const groups = groupByRepo([
      make('f1', '/code/repo', '/code/repo/.git'),
      make('f2', '/code/feature-a', '/code/repo/.git'),
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].folders.map((f) => f.id), ['f1', 'f2']);
  });

  it('names the group after the main worktree, not the folder you opened', () => {
    // repoKey is <main worktree>/.git, so its parent directory names the group.
    const groups = groupByRepo([make('f2', '/code/feature-a', '/code/repo/.git')]);
    assert.equal(groups[0].label, 'repo');
  });

  it('gives a plain folder its own group named after the folder', () => {
    const groups = groupByRepo([make('f1', '/code/notes', null)]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].label, 'notes');
  });

  it('keeps two plain folders apart', () => {
    const groups = groupByRepo([
      make('f1', '/code/notes', null),
      make('f2', '/code/other', null),
    ]);
    assert.equal(groups.length, 2);
  });

  it('keeps two repositories apart', () => {
    const groups = groupByRepo([
      make('f1', '/a/repo', '/a/repo/.git'),
      make('f2', '/b/repo', '/b/repo/.git'),
    ]);
    assert.equal(groups.length, 2);
  });

  it('keeps the order in which the folders were added', () => {
    const groups = groupByRepo([
      make('f1', '/code/notes', null),
      make('f2', '/code/repo', '/code/repo/.git'),
      make('f3', '/code/feature-a', '/code/repo/.git'),
    ]);
    assert.deepEqual(groups.map((g) => g.label), ['notes', 'repo']);
  });
});

describe('subscribe', () => {
  it('notifies subscribers on every mutation', () => {
    const model = createWorkspaceModel();
    let calls = 0;
    model.subscribe(() => { calls += 1; });
    model.addFolder(alpha);
    model.openTab('f1', 'a.md');
    assert.equal(calls, 2);
  });

  it('stops notifying after unsubscribe', () => {
    const model = createWorkspaceModel();
    let calls = 0;
    const unsubscribe = model.subscribe(() => { calls += 1; });
    model.addFolder(alpha);
    unsubscribe();
    model.openTab('f1', 'a.md');
    assert.equal(calls, 1);
  });
});
