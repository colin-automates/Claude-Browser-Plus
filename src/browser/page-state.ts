import type { Page } from 'playwright-core';

const MAX_CONSOLE = 1000;
const MAX_NETWORK = 1000;

export interface ConsoleEntry {
  type: string;
  text: string;
  url: string;
  lineNumber?: number;
  timestamp: number;
}

export interface NetworkEntry {
  url: string;
  method: string;
  status?: number;
  contentType?: string;
  failed?: boolean;
  resourceType?: string;
  timestamp: number;
}

class PageState {
  consoleEvents: ConsoleEntry[] = [];
  consoleCursor = 0;
  networkEvents: NetworkEntry[] = [];
  networkCursor = 0;

  attach(page: Page): void {
    page.on('console', (msg) => {
      const loc = msg.location();
      this.consoleEvents.push({
        type: msg.type(),
        text: msg.text(),
        url: loc.url ?? '',
        lineNumber: loc.lineNumber,
        timestamp: Date.now()
      });
      this.trimConsole();
    });

    page.on('pageerror', (err) => {
      this.consoleEvents.push({
        type: 'error',
        text: `${err.name}: ${err.message}`,
        url: '',
        timestamp: Date.now()
      });
      this.trimConsole();
    });

    page.on('requestfinished', async (req) => {
      try {
        const res = await req.response();
        if (!res) return;
        const headers = res.headers();
        this.networkEvents.push({
          url: req.url(),
          method: req.method(),
          status: res.status(),
          contentType: headers['content-type'],
          resourceType: req.resourceType(),
          timestamp: Date.now()
        });
        this.trimNetwork();
      } catch {
        /* ignore */
      }
    });

    page.on('requestfailed', (req) => {
      const failure = req.failure();
      this.networkEvents.push({
        url: req.url(),
        method: req.method(),
        failed: true,
        contentType: failure?.errorText,
        resourceType: req.resourceType(),
        timestamp: Date.now()
      });
      this.trimNetwork();
    });
  }

  private trimConsole(): void {
    if (this.consoleEvents.length <= MAX_CONSOLE) return;
    const drop = this.consoleEvents.length - MAX_CONSOLE;
    this.consoleEvents.splice(0, drop);
    this.consoleCursor = Math.max(0, this.consoleCursor - drop);
  }
  private trimNetwork(): void {
    if (this.networkEvents.length <= MAX_NETWORK) return;
    const drop = this.networkEvents.length - MAX_NETWORK;
    this.networkEvents.splice(0, drop);
    this.networkCursor = Math.max(0, this.networkCursor - drop);
  }

  getConsole(sinceLastCall: boolean): ConsoleEntry[] {
    if (!sinceLastCall) return this.consoleEvents.slice();
    const out = this.consoleEvents.slice(this.consoleCursor);
    this.consoleCursor = this.consoleEvents.length;
    return out;
  }

  getNetwork(filter: string | undefined, sinceLastCall: boolean): NetworkEntry[] {
    let events = sinceLastCall
      ? this.networkEvents.slice(this.networkCursor)
      : this.networkEvents.slice();
    if (filter) {
      try {
        const re = new RegExp(filter, 'i');
        events = events.filter((e) => re.test(e.url));
      } catch {
        /* invalid regex — return unfiltered */
      }
    }
    if (sinceLastCall) this.networkCursor = this.networkEvents.length;
    return events;
  }
}

const states = new WeakMap<Page, PageState>();

export function attachPageState(page: Page): void {
  if (states.has(page)) return;
  const state = new PageState();
  state.attach(page);
  states.set(page, state);
}

export function getPageState(page: Page): PageState | null {
  return states.get(page) ?? null;
}
