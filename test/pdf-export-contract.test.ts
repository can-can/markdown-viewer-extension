/**
 * PDF export contract tests — headless Chrome print through the CLI:
 *  - single document prints a valid PDF (magic + pages),
 *  - whole book prints one page per chapter (break-before: page).
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';

import {
  createBrowserRenderHarness,
  type BrowserRenderHarness,
} from './helpers/browser-render-harness.ts';

const BODY_TEXT = path.resolve('test/fixtures/layout/body-text.md');
const BOOK_DIR = path.resolve('test/fixtures/book');

const PAGES = [
  { href: 'chapter1.md', title: 'Chapter One' },
  { href: 'chapter2.md', title: 'Chapter Two' },
] as const;

const FIXED_PARAMS = {
  theme: 'default',
  language: 'en',
  frontmatterDisplay: 'hide',
  tableMergeEmpty: false,
  tableLayout: 'center',
  imageLayout: 'center',
  diagramLayout: 'center',
  timeoutMs: 240_000,
} as const;

function pdfPageCount(pdf: Buffer): number {
  const text = pdf.toString('latin1');
  assert.ok(text.startsWith('%PDF'), 'output must be a PDF (magic header)');
  return (text.match(/\/Type \/Page[^s]/g) || []).length;
}

describe('PDF export contract (headless Chrome print)', () => {
  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: BODY_TEXT });
  });

  after(async () => {
    await harness.dispose();
  });

  it('prints a single document to a valid PDF', async () => {
    const pdf = await harness.renderPdf(BODY_TEXT, FIXED_PARAMS);
    assert.ok(pdf.length > 10_000, 'PDF must contain the rendered content');
    assert.ok(pdfPageCount(pdf) >= 1, 'PDF must have at least one page');
  });

  it('prints a whole book with one page per chapter', async () => {
    const pdf = await harness.renderBookPdf([...PAGES], { ...FIXED_PARAMS, inputPath: path.join(BOOK_DIR, 'chapter1.md') });
    assert.ok(pdf.length > 10_000, 'book PDF must contain the rendered chapters');
    assert.ok(
      pdfPageCount(pdf) >= 2,
      'book PDF must start every chapter on a new page (got ' + pdfPageCount(pdf) + ' pages)',
    );
  });
});
