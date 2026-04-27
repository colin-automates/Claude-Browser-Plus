import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BrowserManager } from '../browser/manager.js';
import { settle } from '../browser/settle.js';
import { emitImage, emitText, type ToolContent } from './output.js';
import { getPageState } from '../browser/page-state.js';
import { pickCoordinator } from '../pick-coordinator.js';
import { pushQueue, type Push } from '../push-queue.js';
import type { BrowserPanelProvider } from '../panel/provider.js';

const tabIdProp = {
  tab_id: { type: 'string', description: 'Optional tab id (from browser_tab_list). Defaults to active tab.' }
};

const TOOLS = [
  {
    name: 'browser_open',
    description: 'Navigate the active tab (or the tab specified by tab_id) to a URL. Returns the resolved URL and page title.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open (https:// is added if missing).' },
        ...tabIdProp
      },
      required: ['url']
    }
  },
  {
    name: 'browser_navigate',
    description: 'Navigate back, forward, or reload the active tab.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['back', 'forward', 'reload'] },
        ...tabIdProp
      },
      required: ['direction']
    }
  },
  {
    name: 'browser_wait',
    description:
      'Wait for a condition. strategy="selector" waits for the selector to appear; "network_idle" waits for network quiescence; "timeout" sleeps for value milliseconds.',
    inputSchema: {
      type: 'object',
      properties: {
        strategy: { type: 'string', enum: ['selector', 'network_idle', 'timeout'] },
        value: { description: 'Selector for "selector"; ms for "timeout"; max-wait ms for "network_idle".' },
        ...tabIdProp
      },
      required: ['strategy', 'value']
    }
  },
  {
    name: 'browser_click',
    description: 'Click on a page. Provide either a CSS selector or absolute viewport coordinates {x,y}.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'object',
          properties: {
            selector: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' }
          }
        },
        ...tabIdProp
      },
      required: ['target']
    }
  },
  {
    name: 'browser_type',
    description: 'Type text. If selector is provided, fills that element; otherwise types at the current focus.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        selector: { type: 'string' },
        clear: { type: 'boolean', description: 'When selector is set, clear the field first. Default true.' },
        ...tabIdProp
      },
      required: ['text']
    }
  },
  {
    name: 'browser_press_key',
    description: 'Press a single key using Playwright key syntax (e.g. "Enter", "Control+A", "ArrowDown").',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' }, ...tabIdProp },
      required: ['key']
    }
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the active page.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
        amount_px: { type: 'number', description: 'Pixels for up/down. Defaults to 600. Ignored for top/bottom.' },
        ...tabIdProp
      },
      required: ['direction']
    }
  },
  {
    name: 'browser_screenshot',
    description:
      'PNG screenshot. Inline if under 256 KB, else saves to .claude-browser/captures/ and returns the path.',
    inputSchema: {
      type: 'object',
      properties: {
        full_page: { type: 'boolean', description: 'Capture the full scrollable page. Default false.' },
        selector: { type: 'string', description: 'When set, capture only the matching element.' },
        ...tabIdProp
      }
    }
  },
  {
    name: 'browser_tab_new',
    description: 'Open a new tab. The new tab becomes active and screencast streams it. Optionally navigate immediately.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } }
    }
  },
  {
    name: 'browser_tab_close',
    description: 'Close a tab by tab_id.',
    inputSchema: {
      type: 'object',
      properties: { tab_id: { type: 'string' } },
      required: ['tab_id']
    }
  },
  {
    name: 'browser_tab_switch',
    description: 'Switch the active tab. The screencast follows.',
    inputSchema: {
      type: 'object',
      properties: { tab_id: { type: 'string' } },
      required: ['tab_id']
    }
  },
  {
    name: 'browser_tab_list',
    description: 'List all open tabs with id, url, title, and active flag.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_a11y_snapshot',
    description:
      'YAML accessibility tree of the page. Far more token-efficient than a screenshot for understanding page structure and finding click targets. Each line is "role \"name\"" with nested children.',
    inputSchema: {
      type: 'object',
      properties: { ...tabIdProp }
    }
  },
  {
    name: 'browser_eval',
    description:
      'Evaluate JavaScript in the page context. Return value must be JSON-serializable. Use document/window globals as expected.',
    inputSchema: {
      type: 'object',
      properties: {
        javascript: { type: 'string', description: 'JS expression or async function body. Wrapped in `async () => { ... }`.' },
        ...tabIdProp
      },
      required: ['javascript']
    }
  },
  {
    name: 'browser_get_console',
    description: 'Console + page errors. Defaults to "since last call" semantics with a per-tab cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        since_last_call: { type: 'boolean', description: 'Default true. False returns the entire ring buffer.' },
        ...tabIdProp
      }
    }
  },
  {
    name: 'browser_get_network',
    description: 'Network requests with method/status/content-type. "since_last_call" defaults to true with a per-tab cursor. filter is a case-insensitive regex against the URL.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string' },
        since_last_call: { type: 'boolean' },
        ...tabIdProp
      }
    }
  },
  {
    name: 'extract_dom_resources',
    description:
      'List resource URLs referenced by the DOM grouped by type. type can be "image", "font", "icon", "link", "media", or "all".',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['image', 'font', 'icon', 'link', 'media', 'all'] },
        selector: { type: 'string', description: 'Optional scope; defaults to whole document.' },
        ...tabIdProp
      }
    }
  },
  {
    name: 'extract_styles',
    description:
      'Computed styles. With selector, returns the element\'s computed-style values. Without selector (or with selector="body"), returns a page palette: top colors, font stack, dominant font sizes.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of CSS property names to return for the selector.'
        },
        ...tabIdProp
      }
    }
  },
  {
    name: 'extract_html',
    description: 'HTML of the page or matched element.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'When set, returns outerHTML of the first match. Otherwise full page HTML.' },
        ...tabIdProp
      }
    }
  },
  {
    name: 'browser_pick_element',
    description:
      'Ask the user to click on an element in the Claude Browser panel. Returns selector, tag, text, and bbox of the clicked element. Times out after 60 seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Optional prompt to display in the panel toast.' }
      }
    }
  },
  {
    name: 'browser_set_viewport',
    description:
      'Set the viewport to a preset (desktop / laptop / tablet / mobile) or a custom width × height. Affects every tab and the live screencast. Default at startup is desktop unless overridden by aiBrowser.defaultViewport.',
    inputSchema: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: ['desktop', 'laptop', 'tablet', 'mobile', 'custom'] },
        width: { type: 'number', description: 'Required when preset="custom".' },
        height: { type: 'number', description: 'Required when preset="custom".' }
      },
      required: ['preset']
    }
  },
  {
    name: 'browser_get_user_pushes',
    description:
      "Drain the queue of artifacts the user proactively sent from the Claude Browser panel (Pick or Annotate → Send to Claude). Each push includes file paths and structured details. Idempotent: a push is only returned once. Call this whenever the system note '[claude-browser] User has N pending push(es)…' appears in any tool result.",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'download_through_session',
    description:
      'Download a URL using the active page\'s session (cookies, headers, auth). Saves to a workspace-relative path; rejects path traversal outside the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        save_path: { type: 'string', description: 'Path relative to workspace root (or extension storage if no workspace).' },
        ...tabIdProp
      },
      required: ['url', 'save_path']
    }
  }
];

