import esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev') || watch;

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode', 'playwright-core', '@modelcontextprotocol/sdk'],
  sourcemap: dev,
  minify: !dev,
  logLevel: 'info'
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ['src/panel/webview/canvas.ts'],
  bundle: true,
  outfile: 'out/webview/canvas.js',
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  sourcemap: dev,
  minify: !dev,
  logLevel: 'info'
};

async function copyAssets() {
  await mkdir('out/webview', { recursive: true });
  const assets = [
    ['src/panel/webview/index.html', 'out/webview/index.html'],
    ['src/panel/webview/styles.css', 'out/webview/styles.css']
  ];
  await Promise.all(
    assets
      .filter(([src]) => existsSync(src))
      .map(([src, dst]) => copyFile(src, dst))
  );
}

const assetWatchPlugin = {
  name: 'asset-watcher',
  setup(build) {
    build.onEnd(async () => {
      await copyAssets();
    });
  }
};

async function run() {
  await copyAssets();
  if (watch) {
    const ext = await esbuild.context(extensionConfig);
    const web = await esbuild.context({ ...webviewConfig, plugins: [assetWatchPlugin] });
    await Promise.all([ext.watch(), web.watch()]);
    console.log('[esbuild] watching…');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build({ ...webviewConfig, plugins: [assetWatchPlugin] })
    ]);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
