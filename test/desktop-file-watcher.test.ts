import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  WATCHER_DEBOUNCE_MS,
  createDebouncedEventSender,
  createFileWatcherManager,
  isSupportedWatchFile,
  relativeWatchPath,
  type TimerApi,
} from '../desktop/src/main/file-watcher.ts';
import type { FileChangeEvent } from '../desktop/types/ipc.ts';

class FakeTimers implements TimerApi {
  private nextId = 0;
  readonly callbacks = new Map<number, () => void>();
  readonly delays: number[] = [];

  set(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.callbacks.set(id, callback);
    this.delays.push(delayMs);
    return id;
  }

  clear(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  flush(): void {
    for (const [id, callback] of [...this.callbacks]) {
      this.callbacks.delete(id);
      callback();
    }
  }
}

class FakeWatcher extends EventEmitter {
  closeCalls = 0;

  close(): void {
    this.closeCalls += 1;
  }
}

type FakeWatchListener = (
  eventType: 'rename' | 'change',
  filename: string | null,
) => void;

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('timed out waiting for asynchronous watcher handling');
}

describe('watcher path mapping', () => {
  it('maps paths inside the root to POSIX-style relative paths', () => {
    const root = path.resolve('/tmp/docu-watcher-root');
    assert.equal(
      relativeWatchPath(root, path.join(root, 'nested', 'README.md')),
      'nested/README.md',
    );
    assert.equal(relativeWatchPath(root, root), '');
  });

  it('rejects paths outside the watched root, including prefix siblings', () => {
    const root = path.resolve('/tmp/docu-watcher-root');
    assert.equal(relativeWatchPath(root, path.resolve('/tmp/elsewhere/file.md')), null);
    assert.equal(relativeWatchPath(root, `${root}-other/file.md`), null);
  });

  it('recognises the same supported file extensions as the workspace listing', () => {
    assert.equal(isSupportedWatchFile('/tmp/README.MD'), true);
    assert.equal(isSupportedWatchFile('/tmp/diagram.mermaid'), true);
    assert.equal(isSupportedWatchFile('/tmp/notes.txt'), false);
  });
});

describe('watcher debounce', () => {
  it('collapses a save burst to the last event for a path', () => {
    const timers = new FakeTimers();
    const events: FileChangeEvent[] = [];
    const sender = createDebouncedEventSender((event) => events.push(event), timers);

    sender.enqueue({ folderId: 'f1', relPath: 'README.md', kind: 'unlink', entryKind: 'file' });
    sender.enqueue({ folderId: 'f1', relPath: 'README.md', kind: 'add', entryKind: 'file' });

    assert.equal(timers.callbacks.size, 1);
    assert.deepEqual(timers.delays, [WATCHER_DEBOUNCE_MS, WATCHER_DEBOUNCE_MS]);
    timers.flush();
    assert.deepEqual(events, [
      { folderId: 'f1', relPath: 'README.md', kind: 'add', entryKind: 'file' },
    ]);
  });

  it('keeps independent paths independently debounced', () => {
    const timers = new FakeTimers();
    const events: FileChangeEvent[] = [];
    const sender = createDebouncedEventSender((event) => events.push(event), timers);

    sender.enqueue({ folderId: 'f1', relPath: 'a.md', kind: 'change' });
    sender.enqueue({ folderId: 'f1', relPath: 'b.md', kind: 'change' });
    timers.flush();

    assert.deepEqual(events.map((event) => event.relPath), ['a.md', 'b.md']);
  });

  it('cancels pending delivery when its watcher stops', () => {
    const timers = new FakeTimers();
    const events: FileChangeEvent[] = [];
    const sender = createDebouncedEventSender((event) => events.push(event), timers);
    sender.enqueue({ folderId: 'f1', relPath: 'README.md', kind: 'change' });

    sender.cancel();
    timers.flush();
    assert.deepEqual(events, []);
  });
});

