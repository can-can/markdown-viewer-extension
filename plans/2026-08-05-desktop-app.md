# docu.md Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A macOS Electron app that opens multiple local folders as tabs, each folder owning its own file tree and its own row of file tabs, with open files re-rendering in place when they change on disk.

**Architecture:** A new `desktop/` platform shell alongside `chrome/`, `vscode/`, `obsidian/`, and `mobile/`. The Electron main process owns all filesystem access (directory listing, file reads, chokidar watching) and exposes a narrow `contextBridge` surface. The renderer holds pure workspace state plus a bounded LRU pool of viewer iframes. Rendering reuses the existing shared core: the renderer imports `startViewer` from `chrome/src/webview/viewer-main` — the same cross-platform import `firefox/src/webview/main.ts` already does — supplying its own `PlatformAPI` implementation.

**Tech Stack:** Electron, TypeScript, esbuild (already a dependency), chokidar, electron-builder, `node:test`, Playwright `_electron` for the smoke test.

Spec: `specs/2026-08-04-desktop-app-design.md`

## Global Constraints

- **Platform target:** macOS only. Build config stays cross-platform-capable; only macOS ships.
- **Viewer pool cap:** 8 live views. The active view is never evictable.
- **Watcher debounce:** 100ms. Ignore `.git` and `node_modules`.
- **Electron security:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The renderer never touches `fs` or `path`.
- **Path containment:** every path crossing IPC is resolved against its folder root in the main process and rejected if it escapes.
- **Supported files:** filter to `ALL_SUPPORTED_EXTENSIONS` from `src/types/formats`, matching current workspace behavior.
- **Tests:** `node:test` + `node:assert/strict`, run with `node --test test/<file>.test.ts`. Node 24 strips TypeScript natively — no build step for tests. Import source with the `.ts` extension, matching `test/canvas-renderer.test.ts`.
- **Module formats:** main and preload bundle to CJS (`platform: 'node'`, `external: ['electron']`); renderer bundles to ESM (`platform: 'browser'`).
- **Dependency install:** `electron`, `electron-builder`, `chokidar`, and `@playwright/test` install at latest stable and are pinned in `desktop/package.json` by the install itself. Do not hand-write version ranges.
- **Commits:** land on `main` directly. No feature branch.

## Deviations from the spec, decided during planning

Two things the spec got optimistic about. Both are corrected here; update the spec when Task 1 lands.

1. **`chrome/src/workspace/viewer-embed.ts` cannot be reused verbatim.** It imports `../webview/index`, which sets `globalThis.platform` to the Chrome implementation, and types on `ChromeDocumentService`. The desktop gets its own adapted copy (Task 8). It is ~90 lines shorter because the back/forward history controls are dropped along with nav history.
2. **`chrome/src/webview/viewer-main.ts` (1,644 lines) is reused directly, not copied.** It already takes `{ platform, pluginRenderer, themeConfigRenderer }` as parameters, and `firefox/src/webview/main.ts` already imports it across platform folders. The desktop follows that precedent.

`workspace-embed-host-ui.ts` and `workspace-embed-parent-bridge.ts` are imported from `chrome/src/workspace/` unchanged. `workspace-embed-bridge.ts` needs a one-line type widening (Task 8, Step 1).

## File Structure

```
desktop/
  package.json                        electron, electron-builder, chokidar (app-local deps)
  build.js                            esbuild → dist/desktop/, then electron-builder
  electron-builder.yml                macOS packaging config
  types/
    ipc.ts                            shared main↔renderer contract, imported by both sides
  src/
    main/
      main.ts                         app lifecycle, BrowserWindow, docmd:// protocol
      workspace-fs.ts                 lazy directory listing, file reads, path containment
      file-watcher.ts                 chokidar per open folder
      ipc.ts                          typed handler registration
    preload/
      preload.ts                      contextBridge surface
    renderer/
      index.html                      shell markup: folder strip, sidebar, tab strip, preview
      main.ts                         bootstrap — wires model to views
      workspace-model.ts              pure state, no DOM
      folder-tabs.ts                  folder tab strip
      file-tabs.ts                    per-folder file tab strip
      file-tree.ts                    tree rendering, ported from workspace.ts
      viewer-pool.ts                  LRU pool of viewer iframes
      api-impl.ts                     PlatformAPI implementation (webview end)
      service-host.ts                 host end of the direct transport pair
      viewer-view.ts                  real iframe factory for the pool
      viewer-embed.ts                 adapted from chrome/src/workspace/viewer-embed.ts
      viewer-embed.html
      workspace.css                   based on chrome/src/workspace/workspace.css
test/
  desktop-workspace-fs.test.ts
  desktop-workspace-model.test.ts
  desktop-viewer-pool.test.ts
  desktop-smoke.test.ts               Playwright _electron
  fixtures/desktop/                   fixture folders for tests
```

Responsibility split follows the spec: `workspace-model.ts` holds every folder/tab decision and has no DOM dependency, so it is testable without launching Electron. `viewer-pool.ts` owns iframe lifetime only. The three view files render and emit events; they hold no state of their own.

---

### Task 1: Electron scaffold, build pipeline, and launch smoke test

**Files:**
- Create: `desktop/package.json`
- Create: `desktop/build.js`
- Create: `desktop/src/main/main.ts`
- Create: `desktop/src/renderer/index.html`
- Create: `desktop/src/renderer/main.ts`
- Create: `desktop/src/renderer/workspace.css`
- Modify: `package.json` (add `dev:desktop`, `build:desktop` scripts)
- Modify: `tsconfig.json:36-42` (add `desktop/src/**/*` to `include`)
- Modify: `.gitignore` (add `dist/desktop`)
- Test: `test/desktop-smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a launchable app. `dist/desktop/main.cjs` is the Electron entry. The renderer is served from `docmd://app/index.html`. Later tasks add IPC to `desktop/src/main/main.ts` via `registerIpcHandlers(win)`.

- [ ] **Step 1: Install dependencies**

```bash
npm install --save-dev electron electron-builder chokidar @playwright/test
```

These land in the root `package.json` devDependencies. `desktop/package.json` exists only to mark the app entry point and CJS module type for electron-builder.

- [ ] **Step 2: Write the failing smoke test**

Create `test/desktop-smoke.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/desktop-smoke.test.ts`
Expected: FAIL — `dist/desktop/main.cjs` does not exist.

- [ ] **Step 4: Create `desktop/package.json`**

```json
{
  "name": "docu-md-desktop",
  "productName": "docu.md",
  "version": "5.2.1",
  "main": "main.cjs",
  "type": "commonjs",
  "private": true
}
```

This file is copied into `dist/desktop/` by the build so electron-builder finds the entry point. The `version` is synced from the root `package.json` by `build.js`, mirroring how `chrome/build.js:19-40` syncs `manifest.json`.

- [ ] **Step 5: Write the main process**

Create `desktop/src/main/main.ts`:

```ts
import { app, BrowserWindow, protocol, net } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DIST_DIR = __dirname;

// A custom scheme gives the renderer a real origin. With file:// the viewer
// iframes would be opaque origins, which breaks both postMessage targeting and
// relative asset fetches inside the viewer.
protocol.registerSchemesAsPrivileged([
  { scheme: 'docmd', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: path.join(DIST_DIR, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  void win.loadURL('docmd://app/index.html');
  return win;
}

app.whenReady().then(() => {
  protocol.handle('docmd', (request) => {
    const { pathname } = new URL(request.url);
    const target = path.join(DIST_DIR, pathname);
    // Containment: never serve outside the bundled dist directory.
    if (!target.startsWith(DIST_DIR)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

- [ ] **Step 6: Write the renderer shell**

Create `desktop/src/renderer/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self' docmd:; script-src 'self' docmd:; style-src 'self' docmd: 'unsafe-inline'; img-src 'self' docmd: data: blob:;">
  <title>docu.md</title>
  <link rel="stylesheet" href="workspace.css">
</head>
<body>
  <div id="landing" class="landing">
    <div class="landing-card">
      <h1 class="landing-title">docu.md</h1>
      <p class="landing-desc">Open a folder to browse and preview its documents.</p>
      <button id="open-folder" class="landing-btn">Open Folder</button>
    </div>
  </div>

  <div id="workspace" class="workspace" hidden>
    <div id="folder-tabs" class="folder-tabs" role="tablist"></div>
    <div class="workspace-body">
      <div id="sidebar" class="sidebar">
        <div id="file-tree" class="file-tree"></div>
      </div>
      <div class="resize-handle" id="resize-handle"></div>
      <div class="main-pane">
        <div id="file-tabs" class="file-tabs" role="tablist"></div>
        <div id="viewer-host" class="viewer-host"></div>
      </div>
    </div>
  </div>

  <script type="module" src="renderer.js"></script>
</body>
</html>
```

Create `desktop/src/renderer/main.ts`:

```ts
// Bootstrap. Later tasks wire the model and views in here.
export {};
```

- [ ] **Step 7: Write the stylesheet base**

Create `desktop/src/renderer/workspace.css` by copying `chrome/src/workspace/workspace.css`, then append the shell layout:

```bash
cp chrome/src/workspace/workspace.css desktop/src/renderer/workspace.css
```

Append to `desktop/src/renderer/workspace.css`:

```css
/* ── Desktop shell layout ─────────────────────────────────────────── */
.workspace { display: flex; flex-direction: column; height: 100vh; }
.workspace-body { display: flex; flex: 1; min-height: 0; }
.main-pane { display: flex; flex-direction: column; flex: 1; min-width: 0; }

.folder-tabs {
  display: flex; align-items: center; gap: 2px;
  height: 38px; padding: 0 8px 0 78px; /* 78px clears the macOS traffic lights */
  border-bottom: 1px solid var(--mv-border, #e1e4e8);
  -webkit-app-region: drag;
}
.folder-tabs > * { -webkit-app-region: no-drag; }

.file-tabs {
  display: flex; align-items: stretch; gap: 1px;
  height: 34px; overflow-x: auto;
  border-bottom: 1px solid var(--mv-border, #e1e4e8);
}

.viewer-host { position: relative; flex: 1; min-height: 0; }
.viewer-host > iframe {
  position: absolute; inset: 0;
  width: 100%; height: 100%; border: 0;
}
/* Inactive views stay laid out so Mermaid/KaTeX/drawio measure a real box. */
.viewer-host > iframe[data-active='false'] { visibility: hidden; pointer-events: none; }
```

- [ ] **Step 8: Write the build script**

Create `desktop/build.js`:

```js
#!/usr/bin/env node

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const outdir = path.join(projectRoot, 'dist/desktop');

const watch = process.argv.includes('--watch');

function syncVersion() {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const appPkgPath = path.join(__dirname, 'package.json');
  const appPkg = JSON.parse(fs.readFileSync(appPkgPath, 'utf8'));
  if (appPkg.version !== rootPkg.version) {
    appPkg.version = rootPkg.version;
    fs.writeFileSync(appPkgPath, `${JSON.stringify(appPkg, null, 2)}\n`, 'utf8');
  }
  return rootPkg.version;
}

const version = syncVersion();
console.log(`🔨 Building docu.md Desktop... v${version}\n`);

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });
process.chdir(projectRoot);

const shared = { bundle: true, sourcemap: true, logLevel: 'info' };

await build({
  ...shared,
  entryPoints: { main: 'desktop/src/main/main.ts' },
  outdir,
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  format: 'cjs',
  external: ['electron', 'chokidar', 'fsevents'],
});

await build({
  ...shared,
  entryPoints: { preload: 'desktop/src/preload/preload.ts' },
  outdir,
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});

await build({
  ...shared,
  entryPoints: { renderer: 'desktop/src/renderer/main.ts' },
  outdir,
  platform: 'browser',
  format: 'esm',
  target: 'chrome120',
});

// Static assets.
for (const file of ['index.html', 'workspace.css']) {
  fs.copyFileSync(path.join(__dirname, 'src/renderer', file), path.join(outdir, file));
}
fs.copyFileSync(path.join(__dirname, 'package.json'), path.join(outdir, 'package.json'));

console.log(`\n✅ Build complete → dist/desktop/`);

