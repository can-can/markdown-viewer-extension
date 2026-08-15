/**
 * Shared default render/layout settings — the SINGLE source of truth for
 * the extension settings (DEFAULT_SETTINGS), the documd CLI (parseArgs) and
 * tests. Changing a default here updates every consumer.
 *
 * Note: `language` (CLI) and `preferredLocale` (extension UI language) are
 * deliberately separate: one is the exported document language, the other
 * the extension's UI locale.
 */

export const DEFAULT_RENDER_SETTINGS = {
  /** Theme preset id (themes/presets/<id>.json). */
  theme: 'default',
  /** Language code of the rendered/exported document. */
  language: 'en',
  /** Frontmatter display: hide | table | raw. */
  frontmatterDisplay: 'hide' as 'hide' | 'table' | 'raw',
  /** Table alignment. */
  tableLayout: 'center' as 'left' | 'center' | 'center-full-width',
  /** Standalone image alignment. */
  imageLayout: 'left' as 'left' | 'center',
  /** Diagram/chart alignment. */
  diagramLayout: 'center' as 'left' | 'center',
  /** Merge empty table cells. */
  tableMergeEmpty: true,
  /** First-line indent in characters (0 = none). */
  firstLineIndent: 2,
} as const;
