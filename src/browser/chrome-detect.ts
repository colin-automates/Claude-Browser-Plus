import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ChromeDetectResult {
  found: boolean;
  path?: string;
}

/**
 * Probe well-known install paths for Google Chrome. Faster and less invasive
 * than spawning a process; misses non-default installs but Playwright's
 * `channel: 'chrome'` resolves the path itself at launch time anyway — this
 * detection just decides whether to *attempt* the channel.
 */
export function detectSystemChrome(): ChromeDetectResult {
  const candidates: string[] =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          path.join(
            os.homedir(),
            'AppData',
            'Local',
            'Google',
            'Chrome',
            'Application',
            'chrome.exe'
          )
        ]
      : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/snap/bin/google-chrome',
          '/opt/google/chrome/google-chrome'
        ];

  const hit = candidates.find((p) => existsSync(p));
  return hit ? { found: true, path: hit } : { found: false };
}
