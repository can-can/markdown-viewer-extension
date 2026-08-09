import mermaid from 'mermaid';

import { exportToHtml } from '../exporters/html-exporter';
import { renderMarkdownDocument, resetDocument } from '../core/viewer/viewer-controller';
import { handleRender, initRenderEnvironment } from '../renderers/render-worker-core';
import { loadAndApplyTheme } from '../utils/theme-to-css';
import type { DocumentService, PlatformAPI } from '../types/platform';
import type { RendererThemeConfig } from '../types/render';

type FrontmatterDisplay = 'hide' | 'table' | 'raw';

export interface CliBrowserRenderRequest {
  markdown: string;
  filename: string;
  title?: string;
  theme?: string;
  language?: string;
  frontmatterDisplay?: FrontmatterDisplay;
  tableMergeEmpty?: boolean;
  tableLayout?: 'left' | 'center' | 'center-full-width';
  documentPath: string;
  documentDir: string;
  documentBaseUrl: string;
  fileReadUrl: string;
  resourceBaseUrl: string;
}

type CliBrowserApi = {
  render(request: CliBrowserRenderRequest): Promise<string>;
};

declare global {
  interface Window {
    markdownCli: CliBrowserApi;
    mermaid: typeof mermaid;
  }
}

window.mermaid = mermaid;
initRenderEnvironment();

let rendererThemeConfig: RendererThemeConfig | null = null;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function createDocumentService(request: CliBrowserRenderRequest): DocumentService {
  const readResponse = async (url: string, binary = false): Promise<string> => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Unable to read resource (${response.status}): ${url}`);
    }
    if (!binary) return response.text();
    return bytesToBase64(new Uint8Array(await response.arrayBuffer()));
  };

  const relativeUrl = (relativePath: string): string => {
    const normalized = normalizeRelativePath(relativePath);
    return new URL(normalized, `${request.documentBaseUrl}/`).href;
  };

  return {
    documentPath: request.documentPath,
    documentDir: request.documentDir,
    baseUrl: request.documentBaseUrl,
    needsUriRewrite: false,
    readFile: async (filePath, options) => {
      if (!/^(?:file:|[a-zA-Z]:[\\/]|\/)/.test(filePath)) {
        return readResponse(relativeUrl(filePath), options?.binary);
      }
      const url = new URL(request.fileReadUrl);
      url.searchParams.set('path', filePath);
      return readResponse(url.href, options?.binary);
    },
    readRelativeFile: (relativePath, options) => readResponse(relativeUrl(relativePath), options?.binary),
    resolvePath: (relativePath) => normalizeRelativePath(relativePath),
    toResourceUrl: (filePath) => {
      if (/^(?:file:|[a-zA-Z]:[\\/]|\/)/.test(filePath)) {
        const url = new URL(request.fileReadUrl);
        url.searchParams.set('path', filePath);
        return url.href;
      }
      return relativeUrl(filePath);
    },
    setDocumentPath: () => {},
  };
}

function configurePlatform(request: CliBrowserRenderRequest): DocumentService {
  const documentService = createDocumentService(request);
  const resourceBaseUrl = new URL(request.resourceBaseUrl);

  const renderer = {
    async init(): Promise<void> {},
    setThemeConfig(config: RendererThemeConfig): void {
      rendererThemeConfig = config;
    },
    getThemeConfig(): RendererThemeConfig | null {
      return rendererThemeConfig;
    },
    render(type: string, content: string | object) {
      return handleRender({ renderType: type, input: content, themeConfig: rendererThemeConfig });
    },
  };

  globalThis.platform = {
    platform: 'chrome',
    renderer,
    resource: {
      getURL: (resourcePath: string) => new URL(resourcePath, resourceBaseUrl).href,
      fetch: async (resourcePath: string) => {
        const response = await fetch(new URL(resourcePath, resourceBaseUrl));
        if (!response.ok) throw new Error(`Unable to fetch ${resourcePath}: ${response.status}`);
        return response.text();
      },
    },
    settings: {
      get: async (key: string) => key === 'firstLineIndent' ? 0 : undefined,
      set: async () => {},
    },
    document: documentService,
  } as unknown as PlatformAPI;

  return documentService;
}

async function render(request: CliBrowserRenderRequest): Promise<string> {
  const markdownContent = document.getElementById('markdown-content');
  const markdownPage = document.getElementById('markdown-page');
  if (!(markdownContent instanceof HTMLElement) || !(markdownPage instanceof HTMLElement)) {
    throw new Error('CLI renderer page is missing its Markdown containers');
  }

  resetDocument();
  markdownContent.replaceChildren();
  rendererThemeConfig = null;

  const documentService = configurePlatform(request);
  document.documentElement.lang = request.language || 'en';
  document.title = request.title || request.filename;

  await loadAndApplyTheme(request.theme || 'default');

  markdownContent.classList.remove(
    'table-layout-left',
    'table-layout-center',
    'table-layout-center-full-width',
  );
  markdownContent.classList.add(`table-layout-${request.tableLayout || 'center'}`);

  const result = await renderMarkdownDocument({
    markdown: request.markdown,
    container: markdownContent,
    renderer: globalThis.platform!.renderer,
    translate: (key) => key,
    frontmatterDisplay: request.frontmatterDisplay || 'hide',
    tableMergeEmpty: request.tableMergeEmpty ?? false,
    tableLayout: request.tableLayout || 'center',
  });

  await result.taskManager.processAll();
  await document.fonts?.ready;

  const exported = await exportToHtml({
    container: markdownPage,
    filename: request.filename,
    title: request.title || result.title || request.filename,
    documentService,
    includeKatexCdn: true,
  });

  if (!exported.success || !exported.html) {
    throw new Error(exported.error || 'HTML export failed');
  }
  return exported.html;
}

window.markdownCli = { render };
