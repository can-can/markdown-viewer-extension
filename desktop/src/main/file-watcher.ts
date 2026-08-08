import {
  stat,
  watch as fsWatch,
  type FSWatcher,
  type WatchListener,
  type WatchOptionsWithStringEncoding,
} from 'node:fs';
import path from 'node:path';
import { ALL_SUPPORTED_EXTENSIONS } from '../../../src/types/formats.ts';
import type { FileChangeEvent } from '../../types/ipc.ts';

export const WATCHER_DEBOUNCE_MS = 100;

const SUPPORTED_EXTENSIONS = new Set(
  ALL_SUPPORTED_EXTENSIONS.map((extension) => extension.toLowerCase()),
);

function isIgnoredWatchPath(root: string, absolutePath: string): boolean {
  // Resolve against the selected root so a folder living below a hidden
  // ancestor is still watchable; only hidden descendants are ignored.
  const relative = relativeWatchPath(root, absolutePath);
  if (relative === null || relative === '') return false;
  return relative.split('/').some(
    (segment) => segment.startsWith('.') || segment === 'node_modules',
  );
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'ENOENT' || error.code === 'ENOTDIR';
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
 * Map an absolute watched path to the POSIX-style relative path used by IPC.
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

type WatchFactory = (
  root: string,
  options: WatchOptionsWithStringEncoding,
  listener: WatchListener<string>,
) => FSWatcher;

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
  const watch = dependencies.watch ?? fsWatch;
  const timers = dependencies.timers ?? systemTimers;
  const warn = dependencies.warn ?? ((message, error) => console.warn(message, error));
  const watchers = new Map<string, WatcherRecord>();

  function stopWatching(folderId: string): void {
    const record = watchers.get(folderId);
    if (!record) return;

    // Delete first so any late EventEmitter delivery from close() is ignored.
    watchers.delete(folderId);
    record.sender.cancel();
    try {
      record.watcher.close();
    } catch (error) {
      warn(`[desktop] watcher close failed for ${folderId}:`, error);
    }
  }

  function startWatching(
    folderId: string,
    root: string,
    send: (event: FileChangeEvent) => void,
  ): void {
    stopWatching(folderId);

    const sender = createDebouncedEventSender(send, timers);
    let watcher: FSWatcher;
    const isCurrent = (): boolean => watchers.get(folderId)?.watcher === watcher;
    let rootUnavailableReported = false;
    const handleWatchEvent: WatchListener<string> = (_eventType, filename) => {
      if (!isCurrent() || filename === null) return;

      if (filename === path.basename(root)) {
        stat(root, (error) => {
          if (
            !isCurrent()
            || rootUnavailableReported
            || !isMissingPathError(error)
          ) {
            return;
          }
          rootUnavailableReported = true;
          sender.enqueue({ folderId, relPath: '', kind: 'folder-unavailable' });
        });
        return;
      }

      const absolutePath = path.resolve(root, filename);
      const relPath = relativeWatchPath(root, absolutePath);
      if (
        relPath === null
        || relPath === ''
        || isIgnoredWatchPath(root, absolutePath)
      ) {
        return;
      }

      stat(absolutePath, (error, stats) => {
        if (!isCurrent()) return;
        if (error) {
          if (isMissingPathError(error)) {
            sender.enqueue({ folderId, relPath, kind: 'unlink' });
          }
          return;
        }
        if (stats.isDirectory()) {
          sender.enqueue({ folderId, relPath, kind: 'add', entryKind: 'directory' });
          return;
        }
        if (stats.isFile() && isSupportedWatchFile(absolutePath)) {
          sender.enqueue({ folderId, relPath, kind: 'change', entryKind: 'file' });
        }
      });
    };

    try {
      watcher = watch(root, { recursive: true, persistent: true }, handleWatchEvent);
    } catch (error) {
      warn(`[desktop] watcher unavailable for ${root}:`, error);
      send({ folderId, relPath: '', kind: 'watcher-error' });
      return;
    }

    let failureReported = false;
    watcher.on('error', (error) => {
      if (!isCurrent() || failureReported) return;
      failureReported = true;
      warn(`[desktop] watcher error for ${root}:`, error);
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
