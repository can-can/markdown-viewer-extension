import { createViewerIframeHostBridge } from '../../../src/integration/iframe-viewer-host.ts';
import type { SyncInput, ViewHandle } from './viewer-pool.ts';

const VIEWER_URL = new URL('viewer-embed.html', window.location.href).toString();

type ViewerChildMessage =
  | { type: 'VIEWER_READY' | 'VIEWER_RENDERED' }
  | { type: 'RESOLVE_IMAGE'; src: string; id: number }
  | { type: 'RESOLVE_FILE'; path: string; id: number; binary: boolean }
  | { type: 'WORKSPACE_NAVIGATE'; path: string };

function resolveWorkspacePath(documentPath: string, requestedPath: string): string {
  const withoutFragment = requestedPath.split('#', 1)[0].split('?', 1)[0];
  let decoded = withoutFragment;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    // Leave malformed URI escapes untouched and let the filesystem report it.
  }

  const segments = decoded.startsWith('/')
    ? []
    : documentPath.split('/').slice(0, -1).filter(Boolean);

  for (const segment of decoded.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }

  return segments.join('/');
}

function imageMimeType(filePath: string): string {
  const extension = filePath.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'svg': return 'image/svg+xml';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'bmp': return 'image/bmp';
    case 'ico': return 'image/x-icon';
    case 'tif':
    case 'tiff': return 'image/tiff';
    case 'avif': return 'image/avif';
    default: return 'image/png';
  }
}

export function createIframeView(
  host: HTMLElement,
  folderId: string,
  relPath: string,
  key: string,
): ViewHandle {
  const iframe = document.createElement('iframe');
  iframe.dataset.viewKey = key;
  iframe.dataset.active = 'false';
  iframe.src = `${VIEWER_URL}?folderId=${encodeURIComponent(folderId)}`;
  host.append(iframe);

  const bridge = createViewerIframeHostBridge((message) => {
    iframe.contentWindow?.postMessage(message, '*');
  });

  let ready = false;
  const queue: SyncInput[] = [];

  function push(input: SyncInput): void {
    bridge.syncDocument({
      documentKey: key,
      content: input.content,
      filename: input.filename,
      workspaceName: input.workspaceName,
      workspaceFilePath: input.workspaceFilePath,
      targetLine: input.scrollLine,
    });
  }

  async function handleFileRequest(
    id: number,
    requestedPath: string,
    binary: boolean,
  ): Promise<void> {
    try {
      const resolvedPath = resolveWorkspacePath(relPath, requestedPath);
      const content = await window.desktop.readFile(folderId, resolvedPath, binary);
      iframe.contentWindow?.postMessage({ type: 'FILE_RESOLVED', id, content }, '*');
    } catch (error) {
      iframe.contentWindow?.postMessage({
        type: 'FILE_RESOLVED',
        id,
        error: error instanceof Error ? error.message : String(error),
      }, '*');
    }
  }

  async function handleImageRequest(id: number, src: string): Promise<void> {
    try {
      const resolvedPath = resolveWorkspacePath(relPath, src);
      const content = await window.desktop.readFile(folderId, resolvedPath, true);
      const url = `data:${imageMimeType(resolvedPath)};base64,${content}`;
      iframe.contentWindow?.postMessage({ type: 'IMAGE_RESOLVED', id, url }, '*');
    } catch (error) {
      console.warn('[desktop viewer] failed to resolve image', src, error);
    }
  }

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== iframe.contentWindow) return;
    const message = event.data as ViewerChildMessage | undefined;
    if (!message || typeof message !== 'object' || !('type' in message)) return;

    switch (message.type) {
      case 'VIEWER_READY':
        ready = true;
        for (const pending of queue.splice(0)) push(pending);
        return;
      case 'RESOLVE_FILE':
        void handleFileRequest(message.id, message.path, message.binary);
        return;
      case 'RESOLVE_IMAGE':
        void handleImageRequest(message.id, message.src);
        return;
      case 'WORKSPACE_NAVIGATE':
        host.dispatchEvent(new CustomEvent('desktop-viewer-navigate', {
          bubbles: true,
          detail: {
            folderId,
            relPath: resolveWorkspacePath(relPath, message.path),
          },
        }));
        return;
      default:
        return;
    }
  };
  window.addEventListener('message', onMessage);

  return {
    key,
    setActive(active: boolean): void {
      iframe.dataset.active = String(active);
    },
    sync(input: SyncInput): void {
      if (ready) push(input);
      else queue.push(input);
    },
    destroy(): void {
      window.removeEventListener('message', onMessage);
      bridge.reset();
      iframe.remove();
    },
  };
}
