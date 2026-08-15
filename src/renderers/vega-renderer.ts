/**
 * Vega/Vega-Lite Renderer using BaseRenderer architecture
 * Handles both Vega and Vega-Lite specifications
 */
import { BaseRenderer } from './base-renderer';
import embed from 'vega-embed';
import { expressionInterpreter } from 'vega-interpreter';
import type { RendererThemeConfig, RenderResult } from '../types/index';

/**
 * Vega/Vega-Lite specification encoding channel
 */
interface EncodingChannel {
  sort?: unknown;
  [key: string]: unknown;
}

/**
 * Vega/Vega-Lite specification encoding
 */
interface VegaEncoding {
  [channel: string]: EncodingChannel;
}

/**
 * Vega/Vega-Lite specification
 */
interface VegaSpec {
  encoding?: VegaEncoding;
  layer?: VegaSpec[];
  hconcat?: VegaSpec[];
  vconcat?: VegaSpec[];
  concat?: VegaSpec[];
  facet?: {
    encoding?: VegaEncoding;
  };
  spec?: VegaSpec;
  repeat?: unknown;
  [key: string]: unknown;
}

export class VegaRenderer extends BaseRenderer {
  private mode: 'vega' | 'vega-lite';

  constructor(mode: 'vega' | 'vega-lite' = 'vega-lite') {
    super(mode); // Type is either 'vega' or 'vega-lite'
    this.mode = mode;
  }

  /**
   * Validate Vega/Vega-Lite specification
   */
  validateInput(spec: unknown): boolean {
    if (!spec) {
      throw new Error(`Empty ${this.mode} specification provided`);
    }
    return true;
  }

  /**
   * Preprocess input - parse JSON string if needed
   */
  preprocessInput(spec: string | VegaSpec): VegaSpec {
    // Parse spec if it's a string
    let vegaSpec: VegaSpec;
    if (typeof spec === 'string') {
      try {
        vegaSpec = JSON.parse(spec);
      } catch (e) {
        throw new Error(`Invalid JSON in ${this.mode} specification: ${(e as Error).message}`);
      }
    } else {
      vegaSpec = spec;
    }

    // Validate spec structure
    if (!vegaSpec || typeof vegaSpec !== 'object') {
      throw new Error(`Invalid ${this.mode} specification: must be an object`);
    }

    // Disable auto-sorting for vega-lite specs (recursively handle all views)
    if (this.mode === 'vega-lite') {
      this.disableAutoSortRecursive(vegaSpec);
    }

    return vegaSpec;
  }

  /**
   * Recursively disable automatic sorting in vega-lite specs
   * Handles: single views, layers, concat, facet, repeat
   */
  disableAutoSortRecursive(spec: VegaSpec): void {
    if (!spec || typeof spec !== 'object') {
      return;
    }

    // Handle encoding in current spec
    if (spec.encoding) {
      this.disableAutoSort(spec.encoding);
    }

    // Handle layer compositions
    if (Array.isArray(spec.layer)) {
      spec.layer.forEach(layerSpec => this.disableAutoSortRecursive(layerSpec));
    }

    // Handle concat compositions (hconcat, vconcat, concat)
    (['hconcat', 'vconcat', 'concat'] as const).forEach(concatType => {
      const concatArray = spec[concatType];
      if (Array.isArray(concatArray)) {
        concatArray.forEach(subSpec => this.disableAutoSortRecursive(subSpec));
      }
    });

    // Handle facet compositions
    if (spec.facet) {
      // Facet can have encoding
      if (spec.facet.encoding) {
        this.disableAutoSort(spec.facet.encoding);
      }
      // Nested spec in facet
      if (spec.spec) {
        this.disableAutoSortRecursive(spec.spec);
      }
    }

    // Handle repeat compositions
    if (spec.repeat) {
      if (spec.spec) {
        this.disableAutoSortRecursive(spec.spec);
      }
    }
  }

