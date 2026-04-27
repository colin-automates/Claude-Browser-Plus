import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

const SECRET_KEY = 'ai-browser-mcp-token-v1';

export class AuthManager {
  private cached: string | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async getToken(): Promise<string> {
    if (this.cached) return this.cached;
    let token = await this.context.secrets.get(SECRET_KEY);
    if (!token) {
      token = crypto.randomBytes(32).toString('hex');
      await this.context.secrets.store(SECRET_KEY, token);
    }
    this.cached = token;
    return token;
  }

  async rotate(): Promise<string> {
    const token = crypto.randomBytes(32).toString('hex');
    await this.context.secrets.store(SECRET_KEY, token);
    this.cached = token;
    return token;
  }

  validate(authHeader: string | undefined, expected: string): boolean {
    if (!authHeader) return false;
    const m = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (!m) return false;
    const provided = m[1].trim();
    if (provided.length !== expected.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    } catch {
      return false;
    }
  }
}
