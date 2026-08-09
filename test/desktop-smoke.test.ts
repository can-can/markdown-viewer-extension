import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(projectRoot, 'test/fixtures/desktop');

/**
 * Each describe block gets its own app instance. The app accumulates state
 * (open folders, open tabs), so sharing one instance would make tests
 * order-dependent.
 *
 * Each launch also gets its own user-data directory. The app now writes a
 * session file there, so a shared directory would let one test restore another
 * test's folders — and would write into the real application data of whoever
 * runs the suite. Pass the same directory twice to test restore across a
 * restart.
 */
async function launchApp(userDataDir?: string): Promise<ElectronApplication> {
  const dir = userDataDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'docmd-userdata-'));
  return electron.launch({
    args: [path.join(projectRoot, 'dist/desktop/main.cjs'), `--user-data-dir=${dir}`],
  });
}

/**
 * The native folder dialog cannot be driven from the renderer, so stub it in
 * the main process to hand back the given fixture folders in sequence.
 */
async function stubFolderDialog(app: ElectronApplication, folderNames: string[]): Promise<void> {
  await stubFolderPaths(app, folderNames.map((name) => path.join(fixtures, name)));
}

async function stubFolderPaths(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(async ({ dialog }, paths) => {
    let index = 0;
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [paths[Math.min(index++, paths.length - 1)]],
    });
  }, paths);
}

describe('desktop app launch', () => {
  let app: ElectronApplication;
  let window: Page;

  before(async () => { app = await launchApp(); window = await app.firstWindow(); });
  after(async () => { await app?.close(); });

  it('opens a window showing the landing state', async () => {
    await window.waitForSelector('#landing', { state: 'visible' });
    const text = await window.textContent('#landing');
    assert.match(text ?? '', /Open a folder/);
  });

  it('exposes the filesystem bridge to the renderer', async () => {
    const keys = await window.evaluate(() => Object.keys(window.desktop).sort());
    assert.deepEqual(keys, [
      'closeFolder',
      'listDir',
      'listWorktrees',
      'loadFolder',
      'loadSession',
      'onFileChanged',
      'onMenuAction',
      'openFolderDialog',
      'readFile',
      'registerWorktree',
      'reopenFolder',
      'retryFolder',
      'saveSession',
    ]);
  });

  it('reads a fixture file through the bridge', async () => {
    await stubFolderDialog(app, ['alpha']);
    const result = await window.evaluate(async () => {
      const folder = await window.desktop.openFolderDialog();
      if (!folder) return null;
      const entries = await window.desktop.listDir(folder.id, '');
      const content = await window.desktop.readFile(folder.id, 'README.md', false);
      return { names: entries.map((e) => e.name), content };
    });

    assert.deepEqual(result?.names, ['nested', 'diagram.md', 'notes.markdown', 'README.md']);
    assert.match(result?.content ?? '', /Alpha root document/);
  });
});

