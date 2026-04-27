import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';

export function profileDir(context: vscode.ExtensionContext): string {
  const folders = vscode.workspace.workspaceFolders;
  const key = folders && folders.length > 0 ? folders[0].uri.fsPath : '__no_workspace__';
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  return path.join(context.globalStorageUri.fsPath, 'profiles', hash);
}
