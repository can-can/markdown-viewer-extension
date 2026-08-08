import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  readSession,
  writeSession,
  sessionFilePath,
  type SessionState,
} from '../desktop/src/main/session-store.ts';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docmd-session-'));
  file = path.join(dir, 'session.json');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const state: SessionState = {
  version: 1,
  folders: [
    { path: '/tmp/alpha', tabs: ['README.md', 'docs/api.md'], activeRelPath: 'docs/api.md', expandedPaths: ['docs'] },
    { path: '/tmp/beta', tabs: [], activeRelPath: null, expandedPaths: [] },
  ],
  activeFolderPath: '/tmp/alpha',
};

describe('sessionFilePath', () => {
  it('puts the file in the given user data directory', () => {
    assert.equal(sessionFilePath('/data'), path.join('/data', 'session.json'));
  });
});

describe('writeSession then readSession', () => {
  it('round-trips the full state', async () => {
    await writeSession(file, state);
    assert.deepEqual(await readSession(file), state);
  });

  it('overwrites a previous session', async () => {
    await writeSession(file, state);
    await writeSession(file, { version: 1, folders: [], activeFolderPath: null });
    const loaded = await readSession(file);
    assert.deepEqual(loaded?.folders, []);
    assert.equal(loaded?.activeFolderPath, null);
  });

  it('creates the parent directory when it does not exist', async () => {
    const nested = path.join(dir, 'a', 'b', 'session.json');
    await writeSession(nested, state);
    assert.deepEqual(await readSession(nested), state);
  });

  it('leaves no temp file behind', async () => {
    await writeSession(file, state);
    const entries = await fs.readdir(dir);
    assert.deepEqual(entries, ['session.json']);
  });
});

describe('readSession failure handling', () => {
  it('returns null when the file does not exist', async () => {
    assert.equal(await readSession(file), null);
  });

  it('returns null on malformed JSON instead of throwing', async () => {
    await fs.writeFile(file, '{ not json', 'utf8');
    assert.equal(await readSession(file), null);
  });

  it('returns null on an unknown version', async () => {
    await fs.writeFile(file, JSON.stringify({ version: 99, folders: [] }), 'utf8');
    assert.equal(await readSession(file), null);
  });

  it('returns null when folders is not an array', async () => {
    await fs.writeFile(file, JSON.stringify({ version: 1, folders: 'nope' }), 'utf8');
    assert.equal(await readSession(file), null);
  });

  it('drops a folder entry that has no path', async () => {
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      folders: [{ tabs: [] }, { path: '/tmp/ok', tabs: [], activeRelPath: null, expandedPaths: [] }],
      activeFolderPath: null,
    }), 'utf8');
    const loaded = await readSession(file);
    assert.deepEqual(loaded?.folders.map((f) => f.path), ['/tmp/ok']);
  });

  it('repairs a folder entry with missing optional fields', async () => {
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      folders: [{ path: '/tmp/ok' }],
      activeFolderPath: null,
    }), 'utf8');
    const loaded = await readSession(file);
    assert.deepEqual(loaded?.folders[0], {
      path: '/tmp/ok',
      tabs: [],
      activeRelPath: null,
      expandedPaths: [],
    });
  });

  it('drops non-string entries inside tabs and expandedPaths', async () => {
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      folders: [{ path: '/tmp/ok', tabs: ['a.md', 7, null], expandedPaths: ['docs', {}] }],
      activeFolderPath: null,
    }), 'utf8');
    const loaded = await readSession(file);
    assert.deepEqual(loaded?.folders[0].tabs, ['a.md']);
    assert.deepEqual(loaded?.folders[0].expandedPaths, ['docs']);
  });

  it('clears activeFolderPath when it names no restored folder', async () => {
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      folders: [{ path: '/tmp/ok' }],
      activeFolderPath: '/tmp/gone',
    }), 'utf8');
    assert.equal((await readSession(file))?.activeFolderPath, null);
  });

  it('clears activeRelPath when it names no open tab', async () => {
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      folders: [{ path: '/tmp/ok', tabs: ['a.md'], activeRelPath: 'ghost.md' }],
      activeFolderPath: null,
    }), 'utf8');
    assert.equal((await readSession(file))?.folders[0].activeRelPath, null);
  });
});
