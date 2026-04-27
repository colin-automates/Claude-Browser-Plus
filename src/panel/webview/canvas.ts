import { Annotator, type CanvasGeom as AnnotateGeom } from './annotate.js';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
};

interface FrameMessage {
  kind: 'frame';
  buf: ArrayBuffer | Uint8Array;
}
interface StatusMessage {
  kind: 'status';
  text: string;
}
interface UrlMessage {
  kind: 'url';
  url: string;
}
interface TabInfo {
  tabId: string;
  url: string;
  title: string;
  active: boolean;
  isOwnProject?: boolean;
}
interface TabsMessage {
  kind: 'tabs';
  tabs: TabInfo[];
  activeTabId: string | null;
}
interface PickHoverResult {
  kind: 'pickHover';
  bbox: { x: number; y: number; width: number; height: number } | null;
  selector?: string;
  tag?: string;
}
interface PickStartCommand {
  kind: 'pickMode';
  on: boolean;
}
interface ViewportMessage {
  kind: 'viewport';
  width: number;
  height: number;
  preset: string;
}
type InboundMessage =
  | FrameMessage
  | StatusMessage
  | UrlMessage
  | TabsMessage
  | PickHoverResult
  | PickStartCommand
  | ViewportMessage
  | { kind: string; [k: string]: unknown };

const vscodeApi = acquireVsCodeApi();

const placeholderEl = document.querySelector<HTMLElement>('.placeholder');
const canvasEl = document.getElementById('screencast') as HTMLCanvasElement | null;
const statusEl = document.getElementById('status');
const controlModeEl = document.getElementById('control-mode');
const viewportInfoEl = document.getElementById('viewport-info');
const connDotEl = document.getElementById('conn-dot');
const urlInputEl = document.getElementById('url-input') as HTMLInputElement | null;
const controlToggleEl = document.getElementById('control-toggle') as HTMLButtonElement | null;
const pickBtnEl = document.getElementById('pick-btn') as HTMLButtonElement | null;
const pickOverlayEl = document.getElementById('pick-overlay') as HTMLElement | null;
const pickOutlineEl = document.getElementById('pick-outline') as HTMLElement | null;
const ownBadgeEl = document.getElementById('own-badge') as HTMLElement | null;
const annotateBtnEl = document.getElementById('annotate-btn') as HTMLButtonElement | null;
const sendBtnEl = document.getElementById('send-btn') as HTMLButtonElement | null;
const annotateBarEl = document.getElementById('annotate-bar') as HTMLElement | null;
const annotateLayerEl = document.getElementById('annotate-layer') as HTMLElement | null;
const annotateSvgEl = document.getElementById('annotate-svg') as unknown as SVGSVGElement | null;
const annotateTextInputEl = document.getElementById('annotate-text-input') as HTMLElement | null;
const annotateTextFieldEl = document.getElementById('annotate-text-field') as HTMLInputElement | null;
const annotateColorEl = document.getElementById('annotate-color') as HTMLInputElement | null;
const viewportSelectEl = document.getElementById('viewport-select') as HTMLSelectElement | null;

const ctx = canvasEl?.getContext('2d', { alpha: false }) ?? null;

let firstFrameSeen = false;
let pendingFrame: ArrayBuffer | null = null;
let decoding = false;
let lastFpsTick = performance.now();
let frameCount = 0;
let displayedFps = 0;
let controlOn = true;
let mouseDownButton: number | null = null;
let lastUrl = '';
let pickModeOn = false;
let ownProject = false;
let annotator: Annotator | null = null;

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}
function setControlMode(text: string): void {
  if (controlModeEl) controlModeEl.textContent = text;
}
function setViewportInfo(text: string): void {
  if (viewportInfoEl) viewportInfoEl.textContent = text;
}
function setConnected(connected: boolean): void {
  if (!connDotEl) return;
  connDotEl.classList.toggle('connected', connected);
  connDotEl.setAttribute('title', connected ? 'Connected' : 'Disconnected');
}
function setUrlBar(url: string): void {
  if (!urlInputEl) return;
  if (document.activeElement === urlInputEl) return;
  urlInputEl.value = url;
  lastUrl = url;
}
function setControlState(on: boolean): void {
  controlOn = on;
  if (controlToggleEl) {
    controlToggleEl.dataset.state = on ? 'on' : 'off';
    controlToggleEl.title = on ? 'Take Control: ON (click to release)' : 'Take Control: OFF (click to take)';
  }
  setControlMode(on ? 'user' : 'idle');
}

