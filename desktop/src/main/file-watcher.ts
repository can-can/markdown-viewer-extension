import chokidar, { type ChokidarOptions, type FSWatcher } from 'chokidar';
import path from 'node:path';
import { ALL_SUPPORTED_EXTENSIONS } from '../../../src/types/formats.ts';
import type {
  DirEntry,
  FileChangeEvent,
  FileChangeKind,
} from '../../types/ipc.ts';

export const WATCHER_DEBOUNCE_MS = 100;

const SUPPORTED_EXTENSIONS = new Set(
  ALL_SUPPORTED_EXTENSIONS.map((extension) => extension.toLowerCase()),
);

function watchOptions(root: string): ChokidarOptions {
  return {
    // Resolve against the selected root so a folder living below a hidden
    // ancestor is still watchable; only hidden descendants are ignored.
    ignored: (candidate) => {
      const relative = relativeWatchPath(root, candidate);
      if (relative === null || relative === '') return false;
      return relative.split('/').some(
        (segment) => segment.startsWith('.') || segment === 'node_modules',
      );
    },
    ignoreInitial: true,
    persistent: true,
    depth: 12,
    followSymlinks: false,
  };
}

export interface TimerApi {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const systemTimers: TimerApi = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface DebouncedEventSender {
  enqueue(event: FileChangeEvent): void;
  cancel(): void;
}

/**
 * Map an absolute chokidar path to the POSIX-style relative path used by IPC.
 * Returns null for a path outside the watched root.
 */
export function relativeWatchPath(root: string, absolutePath: string): string | null {
  const relative = path.relative(path.resolve(root), path.resolve(absolutePath));
  if (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative.split(path.sep).join('/');
}

export function isSupportedWatchFile(absolutePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(absolutePath).toLowerCase());
}

/** Collapse editor save bursts to the last event for each affected path. */
export function createDebouncedEventSender(
  send: (event: FileChangeEvent) => void,
  timers: TimerApi = systemTimers,
): DebouncedEventSender {
  const pending = new Map<string, { handle: unknown; event: FileChangeEvent }>();

  return {
    enqueue(event) {
      const key = event.relPath;
      const previous = pending.get(key);
      if (previous) timers.clear(previous.handle);

      const item = {
        event,
        handle: timers.set(() => {
          if (pending.get(key) !== item) return;
          pending.delete(key);
          send(item.event);
        }, WATCHER_DEBOUNCE_MS),
      };
      pending.set(key, item);
    },

    cancel() {
      for (const { handle } of pending.values()) timers.clear(handle);
      pending.clear();
    },
  };
}

type WatchFactory = (root: string, options: ChokidarOptions) => FSWatcher;

export interface FileWatcherManager {
  startWatching(
    folderId: string,
    root: string,
    send: (event: FileChangeEvent) => void,
  ): void;
  stopWatching(folderId: string): void;
  stopAllWatchers(): void;
}

interface FileWatcherDependencies {
  watch?: WatchFactory;
  timers?: TimerApi;
  warn?: (message: string, error: unknown) => void;
}

interface WatcherRecord {
  watcher: FSWatcher;
  sender: DebouncedEventSender;
}

export function createFileWatcherManager(
  dependencies: FileWatcherDependencies = {},
): FileWatcherManager {
  const watch = dependencies.watch ?? ((root, options) => chokidar.watch(root, options));
  const timers = dependencies.timers ?? systemTimers;
  const warn = dependencies.warn ?? ((message, error) => console.warn(message, error));
  const watchers = new Map<string, WatcherRecord>();

  function stopWatching(folderId: string): void {
    const record = watchers.get(folderId);
    if (!record) return;

    // Delete first so any late EventEmitter delivery from close() is ignored.
    watchers.delete(folderId);
    record.sender.cancel();
    void record.watcher.close().catch((error) => {
      warn(`[desktop] watcher close failed for ${folderId}:`, error);
    });
  }

  function startWatching(
    folderId: string,
    root: string,
    send: (event: FileChangeEvent) => void,
  ): void {
    stopWatching(folderId);

    const sender = createDebouncedEventSender(send, timers);
    let watcher: FSWatcher;
    try {
      watcher = watch(root, watchOptions(root));
    } catch (error) {
      warn(`[desktop] watcher unavailable for ${root}:`, error);
      send({ folderId, relPath: '', kind: 'watcher-error' });
      return;
    }

    const isCurrent = (): boolean => watchers.get(folderId)?.watcher === watcher;
    const emitPath = (
      kind: Extract<FileChangeKind, 'change' | 'add' | 'unlink'>,
      absolutePath: string,
      entryKind: DirEntry['kind'],
    ): void => {
      if (!isCurrent()) return;
      const relPath = relativeWatchPath(root, absolutePath);
      if (
        relPath === null
        || relPath === ''
        || (entryKind === 'file' && !isSupportedWatchFile(absolutePath))
      ) {
        return;
      }
      sender.enqueue({ folderId, relPath, kind, entryKind });
    };

    let failureReported = false;
    watcher.on('change', (changedPath) => emitPath('change', changedPath, 'file'));
    watcher.on('add', (addedPath) => emitPath('add', addedPath, 'file'));
    watcher.on('unlink', (removedPath) => emitPath('unlink', removedPath, 'file'));
    watcher.on('addDir', (addedPath) => emitPath('add', addedPath, 'directory'));
    watcher.on('unlinkDir', (removedPath) => {
      if (!isCurrent()) return;
      const relPath = relativeWatchPath(root, removedPath);
      if (relPath === null) return;
      if (relPath === '') {
        sender.enqueue({ folderId, relPath, kind: 'folder-unavailable' });
      } else {
        sender.enqueue({ folderId, relPath, kind: 'unlink', entryKind: 'directory' });
      }
    });
    watcher.on('error', (error) => {
      if (!isCurrent()) return;
      warn(`[desktop] watcher error for ${root}:`, error);
      if (failureReported) return;
      failureReported = true;
      send({ folderId, relPath: '', kind: 'watcher-error' });
    });

    watchers.set(folderId, { watcher, sender });
  }

  return {
    startWatching,
    stopWatching,
    stopAllWatchers() {
      for (const folderId of [...watchers.keys()]) stopWatching(folderId);
    },
  };
}

const defaultManager = createFileWatcherManager();

export const startWatching = defaultManager.startWatching;
export const stopWatching = defaultManager.stopWatching;
export const stopAllWatchers = defaultManager.stopAllWatchers;
