import * as https from 'node:https';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

const RELEASE_URL =
  'https://api.github.com/repos/colin-automates/Claude-Browser-Plus/releases/latest';
const ETAG_KEY = 'updater-etag';
const CACHED_RELEASE_KEY = 'updater-cached-release';
const STARTUP_DELAY_MS = 30_000;
const DEFAULT_INTERVAL_HOURS = 6;

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface Release {
  tag_name: string;
  name: string;
  html_url: string;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

interface FetchResult {
  release: Release | null;
  etag: string | null;
  notModified: boolean;
}

export class Updater {
  private startupTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  start(): void {
    if (this.disposed) return;
    this.startupTimer = setTimeout(() => {
      void this.tickAuto();
    }, STARTUP_DELAY_MS);
    const intervalMs = this.intervalHours() * 60 * 60 * 1000;
    this.intervalTimer = setInterval(() => {
      void this.tickAuto();
    }, intervalMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.startupTimer = null;
    this.intervalTimer = null;
  }

  async checkForUpdates(opts: { manual: boolean }): Promise<void> {
    if (this.inFlight) {
      this.output.appendLine('Update check already in progress; ignoring duplicate request');
      return this.inFlight;
    }
    this.inFlight = this.runCheck(opts).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private autoUpdateEnabled(): boolean {
    const cfg = vscode.workspace.getConfiguration('aiBrowser');
    return cfg.get<boolean>('autoUpdate', true);
  }

  private intervalHours(): number {
    const cfg = vscode.workspace.getConfiguration('aiBrowser');
    const v = cfg.get<number>('updateCheckIntervalHours', DEFAULT_INTERVAL_HOURS);
    return Math.max(1, Math.min(168, v));
  }

  private currentVersion(): string {
    const ext = vscode.extensions.getExtension('colin-automates.claude-browser-plus');
    const v = ext?.packageJSON?.version;
    return typeof v === 'string' ? v : '0.0.0';
  }

  private async tickAuto(): Promise<void> {
    if (this.disposed) return;
    if (!this.autoUpdateEnabled()) {
      this.output.appendLine('Auto-update disabled; skipping scheduled check');
      return;
    }
    try {
      await this.checkForUpdates({ manual: false });
    } catch (err) {
      this.output.appendLine(`Auto-update check error: ${this.errMsg(err)}`);
    }
  }

  private async runCheck(opts: { manual: boolean }): Promise<void> {
    const current = this.currentVersion();
    let fetched: FetchResult;
    try {
      fetched = await this.fetchLatestRelease();
    } catch (err) {
      const m = this.errMsg(err);
      this.output.appendLine(`Update check failed: ${m}`);
      if (opts.manual) {
        vscode.window.showWarningMessage(`Claude Browser: update check failed (${m})`);
      }
      return;
    }

    let release = fetched.release;
    if (fetched.notModified) {
      const cached = this.context.globalState.get<Release>(CACHED_RELEASE_KEY);
      if (cached) release = cached;
    }
    if (!release) {
      this.output.appendLine('Update check: no release data returned');
      if (opts.manual) {
        vscode.window.showWarningMessage('Claude Browser: could not read latest release info');
      }
      return;
    }

    if (fetched.etag) {
      await this.context.globalState.update(ETAG_KEY, fetched.etag);
    }
    if (!fetched.notModified) {
      await this.context.globalState.update(CACHED_RELEASE_KEY, release);
    }

    if (release.prerelease) {
      this.output.appendLine(`Skipping prerelease ${release.tag_name}`);
      if (opts.manual) {
        vscode.window.showInformationMessage(
          `Latest GitHub release (${release.tag_name}) is a prerelease — skipping.`
        );
      }
      return;
    }

    const latestVersion = release.tag_name.replace(/^v/i, '');
    const cmp = compareSemver(latestVersion, current);
    this.output.appendLine(
      `Update check: current=${current}, latest=${latestVersion} (${cmp > 0 ? 'newer' : cmp === 0 ? 'same' : 'older'})`
    );

    if (cmp <= 0) {
      if (opts.manual) {
        vscode.window.showInformationMessage(
          `Claude Browser is up to date (v${current}).`
        );
      }
      return;
    }

    const asset = release.assets.find((a) => /^claude-browser-plus.*\.vsix$/i.test(a.name))
      ?? release.assets.find((a) => /\.vsix$/i.test(a.name));
    if (!asset) {
      this.output.appendLine(`No .vsix asset found in release ${release.tag_name}`);
      if (opts.manual) {
        vscode.window.showWarningMessage(
          `Claude Browser: release ${release.tag_name} has no VSIX asset.`
        );
      }
      return;
    }

    if (this.autoUpdateEnabled()) {
      await this.installFromAsset(asset, latestVersion, release.html_url);
    } else {
      const choice = await vscode.window.showInformationMessage(
        `Claude Browser update available: v${current} → v${latestVersion}`,
        'Install',
        'Release Notes',
        'Later'
      );
      if (choice === 'Install') {
        await this.installFromAsset(asset, latestVersion, release.html_url);
      } else if (choice === 'Release Notes') {
        await vscode.env.openExternal(vscode.Uri.parse(release.html_url));
      }
    }
  }

  private async installFromAsset(
    asset: ReleaseAsset,
    version: string,
    releaseUrl: string
  ): Promise<void> {
    const updateDir = path.join(this.context.globalStorageUri.fsPath, 'update');
    await fsp.mkdir(updateDir, { recursive: true });
    const vsixPath = path.join(updateDir, `claude-browser-plus-${version}.vsix`);
    const lockPath = `${vsixPath}.lock`;

    try {
      await fsp.writeFile(lockPath, String(process.pid), { flag: 'wx' });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'EEXIST') {
        this.output.appendLine(`Skipping install: lock file exists at ${lockPath}`);
        return;
      }
      throw err;
    }

    try {
      this.output.appendLine(`Downloading update v${version} from ${asset.browser_download_url}`);
      await this.downloadVsix(asset.browser_download_url, vsixPath);
      this.output.appendLine(`Downloaded ${vsixPath} (${asset.size} bytes)`);

      try {
        await vscode.commands.executeCommand(
          'workbench.extensions.installExtension',
          vscode.Uri.file(vsixPath)
        );
      } catch (err) {
        const m = this.errMsg(err);
        this.output.appendLine(`installExtension failed: ${m}`);
        const choice = await vscode.window.showErrorMessage(
          `Claude Browser: install of v${version} failed (${m}).`,
          'Open Release',
          'Dismiss'
        );
        if (choice === 'Open Release') {
          await vscode.env.openExternal(vscode.Uri.parse(releaseUrl));
        }
        return;
      }

      this.output.appendLine(`Installed v${version}; restarting extension host`);
      vscode.window.showInformationMessage(
        `Claude Browser updated to v${version} — applying now…`
      );

      try {
        await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
      } catch (err) {
        const m = this.errMsg(err);
        this.output.appendLine(`restartExtensionHost failed (${m}); falling back to reloadWindow`);
        try {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        } catch (err2) {
          this.output.appendLine(`reloadWindow also failed: ${this.errMsg(err2)}`);
          vscode.window.showWarningMessage(
            `Claude Browser v${version} is installed. Reload the window to activate.`
          );
        }
      }
    } finally {
      try {
        await fsp.unlink(lockPath);
      } catch {
        /* lock cleanup is best-effort */
      }
    }
  }

  private fetchLatestRelease(): Promise<FetchResult> {
    return new Promise((resolve, reject) => {
      const cachedEtag = this.context.globalState.get<string>(ETAG_KEY);
      const headers: Record<string, string> = {
        'User-Agent': `claude-browser-plus/${this.currentVersion()}`,
        Accept: 'application/vnd.github+json'
      };
      if (cachedEtag) headers['If-None-Match'] = cachedEtag;

      const req = https.get(RELEASE_URL, { headers, timeout: 15_000 }, (res) => {
        const status = res.statusCode ?? 0;
        const etag = (res.headers['etag'] as string | undefined) ?? null;

        if (status === 304) {
          res.resume();
          resolve({ release: null, etag, notModified: true });
          return;
        }

        if (status === 301 || status === 302) {
          const loc = res.headers['location'];
          res.resume();
          if (typeof loc === 'string') {
            https
              .get(loc, { headers, timeout: 15_000 }, (r2) => this.consumeJson(r2, etag, resolve, reject))
              .on('error', reject)
              .on('timeout', () => {
                req.destroy(new Error('GitHub release fetch timed out'));
              });
            return;
          }
          reject(new Error(`Unexpected redirect without location (status ${status})`));
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`GitHub returned status ${status}`));
          return;
        }

        this.consumeJson(res, etag, resolve, reject);
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('GitHub release fetch timed out'));
      });
    });
  }

  private consumeJson(
    res: NodeJS.ReadableStream,
    etag: string | null,
    resolve: (v: FetchResult) => void,
    reject: (err: Error) => void
  ): void {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(text) as Release;
        resolve({ release: parsed, etag, notModified: false });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    res.on('error', reject);
  }

  private downloadVsix(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tmp = `${destPath}.part`;
      const file = fs.createWriteStream(tmp);
      const headers = {
        'User-Agent': `claude-browser-plus/${this.currentVersion()}`,
        Accept: 'application/octet-stream'
      };

      const cleanup = (err: Error): void => {
        file.destroy();
        fs.unlink(tmp, () => reject(err));
      };

      const get = (target: string, redirects: number): void => {
        if (redirects > 5) {
          cleanup(new Error('Too many redirects downloading VSIX'));
          return;
        }
        const req = https.get(target, { headers, timeout: 60_000 }, (res) => {
          const status = res.statusCode ?? 0;
          if (status === 301 || status === 302 || status === 307 || status === 308) {
            const loc = res.headers['location'];
            res.resume();
            if (typeof loc === 'string') {
              get(loc, redirects + 1);
              return;
            }
            cleanup(new Error(`Redirect without location (status ${status})`));
            return;
          }
          if (status < 200 || status >= 300) {
            res.resume();
            cleanup(new Error(`Download failed: status ${status}`));
            return;
          }
          res.pipe(file);
          file.on('finish', () => {
            file.close((err) => {
              if (err) {
                cleanup(err);
                return;
              }
              fs.rename(tmp, destPath, (renameErr) => {
                if (renameErr) cleanup(renameErr);
                else resolve();
              });
            });
          });
          res.on('error', cleanup);
        });
        req.on('error', cleanup);
        req.on('timeout', () => {
          req.destroy(new Error('VSIX download timed out'));
        });
      };

      get(url, 0);
    });
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function parseSemver(v: string): [number, number, number] {
  const m = v.replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
