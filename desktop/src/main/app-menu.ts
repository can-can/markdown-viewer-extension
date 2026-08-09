// Type-only import. TypeScript erases it, so this module loads under plain
// `node --test`, where the electron module cannot be required. Building the
// real Menu happens in main.ts, which only ever runs inside Electron.
import type { MenuItemConstructorOptions } from 'electron';

export type MenuAction = 'close-tab' | 'next-tab' | 'previous-tab' | 'open-folder';

/**
 * Build the application menu.
 *
 * The app needs its own menu for one reason: macOS binds CmdOrCtrl+W to
 * "Close Window" in the default menu, and a menu accelerator always wins over
 * a keydown handler in the page. Only a menu can take that key back.
 *
 * Two rules hold this together, and both have tests:
 * - `close-tab` is the ONLY owner of CmdOrCtrl+W.
 * - There is no window-close item. Electron's `windowMenu` role includes
 *   Close with CmdOrCtrl+W, so this menu builds the Window entries by hand.
 *
 * The window still closes with the red button and the app still quits with
 * Cmd+Q, which the `appMenu` role provides.
 */
export function buildMenuTemplate(
  send: (action: MenuAction) => void,
): MenuItemConstructorOptions[] {
  const action = (
    id: MenuAction,
    label: string,
    accelerator: string,
  ): MenuItemConstructorOptions => ({
    id,
    label,
    accelerator,
    click: () => send(id),
  });

  return [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        action('open-folder', 'Open Folder…', 'CmdOrCtrl+O'),
        { type: 'separator' },
        action('close-tab', 'Close Tab', 'CmdOrCtrl+W'),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        action('previous-tab', 'Previous Tab', 'CmdOrCtrl+Shift+['),
        action('next-tab', 'Next Tab', 'CmdOrCtrl+Shift+]'),
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      // Built by hand. The windowMenu role would add Close with CmdOrCtrl+W.
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
}

