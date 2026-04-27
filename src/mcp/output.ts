import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { captureDir } from '../captures.js';

const INLINE_THRESHOLD = 256 * 1024;

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export async function emitImage(
  buffer: Buffer,
  mimeType: 'image/png' | 'image/jpeg',
  context: vscode.ExtensionContext,
  meta?: Record<string, unknown>
): Promise<ToolContent[]> {
  if (buffer.length <= INLINE_THRESHOLD) {
    return [{ type: 'image', data: buffer.toString('base64'), mimeType }];
  }
  const id = crypto.randomUUID();
  const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
  const dir = await captureDir(context);
  const filePath = path.join(dir, `${id}.${ext}`);
  await fs.writeFile(filePath, buffer);

  const lines = [
    `Screenshot too large for inline (${(buffer.length / 1024).toFixed(0)} KB > 256 KB threshold).`,
    `capture_id: ${id}`,
    `path: ${filePath}`,
    `size: ${buffer.length} bytes`,
    `content_type: ${mimeType}`
  ];
  if (meta) {
    for (const [k, v] of Object.entries(meta)) lines.push(`${k}: ${String(v)}`);
  }
  lines.push('');
  lines.push('Use the Read tool to view the file.');
  return [{ type: 'text', text: lines.join('\n') }];
}

export async function emitText(
  text: string,
  context: vscode.ExtensionContext,
  ext = 'txt'
): Promise<ToolContent[]> {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= INLINE_THRESHOLD) {
    return [{ type: 'text', text }];
  }
  const id = crypto.randomUUID();
  const dir = await captureDir(context);
  const filePath = path.join(dir, `${id}.${ext}`);
  await fs.writeFile(filePath, text, 'utf8');
  const preview = text.slice(0, 2000);
  return [
    {
      type: 'text',
      text: [
        `Output too large for inline (${(bytes / 1024).toFixed(0)} KB > 256 KB threshold).`,
        `capture_id: ${id}`,
        `path: ${filePath}`,
        `size: ${bytes} bytes`,
        '',
        '--- Preview (first 2 KB) ---',
        preview
      ].join('\n')
    }
  ];
}
