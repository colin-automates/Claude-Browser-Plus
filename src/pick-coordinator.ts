export interface PickResult {
  url: string;
  selector: string;
  tag: string;
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
}

type Pending = {
  resolve: (r: PickResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class PickCoordinator {
  private pending: Pending | null = null;

  hasPending(): boolean {
    return this.pending !== null;
  }

  /** Returns a promise the MCP tool awaits. Cancels any prior pending pick. */
  awaitPick(timeoutMs: number): Promise<PickResult> {
    this.cancelPending('superseded by new request');
    return new Promise<PickResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending) {
          this.pending = null;
          reject(new Error(`pick timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
    });
  }

  /** Resolves the pending tool call; returns true if there was one waiting. */
  fulfill(result: PickResult): boolean {
    if (!this.pending) return false;
    const p = this.pending;
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve(result);
    return true;
  }

  cancelPending(reason: string): void {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
}

export const pickCoordinator = new PickCoordinator();
