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

// ── Publishable CLI entry: bundle documd.js next to its assets and emit a
// package.json so dist/cli is a standalone, installable directory. The entry
// locates its assets relative to itself when run from dist/cli (see the
// existsSync detection in documd.js). Bundling lets documd.js import shared
// TS sources (src/config/defaults.ts) while staying a self-contained file.
await build({
  entryPoints: [path.join(projectRoot, 'scripts', 'documd.js')],
  outfile: path.join(outputDir, 'documd.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node18'],
  // playwright-core stays a runtime dependency of the published package;
  // node: builtins are external automatically. The source shebang is
  // preserved by esbuild automatically.
  external: ['playwright-core'],
});

const rootPackage = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const cliPackage = {
  name: '@markdown-viewer/documd',
  version: rootPackage.version,
  description: 'documd — render Markdown, diagrams and books (html / epub / docx / pdf / svg / png / drawio)',
  type: 'module',
  bin: { documd: './documd.js' },
  engines: { node: '>=18' },
  license: rootPackage.license || 'MIT',
  author: rootPackage.author,
  homepage: rootPackage.homepage || 'https://docu.md',
  repository: rootPackage.repository,
  bugs: rootPackage.bugs,
  private: false,
  // Scoped packages default to private access on the npm registry; this opts
  // the CLI package into a public publish without requiring --access public.
  publishConfig: { access: 'public' },
  // Runtime dependencies: documd.js launches headless Chrome via
  // playwright-core — without this entry the installed CLI fails with
  // "Cannot find package 'playwright-core'".
  dependencies: {
    'playwright-core': rootPackage.dependencies?.['playwright-core'] || '^1.0.0',
  },
  // Explicit tarball contents: everything documd needs at runtime, nothing else.
  files: ['documd.js', 'browser-renderer.js', 'styles.css', 'themes/', 'stencils/', 'README.md'],
  keywords: [
    'markdown',
    'markdown-viewer',
    'documd',
    'diagram',
    'mermaid',
    'plantuml',
    'vega',
    'export',
    'epub',
    'docx',
    'pdf',
    'cli',
  ],
};
await fs.writeFile(path.join(outputDir, 'package.json'), `${JSON.stringify(cliPackage, null, 2)}\n`, 'utf8');

// Publishable README for the standalone dist/cli package.
await fs.copyFile(path.join(projectRoot, 'scripts', 'cli-README.md'), path.join(outputDir, 'README.md'));

console.log(`CLI browser assets built in ${path.relative(projectRoot, outputDir)}`);