describe('folder tabs', () => {
  let app: ElectronApplication;
  let window: Page;

  before(async () => {
    app = await launchApp();
    window = await app.firstWindow();
    await window.waitForSelector('#landing', { state: 'visible' });
    await stubFolderDialog(app, ['alpha', 'beta']);
  });
  after(async () => { await app?.close(); });

  it('opens two folders as separate tabs', async () => {
    await window.click('#open-folder');
    await window.waitForSelector('.folder-tab[data-active="true"]');
    await window.click('#folder-tab-add');
    await window.waitForSelector('.folder-tab:nth-of-type(2)');

    const labels = await window.$$eval('.folder-tab-label', (nodes) =>
      nodes.map((n) => n.textContent));
    assert.deepEqual(labels, ['alpha', 'beta']);

    const active = await window.getAttribute('.folder-tab:nth-of-type(2)', 'data-active');
    assert.equal(active, 'true');
  });

  it('hides the landing state once a folder is open', async () => {
    assert.equal(await window.isVisible('#landing'), false);
    assert.equal(await window.isVisible('#workspace'), true);
  });

  it('expands a directory lazily and lists its children', async () => {
    await window.click('.folder-tab:nth-of-type(1) .folder-tab-label');
    await window.waitForSelector('.tree-row[data-rel-path="README.md"]');

    // 'nested' children are absent until the directory is expanded.
    assert.equal(await window.$('.tree-row[data-rel-path="nested/deep.md"]'), null);
    await window.click('.tree-row[data-rel-path="nested"]');
    await window.waitForSelector('.tree-row[data-rel-path="nested/deep.md"]');
  });

  it('keeps file tabs isolated per folder across folder switches', async () => {
    await window.click('.folder-tab:nth-of-type(1) .folder-tab-label');
    await window.click('.tree-row[data-rel-path="README.md"]');
    await window.waitForSelector('.file-tab[data-rel-path="README.md"]');

    await window.click('.folder-tab:nth-of-type(2) .folder-tab-label');
    await window.waitForSelector('.tree-row[data-rel-path="index.md"]');
    await window.click('.tree-row[data-rel-path="index.md"]');
    await window.waitForSelector('.file-tab[data-rel-path="index.md"]');

    assert.equal((await window.$$('.file-tab')).length, 1, 'beta shows only its own tab');

    await window.click('.folder-tab:nth-of-type(1) .folder-tab-label');
    await window.waitForSelector('.file-tab[data-rel-path="README.md"]');
    assert.equal((await window.$$('.file-tab')).length, 1, 'alpha shows only its own tab');
  });

  it('closes a folder tab and its files', async () => {
    await window.click('.folder-tab:nth-of-type(2) .folder-tab-close');
    await window.waitForFunction(() => document.querySelectorAll('.folder-tab').length === 1);
    const labels = await window.$$eval('.folder-tab-label', (nodes) =>
      nodes.map((n) => n.textContent));
    assert.deepEqual(labels, ['alpha']);
  });
});

describe('document rendering', () => {
  let app: ElectronApplication;
  let window: Page;

  before(async () => {
    app = await launchApp();
    window = await app.firstWindow();
    await window.waitForSelector('#landing', { state: 'visible' });
    await stubFolderDialog(app, ['alpha']);
    await window.click('#open-folder');
    await window.waitForSelector('.tree-row[data-rel-path="README.md"]');
  });
  after(async () => { await app?.close(); });

  it('renders a document in the active viewer iframe', async () => {
    await window.click('.tree-row[data-rel-path="README.md"]');

    const frame = await (await window.waitForSelector(
      'iframe[data-view-key$=":README.md"]',
    )).contentFrame();
    assert.ok(frame, 'active viewer iframe should have a content frame');
    await frame.waitForSelector('h1');
    assert.equal(await frame.textContent('h1'), 'Alpha');
  });

  it('renders a Mermaid diagram through the offscreen render frame', async () => {
    await window.click('.tree-row[data-rel-path="diagram.md"]');

    // Select by view key, not by data-active: the outgoing view can still be
    // marked active while the pool swaps, which would hand back the wrong frame.
    const frame = await (await window.waitForSelector(
      'iframe[data-view-key$=":diagram.md"]',
    )).contentFrame();
    assert.ok(frame, 'diagram viewer iframe should have a content frame');

    // Wait on the rendered marker, NOT on a bare 'svg' selector — toolbar icons
    // are SVGs and match instantly, which would pass before the diagram renders.
    const block = await frame.waitForSelector(
      '.diagram-block[data-plugin-type="mermaid"][data-plugin-rendered="true"]',
      { timeout: 30000 },
    );

    const imgSrc = await block.evaluate(
      (el) => el.querySelector('img')?.getAttribute('src')?.slice(0, 30) ?? '',
    );
    assert.match(
      imgSrc,
      /^data:image\/png;base64,/,
      'diagram should be a rendered PNG, not a placeholder',
    );
  });
});

