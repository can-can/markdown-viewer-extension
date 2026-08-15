/**
 * Base Renderer for diagrams and charts
 * 
 * Each renderer handles one diagram type (mermaid, vega, html, svg, etc.)
 * Renderer instances are shared, so container management must be stateless
 */

import type { RendererThemeConfig, RenderResult } from '../types/index';

export class BaseRenderer {
  type: string;
  protected _initialized: boolean = false;

  /**
   * @param type - Render type identifier (e.g., 'mermaid', 'vega')
   */
  constructor(type: string) {
    this.type = type;
  }

  /**
   * Create a new render container element for this render
   * Each render gets its own container to support parallel rendering
   * Caller is responsible for calling removeContainer() after use
   * @returns New render container element
   */
  createContainer(): HTMLDivElement {
    const container = document.createElement('div');
    container.id = 'render-container-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    container.style.cssText = 'position: absolute; left: -9999px; top: -9999px;';
    document.body.appendChild(container);
    return container;
  }

  /**
   * Remove a render container from DOM
   * @param container - Container to remove
   */
  removeContainer(container: HTMLElement): void {
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
  }

  /**
   * Initialize renderer (load dependencies, setup environment)
   * Called once before first render
   * Subclasses can override to perform async initialization
   * @param themeConfig - Theme configuration
   */
  async initialize(themeConfig: RendererThemeConfig | null = null): Promise<void> {
    this._initialized = true;
  }

  /**
   * Check if renderer is initialized
   * @returns True if initialized
   */
  isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Main render method - must be implemented by subclasses
   * @param input - Input data for rendering
   * @param themeConfig - Theme configuration
   * @returns Render result with base64, dimensions, and format, or null if nothing to render
   */
  async render(input: string | object, themeConfig: RendererThemeConfig | null): Promise<RenderResult | null> {
    throw new Error('render() must be implemented by subclass');
  }

  /**
   * Validate input data
   * @param input - Input to validate
   * @throws If input is invalid
   */
  validateInput(input: unknown): void {
    if (!input || (typeof input === 'string' && input.trim() === '')) {
      throw new Error(`Empty ${this.type} input provided`);
    }
  }

  /**
   * Preprocess input before rendering (can be overridden)
   * @param input - Raw input
   * @returns Processed input
   */
  preprocessInput(input: unknown): unknown {
    return input;
  }

  /**
   * Calculate scale for canvas rendering
   * This is used by renderers that render to canvas
   * PNG size will be divided by 4 in DOCX, so we multiply by 4 here
   * Formula: (themeFontSize/12) * 4
   * @param themeConfig - Theme configuration
   * @returns Scale factor for canvas
   */
  calculateCanvasScale(themeConfig: RendererThemeConfig | null): number {
    const baseFontSize = 12;
    const themeFontSize = themeConfig?.fontSize || baseFontSize;
    return (themeFontSize / baseFontSize) * 4.0;
  }

  /**
   * Clamp a canvas scale factor to Chromium's canvas limits. An SVG with a
   * huge natural size (e.g. a 7917×7917 logo icon) times the default scale
   * factor (×4) exceeds the maximum canvas area; after that toDataURL
   * returns an empty data URL ("data:,") and the PNG export silently
   * breaks. The returned scale keeps the final canvas within the limits.
   */
  clampCanvasDimensions(width: number, height: number, scale: number): number {
    const MAX_CANVAS_SIDE = 16384;
    const MAX_CANVAS_AREA = 268_000_000; // Chromium's practical max (~16384²)
    const sideLimit = Math.min(
      MAX_CANVAS_SIDE / Math.max(width, 1),
      MAX_CANVAS_SIDE / Math.max(height, 1),
    );
    const areaLimit = Math.sqrt(MAX_CANVAS_AREA / Math.max(width * height, 1));
    return Math.min(scale, sideLimit, areaLimit);
  }

  /**
   * Render SVG directly to canvas
   * @param svgContent - SVG content string
   * @param width - Canvas width
   * @param height - Canvas height
   * @param fontFamily - Optional font family to set on canvas
   * @returns Canvas element
   */
  async renderSvgToCanvas(svgContent: string, width: number, height: number, fontFamily: string | null = null): Promise<HTMLCanvasElement> {

    svgContent = svgContent.replace(/<style>/, `<style>foreignObject { overflow: visible; }`);

    // Embed loaded web font @font-face rules into SVG so they work in data: URL context.
    // When SVG is rendered as an Image (data: URL), it cannot access page-loaded fonts.
    if (fontFamily && typeof document !== 'undefined' && document.fonts) {
      const fontCss = await this.collectFontFaceCss(fontFamily);
      if (fontCss) {
        svgContent = svgContent.replace(/<style>/, `<style>${fontCss}`);
      }
    }
    
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'Anonymous';

      // Convert SVG to base64
      const base64Svg = btoa(unescape(encodeURIComponent(svgContent)));
      img.src = `data:image/svg+xml;base64,${base64Svg}`;

      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        
        // Set font on canvas context if provided
        if (fontFamily) {
          ctx.font = `14px ${fontFamily}`;
        }
        
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas);
      };

      img.onerror = (e) => {
        reject(new Error('Failed to load SVG into image for rendering'));
      };
    });
  }

  // Cache for inlined font CSS (fontUrl -> inlined CSS with data URIs)
  private static fontCssCache = new Map<string, string>();

  /**
   * Collect @font-face CSS for the given fontFamily by fetching the font CSS URL
   * from the injected <link> stylesheet, then inlining all woff2 references as data URIs.
   * This is necessary because SVG rendered via data: URL cannot access external fonts.
   */
  private async collectFontFaceCss(fontFamily: string): Promise<string> {
    // Find the Google Fonts <link> in document
    const links = document.querySelectorAll('link[rel="stylesheet"]');
    for (const link of links) {
      const href = (link as HTMLLinkElement).href;
      if (!href || !href.includes('fonts.googleapis.com')) continue;

      if (BaseRenderer.fontCssCache.has(href)) {
        return BaseRenderer.fontCssCache.get(href)!;
      }

      try {
        // Fetch Google Fonts CSS — do NOT set custom User-Agent header
        // as it triggers CORS preflight which may fail in mobile WebView.
        // Modern WebViews send a UA that Google Fonts recognises for woff2.
        const resp = await fetch(href);
        if (!resp.ok) continue;
        let css = await resp.text();

        // Replace all url(...) references with inlined base64 data URIs
        const urlPattern = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g;
        const matches = [...css.matchAll(urlPattern)];
        for (const match of matches) {
          try {
            const fontResp = await fetch(match[1]);
            if (!fontResp.ok) continue;
            const blob = await fontResp.blob();
            const dataUri = await this.blobToBase64(blob);
            css = css.replace(match[0], `url(${dataUri})`);
          } catch {
            // Keep original URL if fetch fails
          }
        }

        BaseRenderer.fontCssCache.set(href, css);
        return css;
      } catch {
        // Ignore fetch errors
      }
    }
    return '';
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}