if (watch) {
  console.log('👀 Watching is not wired yet; re-run the build after edits.');
}
```

- [ ] **Step 9: Wire npm scripts and tsconfig**

Add to `package.json` `scripts`, after `"build:obsidian"`:

```json
"build:desktop": "node desktop/build.js",
"dev:desktop": "node desktop/build.js && electron dist/desktop/main.cjs",
"test": "node --test test/*.test.ts test/*.test.js"
```

Add `"desktop/src/**/*"` to the `include` array in `tsconfig.json`.

Add to `.gitignore`:

```
dist/desktop
```

- [ ] **Step 10: Build and run the test to verify it passes**

Run: `npm run build:desktop && node --test test/desktop-smoke.test.ts`
Expected: PASS — a window opens showing the landing card.

- [ ] **Step 11: Verify the app launches interactively**

Run: `npm run dev:desktop`
Expected: a window with the macOS inset title bar and the "Open Folder" landing card. Close it.

- [ ] **Step 12: Update the spec with the two planning deviations**

In `specs/2026-08-04-desktop-app-design.md`, move `chrome/src/workspace/viewer-embed.ts` and `viewer-embed.html` out of "Reused without modification" into "Ported with changes", and add a line noting `chrome/src/webview/viewer-main.ts` is imported directly, following the `firefox/src/webview/main.ts` precedent.

- [ ] **Step 13: Commit**

```bash
git add desktop package.json tsconfig.json .gitignore test/desktop-smoke.test.ts specs/2026-08-04-desktop-app-design.md
git commit -m "feat(desktop): scaffold Electron shell with build pipeline and launch smoke test"
```

---

### Task 2: Filesystem access in the main process

**Files:**
- Create: `desktop/types/ipc.ts`
- Create: `desktop/src/main/workspace-fs.ts`
- Create: `desktop/src/main/ipc.ts`
- Create: `desktop/src/preload/preload.ts`
- Modify: `desktop/src/main/main.ts` (call `registerIpcHandlers`)
- Test: `test/desktop-workspace-fs.test.ts`, `test/fixtures/desktop/`

**Interfaces:**
- Consumes: `ALL_SUPPORTED_EXTENSIONS` from `src/types/formats`.
- Produces:
  - `DirEntry = { name: string; relPath: string; kind: 'file' | 'directory' }`
  - `listDir(root: string, relPath: string): Promise<DirEntry[]>` — one level, not recursive
  - `readFile(root: string, relPath: string, binary: boolean): Promise<string>` — utf8 text, or base64 when `binary`
  - `resolveWithin(root: string, relPath: string): string` — throws `Error('EPATHESCAPE')` on escape
  - `window.desktop` in the renderer, typed as `DesktopBridge` in `desktop/types/ipc.ts`

- [ ] **Step 1: Create the fixture folders**

```bash
mkdir -p test/fixtures/desktop/alpha/nested test/fixtures/desktop/beta
printf '# Alpha\n\nAlpha root document.\n' > test/fixtures/desktop/alpha/README.md
printf '# Nested\n\nNested document.\n' > test/fixtures/desktop/alpha/nested/deep.md
printf 'binary-ish\n' > test/fixtures/desktop/alpha/notes.txt
printf 'ignored\n' > test/fixtures/desktop/alpha/image.zzz
printf '# Beta\n\nBeta document.\n' > test/fixtures/desktop/beta/index.md
```

`.zzz` is not in `ALL_SUPPORTED_EXTENSIONS`, so it exercises the filter. `.txt` is supported (`demo/test.txt` exists), so it should appear.

- [ ] **Step 2: Write the failing test**

Create `test/desktop-workspace-fs.test.ts`:

```ts
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

  it('rejects a path escaping the root', () => {
    assert.throws(() => resolveWithin(alpha, '../beta/index.md'), /EPATHESCAPE/);
  });

  it('rejects an absolute path', () => {
    assert.throws(() => resolveWithin(alpha, '/etc/passwd'), /EPATHESCAPE/);
  });

  it('rejects a path escaping via a nested traversal', () => {
    assert.throws(() => resolveWithin(alpha, 'nested/../../beta/index.md'), /EPATHESCAPE/);
  });
});

describe('listDir', () => {
  it('lists one level, directories before files, alphabetically', async () => {
    const entries = await listDir(alpha, '');
    assert.deepEqual(entries.map((e) => e.name), ['nested', 'README.md', 'notes.txt']);
    assert.equal(entries[0].kind, 'directory');
  });

  it('omits unsupported extensions', async () => {
    const entries = await listDir(alpha, '');
    assert.equal(entries.some((e) => e.name === 'image.zzz'), false);
  });

  it('returns relPath values usable for a follow-up listDir', async () => {
    const entries = await listDir(alpha, '');
    const nested = entries.find((e) => e.name === 'nested');
    assert.equal(nested?.relPath, 'nested');
    const children = await listDir(alpha, nested!.relPath);
    assert.deepEqual(children.map((e) => e.name), ['deep.md']);
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/desktop-workspace-fs.test.ts`
Expected: FAIL — cannot find module `workspace-fs.ts`.

- [ ] **Step 4: Write the IPC contract**

Create `desktop/types/ipc.ts`:

```ts
export interface DirEntry {
  name: string;
  /** Path relative to the folder root, POSIX separators, '' for the root itself. */
  relPath: string;
  kind: 'file' | 'directory';
}

export interface OpenedFolder {
  id: string;
  /** Absolute path on disk. Renderer treats this as an opaque identifier. */
  path: string;
  name: string;
}

export type FileChangeKind = 'change' | 'add' | 'unlink';

export interface FileChangeEvent {
  folderId: string;
  relPath: string;
  kind: FileChangeKind;
}

export interface DesktopBridge {
  openFolderDialog(): Promise<OpenedFolder | null>;
  closeFolder(folderId: string): Promise<void>;
  listDir(folderId: string, relPath: string): Promise<DirEntry[]>;
  readFile(folderId: string, relPath: string, binary: boolean): Promise<string>;
  onFileChanged(handler: (event: FileChangeEvent) => void): () => void;
}

declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}
```

- [ ] **Step 5: Write `workspace-fs.ts`**

Create `desktop/src/main/workspace-fs.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { ALL_SUPPORTED_EXTENSIONS } from '../../../src/types/formats';
import type { DirEntry } from '../../types/ipc';

const SUPPORTED = new Set(ALL_SUPPORTED_EXTENSIONS.map((ext) => ext.toLowerCase()));

/** Directories never worth walking, matching the watcher's ignore list. */
const SKIP_DIRS = new Set(['.git', 'node_modules']);

export function resolveWithin(root: string, relPath: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relPath);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`EPATHESCAPE: ${relPath} escapes ${root}`);
  }
  return target;
}

function isSupportedFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  // Two-part extensions such as .slides.md still match on their final segment.
  return ext !== '' && SUPPORTED.has(ext);
}

export async function listDir(root: string, relPath: string): Promise<DirEntry[]> {
  const dir = resolveWithin(root, relPath);
  const dirents = await fs.readdir(dir, { withFileTypes: true });

  const entries: DirEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.') && dirent.name !== '.github') continue;
    if (dirent.isDirectory()) {
      if (SKIP_DIRS.has(dirent.name)) continue;
      entries.push({
        name: dirent.name,
        relPath: path.posix.join(relPath, dirent.name),
        kind: 'directory',
      });
    } else if (dirent.isFile() && isSupportedFile(dirent.name)) {
      entries.push({
        name: dirent.name,
        relPath: path.posix.join(relPath, dirent.name),
        kind: 'file',
      });
    }
  }

  // Directories first, then files, each alphabetical and case-insensitive.
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return entries;
}

export async function readFile(root: string, relPath: string, binary: boolean): Promise<string> {
  const target = resolveWithin(root, relPath);
  const buffer = await fs.readFile(target);
  return binary ? buffer.toString('base64') : buffer.toString('utf8');
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test test/desktop-workspace-fs.test.ts`
Expected: PASS — all 12 assertions.

- [ ] **Step 7: Write the IPC handlers**

Create `desktop/src/main/ipc.ts`:

```ts
import { ipcMain, dialog, BrowserWindow } from 'electron';
import path from 'node:path';
import { listDir, readFile } from './workspace-fs';
import type { DirEntry, OpenedFolder } from '../../types/ipc';

/** folderId → absolute root path. The renderer never sees a raw path it can forge. */
const openFolders = new Map<string, string>();
let folderIdCounter = 0;

export function getFolderRoot(folderId: string): string {
  const root = openFolders.get(folderId);
  if (!root) throw new Error(`ENOFOLDER: ${folderId}`);
  return root;
}

export function forEachOpenFolder(fn: (folderId: string, root: string) => void): void {
  for (const [id, root] of openFolders) fn(id, root);
}

export function registerIpcHandlers(win: BrowserWindow): void {
  ipcMain.handle('folder:open', async (): Promise<OpenedFolder | null> => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      buttonLabel: 'Open Folder',
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const root = result.filePaths[0];
    const id = `f${++folderIdCounter}`;
    openFolders.set(id, root);
    return { id, path: root, name: path.basename(root) };
  });

  ipcMain.handle('folder:close', (_event, folderId: string): void => {
    openFolders.delete(folderId);
  });

  ipcMain.handle('fs:listDir', (_event, folderId: string, relPath: string): Promise<DirEntry[]> => {
    return listDir(getFolderRoot(folderId), relPath);
  });

  ipcMain.handle('fs:readFile', (_event, folderId: string, relPath: string, binary: boolean): Promise<string> => {
    return readFile(getFolderRoot(folderId), relPath, binary);
  });
}
```

- [ ] **Step 8: Write the preload bridge**

Create `desktop/src/preload/preload.ts`:

```ts
import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, DirEntry, FileChangeEvent, OpenedFolder } from '../../types/ipc';

const bridge: DesktopBridge = {
  openFolderDialog: (): Promise<OpenedFolder | null> => ipcRenderer.invoke('folder:open'),
  closeFolder: (folderId: string): Promise<void> => ipcRenderer.invoke('folder:close', folderId),
  listDir: (folderId: string, relPath: string): Promise<DirEntry[]> =>
    ipcRenderer.invoke('fs:listDir', folderId, relPath),
  readFile: (folderId: string, relPath: string, binary: boolean): Promise<string> =>
    ipcRenderer.invoke('fs:readFile', folderId, relPath, binary),
  onFileChanged: (handler: (event: FileChangeEvent) => void): (() => void) => {
    const listener = (_event: unknown, payload: FileChangeEvent): void => handler(payload);
    ipcRenderer.on('fs:changed', listener);
    return () => { ipcRenderer.off('fs:changed', listener); };
  },
};

contextBridge.exposeInMainWorld('desktop', bridge);
```

- [ ] **Step 9: Wire the handlers into the main process**

In `desktop/src/main/main.ts`, add the import and the call inside `createWindow`:

```ts
import { registerIpcHandlers } from './ipc';
```

Immediately before `win.once('ready-to-show', ...)`:

```ts
  registerIpcHandlers(win);
```

- [ ] **Step 10: Verify the bridge reaches the renderer**

Add to `desktop/src/renderer/main.ts` temporarily:

```ts
console.log('desktop bridge:', Object.keys(window.desktop));
```

Run: `npm run dev:desktop`, open the DevTools console (View → Toggle Developer Tools).
Expected: `desktop bridge: ['openFolderDialog', 'closeFolder', 'listDir', 'readFile', 'onFileChanged']`. Then revert `main.ts` to `export {};`.

- [ ] **Step 11: Commit**

```bash
git add desktop test/desktop-workspace-fs.test.ts test/fixtures/desktop
git commit -m "feat(desktop): add main-process filesystem access with path containment"
```

---

### Task 3: Workspace state model

**Files:**
- Create: `desktop/src/renderer/workspace-model.ts`
- Test: `test/desktop-workspace-model.test.ts`

**Interfaces:**
- Consumes: `DirEntry`, `OpenedFolder` from `desktop/types/ipc`.
- Produces:
  - `TreeNode = DirEntry & { children?: TreeNode[]; childrenLoaded?: boolean }`
  - `Tab = { relPath: string; name: string; scrollLine: number; dirty: boolean }`
  - `FolderState = { id, path, name, tree, tabs, activeRelPath, expandedPaths, status }`
  - `createWorkspaceModel(): WorkspaceModel` with methods `addFolder`, `removeFolder`, `activateFolder`, `openTab`, `closeTab`, `activateTab`, `setTree`, `setChildren`, `toggleExpanded`, `markDirty`, `setScrollLine`, `setFolderStatus`, `getState`, `subscribe`
  - `viewKey(folderId: string, relPath: string): string` — the `folderId:relPath` key the viewer pool uses

- [ ] **Step 1: Write the failing test**

Create `test/desktop-workspace-model.test.ts`:

```ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceModel, viewKey, type WorkspaceModel } from '../desktop/src/renderer/workspace-model.ts';

const alpha = { id: 'f1', path: '/tmp/alpha', name: 'alpha' };
const beta = { id: 'f2', path: '/tmp/beta', name: 'beta' };

describe('viewKey', () => {
  it('joins folder id and relative path', () => {
    assert.equal(viewKey('f1', 'docs/api.md'), 'f1:docs/api.md');
  });
});

describe('folders', () => {
  let model: WorkspaceModel;
  beforeEach(() => { model = createWorkspaceModel(); });

  it('starts empty with no active folder', () => {
    assert.deepEqual(model.getState().folders, []);
    assert.equal(model.getState().activeFolderId, null);
  });

  it('activates the first folder added', () => {
    model.addFolder(alpha);
    assert.equal(model.getState().activeFolderId, 'f1');
  });

  it('activates each newly added folder', () => {
    model.addFolder(alpha);
    model.addFolder(beta);
    assert.equal(model.getState().activeFolderId, 'f2');
    assert.deepEqual(model.getState().folders.map((f) => f.id), ['f1', 'f2']);
  });

  it('ignores a folder path that is already open, activating it instead', () => {
    model.addFolder(alpha);
    model.addFolder(beta);
    model.addFolder({ id: 'f3', path: '/tmp/alpha', name: 'alpha' });
    assert.deepEqual(model.getState().folders.map((f) => f.id), ['f1', 'f2']);
    assert.equal(model.getState().activeFolderId, 'f1');
  });

  it('activates the neighbor when the active folder is removed', () => {
    model.addFolder(alpha);
    model.addFolder(beta);
    model.removeFolder('f2');
    assert.equal(model.getState().activeFolderId, 'f1');
  });

  it('clears the active folder when the last one is removed', () => {
    model.addFolder(alpha);
    model.removeFolder('f1');
    assert.equal(model.getState().activeFolderId, null);
    assert.deepEqual(model.getState().folders, []);
  });
});

