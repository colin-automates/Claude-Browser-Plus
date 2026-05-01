#!/usr/bin/env node
/**
 * Postinstall hook — currently a no-op.
 *
 * rebrowser-patches@1.0.19 is incompatible with playwright-core@1.59.x:
 * Playwright renamed `_delegate` → `delegate` and the import alias for
 * `Worker` (`import_page2` → `import_page`), so a partial patch leaves the
 * runtime in a broken state where `frames.js` calls into properties that
 * no longer exist (`Cannot read properties of undefined (reading '_sessions')`).
 *
 * We keep the dependency installed so it's easy to re-enable later — flip
 * `ENABLE_REBROWSER_PATCHES = true` once the upstream package catches up.
 *
 * The other 5 anti-detection mitigations (non-headless launch, system
 * Chrome channel, automation-flag scrub, addInitScript stealth patches,
 * humanized input) all run regardless. They cover the bulk of what
 * Cloudflare/Datadome see; the `Runtime.enable` patch was the icing.
 */

const ENABLE_REBROWSER_PATCHES = false;

if (!ENABLE_REBROWSER_PATCHES) {
  console.log(
    '[stealth] rebrowser-patches disabled (waiting for playwright-core 1.59+ compatibility upstream). Other 5 mitigations active.'
  );
  process.exit(0);
}

// --- Below: re-enable path. Kept for the next version bump. ---

const { execFileSync } = await import('node:child_process');
const { existsSync, readFileSync } = await import('node:fs');
const { resolve, relative } = await import('node:path');

const playwrightCore = resolve(process.cwd(), 'node_modules', 'playwright-core');
const patchAbs = resolve(
  process.cwd(),
  'node_modules',
  'rebrowser-patches',
  'patches',
  'playwright-core',
  'lib.patch'
);

if (!existsSync(playwrightCore) || !existsSync(patchAbs)) {
  console.warn('[stealth] playwright-core or rebrowser-patches missing — skipping');
  process.exit(0);
}

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

function fullyApplied() {
  const markers = [
    ['lib/server/chromium/crConnection.js', '__re__emitExecutionContext'],
    ['lib/server/chromium/crDevTools.js', 'REBROWSER_PATCHES_RUNTIME_FIX_MODE'],
    ['lib/server/chromium/crPage.js', 'REBROWSER_PATCHES_RUNTIME_FIX_MODE'],
    ['lib/server/chromium/crServiceWorker.js', 'REBROWSER_PATCHES_RUNTIME_FIX_MODE'],
    ['lib/server/frames.js', 'useContextPromise'],
    ['lib/server/page.js', '_targetId']
  ];
  return markers.every(([file, marker]) => {
    try {
      return readFileSync(resolve(playwrightCore, file), 'utf8').includes(marker);
    } catch {
      return false;
    }
  });
}

if (fullyApplied()) {
  console.log('[stealth] rebrowser-patches already fully applied');
  process.exit(0);
}

let applyOutput = '';
let applyExit = 0;
try {
  applyOutput = execFileSync('patch', baseArgs, {
    cwd: playwrightCore,
    stdio: ['ignore', 'pipe', 'pipe']
  }).toString();
} catch (err) {
  applyExit = err.status ?? 1;
  applyOutput = `${(err.stdout && err.stdout.toString()) || ''}\n${(err.stderr && err.stderr.toString()) || ''}`;
}

if (applyExit === 0 && fullyApplied()) {
  console.log('[stealth] rebrowser-patches applied to playwright-core');
  process.exit(0);
}

console.warn(
  `[stealth] rebrowser-patches did not apply cleanly — reverting to keep playwright-core consistent.`
);
try {
  execFileSync('patch', [...baseArgs, '--reverse'], {
    cwd: playwrightCore,
    stdio: ['ignore', 'pipe', 'pipe']
  });
} catch {
  // Reversal will also "fail" on hunks that never applied; that's expected.
}
console.warn(
  '[stealth] CDP Runtime.enable detection (Cloudflare/Datadome) may catch us. Other 5 mitigations remain active.'
);
