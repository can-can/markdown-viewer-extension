import { showActionMenu, type ActionMenuHandle } from './action-menu';

export interface ExportMenuOptions {
  translate?: (key: string) => string;
  onExportDocx: () => void | Promise<void>;
  onExportEpub?: () => void | Promise<void>;
  onExportHtml?: () => void | Promise<void>;
  onSaveFile?: () => void | Promise<void>;
  onPrint?: () => void | Promise<void>;
  getPrintDisabledTitle?: () => string | null;
  menuClassName?: string;
  rightAligned?: boolean;
  rightMargin?: number;
  container?: HTMLElement;
}

export interface ExportMenu {
  showAtAnchor: (anchor: HTMLElement) => void;
  showAtPosition: (x: number, y: number) => void;
  hide: () => void;
  isVisible: () => boolean;
}

export function createExportMenu(options: ExportMenuOptions): ExportMenu {
  let current: ActionMenuHandle | null = null;

  function translate(key: string): string {
    const translated = options.translate?.(key);
    if (!translated || translated === key) {
      return fallbackTranslation(key);
    }
    return translated;
  }

  function show(anchor?: HTMLElement, x?: number, y?: number): void {
    current?.hide();
    const printDisabledTitle = options.getPrintDisabledTitle?.() || null;
    current = showActionMenu({
      anchor,
      x,
      y,
      className: options.menuClassName,
      rightAligned: options.rightAligned,
      rightMargin: options.rightMargin,
      container: options.container,
      items: [
        {
          label: translate('export_menu_export_docx'),
          onSelect: async () => {
            await options.onExportDocx();
          },
        },
        ...(options.onExportEpub ? [{
          label: translate('export_menu_export_epub'),
          onSelect: async () => {
            await options.onExportEpub!();
          },
        }] : []),
        ...(options.onExportHtml ? [{
          label: translate('export_menu_export_html'),
          onSelect: async () => {
            await options.onExportHtml!();
          },
        }] : []),
        ...(options.onPrint ? [{
          label: translate('export_menu_print_pdf'),
          onSelect: async () => {
            await options.onPrint!();
          },
          disabled: Boolean(printDisabledTitle),
          title: printDisabledTitle || '',
        }] : []),
        ...(options.onSaveFile ? [{
          label: translate('export_menu_save_file'),
          onSelect: async () => {
            await options.onSaveFile!();
          },
        }] : []),
      ],
    });
  }

  return {
    showAtAnchor: (anchor) => show(anchor),
    showAtPosition: (x, y) => show(undefined, x, y),
    hide: () => current?.hide(),
    isVisible: () => current?.isVisible() ?? false,
  };
}

function fallbackTranslation(key: string): string {
  const map: Record<string, string> = {
    export_menu_export_docx: 'Export to DOCX',
    export_menu_export_epub: 'Export to EPUB',
    export_menu_export_html: 'Export to HTML',
    export_menu_save_file: 'Save File',
    export_menu_print_pdf: 'Print to PDF',
  };
  return map[key] || key;
}