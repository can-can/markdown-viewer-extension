/**
 * Installed-extension tests: load the REAL built Chrome extension
 * (dist/chrome) in a persistent Chromium context and verify the export
 * stylesheet collection contract + the FULL fixture matrix across the
 * three file-opening modes:
 *
 *   standalone — file:// direct browse (content-script takeover)
 *   workspace  — workspace.html directory picker + file tree + iframe preview
 *   embed      — viewer-embed.html?embed=1 fed via OPEN_DOCUMENT postMessage
 *
 * Assertions mirror the Web baseline semantics (exact computed values,
 * symmetry/zero geometry, fixed params). On top of that, each mode must
 * expose the shared content stylesheet to the export CSS collectors
 * (document.styleSheets enumeration) — this is the regression guard for the
 * insertCSS bug that silently dropped every structural rule (diagram
 * centering etc.) from exported HTML/EPUB on file:// pages.
 *
 * Requires a GUI (Chrome is launched headed; headless does not load
 * extensions). Skip with MV_SKIP_EXT_TESTS=1. Run `node chrome/build.js`
 * first so dist/chrome is up to date.
 *
 * IMPORTANT: all page-executed code is passed as STRINGS and arguments are
 * inlined via JSON — tsx/esbuild injects a `__name` helper into compiled
 * functions, so serializing compiled functions into the browser page fails,
 * and Playwright rejects strings with arguments.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { chromium, type BrowserContext, type Page, type Frame } from 'playwright-core';

const SKIP_EXT = process.env.MV_SKIP_EXT_TESTS === '1';

const EXT_DIR = path.resolve('dist/chrome');
const LAYOUT_DIR = path.resolve('test/fixtures/layout');

const FIXED_SETTINGS = {
  theme: 'default',
  language: 'en',
  frontmatterDisplay: 'hide',
  tableMergeEmpty: false,
  tableLayout: 'center',
  imageLayout: 'center',
  diagramLayout: 'center',
} as const;

type Target = Page | Frame;

function px(value: string): number {
  return parseFloat(value);
}

function firstOf(measurements: Array<{ selector: string; elements: any[] }>, selector: string) {
  const item = measurements.find((m) => m.selector === selector);
  assert.ok(item, `No measurement for selector "${selector}"`);
  assert.ok(item.elements.length > 0, `Selector "${selector}" matched no elements`);
  return item.elements[0];
}

/**
 * Evaluate a JS function BODY string. Playwright treats an evaluate string
 * as a function BODY, so `() => {}` would just create a function object and
 * serialize to undefined — always invoke the body explicitly (IIFE form).
 */
async function evalJs<T>(target: Target, jsBody: string, arg?: unknown): Promise<T> {
  const src = arg === undefined ? `(${jsBody})()` : `(${jsBody})(${JSON.stringify(arg)})`;
  return target.evaluate(src) as Promise<T>;
}

/**
 * Poll-wait for a JS BODY string to return truthy. Uses evaluate() (function
 * body semantics) instead of waitForFunction — the latter evaluates strings
 * via eval, which extension pages block with CSP (unsafe-eval).
 */
