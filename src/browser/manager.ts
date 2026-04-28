import type { BrowserContext, BrowserType, Page } from 'playwright-core';
import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { profileDir } from '../profile.js';
import { Screencaster } from './screencast.js';
import { TabRegistry, type TabInfo, type TabSnapshot } from './tabs.js';
import { attachPageState } from './page-state.js';
import { isOwnProject } from './project.js';
import { detectSystemChrome, type ChromeDetectResult } from './chrome-detect.js';
import { STEALTH_INIT_SCRIPT } from './stealth.js';

const CHROMIUM_INSTALLED_KEY = 'chromium-installed-v2';
const BROWSERS_TO_INSTALL = ['chromium', 'chromium-headless-shell'];

export type ViewportPreset = 'desktop' | 'laptop' | 'tablet' | 'mobile';

const VIEWPORT_PRESETS: Record<ViewportPreset, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 375, height: 667 }
};

function readViewportSetting(): { width: number; height: number; preset: ViewportPreset } {
  const cfg = vscode.workspace.getConfiguration('aiBrowser');
  const raw = cfg.get<string>('defaultViewport') ?? 'desktop';
  const preset: ViewportPreset =
    raw === 'laptop' || raw === 'tablet' || raw === 'mobile' ? raw : 'desktop';
  return { ...VIEWPORT_PRESETS[preset], preset };
}

function readScreencastSettings(): { quality: number; fps: number } {
  const cfg = vscode.workspace.getConfiguration('aiBrowser');
  const fps = Math.max(5, Math.min(60, cfg.get<number>('screencastFps') ?? 60));
  const quality = Math.max(30, Math.min(95, cfg.get<number>('screencastQuality') ?? 85));
  return { quality, fps };
}

export type MouseInput = {
  kind: 'input';
  type: 'mouse';
  action: 'down' | 'up' | 'move';
  x: number;
  y: number;
  button: number;
  modifiers?: string[];
};
export type WheelInput = {
  kind: 'input';
  type: 'wheel';
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
};
export type TypeInput = { kind: 'input'; type: 'type'; text: string };
export type PressInput = { kind: 'input'; type: 'press'; key: string; modifiers?: string[] };
export type InputMessage = MouseInput | WheelInput | TypeInput | PressInput;

function mouseButton(b: number): 'left' | 'right' | 'middle' {
  if (b === 1) return 'middle';
  if (b === 2) return 'right';
  return 'left';
}

export interface BrowserManagerCallbacks {
  onFrame: (jpeg: ArrayBuffer) => void;
  onUrlChange?: (url: string, ownProject: boolean) => void;
  onTabsChanged?: (snapshot: TabSnapshot) => void;
}

export class BrowserManager {
  private context: BrowserContext | null = null;
  private launching: Promise<void> | null = null;
  private installing: Promise<void> | null = null;
  private chromium: BrowserType | null = null;
  private readonly screencaster: Screencaster;
  private readonly tabs = new TabRegistry();
  private viewport: { width: number; height: number; preset: ViewportPreset | 'custom' };
  private reconnecting = false;
  private disposing = false;
  private chromeDetect: ChromeDetectResult | null = null;