  /**
   * Disable automatic sorting in encoding channels
   */
  disableAutoSort(encoding: VegaEncoding): void {
    if (!encoding || typeof encoding !== 'object') {
      return;
    }

    // Iterate through all encoding channels (x, y, color, size, row, column, etc.)
    for (const channel in encoding) {
      const channelDef = encoding[channel];
      
      if (channelDef && typeof channelDef === 'object' && !Array.isArray(channelDef)) {
        // Only set sort to null if it's not explicitly defined
        if (!Object.prototype.hasOwnProperty.call(channelDef, 'sort')) {
          channelDef.sort = null;
        }
      }
    }
  }

  /**
   * Render Vega/Vega-Lite spec to PNG
   * @param vegaSpec - Vega/Vega-Lite specification
   * @param themeConfig - Theme configuration
   * @returns Render result with base64, width, height, format
   */
  async render(vegaSpec: string | VegaSpec, themeConfig: RendererThemeConfig | null): Promise<RenderResult> {
    // Ensure renderer is initialized
    if (!this._initialized) {
      await this.initialize(themeConfig);
    }
    
    // Validate input
    this.validateInput(vegaSpec);
    
    // Preprocess input
    const processedSpec = this.preprocessInput(vegaSpec);
    
    // Get font family from theme config
    const fontFamily = themeConfig?.fontFamily || "'SimSun', 'Times New Roman', Times, serif";
    const isDark = themeConfig?.colorSchema === 'dark';
    // Dark palette: light text/axes on transparent bg so the chart blends into
    // a dark page. Mirrors vega's built-in 'dark' theme minimally.
    const darkStroke = '#c9d1d9';
    const darkLabel = '#c9d1d9';
    const darkGridline = '#30363d';

    // Create container for this render
    const container = this.createContainer();
    container.style.cssText = 'position: absolute; left: -9999px; top: -9999px; display: inline-block; background: transparent; padding: 0; margin: 0;';

    // Prepare embed options (always use canvas for PNG output)
    const embedOptions = {
      mode: this.mode as 'vega' | 'vega-lite',
      actions: false, // Hide action links
      renderer: 'canvas' as const,
      ast: true, // Use AST mode to avoid eval
      expr: expressionInterpreter, // Use expression interpreter instead of eval
      config: {
        background: null as string | null, // Transparent background
        font: fontFamily,
        ...(isDark ? { title: { color: darkLabel, subtitleColor: darkLabel } } : {}),
        view: {
          stroke: null as string | null // Remove border
        },
        axis: {
          labelFontSize: 11,
          titleFontSize: 12,
          ...(isDark ? {
            domainColor: darkStroke,
            tickColor: darkStroke,
            gridColor: darkGridline,
            labelColor: darkLabel,
            titleColor: darkLabel,
          } : {}),
        },
        legend: {
          labelFontSize: 11,
          titleFontSize: 12,
          ...(isDark ? {
            labelColor: darkLabel,
            titleColor: darkLabel,
          } : {}),
        },
        // Let Vega-Lite use its default step-based sizing for better automatic layout
        mark: {
          tooltip: true
        }
      }
    };

    // Render the spec using vega-embed
    const result = await embed(container, processedSpec, embedOptions);
    
    // Calculate scale for PNG dimensions (clamped to canvas limits)
    const scale = this.clampCanvasDimensions(
      result.view.width(),
      result.view.height(),
      this.calculateCanvasScale(themeConfig),
    );

    // Get Canvas directly from the view object
    // toCanvas() returns a Promise<HTMLCanvasElement>
    const sourceCanvas = await result.view.toCanvas(scale);

    // Validate canvas
    if (!sourceCanvas || sourceCanvas.width === 0 || sourceCanvas.height === 0) {
      throw new Error('Generated canvas is empty or invalid');
    }

    // Convert canvas to PNG data URL
    const pngDataUrl = sourceCanvas.toDataURL('image/png', 1.0);
    const base64Data = pngDataUrl.replace(/^data:image\/png;base64,/, '');

    // SVG representation: view.toSVG() is renderer-independent.
    const svg = await result.view.toSVG();

    // Cleanup container
    this.removeContainer(container);

    return {
      base64: base64Data,
      width: sourceCanvas.width,
      height: sourceCanvas.height,
      format: 'png',
      svg,
    };
  }
}
