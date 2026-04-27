import * as vscode from 'vscode';
import { BrowserPanelProvider } from './panel/provider.js';
import { BrowserManager } from './browser/manager.js';
import type { InputMessage } from './browser/manager.js';
import { AuthManager } from './mcp/auth.js';
import { McpHttpServer } from './mcp/server.js';
import { autoRegister } from './mcp/registration.js';
import {
  sendPickedToClaude,
  sendAnnotationToClaude,
  type PickedElement,
  type AnnotationForBridge
} from './claude-bridge.js';
import { pickCoordinator, type PickResult } from './pick-coordinator.js';
import { clearCaptures } from './captures.js';

let output: vscode.OutputChannel;
let manager: BrowserManager | null = null;
let mcp: McpHttpServer | null = null;
let userControl = true;

function printConnectionInfo(out: vscode.OutputChannel, command: string): void {
  const bar = '─'.repeat(60);
  out.appendLine(bar);
  out.appendLine('MCP server ready.');
  out.appendLine('To connect Claude Code, run:');
  out.appendLine('');
  out.appendLine(`  ${command}`);
  out.appendLine('');
  out.appendLine('Then restart your Claude Code session.');
  out.appendLine('Use "Claude Browser: Copy MCP Connection Command" to copy this line.');
  out.appendLine(bar);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  process.env.PLAYWRIGHT_BROWSERS_PATH = context.globalStorageUri.fsPath;

  output = vscode.window.createOutputChannel('Claude Browser');
  context.subscriptions.push(output);
  output.appendLine('Claude Browser activated');
  output.appendLine(`Browsers path: ${process.env.PLAYWRIGHT_BROWSERS_PATH}`);

  const provider = new BrowserPanelProvider(context, output);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(BrowserPanelProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  manager = new BrowserManager(context, output, {
    onFrame: (buf) => provider.postFrame(buf),
    onUrlChange: (url) => provider.postUrl(url),
    onTabsChanged: (snapshot) => provider.postTabs(snapshot)
  });
  provider.onReady = () => {
    if (manager) provider.postViewport(manager.getViewport());
  };
  context.subscriptions.push({ dispose: () => manager?.dispose() });

  provider.setHandler({
    async onInput(msg: unknown) {
      if (!userControl || !manager) return;
      await manager.handleInput(msg as InputMessage);
    },
    async onNavigate(url: string) {
      if (!manager) return;
      try {
        provider.postStatus(`Opening ${url}…`);
        await manager.open(url);
        provider.postStatus(`Loaded ${url}`);
      } catch (err) {
        const msgText = err instanceof Error ? err.message : String(err);
        output.appendLine(`Open failed: ${msgText}`);
        provider.postStatus(`Error: ${msgText}`);
      }
    },
    async onNavAction(action) {
      await manager?.navigate(action);
    },
    onControlToggle(on: boolean) {
      userControl = on;
      output.appendLine(`User control ${on ? 'enabled' : 'released'}`);
    },
    async onTabAction(action, tabId) {
      if (!manager) return;
      try {
        if (action === 'new') {
          await manager.tabNew();
        } else if (action === 'close' && tabId) {
          await manager.tabClose(tabId);
        } else if (action === 'switch' && tabId) {
          manager.tabSwitch(tabId);
        }
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        output.appendLine(`Tab ${action} failed: ${m}`);
      }
    },
    async onAnnotateSend(payload) {
      if (!manager) return;
      try {
        const pngBuf = Buffer.from(
          payload.png instanceof ArrayBuffer
            ? new Uint8Array(payload.png)
            : payload.png
        );
        let url = '';
        try {
          await manager.withPage(undefined, async (page) => {
            url = page.url();
          });
        } catch {
          /* ignore */
        }

        // For each annotation, ask the page about the deepest element under its center.
        const enriched: AnnotationForBridge[] = [];
        for (const a of payload.annotations) {
          const cx = Math.round(a.bbox.x + a.bbox.width / 2);
          const cy = Math.round(a.bbox.y + a.bbox.height / 2);
          let info: { selector: string; tag: string; styles?: Record<string, string> } | null = null;
          try {
            info = await manager.elementInfoAt(undefined, cx, cy, true);
          } catch (e) {
            output.appendLine(
              `elementInfoAt failed: ${e instanceof Error ? e.message : String(e)}`
            );
          }
          enriched.push({
            id: a.id,
            type: a.type,
            color: a.color,
            bbox: a.bbox,
            text: a.text,
            target_selector: info?.selector,
            target_tag: info?.tag,
            target_styles: info?.styles
          });
        }

        await sendAnnotationToClaude({
          url,
          viewport: payload.viewport,
          png: pngBuf,
          annotations: enriched,
          context,
          output
        });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        output.appendLine(`Annotate send failed: ${m}`);
        vscode.window.showErrorMessage(`Claude Browser annotate failed: ${m}`);
      }
    },
    async onSetViewport(preset) {
      if (!manager) return;
      try {
        await manager.setViewport(preset);
        provider.postViewport(manager.getViewport());
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        output.appendLine(`Set viewport failed: ${m}`);
      }
    },
    async onPick(action, x, y) {
      if (!manager) return;
      if (action === 'cancel') {
        pickCoordinator.cancelPending('user cancelled');
        return;
      }
      if (typeof x !== 'number' || typeof y !== 'number') return;
      try {
        const info = await manager.pickAt(undefined, x, y);
        if (action === 'hover') {
          provider.postPickHover(info ? info.bbox : null);
          return;
        }
        // click
        if (!info) {
          vscode.window.showWarningMessage('No element at that position.');
          return;
        }
        const result: PickResult = {
          url: '',
          selector: info.selector,
          tag: info.tag,
          text: info.text,
          bbox: info.bbox
        };
        // Fill URL from active page best-effort
        try {
          await manager.withPage(undefined, async (page) => {
            result.url = page.url();
          });
        } catch {
          /* ignore */
        }

        // If a Claude tool call is waiting, resolve it instead of routing to clipboard.
        if (pickCoordinator.fulfill(result)) {
          output.appendLine('Pick fulfilled tool call');
          return;
        }

        // Otherwise: take element screenshot and send to Claude clipboard bridge.
        const png = await manager.pickScreenshot(undefined, info.selector);
        const picked: PickedElement = {
          url: result.url,
          selector: result.selector,
          tag: result.tag,
          text: result.text,
          bbox: result.bbox,
          screenshot: png
        };
        await sendPickedToClaude(picked, context, output);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        output.appendLine(`Pick ${action} failed: ${m}`);
      }
    }
  });

  // MCP server
  const auth = new AuthManager(context);
  mcp = new McpHttpServer(context, auth, output, manager, provider);
  context.subscriptions.push({ dispose: () => mcp?.stop() });

  try {
    const endpoint = await mcp.start();
    printConnectionInfo(output, endpoint.claudeMcpAddCommand);

    // Auto-register with Claude Code so the user doesn't have to copy/paste anything.
    const reg = await autoRegister(endpoint, context, output);
    if (reg.status === 'success') {
      if (reg.firstTime) {
        const detail = reg.via === 'config' ? ' (wrote ~/.claude.json directly)' : '';
        vscode.window.showInformationMessage(
          `Claude Browser is registered with Claude Code${detail}. Restart your Claude Code chat to load the tools.`
        );
      } else if (reg.portChanged) {
        vscode.window.showInformationMessage(
          'Claude Browser MCP port changed. Restart your Claude Code chat to reconnect.'
        );
      }
    } else {
      const choice = await vscode.window.showErrorMessage(
        `Claude Browser auto-registration failed: ${reg.message}`,
        'Copy Command',
        'Dismiss'
      );
      if (choice === 'Copy Command') {
        await vscode.commands.executeCommand('aiBrowser.copyMcpCommand');
      }
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    output.appendLine(`Failed to start MCP server: ${m}`);
    vscode.window.showErrorMessage(`Claude Browser MCP server failed to start: ${m}`);
  }

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('aiBrowser.showPanel', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.aiBrowser');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiBrowser.openUrl', async () => {
      const input = await vscode.window.showInputBox({
        prompt: 'URL to open',
        value: 'https://example.com',
        ignoreFocusOut: true
      });
      if (!input) return;
      const url = /^[a-z]+:\/\//i.test(input) ? input : `https://${input}`;

      await vscode.commands.executeCommand('workbench.view.extension.aiBrowser');

      try {
        provider.postStatus(`Opening ${url}…`);
        await manager!.open(url);
        provider.postStatus(`Loaded ${url}`);
      } catch (err) {
        const msgText = err instanceof Error ? err.message : String(err);
        output.appendLine(`Open failed: ${msgText}`);
        provider.postStatus(`Error: ${msgText}`);
        vscode.window.showErrorMessage(`Claude Browser: ${msgText}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiBrowser.copyMcpCommand', async () => {
      const endpoint = mcp?.getEndpoint();
      if (!endpoint) {
        vscode.window.showWarningMessage('Claude Browser MCP server is not running yet.');
        return;
      }
      await vscode.env.clipboard.writeText(endpoint.claudeMcpAddCommand);
      vscode.window.showInformationMessage(
        'Copied. Paste it into a terminal, then restart your Claude Code session.'
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiBrowser.resetProfile', async () => {
      const choice = await vscode.window.showWarningMessage(
        'Reset the Claude Browser project profile? Cookies, logins, and cached site data will be lost. This affects only the current workspace.',
        { modal: true },
        'Reset'
      );
      if (choice !== 'Reset') return;
      try {
        await manager?.resetProfile();
        vscode.window.showInformationMessage('Claude Browser: profile reset. Open a URL to relaunch.');
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Claude Browser: reset failed: ${m}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiBrowser.clearCaptures', async () => {
      try {
        const n = await clearCaptures(context);
        vscode.window.showInformationMessage(
          n === 0 ? 'Claude Browser: captures already empty.' : `Claude Browser: removed ${n} capture file(s).`
        );
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Claude Browser: clear failed: ${m}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiBrowser.rotateToken', async () => {
      const choice = await vscode.window.showWarningMessage(
        'Rotate Claude Browser auth token? Existing Claude Code sessions will lose access until reconnected.',
        { modal: true },
        'Rotate'
      );
      if (choice !== 'Rotate') return;
      const updated = await mcp?.rotateToken();
      if (updated) {
        printConnectionInfo(output, updated.claudeMcpAddCommand);
        await vscode.env.clipboard.writeText(updated.claudeMcpAddCommand);
        vscode.window.showInformationMessage(
          'Token rotated and new connection command copied to clipboard.'
        );
      }
    })
  );

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.text = '$(globe) Claude Browser';
  statusItem.tooltip = 'Open the Claude Browser panel';
  statusItem.command = 'aiBrowser.showPanel';
  statusItem.show();
  context.subscriptions.push(statusItem);
}

export async function deactivate(): Promise<void> {
  output?.appendLine('Claude Browser deactivating');
  await mcp?.stop();
  await manager?.dispose();
  manager = null;
  mcp = null;
}
