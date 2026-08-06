# docu.md Desktop App — Design

**Date:** 2026-08-04
**Status:** Approved, ready for implementation planning

## Summary

A macOS desktop application that opens local folders of Markdown (and the other
supported formats) in the docu.md viewer. Multiple folders are open at once as a
row of folder tabs; each folder owns its own file tree and its own row of file
tabs. Files re-render in place when they change on disk.

The app is a new platform shell in this repository, built on Electron, reusing
the existing shared core in `src/` and the workspace UI already written for the
Chrome extension.

## Motivation

`chrome/src/workspace/` already implements a folder-browsing viewer: directory
picker, lazy file tree, filename and content search, navigation history, and a
preview iframe. It has two limits that a desktop shell removes:

- **One folder at a time, one preview pane.** There is no tab model at either
  level.
- **The File System Access API.** Access is mediated by permission-scoped
  `FileSystemDirectoryHandle` objects rather than real paths, and there is no
  file-change notification.

Electron replaces both constraints with real paths and a filesystem watcher,
which is what makes multi-folder tabs and live reload straightforward rather
than awkward.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Window model | Single window; folder tabs on top, per-folder file tabs below | Folder-scoped tab state was the explicit requirement |
| Shell | Electron | The viewer is already a web app; `workspace.ts` ports nearly unchanged, and rendering matches the Chrome extension already shipped |
| Platform | macOS only for v1 | Build config stays cross-platform-capable but only macOS ships |
| Tab rendering | LRU pool of 8 live views | Instant switching in the common case with a memory ceiling |

## Layout

```
┌──────────────────────────────────────────────┐
│ [ ~/docs ] [ ~/notes ] [ ~/blog ]        [+] │ ← folder tabs
├──────────┬───────────────────────────────────┤
│ FILES    │ README.md │ api.md │ spec.md   ✕  │ ← file tabs (this folder)
│ ▸ guides ├───────────────────────────────────┤
│ ▾ api    │                                   │
│   api.md │   # API Reference                 │
│   spec.md│                                   │
│ README.md│   Endpoints are grouped by...     │
└──────────┴───────────────────────────────────┘
```

Switching folder tabs swaps the tree and the file-tab strip together. Each
folder retains its open tabs, active tab, expanded tree nodes, and scroll
positions.

Interactions:

- `[+]` opens the native folder picker and appends a folder tab.
- Closing a folder tab closes its file tabs, destroys its pooled views, and
  stops its watcher.
- Clicking a file in the tree opens it as a tab, or activates the existing tab
  if the file is already open.
- Closing the active file tab activates its nearest neighbor.
- With no folders open, the window shows the landing state (the existing
  workspace landing card, minus the recent-workspaces list, which depends on
  session persistence that is out of scope for v1).

## Repository layout

A new `desktop/` folder as a peer of `chrome/`, `vscode/`, `obsidian/`, and
`mobile/`, following the `host` + `transports` + `webview` shape those already
use.

```
desktop/
  build.js                       esbuild bundle → dist/desktop/, then electron-builder
  package.json                   electron, electron-builder, chokidar
  src/
    main/
      main.ts                    app lifecycle, single BrowserWindow
      workspace-fs.ts            lazy directory listing, file reads
      file-watcher.ts            chokidar per open folder
      ipc.ts                     typed IPC handler registry
    preload/
      preload.ts                 contextBridge surface
    renderer/
      workspace-model.ts         pure state, no DOM
      folder-tabs.ts             folder tab strip
      file-tabs.ts               per-folder file tab strip
      file-tree.ts               tree rendering, ported from workspace.ts
      viewer-pool.ts             LRU pool of viewer iframes
      api-impl.ts                ViewerHostApi over IPC
      workspace.css              styling, based on chrome/src/workspace/workspace.css
    transports/
      electron-ipc-transport.ts  implements MessageTransport
```

New npm scripts `dev:desktop` and `build:desktop`. No existing platform build
changes.

### Reused without modification

- All of `src/` — markdown core, renderers, exporters, themes, services, i18n
- `chrome/src/workspace/file-icons.ts` and `file-icons-data.ts`
- `src/integration/iframe-viewer-host.ts` — the host↔iframe bridge
- `chrome/src/webview/viewer-main.ts` — imported directly across platform
  folders, following the precedent `firefox/src/webview/main.ts` already sets.
  It takes `{ platform, pluginRenderer, themeConfigRenderer }`, so the desktop
  supplies its own `PlatformAPI` and reuses the 1,644-line viewer as-is.

### Ported with changes

`chrome/src/workspace/workspace.ts` (1,586 lines) splits into
`workspace-model.ts`, `file-tree.ts`, `folder-tabs.ts`, `file-tabs.ts`, and
`viewer-pool.ts`. Its `FileSystemDirectoryHandle` walking is replaced by IPC
calls to `workspace-fs.ts`.

Preserved: lazy tree loading (`childrenLoaded`, `directoryReadCache`), filename
search, content search, and the sidebar resize handle.

Dropped: the back/forward navigation history. Tabs replace it — with every
visited file already addressable as a tab, a second history stack is redundant.

`chrome/src/workspace/workspace.css` is copied as the styling base and extended
with the two tab strips.

`chrome/src/workspace/viewer-embed.ts` and `viewer-embed.html` are adapted
rather than reused verbatim. The Chrome version imports `../webview/index`,
which sets `globalThis.platform` to the Chrome implementation, and types on
`ChromeDocumentService`. The desktop copy swaps the platform import and drops
the back/forward history controls along with nav history, making it roughly 90
lines shorter.