function showCanvas(): void {
  if (placeholderEl) placeholderEl.style.display = 'none';
  if (canvasEl) canvasEl.hidden = false;
}

async function drawFrame(buf: ArrayBuffer): Promise<void> {
  if (!canvasEl || !ctx) return;
  const blob = new Blob([buf], { type: 'image/jpeg' });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (err) {
    console.error('decode failed', err);
    return;
  }
  if (canvasEl.width !== bitmap.width || canvasEl.height !== bitmap.height) {
    canvasEl.width = bitmap.width;
    canvasEl.height = bitmap.height;
    setViewportInfo(`${bitmap.width}×${bitmap.height}`);
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  frameCount++;
  const now = performance.now();
  if (now - lastFpsTick >= 1000) {
    displayedFps = Math.round((frameCount * 1000) / (now - lastFpsTick));
    frameCount = 0;
    lastFpsTick = now;
    if (controlOn) setControlMode(`user · ${displayedFps}fps`);
    else setControlMode(`idle · ${displayedFps}fps`);
  }
}

async function pumpFrames(): Promise<void> {
  if (decoding) return;
  decoding = true;
  try {
    while (pendingFrame) {
      const buf = pendingFrame;
      pendingFrame = null;
      await drawFrame(buf);
    }
  } finally {
    decoding = false;
  }
}

function handleFrame(msg: FrameMessage): void {
  if (!firstFrameSeen) {
    firstFrameSeen = true;
    showCanvas();
    setConnected(true);
  }
  const buf =
    msg.buf instanceof ArrayBuffer
      ? msg.buf
      : msg.buf.buffer.slice(msg.buf.byteOffset, msg.buf.byteOffset + msg.buf.byteLength);
  pendingFrame = buf as ArrayBuffer;
  void pumpFrames();
}

// ---------- Coord translation (object-fit: contain) ----------

function pageCoords(ev: MouseEvent): { x: number; y: number } | null {
  if (!canvasEl) return null;
  const rect = canvasEl.getBoundingClientRect();
  const cw = rect.width;
  const ch = rect.height;
  const bw = canvasEl.width;
  const bh = canvasEl.height;
  if (cw === 0 || ch === 0 || bw === 0 || bh === 0) return null;

  const boxAR = cw / ch;
  const bmAR = bw / bh;

  let displayW: number;
  let displayH: number;
  let offX: number;
  let offY: number;
  if (bmAR > boxAR) {
    displayW = cw;
    displayH = cw / bmAR;
    offX = 0;
    offY = (ch - displayH) / 2;
  } else {
    displayH = ch;
    displayW = ch * bmAR;
    offX = (cw - displayW) / 2;
    offY = 0;
  }

  const cssX = ev.clientX - rect.left - offX;
  const cssY = ev.clientY - rect.top - offY;
  if (cssX < 0 || cssY < 0 || cssX > displayW || cssY > displayH) return null;

  return {
    x: Math.round((cssX * bw) / displayW),
    y: Math.round((cssY * bh) / displayH)
  };
}

// ---------- Input forwarding ----------

function send(msg: unknown): void {
  vscodeApi.postMessage(msg);
}

function onMouseDown(ev: MouseEvent): void {
  if (pickModeOn) return;
  if (!controlOn || !canvasEl) return;
  canvasEl.focus();
  const c = pageCoords(ev);
  if (!c) return;
  ev.preventDefault();
  mouseDownButton = ev.button;
  send({
    kind: 'input',
    type: 'mouse',
    action: 'down',
    x: c.x,
    y: c.y,
    button: ev.button,
    modifiers: modifiersOf(ev)
  });
}

function onMouseUp(ev: MouseEvent): void {
  if (pickModeOn) return;
  if (!controlOn) return;
  const c = pageCoords(ev);
  if (!c) {
    mouseDownButton = null;
    return;
  }
  ev.preventDefault();
  send({
    kind: 'input',
    type: 'mouse',
    action: 'up',
    x: c.x,
    y: c.y,
    button: ev.button,
    modifiers: modifiersOf(ev)
  });
  mouseDownButton = null;
}

function onMouseMove(ev: MouseEvent): void {
  if (pickModeOn) {
    const c = pageCoords(ev);
    if (!c) return;
    send({ kind: 'pick', action: 'hover', x: c.x, y: c.y });
    return;
  }
  if (!controlOn) return;
  const c = pageCoords(ev);
  if (!c) return;
  send({
    kind: 'input',
    type: 'mouse',
    action: 'move',
    x: c.x,
    y: c.y,
    button: mouseDownButton ?? -1,
    modifiers: modifiersOf(ev)
  });
}

function onWheel(ev: WheelEvent): void {
  if (pickModeOn) {
    ev.preventDefault();
    return;
  }
  if (!controlOn) return;
  const c = pageCoords(ev);
  if (!c) return;
  ev.preventDefault();
  send({
    kind: 'input',
    type: 'wheel',
    x: c.x,
    y: c.y,
    deltaX: ev.deltaX,
    deltaY: ev.deltaY
  });
}

function modifiersOf(ev: MouseEvent | KeyboardEvent): string[] {
  const mods: string[] = [];
  if (ev.altKey) mods.push('Alt');
  if (ev.ctrlKey) mods.push('Control');
  if (ev.metaKey) mods.push('Meta');
  if (ev.shiftKey) mods.push('Shift');
  return mods;
}

const SPECIAL_KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
  ' ',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12'
]);

