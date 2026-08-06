/** Host-side handlers for a desktop viewer iframe's direct service channel. */
import { ServiceChannel } from '../../../src/messaging/channels/service-channel.ts';
import { hostTransport } from './api-impl.ts';

export interface HostContext {
  /** Folder against which a workspace-relative file path is resolved. */
  getActiveFolderId(): string | null;
}

interface CacheOperation {
  operation: string;
  key?: string;
  value?: unknown;
  dataType?: string;
}

const STORAGE_PREFIX = 'docu-md:';
const memoryCache = new Map<string, unknown>();

function storageGet(keys: string | string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null) continue;
    try {
      result[key] = JSON.parse(raw);
    } catch {
      result[key] = raw;
    }
  }
  return result;
}

function storageKeys(): string[] {
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(STORAGE_PREFIX)) {
      keys.push(key.slice(STORAGE_PREFIX.length));
    }
  }
  return keys;
}

function handleCacheOperation(payload: CacheOperation): unknown {
  const { operation, key, value } = payload;
  switch (operation) {
    case 'get':
      return key ? (memoryCache.get(key) ?? null) : null;
    case 'set':
      if (!key) return { success: false };
      memoryCache.set(key, value);
      return { success: true };
    case 'delete':
      if (!key) return { success: false };
      memoryCache.delete(key);
      return { success: true };
    case 'clear':
      memoryCache.clear();
      return { success: true };
    case 'getStats': {
      let totalSize = 0;
      const items = [...memoryCache].map(([itemKey, itemValue]) => {
        const size = new Blob([
          typeof itemValue === 'string' ? itemValue : JSON.stringify(itemValue),
        ]).size;
        totalSize += size;
        const now = Date.now();
        return {
          key: itemKey,
          value: itemValue,
          type: 'unknown',
          size,
          timestamp: now,
          accessTime: now,
        };
      });
      return {
        itemCount: memoryCache.size,
        maxItems: 500,
        totalSize,
        totalSizeMB: `${(totalSize / (1024 * 1024)).toFixed(2)} MB`,
        items,
      };
    }
    default:
      return null;
  }
}

function getDesktopBridge(): Window['desktop'] {
  if (window.desktop) return window.desktop;
  return window.parent.desktop;
}

export function createServiceHost(ctx: HostContext): ServiceChannel {
  const channel = new ServiceChannel(hostTransport, {
    source: 'desktop-host',
    timeoutMs: 300_000,
  });

  channel.handle('STORAGE_GET', async (payload) =>
    storageGet((payload as { keys: string | string[] }).keys));

  channel.handle('STORAGE_SET', async (payload) => {
    const { items } = payload as { items: Record<string, unknown> };
    for (const [key, value] of Object.entries(items)) {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    }
    return { success: true };
  });

  channel.handle('STORAGE_REMOVE', async (payload) => {
    const { keys } = payload as { keys: string | string[] };
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      localStorage.removeItem(STORAGE_PREFIX + key);
    }
    return { success: true };
  });

  channel.handle('CACHE_OPERATION', async (payload) =>
    handleCacheOperation(payload as CacheOperation));

  channel.handle('FETCH_ASSET', async (payload) => {
    const { path } = payload as { path: string };
    const url = new URL(path.replace(/^\/+/, ''), window.location.href);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Asset not found: ${path}`);
    return response.text();
  });

  channel.handle('READ_LOCAL_FILE', async (payload) => {
    const { filePath, binary } = payload as { filePath: string; binary?: boolean };
    const folderId = ctx.getActiveFolderId();
    if (!folderId) throw new Error('No active folder');
    return {
      content: await getDesktopBridge().readFile(folderId, filePath, binary ?? false),
    };
  });

  channel.handle('SAVE_SETTING', async (payload) => {
    const { key, value } = (payload ?? {}) as { key: string; value: unknown };
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    return { success: true };
  });

  channel.handle('OPEN_URL', async (payload) => {
    const url = (payload as { url?: string } | null)?.url;
    if (url) window.open(url, '_blank');
    return { success: true };
  });

  channel.handle('OPEN_RELATIVE_FILE', async (payload) => {
    const path = (payload as { path?: string } | null)?.path;
    if (path) window.parent.postMessage({ type: 'WORKSPACE_NAVIGATE', path }, '*');
    return { success: true };
  });

  channel.handle('LOAD_SETTINGS', async () => storageGet(storageKeys()));

  return channel;
}
