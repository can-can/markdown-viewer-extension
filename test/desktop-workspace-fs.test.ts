import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDir, readFile, resolveWithin } from '../desktop/src/main/workspace-fs.ts';

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/desktop',
);
const alpha = path.join(fixtures, 'alpha');

describe('resolveWithin', () => {
  it('resolves a relative path against the root', () => {
    assert.equal(resolveWithin(alpha, 'README.md'), path.join(alpha, 'README.md'));
  });

  it('resolves the empty path to the root itself', () => {
    assert.equal(resolveWithin(alpha, ''), alpha);
  });

  it('rejects a path escaping the root', () => {
    assert.throws(() => resolveWithin(alpha, '../beta/index.md'), /EPATHESCAPE/);
  });

  it('rejects an absolute path', () => {
    assert.throws(() => resolveWithin(alpha, '/etc/passwd'), /EPATHESCAPE/);
  });

  it('rejects a path escaping via a nested traversal', () => {
    assert.throws(() => resolveWithin(alpha, 'nested/../../beta/index.md'), /EPATHESCAPE/);
  });

  it('rejects a sibling directory sharing the root as a name prefix', () => {
    // '/tmp/alpha-other' starts with '/tmp/alpha' as a string but is not inside it.
    assert.throws(() => resolveWithin('/tmp/alpha', '../alpha-other/x.md'), /EPATHESCAPE/);
  });
});

describe('listDir', () => {
  it('lists one level, directories before files, alphabetically', async () => {
    const entries = await listDir(alpha, '');
    assert.deepEqual(
      entries.map((e) => e.name),
      ['nested', 'diagram.md', 'notes.markdown', 'README.md'],
    );
    assert.equal(entries[0].kind, 'directory');
  });

  it('omits unsupported extensions', async () => {
    const entries = await listDir(alpha, '');
    const names = entries.map((e) => e.name);
    assert.equal(names.includes('image.zzz'), false);
    assert.equal(names.includes('notes.txt'), false);
  });

  it('returns relPath values usable for a follow-up listDir', async () => {
    const entries = await listDir(alpha, '');
    const nested = entries.find((e) => e.name === 'nested');
    assert.equal(nested?.relPath, 'nested');
    const children = await listDir(alpha, nested!.relPath);
    assert.deepEqual(children.map((e) => e.name), ['deep.md']);
    assert.equal(children[0].relPath, 'nested/deep.md');
  });

  it('rejects listing outside the root', async () => {
    await assert.rejects(() => listDir(alpha, '../beta'), /EPATHESCAPE/);
  });
});

describe('readFile', () => {
  it('reads a text file as utf8', async () => {
    const content = await readFile(alpha, 'README.md', false);
    assert.match(content, /Alpha root document/);
  });

  it('reads a file as base64 when binary', async () => {
    const content = await readFile(alpha, 'README.md', true);
    assert.match(Buffer.from(content, 'base64').toString('utf8'), /Alpha root document/);
  });

  it('rejects a missing file with ENOENT', async () => {
    await assert.rejects(() => readFile(alpha, 'nope.md', false), /ENOENT/);
  });

  it('rejects a path escaping the root', async () => {
    await assert.rejects(() => readFile(alpha, '../beta/index.md', false), /EPATHESCAPE/);
  });
});
