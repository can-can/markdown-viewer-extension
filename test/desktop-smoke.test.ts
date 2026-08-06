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
});
