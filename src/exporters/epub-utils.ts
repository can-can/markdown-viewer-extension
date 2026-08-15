/**
 * EPUB utility helpers (pure — no DOM or heavy module dependencies, so they
 * stay unit-testable in Node).
 */

export const EPUB_MIME_TYPE = 'application/epub+zip';

export function toEpubFilename(filename: string): string {
  const epubFilename = filename || 'book.epub';
  return epubFilename.toLowerCase().endsWith('.epub') ? epubFilename : `${epubFilename}.epub`;
}