describe('file watching and live reload', () => {
  let app: ElectronApplication;
  let window: Page;

  before(async () => {
    app = await launchApp();
    window = await app.firstWindow();
    await window.waitForSelector('#landing', { state: 'visible' });
    await stubFolderDialog(app, ['alpha']);
    await window.click('#open-folder');
    await window.waitForSelector('.tree-row[data-rel-path="README.md"]');
  });
  after(async () => { await app?.close(); });

  it('re-renders an open tab in its existing iframe when the file changes', async () => {
    const target = path.join(fixtures, 'alpha', 'README.md');
    const original = await fs.readFile(target, 'utf8');

    try {
      await window.click('.tree-row[data-rel-path="README.md"]');
      const iframe = await window.waitForSelector('iframe[data-view-key$=":README.md"]');
      await iframe.evaluate((element) => { element.dataset.smokeIdentity = 'preserved'; });
      const frame = await iframe.contentFrame();
      assert.ok(frame, 'README viewer iframe should have a content frame');
      await frame.waitForSelector('h1');
      assert.equal(await frame.textContent('h1'), 'Alpha');

      await fs.writeFile(target, '# Alpha Reloaded\n\nUpdated on disk.\n', 'utf8');
      await frame.waitForFunction(
        () => document.querySelector('h1')?.textContent === 'Alpha Reloaded',
        undefined,
        { timeout: 5000 },
      );

      assert.equal(
        await window.getAttribute('iframe[data-view-key$=":README.md"]', 'data-smoke-identity'),
        'preserved',
        'live reload must reuse the existing iframe',
      );
    } finally {
      await fs.writeFile(target, original, 'utf8');
    }
  });
});

describe('deleted file state', () => {
  let app: ElectronApplication;
  let window: Page;

  before(async () => {
    app = await launchApp();
    window = await app.firstWindow();
    await window.waitForSelector('#landing', { state: 'visible' });
    await stubFolderDialog(app, ['alpha']);
    await window.click('#open-folder');
    await window.waitForSelector('.tree-row[data-rel-path="README.md"]');
  });
  after(async () => { await app?.close(); });

  it('removes the tree row but keeps the open tab with a banner', async () => {
    const target = path.join(fixtures, 'alpha', 'temp-doc.md');

    try {
      await fs.writeFile(target, '# Temp\n', 'utf8');
      await window.waitForSelector('.tree-row[data-rel-path="temp-doc.md"]');
      await window.click('.tree-row[data-rel-path="temp-doc.md"]');

      const frame = await (await window.waitForSelector(
        'iframe[data-view-key$=":temp-doc.md"]',
      )).contentFrame();
      assert.ok(frame, 'temporary document should have a content frame');
      await frame.waitForSelector('h1');

      await fs.rm(target);
      await window.waitForSelector(
        '.tree-row[data-rel-path="temp-doc.md"]',
        { state: 'detached' },
      );
      await window.waitForSelector('#viewer-banner', { state: 'visible' });

      assert.match(await window.textContent('#viewer-banner') ?? '', /no longer exists on disk/);
      assert.ok(
        await window.$('.file-tab[data-rel-path="temp-doc.md"]'),
        'the deleted file tab should remain open',
      );
    } finally {
      await fs.rm(target, { force: true });
    }
  });
});

describe('unavailable folder state', () => {
  let app: ElectronApplication;
  let window: Page;
  let tempRoot: string;

  before(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'documd-unavailable-'));
    await fs.writeFile(path.join(tempRoot, 'README.md'), '# Available\n', 'utf8');
    app = await launchApp();
    window = await app.firstWindow();
    await window.waitForSelector('#landing', { state: 'visible' });
    await stubFolderPaths(app, [tempRoot]);
    await window.click('#open-folder');
    await window.waitForSelector('.tree-row[data-rel-path="README.md"]');
  });
  after(async () => {
    await app?.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('marks a vanished folder unavailable and recovers through Retry', async () => {
    await fs.rm(tempRoot, { recursive: true });
    await window.waitForSelector('.folder-tab[data-status="unavailable"]');
    await window.waitForSelector('.tree-notice-action', { state: 'visible' });
    assert.match(await window.textContent('.folder-tab-label') ?? '', /unavailable/);

    await fs.mkdir(tempRoot, { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'README.md'), '# Restored\n', 'utf8');
    await window.click('.tree-notice-action');
    await window.waitForSelector('.tree-row[data-rel-path="README.md"]');
    await window.waitForFunction(
      () => !document.querySelector('.folder-tab')?.hasAttribute('data-status'),
    );
  });
});

