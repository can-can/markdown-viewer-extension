/**
 * Desktop Platform API Implementation
 *
 * Electron's viewer iframe is a full Chromium context, so its services run
 * in-process over the same direct transport used by the Obsidian shell. Only
 * workspace file reads leave the iframe, through the existing parent bridge.
 */
import {
  BaseI18nService,
  CacheService,
  StorageService,
  FileService,
  RendererService,
  SettingsService,
  createSettingsService,
} from '../../../src/services/index.ts';

import type { FileState } from '../../../src/types/core.ts';
import type { LocaleMessages } from '../../../src/services/index.ts';
import type { PlatformBridgeAPI } from '../../../src/types/index.ts';
import type { ReadFileOptions } from '../../../src/types/platform.ts';

import { ServiceChannel } from '../../../src/messaging/channels/service-channel.ts';
import { createDirectTransportPair } from '../../../obsidian/src/transports/direct-transport.ts';
import { BaseDocumentService } from '../../../src/services/document-service.ts';
import { IframeRenderHost } from '../../../src/renderers/host/iframe-render-host.ts';

const [hostTransport, webviewTransport] = createDirectTransportPair();
const serviceChannel = new ServiceChannel(webviewTransport, {
  source: 'desktop-renderer',
  timeoutMs: 300_000,
});

const bridge: PlatformBridgeAPI = {
  sendRequest: async <T = unknown>(type: string, payload: unknown): Promise<T> =>
    (await serviceChannel.send(type, payload)) as T,
  postMessage: (type: string, payload: unknown): void => {
    serviceChannel.post(type, payload);
  },
  addListener: (handler: (message: unknown) => void): (() => void) =>
    serviceChannel.onAny((message) => {
      handler(message);
    }),
};

class DesktopResourceService {
  getURL(assetPath: string): string {
    return new URL(assetPath.replace(/^\/+/, ''), window.location.href).toString();
  }

  async fetch(assetPath: string): Promise<string> {
    const response = await window.fetch(this.getURL(assetPath));
    if (!response.ok) throw new Error(`Asset not found: ${assetPath}`);
    return response.text();
  }
}

export class DesktopDocumentService extends BaseDocumentService {
  private workspaceFileReader:
    | ((relativePath: string, binary: boolean) => Promise<string>)
    | null = null;

  setWorkspaceFileReader(
    reader: (relativePath: string, binary: boolean) => Promise<string>,
  ): void {
    this.workspaceFileReader = reader;
  }

  async readFile(absolutePath: string, options?: ReadFileOptions): Promise<string> {
    const response = await serviceChannel.send('READ_LOCAL_FILE', {
      filePath: absolutePath,
      binary: options?.binary,
    });
    return (response as { content: string }).content;
  }

  async readRelativeFile(relativePath: string, options?: ReadFileOptions): Promise<string> {
    if (this.workspaceFileReader) {
      return this.workspaceFileReader(relativePath, options?.binary ?? false);
    }
    return this.readFile(relativePath, options);
  }

  override resolvePath(relativePath: string): string {
    return relativePath;
  }

  override toResourceUrl(absolutePath: string): string {
    return absolutePath;
  }
}

class DesktopI18nService extends BaseI18nService {
  constructor(private readonly resourceService: DesktopResourceService) {
    super();
  }

  async init(): Promise<void> {
    try {
      await this.ensureFallbackMessages();
      this.ready = Boolean(this.fallbackMessages);
    } catch (error) {
      console.warn('[Desktop I18n] init failed:', error);
      this.ready = false;
    }
  }

  async loadLocale(locale: string): Promise<void> {
    try {
      this.messages = await this.fetchLocaleData(locale);
      this.ready = Boolean(this.messages || this.fallbackMessages);
    } catch (error) {
      console.warn('[Desktop I18n] failed to load locale', locale, error);
      this.messages = null;
    }
  }

  async fetchLocaleData(locale: string): Promise<LocaleMessages | null> {
    try {
      return JSON.parse(
        await this.resourceService.fetch(`_locales/${locale}/messages.json`),
      ) as LocaleMessages;
    } catch {
      return null;
    }
  }

  getUILanguage(): string {
    return navigator.language || 'en';
  }
}

class DesktopMessageService {
  async send(message: Record<string, unknown>): Promise<unknown> {
    const { type, payload, id, ...rest } = message;
    const requestId = (id ?? rest.requestId) as string | undefined;
    if (typeof type !== 'string') throw new Error('Message must have a type field');

    try {
      const data = await serviceChannel.send(type, payload ?? rest);
      return { type: 'RESPONSE', requestId: requestId ?? '', ok: true, data };
    } catch (error) {
      return {
        type: 'RESPONSE',
        requestId: requestId ?? '',
        ok: false,
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }

  addListener(handler: (message: unknown) => void): void {
    serviceChannel.onAny(handler);
  }
}

class DesktopFileStateService {
  private readonly states = new Map<string, FileState>();

  async get(url: string): Promise<FileState> {
    return this.states.get(url) || {};
  }

  set(url: string, state: FileState): void {
    this.states.set(url, { ...(this.states.get(url) || {}), ...state });
  }

  async clear(url: string): Promise<void> {
    this.states.delete(url);
  }
}

export class DesktopPlatformAPI {
  public readonly platform = 'desktop' as const;

  public readonly storage: StorageService;
  public readonly file: FileService;
  public readonly fileState: DesktopFileStateService;
  public readonly resource: DesktopResourceService;
  public readonly cache: CacheService;
  public readonly renderer: RendererService;
  public readonly i18n: DesktopI18nService;
  public readonly message: DesktopMessageService;
  public readonly document: DesktopDocumentService;
  public readonly settings: SettingsService;

  constructor() {
    this.storage = new StorageService(serviceChannel);
    this.file = new FileService(serviceChannel);
    this.cache = new CacheService(serviceChannel);
    this.fileState = new DesktopFileStateService();
    this.resource = new DesktopResourceService();
    this.message = new DesktopMessageService();
    this.document = new DesktopDocumentService();
    this.settings = createSettingsService(this.storage);

    this.renderer = new RendererService({
      createHost: () => new IframeRenderHost({
        fetchHtmlContent: async () => this.resource.fetch('iframe-render.html'),
        source: 'desktop-parent',
        serviceRequestHandler: async (type, payload) => {
          if (type === 'FETCH_RESOURCE') {
            return this.resource.fetch((payload as { path: string }).path);
          }
          throw new Error(`Unknown service request type: ${type}`);
        },
      }),
      cache: this.cache,
    });

    this.i18n = new DesktopI18nService(this.resource);
  }

  async init(): Promise<void> {
    await this.cache.init();
    await this.i18n.init();
  }

  setDocumentPath(path: string, baseUri?: string): void {
    this.document.setDocumentPath(path, baseUri);
  }
}

export const desktopPlatform = new DesktopPlatformAPI();
globalThis.platform = desktopPlatform;

export {
  desktopPlatform as platform,
  bridge as desktopBridge,
  hostTransport,
  serviceChannel,
};

export default desktopPlatform;
