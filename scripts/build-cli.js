import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { dagreShimPlugin } from './dagre-shim-plugin.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const outputDir = path.join(projectRoot, 'dist', 'cli');

await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });

await build({
  entryPoints: [path.join(projectRoot, 'src', 'cli', 'browser-renderer.ts')],
  outfile: path.join(outputDir, 'browser-renderer.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  treeShaking: true,
  minify: true,
  define: {
    'process.env.NODE_ENV': '"production"',
    MV_PLATFORM: '"cli"',
    MV_RUNTIME: '"worker"',
    global: 'globalThis',
  },
  inject: [path.join(projectRoot, 'scripts', 'buffer-shim.js')],
  loader: {
    '.css': 'css',
    '.woff': 'dataurl',
    '.woff2': 'dataurl',
    '.ttf': 'dataurl',
  },
  external: ['web-worker'],
  plugins: [dagreShimPlugin],
});

await build({
  entryPoints: [path.join(projectRoot, 'src', 'ui', 'styles.css')],
  outfile: path.join(outputDir, 'styles.css'),
  bundle: true,
  minify: true,
  loader: {
    '.woff': 'dataurl',
    '.woff2': 'dataurl',
    '.ttf': 'dataurl',
    '.eot': 'dataurl',
  },
});

await fs.cp(path.join(projectRoot, 'src', 'themes'), path.join(outputDir, 'themes'), { recursive: true });

const stencilSource = path.join(
  projectRoot,
  'node_modules',
  '@markdown-viewer',
  'drawio2svg',
  'resources',
  'stencils',
);
try {
  await fs.cp(stencilSource, path.join(outputDir, 'stencils'), { recursive: true });
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

console.log(`CLI browser assets built in ${path.relative(projectRoot, outputDir)}`);
