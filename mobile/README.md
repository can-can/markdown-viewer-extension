# docu.md Mobile

docu.md Mobile brings the Markdown handoff workflow to iOS and Android. It is designed for opening Markdown on the go, reviewing a clean reading view, and sharing finished output without needing a desktop browser or editor.

Use the mobile app when Markdown arrives through a file picker, cloud drive, chat attachment, email, or share sheet, and you need to inspect or pass it along from your phone or tablet.

## Highlights

- Open Markdown from the system file picker, share sheet, cloud storage, or recent files.
- Review tables, images, code blocks, math formulas, diagrams, and long-form notes in a mobile reading view.
- Use document themes when preparing content for sharing.
- Keep normal preview work on device.
- Continue heavy export or editing workflows on browser, VS Code, or Obsidian versions when a larger screen is better.

## Install

Install the mobile app from the appropriate app store when available for your device. Development builds use the Flutter project in this directory.

For local development:

```bash
cd mobile
flutter pub get
```

Then run the app through your normal Flutter iOS or Android workflow.

## First Run Setup

Mobile platforms ask for file access through system pickers and share flows. docu.md does not need broad filesystem access for every workflow. Choose a Markdown file from the picker, open a shared file from another app, or select a recent file already known to the app.

If your document is stored in a cloud provider, make sure the provider has downloaded the file locally before opening it.

## Main Workflows

### Open from Files or Cloud Storage

1. Open docu.md Mobile.
2. Choose a Markdown file using the system file picker.
3. Review the rendered document.
4. Switch theme or reading mode if needed.
5. Export or share the result.

### Open from Another App

Use the system share sheet from a file manager, chat app, email client, or cloud drive. Choose docu.md as the target app, then review the Markdown in the mobile reading view.

### Continue Recent Work

The mobile app tracks recent files so repeated review is faster. This is useful for meeting notes, class drafts, project updates, and AI-generated Markdown that you need to revisit.

## Export and Output

Mobile is optimized for reading, review, and sharing from a handheld device. Export options may differ from desktop platforms because iOS and Android handle files, downloads, and sharing differently.

Use mobile output for quick review and handoff. For heavier document preparation, the same Markdown can be opened in a browser extension, VS Code, or Obsidian version of docu.md.

## Privacy

Normal preview processing happens on device. Files selected through the system picker or share sheet do not need to be uploaded to a remote rendering service just to view them.

The operating system may provide files through temporary access grants. If a file becomes unavailable, reopen it from the picker or source app.

## Platform Notes and Limitations

- iOS and Android have different file picker and share sheet behavior.
- Large documents can be constrained by device memory and background limits.
- Cloud files may need to be downloaded before rendering.
- Some desktop export workflows may be more comfortable on larger screens.

## Troubleshooting

### A cloud file will not open

Open the cloud provider app first and make the file available offline, then try again.

### A shared file disappears

Mobile apps may receive temporary file access. Save the file to a stable location or reopen it from the original app.

### Rendering feels slow

Large documents with many visual blocks may take longer on mobile devices. Wait for rendering to finish or use a desktop platform for heavy export work.

## Related Platforms

- Chrome, Edge, and Firefox for browser-based local or web Markdown.
- VS Code for editor-side writing and preview.
- Obsidian for vault-based notes.
- The shared docs site for feature and platform comparison.