function onKeyDown(ev: KeyboardEvent): void {
  if (pickModeOn) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      exitPickMode();
    }
    return;
  }
  if (!controlOn) return;
  if (document.activeElement === urlInputEl) return;
  const target = ev.target as HTMLElement | null;
  if (target && target.tagName === 'INPUT') return;

  ev.preventDefault();
  const mods = modifiersOf(ev);
  const isPrintable = ev.key.length === 1;

  if (isPrintable && mods.length === 0) {
    send({ kind: 'input', type: 'type', text: ev.key });
  } else if (isPrintable && mods.length > 0 && !mods.includes('Shift')) {
    // e.g. Ctrl+C, Ctrl+A — fold in modifiers
    send({ kind: 'input', type: 'press', key: ev.key, modifiers: mods });
  } else if (SPECIAL_KEYS.has(ev.key)) {
    const pwKey = ev.key === ' ' ? 'Space' : ev.key;
    send({ kind: 'input', type: 'press', key: pwKey, modifiers: mods });
  } else if (isPrintable && mods.includes('Shift')) {
    send({ kind: 'input', type: 'type', text: ev.key });
  }
}

// ---------- Pick mode (Phase 7) ----------

function canvasGeometry(): AnnotateGeom | null {
  if (!canvasEl) return null;
  const rect = canvasEl.getBoundingClientRect();
  const cw = rect.width;
  const ch = rect.height;
  const bw = canvasEl.width;
  const bh = canvasEl.height;
  if (cw === 0 || ch === 0 || bw === 0 || bh === 0) return null;
  const boxAR = cw / ch;
  const bmAR = bw / bh;
  let displayW: number;
  let displayH: number;
  let offX: number;
  let offY: number;
  if (bmAR > boxAR) {
    displayW = cw;
    displayH = cw / bmAR;
    offX = 0;
    offY = (ch - displayH) / 2;
  } else {
    displayH = ch;
    displayW = ch * bmAR;
    offX = (cw - displayW) / 2;
    offY = 0;
  }
  return { rect, displayW, displayH, offX, offY, bw, bh };
}