async function waitFor(target: Target, jsBody: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evalJs<boolean>(target, jsBody)) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out (${timeoutMs}ms): ${jsBody.slice(0, 80)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const MEASURE_JS = `(selectors) => selectors.map((selector) => {
  const nodes = Array.from(document.querySelectorAll(selector));
  return {
    selector,
    count: nodes.length,
    elements: nodes.map((node) => {
      const element = node;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        left: rect.left, top: rect.top, width: rect.width, height: rect.height,
        marginTop: style.marginTop, marginRight: style.marginRight,
        marginBottom: style.marginBottom, marginLeft: style.marginLeft,
        paddingTop: style.paddingTop, paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom, paddingLeft: style.paddingLeft,
        borderTopWidth: style.borderTopWidth, borderRightWidth: style.borderRightWidth,
        borderBottomWidth: style.borderBottomWidth, borderLeftWidth: style.borderLeftWidth,
        fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight,
        fontWeight: style.fontWeight, fontStyle: style.fontStyle, color: style.color,
        textDecorationLine: style.textDecorationLine, textAlign: style.textAlign,
        textIndent: style.textIndent, display: style.display,
        backgroundColor: style.backgroundColor, overflowX: style.overflowX, overflowY: style.overflowY,
      };
    }),
  };
})`;

const COLLECT_CSS_JS = `() => {
  const CONTENT_TOKENS = ['#markdown-content', '#markdown-page', '.katex', '.hljs', '.mermaid', '.markmap', '.graphviz', '.plantuml', '.diagram'];
  const shouldKeep = (sel) => CONTENT_TOKENS.some((t) => sel.toLowerCase().includes(t));
  const chunks = [];
  for (const ss of Array.from(document.styleSheets)) {
    const owner = ss.ownerNode;
    if (owner && owner.id === 'markdown-viewer-preload') continue;
    try {
      const text = Array.from(ss.cssRules)
        .filter((r) => (r.type === 1 && shouldKeep(r.selectorText)) || r.type === 5 /* FONT_FACE_RULE */)
        .map((r) => r.cssText)
        .join('\\n');
      if (text) chunks.push(text);
    } catch { /* skip inaccessible sheets — like the exporter collector */ }
  }
  const theme = document.getElementById('theme-dynamic-style')?.textContent || '';
  if (theme) chunks.push(theme);
  return chunks.join('\\n');
}`;

const waitImagesJs = (rootSel: string) => `() => {
  const images = Array.from(document.querySelectorAll('${rootSel} img'));
  return Promise.all(images.map((img) => {
    if (typeof img.decode === 'function') return img.decode().catch(() => undefined);
    return new Promise((resolve) => {
      if (img.complete) { resolve(); return; }
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
    });
  })).then(() => true);
}`;
const WAIT_IMAGES_JS = waitImagesJs('#markdown-content');

const WAIT_RENDERED_JS = `() => {
  const c = document.getElementById('markdown-content');
  return Boolean(c && c.children.length > 0);
}`;

// standalone: content render + the async style injection (inject-styles
// fetches ui/styles.css) must BOTH be complete before collection.
const WAIT_STANDALONE_READY_JS = `() => {
  const c = document.getElementById('markdown-content');
  return Boolean(c && c.children.length > 0 && document.getElementById('mv-content-styles'));
}`;

const SET_STORAGE_JS = `(settings) => chrome.storage.local.set({ markdownViewerSettings: settings })`;

const POST_OPEN_DOCUMENT_JS = `(msg) => window.postMessage(msg, '*')`;

const MOCK_PICKER_JS = `(fixtures) => {
  const handles = {};
  for (const [name, content] of Object.entries(fixtures)) {
    handles[name] = { name, kind: 'file', getFile: async () => new File([content], name) };
  }
  window.showDirectoryPicker = async () => ({
    name: 'fixtures',
    kind: 'directory',
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getFileHandle: async (name) => {
      if (!handles[name]) throw new DOMException('Not found', 'NotFoundError');
      return handles[name];
    },
    getDirectoryHandle: async () => { throw new DOMException('Not a directory', 'NotFoundError'); },
    [Symbol.asyncIterator]: async function* () {
      for (const [name, handle] of Object.entries(handles)) yield [name, handle];
    },
  });
}`;

describe('installed Chrome extension (three open modes × full fixture matrix)', { skip: SKIP_EXT }, () => {
  let context: BrowserContext;
  let extensionId = '';
  let userDataDir = '';
  let standalonePage: Page;
  let embedPage: Page;
  let workspacePage: Page;
  let inlinePage: Page;

  before(async () => {
    await fs.promises.access(path.join(EXT_DIR, 'manifest.json')).catch(() => {
      throw new Error('dist/chrome missing — run "node chrome/build.js" first');
    });

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-installed-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: false,
      args: [
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
        '--no-first-run',
        '--disable-default-apps',
        // Let content scripts fetch file:// resources (fixture images).
        '--allow-file-access-from-files',
      ],
    });

    const worker = await context.waitForEvent('serviceworker', { timeout: 30000 });
    extensionId = worker.url().split('/')[2];

    standalonePage = await context.newPage();
    embedPage = await context.newPage();

    // Inline <markdown-viewer> element mode: the demo page hosts the element;
    // the background injects the element runtime after content detection.
    inlinePage = await context.newPage();
    await inlinePage.goto('file://' + path.resolve('demo/demo.html'), { waitUntil: 'load' });
    await waitFor(inlinePage, `() => Boolean(customElements.get('markdown-viewer'))`);
    await inlinePage.waitForTimeout(800);

    // Workspace page: mock the directory picker with ALL layout fixtures so
    // the tree contains every fixture and tests switch files by clicking.
    const fixtureContents: Record<string, string> = {};
    for (const name of fs.readdirSync(LAYOUT_DIR)) {
      if (name.endsWith('.md')) {
        fixtureContents[name] = fs.readFileSync(path.join(LAYOUT_DIR, name), 'utf8');
      }
    }
    workspacePage = await context.newPage();
    await workspacePage.addInitScript(`(${MOCK_PICKER_JS})(${JSON.stringify(fixtureContents)})`);

    // Pin the settings used by every render.
    await embedPage.goto(`chrome-extension://${extensionId}/ui/workspace/viewer-embed.html?embed=1`);
    await evalJs(embedPage, SET_STORAGE_JS, { ...FIXED_SETTINGS });
  });

  after(async () => {
    await context?.close();
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  // ── Mode plumbing ────────────────────────────────────────────────────────

  const ensureSettings = async (overrides: Record<string, unknown> = {}) => {
    await evalJs(embedPage, SET_STORAGE_JS, { ...FIXED_SETTINGS, ...overrides });
  };

  const openStandalone = async (fixtureName: string) => {
    await standalonePage.goto('file://' + path.join(LAYOUT_DIR, fixtureName), { waitUntil: 'load' });
    await waitFor(standalonePage, WAIT_STANDALONE_READY_JS);
    await evalJs(standalonePage, WAIT_IMAGES_JS);
  };

  const openEmbed = async (fixtureName: string) => {
    const content = fs.readFileSync(path.join(LAYOUT_DIR, fixtureName), 'utf8');
    await embedPage.goto(`chrome-extension://${extensionId}/ui/workspace/viewer-embed.html?embed=1`, { waitUntil: 'load' });
    await embedPage.waitForTimeout(600); // viewer runtime bootstrap
    await evalJs(embedPage, POST_OPEN_DOCUMENT_JS, {
      type: 'OPEN_DOCUMENT',
      content,
      filename: fixtureName,
      fileDir: '',
    });
    await waitFor(embedPage, WAIT_RENDERED_JS);
    await evalJs(embedPage, WAIT_IMAGES_JS);
  };

  const workspaceFrame = (): Frame => {
    const frame = workspacePage.frames().find((f) => f.url().includes('viewer-embed'));
    assert.ok(frame, 'workspace preview iframe not found');
    return frame;
  };

  /** Wait until the preview iframe finishes navigating (frame list is Node-side). */
  const waitForWorkspaceFrame = async (): Promise<Frame> => {
    const deadline = Date.now() + 30000;
    for (;;) {
      const frame = workspacePage.frames().find((f) => f.url().includes('viewer-embed'));
      if (frame) return frame;
      if (Date.now() >= deadline) {
        throw new Error('workspace preview iframe not found (timeout)');
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  const openWorkspace = async (fixtureName: string) => {
    const treeVisible = await evalJs<boolean>(workspacePage, `() => Boolean(document.querySelector('.tree-item'))`);
    if (!treeVisible) {
      await workspacePage.goto(`chrome-extension://${extensionId}/ui/workspace/workspace.html`, { waitUntil: 'load' });
      await evalJs(workspacePage, `() => { (document.querySelector('#pick-directory')).click(); return true; }`);
      await workspacePage.waitForSelector('.tree-item', { timeout: 30000 });
    }
    await evalJs(workspacePage, `(name) => {
      const item = Array.from(document.querySelectorAll('.tree-item')).find((el) => el.textContent.includes(name));
      if (item) item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return Boolean(item);
    }`, fixtureName);
    // The preview iframe is created lazily by the workspace bridge.
    const frame = await waitForWorkspaceFrame();
    await waitFor(frame, WAIT_RENDERED_JS);
    await evalJs(frame, WAIT_IMAGES_JS);
  };

  const modeTarget = (mode: string): Target => {
    if (mode === 'standalone') return standalonePage;
    if (mode === 'embed') return embedPage;
    if (mode === 'inline') return inlinePage;
    return workspaceFrame();
  };

  const openFixture = async (mode: string, fixtureName: string, overrides: Record<string, unknown> = {}) => {
    await ensureSettings(overrides);
    if (mode === 'standalone') await openStandalone(fixtureName);
    else if (mode === 'embed') await openEmbed(fixtureName);
    else if (mode === 'inline') await openInline(fixtureName);
    else await openWorkspace(fixtureName);
  };

  const openInline = async (fixtureName: string) => {
    const content = fs.readFileSync(path.join(LAYOUT_DIR, fixtureName), 'utf8');
    await evalJs(inlinePage, `(markdown) => {
      const el = document.getElementById('viewer');
      return el.render(markdown).then(() => true);
    }`, content);
    await waitFor(inlinePage, `() => {
      const c = document.querySelector('#viewer .markdown-viewer-content, #viewer #markdown-content');
      return Boolean(c && c.children.length > 0);
    }`);
    await waitFor(inlinePage, waitImagesJs('.markdown-viewer-content'));
  };

  const measure = (mode: string, selectors: string[]) => evalJs(modeTarget(mode), MEASURE_JS, selectors);

  /** Selector for the content root in the given mode. */
  const contentSel = (mode: string) => (mode === 'inline' ? '.markdown-viewer-content' : '#markdown-content');

  /** Wait until a selector exists inside the content root (async rendering). */
  const waitForContent = (mode: string, selector: string) =>
    waitFor(modeTarget(mode), `() => Boolean(document.querySelector('${contentSel(mode)} ${selector}'))`);

  const collectCss = (mode: string) => evalJs<string>(modeTarget(mode), COLLECT_CSS_JS);

  // ── Fixture matrix (same semantics as the Web baseline) ──────────────────

  const runFullMatrix = async (mode: string) => {
    const ctx = (name: string) => `[${mode}] ${name}`;

    // images (data-URL fixtures: relative resources are unresolvable in the
    // embed/workspace modes, and a broken image stretches block-level to the
    // container width, zeroing its auto margins)
    {
      await openFixture(mode, 'image-center-data.md');
      await waitForContent(mode, 'img');
      const m = await measure(mode, [`${contentSel(mode)} img`]);
      const img = firstOf(m, `${contentSel(mode)} img`);
      assert.equal(img.display, 'block', ctx('centered image should be block'));
      assert.equal(img.marginLeft, img.marginRight, ctx('centered image needs symmetric margins'));
      assert.ok(px(img.marginLeft) > 0, ctx('centered image needs a positive centering margin'));
    }
    {
      await openFixture(mode, 'image-left-data.md', { imageLayout: 'left' });
      await waitForContent(mode, 'img');
      const m = await measure(mode, [`${contentSel(mode)} img`]);
      const img = firstOf(m, `${contentSel(mode)} img`);
      assert.equal(img.marginLeft, '0px', ctx('left image must have zero margin-left'));
      assert.equal(img.display, 'block', ctx('left image should be block'));
    }

    // diagrams
    {
      await openFixture(mode, 'diagram-center.md');
      await waitForContent(mode, '.diagram-block');
      const m = await measure(mode, ['.diagram-block']);
      const block = firstOf(m, '.diagram-block');
      assert.equal(block.marginLeft, block.marginRight, ctx('centered diagram needs symmetric margins'));
      assert.ok(px(block.marginLeft) > 0, ctx('centered diagram needs a positive centering margin'));
    }
    {
      await openFixture(mode, 'diagram-left.md', { diagramLayout: 'left' });
      await waitForContent(mode, '.diagram-block');
      const m = await measure(mode, ['.diagram-block']);
      const block = firstOf(m, '.diagram-block');
      assert.equal(block.marginLeft, '0px', ctx('left diagram must have zero margin-left'));
      assert.equal(block.textAlign, 'left', ctx('left diagram container should be text-align:left'));
    }

    // tables
    {
      await openFixture(mode, 'table-center.md');
      await waitForContent(mode, 'table');
      const m = await measure(mode, [`${contentSel(mode)} table`]);
      const table = firstOf(m, `${contentSel(mode)} table`);
      assert.ok(Math.abs(px(table.marginLeft) - px(table.marginRight)) < 1, ctx('centered table margins symmetric within 1px'));
      assert.ok(px(table.marginLeft) > 0, ctx('centered table needs a positive centering margin'));
    }
    {
      await openFixture(mode, 'table-left.md', { tableLayout: 'left' });
      await waitForContent(mode, 'table');
      const m = await measure(mode, [`${contentSel(mode)} table`]);
      const table = firstOf(m, `${contentSel(mode)} table`);
      assert.equal(table.marginLeft, '0px', ctx('left table must have zero margin-left'));
    }
    {
      await openFixture(mode, 'table-full.md', { tableLayout: 'center-full-width' });
      await waitForContent(mode, 'table');
      const m = await measure(mode, [`${contentSel(mode)} table`]);
      const table = firstOf(m, `${contentSel(mode)} table`);
      assert.equal(table.display, 'table', ctx('full-width table should be a real table layout box'));
      // Workspace preview iframe is narrower than the 1440px baseline; the
      // semantic is "spans the content width", so require a wide table but
      // not the desktop baseline width.
      assert.ok(table.width > 400, ctx(`full-width table should span the content width (got ${table.width}px)`));
    }
    {
      await openFixture(mode, 'table-cells.md');
      await waitForContent(mode, 'table');
      const m = await measure(mode, ['table th', 'table td']);
      const th = firstOf(m, 'table th');
      const td = firstOf(m, 'table td');
      assert.equal(th.fontWeight, '700', ctx('table header should be bold'));
      assert.equal(td.fontWeight, '400', ctx('table body cells should be regular'));
      assert.notEqual(th.backgroundColor, 'rgba(0, 0, 0, 0)', ctx('table header should have a background'));
      assert.ok(px(td.paddingTop) > 0 && px(td.paddingLeft) > 0, ctx('cells should keep padding'));
      assert.ok(px(td.borderTopWidth) > 0 && px(td.borderLeftWidth) > 0, ctx('cells should keep borders'));
    }

    // blockquote
    {
      await openFixture(mode, 'blockquote-body.md');
      await waitForContent(mode, 'blockquote');
      const m = await measure(mode, ['blockquote']);
      const quote = firstOf(m, 'blockquote');
      assert.ok(px(quote.borderLeftWidth) > 0, ctx('blockquote should keep a left border'));
      assert.ok(px(quote.paddingLeft) > 0, ctx('blockquote should keep left padding'));
      assert.notEqual(quote.backgroundColor, 'rgba(0, 0, 0, 0)', ctx('blockquote should keep a themed background'));
    }

    // body typography
    {
      await openFixture(mode, 'body-text.md');
      await waitForContent(mode, 'p');
      const m = await measure(mode, [`${contentSel(mode)} p`]);
      const p = firstOf(m, `${contentSel(mode)} p`);
      assert.equal(p.fontSize, '16px', ctx('body font size should stay 16px'));
      assert.equal(p.lineHeight, '24px', ctx('body line-height should stay 1.5 (24px)'));
      assert.notEqual(p.color, 'rgba(0, 0, 0, 0)', ctx('body text color should be set'));
      assert.ok(p.fontFamily.includes('FangSong'), ctx('body font stack should keep FangSong first'));
    }

    // headings
    {
      await openFixture(mode, 'headings.md');
      await waitForContent(mode, 'h1');
      const m = await measure(mode, [`${contentSel(mode)} h1`, `${contentSel(mode)} h2`]);
      const h1 = firstOf(m, `${contentSel(mode)} h1`);
      const h2 = firstOf(m, `${contentSel(mode)} h2`);
      assert.ok(px(h1.marginTop) > 0 && px(h1.marginBottom) > 0, ctx('h1 should keep block spacing'));
      assert.ok(px(h2.marginTop) > 0 && px(h2.marginBottom) > 0, ctx('h2 should keep block spacing'));
      assert.equal(h1.fontSize, '24px', ctx('h1 should stay 24px'));
      assert.equal(h2.fontSize, '21.3333px', ctx('h2 should stay 21.3333px'));
    }

    // hr
    {
      await openFixture(mode, 'hr.md');
      await waitForContent(mode, 'hr');
      const m = await measure(mode, ['hr']);
      const hr = firstOf(m, 'hr');
      assert.ok(px(hr.marginTop) > 0 && px(hr.marginBottom) > 0, ctx('hr should keep vertical margins'));
      assert.notEqual(hr.backgroundColor, 'rgba(0, 0, 0, 0)', ctx('hr should render a visible rule'));
    }

    // inline formatting
    {
      await openFixture(mode, 'text-format.md');
      await waitForContent(mode, 'strong');
      const m = await measure(mode, ['strong', 'em', 'del', 'a', `${contentSel(mode)} code`]);
      assert.equal(firstOf(m, 'strong').fontWeight, '700', ctx('strong should render bold'));
      assert.equal(firstOf(m, 'em').fontStyle, 'italic', ctx('em should render italic'));
      assert.equal(firstOf(m, 'del').textDecorationLine, 'line-through', ctx('del should render struck through'));
      const link = firstOf(m, 'a');
      assert.notEqual(link.color, 'rgb(23, 23, 23)', ctx('links should use an accent color, not body color'));
      assert.equal(link.textDecorationLine, 'none', ctx('links should not be underlined'));
      const code = firstOf(m, `${contentSel(mode)} code`);
      assert.notEqual(code.backgroundColor, 'rgba(0, 0, 0, 0)', ctx('inline code should have a background'));
      assert.ok(px(code.paddingLeft) > 0, ctx('inline code should keep horizontal padding'));
      assert.ok(px(code.fontSize) < 16, ctx('inline code should be smaller than body text'));
    }

    // lists
    {
      await openFixture(mode, 'list.md');
      await waitForContent(mode, 'ul');
      const m = await measure(mode, ['ul', 'ol', 'ul li']);
      assert.ok(px(firstOf(m, 'ul').paddingLeft) > 0, ctx('unordered list should keep indentation padding'));
      assert.ok(px(firstOf(m, 'ol').paddingLeft) > 0, ctx('ordered list should keep indentation padding'));
      const li = firstOf(m, 'ul li');
      assert.equal(li.fontSize, '16px', ctx('list items should use the body font size'));
      assert.ok(px(li.marginBottom) > 0, ctx('list items should keep bottom spacing'));
    }

    // code blocks (pagination compatibility: no scroll containers)
    {
      await openFixture(mode, 'code-block.md');
      await waitForContent(mode, 'pre');
      const m = await measure(mode, [`${contentSel(mode)} pre`]);
      const pre = firstOf(m, `${contentSel(mode)} pre`);
      assert.equal(pre.overflowX, 'visible', ctx('pre must not be a horizontal scroll container (pagination)'));
      assert.equal(pre.overflowY, 'visible', ctx('pre must not be a vertical scroll container (pagination)'));
      assert.notEqual(pre.backgroundColor, 'rgba(0, 0, 0, 0)', ctx('pre should have a background'));
    }

    // footnotes & math
    {
      await openFixture(mode, 'footnotes.md');
      await waitForContent(mode, 'section.footnotes');
      const m = await measure(mode, ['section.footnotes', 'sup']);
      const section = firstOf(m, 'section.footnotes');
      assert.ok(px(section.fontSize) > 0, ctx('footnotes section should have typography'));
      firstOf(m, 'sup');
    }
    {
      await openFixture(mode, 'math.md');
      await waitForContent(mode, '.katex-display');
      const m = await measure(mode, ['.katex-display', '.katex']);
      const display = firstOf(m, '.katex-display');
      assert.ok(px(display.marginTop) > 0 && px(display.marginBottom) > 0, ctx('display math should keep block margins'));
      assert.equal(firstOf(m, '.katex').fontSize, '16px', ctx('KaTeX should follow the body font size'));
    }
  };

  const runCollectionContract = async (mode: string) => {
    await openFixture(mode, 'diagram-center.md');
    const css = await collectCss(mode);

    assert.ok(
      /#markdown-content \.diagram-block[^{]*\{[^}]*margin\s*:\s*20px\s+auto/.test(css),
      `[${mode}] collected stylesheet must carry the diagram centering rule`,
    );
    assert.ok(
      /#markdown-content img\s*\{[^}]*max-width\s*:\s*100%/.test(css),
      `[${mode}] collected stylesheet must carry the shared img sizing rule`,
    );
    assert.ok(
      /#markdown-content svg\s*\{[^}]*max-width\s*:\s*100%/.test(css),
      `[${mode}] collected stylesheet must carry the shared svg sizing rule`,
    );
    assert.ok(css.includes('.katex'), `[${mode}] collected stylesheet must carry KaTeX rules`);
    assert.ok(css.includes('#markdown-page'), `[${mode}] collected stylesheet must carry page-level rules`);
    // standalone/inline host pages load a FILTERED stylesheet (no @font-face)
    // while workspace/embed load the full ui/styles.css (same-origin fonts).
    if (mode === 'workspace' || mode === 'embed') {
      assert.ok(css.includes('@font-face'), `[${mode}] collected stylesheet must keep @font-face (same-origin fonts)`);
    }
  };

  for (const mode of ['standalone', 'workspace', 'embed', 'inline']) {
    describe(mode, () => {
      it('layout classes live on the render target only (single layer)', async () => {
        await openFixture(mode, 'image-center-data.md');
        await waitForContent(mode, 'img');
        const result = await evalJs<{ targetHasLayout: boolean; holders: number; single: boolean }>(modeTarget(mode), `() => {
          const root = document.querySelector('#markdown-content, .markdown-viewer-content');
          const cls = (el) => Array.from((el.className || '').split(' ')).filter((x) => x.includes('-layout-'));
          // Hosts either render into the content root itself or into a child
          // .markdown-viewer-content (content-script takeover, embed, etc.).
          const target = root.querySelector(':scope > .markdown-viewer-content') || root;
          const holders = [root, ...Array.from(root.querySelectorAll('*'))]
            .filter((el) => cls(el).length > 0);
          return {
            targetHasLayout: cls(target).length > 0,
            holders: holders.length,
            single: holders.length === 1 && holders[0] === target,
          };
        }`);
        assert.ok(
          result.targetHasLayout,
          `[${mode}] the render target must carry the layout classes`,
        );
        assert.ok(
          result.single,
          `[${mode}] layout classes must live on the render target only (single layer; got ${result.holders} holders)`,
        );
      });

      it('collects the full shared export stylesheet (diagram rule present)', async () => {
        await runCollectionContract(mode);
      });

      it('renders the full fixture matrix', async () => {
        await runFullMatrix(mode);
      });
    });
  }

  // Inline-specific concerns on top of the shared matrix above: the host page
  // must receive the shared content stylesheet in FILTERED form only.
  it('inline mode injects a filtered content stylesheet (host page untouched)', async () => {
    await openFixture('inline', 'diagram-center.md');
    const hasStyles = await evalJs<boolean>(inlinePage, `() => {
      const style = document.getElementById('mv-content-styles');
      return Boolean(style && style.textContent.includes('.diagram-block'));
    }`);
    assert.ok(hasStyles, 'inline mode must inject the shared content styles (diagram rule present)');
    // The host page itself must not be restyled by global rules.
    const hostClean = await evalJs<boolean>(inlinePage, `() => {
      const wrap = document.querySelector('.viewer-wrap');
      return Boolean(wrap && getComputedStyle(wrap).overflowY !== 'hidden');
    }`);
    assert.ok(hostClean, 'the filtered stylesheet must not leak global body rules into the host page');
  });
});
