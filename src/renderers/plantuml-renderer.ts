/**
 * PlantUML Renderer
 * 
 * Renders PlantUML diagrams to PNG images.
 * Uses @markdown-viewer/draw-uml to convert PlantUML DSL to DrawIO XML,
 * then @markdown-viewer/drawio2svg to convert DrawIO XML to SVG.
 */
import { BaseRenderer } from './base-renderer';
import { textToDrawioXml } from '@markdown-viewer/draw-uml';
import { convert } from '@markdown-viewer/drawio2svg';
import { applyRoughEffect, type RoughSvgOptions } from './libs/rough-svg';
import { getStencilsService } from '../services/stencils-service';
import type { RendererThemeConfig, RenderResult } from '../types/index';

interface DrawUmlThemeOptions {
  mode?: 'light' | 'dark';
  fontSize?: number;
  fontFamily?: string;
}

/**
 * Extract stencil group names from DrawIO XML
 */
function extractStencilGroups(xml: string): string[] {
  const groups = new Set<string>();
  const regex = /shape=["']?mxgraph\.([a-zA-Z0-9_]+)\./g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    let group = match[1];
    if (group === 'ios7ui') {
      group = 'ios7';
    }
    groups.add(group);
  }
  return Array.from(groups);
}

function buildDrawUmlTheme(themeConfig: RendererThemeConfig | null): DrawUmlThemeOptions | undefined {
  if (!themeConfig) return undefined;

  const theme: DrawUmlThemeOptions = {};

  if (themeConfig.colorSchema === 'dark') {
    theme.mode = 'dark';
  } else if (themeConfig.colorSchema === 'light') {
    theme.mode = 'light';
  }

  if (typeof themeConfig.fontSize === 'number' && Number.isFinite(themeConfig.fontSize)) {
    theme.fontSize = themeConfig.fontSize;
  }

  // Pass the full font stack through — draw-uml keeps comma-separated
  // fallback chains (e.g. `FangSong, SimSun, sans-serif`) end-to-end.
  if (typeof themeConfig.fontFamily === 'string' && themeConfig.fontFamily.trim()) {
    theme.fontFamily = themeConfig.fontFamily.trim();
  }

  return Object.keys(theme).length > 0 ? theme : undefined;
}

export class PlantumlRenderer extends BaseRenderer {
  private roughOptions: RoughSvgOptions = {
    roughness: 0.5,
    bowing: 0.5,
  };
  private stencilsInitialized = false;

  constructor() {
    super('plantuml');
  }

  /**
   * Initialize stencils service (lazy loading)
   */
  private async ensureStencils(): Promise<void> {
    if (this.stencilsInitialized) return;

    try {
      const service = getStencilsService();
      await service.init();
      this.stencilsInitialized = true;
    } catch (error) {
      this.stencilsInitialized = true;
    }
  }

  /**
   * Render PlantUML diagram to PNG
   * @param dsl - PlantUML DSL content
   * @param themeConfig - Theme configuration
   * @returns Render result with base64, width, height, format
   */
  async render(dsl: string, themeConfig: RendererThemeConfig | null): Promise<RenderResult> {
    this.validateInput(dsl);

    // Step 1: Convert PlantUML DSL to DrawIO XML
    const drawioXml = await textToDrawioXml(dsl as string, {
      theme: buildDrawUmlTheme(themeConfig),
    });

    // Step 2: Prepare stencils for DrawIO rendering
    await this.ensureStencils();

    const stencilsService = getStencilsService();
    const groups = extractStencilGroups(drawioXml);
    if (groups.length > 0) {
      await stencilsService.preloadGroups(groups);
    }

    const stencils = stencilsService.getBundle();

    // Step 3: Convert DrawIO XML to SVG
    let svg = convert(drawioXml, {
      stencils,
      fontFamily: themeConfig?.fontFamily || undefined
    });

    // Step 4: Parse SVG to get dimensions
    const parser = new DOMParser();
    const doc = parser.parseFromString(svg, 'image/svg+xml');
    const svgEl = doc.querySelector('svg');

    if (!svgEl) {
      throw new Error('PlantUML rendering failed: no SVG element generated');
    }

    const viewBox = svgEl.getAttribute('viewBox');
    let captureWidth: number, captureHeight: number;

    if (viewBox) {
      const parts = viewBox.split(/\s+/);
      captureWidth = Math.ceil(parseFloat(parts[2]));
      captureHeight = Math.ceil(parseFloat(parts[3]));
    } else {
      captureWidth = Math.ceil(parseFloat(svgEl.getAttribute('width') || '800'));
      captureHeight = Math.ceil(parseFloat(svgEl.getAttribute('height') || '600'));
    }

    // Step 5: Apply hand-drawn effect if enabled
    const isHandDrawn = themeConfig?.diagramStyle === 'handDrawn';
    if (isHandDrawn) {
      svg = applyRoughEffect(svg, this.roughOptions);
    }

    // Step 6: Render SVG to PNG
    const scale = this.calculateCanvasScale(themeConfig);
    const canvas = await this.renderSvgToCanvas(svg, captureWidth * scale, captureHeight * scale);

    const pngDataUrl = canvas.toDataURL('image/png', 1.0);
    const base64Data = pngDataUrl.replace(/^data:image\/png;base64,/, '');

    return {
      base64: base64Data,
      width: canvas.width,
      height: canvas.height,
      format: 'png',
      svg,
      drawioXml,
    };
  }
}