describe('tabs', () => {
  let model: WorkspaceModel;
  beforeEach(() => {
    model = createWorkspaceModel();
    model.addFolder(alpha);
    model.addFolder(beta);
  });

  it('opens a tab and makes it active', () => {
    model.openTab('f1', 'README.md');
    const folder = model.getFolder('f1')!;
    assert.deepEqual(folder.tabs.map((t) => t.relPath), ['README.md']);
    assert.equal(folder.activeRelPath, 'README.md');
  });

  it('derives the tab name from the relative path', () => {
    model.openTab('f1', 'docs/api.md');
    assert.equal(model.getFolder('f1')!.tabs[0].name, 'api.md');
  });

  it('activates the existing tab instead of duplicating', () => {
    model.openTab('f1', 'a.md');
    model.openTab('f1', 'b.md');
    model.openTab('f1', 'a.md');
    const folder = model.getFolder('f1')!;
    assert.deepEqual(folder.tabs.map((t) => t.relPath), ['a.md', 'b.md']);
    assert.equal(folder.activeRelPath, 'a.md');
  });

  it('keeps tabs isolated per folder', () => {
    model.openTab('f1', 'a.md');
    model.openTab('f2', 'z.md');
    assert.deepEqual(model.getFolder('f1')!.tabs.map((t) => t.relPath), ['a.md']);
    assert.deepEqual(model.getFolder('f2')!.tabs.map((t) => t.relPath), ['z.md']);
  });

  it('preserves each folder tab state across folder switches', () => {
    model.openTab('f1', 'a.md');
    model.openTab('f1', 'b.md');
    model.openTab('f2', 'z.md');
    model.activateFolder('f1');
    assert.equal(model.getFolder('f1')!.activeRelPath, 'b.md');
    model.activateFolder('f2');
    assert.equal(model.getFolder('f2')!.activeRelPath, 'z.md');
  });

  it('activates the right neighbor when the active tab is closed', () => {
    model.openTab('f1', 'a.md');
    model.openTab('f1', 'b.md');
    model.openTab('f1', 'c.md');
    model.activateTab('f1', 'b.md');
    model.closeTab('f1', 'b.md');
    assert.equal(model.getFolder('f1')!.activeRelPath, 'c.md');
  });

  it('activates the left neighbor when the last tab is closed', () => {
    model.openTab('f1', 'a.md');
    model.openTab('f1', 'b.md');
    model.closeTab('f1', 'b.md');
    assert.equal(model.getFolder('f1')!.activeRelPath, 'a.md');
  });

  it('clears the active tab when the only tab is closed', () => {
    model.openTab('f1', 'a.md');
    model.closeTab('f1', 'a.md');
    assert.equal(model.getFolder('f1')!.activeRelPath, null);
    assert.deepEqual(model.getFolder('f1')!.tabs, []);
  });

  it('leaves the active tab alone when a non-active tab is closed', () => {
    model.openTab('f1', 'a.md');
    model.openTab('f1', 'b.md');
    model.closeTab('f1', 'a.md');
    assert.equal(model.getFolder('f1')!.activeRelPath, 'b.md');
  });
});

describe('tree', () => {
  let model: WorkspaceModel;
  beforeEach(() => {
    model = createWorkspaceModel();
    model.addFolder(alpha);
    model.setTree('f1', [
      { name: 'docs', relPath: 'docs', kind: 'directory' },
      { name: 'README.md', relPath: 'README.md', kind: 'file' },
    ]);
  });

  it('stores the root tree', () => {
    assert.deepEqual(model.getFolder('f1')!.tree.map((n) => n.name), ['docs', 'README.md']);
  });

  it('attaches children to a directory node and marks it loaded', () => {
    model.setChildren('f1', 'docs', [{ name: 'api.md', relPath: 'docs/api.md', kind: 'file' }]);
    const docs = model.getFolder('f1')!.tree[0];
    assert.deepEqual(docs.children?.map((n) => n.name), ['api.md']);
    assert.equal(docs.childrenLoaded, true);
  });

  it('toggles expansion state', () => {
    assert.equal(model.getFolder('f1')!.expandedPaths.has('docs'), false);
    model.toggleExpanded('f1', 'docs');
    assert.equal(model.getFolder('f1')!.expandedPaths.has('docs'), true);
    model.toggleExpanded('f1', 'docs');
    assert.equal(model.getFolder('f1')!.expandedPaths.has('docs'), false);
  });

  it('preserves expansion state when a sibling node is added', () => {
    model.setChildren('f1', 'docs', [{ name: 'api.md', relPath: 'docs/api.md', kind: 'file' }]);
    model.toggleExpanded('f1', 'docs');
    model.addNode('f1', { name: 'CHANGELOG.md', relPath: 'CHANGELOG.md', kind: 'file' });
    assert.equal(model.getFolder('f1')!.expandedPaths.has('docs'), true);
    assert.deepEqual(
      model.getFolder('f1')!.tree.map((n) => n.name),
      ['docs', 'CHANGELOG.md', 'README.md'],
    );
  });

  it('removes a node without rebuilding the tree', () => {
    model.setChildren('f1', 'docs', [
      { name: 'api.md', relPath: 'docs/api.md', kind: 'file' },
      { name: 'spec.md', relPath: 'docs/spec.md', kind: 'file' },
    ]);
    model.removeNode('f1', 'docs/api.md');
    assert.deepEqual(
      model.getFolder('f1')!.tree[0].children?.map((n) => n.name),
      ['spec.md'],
    );
  });
});

describe('dirty tracking', () => {
  it('marks and clears the dirty flag on a tab', () => {
    const model = createWorkspaceModel();
    model.addFolder(alpha);
    model.openTab('f1', 'a.md');
    assert.equal(model.getFolder('f1')!.tabs[0].dirty, false);
    model.markDirty('f1', 'a.md', true);
    assert.equal(model.getFolder('f1')!.tabs[0].dirty, true);
    model.markDirty('f1', 'a.md', false);
    assert.equal(model.getFolder('f1')!.tabs[0].dirty, false);
  });

  it('ignores a dirty mark for a file with no open tab', () => {
    const model = createWorkspaceModel();
    model.addFolder(alpha);
    assert.doesNotThrow(() => model.markDirty('f1', 'ghost.md', true));
  });
});

