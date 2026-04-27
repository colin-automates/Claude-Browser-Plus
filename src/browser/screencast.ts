import type { CDPSession, Page } from 'playwright-core';

interface ScreencastFrameParams {
  data: string;
  sessionId: number;
  metadata?: { offsetTop?: number; pageScaleFactor?: number };
}

export interface ScreencastOptions {
  quality: number;
  fps: number;
}

export class Screencaster {
  private readonly sessions = new WeakMap<Page, CDPSession>();
  private activePage: Page | null = null;
  private opts: ScreencastOptions;

  constructor(
    private readonly onFrame: (jpeg: Buffer, page: Page) => void,
    initial: ScreencastOptions
  ) {
    this.opts = { ...initial };
  }

  /** Underlying Chromium screencast runs at ~60Hz; everyNthFrame=2 → 30fps. */
  private nthFromFps(fps: number): number {
    const clamped = Math.max(5, Math.min(60, Math.round(fps)));
    return Math.max(1, Math.round(60 / clamped));
  }

  async setOptions(next: ScreencastOptions): Promise<void> {
    this.opts = { ...next };
    if (this.activePage) {
      const session = this.sessions.get(this.activePage);
      if (!session) return;
      try {
        await session.send('Page.stopScreencast');
        await session.send('Page.startScreencast', {
          format: 'jpeg',
          quality: this.opts.quality,
          everyNthFrame: this.nthFromFps(this.opts.fps),
          maxWidth: 1920,
          maxHeight: 1200
        });
      } catch {
        /* page may have closed */
      }
    }
  }

  async setActive(page: Page | null): Promise<void> {
    if (this.activePage === page) return;

    if (this.activePage) {
      const prev = this.sessions.get(this.activePage);
      if (prev) {
        try {
          await prev.send('Page.stopScreencast');
        } catch {
          /* page may have closed */
        }
      }
    }

    this.activePage = page;
    if (!page) return;

    let session = this.sessions.get(page);
    if (!session) {
      session = await page.context().newCDPSession(page);
      this.sessions.set(page, session);

      const targetSession = session;
      session.on('Page.screencastFrame', (params: ScreencastFrameParams) => {
        const bytes = Buffer.from(params.data, 'base64');
        this.onFrame(bytes, page);
        targetSession
          .send('Page.screencastFrameAck', { sessionId: params.sessionId })
          .catch(() => {
            /* page may have closed */
          });
      });

      page.on('close', () => {
        this.sessions.delete(page);
        if (this.activePage === page) this.activePage = null;
      });
    }

    await session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: this.opts.quality,
      everyNthFrame: this.nthFromFps(this.opts.fps),
      maxWidth: 1920,
      maxHeight: 1200
    });
  }

  async dispose(): Promise<void> {
    if (!this.activePage) return;
    const session = this.sessions.get(this.activePage);
    if (!session) return;
    try {
      await session.send('Page.stopScreencast');
    } catch {
      /* ignore */
    }
    try {
      await session.detach();
    } catch {
      /* ignore */
    }
    this.activePage = null;
  }
}
