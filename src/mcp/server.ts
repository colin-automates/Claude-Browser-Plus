import * as http from 'node:http';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as vscode from 'vscode';
import { AuthManager } from './auth.js';
import { registerTools } from './tools.js';
import type { BrowserManager } from '../browser/manager.js';
import type { BrowserPanelProvider } from '../panel/provider.js';

export interface McpEndpoint {
  port: number;
  token: string;
  url: string;
  claudeMcpAddCommand: string;
}

export class McpHttpServer {
  private server: http.Server | null = null;
  private endpoint: McpEndpoint | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly auth: AuthManager,
    private readonly output: vscode.OutputChannel,
    private readonly browser: BrowserManager,
    private readonly provider: BrowserPanelProvider | null = null
  ) {}

  getEndpoint(): McpEndpoint | null {
    return this.endpoint;
  }

  async start(): Promise<McpEndpoint> {
    if (this.endpoint) return this.endpoint;

    const token = await this.auth.getToken();

    const httpServer = http.createServer((req, res) => {
      this.handle(req, res, token).catch((err: unknown) => {
        const m = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`MCP request error: ${m}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal' }));
        }
      });
    });

    return new Promise<McpEndpoint>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to bind MCP server port'));
          return;
        }
        this.server = httpServer;
        const url = `http://127.0.0.1:${addr.port}/mcp`;
        this.endpoint = {
          port: addr.port,
          token,
          url,
          claudeMcpAddCommand: `claude mcp add --transport http --scope user claude-browser-plus ${url} --header "Authorization: Bearer ${token}"`
        };
        this.output.appendLine(`MCP server listening on ${url}`);
        resolve(this.endpoint);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    this.endpoint = null;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /**
   * Re-issue token. The HTTP server stays bound to the same port, but old token
   * stops working immediately.
   */
  async rotateToken(): Promise<McpEndpoint | null> {
    const newToken = await this.auth.rotate();
    if (!this.endpoint) return null;
    const url = this.endpoint.url;
    this.endpoint = {
      port: this.endpoint.port,
      token: newToken,
      url,
      claudeMcpAddCommand: `claude mcp add --transport http --scope user claude-browser-plus ${url} --header "Authorization: Bearer ${newToken}"`
    };
    return this.endpoint;
  }

  private async readBody(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  private writeJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    expectedToken: string
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    // Health check (no auth) — useful for debugging connection without token
    if (req.method === 'GET' && url.pathname === '/health') {
      this.writeJson(res, 200, { status: 'ok' });
      return;
    }

    // Auth gate for all other endpoints
    const authHeader =
      req.headers['authorization'] ??
      (Array.isArray(req.headers['authorization'])
        ? req.headers['authorization'][0]
        : undefined);
    if (!this.auth.validate(typeof authHeader === 'string' ? authHeader : undefined, expectedToken)) {
      this.writeJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (url.pathname !== '/mcp') {
      this.writeJson(res, 404, { error: 'not_found' });
      return;
    }

    if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
      res.writeHead(405, { Allow: 'POST, GET, DELETE' });
      res.end();
      return;
    }

    // Build a fresh stateless session per request.
    const mcp = new McpServer(
      { name: 'claude-browser-plus', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    registerTools(mcp, this.browser, this.context, this.output, this.provider);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    res.on('close', () => {
      void transport.close();
    });

    await mcp.connect(transport);

    let parsed: unknown;
    if (req.method === 'POST') {
      const body = await this.readBody(req);
      if (body.length > 0) {
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          this.writeJson(res, 400, { error: 'invalid_json' });
          return;
        }
      }
    }

    await transport.handleRequest(req, res, parsed);
  }
}