  constructor(
    private readonly extCtx: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly callbacks: BrowserManagerCallbacks
  ) {
    this.viewport = readViewportSetting();
    this.screencaster = new Screencaster(
      (jpeg) => {
        const copy = new ArrayBuffer(jpeg.byteLength);
        new Uint8Array(copy).set(jpeg);
        this.callbacks.onFrame(copy);
      },
      readScreencastSettings()
    );

    this.tabs.on('activeChanged', (page: Page | null) => {
      void this.screencaster.setActive(page);
      if (page && this.callbacks.onUrlChange) {
        const u = page.url();
        this.callbacks.onUrlChange(u, isOwnProject(u));
      }
    });

    this.tabs.on('changed', () => {
      void this.fireTabsChanged();
    });

    // React to setting changes live.
    this.extCtx.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('aiBrowser.screencastFps') ||
          e.affectsConfiguration('aiBrowser.screencastQuality')
        ) {
          void this.screencaster.setOptions(readScreencastSettings());
        }
      })
    );
  }

  getViewport(): { width: number; height: number; preset: ViewportPreset | 'custom' } {
    return { ...this.viewport };
  }

  private async fireTabsChanged(): Promise<void> {
    if (!this.callbacks.onTabsChanged) return;
    try {
      const snap = await this.tabs.snapshotWithTitles();
      const enriched: TabSnapshot = {
        tabs: snap.tabs.map((t) => ({ ...t, isOwnProject: isOwnProject(t.url) })),
        activeTabId: snap.activeTabId
      };
      this.callbacks.onTabsChanged(enriched);
    } catch (err) {
      this.output.appendLine(`tabs snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private get browsersPath(): string {
    return this.extCtx.globalStorageUri.fsPath;
  }

  private setBrowsersEnv(): void {
    process.env.PLAYWRIGHT_BROWSERS_PATH = this.browsersPath;
  }

  private async loadChromium(): Promise<BrowserType> {
    if (this.chromium) return this.chromium;
    this.setBrowsersEnv();
    const pw: typeof import('playwright-core') = await import('playwright-core');
    this.chromium = pw.chromium;
    return this.chromium;
  }

  async ensureChromium(): Promise<void> {
    if (this.extCtx.globalState.get<boolean>(CHROMIUM_INSTALLED_KEY)) return;
    if (this.installing) return this.installing;

    this.installing = (async () => {
      await fs.mkdir(this.browsersPath, { recursive: true });
      const cliPath = path.join(
        this.extCtx.extensionPath,
        'node_modules',
        'playwright-core',
        'cli.js'
      );

      this.output.appendLine(`Installing Chromium → ${this.browsersPath}`);
      this.output.appendLine(`Browsers: ${BROWSERS_TO_INSTALL.join(', ')}`);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Claude Browser: downloading Chromium (one-time, ~250 MB)…',
          cancellable: false
        },
        async (progress) => {
          await new Promise<void>((resolve, reject) => {
            const proc = cp.spawn(
              process.execPath,
              [cliPath, 'install', ...BROWSERS_TO_INSTALL],
              {
                env: {
                  ...process.env,
                  PLAYWRIGHT_BROWSERS_PATH: this.browsersPath
                },
                stdio: ['ignore', 'pipe', 'pipe']
              }
            );
            proc.stdout?.on('data', (d) => {
              const text = String(d).trim();
              if (text) {
                this.output.appendLine(`[chromium] ${text}`);
                const last = text.split(/\r?\n/).pop();
                if (last) progress.report({ message: last });
              }
            });
            proc.stderr?.on('data', (d) => {
              const text = String(d).trim();
              if (text) this.output.appendLine(`[chromium:err] ${text}`);
            });
            proc.on('error', reject);
            proc.on('exit', (code) => {
              if (code === 0) resolve();
              else reject(new Error(`Chromium install exited with code ${code}`));
            });
          });
        }
      );

      await this.extCtx.globalState.update(CHROMIUM_INSTALLED_KEY, true);
      this.output.appendLine('Chromium install complete');
    })();

    try {
      await this.installing;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`Chromium install failed: ${m}`);
      void vscode.window
        .showErrorMessage(
          `Claude Browser: Chromium download failed (${m}). Behind a proxy? Set HTTPS_PROXY or PLAYWRIGHT_DOWNLOAD_HOST and retry.`,
          'Open Output',
          'Retry'
        )
        .then(async (choice) => {
          if (choice === 'Open Output') this.output.show(true);
          if (choice === 'Retry') {
            // Force re-download on next launch attempt.
            await this.extCtx.globalState.update(CHROMIUM_INSTALLED_KEY, false);
          }
        });
      throw err;
    } finally {
      this.installing = null;
    }
  }

  async launch(): Promise<void> {
    if (this.context) return;
    if (this.launching) return this.launching;

    this.launching = (async () => {
      // Prefer system Chrome over bundled Chromium — real Chrome leaks far less
      // bot-detection signal. If absent, fall back to the bundled download.
      if (!this.chromeDetect) this.chromeDetect = detectSystemChrome();
      if (this.chromeDetect.found) {
        this.output.appendLine(`[stealth] Using system Chrome at ${this.chromeDetect.path}`);
      } else {
        this.output.appendLine(
          '[stealth] Google Chrome not detected — falling back to bundled Chromium. Bot detection will be more aggressive on Cloudflare/Datadome sites.'
        );
        await this.ensureChromium();
      }
      this.setBrowsersEnv();
      const chromium = await this.loadChromium();

      // The per-workspace profile is part of the anti-detection strategy:
      // cookies and Cloudflare/Datadome challenge completions accumulate trust over time.
      const profile = profileDir(this.extCtx);
      await fs.mkdir(profile, { recursive: true });
      this.output.appendLine(`Profile dir: ${profile}`);

      const vp = { width: this.viewport.width, height: this.viewport.height };
      const stealthArgs = [
        `--window-position=-10000,-10000`,
        `--window-size=${vp.width},${vp.height}`,
        '--disable-blink-features=AutomationControlled'
      ];
      const ignoreDefaultArgs = ['--enable-automation'];

      try {
        this.context = await chromium.launchPersistentContext(profile, {
          channel: this.chromeDetect.found ? 'chrome' : undefined,
          headless: false,
          viewport: vp,
          args: stealthArgs,
          ignoreDefaultArgs
        });
        this.output.appendLine(
          `Persistent context launched @ ${vp.width}×${vp.height} (${String(this.viewport.preset)}) — channel=${this.chromeDetect.found ? 'chrome' : 'chromium'}`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/SingletonLock|ProcessSingleton/.test(msg)) {
          this.output.appendLine('Profile in use — falling back to ephemeral context');
          vscode.window.showWarningMessage(
            'Claude Browser: profile in use by another VS Code window; running in temporary mode (no persistence).'
          );
          const browser = await chromium.launch({
            channel: this.chromeDetect.found ? 'chrome' : undefined,
            headless: false,
            args: stealthArgs,
            ignoreDefaultArgs
          });
          this.context = await browser.newContext({ viewport: vp });
        } else {
          this.output.appendLine(`Launch failed: ${msg}`);
          throw err;
        }
      }

      // Apply stealth init script to every page in this context, before any page script.
      try {
        await this.context.addInitScript({ content: STEALTH_INIT_SCRIPT });
      } catch (err) {
        this.output.appendLine(
          `[stealth] addInitScript failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      this.context.on('page', (p) => this.attachPage(p, true));
      this.context.on('close', () => {
        this.output.appendLine('Context closed');
        this.context = null;
        const urls = this.tabs.urls();
        this.tabs.clear();
        // Auto-reconnect if Chromium crashed unexpectedly.
        if (urls.length > 0 && !this.reconnecting && !this.disposing) {
          void this.reconnect(urls);
        }
      });

      const existing = this.context.pages();
      if (existing.length === 0) {
        const newPage = await this.context.newPage();
        this.attachPage(newPage, true);
      } else {
        for (let i = 0; i < existing.length; i++) {
          this.attachPage(existing[i], i === 0);
        }
      }
    })();

    try {
      await this.launching;
    } finally {
      this.launching = null;
    }
  }

  private attachPage(page: Page, makeActive: boolean): string {
    const existing = this.tabs.getId(page);
    if (existing) {
      if (makeActive) this.tabs.setActive(existing);
      return existing;
    }
    attachPageState(page);
    const id = this.tabs.add(page, makeActive);
    this.output.appendLine(`Tab attached: ${id} ${page.url() || '(blank)'}`);
    return id;
  }

  /**
   * Run fn on the active page or, if tabId is provided, on that specific page.
   * Throws if the requested tab does not exist or has been closed.
   */
  async withPage<T>(tabId: string | undefined, fn: (page: Page) => Promise<T>): Promise<T> {
    await this.launch();
    if (!this.context) throw new Error('Browser context unavailable');

    let page: Page | null;
    if (tabId) {
      page = this.tabs.getPage(tabId);
      if (!page) throw new Error(`tab not found: ${tabId}`);
      if (page.isClosed()) throw new Error(`tab is closed: ${tabId}`);
    } else {
      page = this.tabs.activePage();
      if (!page || page.isClosed()) {
        const fresh = await this.context.newPage();
        this.attachPage(fresh, true);
        page = fresh;
      }
    }
    return fn(page);
  }

  async open(url: string): Promise<void> {
    await this.withPage(undefined, async (page) => {
      this.output.appendLine(`Navigate → ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    });
  }

  async navigate(action: 'back' | 'forward' | 'reload'): Promise<void> {
    await this.withPage(undefined, async (page) => {
      try {
        if (action === 'back') await page.goBack({ timeout: 10000 });
        else if (action === 'forward') await page.goForward({ timeout: 10000 });
        else await page.reload({ timeout: 10000 });
      } catch (err) {
        this.output.appendLine(`Nav ${action} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  // ------ Element picker (Phase 7) ------

  async pickAt(
    tabId: string | undefined,
    x: number,
    y: number
  ): Promise<{
    selector: string;
    text: string;
    tag: string;
    bbox: { x: number; y: number; width: number; height: number };
  } | null> {
    return this.withPage(tabId, async (page) => {
      return page.evaluate(({ px, py }) => {
        const el = document.elementFromPoint(px, py) as Element | null;
        if (!el) return null;

        const tag = el.tagName.toLowerCase();
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);

        // Compute a reasonably-unique CSS selector.
        const generate = (target: Element): string => {
          if (target.id && /^[A-Za-z][\w-]*$/.test(target.id)) {
            const sel = `#${CSS.escape(target.id)}`;
            if (document.querySelectorAll(sel).length === 1) return sel;
          }
          const pieces: string[] = [];
          let cur: Element | null = target;
          let depth = 0;
          while (cur && cur !== document.documentElement && depth < 8) {
            const t = cur.tagName.toLowerCase();
            const cls = Array.from(cur.classList)
              .filter((c) => /^[A-Za-z][\w-]{0,40}$/.test(c))
              .slice(0, 2);
            let piece = t + (cls.length > 0 ? '.' + cls.map(CSS.escape).join('.') : '');
            const parent: Element | null = cur.parentElement;
            if (parent) {
              const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
              if (sameTag.length > 1) {
                const idx = sameTag.indexOf(cur) + 1;
                piece += `:nth-of-type(${idx})`;
              }
            }
            pieces.unshift(piece);
            try {
              const trial = pieces.join(' > ');
              if (document.querySelectorAll(trial).length === 1) return trial;
            } catch {
              /* invalid CSS — keep walking */
            }
            cur = parent;
            depth++;
          }
          return pieces.join(' > ') || tag;
        };

        const r = el.getBoundingClientRect();
        return {
          selector: generate(el),
          text,
          tag,
          bbox: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
        };
      }, { px: x, py: y });
    });
  }

  async elementInfoAt(
    tabId: string | undefined,
    x: number,
    y: number,
    withStyles: boolean
  ): Promise<{
    selector: string;
    tag: string;
    text: string;
    bbox: { x: number; y: number; width: number; height: number };
    styles?: Record<string, string>;
  } | null> {
    const base = await this.pickAt(tabId, x, y);
    if (!base) return null;
    if (!withStyles) return base;
    return this.withPage(tabId, async (page) => {
      const styles = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = window.getComputedStyle(el);
        const props = [
          'color',
          'background-color',
          'background-image',
          'border',
          'border-radius',
          'box-shadow',
          'padding',
          'margin',
          'display',
          'position',
          'width',
          'height',
          'font-family',
          'font-size',
          'font-weight',
          'line-height',
          'text-align',
          'opacity',
          'z-index'
        ];
        const out: Record<string, string> = {};
        for (const p of props) out[p] = cs.getPropertyValue(p);
        return out;
      }, base.selector);
      return { ...base, styles: styles ?? undefined };
    });
  }

  async pickScreenshot(
    tabId: string | undefined,
    selector: string
  ): Promise<Buffer | null> {
    return this.withPage(tabId, async (page) => {
      try {
        const handle = await page.$(selector);
        if (!handle) return null;
        return await handle.screenshot({ type: 'png' });
      } catch {
        return null;
      }
    });
  }

  // ------ Tab tools ------

  async tabNew(url?: string): Promise<TabInfo> {
    await this.launch();
    if (!this.context) throw new Error('Browser context unavailable');
    const page = await this.context.newPage();
    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    const tabId = this.attachPage(page, true);
    let title = '';
    try {
      title = await page.title();
    } catch {
      /* ignore */
    }
    return { tabId, url: page.url(), title, active: true };
  }

  async tabClose(tabId: string): Promise<void> {
    const page = this.tabs.getPage(tabId);
    if (!page) throw new Error(`tab not found: ${tabId}`);
    if (page.isClosed()) return;
    await page.close();
  }

  tabSwitch(tabId: string): void {
    if (!this.tabs.getPage(tabId)) throw new Error(`tab not found: ${tabId}`);
    this.tabs.setActive(tabId);
  }

  async tabList(): Promise<TabInfo[]> {
    const snap = await this.tabs.snapshotWithTitles();
    return snap.tabs;
  }

  // ------ Input + handler dispatch (unchanged from Phase 3) ------

  async handleInput(msg: InputMessage): Promise<void> {
    const page = this.tabs.activePage();
    if (!page || page.isClosed()) return;
    try {
      if (msg.type === 'mouse') {
        const button = mouseButton(msg.button);
        if (msg.action === 'move') {
          await page.mouse.move(msg.x, msg.y);
        } else if (msg.action === 'down') {
          await page.mouse.move(msg.x, msg.y);
          await page.mouse.down({ button });
        } else if (msg.action === 'up') {
          await page.mouse.move(msg.x, msg.y);
          await page.mouse.up({ button });
        }
      } else if (msg.type === 'wheel') {
        await page.mouse.wheel(msg.deltaX, msg.deltaY);
      } else if (msg.type === 'type') {
        await page.keyboard.type(msg.text);
      } else if (msg.type === 'press') {
        const combo = (msg.modifiers ?? []).concat([msg.key]).join('+');
        await page.keyboard.press(combo);
      }
    } catch (err) {
      this.output.appendLine(`Input dispatch error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ------ Phase 9: viewport, reconnect, reset ------

  async setViewport(preset: ViewportPreset | 'custom', custom?: { width: number; height: number }): Promise<void> {
    let dim: { width: number; height: number };
    let storedPreset: ViewportPreset | 'custom';
    if (preset === 'custom') {
      if (!custom) throw new Error('custom viewport requires width and height');
      dim = { width: custom.width, height: custom.height };
      storedPreset = 'custom';
    } else {
      dim = custom ?? VIEWPORT_PRESETS[preset];
      storedPreset = custom ? 'custom' : preset;
    }
    this.viewport = { width: dim.width, height: dim.height, preset: storedPreset };
    await this.launch();
    if (!this.context) return;
    for (const p of this.context.pages()) {
      try {
        await p.setViewportSize(dim);
      } catch {
        /* page may be navigating */
      }
    }
    // Restart screencast on the active page so frame size matches.
    const active = this.tabs.activePage();
    if (active) {
      await this.screencaster.setActive(null);
      await this.screencaster.setActive(active);
    }
    this.output.appendLine(`Viewport → ${dim.width}×${dim.height} (${preset})`);
  }

  private async reconnect(restoreUrls: string[]): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.output.appendLine(`Chromium context closed unexpectedly — reconnecting (${restoreUrls.length} tab${restoreUrls.length === 1 ? '' : 's'})…`);
    vscode.window.showWarningMessage('Claude Browser: Chromium closed unexpectedly. Reconnecting…');
    try {
      await this.launch();
      if (!this.context) return;
      // The fresh context may already have a blank page; navigate it to the first URL,
      // open new tabs for the rest.
      const pages = this.context.pages();
      const first = pages[0];
      if (first && restoreUrls.length > 0) {
        try {
          await first.goto(restoreUrls[0], { waitUntil: 'domcontentloaded', timeout: 20000 });
        } catch {
          /* ignore */
        }
      }
      for (let i = 1; i < restoreUrls.length; i++) {
        try {
          const p = await this.context.newPage();
          this.attachPage(p, false);
          await p.goto(restoreUrls[i], { waitUntil: 'domcontentloaded', timeout: 20000 });
        } catch {
          /* ignore */
        }
      }
      this.output.appendLine('Reconnect complete');
    } catch (err) {
      this.output.appendLine(`Reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.reconnecting = false;
    }
  }

  async resetProfile(): Promise<void> {
    await this.dispose();
    const profile = profileDir(this.extCtx);
    try {
      await fs.rm(profile, { recursive: true, force: true });
      this.output.appendLine(`Profile dir removed: ${profile}`);
    } catch (err) {
      this.output.appendLine(`Profile remove failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    try {
      await this.screencaster.dispose();
      if (this.context) {
        try {
          await this.context.close();
        } catch {
          /* ignore */
        }
        this.context = null;
      }
      this.tabs.clear();
    } finally {
      this.disposing = false;
    }
  }
}
