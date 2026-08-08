# docu.md Desktop

Electron shell for macOS. It opens multiple local folders as tabs, with a
separate lazy file tree and file-tab row for each folder. Open documents
re-render in place when their files change on disk.

## Develop

```bash
npm run dev:desktop      # build, then launch Electron
npm run build:desktop    # build only → dist/desktop/
npm run package:desktop  # unsigned universal DMG → dist/
```

The package is intentionally unsigned. macOS Gatekeeper may require using
right-click → Open for a local build. Code signing and notarization are not part
of the current desktop release workflow.

## Test

```bash
node --test test/desktop-workspace-fs.test.ts
node --test test/desktop-workspace-model.test.ts
node --test test/desktop-viewer-pool.test.ts
node --test test/desktop-file-watcher.test.ts
npm run build:desktop && node --test test/desktop-smoke.test.ts
```

The first four commands do not launch Electron. The smoke suite drives a fresh
Electron instance for each stateful scenario and needs a current desktop build.

## Architecture

The main process owns filesystem access and a recursive Node filesystem watcher
for every open folder, exposed through the narrow bridge in `types/ipc.ts`. The
renderer owns the pure workspace state and a global LRU pool of viewer iframes
capped at eight. A live file change reuses the existing iframe/document key, so
the shared viewer takes its in-place `UPDATE_CONTENT` path and preserves scroll
position.

Rendering reuses the cross-platform viewer in
`chrome/src/webview/viewer-main.ts`, with the desktop platform implementation
and direct host transport under `src/renderer/`.

See `../specs/2026-08-04-desktop-app-design.md` for the approved design.