describe('watcher failure notice', () => {
  let app: ElectronApplication;
  let window: Page;

  before(async () => {
    app = await launchApp();
    window = await app.firstWindow();
    await window.waitForSelector('#landing', { state: 'visible' });
    await stubFolderDialog(app, ['alpha']);
    await window.click('#open-folder');
    await window.waitForSelector('.tree-row[data-rel-path="README.md"]');
  });
  after(async () => { await app?.close(); });

  it('shows a non-blocking notice while files remain readable', async () => {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('fs:changed', {
        folderId: 'f1',
        relPath: '',
        kind: 'watcher-error',
      });
    });

    await window.waitForSelector('#viewer-banner', { state: 'visible' });
    assert.match(await window.textContent('#viewer-banner') ?? '', /Live reload is unavailable/);
    assert.equal(await window.textContent('.viewer-banner-action'), 'Retry watcher');

    await window.click('.tree-row[data-rel-path="README.md"]');
    const frame = await (await window.waitForSelector(
      'iframe[data-view-key$=":README.md"]',
    )).contentFrame();
    assert.ok(frame, 'watcher failure must not block normal file reads');
    await frame.waitForSelector('h1');
    assert.equal(await frame.textContent('h1'), 'Alpha');
  });
});

describe('session persistence', () => {
  let userDataDir: string;

  before(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docmd-session-'));
  });

  after(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it('reopens the same folders and tabs after a restart', async () => {
    // First run: open two folders, open tabs, expand a directory.
    const first = await launchApp(userDataDir);
    const firstWindow = await first.firstWindow();
    await firstWindow.waitForSelector('#landing', { state: 'visible' });
    await stubFolderDialog(first, ['alpha', 'beta']);

    await firstWindow.click('#open-folder');
    await firstWindow.waitForSelector('.tree-row[data-rel-path="README.md"]');
    await firstWindow.click('.tree-row[data-rel-path="nested"]');
    await firstWindow.waitForSelector('.tree-row[data-rel-path="nested/deep.md"]');
    await firstWindow.click('.tree-row[data-rel-path="README.md"]');
    await firstWindow.waitForSelector('.file-tab[data-rel-path="README.md"]');
    await firstWindow.click('.tree-row[data-rel-path="notes.markdown"]');
    await firstWindow.waitForSelector('.file-tab[data-rel-path="notes.markdown"]');

    await firstWindow.click('#folder-tab-add');
    await firstWindow.waitForSelector('.folder-tab:nth-of-type(2)');
    await firstWindow.waitForSelector('.tree-row[data-rel-path="index.md"]');
    await firstWindow.click('.tree-row[data-rel-path="index.md"]');
    await firstWindow.waitForSelector('.file-tab[data-rel-path="index.md"]');

    // Give the debounced write time to land, then confirm it reached disk.
    await firstWindow.waitForTimeout(700);
    const sessionFile = path.join(userDataDir, 'session.json');
    const saved = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
    assert.equal(saved.folders.length, 2, 'both folders should be recorded');

    await first.close();

    // Second run: no dialog, no clicks. Everything must come back on its own.
    const second = await launchApp(userDataDir);
    const secondWindow = await second.firstWindow();
    try {
      await secondWindow.waitForSelector('.folder-tab:nth-of-type(2)');

      const labels = await secondWindow.$$eval('.folder-tab-label', (nodes) =>
        nodes.map((n) => n.textContent));
      assert.deepEqual(labels, ['alpha', 'beta'], 'both folder tabs should return');

      // beta was active at shutdown, so it is active again with its own tab.
      await secondWindow.waitForSelector('.file-tab[data-rel-path="index.md"]');
      assert.equal(
        await secondWindow.getAttribute('.folder-tab:nth-of-type(2)', 'data-active'),
        'true',
      );

      // alpha keeps both its tabs and its expanded directory.
      await secondWindow.click('.folder-tab:nth-of-type(1) .folder-tab-label');
      await secondWindow.waitForSelector('.file-tab[data-rel-path="README.md"]');
      const alphaTabs = await secondWindow.$$eval('.file-tab', (nodes) =>
        nodes.map((n) => n.getAttribute('data-rel-path')));
      assert.deepEqual(alphaTabs, ['README.md', 'notes.markdown']);
      await secondWindow.waitForSelector('.tree-row[data-rel-path="nested/deep.md"]');

      assert.equal(await secondWindow.isVisible('#landing'), false);
    } finally {
      await second.close();
    }
  });

  it('starts at the landing state when no session exists', async () => {
    const fresh = await launchApp();
    const freshWindow = await fresh.firstWindow();
    try {
      await freshWindow.waitForSelector('#landing', { state: 'visible' });
      assert.equal((await freshWindow.$$('.folder-tab')).length, 0);
    } finally {
      await fresh.close();
    }
  });

  it('refuses to reopen a path that was not in the session file', async () => {
    const fresh = await launchApp();
    const freshWindow = await fresh.firstWindow();
    try {
      await freshWindow.waitForSelector('#landing', { state: 'visible' });
      const result = await freshWindow.evaluate(
        (target) => window.desktop.reopenFolder(target),
        path.join(fixtures, 'alpha'),
      );
      assert.equal(result, null, 'renderer must not name an arbitrary path');
    } finally {
      await fresh.close();
    }
  });
});

