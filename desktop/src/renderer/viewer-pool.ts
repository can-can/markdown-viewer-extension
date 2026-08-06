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
  deactivate(): void;
  acquire(key: string): ViewHandle | null;
  has(key: string): boolean;
  evictFolder(folderId: string): void;
  size(): number;
}

/**
 * Bounded pool of viewer instances, keyed `folderId:relPath`.
 *
 * Deliberately ignorant of the DOM: the view factory is injected, so the
 * eviction policy is testable without Electron. The real factory builds
 * iframes; the tests use plain objects.
 */
export function createViewerPool(options: ViewerPoolOptions): ViewerPool {
  const { capacity, createView } = options;
  // Map preserves insertion order, so the first key is the least recently used
  // as long as every use re-inserts.
  const views = new Map<string, ViewHandle>();
  let activeKey: string | null = null;

  function touch(key: string, view: ViewHandle): void {
    views.delete(key);
    views.set(key, view);
  }

  function evictIfNeeded(): void {
    while (views.size > capacity) {
      let victim: string | null = null;
      for (const key of views.keys()) {
        if (key !== activeKey) { victim = key; break; }
      }
      // Only the active view remains; it is never evictable.
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

    deactivate() {
      if (activeKey) views.get(activeKey)?.setActive(false);
      activeKey = null;
    },

    acquire: (key) => views.get(key) ?? null,

    has: (key) => views.has(key),

    evictFolder(folderId) {
      // Match on the exact id segment so folder 'f1' does not evict 'f10'.
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
