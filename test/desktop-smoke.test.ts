import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(projectRoot, 'test/fixtures/desktop');

/**
 * Each describe block gets its own app instance. The app accumulates state
 * (open folders, open tabs), so sharing one instance would make tests
 * order-dependent.
 */
async function launchApp(): Promise<ElectronApplication> {
  return electron.launch({ args: [path.join(projectRoot, 'dist/desktop/main.cjs')] });
}

/**
 * The native folder dialog cannot be driven from the renderer, so stub it in
 * the main process to hand back the given fixture folders in sequence.
 */
async function stubFolderDialog(app: ElectronApplication, folderNames: string[]): Promise<void> {
  await app.evaluate(async ({ dialog }, paths) => {
    let index = 0;
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [paths[Math.min(index++, paths.length - 1)]],
    });
  }, folderNames.map((name) => path.join(fixtures, name)));
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
      'onFileChanged',
      'openFolderDialog',
      'readFile',
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
      'iframe[data-active="true"]',
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

export { launchApp, stubFolderDialog, fixtures, projectRoot, fs };
