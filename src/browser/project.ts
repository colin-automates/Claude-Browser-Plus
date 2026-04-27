import * as vscode from 'vscode';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

function configHosts(): string[] {
  const raw = vscode.workspace.getConfiguration('aiBrowser').get<string[]>('projectHosts', []);
  return raw.map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0);
}

/**
 * True when the URL belongs to "your own project":
 *  - localhost / 127.0.0.1 / 0.0.0.0 / ::1 / *.localhost
 *  - file:// path inside the open workspace
 *  - host (or subdomain of host) listed in aiBrowser.projectHosts
 */
export function isOwnProject(url: string): boolean {
  if (!url || url === 'about:blank') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol === 'file:') {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return false;
    const fsPath = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    return folders.some((f) => fsPath.toLowerCase().startsWith(f.uri.fsPath.toLowerCase()));
  }

  const host = parsed.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host)) return true;
  if (host.endsWith('.localhost')) return true;

  for (const h of configHosts()) {
    if (host === h || host.endsWith('.' + h)) return true;
  }
  return false;
}
