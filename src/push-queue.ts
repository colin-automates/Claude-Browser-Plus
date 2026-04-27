/**
 * Pending pushes from the user → Claude. Decoupled from MCP transport so any
 * tool dispatcher can drain it.
 *
 * Used because the MCP HTTP server is stateless per request: server→client
 * notifications can't reach Claude between calls. Instead we enqueue here,
 * piggyback a one-line note onto the next tool response, and let Claude pull
 * via `browser_get_user_pushes`.
 */

export interface PickPush {
  kind: 'pick';
  createdAt: number;
  /** Markdown payload — same shape that's also written to the clipboard. */
  markdown: string;
  /** Disk path of the element screenshot, if any. */
  screenshotPath?: string;
  selector: string;
  url: string;
}

export interface AnnotationPush {
  kind: 'annotation';
  createdAt: number;
  markdown: string;
  pngPath: string;
  jsonPath: string;
  url: string;
  count: number;
}

export type Push = PickPush | AnnotationPush;

class PushQueue {
  private items: Push[] = [];

  enqueue(p: Push): void {
    this.items.push(p);
  }

  drain(): Push[] {
    const out = this.items;
    this.items = [];
    return out;
  }

  size(): number {
    return this.items.length;
  }

  /** "1 pending push (1 annotation)" — for the piggyback note. */
  peekSummary(): string {
    if (this.items.length === 0) return '';
    let picks = 0;
    let annotations = 0;
    for (const it of this.items) {
      if (it.kind === 'pick') picks++;
      else annotations++;
    }
    const parts: string[] = [];
    if (picks > 0) parts.push(`${picks} pick${picks === 1 ? '' : 's'}`);
    if (annotations > 0) parts.push(`${annotations} annotation${annotations === 1 ? '' : 's'}`);
    const total = this.items.length;
    return `User has ${total} pending push${total === 1 ? '' : 'es'} (${parts.join(', ')})`;
  }
}

export const pushQueue = new PushQueue();
