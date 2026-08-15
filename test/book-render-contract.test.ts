/**
 * Whole-book chapter DOM contract tests.
 *
 * Renders a book through the REAL print renderer (renderBookForPrint — the
 * same pipeline the whole-book PDF/EPUB export uses) and asserts the
 * canonical chapter wrapper contract on every chapter:
 *
 *   .book-chapter > #markdown-content.markdown-viewer-content + layout classes
 *
 * The content root tag must be the canonical <div> and the layout classes
 * must live on the content root (single layer, matching the single-document
 * contract).
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';
import JSZip from 'jszip';

import {
  createBrowserRenderHarness,
  type BrowserRenderHarness,
} from './helpers/browser-render-harness.ts';

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
  inputPath: path.join(BOOK_DIR, 'chapter1.md'),
  timeoutMs: 180_000,
} as const;

describe('whole-book chapter DOM contract (book renderer)', () => {
  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: path.join(BOOK_DIR, 'chapter1.md') });
  });

  after(async () => {
    await harness.dispose();
  });

  it('renders every page as a canonical chapter wrapper', async () => {
    const dom = await harness.renderBookDom([...PAGES], FIXED_PARAMS);
    assert.equal(dom.chapters.length, 2, 'book must render one chapter per page');

    for (const chapter of dom.chapters) {
      assert.ok(
        /^<div\b[^>]*id="markdown-content"/.test(chapter.html.trim()),
        'chapter content root must be a <div id="markdown-content">',
      );
      assert.ok(
        chapter.html.includes('markdown-viewer-content'),
        'chapter content root must carry .markdown-viewer-content',
      );
      assert.ok(
        chapter.html.includes('table-layout-center image-layout-center diagram-layout-center'),
        'chapter content root must carry the layout classes (single layer)',
      );
      assert.ok(
        /<h1[^>]*>/.test(chapter.html),
        'chapter content must render (h1 present)',
      );
    }
  });

  it('renders distinct content per chapter (no cross-page bleed)', async () => {
    const dom = await harness.renderBookDom([...PAGES], FIXED_PARAMS);
    const [first, second] = dom.chapters;
    assert.ok(first.html.includes('Chapter One'), 'first chapter keeps its own content');
    assert.ok(second.html.includes('Chapter Two'), 'second chapter keeps its own content');
    assert.ok(!first.html.includes('Chapter Two'), 'no cross-page bleed into the first chapter');
  });

  it('threads the layout parameters into every chapter', async () => {
    const dom = await harness.renderBookDom([...PAGES], {
      ...FIXED_PARAMS,
      tableLayout: 'left',
      imageLayout: 'left',
      diagramLayout: 'left',
    });
    for (const chapter of dom.chapters) {
      assert.ok(
        chapter.html.includes('table-layout-left image-layout-left diagram-layout-left'),
        'chapter content root must carry the requested layout classes',
      );
    }
  });
});

describe('whole-book EPUB contract (real pipeline)', () => {
  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: path.join(BOOK_DIR, 'chapter1.md') });
  });

  after(async () => {
    await harness.dispose();
  });

  it('packages every page as a canonical chapter', async () => {
    const { base64 } = await harness.renderBookEpub([...PAGES], FIXED_PARAMS);
    const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));

    const chapterNames = Object.keys(zip.files)
      .filter((n) => /^OEBPS\/\d+-.*\.xhtml$/.test(n))
      .sort();
    assert.equal(chapterNames.length, 2, 'whole-book EPUB must contain one chapter per page');

    for (const name of chapterNames) {
      const chapter = await zip.files[name].async('string');
      assert.ok(
        /<div\b[^>]*id="markdown-content"/.test(chapter),
        `${name} content root must be a <div id="markdown-content">`,
      );
      assert.ok(
        chapter.includes('markdown-viewer-content'),
        `${name} content root must carry .markdown-viewer-content`,
      );
      assert.ok(
        chapter.includes('table-layout-center image-layout-center diagram-layout-center'),
        `${name} content root must carry the layout classes`,
      );
    }
  });

  it('keeps the linear TOC first (whole-book navigation)', async () => {
    const { base64 } = await harness.renderBookEpub([...PAGES], FIXED_PARAMS);
    const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
    const opf = await zip.files['OEBPS/content.opf'].async('string');

    const spine = opf.match(/<spine[^>]*>([\s\S]*?)<\/spine>/)?.[1] || '';
    const itemrefs = Array.from(spine.matchAll(/<itemref[^>]*>/g)).map((m) => m[0]);
    assert.ok(
      itemrefs[0].includes('idref="nav"') && itemrefs[0].includes('linear="yes"'),
      'whole-book spine must open with the linear nav (TOC page)',
    );
    assert.equal(
      itemrefs.filter((r) => r.includes('idref="chapter-')).length,
      2,
      'spine must list every chapter',
    );

    const nav = await zip.files['OEBPS/nav.xhtml'].async('string');
    for (const page of PAGES) {
      assert.ok(nav.includes(page.title), `nav must list "${page.title}"`);
    }
  });

  it('carries the shared stylesheet in the whole-book EPUB', async () => {
    const { base64 } = await harness.renderBookEpub([...PAGES], FIXED_PARAMS);
    const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
    const styles = await zip.files['OEBPS/style.css'].async('string');

    assert.ok(
      /#markdown-content \.diagram-block[^{]*\{[^}]*margin\s*:\s*20px\s+auto/.test(styles),
      'whole-book stylesheet must carry the diagram centering rule',
    );
    assert.ok(styles.includes('@font-face'), 'whole-book stylesheet must embed fonts');
  });

  it('exports a whole-book DOCX with every chapter merged', async () => {
    const { base64, filename } = await harness.renderBookDocx([...PAGES], FIXED_PARAMS);
    assert.ok(filename.endsWith('.docx'), `filename must be a .docx (got "${filename}")`);

    const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
    assert.ok(zip.files['word/document.xml'], 'DOCX must contain document.xml');
    const documentXml = await zip.files['word/document.xml'].async('string');
    assert.ok(
      documentXml.includes('Chapter One') && documentXml.includes('Chapter Two'),
      'merged document must carry both chapters',
    );
    assert.ok(
      documentXml.includes('Second chapter body'),
      'merged document must carry the second chapter content',
    );
  });
});
