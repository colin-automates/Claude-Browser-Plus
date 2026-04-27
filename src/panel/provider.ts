import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type { TabSnapshot } from '../browser/tabs.js';

export interface PanelMessageHandler {
  onInput(msg: unknown): void | Promise<void>;
  onNavigate(url: string): void | Promise<void>;
  onNavAction(action: 'back' | 'forward' | 'reload'): void | Promise<void>;
  onControlToggle(on: boolean): void;
  onTabAction(action: 'new' | 'close' | 'switch', tabId?: string): void | Promise<void>;
  onPick(action: 'hover' | 'click' | 'cancel', x?: number, y?: number): void | Promise<void>;
  onAnnotateSend(payload: AnnotateSendPayload): void | Promise<void>;
  onSetViewport(preset: 'desktop' | 'laptop' | 'tablet' | 'mobile'): void | Promise<void>;
}

export interface AnnotateSendPayload {
  png: ArrayBuffer | Uint8Array;
  annotations: Array<{
    id: string;
    type: 'rect' | 'free' | 'arrow' | 'text';
    color: string;
    bbox: { x: number; y: number; width: number; height: number };
    text?: string;
  }>;
  viewport: { width: number; height: number };
}

export class BrowserPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'aiBrowser.panel';

  private currentView: vscode.WebviewView | null = null;
  private handler: PanelMessageHandler | null = null;
  onReady: (() => void) | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  setHandler(handler: PanelMessageHandler): void {
    this.handler = handler;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.currentView = view;

    const { webview } = view;
    const webviewRoot = vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview');

    webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewRoot]
    };

    webview.html = this.buildHtml(webview, webviewRoot);

    view.onDidDispose(() => {
      this.output.appendLine('Webview disposed');
      this.currentView = null;
    });

    webview.onDidReceiveMessage((message: { kind?: string; [k: string]: unknown }) => {
      if (!message || typeof message !== 'object') return;
      const k = message.kind;
      if (k === 'ready') {
        this.output.appendLine('Webview ready');
        if (this.onReady) {
          try {
            this.onReady();
          } catch (err) {
            this.output.appendLine(`onReady threw: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return;
      }
      if (k === 'input' && this.handler) {
        void this.handler.onInput(message);
        return;
      }
      if (k === 'navigate' && typeof message.url === 'string' && this.handler) {
        void this.handler.onNavigate(message.url);
        return;
      }
      if (k === 'nav' && typeof message.action === 'string' && this.handler) {
        const a = message.action;
        if (a === 'back' || a === 'forward' || a === 'reload') {
          void this.handler.onNavAction(a);
        }
        return;
      }
      if (k === 'control' && typeof message.on === 'boolean' && this.handler) {
        this.handler.onControlToggle(message.on);
        return;
      }
      if (k === 'tab' && typeof message.action === 'string' && this.handler) {
        const a = message.action;
        if (a === 'new' || a === 'close' || a === 'switch') {
          void this.handler.onTabAction(a, typeof message.tabId === 'string' ? message.tabId : undefined);
        }
        return;
      }
      if (k === 'pick' && typeof message.action === 'string' && this.handler) {
        const a = message.action;
        if (a === 'hover' || a === 'click' || a === 'cancel') {
          const x = typeof message.x === 'number' ? message.x : undefined;
          const y = typeof message.y === 'number' ? message.y : undefined;
          void this.handler.onPick(a, x, y);
        }
        return;
      }
      if (k === 'setViewport' && this.handler && typeof message.preset === 'string') {
        const p = message.preset;
        if (p === 'desktop' || p === 'laptop' || p === 'tablet' || p === 'mobile') {
          void this.handler.onSetViewport(p);
        }
        return;
      }
      if (k === 'annotateSend' && this.handler) {
        const payload = message as unknown as AnnotateSendPayload;
        if (payload.png && Array.isArray(payload.annotations) && payload.viewport) {
          void this.handler.onAnnotateSend(payload);
        }
        return;
      }
      this.output.appendLine(`Unhandled webview message: ${JSON.stringify(message)}`);
    });

    this.output.appendLine('Webview resolved');
  }

  postFrame(buf: ArrayBuffer): void {
    if (!this.currentView) return;
    void this.currentView.webview.postMessage({ kind: 'frame', buf });
  }

  postStatus(text: string): void {
    if (!this.currentView) return;
    void this.currentView.webview.postMessage({ kind: 'status', text });
  }

  postUrl(url: string): void {
    if (!this.currentView) return;
    void this.currentView.webview.postMessage({ kind: 'url', url });
  }

  postTabs(snapshot: TabSnapshot): void {
    if (!this.currentView) return;
    void this.currentView.webview.postMessage({ kind: 'tabs', ...snapshot });
  }

  postPickHover(bbox: { x: number; y: number; width: number; height: number } | null): void {
    if (!this.currentView) return;
    void this.currentView.webview.postMessage({ kind: 'pickHover', bbox });
  }

  postPickMode(on: boolean): void {
    if (!this.currentView) return;
    void this.currentView.webview.postMessage({ kind: 'pickMode', on });
  }

  postViewport(vp: { width: number; height: number; preset: string }): void {
    if (!this.currentView) return;
    void this.currentView.webview.postMessage({ kind: 'viewport', ...vp });
  }

  hasView(): boolean {
    return this.currentView !== null;
  }

  private buildHtml(webview: vscode.Webview, webviewRoot: vscode.Uri): string {
    const htmlPath = vscode.Uri.joinPath(webviewRoot, 'index.html').fsPath;
    let html = fs.readFileSync(htmlPath, 'utf8');

    const nonce = crypto.randomBytes(16).toString('base64');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'canvas.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'styles.css'));

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');

    html = html
      .replace(/{{CSP}}/g, csp)
      .replace(/{{NONCE}}/g, nonce)
      .replace(/{{STYLE_URI}}/g, styleUri.toString())
      .replace(/{{SCRIPT_URI}}/g, scriptUri.toString())
      .replace(/{{CSP_SOURCE}}/g, webview.cspSource);

    return html;
  }
}
