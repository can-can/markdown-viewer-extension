# documd

The official CLI of [docu.md Markdown Viewer](https://docu.md).

Render Markdown, diagrams and GitBook books to **HTML, EPUB, DOCX, PDF, SVG, PNG
and DrawIO** with headless Chrome — powered by the docu.md Markdown Viewer
engine (the same renderers and exporters as the browser extension).

- Website: <https://docu.md>
- Source: <https://github.com/markdown-viewer/markdown-viewer-extension>
- Issues: <https://github.com/markdown-viewer/markdown-viewer-extension/issues>

## Install

```bash
npm install -g @markdown-viewer/documd
```

## Version

```bash
documd --version
```

## Usage

```bash
documd <input> [<output>] [--format <f>] [options]
```

The output file is the second positional argument (pandoc style). Its
extension selects the format — when the input extension is a known input
format and the output extension is a known output format, documd infers
everything; otherwise it reports the unknown format and asks you to set
`--format` instead of guessing.

`--format` is inferred from the **output extension** when omitted:

- `notes.md out.epub` → epub, `notes.md out.pdf` → pdf, `flow.puml out.png` → png, …
- no output: markdown → html, diagram sources → svg, `--book` → epub

## Markdown documents

```bash
documd notes.md                      # notes.html
documd notes.md --format epub        # notes.epub
documd notes.md report.pdf           # PDF (inferred from the extension)
documd notes.md --format docx        # notes.docx
```

## Diagrams

```bash
documd flow.puml                     # flow.svg (PlantUML inferred)
documd chart.mmd chart.png           # Mermaid → PNG
documd flow.puml --format drawio     # PlantUML → DrawIO XML
```

Supported diagram sources:

| Extension | Renderer |
|---|---|
| .puml / .plantuml / .wsd | PlantUML (also produces DrawIO XML) |
| .mmd / .mermaid | Mermaid |
| .dot / .gv | Graphviz |
| .vega / .vl | Vega / Vega-Lite |
| .drawio | DrawIO |
| .echarts | ECharts |
| .svg | static SVG (passed through) |
| .infographic | Infographic |
| .canvas | Canvas |

## Whole books (GitBook SUMMARY.md)

```bash
documd SUMMARY.md --book                 # book.epub (default)
documd SUMMARY.md --book --format docx   # merged DOCX
documd SUMMARY.md --book --format pdf    # one page per chapter
```

## Options

| Option | Description |
|---|---|
| `--format <f>` | html, epub, docx, pdf, svg, png, drawio |
| `-b, --book` | Whole-book export (input: GitBook SUMMARY.md) |
| `--diagram-type <t>` | Diagram renderer override |
| `-t, --theme <id>` | Viewer theme id |
| `--title <text>` | Document title |
| `--language <code>` | Document language |
| `--frontmatter <mode>` | hide, table, raw |
| `--table-layout <mode>` | left, center, center-full-width |
| `--image-layout <mode>` | left, center |
| `--diagram-layout <mode>` | left, center |
| `--merge-empty-cells` | Merge empty table cells (on by default) |
| `--first-line-indent <n>` | First-line indent in characters, 0-4 (default 2) |
| `--merge-empty-cells` | Merge empty Markdown table cells |
| `--chrome <path>` | Explicit Chrome executable path |
| `--timeout <seconds>` | Render timeout (default 120) |
| `-h, --help` | Show help |

## Notes

- Requires Chrome; pass `--chrome` to use a specific binary.
- Themes, fonts, code highlighting, math and layout settings mirror the
  docu.md Markdown Viewer extension.
