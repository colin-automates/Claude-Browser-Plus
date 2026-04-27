import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { captureDir } from './captures.js';
import { pushQueue } from './push-queue.js';

export interface PickedElement {
  url: string;
  selector: string;
  tag: string;
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
  screenshot?: Buffer | null;
}

const FOCUS_COMMAND_CANDIDATES = [
  'workbench.view.extension.claude-code',
  'workbench.view.extension.claude-code-extension',
  'claude-code.openChat',
  'claude.openChat'
];

async function tryFocusClaude(): Promise<boolean> {
  for (const cmd of FOCUS_COMMAND_CANDIDATES) {
    try {
      await vscode.commands.executeCommand(cmd);
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

export async function sendPickedToClaude(
  picked: PickedElement,
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<void> {
  let screenshotPath: string | undefined;
  if (picked.screenshot) {
    const id = crypto.randomUUID();
    const dir = await captureDir(context);
    screenshotPath = path.join(dir, `pick-${id}.png`);
    await fs.writeFile(screenshotPath, picked.screenshot);
  }

  const lines = [
    `**Element picked from Claude Browser**`,
    ``,
    `- URL: ${picked.url}`,
    `- Tag: \`${picked.tag}\``,
    `- Selector: \`${picked.selector}\``,
    `- Bounds: x=${picked.bbox.x} y=${picked.bbox.y} w=${picked.bbox.width} h=${picked.bbox.height}`,
    `- Text: "${picked.text}"`
  ];
  if (screenshotPath) {
    lines.push('', `Screenshot of the element saved to:`);
    lines.push(`\`${screenshotPath}\``);
    lines.push('', '_Use the Read tool to view the image when needed._');
  }

  const payload = lines.join('\n');
  await vscode.env.clipboard.writeText(payload);

  pushQueue.enqueue({
    kind: 'pick',
    createdAt: Date.now(),
    markdown: payload,
    screenshotPath,
    selector: picked.selector,
    url: picked.url
  });

  output.appendLine(`Picked → ${picked.tag}${picked.selector ? ' (' + picked.selector + ')' : ''}`);
  if (screenshotPath) output.appendLine(`Screenshot → ${screenshotPath}`);

  vscode.window.showInformationMessage(
    'Sent — Claude will see it on the next browser tool call. (Also copied to clipboard as a fallback.)'
  );
}

export async function sendTextToClaude(
  text: string,
  output: vscode.OutputChannel
): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  await tryFocusClaude();
  output.appendLine(`Sent ${text.length} chars to Claude (clipboard)`);
  vscode.window.showInformationMessage('Copied to clipboard. Paste into Claude Code.');
}

export interface AnnotationForBridge {
  id: string;
  type: 'rect' | 'free' | 'arrow' | 'text';
  color: string;
  bbox: { x: number; y: number; width: number; height: number };
  text?: string;
  target_selector?: string;
  target_tag?: string;
  target_styles?: Record<string, string>;
}

export async function sendAnnotationToClaude(opts: {
  url: string;
  viewport: { width: number; height: number };
  png: Buffer;
  annotations: AnnotationForBridge[];
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
}): Promise<void> {
  const id = crypto.randomUUID();
  const dir = await captureDir(opts.context);
  const pngPath = path.join(dir, `annotate-${id}.png`);
  const jsonPath = path.join(dir, `annotate-${id}.json`);

  const structured = {
    url: opts.url,
    viewport: opts.viewport,
    annotation_count: opts.annotations.length,
    annotations: opts.annotations
  };

  await fs.writeFile(pngPath, opts.png);
  await fs.writeFile(jsonPath, JSON.stringify(structured, null, 2), 'utf8');

  const lines = [
    `**Annotated screenshot from Claude Browser**`,
    ``,
    `- URL: ${opts.url}`,
    `- Viewport: ${opts.viewport.width} × ${opts.viewport.height}`,
    `- Annotations: ${opts.annotations.length}`,
    ``,
    `Composite PNG (frame + annotations):`,
    `\`${pngPath}\``,
    ``,
    `Structured JSON (with target_selector / target_styles per annotation):`,
    `\`${jsonPath}\``,
    ``,
    `_Use the Read tool on either path. The JSON identifies the underlying DOM element each annotation overlays._`
  ];

  const lite: AnnotationForBridge[] = opts.annotations.slice(0, 5).map((a) => ({
    id: a.id,
    type: a.type,
    color: a.color,
    bbox: a.bbox,
    text: a.text,
    target_selector: a.target_selector,
    target_tag: a.target_tag
  }));
  if (lite.length > 0) {
    lines.push('', '_Quick summary:_', '```json', JSON.stringify(lite, null, 2), '```');
  }

  const payload = lines.join('\n');
  await vscode.env.clipboard.writeText(payload);

  pushQueue.enqueue({
    kind: 'annotation',
    createdAt: Date.now(),
    markdown: payload,
    pngPath,
    jsonPath,
    url: opts.url,
    count: opts.annotations.length
  });

  opts.output.appendLine(
    `Annotation → ${opts.annotations.length} annotation(s), png=${pngPath}, json=${jsonPath}`
  );

  vscode.window.showInformationMessage(
    'Sent — Claude will see it on the next browser tool call. (Also copied to clipboard as a fallback.)'
  );
}
