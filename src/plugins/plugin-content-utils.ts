/**
 * Plugin Content Script Utilities
 * Handles content script specific logic for plugins (HTML generation, remark integration)
 */

import type { BasePlugin } from './base-plugin';
import { replacePlaceholderWithImage } from './plugin-html-utils';
import type { 
  TranslateFunction,
  EscapeHtmlFunction,
  TaskData,
  AsyncTaskQueueManager,
  ASTNode,
  PluginRenderer
} from '../types/index';

/**
 * Create async placeholder element HTML (before rendering)
 * @param id - Placeholder element ID
 * @param pluginType - Plugin type identifier
 * @param isInline - Whether to render inline or block
 * @param translate - Translation function
 * @param sourceHash - Content hash for DOM diff matching
 * @param imgAttrs - Authored <img> attributes (width/height/alt) to carry into the placeholder so the rendered replacement can apply them
 * @returns Placeholder HTML
 */
export function createPlaceholderElement(
  id: string,
  pluginType: string,
  isInline: boolean,
  translate: TranslateFunction,
  sourceHash?: string,
  imgAttrs?: { width?: string | null; height?: string | null; alt?: string | null } | null
): string {
  // Generate translation key dynamically based on type
  const typeLabelKey = `async_placeholder_type_${pluginType.replace(/-/g, '')}`;
  const typeLabel = translate(typeLabelKey) || '';
  
  // If no translation found, use type as fallback
  const resolvedTypeLabel = typeLabel || pluginType;
  const processingText = translate('async_processing_message', [resolvedTypeLabel, ''])
    || `Processing ${resolvedTypeLabel}...`;

  // Data attributes for DOM diff matching
  const dataAttrs = sourceHash 
    ? `data-source-hash="${sourceHash}" data-plugin-type="${pluginType}"` 
    : '';

  // Authored <img> attributes survive the takeover via data-* attributes on
  // the placeholder; replacePlaceholderWithImage reads them back and applies
  // them to the rendered <img> element.
  const imgDataAttrs = imgAttrs
    ? (['width', 'height', 'alt'] as const)
        .filter((key) => imgAttrs[key] != null && imgAttrs[key] !== '')
        .map((key) => ` data-${key}="${escapeHtmlAttr(String(imgAttrs[key]))}"`)
        .join('')
    : '';

  if (isInline) {
    return `<span id="${id}" class="async-placeholder ${pluginType}-placeholder inline-placeholder" ${dataAttrs}${imgDataAttrs}>
      <span class="async-loading">
        <span class="async-spinner"></span>
        <span class="async-text">${processingText}</span>
      </span>
    </span>`;
  }

  return `<div id="${id}" class="async-placeholder ${pluginType}-placeholder" ${dataAttrs}${imgDataAttrs}>
    <div class="async-loading">
      <div class="async-spinner"></div>
      <div class="async-text">${processingText}</div>
    </div>
  </div>`;
}

/**
 * Escape a value for use inside a double-quoted HTML attribute.
 */
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Carry authored <img> attributes (width/height/alt) and the source line from
 * the AST node into the async task data, so the placeholder element can expose
 * them to the replacement step and error reports can name the location. The
 * attributes come from node.data.hProperties (set by remark-inline-html); the
 * alt text is the standard mdast image field; the line comes from the remark
 * AST position.
 * @param data - Task data created by plugin.createTaskData()
 * @param node - The AST node being processed
 * @returns Task data enriched with sourceWidth/sourceHeight/sourceAlt/sourceLine
 */
export function withNodeSourceInfo(
  data: Record<string, unknown>,
  node: ASTNode
): Record<string, unknown> {
  const enriched = { ...data };
  if (node.type === 'image') {
    const hProperties = (node.data as { hProperties?: Record<string, string> } | undefined)?.hProperties;
    enriched.sourceWidth = hProperties?.width ?? null;
    enriched.sourceHeight = hProperties?.height ?? null;
    enriched.sourceAlt = node.alt ?? null;
  }
  enriched.sourceLine = node.position?.start?.line ?? null;
  return enriched;
}

