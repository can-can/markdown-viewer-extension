# docu.md for Firefox

docu.md for Firefox is the Firefox browser version of docu.md Markdown Viewer. It is built for people who want to open Markdown in the browser, review a finished reading view, and export a document without moving the content into another editor.

Use this version when Firefox is your daily browser, when you prefer installing from Firefox Add-ons, or when you need to review local and web Markdown in a Firefox-based workflow.

## Highlights

- Preview local files and supported web Markdown directly in Firefox.
- Render rich Markdown content including tables, task lists, code blocks, math formulas, SVG content, and complex HTML tables.
- Display diagrams and charts from common text-based formats such as PlantUML, Mermaid, Vega/Vega-Lite, drawio, Canvas, Infographic, and Graphviz.
- Export to DOCX, PDF, or self-contained HTML where supported.
- Use document themes and local processing for a private handoff workflow.

## Install

Install from Firefox Add-ons:

https://addons.mozilla.org/firefox/addon/markdown-viewer-extension/

After installation, pin the extension if you want quicker access to settings and actions.

## First Run Setup

Firefox requires explicit user approval for extension permissions. For normal web pages, install the extension and open a supported Markdown resource. For local files, enable file access in the browser extension settings before opening files from your device.

If a local `.md` file opens as plain text or downloads instead of rendering, check the Firefox extension details page and confirm the required access is enabled.

## Main Workflows

### Open a Local Markdown File

1. Enable local file access for the extension.
2. Open a `.md` file from Firefox or drag it into the browser.
3. Review the rendered document.
4. Choose a theme if the document is meant for sharing or export.
5. Export when the document is ready.

### Review Markdown from the Web

Open a supported Markdown URL in Firefox. docu.md renders the file as a clean reading page, preserving document structure, tables, images, code blocks, math, and visual blocks where supported.

### Export a Finished Document

Use the export action when you need a handoff file. DOCX output is useful when the recipient needs an editable Word document. PDF or HTML may be available depending on the platform build and current feature support.

## Export and Output

docu.md focuses on turning Markdown into files people can actually use after writing is done:

- DOCX for editable documents.
- PDF for print-style sharing where supported.
- HTML for portable publishing where supported.
- Image/vector output for rendered visual blocks where supported.

Exact output options can vary by platform and release. If an output is unavailable in Firefox, export from another docu.md platform using the same source Markdown.

## Privacy

Normal preview and export processing happens locally. Your Markdown files do not need to be uploaded to a remote rendering service just to view or export them.

Firefox permission prompts are part of the browser security model. Local file access should be enabled only if you want docu.md to open files from your device.

## Platform Notes and Limitations

- Firefox permission behavior can differ from Chromium browsers.
- Local file rendering depends on browser-level extension access.
- Some web pages may prevent extension processing through browser or site restrictions.
- Feature parity is shared with the docu.md engine, but browser APIs can affect exact behavior.

## Troubleshooting

### Local files do not render

Confirm that file access is enabled for the extension, then reopen the file.

### A web Markdown file still shows as plain text

Refresh the page and confirm the file type is supported. If the server sends unusual content headers, save the file locally and open it from disk.

### Export is unavailable

Check that the document finished rendering. If the browser blocks a download, allow downloads from the extension and retry.

## Related Platforms

- Chrome / Chromium: browser workflow with Chromium extension APIs.
- Microsoft Edge: Edge Add-ons distribution and Edge-managed updates.
- VS Code: editor-side preview and commands.
- Obsidian: vault-native preview and export.
- Mobile: file picker and share workflows on iOS and Android.