function pageBoxToCanvasCss(
  box: { x: number; y: number; width: number; height: number },
  geom: AnnotateGeom
): { left: number; top: number; width: number; height: number } {
  const sx = geom.displayW / geom.bw;
  const sy = geom.displayH / geom.bh;
  return {
    left: geom.offX + box.x * sx,
    top: geom.offY + box.y * sy,
    width: Math.max(2, box.width * sx),
    height: Math.max(2, box.height * sy)
  };
}

function setPickOutline(box: { x: number; y: number; width: number; height: number } | null): void {
  if (!pickOutlineEl) return;
  if (!box) {
    pickOutlineEl.classList.remove('visible');
    return;
  }
  const geom = canvasGeometry();
  if (!geom) return;
  const css = pageBoxToCanvasCss(box, geom);
  pickOutlineEl.style.left = `${css.left}px`;
  pickOutlineEl.style.top = `${css.top}px`;
  pickOutlineEl.style.width = `${css.width}px`;
  pickOutlineEl.style.height = `${css.height}px`;
  pickOutlineEl.classList.add('visible');
}

function enterPickMode(): void {
  pickModeOn = true;
  if (pickBtnEl) pickBtnEl.dataset.state = 'on';
  if (pickOverlayEl) {
    pickOverlayEl.hidden = false;
    pickOverlayEl.classList.add('active');
  }
  setPickOutline(null);
  setStatus('Pick mode — hover, then click an element');
}

function exitPickMode(): void {
  pickModeOn = false;
  if (pickBtnEl) pickBtnEl.dataset.state = 'off';
  if (pickOverlayEl) {
    pickOverlayEl.hidden = true;
    pickOverlayEl.classList.remove('active');
  }
  setPickOutline(null);
  setStatus('Ready');
  send({ kind: 'pick', action: 'cancel' });
}

function onPickOverlayMove(ev: MouseEvent): void {
  if (!pickModeOn) return;
  const c = pageCoords(ev);
  if (!c) return;
  send({ kind: 'pick', action: 'hover', x: c.x, y: c.y });
}

function onPickOverlayClick(ev: MouseEvent): void {
  if (!pickModeOn) return;
  const c = pageCoords(ev);
  if (!c) return;
  ev.preventDefault();
  ev.stopPropagation();
  send({ kind: 'pick', action: 'click', x: c.x, y: c.y });
  exitPickMode();
}

function onPickButtonClick(): void {
  if (pickModeOn) exitPickMode();
  else enterPickMode();
}

// ---------- Annotate mode (Phase 8) ----------

function setOwnProject(on: boolean): void {
  ownProject = on;
  if (ownBadgeEl) ownBadgeEl.hidden = !on;
  if (annotateBtnEl) {
    if (on) {
      annotateBtnEl.removeAttribute('disabled');
      annotateBtnEl.title = 'Annotate (own project)';
    } else {
      annotateBtnEl.setAttribute('disabled', 'true');
      annotateBtnEl.title = 'Available on your own project (localhost / file:// / configured hosts)';
      // Auto-exit annotate mode if active
      if (annotator?.isActive()) exitAnnotateMode();
    }
  }
}

function ensureAnnotator(): Annotator | null {
  if (annotator) return annotator;
  if (!annotateLayerEl || !annotateSvgEl || !annotateTextInputEl || !annotateTextFieldEl) return null;
  annotator = new Annotator({
    layerEl: annotateLayerEl,
    svgEl: annotateSvgEl,
    textInputEl: annotateTextInputEl,
    textFieldEl: annotateTextFieldEl,
    getGeom: canvasGeometry,
    getCanvas: () => canvasEl
  });
  return annotator;
}

function setAnnotateToolButtonState(tool: string): void {
  document.querySelectorAll<HTMLElement>('.annotate-tool[data-tool]').forEach((btn) => {
    if (['undo', 'clear'].includes(btn.dataset.tool ?? '')) return;
    btn.dataset.state = btn.dataset.tool === tool ? 'on' : 'off';
  });
}