## Process architecture

### Main process

The only component with disk access.

- **`main.ts`** — app lifecycle and a single `BrowserWindow` created with
  `contextIsolation: true` and `nodeIntegration: false`.
- **`workspace-fs.ts`** — lazy directory listing and file reads over real paths.
  Filters to `ALL_SUPPORTED_EXTENSIONS` from `src/types/formats`, matching
  current workspace behavior.
- **`file-watcher.ts`** — one chokidar watcher per open folder, debounced at
  100ms, ignoring `.git` and `node_modules`.
- **`ipc.ts`** — typed handler registration so main and preload share one
  contract.

### Preload

A narrow `contextBridge` surface. No `fs`, no `path`, and no arbitrary IPC is
exposed to the renderer:

- `openFolderDialog()`
- `listDir(folderId, relPath)`
- `readFile(folderId, relPath)`
- `watch(folderId)` / `unwatch(folderId)`
- `onFileChanged(handler)`

All paths are resolved against the folder root in the main process and rejected
if they escape it.

### Renderer

- **`workspace-model.ts`** — pure state with no DOM dependency. Holds
  `Folder[]`, each `{ id, path, name, tree, tabs, activeTabId, expandedPaths,
  scrollLines }`. All folder and tab logic lives here so it is unit-testable
  without launching Electron.
- **`folder-tabs.ts` / `file-tabs.ts`** — the two tab strips.
- **`file-tree.ts`** — tree rendering with lazy child loading and search.
- **`viewer-pool.ts`** — the LRU iframe pool (below).
- **`api-impl.ts` + `electron-ipc-transport.ts`** — the platform adapter pair
  that every other platform in this repo already provides.

## Viewer pool

Up to **8 live `<iframe>` elements**, each running the existing
`viewer-embed.html`, keyed by `folderId:filePath`.

All pooled iframes are absolutely positioned and stacked in the preview area.
Inactive ones use `visibility: hidden; pointer-events: none` rather than
`display: none`, so they remain laid out with real dimensions. This matters
because Mermaid sizing, KaTeX layout, and drawio rendering measure their
container; a zero-size container produces broken output.

Each iframe owns its own `createViewerIframeHostBridge` instance.

Eviction rules:

- The active tab is never evictable.
- When the pool is at capacity and a new view is needed, the least recently
  used non-active view is destroyed and removed from the DOM.
- Returning to an evicted tab creates a fresh iframe, re-renders the document,
  and restores the remembered scroll line.

The pool is global across folders rather than per-folder, so a folder left with
a recently used tab usually returns instantly. Switching folders hides one
folder's iframe set and reveals the next folder's; it does not evict.

## Live reload

`createViewerIframeHostBridge.syncDocument()` already distinguishes two cases by
`documentKey`: an unchanged key sends `UPDATE_CONTENT` (in-place, scroll
preserved), a new key sends `OPEN_DOCUMENT` (full render). Live reload uses the
first path.

1. chokidar reports a change to path `P` in folder `F`.
2. The renderer looks up `F:P` in the viewer pool.
3. **Live view** — read the file, call `syncDocument` with the *same*
   `documentKey`. The viewer updates in place and scroll position survives.
4. **Evicted view** — mark the tab dirty; re-read on next activation.
5. **`add` / `unlink`** — patch the single affected tree node. The tree is never
   rebuilt wholesale, so expansion state and scroll survive.

## Error handling

| Case | Behavior |
|---|---|
| Folder deleted or unmounted while open | That folder tab enters an unavailable state with a retry action; other folders are unaffected |
| File deleted while its tab is open | The tab remains and shows a banner; the user decides whether to close it |
| Binary or unreadable file | Reuses the existing `file-type` detection path from `workspace.ts` |
| Watcher fails (fd limits, network volume) | The folder still opens; live reload degrades silently with a notice. A watcher failure never blocks opening a folder. |
| Very large folder or symlink loop | Lazy tree loading plus a depth cap |
| Path escaping the folder root | Rejected in the main process |

## Testing

Matching the repository's existing `node:test` style under `test/`.

**Unit — `workspace-model`**
- Open and close folders; folder tab ordering
- Open and close file tabs; closing the active tab activates its neighbor
- Opening an already-open file activates the existing tab instead of duplicating
- Tab state stays isolated per folder across folder switches
- Tree patching on `add` and `unlink` preserves expansion state

**Unit — `viewer-pool`** (with a fake iframe factory, no Electron)
- Pool cap is enforced at 8
- Eviction selects the least recently used view
- The active view is never evicted
- A tab marked dirty while evicted re-renders on return

**Unit — `workspace-fs`** (against a temp fixture directory)
- Lazy listing returns only supported extensions
- Paths escaping the root are rejected
- Missing and unreadable files return structured errors

**Integration — Playwright `_electron` smoke test**
- Launch the app, open two fixture folders
- Open several file tabs in each
- Switch folders and assert per-folder tab state survived
- Touch a fixture file and assert the open tab live-reloaded

## Out of scope for v1

Deferred deliberately. None are blocked by this architecture.

- Export to DOCX, PDF, or HTML — later this is wiring `src/exporters` into a
  menu, since the exporters already work against the rendered document
- Session restore across relaunch
- Finder file associations and "Open With"
- Editing files
- Windows and Linux builds
- Auto-update
- Multiple app windows
