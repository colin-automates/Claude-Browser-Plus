#!/usr/bin/env node
/**
 * Postinstall hook: apply rebrowser-patches' playwright-core lib.patch so the
 * CDP `Runtime.enable` tell (caught by Cloudflare/Datadome) is suppressed.
 *
 * We invoke `patch` directly (not the rebrowser-patches CLI) because the CLI
 * uses `exec()` and breaks on Windows project paths that contain spaces (it
 * doesn't quote `--input=`). We also use `-i <file>` instead of `--input=...`
 * because some Windows builds of GNU patch parse the long-form path badly.
 *
 * Idempotent: detects "already applied" via patch's stderr.
 * Failures are logged but never break npm install — partial stealth from the
 * other 5 mitigations is still useful.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const playwrightCore = resolve(process.cwd(), 'node_modules', 'playwright-core');
const patchAbs = resolve(
  process.cwd(),
  'node_modules',
  'rebrowser-patches',
  'patches',
  'playwright-core',
  'lib.patch'
);

if (!existsSync(playwrightCore)) {
  console.warn('[stealth] node_modules/playwright-core missing — skipping patcher');
  process.exit(0);
}
if (!existsSync(patchAbs)) {
  console.warn('[stealth] rebrowser-patches lib.patch missing — skipping patcher');
  process.exit(0);
}

// Use a relative path from cwd=playwrightCore so the patch tool sees a short,
// space-aware argument.
const patchRel = relative(playwrightCore, patchAbs).replace(/\\/g, '/');

const baseArgs = [
  '--batch',
  '-p1',
  '-i',
  patchRel,
  '--no-backup-if-mismatch',
  '--reject-file=-',
  '--forward'
];

// Quick "already fully patched?" probe using one of the marker strings the
// patch introduces — avoids a noisy `patch` invocation when nothing to do.
function hasMarker(file, marker) {
  try {
    return readFileSync(resolve(playwrightCore, file), 'utf8').includes(marker);
  } catch {
    return false;
  }
}
const allMarkers = [
  ['lib/server/chromium/crConnection.js', '__re__emitExecutionContext'],
  ['lib/server/chromium/crDevTools.js', 'REBROWSER_PATCHES_RUNTIME_FIX_MODE'],
  ['lib/server/frames.js', 'useContextPromise']
];
if (allMarkers.every(([f, m]) => hasMarker(f, m))) {
  console.log('[stealth] rebrowser-patches markers already present in playwright-core');
  process.exit(0);
}

let stdout = '';
let stderr = '';
let exitCode = 0;
try {
  const out = execFileSync('patch', baseArgs, {
    cwd: playwrightCore,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  stdout = out.toString();
} catch (err) {
  exitCode = err.status ?? 1;
  stdout = (err.stdout && err.stdout.toString()) || '';
  stderr = (err.stderr && err.stderr.toString()) || '';
}

const combined = `${stdout}\n${stderr}`;
const reversedHits = (combined.match(/Reversed \(or previously applied\)/g) || []).length;
const failedHits = (combined.match(/hunk(s)? FAILED/g) || []).length;

if (exitCode === 0 || (reversedHits > 0 && failedHits === 0)) {
  console.log('[stealth] rebrowser-patches applied to playwright-core');
} else if (failedHits > 0 && reversedHits > 0) {
  console.warn(
    `[stealth] rebrowser-patches partially applied — ${failedHits} hunk(s) failed (likely a playwright-core version that drifted from rebrowser's tested set). Cloudflare/Datadome stealth coverage will be reduced. Continuing.`
  );
} else if (failedHits > 0) {
  console.warn(
    `[stealth] rebrowser-patches failed — ${failedHits} hunk(s) could not apply. CDP Runtime.enable detection may catch us. Continuing.`
  );
} else {
  console.warn(
    `[stealth] rebrowser-patches: unexpected exit ${exitCode}. Continuing.\n${combined.split('\n').slice(0, 4).join('\n')}`
  );
}
