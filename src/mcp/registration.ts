import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { McpEndpoint } from './server.js';

const execAsync = promisify(cp.exec);

export type RegistrationStatus =
  | { status: 'success'; firstTime: boolean; portChanged: boolean; via: 'cli' | 'config' }
  | { status: 'error'; message: string };

const SERVER_NAME = 'claude-browser-plus';
/** Older builds registered as `ai-browser`; clean it up on first run. */
const LEGACY_SERVER_NAMES = ['ai-browser'];
const LAST_PORT_KEY = 'mcp-last-registered-port';
const CLAUDE_CONFIG_PATH = path.join(os.homedir(), '.claude.json');

function isClaudeMissingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not found|not recognized|ENOENT|is not recognized/i.test(msg);
}

interface ServerConfig {
  type: 'http';
  url: string;
  headers: Record<string, string>;
}

function buildServerEntry(endpoint: McpEndpoint): ServerConfig {
  return {
    type: 'http',
    url: endpoint.url,
    headers: { Authorization: `Bearer ${endpoint.token}` }
  };
}

async function tryCliRegister(
  endpoint: McpEndpoint,
  output: vscode.OutputChannel
): Promise<{ ok: true } | { ok: false; missing: boolean; message?: string }> {
  try {
    await execAsync('claude --version', { timeout: 8000 });
  } catch (err) {
    if (isClaudeMissingError(err)) return { ok: false, missing: true };
    const msg = err instanceof Error ? err.message : String(err);
    output.appendLine(`claude --version failed: ${msg}; will still attempt CLI add`);
  }

  for (const legacy of LEGACY_SERVER_NAMES) {
    try {
      await execAsync(`claude mcp remove ${legacy} --scope user`, { timeout: 8000 });
      output.appendLine(`Removed legacy MCP entry: ${legacy}`);
    } catch {
      /* not registered */
    }
  }
  try {
    await execAsync(`claude mcp remove ${SERVER_NAME} --scope user`, { timeout: 8000 });
  } catch {
    /* not registered yet */
  }

  const headerArg = `--header "Authorization: Bearer ${endpoint.token}"`;
  const cmd = `claude mcp add --transport http --scope user ${SERVER_NAME} ${endpoint.url} ${headerArg}`;
  try {
    const { stdout } = await execAsync(cmd, { timeout: 12000 });
    if (stdout.trim()) output.appendLine(`claude mcp add: ${stdout.trim()}`);
    return { ok: true };
  } catch (err) {
    if (isClaudeMissingError(err)) return { ok: false, missing: true };
    return { ok: false, missing: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function readClaudeConfig(): Promise<Record<string, unknown>> {
  try {
    const text = await fs.readFile(CLAUDE_CONFIG_PATH, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeClaudeConfigAtomic(config: Record<string, unknown>): Promise<void> {
  const tmp = `${CLAUDE_CONFIG_PATH}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
  await fs.rename(tmp, CLAUDE_CONFIG_PATH);
}

async function tryConfigRegister(
  endpoint: McpEndpoint,
  output: vscode.OutputChannel
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const config = await readClaudeConfig();

    // Top-level mcpServers in ~/.claude.json is the user-scope bucket.
    let mcpServers: Record<string, unknown>;
    const existing = config.mcpServers;
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      mcpServers = existing as Record<string, unknown>;
    } else {
      mcpServers = {};
    }

    for (const legacy of LEGACY_SERVER_NAMES) {
      if (legacy in mcpServers) {
        delete mcpServers[legacy];
        output.appendLine(`Removed legacy MCP entry: ${legacy}`);
      }
    }
    mcpServers[SERVER_NAME] = buildServerEntry(endpoint);
    config.mcpServers = mcpServers;

    await writeClaudeConfigAtomic(config);
    output.appendLine(`Wrote ${SERVER_NAME} entry directly to ${CLAUDE_CONFIG_PATH}`);
    return { ok: true };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { ok: false, message: m };
  }
}

export async function autoRegister(
  endpoint: McpEndpoint,
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<RegistrationStatus> {
  const lastPort = context.globalState.get<number>(LAST_PORT_KEY);
  const firstTime = lastPort === undefined;
  const portChanged = lastPort !== endpoint.port;

  // Try CLI first — if it works, that's the documented path
  const cli = await tryCliRegister(endpoint, output);
  if (cli.ok) {
    await context.globalState.update(LAST_PORT_KEY, endpoint.port);
    output.appendLine(`Auto-registered via CLI on port ${endpoint.port}`);
    return { status: 'success', firstTime, portChanged, via: 'cli' };
  }

  // Fallback: edit ~/.claude.json directly
  output.appendLine(
    cli.missing
      ? 'Claude Code CLI not on PATH; falling back to direct config write'
      : `CLI add failed (${cli.message ?? 'unknown'}); falling back to direct config write`
  );

  const cfg = await tryConfigRegister(endpoint, output);
  if (cfg.ok) {
    await context.globalState.update(LAST_PORT_KEY, endpoint.port);
    output.appendLine(`Auto-registered via config write on port ${endpoint.port}`);
    return { status: 'success', firstTime, portChanged, via: 'config' };
  }

  return { status: 'error', message: cfg.message };
}

export async function unregister(output: vscode.OutputChannel): Promise<void> {
  // Try CLI removal first
  try {
    await execAsync(`claude mcp remove ${SERVER_NAME} --scope user`, { timeout: 8000 });
    output.appendLine(`Unregistered ${SERVER_NAME} via CLI`);
    return;
  } catch {
    /* try direct edit */
  }

  try {
    const config = await readClaudeConfig();
    if (config.mcpServers && typeof config.mcpServers === 'object') {
      const servers = config.mcpServers as Record<string, unknown>;
      if (SERVER_NAME in servers) {
        delete servers[SERVER_NAME];
        await writeClaudeConfigAtomic(config);
        output.appendLine(`Unregistered ${SERVER_NAME} via config write`);
      }
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    output.appendLine(`Unregister failed: ${m}`);
  }
}