interface ToolArgs {
  [k: string]: unknown;
}

function asString(v: unknown): string {
  if (typeof v !== 'string') throw new Error('expected string');
  return v;
}
function asNumber(v: unknown): number {
  if (typeof v !== 'number') throw new Error('expected number');
  return v;
}
function tabIdOf(args: ToolArgs): string | undefined {
  return typeof args.tab_id === 'string' ? args.tab_id : undefined;
}

function ok(content: ToolContent[]): { content: ToolContent[] } {
  return { content };
}
function err(message: string): { content: ToolContent[]; isError: true } {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

async function dispatch(
  name: string,
  args: ToolArgs,
  browser: BrowserManager,
  context: vscode.ExtensionContext,
  provider: BrowserPanelProvider | null
): Promise<{ content: ToolContent[]; isError?: true }> {
  const tabId = tabIdOf(args);

  switch (name) {
    case 'browser_open': {
      const raw = asString(args.url);
      const url = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
      return browser.withPage(tabId, async (page) => {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await settle(page);
        const title = await page.title().catch(() => '');
        return ok([{ type: 'text', text: `Loaded ${page.url()}\nTitle: ${title}` }]);
      });
    }
    case 'browser_navigate': {
      const direction = asString(args.direction);
      if (direction !== 'back' && direction !== 'forward' && direction !== 'reload') {
        return err(`invalid direction: ${direction}`);
      }
      return browser.withPage(tabId, async (page) => {
        if (direction === 'back') await page.goBack({ timeout: 10000 });
        else if (direction === 'forward') await page.goForward({ timeout: 10000 });
        else await page.reload({ timeout: 10000 });
        await settle(page);
        return ok([{ type: 'text', text: `${direction} → ${page.url()}` }]);
      });
    }
    case 'browser_wait': {
      const strategy = asString(args.strategy);
      return browser.withPage(tabId, async (page) => {
        if (strategy === 'selector') {
          const sel = asString(args.value);
          await page.waitForSelector(sel, { timeout: 10000 });
          return ok([{ type: 'text', text: `Selector found: ${sel}` }]);
        }
        if (strategy === 'network_idle') {
          const max = typeof args.value === 'number' ? args.value : 5000;
          await page.waitForLoadState('networkidle', { timeout: max });
          return ok([{ type: 'text', text: `Network idle reached (≤ ${max}ms)` }]);
        }
        if (strategy === 'timeout') {
          const ms = asNumber(args.value);
          await page.waitForTimeout(ms);
          return ok([{ type: 'text', text: `Waited ${ms}ms` }]);
        }
        return err(`invalid strategy: ${strategy}`);
      });
    }
    case 'browser_click': {
      const target = args.target as { selector?: unknown; x?: unknown; y?: unknown } | undefined;
      if (!target || typeof target !== 'object') return err('target required');
      return browser.withPage(tabId, async (page) => {
        if (typeof target.selector === 'string') {
          await page.click(target.selector, { timeout: 5000 });
        } else if (typeof target.x === 'number' && typeof target.y === 'number') {
          await page.mouse.click(target.x, target.y);
        } else {
          return err('target requires selector or {x,y}');
        }
        await settle(page);
        return ok([{ type: 'text', text: 'Clicked' }]);
      });
    }
    case 'browser_type': {
      const text = asString(args.text);
      const selector = typeof args.selector === 'string' ? args.selector : undefined;
      const clear = args.clear !== false;
      return browser.withPage(tabId, async (page) => {
        if (selector) {
          if (clear) await page.fill(selector, '');
          await page.fill(selector, text);
        } else {
          await page.keyboard.type(text);
        }
        await settle(page);
        return ok([{ type: 'text', text: `Typed ${text.length} char(s)` }]);
      });
    }
    case 'browser_press_key': {
      const key = asString(args.key);
      return browser.withPage(tabId, async (page) => {
        await page.keyboard.press(key);
        await settle(page);
        return ok([{ type: 'text', text: `Pressed ${key}` }]);
      });
    }
    case 'browser_scroll': {
      const direction = asString(args.direction);
      const amount = typeof args.amount_px === 'number' ? args.amount_px : 600;
      return browser.withPage(tabId, async (page) => {
        if (direction === 'up') await page.mouse.wheel(0, -amount);
        else if (direction === 'down') await page.mouse.wheel(0, amount);
        else if (direction === 'top') await page.evaluate(() => window.scrollTo(0, 0));
        else if (direction === 'bottom')
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        else return err(`invalid direction: ${direction}`);
        await settle(page);
        return ok([{ type: 'text', text: `Scrolled ${direction}` }]);
      });
    }
    case 'browser_screenshot': {
      const fullPage = args.full_page === true;
      const selector = typeof args.selector === 'string' ? args.selector : undefined;
      return browser.withPage(tabId, async (page) => {
        let buffer: Buffer;
        if (selector) {
          const el = await page.$(selector);
          if (!el) return err(`selector not found: ${selector}`);
          buffer = await el.screenshot({ type: 'png' });
        } else {
          buffer = await page.screenshot({ fullPage, type: 'png' });
        }
        const cfg = vscode.workspace.getConfiguration('aiBrowser');
        const highRes = cfg.get<boolean>('highRes') === true;
        const meta = {
          url: page.url(),
          full_page: fullPage,
          long_edge_cap: highRes ? 2576 : 1568
        };
        const content = await emitImage(buffer, 'image/png', context, meta);
        return ok(content);
      });
    }
    case 'browser_tab_new': {
      const raw = typeof args.url === 'string' ? args.url : undefined;
      const url = raw ? (/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`) : undefined;
      const info = await browser.tabNew(url);
      return ok([
        {
          type: 'text',
          text: JSON.stringify(info, null, 2)
        }
      ]);
    }
    case 'browser_tab_close': {
      const id = asString(args.tab_id);
      await browser.tabClose(id);
      return ok([{ type: 'text', text: `Closed tab ${id}` }]);
    }
    case 'browser_tab_switch': {
      const id = asString(args.tab_id);
      browser.tabSwitch(id);
      return ok([{ type: 'text', text: `Switched to ${id}` }]);
    }
    case 'browser_tab_list': {
      const tabs = await browser.tabList();
      return ok([{ type: 'text', text: JSON.stringify(tabs, null, 2) }]);
    }
    case 'browser_a11y_snapshot': {
      return browser.withPage(tabId, async (page) => {
        const yaml = await page.locator('body').ariaSnapshot();
        const out = await emitText(yaml, context, 'yaml');
        return ok(out);
      });
    }
    case 'browser_eval': {
      const code = asString(args.javascript);
      return browser.withPage(tabId, async (page) => {
        // Wrap so users can use either an expression ("1+1") or statements ("return 1+1")
        const wrapped = `(async () => { ${code.includes('return ') ? code : 'return (' + code + ');'} })()`;
        const result = await page.evaluate(wrapped);
        let serialized: string;
        try {
          serialized = JSON.stringify(result, null, 2) ?? 'undefined';
        } catch {
          serialized = String(result);
        }
        const out = await emitText(serialized, context, 'json');
        return ok(out);
      });
    }
    case 'browser_get_console': {
      const sinceLast = args.since_last_call !== false;
      return browser.withPage(tabId, async (page) => {
        const state = getPageState(page);
        const events = state ? state.getConsole(sinceLast) : [];
        const out = await emitText(JSON.stringify(events, null, 2), context, 'json');
        return ok(out);
      });
    }
    case 'browser_get_network': {
      const filter = typeof args.filter === 'string' ? args.filter : undefined;
      const sinceLast = args.since_last_call !== false;
      return browser.withPage(tabId, async (page) => {
        const state = getPageState(page);
        const events = state ? state.getNetwork(filter, sinceLast) : [];
        const out = await emitText(JSON.stringify(events, null, 2), context, 'json');
        return ok(out);
      });
    }
    case 'extract_dom_resources': {
      const type = (typeof args.type === 'string' ? args.type : 'all') as
        | 'image'
        | 'font'
        | 'icon'
        | 'link'
        | 'media'
        | 'all';
      const selector = typeof args.selector === 'string' ? args.selector : undefined;
      return browser.withPage(tabId, async (page) => {
        const result = await page.evaluate(
          ({ scope, kind }) => {
            const root: Document | Element = scope
              ? (document.querySelector(scope) ?? document)
              : document;
            const out: Record<string, string[]> = {
              image: [],
              font: [],
              icon: [],
              link: [],
              media: []
            };
            const abs = (u: string) => {
              try {
                return new URL(u, document.baseURI).href;
              } catch {
                return u;
              }
            };

            if (kind === 'image' || kind === 'all') {
              root.querySelectorAll('img[src]').forEach((el) => {
                const v = (el as HTMLImageElement).src;
                if (v) out.image.push(abs(v));
              });
              root.querySelectorAll('source[srcset]').forEach((el) => {
                const ss = (el as HTMLSourceElement).srcset;
                ss.split(',').forEach((s) => {
                  const u = s.trim().split(/\s+/)[0];
                  if (u) out.image.push(abs(u));
                });
              });
              root.querySelectorAll<HTMLElement>('[style*="background-image"]').forEach((el) => {
                const m = /url\((['"]?)([^'")]+)\1\)/.exec(el.style.backgroundImage);
                if (m) out.image.push(abs(m[2]));
              });
            }
            if (kind === 'icon' || kind === 'all') {
              document
                .querySelectorAll<HTMLLinkElement>('link[rel*="icon"]')
                .forEach((el) => {
                  if (el.href) out.icon.push(el.href);
                });
            }
            if (kind === 'link' || kind === 'all') {
              root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((el) => {
                if (el.href) out.link.push(el.href);
              });
            }
            if (kind === 'media' || kind === 'all') {
              root.querySelectorAll<HTMLMediaElement>('video[src],audio[src]').forEach((el) => {
                if (el.src) out.media.push(abs(el.src));
              });
              root.querySelectorAll<HTMLSourceElement>('video source,audio source').forEach((el) => {
                if (el.src) out.media.push(abs(el.src));
              });
            }
            if (kind === 'font' || kind === 'all') {
              for (const sheet of Array.from(document.styleSheets)) {
                try {
                  const rules = sheet.cssRules;
                  if (!rules) continue;
                  for (const rule of Array.from(rules)) {
                    const cssText = (rule as CSSRule).cssText;
                    if (!cssText.includes('@font-face')) continue;
                    const re = /url\((['"]?)([^'")]+)\1\)/g;
                    let m: RegExpExecArray | null;
                    while ((m = re.exec(cssText)) !== null) out.font.push(abs(m[2]));
                  }
                } catch {
                  /* cross-origin sheet */
                }
              }
            }

            for (const k of Object.keys(out)) {
              out[k] = Array.from(new Set(out[k]));
            }
            if (kind !== 'all') {
              return { [kind]: out[kind] };
            }
            return out;
          },
          { scope: selector, kind: type }
        );
        const json = JSON.stringify(result, null, 2);
        const out = await emitText(json, context, 'json');
        return ok(out);
      });
    }
    case 'extract_styles': {
      const selector = typeof args.selector === 'string' ? args.selector : undefined;
      const props = Array.isArray(args.properties)
        ? (args.properties as unknown[]).filter((x): x is string => typeof x === 'string')
        : undefined;
      return browser.withPage(tabId, async (page) => {
        if (selector) {
          const result = await page.evaluate(
            ({ sel, properties }) => {
              const el = document.querySelector(sel);
              if (!el) return { error: 'not found' };
              const cs = window.getComputedStyle(el);
              const out: Record<string, string> = {};
              const list = properties && properties.length > 0
                ? properties
                : Array.from(cs).slice(0, 200);
              for (const p of list) out[p] = cs.getPropertyValue(p);
              return out;
            },
            { sel: selector, properties: props }
          );
          const out = await emitText(JSON.stringify(result, null, 2), context, 'json');
          return ok(out);
        }
        // Palette (selectorless)
        const palette = await page.evaluate(() => {
          const colorCount = new Map<string, number>();
          const fontCount = new Map<string, number>();
          const sizeCount = new Map<string, number>();
          const all = document.querySelectorAll('*');
          let n = 0;
          for (const el of Array.from(all)) {
            n++;
            if (n > 4000) break;
            const cs = window.getComputedStyle(el);
            const c = cs.color;
            const bg = cs.backgroundColor;
            const f = cs.fontFamily;
            const fs = cs.fontSize;
            if (c && c !== 'rgba(0, 0, 0, 0)') colorCount.set(c, (colorCount.get(c) ?? 0) + 1);
            if (bg && bg !== 'rgba(0, 0, 0, 0)') colorCount.set(bg, (colorCount.get(bg) ?? 0) + 1);
            if (f) fontCount.set(f, (fontCount.get(f) ?? 0) + 1);
            if (fs) sizeCount.set(fs, (sizeCount.get(fs) ?? 0) + 1);
          }
          const top = (m: Map<string, number>, k: number) =>
            Array.from(m.entries())
              .sort((a, b) => b[1] - a[1])
              .slice(0, k)
              .map(([v, count]) => ({ value: v, count }));
          return {
            sampled_elements: Math.min(n, 4000),
            colors: top(colorCount, 12),
            fonts: top(fontCount, 6),
            font_sizes: top(sizeCount, 8)
          };
        });
        const out = await emitText(JSON.stringify(palette, null, 2), context, 'json');
        return ok(out);
      });
    }
    case 'extract_html': {
      const selector = typeof args.selector === 'string' ? args.selector : undefined;
      return browser.withPage(tabId, async (page) => {
        let html: string;
        if (selector) {
          html = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            return el ? el.outerHTML : '';
          }, selector);
          if (!html) return err(`selector not found: ${selector}`);
        } else {
          html = await page.content();
        }
        const out = await emitText(html, context, 'html');
        return ok(out);
      });
    }
    case 'browser_pick_element': {
      if (!provider || !provider.hasView()) {
        return err('Claude Browser panel is not open — open it before requesting a pick.');
      }
      const promptText = typeof args.prompt === 'string' ? args.prompt : 'Click on an element in the panel.';
      provider.postStatus(`Claude asked: ${promptText}`);
      provider.postPickMode(true);
      try {
        const picked = await pickCoordinator.awaitPick(60_000);
        return ok([{ type: 'text', text: JSON.stringify(picked, null, 2) }]);
      } catch (e) {
        provider.postPickMode(false);
        const m = e instanceof Error ? e.message : String(e);
        return err(m);
      }
    }
    case 'browser_set_viewport': {
      const preset = asString(args.preset);
      if (preset === 'custom') {
        const w = asNumber(args.width);
        const h = asNumber(args.height);
        if (w < 200 || h < 200 || w > 4000 || h > 4000) {
          return err('custom viewport must be between 200 and 4000 pixels per dimension');
        }
        await browser.setViewport('custom', { width: w, height: h });
        const vp = browser.getViewport();
        return ok([{ type: 'text', text: `Viewport → ${vp.width}×${vp.height} (custom)` }]);
      }
      if (preset !== 'desktop' && preset !== 'laptop' && preset !== 'tablet' && preset !== 'mobile') {
        return err(`invalid preset: ${preset}`);
      }
      await browser.setViewport(preset);
      const vp = browser.getViewport();
      return ok([{ type: 'text', text: `Viewport → ${vp.width}×${vp.height} (${preset})` }]);
    }
    case 'browser_get_user_pushes': {
      const pushes = pushQueue.drain();
      if (pushes.length === 0) {
        return ok([{ type: 'text', text: 'No pending pushes.' }]);
      }
      const blocks: ToolContent[] = [
        {
          type: 'text',
          text: `Draining ${pushes.length} push${pushes.length === 1 ? '' : 'es'} from Claude Browser panel.`
        }
      ];
      for (let i = 0; i < pushes.length; i++) {
        const p: Push = pushes[i];
        const header = `--- Push ${i + 1}/${pushes.length} (${p.kind}) ---`;
        blocks.push({ type: 'text', text: `${header}\n${p.markdown}` });
      }
      return ok(blocks);
    }
    case 'download_through_session': {
      const url = asString(args.url);
      const savePath = asString(args.save_path);
      return browser.withPage(tabId, async (page) => {
        // Resolve the destination root: workspace if available, else extension storage
        const wf = vscode.workspace.workspaceFolders?.[0];
        const root = wf ? wf.uri.fsPath : context.globalStorageUri.fsPath;
        const resolved = path.resolve(root, savePath);
        const rel = path.relative(root, resolved);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          return err(`save_path escapes workspace root: ${savePath}`);
        }

        await fs.mkdir(path.dirname(resolved), { recursive: true });

        const apiCtx = page.context().request;
        const res = await apiCtx.fetch(url);
        if (!res.ok()) {
          return err(`download failed: HTTP ${res.status()}`);
        }
        const body = await res.body();
        await fs.writeFile(resolved, body);

        const sizeKb = (body.length / 1024).toFixed(1);
        return ok([
          {
            type: 'text',
            text: `Saved ${url}\n→ ${resolved}\nsize: ${sizeKb} KB\nstatus: ${res.status()}\ncontent-type: ${res.headers()['content-type'] ?? 'unknown'}`
          }
        ]);
      });
    }
    default:
      return err(`unknown tool: ${name}`);
  }
}

export function registerTools(
  server: Server,
  browser: BrowserManager,
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  provider: BrowserPanelProvider | null = null
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as ToolArgs;
    output.appendLine(`tool ▶ ${name} ${JSON.stringify(args)}`);
    try {
      const result = await dispatch(name, args, browser, context, provider);
      // Piggyback: if the user has proactively pushed pick/annotate artifacts,
      // prepend a one-line note so Claude knows to drain the queue. Skip for
      // browser_get_user_pushes itself to avoid a self-referential loop.
      if (name !== 'browser_get_user_pushes' && pushQueue.size() > 0) {
        const note: ToolContent = {
          type: 'text',
          text: `[claude-browser] ${pushQueue.peekSummary()}. Call browser_get_user_pushes to retrieve.`
        };
        result.content = [note, ...result.content];
      }
      const status = result.isError ? 'error' : 'ok';
      output.appendLine(`tool ◀ ${name} ${status}`);
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      output.appendLine(`tool ✗ ${name} ${message}`);
      if (e instanceof Error && e.stack && Buffer.byteLength(e.stack, 'utf8') > 1024) {
        const persisted = await emitText(e.stack, context, 'log');
        return { isError: true, content: persisted };
      }
      return err(message);
    }
  });
}