/**
 * Create error HTML
 * @param errorMessage - Localized error message
 * @returns Error HTML
 */
export function createErrorHTML(errorMessage: string): string {
  // Explicit color + background so the block stays readable under both light
  // and dark themes (inherited text color would otherwise be light in dark
  // themes and become illegible on the light pink background).
  return `<pre style="background: #fee; color: #8b0000; border-left: 4px solid #f00; padding: 10px; font-size: 12px; white-space: pre-wrap; word-break: break-word;">${errorMessage}</pre>`;
}

// PluginRenderer is defined in src/types/plugin.ts

/**
 * Visit function type from unist-util-visit
 */
type VisitFn = (
  tree: unknown,
  nodeType: string,
  visitor: (node: ASTNode, index: number | undefined, parent: { children?: unknown[] } | undefined) => void
) => void;

/**
 * Create remark plugin function for a plugin
 * @param plugin - Plugin instance
 * @param renderer - Renderer instance
 * @param asyncTask - Async task creator
 * @param translate - Translation function
 * @param escapeHtml - HTML escape function
 * @param visit - unist-util-visit function
 * @returns Remark plugin function
 */
export function createRemarkPlugin(
  plugin: BasePlugin,
  renderer: PluginRenderer,
  asyncTask: AsyncTaskQueueManager['asyncTask'],
  translate: TranslateFunction,
  escapeHtml: EscapeHtmlFunction,
  visit: VisitFn
): () => (tree: unknown) => void {  
  return function() {
    return (tree: unknown) => {
      // Visit all node types
      for (const nodeType of plugin.nodeSelector) {
        visit(tree, nodeType, (node, index, parent) => {
          const content = plugin.extractContent(node);
          if (!content) return;

          const isInline = plugin.isInline();
          const placeholderPlugin = { ...plugin, isInline: () => isInline } as typeof plugin;

          // Determine initial status: URLs need fetching
          const initialStatus = plugin.isUrl(content) ? 'fetching' : 'ready';

          const result = asyncTask(
            async (data: TaskData) => {
              const { id, code, sourceHash } = data;
              try {
                const renderResult = await renderer.render(plugin.type, code || '');
                
                // If renderer returns null (e.g., empty content), skip rendering
                if (renderResult) {
                  replacePlaceholderWithImage(id, renderResult, plugin.type, isInline, sourceHash as string);
                } else {
                  // Remove placeholder element if content is empty
                  const placeholder = document.getElementById(id);
                  if (placeholder) {
                    placeholder.remove();
                  }
                }
              } catch (error) {
                // Skip error display if context was cancelled or render was cancelled
                if ((error as Error).message === 'Render cancelled' || (error as Error).message === 'Request cancelled') {
                  return;
                }
                
                // Show error
                const placeholder = document.getElementById(id);
                if (placeholder) {
                  const errorDetail = escapeHtml((error as Error).message || '');
                  const localizedError = translate('async_processing_error', [plugin.type, errorDetail]) 
                    || `${plugin.type} error: ${errorDetail}`;
                  placeholder.outerHTML = createErrorHTML(localizedError);
                }
              }
            },
            withNodeSourceInfo(plugin.createTaskData(content), node),
            placeholderPlugin,
            translate,
            initialStatus
          );

          // For URLs, start fetching immediately
          if (plugin.isUrl(content)) {
            plugin.fetchContent(content)
              .then(fetchedContent => {
                result.task.data.code = fetchedContent;
                result.task.setReady();
              })
              .catch(error => {
                result.task.setError(error);
              });
          }

          const parentWithChildren = parent as { children?: unknown[] } | undefined;
          if (index === undefined || !parentWithChildren || !Array.isArray(parentWithChildren.children)) return;
          parentWithChildren.children[index] = result.placeholder as unknown;
        });
      }
    };
  };
}
