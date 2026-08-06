// Embedded desktop viewer. Receives documents from the pooled parent iframe
// host and runs the existing Chrome viewer pipeline against the desktop API.

import platform from './api-impl.ts';
import { createServiceHost } from './service-host.ts';
import {
  getViewerMainRuntime,
  startViewer,
} from '../../../chrome/src/webview/viewer-main.ts';
import { initializeViewerBase } from '../../../src/core/viewer/viewer-bootstrap.ts';
import { loadAndApplyTheme } from '../../../src/utils/theme-to-css.ts';
import { applyCodeViewPresentation } from '../../../src/utils/code-preview.ts';
import { createWorkspaceEmbedBridge } from '../../../chrome/src/workspace/workspace-embed-bridge.ts';
import {
  createWorkspaceEmbedHostUiController,
  TOC_NAVIGATION_SCROLL_BEHAVIOR,
} from '../../../chrome/src/workspace/workspace-embed-host-ui.ts';
import { createWorkspaceEmbedParentBridge } from '../../../chrome/src/workspace/workspace-embed-parent-bridge.ts';
import type {
  ViewerIframeMessage,
  ViewerOpenDocumentMessage,
  ViewerUpdateContentMessage,
} from '../../../src/integration/iframe-viewer-host.ts';

type DocumentMessage = ViewerOpenDocumentMessage | ViewerUpdateContentMessage;

const viewerParams = new URLSearchParams(window.location.search);
const folderId = viewerParams.get('folderId');

// A direct transport only connects objects in one JavaScript context. Each
// pooled iframe therefore owns both ends, exactly as Obsidian does in its
// single bundled context; workspace reads still cross the parent bridge.
createServiceHost({ getActiveFolderId: () => folderId });
const platformReady = platform.init();

let initialized = false;
const EMBED_MODE = viewerParams.get('embed') === '1';

const workspaceEmbedBridge = createWorkspaceEmbedBridge({
  documentService: platform.document,
  postToParent: (message) => {
    window.parent.postMessage(message, '*');
  },
});

const parentBridge = createWorkspaceEmbedParentBridge({
  getRuntime: () => getViewerMainRuntime(),
  postToParent: (message) => {
    window.parent.postMessage(message, '*');
  },
  ensureWorkspaceResolvers: () => {
    workspaceEmbedBridge.ensureConnected();
  },
  scrollToAnchor,
});

const hostUiController = createWorkspaceEmbedHostUiController({
  scrollToAnchor,
  applyTheme: (themeId) => {
    const runtime = getViewerMainRuntime();
    if (runtime) return runtime.setTheme(themeId);
    return loadAndApplyTheme(themeId);
  },
});

async function waitForViewerMainRuntime(): Promise<
  NonNullable<ReturnType<typeof getViewerMainRuntime>>
> {
  const runtime = getViewerMainRuntime();
  if (runtime) return runtime;

  for (let attempt = 0; attempt < 24; attempt += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    const nextRuntime = getViewerMainRuntime();
    if (nextRuntime) return nextRuntime;
  }

  throw new Error('[viewer-embed] viewer runtime not initialized');
}

if (EMBED_MODE) {
  document.body.dataset.mvEmbed = '1';

  const style = document.createElement('style');
  style.id = 'embed-mode-styles';
  style.textContent = [
    '#page-header { display: none !important; }',
    '#table-of-contents { top: 0 !important; height: 100vh !important; }',
    'body.toc-hidden #markdown-wrapper { margin-left: 0 !important; margin-right: 0 !important; }',
    'body:not(.toc-hidden) #markdown-wrapper { margin-left: 280px !important; margin-right: 0 !important; }',
    'body.toc-position-right:not(.toc-hidden) #markdown-wrapper { margin-left: 0 !important; margin-right: 280px !important; }',
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);
}

(function restorePendingOpenDocument() {
  try {
    const raw = sessionStorage.getItem('mv:pendingOpen');
    if (!raw) return;
    sessionStorage.removeItem('mv:pendingOpen');
    const message = JSON.parse(raw) as ViewerOpenDocumentMessage;
    if (message && typeof message.content === 'string') {
      void handleDocumentMessage(message, 'open');
    }
  } catch {
    // Malformed JSON or blocked storage: ignore the stale pending document.
  }
})();

function scrollToAnchor(anchor: string): void {
  const normalized = decodeURIComponent(anchor || '').replace(/^#/, '').trim();
  if (!normalized) return;

  const target = document.getElementById(normalized);
  if (!target) return;

  const wrapper = document.getElementById('markdown-wrapper') as HTMLElement | null;
  if (!wrapper) {
    target.scrollIntoView({
      behavior: TOC_NAVIGATION_SCROLL_BEHAVIOR,
      block: 'start',
    });
    return;
  }
  const containerRect = wrapper.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const top = targetRect.top - containerRect.top + wrapper.scrollTop;
  wrapper.scrollTo({
    top: Math.max(0, top),
    behavior: TOC_NAVIGATION_SCROLL_BEHAVIOR,
  });
}

function normalizeTargetLine(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.floor(value));
}

