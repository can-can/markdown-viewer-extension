/**
 * Obsidian Plugin Entry Point
 *
 * Main entry point for the Markdown Viewer plugin.
 * Registers a custom ItemView for Markdown Viewer with DOCX export and settings.
 */

import { Plugin, WorkspaceLeaf, TFile, MarkdownView, addIcon } from 'obsidian';
import { MarkdownPreviewView, VIEW_TYPE, ViewerLeafState } from './preview-view';
import { getFileType } from '../../../src/utils/file-wrapper';
import { ALL_FORMAT_EXTENSIONS } from '../../../src/types/formats';

// Custom icon derived from icons/icon.svg (M letter, scaled to 100×100)
const MARKDOWN_VIEWER_ICON = '<path fill="currentColor" d="M15.2 77.8v-55.7h13.9L50 43l20.9-20.9h13.9v55.7H70.9V41.9L50 62.7 29 42v36z"/>';

function injectScopedViewStyles(): () => void {
  const styleEl = document.createElement('style');
  styleEl.dataset.markdownViewer = 'obsidian-view-content';
  styleEl.textContent = `
    .workspace-leaf-content[data-type="${VIEW_TYPE}"] .view-content.markdown-viewer-preview {
      padding: 0;
    }
  `;
  document.head.appendChild(styleEl);
  return () => styleEl.remove();
}

/**
 * Check if a file is supported for preview.
 * Supports all file types defined in file-wrapper.ts.
 */
function isSupportedFile(file: TFile): boolean {
  const fileType = getFileType(file.name);
  // 'markdown' is the default/fallback, only match explicit types + md
  return fileType !== 'markdown' || file.extension === 'md' || file.extension === 'markdown';
}

export default class MarkdownViewerPlugin extends Plugin {

  async onload() {
    this.register(injectScopedViewStyles());

    // Register non-markdown file extensions so Obsidian recognizes them as files
    try {
      this.registerExtensions(
        [...ALL_FORMAT_EXTENSIONS, 'svg'],
        VIEW_TYPE
      );
    } catch {
      // Extensions may already be registered by another plugin
    }

    // Register custom icon
    addIcon('markdown-viewer', MARKDOWN_VIEWER_ICON);

    // Register custom preview view
    this.registerView(VIEW_TYPE, (leaf) =>
      new MarkdownPreviewView(leaf, this)
    );

    // Ribbon icon in the left sidebar
    this.addRibbonIcon('markdown-viewer', 'Markdown Viewer Preview', async () => {
      await this.showPreview();
    });

    // Command palette: open preview
    this.addCommand({
      id: 'open-preview',
      name: 'Open Markdown Viewer',
      callback: () => this.showPreview(),
    });

    // Command palette: swap the current tab in place, no second pane
    this.addCommand({
      id: 'toggle-view',
      name: 'Toggle Markdown Viewer in current tab',
      checkCallback: (checking) => {
        const leaf = this.getToggleTarget();
        if (!leaf) return false;
        if (!checking) void this.toggleLeafView(leaf);
        return true;
      },
    });

    // Update preview when active file changes
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.updatePreviewContent();
      })
    );

    // Update preview when file is modified
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile) {
          this.updatePreviewForFile(file);
        }
      })
    );
  }

  onunload() {
    // Obsidian automatically cleans up registered views
  }

  /**
   * The leaf a toggle would act on: the focused viewer, or the focused markdown
   * editor holding a file this plugin can render.
   */
  private getToggleTarget(): WorkspaceLeaf | null {
    const viewer = this.app.workspace.getActiveViewOfType(MarkdownPreviewView);
    if (viewer) return viewer.leaf;

    const markdown = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (markdown?.file && isSupportedFile(markdown.file)) return markdown.leaf;

    return null;
  }

  /**
   * Swap a leaf between the built-in markdown view and the viewer, in place.
   *
   * The leaf's own view state carries the file, so both directions are one
   * operation with the type swapped — there is no second pane to keep in sync.
   */
  async toggleLeafView(leaf: WorkspaceLeaf): Promise<void> {
    const current = leaf.getViewState();
    const state = (current.state ?? {}) as ViewerLeafState;
    if (!state.file) return;

    if (current.type === VIEW_TYPE) {
      await leaf.setViewState({
        type: 'markdown',
        active: true,
        state: { ...state.prev, file: state.file },
      });
      return;
    }

    await leaf.setViewState({
      type: VIEW_TYPE,
      active: true,
      state: { file: state.file, prev: current.state },
    });
  }

  /**
   * Open the preview panel (or reveal if already open).
   */
  async showPreview(): Promise<void> {
    const existing = this.app.workspace
      .getLeavesOfType(VIEW_TYPE)
      .find((leaf) => leaf.view instanceof MarkdownPreviewView && leaf.view.followsActiveFile());

    if (existing) {
      this.app.workspace.revealLeaf(existing);
      this.updatePreviewContent();
      return;
    }

    const leaf = this.app.workspace.getLeaf('split');
    await leaf.setViewState({
      type: VIEW_TYPE,
      active: true,
      state: { file: this.app.workspace.getActiveFile()?.path, follow: true },
    });
    this.app.workspace.revealLeaf(leaf);
  }

  /**
   * Push the current active file into the sidecar panel.
   *
   * Only leaves that asked to follow are touched; a leaf that carries a file of
   * its own owns it the same way a markdown tab does.
   */
  updatePreviewContent(): void {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || !isSupportedFile(activeFile)) return;

    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof MarkdownPreviewView && view.followsActiveFile()) {
        view.setFile(activeFile);
      }
    }
  }

  /**
   * Update preview only if the modified file matches the currently previewed file.
   */
  updatePreviewForFile(file: TFile): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof MarkdownPreviewView && view.isFileMatch(file)) {
        view.setFile(file);
      }
    }
  }

}
