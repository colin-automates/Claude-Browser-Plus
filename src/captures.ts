import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

export async function captureRoot(context: vscode.ExtensionContext): Promise<string> {
  const wf = vscode.workspace.workspaceFolders?.[0];
  const base = wf ? wf.uri.fsPath : context.globalStorageUri.fsPath;
  const root = path.join(base, '.claude-browser');

  await fs.mkdir(root, { recursive: true });

  const gitignore = path.join(root, '.gitignore');
  try {
    await fs.access(gitignore);
  } catch {
    await fs.writeFile(gitignore, '*\n', 'utf8');
  }

  return root;
}

export async function captureDir(context: vscode.ExtensionContext): Promise<string> {
  const root = await captureRoot(context);
  const dir = path.join(root, 'captures');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function clearCaptures(context: vscode.ExtensionContext): Promise<number> {
  const dir = await captureDir(context);
  const entries = await fs.readdir(dir);
  let count = 0;
  for (const e of entries) {
    try {
      await fs.unlink(path.join(dir, e));
      count++;
    } catch {
      /* skip */
    }
  }
  return count;
}
