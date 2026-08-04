# docu.md for VS Code

docu.md for VS Code is the editor-focused version of docu.md Markdown Viewer. It is built for writers and developers who want to keep Markdown in their workspace, preview it beside the editor, and export finished documents without leaving VS Code.

Use this version when you are writing project documentation, reports, research notes, READMEs, or AI-assisted drafts inside a code workspace.

## Highlights

- Preview Markdown beside the editor while keeping the source file editable.
- Review rich Markdown content including tables, code blocks, math formulas, SVG content, and complex HTML tables.
- Render diagrams and charts from common text-based formats such as PlantUML, Mermaid, Vega/Vega-Lite, drawio, Canvas, Infographic, and Graphviz.
- Export handoff documents from the workspace where supported.
- Use command palette workflows, editor navigation, and local processing inside VS Code.

## Install

Install from VS Code Marketplace:

https://marketplace.visualstudio.com/items?itemName=xicilion.markdown-viewer-extension

Open VSX:

https://open-vsx.org/extension/xicilion/markdown-viewer-extension

After installation, open a Markdown file and use the command palette to launch the docu.md preview.

## First Run Setup

VS Code does not require browser-style local file permission for workspace files. The extension works inside the files already available to your editor.

If you use a remote workspace, container, or SSH session, remember that files and extension host behavior follow the VS Code environment you are connected to.

## Main Workflows

### Preview Beside the Editor

1. Open a Markdown file.
2. Run the docu.md preview command from the command palette.
3. Keep writing while the preview shows the rendered result.
4. Use scroll sync where supported to move between source and preview.

### Review Complex Markdown

Use the preview for documents with tables, code blocks, math, diagrams, images, and long-form structure. The goal is to keep source Markdown editable while making the final reading surface easy to inspect.

### Export from the Workspace

When the document is ready, use the export command to create a handoff file. DOCX is useful for recipients who need a Word document. Other outputs may be available depending on release and platform support.

## Export and Output

The VS Code extension is best when writing and export happen in the same workspace. It is useful for:

- Project documentation.
- Internal reports.
- Technical design notes.
- AI-generated Markdown that needs review and cleanup.
- READMEs and long-form engineering docs.

Export behavior can depend on the current workspace, file permissions, and extension host environment.

## Privacy

Workspace preview and export are designed for local processing in the extension environment. Your Markdown content does not need to be uploaded to a remote rendering service for normal preview and export workflows.

Remote VS Code environments may run extension code on the remote host. Treat that host as the processing location for privacy and access-control purposes.

## Platform Notes and Limitations

- VS Code is the best fit when source editing and preview should stay together.
- Browser features such as opening arbitrary web URLs are not the main workflow here.
- Remote workspaces can affect file paths, downloads, and export destinations.
- Some keyboard shortcuts may conflict with existing editor or workspace bindings.

## Troubleshooting

### Preview does not open

Confirm that the active file is a supported Markdown or document source file, then run the command palette action again.

### Scroll sync feels wrong

Large generated sections, tables, or rendered visual blocks can make source-to-preview positions approximate. Use headings or the table of contents to navigate.

### Export cannot write a file

Check workspace permissions and confirm that the target directory is writable. In remote workspaces, check the remote filesystem rather than your local machine.

## Related Platforms

- Browser extensions for local and web Markdown outside the editor.
- Obsidian for vault-native notes.
- Mobile apps for file picker and share workflows.
- The docs site for feature details and platform comparison.