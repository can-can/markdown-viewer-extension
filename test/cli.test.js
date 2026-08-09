import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import path from 'node:path';

import { ensureOutputDirectory, parseArgs } from '../scripts/md-to-html.js';

describe('Markdown HTML CLI arguments', () => {
  it('uses stable defaults', () => {
    const options = parseArgs(['notes.md']);
    assert.equal(options.input, 'notes.md');
    assert.equal(options.theme, 'default');
    assert.equal(options.frontmatterDisplay, 'hide');
    assert.equal(options.tableLayout, 'center');
    assert.equal(options.timeoutMs, 120_000);
  });

  it('parses rendering options', () => {
    const options = parseArgs([
      'notes.md',
      '--output', 'notes.html',
      '--theme', 'midnight',
      '--frontmatter', 'table',
      '--table-layout', 'left',
      '--merge-empty-cells',
      '--timeout', '30',
    ]);

    assert.equal(options.output, 'notes.html');
    assert.equal(options.theme, 'midnight');
    assert.equal(options.frontmatterDisplay, 'table');
    assert.equal(options.tableLayout, 'left');
    assert.equal(options.tableMergeEmpty, true);
    assert.equal(options.timeoutMs, 30_000);
  });

  it('rejects invalid enum options', () => {
    assert.throws(
      () => parseArgs(['notes.md', '--frontmatter', 'show']),
      /--frontmatter must be hide, table, or raw/,
    );
  });

  it('accepts an output file directly under an existing filesystem root', async () => {
    const filesystemRoot = path.parse(process.cwd()).root;
    await ensureOutputDirectory(path.join(filesystemRoot, 'documd-root-output-test.html'));
  });
});
