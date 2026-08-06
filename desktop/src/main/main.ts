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
    const target = path.join(DIST_DIR, decodeURIComponent(pathname));
    // Containment: never serve outside the bundled dist directory.
    if (target !== DIST_DIR && !target.startsWith(DIST_DIR + path.sep)) {
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