describe('file watcher manager', () => {
  it('starts one persistent recursive watcher with the callback API', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'docu-watcher-'));
    const watcher = new FakeWatcher();
    let watchedRoot: string | undefined;
    let options: Record<string, unknown> | undefined;
    let listener: FakeWatchListener | undefined;
    const manager = createFileWatcherManager({
      watch: ((candidateRoot: string, watchOptions: Record<string, unknown>, callback: FakeWatchListener) => {
        watchedRoot = candidateRoot;
        options = watchOptions;
        listener = callback;
        return watcher;
      }) as never,
    });

    try {
      manager.startWatching('f1', root, () => {});
      assert.equal(watchedRoot, root);
      assert.deepEqual(options, { recursive: true, persistent: true });
      assert.equal(typeof listener, 'function');
    } finally {
      manager.stopAllWatchers();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses stat to map relative file and directory events', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'docu-watcher-'));
    await mkdir(path.join(root, 'guides'));
    await writeFile(path.join(root, 'guides', 'README.md'), '# Guide');
    const watcher = new FakeWatcher();
    const timers = new FakeTimers();
    const events: FileChangeEvent[] = [];
    let listener: FakeWatchListener = () => {};
    const manager = createFileWatcherManager({
      watch: ((_root: string, _options: unknown, callback: FakeWatchListener) => {
        listener = callback;
        return watcher;
      }) as never,
      timers,
    });

    try {
      manager.startWatching('f1', root, (event) => events.push(event));
      listener('rename', 'guides');
      listener('rename', 'guides/README.md');
      await waitFor(() => timers.callbacks.size === 2);
      timers.flush();

      assert.deepEqual(events, [
        { folderId: 'f1', relPath: 'guides', kind: 'add', entryKind: 'directory' },
        { folderId: 'f1', relPath: 'guides/README.md', kind: 'change', entryKind: 'file' },
      ]);
    } finally {
      manager.stopAllWatchers();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores null, the existing root basename, unsupported files, and ignored segments', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'docu-watcher-'));
    await mkdir(path.join(root, '.git'));
    await mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, 'notes.txt'), 'unsupported');
    await writeFile(path.join(root, '.git', 'README.md'), 'hidden');
    await writeFile(path.join(root, 'node_modules', 'README.md'), 'dependency');
    const watcher = new FakeWatcher();
    const timers = new FakeTimers();
    const events: FileChangeEvent[] = [];
    let listener: FakeWatchListener = () => {};
    const manager = createFileWatcherManager({
      watch: ((_root: string, _options: unknown, callback: FakeWatchListener) => {
        listener = callback;
        return watcher;
      }) as never,
      timers,
    });

    try {
      manager.startWatching('f1', root, (event) => events.push(event));
      listener('change', null);
      listener('change', path.basename(root));
      listener('rename', 'notes.txt');
      listener('rename', '.git/README.md');
      listener('rename', 'node_modules/README.md');
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      timers.flush();

      assert.deepEqual(events, []);
    } finally {
      manager.stopAllWatchers();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('maps a missing path to unlink without an entry kind', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'docu-watcher-'));
    const watcher = new FakeWatcher();
    const timers = new FakeTimers();
    const events: FileChangeEvent[] = [];
    let listener: FakeWatchListener = () => {};
    const manager = createFileWatcherManager({
      watch: ((_root: string, _options: unknown, callback: FakeWatchListener) => {
        listener = callback;
        return watcher;
      }) as never,
      timers,
    });

    try {
      manager.startWatching('f1', root, (event) => events.push(event));
      listener('rename', 'removed/README.md');
      await waitFor(() => timers.callbacks.size === 1);
      timers.flush();

      assert.deepEqual(events, [
        { folderId: 'f1', relPath: 'removed/README.md', kind: 'unlink' },
      ]);
    } finally {
      manager.stopAllWatchers();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports root deletion once from its basename event', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'docu-watcher-'));
    const watcher = new FakeWatcher();
    const timers = new FakeTimers();
    const events: FileChangeEvent[] = [];
    let listener: FakeWatchListener = () => {};
    const manager = createFileWatcherManager({
      watch: ((_root: string, _options: unknown, callback: FakeWatchListener) => {
        listener = callback;
        return watcher;
      }) as never,
      timers,
    });

    try {
      manager.startWatching('f1', root, (event) => events.push(event));
      await rm(root, { recursive: true });
      listener('change', path.basename(root));
      await waitFor(() => timers.callbacks.size === 1);
      timers.flush();
      listener('change', path.basename(root));
      await new Promise<void>((resolve) => setImmediate(resolve));
      timers.flush();

      assert.deepEqual(events, [
        { folderId: 'f1', relPath: '', kind: 'folder-unavailable' },
      ]);
    } finally {
      manager.stopAllWatchers();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports and logs a watcher error once without stopping normal folder access', () => {
    const watcher = new FakeWatcher();
    const events: FileChangeEvent[] = [];
    const warnings: string[] = [];
    const manager = createFileWatcherManager({
      watch: (() => watcher) as never,
      warn: (message) => warnings.push(message),
    });

    manager.startWatching('f1', '/tmp/docs', (event) => events.push(event));
    watcher.emit('error', new Error('EMFILE'));
    watcher.emit('error', new Error('still failing'));

    assert.deepEqual(events, [{ folderId: 'f1', relPath: '', kind: 'watcher-error' }]);
    assert.equal(warnings.length, 1);
  });

  it('reports a synchronous watcher startup failure', () => {
    const events: FileChangeEvent[] = [];
    const manager = createFileWatcherManager({
      watch: (() => { throw new Error('watch unavailable'); }) as never,
      warn: () => {},
    });

    manager.startWatching('f1', '/tmp/docs', (event) => events.push(event));
    assert.deepEqual(events, [{ folderId: 'f1', relPath: '', kind: 'watcher-error' }]);
  });

  it('keeps one watcher per folder and cancels the old watcher on replacement', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'docu-watcher-'));
    await writeFile(path.join(root, 'old.md'), 'old');
    await writeFile(path.join(root, 'late.md'), 'late');
    await writeFile(path.join(root, 'new.md'), 'new');
    const first = new FakeWatcher();
    const second = new FakeWatcher();
    const timers = new FakeTimers();
    const events: FileChangeEvent[] = [];
    const queue = [first, second];
    const listeners: FakeWatchListener[] = [];
    const manager = createFileWatcherManager({
      watch: ((_root: string, _options: unknown, callback: FakeWatchListener) => {
        listeners.push(callback);
        return queue.shift()!;
      }) as never,
      timers,
    });

    try {
      manager.startWatching('f1', root, (event) => events.push(event));
      listeners[0]('change', 'old.md');
      await waitFor(() => timers.callbacks.size === 1);
      manager.startWatching('f1', root, (event) => events.push(event));
      listeners[0]('change', 'late.md');
      listeners[1]('change', 'new.md');
      await waitFor(() => timers.callbacks.size === 1);
      timers.flush();

      assert.equal(first.closeCalls, 1);
      assert.deepEqual(events.map((event) => event.relPath), ['new.md']);

      manager.stopAllWatchers();
      assert.equal(second.closeCalls, 1);
    } finally {
      manager.stopAllWatchers();
      await rm(root, { recursive: true, force: true });
    }
  });
});