function enterAnnotateMode(): void {
  const ann = ensureAnnotator();
  if (!ann) return;
  if (pickModeOn) exitPickMode();
  ann.enter();
  if (annotateBarEl) annotateBarEl.hidden = false;
  if (annotateBtnEl) annotateBtnEl.dataset.state = 'on';
  if (sendBtnEl) sendBtnEl.removeAttribute('disabled');
  ann.setTool('rect');
  setAnnotateToolButtonState('rect');
  setStatus('Annotate mode — draw, then Send to Claude');
}

function exitAnnotateMode(): void {
  if (!annotator) return;
  annotator.exit();
  if (annotateBarEl) annotateBarEl.hidden = true;
  if (annotateBtnEl) annotateBtnEl.dataset.state = 'off';
  if (sendBtnEl) sendBtnEl.setAttribute('disabled', 'true');
  setStatus('Ready');
}

function onAnnotateButtonClick(): void {
  if (!ownProject) return;
  if (annotator?.isActive()) exitAnnotateMode();
  else enterAnnotateMode();
}

function onAnnotateToolClick(tool: string): void {
  if (!annotator) return;
  if (tool === 'undo') {
    annotator.undo();
    return;
  }
  if (tool === 'clear') {
    annotator.clearAll();
    return;
  }
  if (tool === 'rect' || tool === 'free' || tool === 'arrow' || tool === 'text') {
    annotator.setTool(tool);
    setAnnotateToolButtonState(tool);
  }
}

async function onSendClick(): Promise<void> {
  if (!annotator || !annotator.isActive()) return;
  if (!annotator.hasContent()) {
    setStatus('No annotations to send');
    return;
  }
  setStatus('Compositing…');
  const png = await annotator.compositePng();
  const snap = annotator.snapshot();
  if (!png) {
    setStatus('Composite failed');
    return;
  }
  send({
    kind: 'annotateSend',
    png,
    annotations: snap.annotations,
    viewport: snap.viewport
  });
  setStatus('Sent — see Claude Code chat');
  exitAnnotateMode();
}

// ---------- Chrome bar (URL bar + nav buttons + control toggle) ----------

function onUrlEnter(ev: KeyboardEvent): void {
  if (ev.key !== 'Enter' || !urlInputEl) return;
  const raw = urlInputEl.value.trim();
  if (!raw) return;
  const url = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
  send({ kind: 'navigate', url });
  if (canvasEl) canvasEl.focus();
}

function onNavClick(action: string): void {
  send({ kind: 'nav', action });
}

function onToggleControl(): void {
  setControlState(!controlOn);
  send({ kind: 'control', on: controlOn });
}

// ---------- Wire everything ----------

function attach(): void {
  if (canvasEl) {
    canvasEl.addEventListener('mousedown', onMouseDown);
    canvasEl.addEventListener('mouseup', onMouseUp);
    canvasEl.addEventListener('mousemove', throttle(onMouseMove, 16));
    canvasEl.addEventListener('wheel', onWheel, { passive: false });
    canvasEl.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  window.addEventListener('keydown', onKeyDown);
  if (urlInputEl) {
    urlInputEl.addEventListener('keydown', onUrlEnter);
  }
  document.querySelectorAll<HTMLButtonElement>('.nav-btn[data-action]').forEach((btn) => {
    const action = btn.dataset.action;
    if (!action) return;
    btn.addEventListener('click', () => onNavClick(action));
  });
  if (controlToggleEl) controlToggleEl.addEventListener('click', onToggleControl);
  if (pickBtnEl) pickBtnEl.addEventListener('click', onPickButtonClick);
  if (pickOverlayEl) {
    pickOverlayEl.addEventListener('mousemove', throttle(onPickOverlayMove, 80));
    pickOverlayEl.addEventListener('click', onPickOverlayClick);
    pickOverlayEl.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  if (annotateBtnEl) annotateBtnEl.addEventListener('click', onAnnotateButtonClick);
  if (sendBtnEl) sendBtnEl.addEventListener('click', () => void onSendClick());
  document.querySelectorAll<HTMLElement>('.annotate-tool[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => onAnnotateToolClick(btn.dataset.tool ?? ''));
  });
  if (annotateColorEl) {
    annotateColorEl.addEventListener('change', () => {
      if (annotator) annotator.setColor(annotateColorEl.value);
    });
  }
  if (viewportSelectEl) {
    viewportSelectEl.addEventListener('change', () => {
      const preset = viewportSelectEl.value;
      if (preset === 'desktop' || preset === 'laptop' || preset === 'tablet' || preset === 'mobile') {
        send({ kind: 'setViewport', preset });
      }
    });
  }
}

function throttle<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let last = 0;
  let lastArgs: unknown[] | null = null;
  let scheduled = false;
  const run = (): void => {
    last = performance.now();
    scheduled = false;
    if (lastArgs) {
      (fn as unknown as (...a: unknown[]) => void)(...lastArgs);
      lastArgs = null;
    }
  };
  return ((...args: unknown[]): void => {
    const now = performance.now();
    if (now - last >= ms) {
      last = now;
      (fn as unknown as (...a: unknown[]) => void)(...args);
    } else {
      lastArgs = args;
      if (!scheduled) {
        scheduled = true;
        setTimeout(run, ms - (now - last));
      }
    }
  }) as unknown as T;
}