describe('worktree bridge calls', () => {
  let app: ElectronApplication;
  let window: Page;
  let base: string;
  let repo: string;
  let linked: string;

  before(async () => {
    const { execFileSync } = await import('node:child_process');
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'docmd-wt-')));
    repo = path.join(base, 'repo');
    linked = path.join(base, 'feature-a');

    const git = (cwd: string, ...args: string[]): void => {
      execFileSync('git', args, { cwd, stdio: 'ignore' });
    };
    await fs.mkdir(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    await fs.writeFile(path.join(repo, 'README.md'), '# Repo main\n', 'utf8');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'feature-a');

    app = await launchApp();
    window = await app.firstWindow();
    await window.waitForSelector('#landing', { state: 'visible' });
    await stubFolderPaths(app, [repo]);
  });

  after(async () => {
    await app?.close();
    await fs.rm(base, { recursive: true, force: true });
  });

  it('reports repoKey and branch when the folder opens', async () => {
    const folder = await window.evaluate(() => window.desktop.openFolderDialog());
    assert.equal(folder?.branch, 'main');
    assert.ok(folder?.repoKey?.endsWith('/.git'), 'repoKey should be the git common directory');
  });

  it('lists both worktrees and registers one without a watcher', async () => {
    const result = await window.evaluate(async (linkedPath) => {
      const folder = await window.desktop.openFolderDialog();
      const list = await window.desktop.listWorktrees(folder!.id);
      const registered = await window.desktop.registerWorktree(linkedPath);
      return {
        branches: list.map((w) => w.branch),
        registeredBranch: registered?.branch ?? null,
      };
    }, linked);

    assert.deepEqual(result.branches, ['main', 'feature-a']);
    assert.equal(result.registeredBranch, 'feature-a');
  });

  it('refuses a path that git did not report', async () => {
    const refused = await window.evaluate(
      (target) => window.desktop.registerWorktree(target),
      path.join(fixtures, 'alpha'),
    );
    assert.equal(refused, null, 'renderer must not name an arbitrary path');
  });

  it('reads the root only when loadFolder runs', async () => {
    const names = await window.evaluate(async (linkedPath) => {
      const registered = await window.desktop.registerWorktree(linkedPath);
      const entries = await window.desktop.loadFolder(registered!.id);
      return entries.map((entry) => entry.name);
    }, linked);

    assert.deepEqual(names, ['README.md']);
  });
});

