import { context } from 'esbuild';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createBuildConfig } from './build-config.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(projectRoot);

console.log('📦 Building Slidev assets...');
execSync('npm run build:slidev-shell', { stdio: 'inherit' });
execSync('node --import tsx slidev-shell/build-themes.ts', { stdio: 'inherit' });

const outdir = path.join(projectRoot, 'dist/chrome');
fs.rmSync(outdir, { recursive: true, force: true });

const buildContext = await context(createBuildConfig({ development: true }));
await buildContext.watch();

const staticTargets = [
  'chrome/manifest.json',
  'chrome/src/popup',
  'chrome/src/workspace',
  'chrome/src/webview/offscreen-render.html',
  'icons',
  'src/_locales',
  'src/themes',
];

function getStaticSnapshot() {
  const files = [];

  function collect(target) {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      fs.readdirSync(target).forEach((entry) => collect(path.join(target, entry)));
      return;
    }

    if (!['.ts', '.tsx'].includes(path.extname(target))) {
      files.push(`${target}:${stat.mtimeMs}:${stat.size}`);
    }
  }

  staticTargets.forEach((target) => collect(path.join(projectRoot, target)));
  return files.sort().join('|');
}

let previousSnapshot = getStaticSnapshot();
const pollTimer = setInterval(() => {
  const nextSnapshot = getStaticSnapshot();
  if (nextSnapshot === previousSnapshot) return;

  previousSnapshot = nextSnapshot;
  buildContext.rebuild()
    .then(() => console.log('🔄 Static assets updated'))
    .catch((error) => console.error('❌ Static asset rebuild failed:', error));
}, 500);

console.log('\n👀 Chrome development build is watching for changes');
console.log('   Load dist/chrome in chrome://extensions/');
console.log('   After a rebuild, reload the extension and refresh the test page.');
console.log('   Restart this command after changing slidev-shell/.\n');

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(pollTimer);
  await buildContext.dispose();
}

process.once('SIGINT', async () => {
  await stop();
  process.exit(0);
});

process.once('SIGTERM', async () => {
  await stop();
  process.exit(0);
});