function renderTabs(tabs: TabInfo[]): void {
  const active = tabs.find((t) => t.active);
  setOwnProject(!!active?.isOwnProject);

  const strip = document.querySelector<HTMLElement>('.tab-strip');
  if (!strip) return;
  strip.innerHTML = '';

  if (tabs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tab tab-empty';
    empty.textContent = 'No tabs yet';
    strip.appendChild(empty);
  } else {
    for (const t of tabs) {
      const tabEl = document.createElement('div');
      tabEl.className = 'tab' + (t.active ? ' active' : '');
      tabEl.dataset.tabId = t.tabId;
      tabEl.title = `${t.title || ''}\n${t.url}`.trim();

      const label = document.createElement('span');
      label.className = 'tab-label';
      const display = t.title?.trim() || prettyUrl(t.url) || 'New tab';
      label.textContent = display;
      tabEl.appendChild(label);

      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = 'Close tab';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        send({ kind: 'tab', action: 'close', tabId: t.tabId });
      });
      tabEl.appendChild(close);

      tabEl.addEventListener('click', () => {
        if (!t.active) send({ kind: 'tab', action: 'switch', tabId: t.tabId });
      });

      strip.appendChild(tabEl);
    }
  }

  const newBtn = document.createElement('button');
  newBtn.className = 'tab-new';
  newBtn.textContent = '+';
  newBtn.title = 'New tab';
  newBtn.addEventListener('click', () => send({ kind: 'tab', action: 'new' }));
  strip.appendChild(newBtn);
}

function prettyUrl(url: string): string {
  if (!url || url === 'about:blank') return '';
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url;
  }
}

window.addEventListener('message', (event: MessageEvent<InboundMessage>) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.kind) {
    case 'frame':
      handleFrame(msg as FrameMessage);
      break;
    case 'status':
      setStatus((msg as StatusMessage).text);
      break;
    case 'url':
      setUrlBar((msg as UrlMessage).url);
      break;
    case 'tabs':
      renderTabs((msg as TabsMessage).tabs);
      break;
    case 'pickHover': {
      const ph = msg as PickHoverResult;
      setPickOutline(ph.bbox);
      break;
    }
    case 'pickMode': {
      const pm = msg as PickStartCommand;
      if (pm.on && !pickModeOn) enterPickMode();
      else if (!pm.on && pickModeOn) exitPickMode();
      break;
    }
    case 'viewport': {
      const v = msg as ViewportMessage;
      if (viewportSelectEl && (v.preset === 'desktop' || v.preset === 'laptop' || v.preset === 'tablet' || v.preset === 'mobile')) {
        viewportSelectEl.value = v.preset;
      }
      setViewportInfo(`${v.width}×${v.height}`);
      break;
    }
    default:
      break;
  }
});

setStatus('Ready');
setControlState(true);
setViewportInfo(`${window.innerWidth}×${window.innerHeight}`);
setConnected(false);
attach();

vscodeApi.postMessage({ kind: 'ready', phase: 3 });
void lastUrl;
