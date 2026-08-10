/**
 * Book Export Type Definitions
 * Shared types for GitBook whole-book export (DOCX / PDF)
 */

/**
 * A single page of a GitBook-style book (from SUMMARY.md navigation)
 */
export interface BookPage {
  title: string;
  href: string;
  /** Book-tree depth (0 = top level) */
  depth: number;
}

/**
 * Export pipeline phases for progress reporting
 * - fetch:   downloading page markdown files
 * - render:  rendering pages to HTML (PDF/print path)
 * - convert: markdown -> DOCX conversion (DOCX path)
 * - pack:    DOCX packaging / upload
 */
export type BookExportPhase = 'fetch' | 'render' | 'convert' | 'pack';

/**
 * Progress callback for book exports
 */
export type BookExportProgressHandler = (phase: BookExportPhase, done: number, total: number) => void;

/**
 * DOCX book export result
 */
export interface BookExportDocxResult {
  success: boolean;
  error?: string;
  /** Number of pages that failed to fetch and were skipped */
  skippedCount?: number;
  filename?: string;
}

/**
 * PDF (print) book export result
 */
export interface BookExportPdfResult {
  success: boolean;
  error?: string;
}