describe('worktree user interface', () => {
  let app: ElectronApplication;
  let window: Page;
  let base: string;
  let repo: string;

  before(async () => {
    const { execFileSync } = await import('node:child_process');
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'docmd-wtui-')));
    repo = path.join(base, 'repo');

    const git = (cwd: string, ...args: string[]): void => {
      execFileSync('git', args, { cwd, stdio: 'ignore' });
    };
    await fs.mkdir(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    await fs.writeFile(path.join(repo, 'README.md'), '# Repo main\n', 'utf8');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
    git(repo, 'worktree', 'add', '-q', path.join(base, 'feature-a'), '-b', 'feature-a');
    await fs.writeFile(path.join(base, 'feature-a', 'ONLY-A.md'), '# Only on A\n', 'utf8');

    app = await launchApp();
    window = await app.firstWindow();
    await window.waitForSelector('#landing', { state: 'visible' });
    await stubFolderPaths(app, [repo, path.join(fixtures, 'alpha')]);
  });

  after(async () => {
    await app?.close();
    await fs.rm(base, { recursive: true, force: true });
  });

  it('shows one repository tab for two worktrees', async () => {
    await window.click('#open-folder');
    await window.waitForSelector('.tree-row[data-rel-path="README.md"]');
    await window.waitForSelector('#worktree-select-control');

    assert.equal((await window.$$('.folder-tab')).length, 1, 'two worktrees, one tab');
    assert.equal(await window.textContent('.folder-tab-label'), 'repo');
  });

  it('lists both branches in the dropdown', async () => {
    const options = await window.$$eval('#worktree-select-control option', (nodes) =>
      nodes.map((n) => n.textContent));
    assert.deepEqual(options, ['main', 'feature-a']);
  });

  it('changes the tree when you select the other worktree', async () => {
    // ONLY-A.md exists on feature-a and not on main.
    assert.equal(await window.$('.tree-row[data-rel-path="ONLY-A.md"]'), null);

    await window.selectOption('#worktree-select-control', { label: 'feature-a' });
    await window.waitForSelector('.tree-row[data-rel-path="ONLY-A.md"]');
  });

  it('keeps the file tabs of each worktree apart', async () => {
    await window.click('.tree-row[data-rel-path="ONLY-A.md"]');
    await window.waitForSelector('.file-tab[data-rel-path="ONLY-A.md"]');

    await window.selectOption('#worktree-select-control', { label: 'main' });
    await window.waitForSelector('.tree-row[data-rel-path="README.md"]');
    assert.equal((await window.$$('.file-tab')).length, 0, 'main has no tab open yet');

    await window.selectOption('#worktree-select-control', { label: 'feature-a' });
    await window.waitForSelector('.file-tab[data-rel-path="ONLY-A.md"]');
  });

  it('hides the dropdown for a folder that is not a repository', async () => {
    await window.click('#folder-tab-add');
    await window.waitForSelector('.folder-tab:nth-of-type(2)');
    await window.waitForSelector('.tree-row[data-rel-path="README.md"]');
    assert.equal(await window.isVisible('#worktree-select'), false);
  });
});

describe('worktree list stays in step with git', () => {
  let app: ElectronApplication;
  let window: Page;
  let base: string;
  let repo: string;
  let userDataDir: string;
  let git: (cwd: string, ...args: string[]) => void;

  const branches = async (): Promise<string[]> =>
    window.$$eval('#worktree-select-control option', (nodes) =>
      nodes.map((n) => n.textContent ?? ''));

  before(async () => {
    const { execFileSync } = await import('node:child_process');
    git = (cwd, ...args) => { execFileSync('git', args, { cwd, stdio: 'ignore' }); };

    // realpath matters: git reports resolved paths, and the app must match them
    // or it adds the opened folder again as its own sibling.
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'docmd-wtref-')));
    repo = path.join(base, 'repo');
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docmd-wtref-ud-'));

    await fs.mkdir(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    await fs.writeFile(path.join(repo, 'README.md'), '# Main\n', 'utf8');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
    git(repo, 'worktree', 'add', '-q', path.join(base, 'wt-a'), '-b', 'feat-a');

    app = await launchApp(userDataDir);
    window = await app.firstWindow();
    await window.waitForSelector('#landing', { state: 'visible' });
    // Pass the unresolved /tmp form on purpose, to prove the app canonicalises.
    await stubFolderPaths(app, [repo.replace('/private/tmp/', '/tmp/')]);
    await window.click('#open-folder');
    await window.waitForSelector('#worktree-select-control');
  });

  after(async () => {
    await app?.close();
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it('lists each worktree once, with no duplicate for the opened folder', async () => {
    assert.deepEqual(await branches(), ['main', 'feat-a']);
    assert.equal((await window.$$('.folder-tab')).length, 1);
  });

  it('picks up a worktree created while the app is open', async () => {
    git(repo, 'worktree', 'add', '-q', path.join(base, 'wt-b'), '-b', 'feat-b');

    // Returning to the window is when the app asks git again.
    await window.evaluate(() => window.dispatchEvent(new Event('focus')));
    await window.waitForFunction(
      () => document.querySelectorAll('#worktree-select-control option').length === 3,
      undefined,
      { timeout: 15000 },
    );
    assert.deepEqual(await branches(), ['main', 'feat-a', 'feat-b']);
  });

  it('keeps the new worktree after a restart', async () => {
    // The session stores a snapshot. Restore must ask git again, or the list
    // freezes at whatever was saved.
    git(repo, 'worktree', 'add', '-q', path.join(base, 'wt-c'), '-b', 'feat-c');
    await window.waitForTimeout(700);   // let the debounced session write land
    await app.close();

    app = await launchApp(userDataDir);
    window = await app.firstWindow();
    await window.waitForSelector('#worktree-select-control');
    await window.waitForFunction(
      () => document.querySelectorAll('#worktree-select-control option').length === 4,
      undefined,
      { timeout: 15000 },
    );
    assert.deepEqual(await branches(), ['main', 'feat-a', 'feat-b', 'feat-c']);
    assert.equal((await window.$$('.folder-tab')).length, 1, 'still one repository tab');
  });
});

