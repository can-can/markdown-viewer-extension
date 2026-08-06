#!/usr/bin/env node

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  entryPoints: { renderer: 'desktop/src/renderer/main.ts' },
  outdir,
  platform: 'browser',
  format: 'esm',
  target: 'chrome120',
});

// Static assets.
for (const file of ['index.html', 'workspace.css']) {
  fs.copyFileSync(path.join(__dirname, 'src/renderer', file), path.join(outdir, file));
}
writeAppManifest(version);

console.log(`\n✅ Build complete → dist/desktop/`);
