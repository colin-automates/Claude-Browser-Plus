import type { Page } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export interface TabInfo {
  tabId: string;
  url: string;
  title: string;
  active: boolean;
  /** Filled in by BrowserManager (registry has no vscode dependency). */
  isOwnProject?: boolean;
}

export interface TabRegistryEvents {
  changed: (snapshot: TabSnapshot) => void;
  activeChanged: (page: Page | null) => void;
}

export interface TabSnapshot {
  tabs: TabInfo[];
  activeTabId: string | null;
}

export class TabRegistry extends EventEmitter {
  private readonly idToPage = new Map<string, Page>();
  private readonly pageToId = new WeakMap<Page, string>();
  private activeId: string | null = null;

  override on<E extends keyof TabRegistryEvents>(event: E, listener: TabRegistryEvents[E]): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  private fireChanged(): void {
    super.emit('changed', this.snapshot());
  }
  private fireActiveChanged(): void {
    super.emit('activeChanged', this.activePage());
  }

  add(page: Page, makeActive: boolean): string {
    const existing = this.pageToId.get(page);
    if (existing) {
      if (makeActive) this.setActive(existing);
      return existing;
    }
    const tabId = randomUUID();
    this.idToPage.set(tabId, page);
    this.pageToId.set(page, tabId);

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.fireChanged();
    });
    page.on('domcontentloaded', () => this.fireChanged());
    page.on('close', () => this.removeByPage(page));

    if (makeActive || this.activeId === null) {
      this.activeId = tabId;
      this.fireActiveChanged();
    }
    this.fireChanged();
    return tabId;
  }

  private removeByPage(page: Page): void {
    const id = this.pageToId.get(page);
    if (!id) return;
    this.idToPage.delete(id);
    if (this.activeId === id) {
      const next = this.idToPage.keys().next().value as string | undefined;
      this.activeId = next ?? null;
      this.fireActiveChanged();
    }
    this.fireChanged();
  }

  setActive(tabId: string): boolean {
    if (!this.idToPage.has(tabId)) return false;
    if (this.activeId === tabId) return true;
    this.activeId = tabId;
    this.fireActiveChanged();
    this.fireChanged();
    return true;
  }

  activePage(): Page | null {
    if (!this.activeId) return null;
    return this.idToPage.get(this.activeId) ?? null;
  }

  activeTabId(): string | null {
    return this.activeId;
  }

  getPage(tabId: string): Page | null {
    return this.idToPage.get(tabId) ?? null;
  }

  getId(page: Page): string | null {
    return this.pageToId.get(page) ?? null;
  }

  size(): number {
    return this.idToPage.size;
  }

  /** URLs of all currently-tracked tabs (for crash-reconnect snapshots). */
  urls(): string[] {
    const out: string[] = [];
    for (const page of this.idToPage.values()) {
      const u = page.url();
      if (u && u !== 'about:blank') out.push(u);
    }
    return out;
  }

  /**
   * Synchronous snapshot. Titles are filled in lazily via async title-fetching;
   * here we return the URL as a placeholder when no cached title is available.
   */
  snapshot(): TabSnapshot {
    const tabs: TabInfo[] = [];
    for (const [tabId, page] of this.idToPage) {
      tabs.push({
        tabId,
        url: page.url(),
        title: '',
        active: tabId === this.activeId
      });
    }
    return { tabs, activeTabId: this.activeId };
  }

  async snapshotWithTitles(): Promise<TabSnapshot> {
    const tabs: TabInfo[] = [];
    for (const [tabId, page] of this.idToPage) {
      let title = '';
      try {
        title = await page.title();
      } catch {
        /* page closed mid-iteration */
      }
      tabs.push({
        tabId,
        url: page.url(),
        title,
        active: tabId === this.activeId
      });
    }
    return { tabs, activeTabId: this.activeId };
  }

  clear(): void {
    this.idToPage.clear();
    this.activeId = null;
    this.fireActiveChanged();
    this.fireChanged();
  }
}