describe('subscribe', () => {
  it('notifies subscribers on every mutation', () => {
    const model = createWorkspaceModel();
    let calls = 0;
    model.subscribe(() => { calls += 1; });
    model.addFolder(alpha);
    model.openTab('f1', 'a.md');
    assert.equal(calls, 2);
  });

  it('stops notifying after unsubscribe', () => {
    const model = createWorkspaceModel();
    let calls = 0;
    const unsubscribe = model.subscribe(() => { calls += 1; });
    model.addFolder(alpha);
    unsubscribe();
    model.openTab('f1', 'a.md');
    assert.equal(calls, 1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/desktop-workspace-model.test.ts`
Expected: FAIL — cannot find module `workspace-model.ts`.

- [ ] **Step 3: Write the model**

Create `desktop/src/renderer/workspace-model.ts`:

```ts
import type { DirEntry, OpenedFolder } from '../../types/ipc';

export interface TreeNode extends DirEntry {
  children?: TreeNode[];
  childrenLoaded?: boolean;
}

export interface Tab {
  relPath: string;
  name: string;
  /** Last known scroll line, restored when an evicted view is recreated. */
  scrollLine: number;
  /** Changed on disk while the view was evicted; re-read on next activation. */
  dirty: boolean;
}

export type FolderStatus = 'ready' | 'unavailable';

export interface FolderState {
  id: string;
  path: string;
  name: string;
  tree: TreeNode[];
  tabs: Tab[];
  activeRelPath: string | null;
  expandedPaths: Set<string>;
  status: FolderStatus;
}

export interface WorkspaceState {
  folders: FolderState[];
  activeFolderId: string | null;
}

export function viewKey(folderId: string, relPath: string): string {
  return `${folderId}:${relPath}`;
}

function basename(relPath: string): string {
  const index = relPath.lastIndexOf('/');
  return index === -1 ? relPath : relPath.slice(index + 1);
}

/** Depth-first search for a node by relative path. */
function findNode(nodes: TreeNode[], relPath: string): TreeNode | null {
  for (const node of nodes) {
    if (node.relPath === relPath) return node;
    if (node.children) {
      const found = findNode(node.children, relPath);
      if (found) return found;
    }
  }
  return null;
}

function parentPath(relPath: string): string {
  const index = relPath.lastIndexOf('/');
  return index === -1 ? '' : relPath.slice(0, index);
}

/** Directories first, then files, each alphabetical — mirrors listDir. */
function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

export interface WorkspaceModel {
  getState(): WorkspaceState;
  getFolder(folderId: string): FolderState | null;
  getActiveFolder(): FolderState | null;
  subscribe(listener: () => void): () => void;

  addFolder(folder: OpenedFolder): void;
  removeFolder(folderId: string): void;
  activateFolder(folderId: string): void;
  setFolderStatus(folderId: string, status: FolderStatus): void;

  openTab(folderId: string, relPath: string): void;
  closeTab(folderId: string, relPath: string): void;
  activateTab(folderId: string, relPath: string): void;
  markDirty(folderId: string, relPath: string, dirty: boolean): void;
  setScrollLine(folderId: string, relPath: string, line: number): void;

  setTree(folderId: string, nodes: DirEntry[]): void;
  setChildren(folderId: string, relPath: string, nodes: DirEntry[]): void;
  toggleExpanded(folderId: string, relPath: string): void;
  addNode(folderId: string, entry: DirEntry): void;
  removeNode(folderId: string, relPath: string): void;
}

export function createWorkspaceModel(): WorkspaceModel {
  const state: WorkspaceState = { folders: [], activeFolderId: null };
  const listeners = new Set<() => void>();

  const notify = (): void => { for (const listener of listeners) listener(); };
  const find = (folderId: string): FolderState | null =>
    state.folders.find((f) => f.id === folderId) ?? null;

  const model: WorkspaceModel = {
    getState: () => state,
    getFolder: find,
    getActiveFolder: () => (state.activeFolderId ? find(state.activeFolderId) : null),

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    addFolder(folder) {
      const existing = state.folders.find((f) => f.path === folder.path);
      if (existing) {
        state.activeFolderId = existing.id;
        notify();
        return;
      }
      state.folders.push({
        id: folder.id,
        path: folder.path,
        name: folder.name,
        tree: [],
        tabs: [],
        activeRelPath: null,
        expandedPaths: new Set(),
        status: 'ready',
      });
      state.activeFolderId = folder.id;
      notify();
    },

    removeFolder(folderId) {
      const index = state.folders.findIndex((f) => f.id === folderId);
      if (index === -1) return;
      state.folders.splice(index, 1);
      if (state.activeFolderId === folderId) {
        const neighbor = state.folders[index] ?? state.folders[index - 1] ?? null;
        state.activeFolderId = neighbor?.id ?? null;
      }
      notify();
    },

    activateFolder(folderId) {
      if (!find(folderId)) return;
      state.activeFolderId = folderId;
      notify();
    },

    setFolderStatus(folderId, status) {
      const folder = find(folderId);
      if (!folder) return;
      folder.status = status;
      notify();
    },

    openTab(folderId, relPath) {
      const folder = find(folderId);
      if (!folder) return;
      if (!folder.tabs.some((t) => t.relPath === relPath)) {
        folder.tabs.push({ relPath, name: basename(relPath), scrollLine: 1, dirty: false });
      }
      folder.activeRelPath = relPath;
      notify();
    },

    closeTab(folderId, relPath) {
      const folder = find(folderId);
      if (!folder) return;
      const index = folder.tabs.findIndex((t) => t.relPath === relPath);
      if (index === -1) return;
      folder.tabs.splice(index, 1);
      if (folder.activeRelPath === relPath) {
        // Prefer the right neighbor, fall back to the left.
        const neighbor = folder.tabs[index] ?? folder.tabs[index - 1] ?? null;
        folder.activeRelPath = neighbor?.relPath ?? null;
      }
      notify();
    },

    activateTab(folderId, relPath) {
      const folder = find(folderId);
      if (!folder || !folder.tabs.some((t) => t.relPath === relPath)) return;
      folder.activeRelPath = relPath;
      notify();
    },

    markDirty(folderId, relPath, dirty) {
      const tab = find(folderId)?.tabs.find((t) => t.relPath === relPath);
      if (!tab) return;
      tab.dirty = dirty;
      notify();
    },

    setScrollLine(folderId, relPath, line) {
      const tab = find(folderId)?.tabs.find((t) => t.relPath === relPath);
      if (!tab) return;
      tab.scrollLine = line;
    },

    setTree(folderId, nodes) {
      const folder = find(folderId);
      if (!folder) return;
      folder.tree = nodes.map((n) => ({ ...n }));
      notify();
    },

    setChildren(folderId, relPath, nodes) {
      const folder = find(folderId);
      if (!folder) return;
      const node = findNode(folder.tree, relPath);
      if (!node) return;
      node.children = nodes.map((n) => ({ ...n }));
      node.childrenLoaded = true;
      notify();
    },

    toggleExpanded(folderId, relPath) {
      const folder = find(folderId);
      if (!folder) return;
      if (folder.expandedPaths.has(relPath)) folder.expandedPaths.delete(relPath);
      else folder.expandedPaths.add(relPath);
      notify();
    },

    addNode(folderId, entry) {
      const folder = find(folderId);
      if (!folder) return;
      const parent = parentPath(entry.relPath);
      const siblings = parent === '' ? folder.tree : findNode(folder.tree, parent)?.children;
      // An unloaded parent needs no patch; its children load fresh on expand.
      if (!siblings) return;
      if (siblings.some((n) => n.relPath === entry.relPath)) return;
      siblings.push({ ...entry });
      sortNodes(siblings);
      notify();
    },

    removeNode(folderId, relPath) {
      const folder = find(folderId);
      if (!folder) return;
      const parent = parentPath(relPath);
      const siblings = parent === '' ? folder.tree : findNode(folder.tree, parent)?.children;
      if (!siblings) return;
      const index = siblings.findIndex((n) => n.relPath === relPath);
      if (index === -1) return;
      siblings.splice(index, 1);
      notify();
    },
  };

  return model;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/desktop-workspace-model.test.ts`
Expected: PASS — all 25 assertions.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/renderer/workspace-model.ts test/desktop-workspace-model.test.ts
git commit -m "feat(desktop): add pure workspace state model for folders and tabs"
```

---

### Task 4: Viewer pool

**Files:**
- Create: `desktop/src/renderer/viewer-pool.ts`
- Test: `test/desktop-viewer-pool.test.ts`

**Interfaces:**
- Consumes: `viewKey` from `workspace-model.ts`.
- Produces:
  - `ViewHandle = { key: string; setActive(active: boolean): void; sync(input: SyncInput): void; destroy(): void }`
  - `SyncInput = { content: string; filename: string; workspaceName: string; workspaceFilePath: string; scrollLine?: number }`
  - `createViewerPool(options: ViewerPoolOptions): ViewerPool` with `acquire(key)`, `activate(key, input)`, `has(key)`, `evictFolder(folderId)`, `size()`
  - `ViewerPoolOptions = { capacity: number; createView(key: string): ViewHandle }` — the injected factory is what makes this testable without a DOM

The pool is deliberately ignorant of iframes. Task 8 supplies the real factory; the test supplies a fake.

- [ ] **Step 1: Write the failing test**

Create `test/desktop-viewer-pool.test.ts`:

```ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createViewerPool, type ViewHandle, type ViewerPool } from '../desktop/src/renderer/viewer-pool.ts';

interface FakeView extends ViewHandle {
  destroyed: boolean;
  active: boolean;
  syncs: string[];
}

function setup(capacity: number): { pool: ViewerPool; views: Map<string, FakeView> } {
  const views = new Map<string, FakeView>();
  const pool = createViewerPool({
    capacity,
    createView(key: string): ViewHandle {
      const view: FakeView = {
        key,
        destroyed: false,
        active: false,
        syncs: [],
        setActive(active: boolean) { view.active = active; },
        sync(input) { view.syncs.push(input.content); },
        destroy() { view.destroyed = true; },
      };
      views.set(key, view);
      return view;
    },
  });
  return { pool, views };
}

const doc = (content: string) => ({
  content,
  filename: 'a.md',
  workspaceName: 'alpha',
  workspaceFilePath: 'a.md',
});

describe('viewer pool', () => {
  let pool: ViewerPool;
  let views: Map<string, FakeView>;
  beforeEach(() => { ({ pool, views } = setup(3)); });

  it('creates a view on first activate', () => {
    pool.activate('f1:a.md', doc('# A'));
    assert.equal(pool.size(), 1);
    assert.equal(views.get('f1:a.md')?.syncs.length, 1);
  });

  it('reuses an existing view instead of recreating it', () => {
    pool.activate('f1:a.md', doc('# A'));
    const first = views.get('f1:a.md');
    pool.activate('f1:b.md', doc('# B'));
    pool.activate('f1:a.md', doc('# A'));
    assert.equal(views.get('f1:a.md'), first);
    assert.equal(first?.destroyed, false);
    assert.equal(pool.size(), 2);
  });

  it('marks only the activated view as active', () => {
    pool.activate('f1:a.md', doc('# A'));
    pool.activate('f1:b.md', doc('# B'));
    assert.equal(views.get('f1:a.md')?.active, false);
    assert.equal(views.get('f1:b.md')?.active, true);
  });

  it('evicts the least recently used view at capacity', () => {
    pool.activate('f1:a.md', doc('# A'));
    pool.activate('f1:b.md', doc('# B'));
    pool.activate('f1:c.md', doc('# C'));
    pool.activate('f1:d.md', doc('# D'));
    assert.equal(views.get('f1:a.md')?.destroyed, true);
    assert.equal(pool.size(), 3);
    assert.equal(pool.has('f1:a.md'), false);
  });

  it('counts activation as recent use, sparing a revisited view', () => {
    pool.activate('f1:a.md', doc('# A'));
    pool.activate('f1:b.md', doc('# B'));
    pool.activate('f1:c.md', doc('# C'));
    pool.activate('f1:a.md', doc('# A'));   // a is now most recent, b is LRU
    pool.activate('f1:d.md', doc('# D'));
    assert.equal(views.get('f1:a.md')?.destroyed, false);
    assert.equal(views.get('f1:b.md')?.destroyed, true);
  });

  it('never evicts the active view', () => {
    const small = setup(1);
    small.pool.activate('f1:a.md', doc('# A'));
    small.pool.activate('f1:b.md', doc('# B'));
    // Capacity is 1, but evicting the newly active view would be pointless.
    assert.equal(small.views.get('f1:b.md')?.destroyed, false);
    assert.equal(small.views.get('f1:a.md')?.destroyed, true);
  });

  it('re-syncs content when a previously evicted key is activated again', () => {
    pool.activate('f1:a.md', doc('# A'));
    pool.activate('f1:b.md', doc('# B'));
    pool.activate('f1:c.md', doc('# C'));
    pool.activate('f1:d.md', doc('# D'));  // evicts a
    pool.activate('f1:a.md', doc('# A v2'));
    assert.deepEqual(views.get('f1:a.md')?.syncs, ['# A v2']);
  });

  it('syncs an already-live view without recreating it', () => {
    pool.activate('f1:a.md', doc('# A'));
    pool.activate('f1:a.md', doc('# A edited'));
    assert.deepEqual(views.get('f1:a.md')?.syncs, ['# A', '# A edited']);
  });

  it('returns the live view from acquire, or null when absent', () => {
    pool.activate('f1:a.md', doc('# A'));
    assert.equal(pool.acquire('f1:a.md')?.key, 'f1:a.md');
    assert.equal(pool.acquire('f1:zz.md'), null);
  });

  it('destroys every view belonging to a closed folder', () => {
    pool.activate('f1:a.md', doc('# A'));
    pool.activate('f2:z.md', doc('# Z'));
    pool.evictFolder('f1');
    assert.equal(views.get('f1:a.md')?.destroyed, true);
    assert.equal(views.get('f2:z.md')?.destroyed, false);
    assert.equal(pool.size(), 1);
  });

  it('deactivates the previous view when a new folder view is activated', () => {
    pool.activate('f1:a.md', doc('# A'));
    pool.activate('f2:z.md', doc('# Z'));
    assert.equal(views.get('f1:a.md')?.active, false);
    assert.equal(views.get('f2:z.md')?.active, true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/desktop-viewer-pool.test.ts`
Expected: FAIL — cannot find module `viewer-pool.ts`.

- [ ] **Step 3: Write the pool**

Create `desktop/src/renderer/viewer-pool.ts`:

```ts
export interface SyncInput {
  content: string;
  filename: string;
  workspaceName: string;
  workspaceFilePath: string;
  scrollLine?: number;
}

export interface ViewHandle {
  key: string;
  setActive(active: boolean): void;
  sync(input: SyncInput): void;
  destroy(): void;
}

export interface ViewerPoolOptions {
  capacity: number;
  createView(key: string): ViewHandle;
}

export interface ViewerPool {
  activate(key: string, input: SyncInput): ViewHandle;
  acquire(key: string): ViewHandle | null;
  has(key: string): boolean;
  evictFolder(folderId: string): void;
  size(): number;
}

export function createViewerPool(options: ViewerPoolOptions): ViewerPool {
  const { capacity, createView } = options;
  // Map preserves insertion order; we re-insert on use so the first key is LRU.
  const views = new Map<string, ViewHandle>();
  let activeKey: string | null = null;

  function touch(key: string, view: ViewHandle): void {
    views.delete(key);
    views.set(key, view);
  }

  function evictIfNeeded(): void {
    while (views.size > capacity) {
      // The first non-active key in insertion order is the least recently used.
      let victim: string | null = null;
      for (const key of views.keys()) {
        if (key !== activeKey) { victim = key; break; }
      }
      if (victim === null) return;
      views.get(victim)?.destroy();
      views.delete(victim);
    }
  }

  return {
    activate(key, input) {
      if (activeKey && activeKey !== key) {
        views.get(activeKey)?.setActive(false);
      }

      let view = views.get(key) ?? null;
      if (!view) {
        view = createView(key);
        views.set(key, view);
      } else {
        touch(key, view);
      }

      activeKey = key;
      view.setActive(true);
      view.sync(input);
      evictIfNeeded();
      return view;
    },

    acquire: (key) => views.get(key) ?? null,
    has: (key) => views.has(key),

    evictFolder(folderId) {
      const prefix = `${folderId}:`;
      for (const [key, view] of [...views]) {
        if (!key.startsWith(prefix)) continue;
        view.destroy();
        views.delete(key);
        if (activeKey === key) activeKey = null;
      }
    },

    size: () => views.size,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/desktop-viewer-pool.test.ts`
Expected: PASS — all 12 assertions.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/renderer/viewer-pool.ts test/desktop-viewer-pool.test.ts
git commit -m "feat(desktop): add LRU viewer pool with injectable view factory"
```

---

### Task 5: Folder tab strip and folder open flow

**Files:**
- Create: `desktop/src/renderer/folder-tabs.ts`
- Modify: `desktop/src/renderer/main.ts`
- Modify: `test/desktop-smoke.test.ts` (add folder-open coverage)

**Interfaces:**
- Consumes: `WorkspaceModel` from `workspace-model.ts`; `window.desktop.openFolderDialog`.
- Produces: `renderFolderTabs(container: HTMLElement, model: WorkspaceModel, handlers: FolderTabHandlers): void` where `FolderTabHandlers = { onActivate(folderId): void; onClose(folderId): void; onAdd(): void }`.

- [ ] **Step 1: Write the folder tab strip**

Create `desktop/src/renderer/folder-tabs.ts`:

```ts
import type { WorkspaceModel } from './workspace-model';

export interface FolderTabHandlers {
  onActivate(folderId: string): void;
  onClose(folderId: string): void;
  onAdd(): void;
}

export function renderFolderTabs(
  container: HTMLElement,
  model: WorkspaceModel,
  handlers: FolderTabHandlers,
): void {
  const { folders, activeFolderId } = model.getState();
  container.replaceChildren();

  for (const folder of folders) {
    const tab = document.createElement('div');
    tab.className = 'folder-tab';
    tab.dataset.folderId = folder.id;
    tab.dataset.active = String(folder.id === activeFolderId);
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(folder.id === activeFolderId));
    tab.title = folder.path;

    const label = document.createElement('span');
    label.className = 'folder-tab-label';
    label.textContent = folder.name;
    if (folder.status === 'unavailable') {
      tab.dataset.status = 'unavailable';
      label.textContent = `${folder.name} (unavailable)`;
    }
    label.addEventListener('click', () => handlers.onActivate(folder.id));

    const close = document.createElement('button');
    close.className = 'folder-tab-close';
    close.type = 'button';
    close.textContent = '✕';
    close.setAttribute('aria-label', `Close ${folder.name}`);
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      handlers.onClose(folder.id);
    });

    tab.append(label, close);
    container.append(tab);
  }

  const add = document.createElement('button');
  add.className = 'folder-tab-add';
  add.id = 'folder-tab-add';
  add.type = 'button';
  add.textContent = '+';
  add.setAttribute('aria-label', 'Open folder');
  add.addEventListener('click', () => handlers.onAdd());
  container.append(add);
}
```

- [ ] **Step 2: Add the tab styles**

Append to `desktop/src/renderer/workspace.css`:

```css
.folder-tab {
  display: flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 6px 0 10px;
  border-radius: 6px 6px 0 0;
  font-size: 12px; cursor: default; user-select: none;
  color: var(--mv-text-muted, #57606a);
}
.folder-tab[data-active='true'] {
  background: var(--mv-bg, #fff);
  color: var(--mv-text, #1f2328);
  box-shadow: inset 0 -2px 0 var(--mv-accent, #0969da);
}
.folder-tab[data-status='unavailable'] { opacity: 0.55; font-style: italic; }
.folder-tab-label { cursor: pointer; white-space: nowrap; }
.folder-tab-close, .folder-tab-add {
  border: 0; background: transparent; cursor: pointer;
  color: inherit; font-size: 12px; line-height: 1;
  padding: 2px 4px; border-radius: 4px;
}
.folder-tab-close:hover, .folder-tab-add:hover { background: var(--mv-hover, #eaeef2); }
.folder-tab-add { font-size: 16px; margin-left: 4px; }
```

- [ ] **Step 3: Wire the bootstrap**

Replace `desktop/src/renderer/main.ts`:

```ts
import { createWorkspaceModel } from './workspace-model';
import { renderFolderTabs } from './folder-tabs';
import '../../types/ipc';

const model = createWorkspaceModel();

const $landing = document.getElementById('landing')!;
const $workspace = document.getElementById('workspace')!;
const $folderTabs = document.getElementById('folder-tabs')!;
const $openFolder = document.getElementById('open-folder')!;

async function openFolder(): Promise<void> {
  const folder = await window.desktop.openFolderDialog();
  if (!folder) return;
  model.addFolder(folder);

  const entries = await window.desktop.listDir(folder.id, '');
  model.setTree(folder.id, entries);
}

function closeFolder(folderId: string): void {
  void window.desktop.closeFolder(folderId);
  model.removeFolder(folderId);
}

function render(): void {
  const { folders } = model.getState();
  const hasFolders = folders.length > 0;
  $landing.hidden = hasFolders;
  $workspace.hidden = !hasFolders;

  renderFolderTabs($folderTabs, model, {
    onActivate: (folderId) => model.activateFolder(folderId),
    onClose: closeFolder,
    onAdd: () => { void openFolder(); },
  });
}

model.subscribe(render);
$openFolder.addEventListener('click', () => { void openFolder(); });
render();
```

- [ ] **Step 4: Extend the smoke test**

Append to `test/desktop-smoke.test.ts`, inside the existing `describe`:

```ts
  it('opens two folders as separate tabs', async () => {
    const window = await app.firstWindow();

    // The native folder dialog cannot be driven from the renderer, so stub the
    // main-process handler to return the fixture folders in sequence.
    await app.evaluate(async ({ ipcMain, dialog }, fixtures) => {
      const paths = [`${fixtures}/alpha`, `${fixtures}/beta`];
      let index = 0;
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [paths[index++ % paths.length]],
      });
      void ipcMain;
    }, path.join(projectRoot, 'test/fixtures/desktop'));

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
```

- [ ] **Step 5: Build and run the smoke test to verify it passes**

Run: `npm run build:desktop && node --test test/desktop-smoke.test.ts`
Expected: PASS — two folder tabs named `alpha` and `beta`, the second active.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/renderer test/desktop-smoke.test.ts
git commit -m "feat(desktop): add folder tab strip and folder open flow"
```

---

### Task 6: File tree

**Files:**
- Create: `desktop/src/renderer/file-tree.ts`
- Modify: `desktop/src/renderer/main.ts`

**Interfaces:**
- Consumes: `WorkspaceModel`, `TreeNode`; `window.desktop.listDir`; icon helpers `chevronRight`, `chevronDown`, `folderClosed`, `folderOpen`, `getFileIcon` from `chrome/src/workspace/file-icons`.
- Produces: `renderFileTree(container: HTMLElement, model: WorkspaceModel, handlers: FileTreeHandlers): void` where `FileTreeHandlers = { onOpenFile(folderId, relPath): void; onToggleDir(folderId, relPath): void }`.

- [ ] **Step 1: Write the tree renderer**

Create `desktop/src/renderer/file-tree.ts`:

```ts
import {
  chevronRight,
  chevronDown,
  folderClosed,
  folderOpen,
  getFileIcon,
} from '../../../chrome/src/workspace/file-icons';
import type { FolderState, TreeNode, WorkspaceModel } from './workspace-model';

export interface FileTreeHandlers {
  onOpenFile(folderId: string, relPath: string): void;
  onToggleDir(folderId: string, relPath: string): void;
}

function renderNode(
  node: TreeNode,
  folder: FolderState,
  depth: number,
  handlers: FileTreeHandlers,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tree-row';
  row.dataset.relPath = node.relPath;
  row.dataset.kind = node.kind;
  row.style.paddingLeft = `${8 + depth * 14}px`;

  const expanded = folder.expandedPaths.has(node.relPath);

  const chevron = document.createElement('span');
  chevron.className = 'tree-chevron';
  chevron.innerHTML = node.kind === 'directory' ? (expanded ? chevronDown : chevronRight) : '';

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.innerHTML = node.kind === 'directory'
    ? (expanded ? folderOpen : folderClosed)
    : getFileIcon(node.name);

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = node.name;

  row.append(chevron, icon, label);

  if (node.kind === 'file' && folder.activeRelPath === node.relPath) {
    row.dataset.active = 'true';
  }

  row.addEventListener('click', () => {
    if (node.kind === 'directory') handlers.onToggleDir(folder.id, node.relPath);
    else handlers.onOpenFile(folder.id, node.relPath);
  });

  const wrapper = document.createElement('div');
  wrapper.append(row);

  if (node.kind === 'directory' && expanded && node.children) {
    for (const child of node.children) {
      wrapper.append(renderNode(child, folder, depth + 1, handlers));
    }
  }

  return wrapper;
}

export function renderFileTree(
  container: HTMLElement,
  model: WorkspaceModel,
  handlers: FileTreeHandlers,
): void {
  container.replaceChildren();
  const folder = model.getActiveFolder();
  if (!folder) return;

  if (folder.status === 'unavailable') {
    const notice = document.createElement('div');
    notice.className = 'tree-notice';
    notice.textContent = 'This folder is no longer available.';
    container.append(notice);
    return;
  }

  for (const node of folder.tree) {
    container.append(renderNode(node, folder, 0, handlers));
  }
}
```

- [ ] **Step 2: Add the tree styles**

Append to `desktop/src/renderer/workspace.css`:

```css
.tree-row {
  display: flex; align-items: center; gap: 4px;
  height: 24px; padding-right: 8px;
  font-size: 13px; cursor: pointer; user-select: none;
  white-space: nowrap; overflow: hidden;
}
.tree-row:hover { background: var(--mv-hover, #eaeef2); }
.tree-row[data-active='true'] { background: var(--mv-selected, #dbe9f7); }
.tree-chevron, .tree-icon { display: inline-flex; width: 16px; flex: 0 0 auto; }
.tree-chevron svg, .tree-icon svg { width: 14px; height: 14px; }
.tree-label { overflow: hidden; text-overflow: ellipsis; }
.tree-notice { padding: 12px; font-size: 13px; color: var(--mv-text-muted, #57606a); }
```

- [ ] **Step 3: Wire lazy loading into the bootstrap**

In `desktop/src/renderer/main.ts`, add the imports:

```ts
import { renderFileTree } from './file-tree';
```

Add the DOM ref beside the others:

```ts
const $fileTree = document.getElementById('file-tree')!;
```

Add the toggle handler above `render`:

```ts
async function toggleDir(folderId: string, relPath: string): Promise<void> {
  const folder = model.getFolder(folderId);
  const node = folder?.tree && findTreeNode(folder.tree, relPath);
  // Load children the first time a directory is expanded, then reuse them.
  if (node && node.kind === 'directory' && !node.childrenLoaded) {
    const entries = await window.desktop.listDir(folderId, relPath);
    model.setChildren(folderId, relPath, entries);
  }
  model.toggleExpanded(folderId, relPath);
}
```

Add the lookup helper at the bottom of the file:

```ts
function findTreeNode(nodes: TreeNode[], relPath: string): TreeNode | null {
  for (const node of nodes) {
    if (node.relPath === relPath) return node;
    if (node.children) {
      const found = findTreeNode(node.children, relPath);
      if (found) return found;
    }
  }
  return null;
}
```

Import the type at the top:

```ts
import { createWorkspaceModel, type TreeNode } from './workspace-model';
```

Add to the body of `render()`:

```ts
  renderFileTree($fileTree, model, {
    onOpenFile: (folderId, relPath) => model.openTab(folderId, relPath),
    onToggleDir: (folderId, relPath) => { void toggleDir(folderId, relPath); },
  });
```

- [ ] **Step 4: Extend the smoke test**

Append to `test/desktop-smoke.test.ts`, inside the existing `describe`:

```ts
  it('expands a directory lazily and lists its children', async () => {
    const window = await app.firstWindow();
    await window.click('.folder-tab:nth-of-type(1) .folder-tab-label');
    await window.waitForSelector('.tree-row[data-rel-path="README.md"]');

    // 'nested' children are absent until the directory is expanded.
    assert.equal(await window.$('.tree-row[data-rel-path="nested/deep.md"]'), null);
    await window.click('.tree-row[data-rel-path="nested"]');
    await window.waitForSelector('.tree-row[data-rel-path="nested/deep.md"]');
  });
```

- [ ] **Step 5: Build and run the smoke test to verify it passes**

Run: `npm run build:desktop && node --test test/desktop-smoke.test.ts`
Expected: PASS — `nested/deep.md` appears only after expanding `nested`.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/renderer test/desktop-smoke.test.ts
git commit -m "feat(desktop): add lazy-loading file tree"
```

---

### Task 7: File tab strip

**Files:**
- Create: `desktop/src/renderer/file-tabs.ts`
- Modify: `desktop/src/renderer/main.ts`

**Interfaces:**
- Consumes: `WorkspaceModel`.
- Produces: `renderFileTabs(container: HTMLElement, model: WorkspaceModel, handlers: FileTabHandlers): void` where `FileTabHandlers = { onActivate(folderId, relPath): void; onClose(folderId, relPath): void }`.

- [ ] **Step 1: Write the file tab strip**

Create `desktop/src/renderer/file-tabs.ts`:

```ts
import { getFileIcon } from '../../../chrome/src/workspace/file-icons';
import type { WorkspaceModel } from './workspace-model';

export interface FileTabHandlers {
  onActivate(folderId: string, relPath: string): void;
  onClose(folderId: string, relPath: string): void;
}

export function renderFileTabs(
  container: HTMLElement,
  model: WorkspaceModel,
  handlers: FileTabHandlers,
): void {
  container.replaceChildren();
  const folder = model.getActiveFolder();
  if (!folder) return;

  for (const tab of folder.tabs) {
    const el = document.createElement('div');
    el.className = 'file-tab';
    el.dataset.relPath = tab.relPath;
    el.dataset.active = String(folder.activeRelPath === tab.relPath);
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(folder.activeRelPath === tab.relPath));
    el.title = tab.relPath;

    const icon = document.createElement('span');
    icon.className = 'file-tab-icon';
    icon.innerHTML = getFileIcon(tab.name);

    const label = document.createElement('span');
    label.className = 'file-tab-label';
    label.textContent = tab.name;

    el.append(icon, label);
    el.addEventListener('click', () => handlers.onActivate(folder.id, tab.relPath));
    // Middle-click closes, matching browser and editor convention.
    el.addEventListener('auxclick', (event) => {
      if (event.button === 1) handlers.onClose(folder.id, tab.relPath);
    });

    const close = document.createElement('button');
    close.className = 'file-tab-close';
    close.type = 'button';
    close.textContent = '✕';
    close.setAttribute('aria-label', `Close ${tab.name}`);
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      handlers.onClose(folder.id, tab.relPath);
    });

    el.append(close);
    container.append(el);
  }
}
```

- [ ] **Step 2: Add the file tab styles**

Append to `desktop/src/renderer/workspace.css`:

```css
.file-tab {
  display: flex; align-items: center; gap: 6px;
  padding: 0 6px 0 10px; max-width: 220px;
  border-right: 1px solid var(--mv-border, #e1e4e8);
  font-size: 12px; cursor: pointer; user-select: none;
  color: var(--mv-text-muted, #57606a);
}
.file-tab[data-active='true'] {
  background: var(--mv-bg, #fff);
  color: var(--mv-text, #1f2328);
  box-shadow: inset 0 -2px 0 var(--mv-accent, #0969da);
}
.file-tab-icon { display: inline-flex; flex: 0 0 auto; }
.file-tab-icon svg { width: 14px; height: 14px; }
.file-tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-tab-close {
  border: 0; background: transparent; cursor: pointer;
  color: inherit; font-size: 11px; line-height: 1;
  padding: 2px 4px; border-radius: 4px; flex: 0 0 auto;
}
.file-tab-close:hover { background: var(--mv-hover, #eaeef2); }
```

- [ ] **Step 3: Wire into the bootstrap**

In `desktop/src/renderer/main.ts`, add the import:

```ts
import { renderFileTabs } from './file-tabs';
```

Add the DOM ref:

```ts
const $fileTabs = document.getElementById('file-tabs')!;
```

Add to the body of `render()`:

```ts
  renderFileTabs($fileTabs, model, {
    onActivate: (folderId, relPath) => model.activateTab(folderId, relPath),
    onClose: (folderId, relPath) => model.closeTab(folderId, relPath),
  });
```

- [ ] **Step 4: Extend the smoke test**

Append to `test/desktop-smoke.test.ts`, inside the existing `describe`:

```ts
  it('keeps file tabs isolated per folder across folder switches', async () => {
    const window = await app.firstWindow();

    await window.click('.folder-tab:nth-of-type(1) .folder-tab-label');
    await window.click('.tree-row[data-rel-path="README.md"]');
    await window.waitForSelector('.file-tab[data-rel-path="README.md"]');

    await window.click('.folder-tab:nth-of-type(2) .folder-tab-label');
    await window.waitForSelector('.tree-row[data-rel-path="index.md"]');
    await window.click('.tree-row[data-rel-path="index.md"]');
    await window.waitForSelector('.file-tab[data-rel-path="index.md"]');

    // beta shows only its own tab
    assert.equal(
      (await window.$$('.file-tab')).length, 1,
      'beta should show exactly its own file tab',
    );

    // switching back restores alpha's tab
    await window.click('.folder-tab:nth-of-type(1) .folder-tab-label');
    await window.waitForSelector('.file-tab[data-rel-path="README.md"]');
    assert.equal((await window.$$('.file-tab')).length, 1);
  });
```

- [ ] **Step 5: Build and run the smoke test to verify it passes**

Run: `npm run build:desktop && node --test test/desktop-smoke.test.ts`
Expected: PASS — each folder shows only its own file tabs.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/renderer test/desktop-smoke.test.ts
git commit -m "feat(desktop): add per-folder file tab strip"
```

---

### Task 8: Platform services and the viewer iframe

This is the task that makes documents actually render. It follows the Obsidian model rather than the Chrome one: Electron's renderer can run the whole service layer in-process, so services connect over `createDirectTransportPair` and only filesystem calls cross IPC.

> **Read these three files before starting.** This task is a port of the Obsidian
> platform shell, which is the closest existing analog (in-process services, no
> extension runtime). `obsidian/src/webview/api-impl.ts` is the class shape,
> `obsidian/src/host/preview-view.ts:344-420` is the service-handler surface, and
> `obsidian/build.js:217-290` is the asset pipeline. Deviating from those three
> files is almost always a mistake.

**Files:**
- Create: `desktop/src/renderer/api-impl.ts`
- Create: `desktop/src/renderer/service-host.ts`
- Create: `desktop/src/renderer/viewer-embed.ts`
- Create: `desktop/src/renderer/viewer-embed.html`
- Create: `desktop/src/renderer/viewer-view.ts`
- Modify: `chrome/src/workspace/workspace-embed-bridge.ts:1` (widen the type)
- Modify: `src/types/platform.ts:14` (add `'desktop'` to `PlatformType`)
- Modify: `desktop/build.js` (viewer-embed entry point + the full asset pipeline)
- Modify: `desktop/src/renderer/main.ts` (create the pool, activate on tab change)

**Interfaces:**
- Consumes: `createViewerPool`, `ViewHandle`, `SyncInput` from `viewer-pool.ts`; `createViewerIframeHostBridge` from `src/integration/iframe-viewer-host`; `startViewer`, `getViewerMainRuntime` from `chrome/src/webview/viewer-main`; `createDirectTransportPair` from `obsidian/src/transports/direct-transport`; `IframeRenderHost` from `src/renderers/host/iframe-render-host`.
- Produces:
  - `desktopPlatform: DesktopPlatformAPI` and `hostTransport` exported from `api-impl.ts`
  - `registerHostHandlers(channel: ServiceChannel, ctx: HostContext): void` from `service-host.ts`, where `HostContext = { getActiveFolderId(): string | null }`
  - `createIframeView(host: HTMLElement, folderId: string, relPath: string, key: string): ViewHandle` from `viewer-view.ts` — the real factory passed to `createViewerPool`

**No IPC transport is needed.** The Electron renderer is a full Chromium context, so
every service runs in-process over `createDirectTransportPair`, exactly as in Obsidian.
The only thing that crosses IPC is a file read, and the service host calls
`window.desktop.readFile` directly for that. An `ElectronIpcTransport` would be dead
weight.

- [ ] **Step 1: Widen the embed bridge type**

`workspace-embed-bridge.ts` only calls `setWorkspaceFileReader`, so it does not need the concrete Chrome class. In `chrome/src/workspace/workspace-embed-bridge.ts`, replace line 1:

```ts
import type { ChromeDocumentService } from '../webview/api-impl';
```

with:

```ts
/** Structural type so non-Chrome hosts can supply their own document service. */
interface WorkspaceFileReaderHost {
  setWorkspaceFileReader(
    reader: (relativePath: string, binary: boolean) => Promise<string>,
  ): void;
}
```

and change the `documentService` field in `WorkspaceEmbedBridgeOptions` to `WorkspaceFileReaderHost`.

- [ ] **Step 2: Verify the Chrome build still passes**

Run: `npx tsc --noEmit && npm run build:chrome`
Expected: no type errors; the Chrome build completes. This confirms the widening did not regress the shipping extension.

- [ ] **Step 3: Add the desktop platform type**

In `src/types/platform.ts:14`, change:

```ts
export type PlatformType = 'chrome' | 'firefox' | 'mobile' | 'vscode' | 'obsidian';
```

to:

```ts
export type PlatformType = 'chrome' | 'firefox' | 'mobile' | 'vscode' | 'obsidian' | 'desktop';
```

- [ ] **Step 4: Write the platform implementation**

Create `desktop/src/renderer/api-impl.ts`. This mirrors `obsidian/src/webview/api-impl.ts` class for class; the differences are that assets are fetched over `docmd://` instead of round-tripping through the host, and workspace file reads go through `window.desktop`.

```ts
/**
 * Desktop Platform API Implementation
 *
 * Electron's renderer is a full Chromium context, so the whole service layer
 * runs in-process over a direct transport pair — the Obsidian model, not the
 * Chrome one. Modelled closely after obsidian/src/webview/api-impl.ts.
 */
import {
  BaseI18nService,
  CacheService,
  StorageService,
  FileService,
  RendererService,
  SettingsService,
  createSettingsService,
} from '../../../src/services';

import type { FileState } from '../../../src/types/core';
import type { LocaleMessages } from '../../../src/services';
import type { PlatformBridgeAPI } from '../../../src/types/index';
import type { ReadFileOptions } from '../../../src/types/platform';

import { ServiceChannel } from '../../../src/messaging/channels/service-channel';
import { createDirectTransportPair } from '../../../obsidian/src/transports/direct-transport';
import { BaseDocumentService } from '../../../src/services/document-service';
import { IframeRenderHost } from '../../../src/renderers/host/iframe-render-host';

const [hostTransport, webviewTransport] = createDirectTransportPair();
const serviceChannel = new ServiceChannel(webviewTransport, {
  source: 'desktop-renderer',
  timeoutMs: 300000,
});

const bridge: PlatformBridgeAPI = {
  sendRequest: async <T = unknown>(type: string, payload: unknown): Promise<T> =>
    (await serviceChannel.send(type, payload)) as T,
  postMessage: (type: string, payload: unknown): void => { serviceChannel.post(type, payload); },
  addListener: (handler: (message: unknown) => void): (() => void) =>
    serviceChannel.onAny((message) => { handler(message); }),
};

// ── Resource service ───────────────────────────────────────────────
// Bundled assets live next to the renderer under the docmd:// origin, so a
// plain fetch works. No host round-trip needed, unlike Obsidian.
class DesktopResourceService {
  getURL(assetPath: string): string {
    return `docmd://app/${assetPath.replace(/^\/+/, '')}`;
  }

  async fetch(assetPath: string): Promise<string> {
    const response = await window.fetch(this.getURL(assetPath));
    if (!response.ok) throw new Error(`asset not found: ${assetPath}`);
    return response.text();
  }
}

// ── Document service ───────────────────────────────────────────────
export class DesktopDocumentService extends BaseDocumentService {
  private workspaceFileReader:
    | ((relativePath: string, binary: boolean) => Promise<string>)
    | null = null;

  /** Called by the workspace embed bridge so relative images/files resolve. */
  setWorkspaceFileReader(
    reader: (relativePath: string, binary: boolean) => Promise<string>,
  ): void {
    this.workspaceFileReader = reader;
  }

  async readFile(absolutePath: string, options?: ReadFileOptions): Promise<string> {
    const response = await serviceChannel.send('READ_LOCAL_FILE', {
      filePath: absolutePath,
      binary: options?.binary,
    });
    return (response as { content: string }).content;
  }

  async readRelativeFile(relativePath: string, options?: ReadFileOptions): Promise<string> {
    if (this.workspaceFileReader) {
      return this.workspaceFileReader(relativePath, !!options?.binary);
    }
    return this.readFile(relativePath, options);
  }

  override resolvePath(relativePath: string): string {
    return relativePath;
  }

  override toResourceUrl(absolutePath: string): string {
    return absolutePath;
  }
}

// ── I18n service ───────────────────────────────────────────────────
class DesktopI18nService extends BaseI18nService {
  constructor(private resourceService: DesktopResourceService) { super(); }

  async init(): Promise<void> {
    try {
      await this.ensureFallbackMessages();
      this.ready = Boolean(this.fallbackMessages);
    } catch (error) {
      console.warn('[Desktop I18n] init failed:', error);
      this.ready = false;
    }
  }

  async loadLocale(locale: string): Promise<void> {
    try {
      this.messages = await this.fetchLocaleData(locale);
      this.ready = Boolean(this.messages || this.fallbackMessages);
    } catch (error) {
      console.warn('[Desktop I18n] failed to load locale', locale, error);
      this.messages = null;
    }
  }

  async fetchLocaleData(locale: string): Promise<LocaleMessages | null> {
    try {
      return JSON.parse(await this.resourceService.fetch(`_locales/${locale}/messages.json`));
    } catch {
      return null;
    }
  }

  getUILanguage(): string {
    return navigator.language || 'en';
  }
}

// ── Message service ────────────────────────────────────────────────
class DesktopMessageService {
  async send(message: Record<string, unknown>): Promise<unknown> {
    const { type, payload, id, ...rest } = message;
    const requestId = (id ?? rest.requestId) as string | undefined;
    if (typeof type !== 'string') throw new Error('Message must have a type field');

    try {
      const data = await serviceChannel.send(type, payload ?? rest);
      return { type: 'RESPONSE', requestId: requestId ?? '', ok: true, data };
    } catch (error) {
      return {
        type: 'RESPONSE',
        requestId: requestId ?? '',
        ok: false,
        error: { message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  }

  addListener(handler: (message: unknown) => void): void {
    serviceChannel.onAny(handler);
  }
}

// ── File state service ─────────────────────────────────────────────
class DesktopFileStateService {
  private states = new Map<string, FileState>();

  async get(url: string): Promise<FileState> { return this.states.get(url) || {}; }

  set(url: string, state: FileState): void {
    this.states.set(url, { ...(this.states.get(url) || {}), ...state });
  }

  async clear(url: string): Promise<void> { this.states.delete(url); }
}

// ── Platform ───────────────────────────────────────────────────────
export class DesktopPlatformAPI {
  public readonly platform = 'desktop' as const;

  public readonly storage: StorageService;
  public readonly file: FileService;
  public readonly fileState: DesktopFileStateService;
  public readonly resource: DesktopResourceService;
  public readonly cache: CacheService;
  public readonly renderer: RendererService;
  public readonly i18n: DesktopI18nService;
  public readonly message: DesktopMessageService;
  public readonly document: DesktopDocumentService;
  public readonly settings: SettingsService;

  constructor() {
    this.storage = new StorageService(serviceChannel);
    this.file = new FileService(serviceChannel);
    this.cache = new CacheService(serviceChannel);
    this.fileState = new DesktopFileStateService();
    this.resource = new DesktopResourceService();
    this.message = new DesktopMessageService();
    this.document = new DesktopDocumentService();
    this.settings = createSettingsService(this.storage);

    this.renderer = new RendererService({
      createHost: () => new IframeRenderHost({
        fetchHtmlContent: async () => this.resource.fetch('iframe-render.html'),
        source: 'desktop-parent',
        serviceRequestHandler: async (type, payload) => {
          if (type === 'FETCH_RESOURCE') {
            return this.resource.fetch((payload as { path: string }).path);
          }
          throw new Error(`Unknown service request type: ${type}`);
        },
      }),
      cache: this.cache,
    });

    this.i18n = new DesktopI18nService(this.resource);
  }

  async init(): Promise<void> {
    await this.cache.init();
    await this.i18n.init();
  }

  setDocumentPath(path: string, baseUri?: string): void {
    this.document.setDocumentPath(path, baseUri);
  }
}

export const desktopPlatform = new DesktopPlatformAPI();
globalThis.platform = desktopPlatform;

export { desktopPlatform as platform, bridge as desktopBridge, hostTransport, serviceChannel };
export default desktopPlatform;
```

- [ ] **Step 5: Write the service host**

The direct transport pair has two ends. Step 4 built the webview end; this is the host end that answers its requests. The handler list mirrors `obsidian/src/host/preview-view.ts:351-420`, minus the export handlers (`UPLOAD_OPERATION`, `DOCX_DOWNLOAD_FINALIZE`), which belong to export and are out of scope for v1.

Create `desktop/src/renderer/service-host.ts`:

```ts
/**
 * Host end of the direct transport pair.
 *
 * Mirrors obsidian/src/host/preview-view.ts registerHostHandlers(). Storage is
 * localStorage (the renderer is a stable single-origin context), cache is
 * whatever CacheService expects from a host, and file reads go over IPC.
 */
import { ServiceChannel } from '../../../src/messaging/channels/service-channel';
import { hostTransport } from './api-impl';

export interface HostContext {
  /** The folder a relative path should resolve against. */
  getActiveFolderId(): string | null;
}

const STORAGE_PREFIX = 'docu-md:';

function storageGet(keys: string | string[]): Record<string, unknown> {
  const list = Array.isArray(keys) ? keys : [keys];
  const result: Record<string, unknown> = {};
  for (const key of list) {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (raw !== null) {
      try { result[key] = JSON.parse(raw); } catch { result[key] = raw; }
    }
  }
  return result;
}

export function createServiceHost(ctx: HostContext): ServiceChannel {
  const channel = new ServiceChannel(hostTransport, {
    source: 'desktop-host',
    timeoutMs: 300000,
  });

  channel.handle('STORAGE_GET', async (payload) =>
    storageGet((payload as { keys: string | string[] }).keys));

  channel.handle('STORAGE_SET', async (payload) => {
    const { items } = payload as { items: Record<string, unknown> };
    for (const [key, value] of Object.entries(items)) {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    }
    return { success: true };
  });

  channel.handle('STORAGE_REMOVE', async (payload) => {
    const { keys } = payload as { keys: string | string[] };
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      localStorage.removeItem(STORAGE_PREFIX + key);
    }
    return { success: true };
  });

  channel.handle('CACHE_OPERATION', async (payload) => {
    // Cache entries are content-addressed render output. localStorage is the
    // wrong store for large blobs, but v1 has no cross-session persistence
    // requirement, so an in-memory map is sufficient and cannot bloat on disk.
    return handleCacheOperation(payload as CacheOp);
  });

  channel.handle('FETCH_ASSET', async (payload) => {
    const { path } = payload as { path: string };
    const response = await fetch(`docmd://app/${path.replace(/^\/+/, '')}`);
    if (!response.ok) throw new Error(`asset not found: ${path}`);
    return response.text();
  });

  channel.handle('READ_LOCAL_FILE', async (payload) => {
    const { filePath, binary } = payload as { filePath: string; binary?: boolean };
    const folderId = ctx.getActiveFolderId();
    if (!folderId) throw new Error('no active folder');
    return { content: await window.desktop.readFile(folderId, filePath, !!binary) };
  });

  channel.handle('SAVE_SETTING', async (payload) => {
    const { key, value } = (payload ?? {}) as { key: string; value: unknown };
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    return { success: true };
  });

  channel.handle('LOAD_SETTINGS', async () => storageGet(
    Object.keys(localStorage)
      .filter((k) => k.startsWith(STORAGE_PREFIX))
      .map((k) => k.slice(STORAGE_PREFIX.length)),
  ));

  channel.handle('OPEN_URL', async (payload) => {
    const url = (payload as { url?: string })?.url;
    if (url) window.open(url, '_blank');
    return { success: true };
  });

  return channel;
}

interface CacheOp {
  operation: string;
  key?: string;
  value?: unknown;
  dataType?: string;
}

const memoryCache = new Map<string, unknown>();

function handleCacheOperation(op: CacheOp): unknown {
  switch (op.operation) {
    case 'get': return { value: memoryCache.get(op.key!) ?? null };
    case 'set': memoryCache.set(op.key!, op.value); return { success: true };
    case 'delete': memoryCache.delete(op.key!); return { success: true };
    case 'clear': memoryCache.clear(); return { success: true };
    case 'getStats': return { count: memoryCache.size };
    default: throw new Error(`unknown cache operation: ${op.operation}`);
  }
}
```

> **Verify against the real signatures.** `ServiceChannel.handle`, `CacheService.init`, and `RendererService`'s options are read from `obsidian/src/host/preview-view.ts` and `obsidian/src/webview/api-impl.ts`, which are known-working callers. If a signature disagrees, follow the Obsidian file, not this plan.

- [ ] **Step 6: Write the viewer embed page**

Create `desktop/src/renderer/viewer-embed.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style id="markdown-viewer-preload">body{opacity:0}</style>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <script type="module" src="viewer-embed.js"></script>
</body>
</html>
```

Create `desktop/src/renderer/viewer-embed.ts` by adapting `chrome/src/workspace/viewer-embed.ts`:

```bash
cp chrome/src/workspace/viewer-embed.ts desktop/src/renderer/viewer-embed.ts
```

Then make these edits to `desktop/src/renderer/viewer-embed.ts`:

1. Replace the platform import
   - from: `import { platform } from '../webview/index';`
   - to: `import platform from './api-impl';`
2. Repoint the cross-folder imports
   - `'../webview/viewer-main'` → `'../../../chrome/src/webview/viewer-main'`
   - `'../../../src/core/viewer/viewer-bootstrap'` → `'../../../src/core/viewer/viewer-bootstrap'` (unchanged depth — verify)
   - `'./workspace-embed-bridge'` → `'../../../chrome/src/workspace/workspace-embed-bridge'`
   - `'./workspace-embed-host-ui'` → `'../../../chrome/src/workspace/workspace-embed-host-ui'`
   - `'./workspace-embed-parent-bridge'` → `'../../../chrome/src/workspace/workspace-embed-parent-bridge'`
   - `'./file-icons'` → delete this import entirely
3. Drop the nav-history code, which has no desktop equivalent:
   - delete `interface WorkspaceHistoryUiMessage`
   - delete `let pendingWorkspaceHistoryUi`
   - delete `ensureWorkspaceHistoryInline()` and `applyWorkspaceHistoryUi()`
   - delete the `if (pendingWorkspaceHistoryUi) { applyWorkspaceHistoryUi(...) }` block inside `ensureViewerInitialized`
   - delete the trailing `window.addEventListener('message', ...)` block that handles `SYNC_WORKSPACE_HISTORY_UI`
4. Drop the `ChromeDocumentService` cast in the `createWorkspaceEmbedBridge` call:
   - from: `documentService: platform.document as import('../webview/api-impl').ChromeDocumentService,`
   - to: `documentService: platform.document as import('./api-impl').DesktopDocumentService,`

- [ ] **Step 7: Write the real view factory**

Create `desktop/src/renderer/viewer-view.ts`:

```ts
import { createViewerIframeHostBridge } from '../../../src/integration/iframe-viewer-host';
import type { SyncInput, ViewHandle } from './viewer-pool';

const VIEWER_URL = 'docmd://app/viewer-embed.html';

export function createIframeView(
  host: HTMLElement,
  folderId: string,
  relPath: string,
  key: string,
): ViewHandle {
  const iframe = document.createElement('iframe');
  iframe.dataset.viewKey = key;
  iframe.dataset.active = 'false';
  iframe.src = VIEWER_URL;
  host.append(iframe);

  const bridge = createViewerIframeHostBridge((message) => {
    iframe.contentWindow?.postMessage(message, '*');
  });

  // Messages queue until the embedded viewer signals it is listening.
  let ready = false;
  const queue: SyncInput[] = [];

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== iframe.contentWindow) return;
    if ((event.data as { type?: string })?.type !== 'VIEWER_READY') return;
    ready = true;
    for (const pending of queue.splice(0)) push(pending);
  };
  window.addEventListener('message', onMessage);

  function push(input: SyncInput): void {
    bridge.syncDocument({
      // Same key → UPDATE_CONTENT (in place, scroll preserved).
      // New key  → OPEN_DOCUMENT (full render).
      documentKey: key,
      content: input.content,
      filename: input.filename,
      workspaceName: input.workspaceName,
      workspaceFilePath: input.workspaceFilePath,
      targetLine: input.scrollLine,
    });
  }

  return {
    key,
    setActive(active: boolean): void {
      iframe.dataset.active = String(active);
    },
    sync(input: SyncInput): void {
      if (ready) push(input);
      else queue.push(input);
    },
    destroy(): void {
      window.removeEventListener('message', onMessage);
      bridge.reset();
      iframe.remove();
    },
  };
}
```

- [ ] **Step 8: Extend the build with the viewer entry point and the asset pipeline**

The viewer needs far more than the two files Task 1 copied: locales, themes, drawio stencils, and a generated `iframe-render.html` with Mermaid inlined. This mirrors `obsidian/build.js:217-290` — read that function before writing this one.

In `desktop/build.js`, change the renderer build's `entryPoints` to:

```js
  entryPoints: {
    renderer: 'desktop/src/renderer/main.ts',
    'viewer-embed': 'desktop/src/renderer/viewer-embed.ts',
  },
```

Add an IIFE build for the render worker, after the renderer build:

```js
await build({
  ...shared,
  entryPoints: { 'iframe-render-worker': 'mobile/src/webview/iframe-render-worker.ts' },
  outdir,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  external: ['mermaid', 'web-worker'],
});
```

Replace the static-asset section at the end of the file with:

```js
function copyDirectory(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const src = path.join(sourceDir, entry.name);
    const dst = path.join(targetDir, entry.name);
    if (entry.isDirectory()) copyDirectory(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

for (const file of ['index.html', 'viewer-embed.html', 'workspace.css']) {
  fs.copyFileSync(path.join(__dirname, 'src/renderer', file), path.join(outdir, file));
}
fs.copyFileSync(path.join(__dirname, 'package.json'), path.join(outdir, 'package.json'));
fs.copyFileSync(path.join(projectRoot, 'src/ui/styles.css'), path.join(outdir, 'styles.css'));

copyDirectory(path.join(projectRoot, 'icons'), path.join(outdir, 'icons'));
copyDirectory(path.join(projectRoot, 'src/_locales'), path.join(outdir, '_locales'));
copyDirectory(path.join(projectRoot, 'src/themes'), path.join(outdir, 'themes'));
copyDirectory(
  path.join(projectRoot, 'node_modules/@markdown-viewer/drawio2svg/resources/stencils'),
  path.join(outdir, 'stencils'),
);
console.log('  • icons, _locales, themes, stencils');

// iframe-render.html with Mermaid and the worker inlined, matching
// obsidian/build.js — the renderer fetches this via DesktopResourceService.
const mermaidPath = path.join(projectRoot, 'node_modules/mermaid/dist/mermaid.min.js');
const workerPath = path.join(outdir, 'iframe-render-worker.js');
if (fs.existsSync(mermaidPath) && fs.existsSync(workerPath)) {
  const template = fs.readFileSync(
    path.join(projectRoot, 'mobile/src/webview/iframe-render.html'),
    'utf8',
  );
  const html = template
    .replace('<!--INLINE_MERMAID-->', `<script>${fs.readFileSync(mermaidPath, 'utf8')}</script>`)
    .replace('<!--INLINE_WORKER-->', `<script>${fs.readFileSync(workerPath, 'utf8')}</script>`);
  fs.writeFileSync(path.join(outdir, 'iframe-render.html'), html);
  console.log('  • iframe-render.html');
} else {
  console.warn('⚠️  mermaid or iframe-render-worker missing — diagrams will not render');
}

console.log(`\n✅ Build complete → dist/desktop/`);
```

> **Check the template placeholders.** `mobile/src/webview/iframe-render.html` may use different markers than `<!--INLINE_MERMAID-->` / `<!--INLINE_WORKER-->`, or may inline via a different mechanism. Read it and `obsidian/build.js:262-287` together, and follow whatever the Obsidian build actually does.

- [ ] **Step 9: Wire the pool into the bootstrap**

In `desktop/src/renderer/main.ts`, add the imports:

```ts
import { createViewerPool } from './viewer-pool';
import { createIframeView } from './viewer-view';
import { viewKey } from './workspace-model';
import { desktopPlatform } from './api-impl';
import { createServiceHost } from './service-host';
```

Add the DOM ref, the service host, and the pool, after the model. The service host must exist before any service request is issued, so it is created first.

```ts
const $viewerHost = document.getElementById('viewer-host')!;

// Host end of the direct transport pair. Relative paths resolve against
// whichever folder is active when the request arrives.
createServiceHost({
  getActiveFolderId: () => model.getState().activeFolderId,
});

const pool = createViewerPool({
  capacity: 8,
  createView: (key) => {
    const [folderId, ...rest] = key.split(':');
    return createIframeView($viewerHost, folderId, rest.join(':'), key);
  },
});
```

Replace the final `render();` call at the bottom of the file with an async bootstrap, so caches and locales are ready before the first document renders:

```ts
void (async () => {
  await desktopPlatform.init();
  render();
})();
```

Add the activation routine above `render`:

```ts
let lastActivatedKey: string | null = null;

async function activateActiveTab(): Promise<void> {
  const folder = model.getActiveFolder();
  if (!folder || !folder.activeRelPath) return;

  const relPath = folder.activeRelPath;
  const key = viewKey(folder.id, relPath);
  const tab = folder.tabs.find((t) => t.relPath === relPath);

  // Re-read only when the view is cold or the file changed while evicted.
  const needsRead = !pool.has(key) || tab?.dirty || lastActivatedKey !== key;
  if (!needsRead) return;

  const content = await window.desktop.readFile(folder.id, relPath, false);
  pool.activate(key, {
    content,
    filename: tab?.name ?? relPath,
    workspaceName: folder.name,
    workspaceFilePath: relPath,
    scrollLine: tab?.scrollLine,
  });
  model.markDirty(folder.id, relPath, false);
  lastActivatedKey = key;
}
```

Call it at the end of `render()`:

```ts
  void activateActiveTab();
```

And evict a folder's views in `closeFolder`, before `model.removeFolder`:

```ts
  pool.evictFolder(folderId);
```

- [ ] **Step 10: Extend the smoke test**

Append to `test/desktop-smoke.test.ts`, inside the existing `describe`:

```ts
  it('renders a document in the viewer iframe', async () => {
    const window = await app.firstWindow();
    await window.click('.folder-tab:nth-of-type(1) .folder-tab-label');
    await window.click('.tree-row[data-rel-path="README.md"]');

    const frame = await (await window.waitForSelector(
      'iframe[data-active="true"]',
    )).contentFrame();
    assert.ok(frame, 'active viewer iframe should have a content frame');
    await frame.waitForSelector('h1');
    assert.equal(await frame.textContent('h1'), 'Alpha');
  });
```

- [ ] **Step 11: Build and run the full test suite to verify it passes**

Run: `npx tsc --noEmit && npm run build:desktop && npm test`
Expected: PASS — the heading `Alpha` renders inside the active iframe, and every existing test still passes.

- [ ] **Step 12: Commit**

```bash
git add desktop src/types/platform.ts chrome/src/workspace/workspace-embed-bridge.ts test/desktop-smoke.test.ts
git commit -m "feat(desktop): render documents through pooled viewer iframes"
```

---

### Task 9: File watching and live reload

**Files:**
- Create: `desktop/src/main/file-watcher.ts`
- Modify: `desktop/src/main/ipc.ts` (start/stop watchers alongside folder open/close)
- Modify: `desktop/src/renderer/main.ts` (subscribe to change events)
- Modify: `test/desktop-smoke.test.ts`

**Interfaces:**
- Consumes: `FileChangeEvent` from `desktop/types/ipc`; `chokidar`.
- Produces: `startWatching(folderId, root, send)`, `stopWatching(folderId)`, `stopAllWatchers()` from `file-watcher.ts`, where `send: (event: FileChangeEvent) => void`.

- [ ] **Step 1: Write the watcher**

Create `desktop/src/main/file-watcher.ts`:

```ts
import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';
import type { FileChangeEvent, FileChangeKind } from '../../types/ipc';

const DEBOUNCE_MS = 100;

const watchers = new Map<string, FSWatcher>();

export function startWatching(
  folderId: string,
  root: string,
  send: (event: FileChangeEvent) => void,
): void {
  stopWatching(folderId);

  const pending = new Map<string, NodeJS.Timeout>();

  const emit = (kind: FileChangeKind, absPath: string): void => {
    const relPath = path.relative(root, absPath).split(path.sep).join('/');
    if (relPath.startsWith('..')) return;

    // Collapse the burst of events editors emit for a single save.
    const existing = pending.get(relPath);
    if (existing) clearTimeout(existing);
    pending.set(relPath, setTimeout(() => {
      pending.delete(relPath);
      send({ folderId, relPath, kind });
    }, DEBOUNCE_MS));
  };

  let watcher: FSWatcher;
  try {
    watcher = chokidar.watch(root, {
      ignored: /(^|[/\\])(\.git|node_modules)([/\\]|$)/,
      ignoreInitial: true,
      persistent: true,
      depth: 12,
    });
  } catch (error) {
    // A watcher failure must never block opening a folder — live reload is a
    // convenience, not a precondition.
    console.warn(`[desktop] watcher unavailable for ${root}:`, error);
    return;
  }

  watcher.on('change', (p) => emit('change', p));
  watcher.on('add', (p) => emit('add', p));
  watcher.on('unlink', (p) => emit('unlink', p));
  watcher.on('error', (error) => {
    console.warn(`[desktop] watcher error for ${root}:`, error);
  });

  watchers.set(folderId, watcher);
}

export function stopWatching(folderId: string): void {
  const watcher = watchers.get(folderId);
  if (!watcher) return;
  void watcher.close();
  watchers.delete(folderId);
}

export function stopAllWatchers(): void {
  for (const folderId of [...watchers.keys()]) stopWatching(folderId);
}
```

- [ ] **Step 2: Start and stop watchers with folders**

In `desktop/src/main/ipc.ts`, add the import:

```ts
import { startWatching, stopWatching } from './file-watcher';
```

In the `folder:open` handler, after `openFolders.set(id, root);`:

```ts
    startWatching(id, root, (event) => {
      if (!win.isDestroyed()) win.webContents.send('fs:changed', event);
    });
```

In the `folder:close` handler, before `openFolders.delete(folderId)`:

```ts
    stopWatching(folderId);
```

In `desktop/src/main/main.ts`, stop watchers on quit. Add the import and the handler:

```ts
import { stopAllWatchers } from './file-watcher';
```

```ts
app.on('before-quit', () => { stopAllWatchers(); });
```

- [ ] **Step 3: Handle change events in the renderer**

In `desktop/src/renderer/main.ts`, add below the `pool` definition:

```ts
window.desktop.onFileChanged((event) => {
  const folder = model.getFolder(event.folderId);
  if (!folder) return;

  if (event.kind === 'add') {
    model.addNode(event.folderId, {
      name: event.relPath.split('/').pop()!,
      relPath: event.relPath,
      kind: 'file',
    });
    return;
  }

  if (event.kind === 'unlink') {
    model.removeNode(event.folderId, event.relPath);
    return;
  }

  const key = viewKey(event.folderId, event.relPath);
  if (!pool.has(key)) {
    // Evicted: re-read on next activation instead of paying for it now.
    model.markDirty(event.folderId, event.relPath, true);
    return;
  }

  void reloadView(event.folderId, event.relPath, key);
});

async function reloadView(folderId: string, relPath: string, key: string): Promise<void> {
  const folder = model.getFolder(folderId);
  const tab = folder?.tabs.find((t) => t.relPath === relPath);
  if (!folder || !tab) return;

  let content: string;
  try {
    content = await window.desktop.readFile(folderId, relPath, false);
  } catch {
    // Deleted between the event and the read — the unlink event will follow.
    return;
  }

  // Same documentKey → the bridge sends UPDATE_CONTENT, so scroll survives.
  pool.acquire(key)?.sync({
    content,
    filename: tab.name,
    workspaceName: folder.name,
    workspaceFilePath: relPath,
  });
}
```

- [ ] **Step 4: Extend the smoke test**

Append to `test/desktop-smoke.test.ts`. Add the fs import at the top of the file:

```ts
import fs from 'node:fs/promises';
```

Then inside the existing `describe`:

```ts
  it('live-reloads an open tab when its file changes on disk', async () => {
    const window = await app.firstWindow();
    const target = path.join(projectRoot, 'test/fixtures/desktop/alpha/README.md');
    const original = await fs.readFile(target, 'utf8');

    try {
      await window.click('.folder-tab:nth-of-type(1) .folder-tab-label');
      await window.click('.tree-row[data-rel-path="README.md"]');

      const frame = await (await window.waitForSelector(
        'iframe[data-active="true"]',
      )).contentFrame();
      await frame!.waitForSelector('h1');
      assert.equal(await frame!.textContent('h1'), 'Alpha');

      await fs.writeFile(target, '# Alpha Reloaded\n\nUpdated on disk.\n', 'utf8');
      await frame!.waitForFunction(
        () => document.querySelector('h1')?.textContent === 'Alpha Reloaded',
        undefined,
        { timeout: 5000 },
      );
    } finally {
      await fs.writeFile(target, original, 'utf8');
    }
  });
```

- [ ] **Step 5: Build and run the smoke test to verify it passes**

Run: `npm run build:desktop && node --test test/desktop-smoke.test.ts`
Expected: PASS — the heading changes to `Alpha Reloaded` without any click, and the fixture is restored.

- [ ] **Step 6: Commit**

```bash
git add desktop test/desktop-smoke.test.ts
git commit -m "feat(desktop): live-reload open tabs on disk changes"
```

---

### Task 10: Error states

**Files:**
- Modify: `desktop/src/main/ipc.ts` (report a vanished folder root)
- Modify: `desktop/src/renderer/main.ts` (surface folder and file errors)
- Modify: `desktop/src/renderer/workspace.css` (banner styles)
- Modify: `test/desktop-smoke.test.ts`

**Interfaces:**
- Consumes: `setFolderStatus` from `WorkspaceModel`.
- Produces: no new exports. `listDir` rejections carrying `ENOENT` flip the folder to `status: 'unavailable'`; `readFile` rejections render a banner in the viewer host.

- [ ] **Step 1: Surface folder unavailability**

In `desktop/src/renderer/main.ts`, wrap the initial tree load in `openFolder`:

```ts
  try {
    const entries = await window.desktop.listDir(folder.id, '');
    model.setTree(folder.id, entries);
  } catch {
    model.setFolderStatus(folder.id, 'unavailable');
  }
```

And in `toggleDir`, wrap the child load:

```ts
  if (node && node.kind === 'directory' && !node.childrenLoaded) {
    try {
      const entries = await window.desktop.listDir(folderId, relPath);
      model.setChildren(folderId, relPath, entries);
    } catch {
      model.setFolderStatus(folderId, 'unavailable');
      return;
    }
  }
```

- [ ] **Step 2: Surface a missing file**

In `desktop/src/renderer/main.ts`, replace the body of `activateActiveTab` after the `needsRead` check:

```ts
  let content: string;
  try {
    content = await window.desktop.readFile(folder.id, relPath, false);
  } catch (error) {
    showViewerBanner(
      String(error).includes('ENOENT')
        ? `${relPath} no longer exists on disk.`
        : `Could not read ${relPath}.`,
    );
    return;
  }
  clearViewerBanner();
```

Add the banner helpers at the bottom of the file:

```ts
function showViewerBanner(message: string): void {
  let banner = document.getElementById('viewer-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'viewer-banner';
    banner.className = 'viewer-banner';
    $viewerHost.append(banner);
  }
  banner.textContent = message;
  banner.hidden = false;
}

function clearViewerBanner(): void {
  const banner = document.getElementById('viewer-banner');
  if (banner) banner.hidden = true;
}
```

- [ ] **Step 3: Style the banner**

Append to `desktop/src/renderer/workspace.css`:

```css
.viewer-banner {
  position: absolute; top: 0; left: 0; right: 0; z-index: 10;
  padding: 8px 12px; font-size: 13px;
  background: var(--mv-warn-bg, #fff8c5);
  color: var(--mv-warn-text, #4d2d00);
  border-bottom: 1px solid var(--mv-warn-border, #d4a72c);
}
```

- [ ] **Step 4: Extend the smoke test**

Append to `test/desktop-smoke.test.ts`, inside the existing `describe`:

```ts
  it('shows a banner when an open file is deleted', async () => {
    const window = await app.firstWindow();
    const dir = path.join(projectRoot, 'test/fixtures/desktop/alpha');
    const temp = path.join(dir, 'temp-doc.md');
    await fs.writeFile(temp, '# Temp\n', 'utf8');

    try {
      await window.click('.folder-tab:nth-of-type(1) .folder-tab-label');
      await window.waitForSelector('.tree-row[data-rel-path="temp-doc.md"]');
      await window.click('.tree-row[data-rel-path="temp-doc.md"]');
      await window.waitForSelector('.file-tab[data-rel-path="temp-doc.md"]');

      await fs.rm(temp);
      // The tab survives the deletion; only the tree row disappears.
      await window.waitForSelector('.tree-row[data-rel-path="temp-doc.md"]', { state: 'detached' });
      assert.ok(await window.$('.file-tab[data-rel-path="temp-doc.md"]'));
    } finally {
      await fs.rm(temp, { force: true });
    }
  });
```

- [ ] **Step 5: Build and run the full suite to verify it passes**

Run: `npm run build:desktop && npm test`
Expected: PASS — the tree row disappears, the file tab remains, and no test regressed.

- [ ] **Step 6: Commit**

```bash
git add desktop test/desktop-smoke.test.ts
git commit -m "feat(desktop): handle unavailable folders and deleted files"
```

---

### Task 11: macOS packaging

**Files:**
- Create: `desktop/electron-builder.yml`
- Modify: `desktop/build.js` (add a `--package` flag)
- Modify: `package.json` (add `package:desktop`)
- Create: `desktop/README.md`

**Interfaces:**
- Consumes: `dist/desktop/` from Task 1's build.
- Produces: `dist/docu.md-<version>-universal.dmg`.

- [ ] **Step 1: Write the electron-builder config**

Create `desktop/electron-builder.yml`:

```yaml
appId: md.docu.desktop
productName: docu.md
copyright: GPL-3.0-only

directories:
  app: ../dist/desktop
  output: ../dist

files:
  - '**/*'

mac:
  category: public.app-category.productivity
  target:
    - target: dmg
      arch: [universal]
  icon: ../icons/icon128.png
  darkModeSupport: true
  # Unsigned local builds. Signing and notarization are a separate change.
  identity: null

dmg:
  artifactName: ${productName}-${version}-universal.${ext}
```

- [ ] **Step 2: Add the packaging step to the build script**

Append to `desktop/build.js`, replacing the trailing `if (watch)` block:

```js
if (process.argv.includes('--package')) {
  const { execSync } = await import('node:child_process');
  console.log('\n📦 Packaging macOS app...');
  execSync('npx electron-builder --config desktop/electron-builder.yml --mac', {
    stdio: 'inherit',
    cwd: projectRoot,
  });
  console.log(`\n✅ Packaged → dist/docu.md-${version}-universal.dmg`);
}
```

- [ ] **Step 3: Add the npm script**

Add to `package.json` `scripts`, after `"build:desktop"`:

```json
"package:desktop": "node desktop/build.js --package",
```

- [ ] **Step 4: Build the package and verify it launches**

Run: `npm run package:desktop`
Expected: `dist/docu.md-5.2.1-universal.dmg` is produced.

Then:

```bash
open dist/docu.md-*-universal.dmg
```

Drag the app to `/Applications`, launch it, open a folder, and confirm a document renders. macOS Gatekeeper will warn about an unidentified developer on an unsigned build — right-click → Open to bypass for local verification.

- [ ] **Step 5: Write the platform README**

Create `desktop/README.md`:

```markdown
# docu.md Desktop

Electron shell for macOS. Opens multiple local folders as tabs; each folder has
its own file tree and its own row of file tabs. Open files re-render in place
when they change on disk.

## Develop

```bash
npm run dev:desktop      # build, then launch Electron
npm run build:desktop    # build only → dist/desktop/
npm run package:desktop  # build + package → dist/*.dmg
```

## Test

```bash
node --test test/desktop-workspace-fs.test.ts
node --test test/desktop-workspace-model.test.ts
node --test test/desktop-viewer-pool.test.ts
npm run build:desktop && node --test test/desktop-smoke.test.ts
```

The first three run without Electron. The smoke test drives the packaged
renderer through Playwright's `_electron` and needs a fresh build first.

## Architecture

The main process owns all filesystem access and exposes a narrow
`contextBridge` surface (`desktop/types/ipc.ts`). The renderer holds pure
workspace state (`workspace-model.ts`) plus a bounded LRU pool of viewer
iframes (`viewer-pool.ts`, cap 8).

Rendering reuses the shared core: `viewer-embed.ts` imports `startViewer` from
`chrome/src/webview/viewer-main`, the same cross-platform import
`firefox/src/webview/main.ts` uses, supplying the desktop `PlatformAPI` from
`api-impl.ts`.

Design: `specs/2026-08-04-desktop-app-design.md`
```

- [ ] **Step 6: Commit**

```bash
git add desktop package.json
git commit -m "feat(desktop): package macOS universal DMG"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: repository layout → Task 1; process architecture → Tasks 1, 2, 8; the folder-bar-plus-file-tabs layout → Tasks 5, 6, 7; the viewer pool including the `visibility: hidden` rule → Tasks 1 (CSS), 4 (logic), 8 (iframes); live reload including the `documentKey` mechanism → Task 9; the error-handling table → Tasks 2 (path escape), 9 (watcher failure), 10 (unavailable folder, deleted file); the testing section → Tasks 2, 3, 4 (unit) and 1, 5, 6, 7, 8, 9, 10 (smoke); out-of-scope items appear nowhere, as intended.

Two spec statements were wrong and are corrected in the "Deviations" section above, with Task 1 Step 12 updating the spec itself.

**Type consistency.** `viewKey(folderId, relPath)` returns `folderId:relPath` in Task 3 and is parsed with the same shape in Task 8 Step 9 and matched by prefix in `evictFolder` (Task 4). `SyncInput` is defined once in Task 4 and consumed unchanged in Tasks 8 and 9. `DirEntry`, `OpenedFolder`, and `FileChangeEvent` are defined once in `desktop/types/ipc.ts` (Task 2) and imported everywhere else. `DesktopBridge` grows in Task 8 Step 4; the preload and main handlers are updated in the same step.

**Corrections made during self-review.** The first draft of Task 8 was wrong in three ways, all found by reading the Obsidian shell rather than assuming:

1. It invented an `ElectronIpcTransport`. Unnecessary — the renderer runs every service in-process over `createDirectTransportPair`, and the one filesystem call goes through `window.desktop` directly. The file and its preload/main plumbing were deleted.
2. Its `api-impl.ts` was a flat object literal with guessed constructor arities. The real shape is a class with six collaborating services, a `RendererService` built around `IframeRenderHost`, and an async `init()`. Rewritten against `obsidian/src/webview/api-impl.ts`.
3. It had no service host at all, so every service request would have hung with no responder, and no asset pipeline, so locales, themes, stencils, and `iframe-render.html` would have been missing at runtime. Both added, modeled on `obsidian/src/host/preview-view.ts:351-420` and `obsidian/build.js:217-290`.

**Remaining soft spots.** Two, both flagged inline in the task with instructions to follow the Obsidian source over this plan: the exact `ServiceChannel.handle` / `RendererService` options signatures (Task 8 Step 5), and the inlining markers in `mobile/src/webview/iframe-render.html` (Task 8 Step 8). Task 8 is the largest task by a wide margin and is where a reviewer should look hardest.
