#!/usr/bin/env node

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dagreShimPlugin } from '../scripts/dagre-shim-plugin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const outdir = path.join(projectRoot, 'dist/desktop');

/**
 * The app manifest is generated rather than checked in. A source
 * desktop/package.json would need "type": "commonjs" for electron-builder,
 * and that would also force this build script to be parsed as CommonJS.
 */
function writeAppManifest(version) {
  fs.writeFileSync(
    path.join(outdir, 'package.json'),
    `${JSON.stringify({
      name: 'docu-md-desktop',
      productName: 'docu.md',
      version,
      main: 'main.cjs',
      type: 'commonjs',
      private: true,
    }, null, 2)}\n`,
    'utf8',
  );
}

const version = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
).version;
console.log(`🔨 Building docu.md Desktop... v${version}\n`);

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });
process.chdir(projectRoot);

const shared = { bundle: true, sourcemap: true, logLevel: 'info' };
const browserDefines = {
  'process.env.NODE_ENV': '"production"',
  'MV_PLATFORM': '"desktop"',
  'global': 'globalThis',
};

await build({
  ...shared,
  entryPoints: { main: 'desktop/src/main/main.ts' },
  outdir,
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  format: 'cjs',
  external: ['electron', 'chokidar', 'fsevents'],
});

await build({
  ...shared,
  entryPoints: { preload: 'desktop/src/preload/preload.ts' },
  outdir,
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});

await build({
  ...shared,
  entryPoints: {
    renderer: 'desktop/src/renderer/main.ts',
    'viewer-embed': 'desktop/src/renderer/viewer-embed.ts',
  },
  outdir,
  platform: 'browser',
  format: 'esm',
  target: 'chrome120',
  define: { ...browserDefines, 'MV_RUNTIME': '"shared"' },
  inject: [path.join(projectRoot, 'scripts/buffer-shim.js')],
  external: ['mermaid', 'web-worker'],
  plugins: [dagreShimPlugin],
  loader: {
    '.css': 'empty',
    '.woff2': 'empty',
    '.woff': 'empty',
    '.ttf': 'empty',
    '.eot': 'empty',
  },
});

// The isolated render frame follows the known-working Obsidian worker build.
await build({
  ...shared,
  sourcemap: false,
  minify: true,
  entryPoints: {
    'iframe-render-worker': 'mobile/src/webview/iframe-render-worker.ts',
  },
  outdir,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  define: { ...browserDefines, 'MV_RUNTIME': '"worker"' },
  inject: [path.join(projectRoot, 'scripts/buffer-shim.js')],
  external: ['mermaid', 'web-worker'],
  plugins: [dagreShimPlugin],
  loader: {
    '.css': 'css',
    '.woff': 'dataurl',
    '.woff2': 'dataurl',
    '.ttf': 'dataurl',
  },
});

// Bundle viewer CSS so @imports and KaTeX font references resolve correctly.
await build({
  entryPoints: ['src/ui/styles.css'],
  bundle: true,
  outfile: path.join(outdir, 'styles.css'),
  logLevel: 'info',
  minify: true,
  loader: {
    '.css': 'css',
    '.woff2': 'file',
    '.woff': 'empty',
    '.ttf': 'empty',
    '.eot': 'empty',
  },
  assetNames: '[name]',
});

function copyDirectory(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) copyDirectory(source, target);
    else fs.copyFileSync(source, target);
  }
}

for (const file of ['index.html', 'viewer-embed.html', 'workspace.css']) {
  fs.copyFileSync(path.join(__dirname, 'src/renderer', file), path.join(outdir, file));
}
writeAppManifest(version);

copyDirectory(path.join(projectRoot, 'icons'), path.join(outdir, 'icons'));
copyDirectory(path.join(projectRoot, 'src/_locales'), path.join(outdir, '_locales'));
copyDirectory(path.join(projectRoot, 'src/themes'), path.join(outdir, 'themes'));
copyDirectory(
  path.join(projectRoot, 'node_modules/@markdown-viewer/drawio2svg/resources/stencils'),
  path.join(outdir, 'stencils'),
);

// Chrome's reused viewer asks for these paths for Slidev. They are optional in
// the Obsidian pipeline too, so copy them when a prior Slidev build is present.
copyDirectory(path.join(projectRoot, 'dist/slidev-shell'), path.join(outdir, 'slidev-shell'));
copyDirectory(path.join(projectRoot, 'dist/themes'), path.join(outdir, 'slidev-shell/themes'));
console.log('  • icons, _locales, themes, stencils');

// mobile/src/webview/iframe-render.html has external script tags, not inline
// markers. Obsidian generates this complete document and injects Mermaid first,
// then the worker; duplicate that known-working order exactly.
const mermaidJs = fs.readFileSync(
  path.join(projectRoot, 'node_modules/mermaid/dist/mermaid.min.js'),
  'utf8',
);
const workerPath = path.join(outdir, 'iframe-render-worker.js');
const workerJs = fs.readFileSync(workerPath, 'utf8');
const iframeRenderHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline';">
  <title>Render Frame</title>
  <style>* { margin: 0; padding: 0; } html, body { background: transparent; width: 1400px; min-height: 600px; }</style>
</head>
<body>
  <div id="render-container"></div>
  <canvas id="png-canvas"></canvas>
  <script>${mermaidJs}</script>
  <script>${workerJs}</script>
</body>
</html>`;
fs.writeFileSync(path.join(outdir, 'iframe-render.html'), iframeRenderHtml);
fs.unlinkSync(workerPath);
console.log('  • iframe-render.html (Mermaid + worker inlined)');

console.log(`\n✅ Build complete → dist/desktop/`);
