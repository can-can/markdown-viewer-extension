import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron, type ElectronApplication } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('desktop app launch', () => {
  let app: ElectronApplication;

  before(async () => {
    app = await electron.launch({
      args: [path.join(projectRoot, 'dist/desktop/main.cjs')],
    });
  });

  after(async () => {
    await app?.close();
  });

  it('opens a window showing the landing state', async () => {
    const window = await app.firstWindow();
    await window.waitForSelector('#landing', { state: 'visible' });
    const text = await window.textContent('#landing');
    assert.match(text ?? '', /Open a folder/);
  });

  it('exposes the filesystem bridge to the renderer', async () => {
    const window = await app.firstWindow();
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
    const window = await app.firstWindow();
    const fixtures = path.join(projectRoot, 'test/fixtures/desktop');

    // The native dialog cannot be driven from the renderer, so stub it.
    await app.evaluate(async ({ dialog }, alphaPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [alphaPath] });
    }, path.join(fixtures, 'alpha'));

    const result = await window.evaluate(async () => {
      const folder = await window.desktop.openFolderDialog();
      if (!folder) return null;
      const entries = await window.desktop.listDir(folder.id, '');
      const content = await window.desktop.readFile(folder.id, 'README.md', false);
      return { names: entries.map((e) => e.name), content };
    });

    assert.deepEqual(result?.names, ['nested', 'notes.markdown', 'README.md']);
    assert.match(result?.content ?? '', /Alpha root document/);
  });
});