describe('menu shortcuts', () => {
  let app: ElectronApplication;
  let window: Page;

  /**
   * Click the real menu item in the main process.
   *
   * A key press sent to the page cannot trigger a menu accelerator, because
   * the native menu handles accelerators before the page sees the key. Firing
   * the menu item proves the same path the accelerator uses.
   */
  const clickMenu = async (id: string): Promise<boolean> =>
    app.evaluate(async ({ Menu }, itemId) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
      if (!item) return false;
      item.click();
      return true;
    }, id);

  before(async () => {
    app = await launchApp();
    window = await app.firstWindow();
    await window.waitForSelector('#landing', { state: 'visible' });
    await stubFolderDialog(app, ['alpha']);
    await window.click('#open-folder');
    await window.waitForSelector('.tree-row[data-rel-path="README.md"]');
  });
  after(async () => { await app?.close(); });

  it('binds CmdOrCtrl+W to Close Tab and to nothing else', async () => {
    const owners = await app.evaluate(async ({ Menu }) => {
      const found: string[] = [];
      const walk = (items: Electron.MenuItem[]): void => {
        for (const item of items) {
          if (item.accelerator === 'CmdOrCtrl+W') found.push(item.id || item.label);
          if (item.submenu) walk(item.submenu.items);
        }
      };
      walk(Menu.getApplicationMenu()?.items ?? []);
      return found;
    });
    assert.deepEqual(owners, ['close-tab'], 'only Close Tab may own CmdOrCtrl+W');
  });

  it('closes the active file tab, not the repository tab', async () => {
    await window.click('.tree-row[data-rel-path="README.md"]');
    await window.waitForSelector('.file-tab[data-rel-path="README.md"]');
    await window.click('.tree-row[data-rel-path="notes.markdown"]');
    await window.waitForSelector('.file-tab[data-rel-path="notes.markdown"]');

    assert.equal(await clickMenu('close-tab'), true);
    await window.waitForSelector('.file-tab[data-rel-path="notes.markdown"]', { state: 'detached' });

    assert.equal((await window.$$('.file-tab')).length, 1, 'the other file tab stays');
    assert.equal((await window.$$('.folder-tab')).length, 1, 'the repository tab stays');
  });

  it('does nothing when no file tab is open, and leaves the window open', async () => {
    await clickMenu('close-tab');           // closes the last remaining tab
    await window.waitForFunction(() => document.querySelectorAll('.file-tab').length === 0);

    await clickMenu('close-tab');           // nothing left to close
    await window.waitForTimeout(300);

    assert.equal((await window.$$('.folder-tab')).length, 1, 'repository tab must survive');
    assert.equal(await window.isVisible('#workspace'), true, 'window must stay open');
    assert.equal((await app.windows()).length, 1, 'window must not close');
  });

  it('moves to the next and previous file tab', async () => {
    await window.click('.tree-row[data-rel-path="README.md"]');
    await window.waitForSelector('.file-tab[data-rel-path="README.md"]');
    await window.click('.tree-row[data-rel-path="notes.markdown"]');
    await window.waitForSelector('.file-tab[data-rel-path="notes.markdown"][data-active="true"]');

    await clickMenu('previous-tab');
    await window.waitForSelector('.file-tab[data-rel-path="README.md"][data-active="true"]');

    await clickMenu('next-tab');
    await window.waitForSelector('.file-tab[data-rel-path="notes.markdown"][data-active="true"]');
  });
});

export { launchApp, stubFolderDialog, stubFolderPaths, fixtures, projectRoot, fs };
