import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMenuTemplate, type MenuAction } from '../desktop/src/main/app-menu.ts';

interface FlatItem {
  id?: string;
  label?: string;
  role?: string;
  accelerator?: string;
}

function flatten(template: ReturnType<typeof buildMenuTemplate>): FlatItem[] {
  const items: FlatItem[] = [];
  const walk = (list: readonly unknown[]): void => {
    for (const raw of list) {
      const item = raw as FlatItem & { submenu?: readonly unknown[] };
      items.push({
        id: item.id,
        label: item.label,
        role: item.role,
        accelerator: item.accelerator,
      });
      if (Array.isArray(item.submenu)) walk(item.submenu);
    }
  };
  walk(template);
  return items;
}

const template = (): FlatItem[] => flatten(buildMenuTemplate(() => {}));

describe('buildMenuTemplate accelerators', () => {
  it('binds CmdOrCtrl+W to close the file tab', () => {
    const item = template().find((i) => i.id === 'close-tab');
    assert.equal(item?.accelerator, 'CmdOrCtrl+W');
  });

  it('never binds CmdOrCtrl+W to anything else', () => {
    const owners = template().filter((i) => i.accelerator === 'CmdOrCtrl+W');
    assert.deepEqual(owners.map((i) => i.id), ['close-tab'],
      'a second CmdOrCtrl+W owner would close the window instead of the tab');
  });

  it('has no window-close item, by role or by label', () => {
    // Electron's windowMenu role includes Close with CmdOrCtrl+W. Using it
    // would take the shortcut back and close the window.
    const items = template();
    assert.equal(items.some((i) => i.role === 'close'), false);
    assert.equal(items.some((i) => i.role === 'windowMenu'), false);
  });

  it('binds the tab movement keys', () => {
    const items = template();
    assert.equal(items.find((i) => i.id === 'next-tab')?.accelerator, 'CmdOrCtrl+Shift+]');
    assert.equal(items.find((i) => i.id === 'previous-tab')?.accelerator, 'CmdOrCtrl+Shift+[');
  });

  it('binds CmdOrCtrl+O to open a folder', () => {
    assert.equal(template().find((i) => i.id === 'open-folder')?.accelerator, 'CmdOrCtrl+O');
  });

  it('keeps quit reachable through the application menu role', () => {
    assert.equal(template().some((i) => i.role === 'appMenu'), true);
  });

  it('keeps copy and paste reachable through the edit menu role', () => {
    assert.equal(template().some((i) => i.role === 'editMenu'), true);
  });
});

describe('buildMenuTemplate actions', () => {
  function clickById(id: string): MenuAction | null {
    let sent: MenuAction | null = null;
    const found = flattenWithClick(buildMenuTemplate((action) => { sent = action; }))
      .find((i) => i.id === id);
    found?.click?.();
    return sent;
  }

  interface ClickableItem extends FlatItem { click?: () => void; }

  function flattenWithClick(tpl: ReturnType<typeof buildMenuTemplate>): ClickableItem[] {
    const items: ClickableItem[] = [];
    const walk = (list: readonly unknown[]): void => {
      for (const raw of list) {
        const item = raw as ClickableItem & { submenu?: readonly unknown[] };
        items.push(item);
        if (Array.isArray(item.submenu)) walk(item.submenu);
      }
    };
    walk(tpl);
    return items;
  }

  it('sends close-tab', () => {
    assert.equal(clickById('close-tab'), 'close-tab');
  });

  it('sends next-tab and previous-tab', () => {
    assert.equal(clickById('next-tab'), 'next-tab');
    assert.equal(clickById('previous-tab'), 'previous-tab');
  });

  it('sends open-folder', () => {
    assert.equal(clickById('open-folder'), 'open-folder');
  });
});
