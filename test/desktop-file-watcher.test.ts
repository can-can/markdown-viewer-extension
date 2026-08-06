import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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

  close(): Promise<void> {
    this.closeCalls += 1;
    return Promise.resolve();
  }
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
  it('maps file and directory events and filters unsupported files', () => {
    const watcher = new FakeWatcher();
    const timers = new FakeTimers();
    const events: FileChangeEvent[] = [];
    const root = path.resolve('/tmp/docu-watcher-root');
    let options: Record<string, unknown> | undefined;
    const manager = createFileWatcherManager({
      watch: ((_root: string, watchOptions: Record<string, unknown>) => {
        options = watchOptions;
        return watcher;
      }) as never,
      timers,
    });

    manager.startWatching('f1', root, (event) => events.push(event));
    watcher.emit('change', path.join(root, 'README.md'));
    watcher.emit('add', path.join(root, 'notes.txt'));
    watcher.emit('addDir', root);
    watcher.emit('addDir', path.join(root, 'guides'));
    watcher.emit('unlinkDir', root);
    timers.flush();

    assert.deepEqual(events, [
      { folderId: 'f1', relPath: 'README.md', kind: 'change', entryKind: 'file' },
      { folderId: 'f1', relPath: 'guides', kind: 'add', entryKind: 'directory' },
      { folderId: 'f1', relPath: '', kind: 'folder-unavailable' },
    ]);
    assert.equal(options?.ignoreInitial, true);
    assert.equal(options?.depth, 12);
    assert.equal(options?.followSymlinks, false);
    const ignored = options?.ignored as ((candidate: string) => boolean);
    assert.equal(ignored(root), false, 'the selected root itself is never ignored');
    assert.equal(ignored(path.join(root, '.git', 'config')), true);
    assert.equal(ignored(path.join(root, '.draft.md')), true);
  });

  it('reports a watcher error once without stopping normal folder access', () => {
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
    assert.equal(warnings.length, 2, 'every underlying error is still logged');
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

  it('keeps one watcher per folder and cancels the old watcher on replacement', () => {
    const first = new FakeWatcher();
    const second = new FakeWatcher();
    const timers = new FakeTimers();
    const events: FileChangeEvent[] = [];
    const queue = [first, second];
    const root = path.resolve('/tmp/docu-watcher-root');
    const manager = createFileWatcherManager({
      watch: (() => queue.shift()!) as never,
      timers,
    });

    manager.startWatching('f1', root, (event) => events.push(event));
    first.emit('change', path.join(root, 'old.md'));
    manager.startWatching('f1', root, (event) => events.push(event));
    first.emit('change', path.join(root, 'late.md'));
    second.emit('change', path.join(root, 'new.md'));
    timers.flush();

    assert.equal(first.closeCalls, 1);
    assert.deepEqual(events.map((event) => event.relPath), ['new.md']);

    manager.stopAllWatchers();
    assert.equal(second.closeCalls, 1);
  });
});