function applyOpenDocumentMetadata(message: ViewerOpenDocumentMessage): void {
  const filename = String(message.filename || 'inline.md');
  const workspaceName = String(message.workspaceName || '');
  const workspaceFilePath = String(message.workspaceFilePath || '');
  const codeView = Boolean(message.codeView);

  document.documentElement.dataset.viewerFilename = filename;
  if (workspaceName && workspaceFilePath) {
    document.documentElement.dataset.viewerWorkspaceName = workspaceName;
    document.documentElement.dataset.viewerWorkspaceFilePath = workspaceFilePath;
  } else {
    delete document.documentElement.dataset.viewerWorkspaceName;
    delete document.documentElement.dataset.viewerWorkspaceFilePath;
  }

  const imagePreviewExtensions = /\.(svg|png|jpe?g|gif|webp|bmp|ico|tiff?|avif)\.(md|markdown)$/i;
  const tocEnabled = /\.(md|markdown)$/i.test(filename)
    && !/\.slides\.md$/i.test(filename)
    && !imagePreviewExtensions.test(filename);
  if (tocEnabled) {
    delete document.documentElement.dataset.tocDisabled;
    const toc = document.getElementById('table-of-contents');
    const overlay = document.getElementById('toc-overlay');
    if (toc) {
      toc.style.display = '';
      toc.classList.remove('hidden');
    }
    overlay?.classList.remove('hidden');
    document.body.classList.remove('toc-hidden');
  } else {
    document.documentElement.dataset.tocDisabled = '1';
    const toc = document.getElementById('table-of-contents');
    const overlay = document.getElementById('toc-overlay');
    if (toc) {
      toc.style.display = 'none';
      toc.classList.add('hidden');
    }
    overlay?.classList.add('hidden');
    document.body.classList.add('toc-hidden');
  }

  applyCodeViewPresentation(codeView);
  const fileName = document.getElementById('file-name');
  if (fileName) fileName.textContent = filename;
  document.title = filename;
}

async function ensureViewerInitialized(initialContent: string): Promise<{
  runtime: NonNullable<ReturnType<typeof getViewerMainRuntime>>;
  wasInitialized: boolean;
}> {
  const wasInitialized = initialized;

  if (!initialized) {
    await platformReady;
    document.body.textContent = initialContent;
    await initializeViewerBase(platform).then((pluginRenderer) => {
      startViewer({
        platform,
        pluginRenderer,
        themeConfigRenderer: platform.renderer,
      });
      initialized = true;
      hostUiController.attachWrapperInteractionFixes();
    }).catch((error) => {
      console.error('[viewer-embed] viewer base init failed', error);
    });
  }

  return {
    runtime: await waitForViewerMainRuntime(),
    wasInitialized,
  };
}

function applyTargetLine(
  runtime: NonNullable<ReturnType<typeof getViewerMainRuntime>>,
  targetLine: number | undefined,
): void {
  if (targetLine !== undefined) runtime.setScrollLine(targetLine);
}

async function handleDocumentMessage(
  message: DocumentMessage,
  mode: 'open' | 'update',
): Promise<void> {
  const content = String(message.content || '');
  const targetLine = normalizeTargetLine(message.targetLine);

  if (mode === 'open') applyOpenDocumentMetadata(message as ViewerOpenDocumentMessage);

  const { runtime, wasInitialized } = await ensureViewerInitialized(content);

  if (mode === 'open') {
    if (wasInitialized) {
      const filename = (message as ViewerOpenDocumentMessage).filename || '';
      const isSlides = /\.slides\.md$/i.test(filename);
      const cameFromSlidev = document.documentElement.dataset.slidevActive === '1';

      if (isSlides) {
        await runtime.renderSlidev(content);
      } else if (cameFromSlidev) {
        try {
          sessionStorage.setItem('mv:pendingOpen', JSON.stringify(message));
        } catch {
          // Continue with the reload even if session storage is unavailable.
        }
        window.location.reload();
        return;
      } else {
        await runtime.openDocument(content, { scrollLine: targetLine });
      }
    }
  } else {
    await runtime.updateContent(content, targetLine);
  }

  applyTargetLine(runtime, targetLine);
  parentBridge.prepareWorkspaceResolvers();
  hostUiController.applyAfterRender();
  parentBridge.notifyViewerRendered();
}

function handleViewerMessage(data: ViewerIframeMessage): void {
  switch (data.type) {
    case 'OPEN_DOCUMENT':
      void handleDocumentMessage(data, 'open');
      return;
    case 'UPDATE_CONTENT':
      void handleDocumentMessage(data, 'update');
      return;
    case 'SYNC_HOST_UI':
      hostUiController.syncHostUi(data);
      return;
    case 'SYNC_HOST_NAVIGATION':
      parentBridge.syncHostNavigation(data);
      return;
    default:
      return;
  }
}

parentBridge.bindViewerMessages(handleViewerMessage);

document.addEventListener('click', (event) => {
  const anchor = (event.target as HTMLElement).closest?.('a');
  if (!anchor) return;

  const href = anchor.getAttribute('href');
  if (!href || href.startsWith('#')) return;

  event.preventDefault();
  if (/^[a-z][a-z0-9+\-.]*:/i.test(href)) {
    window.open(href, '_blank');
    return;
  }
  window.parent.postMessage({ type: 'WORKSPACE_NAVIGATE', path: href }, '*');
});

workspaceEmbedBridge.ensureConnected();
parentBridge.notifyViewerReady();
