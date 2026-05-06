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

const placeholderEl = document.getElementById('placeholder');
const placeholderRecentsEl = document.getElementById('placeholder-recents');
const canvasEl = document.getElementById('screencast') as HTMLCanvasElement | null;
const statusEl = document.getElementById('status');
const controlModeEl = document.getElementById('control-mode');
const viewportInfoEl = document.getElementById('viewport-info');
const connDotEl = document.getElementById('conn-dot');
const urlInputEl = document.getElementById('url-input') as HTMLInputElement | null;
const urlHistoryEl = document.getElementById('url-history') as HTMLDataListElement | null;
const controlToggleEl = document.getElementById('control-toggle') as HTMLButtonElement | null;
const navTabNewBtnEl = document.getElementById('nav-tab-new') as HTMLButtonElement | null;
const tabStripEl = document.getElementById('tab-strip') as HTMLElement | null;
const pickOverlayEl = document.getElementById('pick-overlay') as HTMLElement | null;
const pickOutlineEl = document.getElementById('pick-outline') as HTMLElement | null;
const ownBadgeEl = document.getElementById('own-badge') as HTMLElement | null;
const sendBtnEl = document.getElementById('send-btn') as HTMLButtonElement | null;
const annotateBarEl = document.getElementById('annotate-bar') as HTMLElement | null;
const annotateLayerEl = document.getElementById('annotate-layer') as HTMLElement | null;
const annotateSvgEl = document.getElementById('annotate-svg') as unknown as SVGSVGElement | null;
const annotateTextInputEl = document.getElementById('annotate-text-input') as HTMLElement | null;
const annotateTextFieldEl = document.getElementById('annotate-text-field') as HTMLInputElement | null;
const annotateColorEl = document.getElementById('annotate-color') as HTMLInputElement | null;
const viewportSelectEl = document.getElementById('viewport-select') as HTMLSelectElement | null;
const volumeSliderEl = document.getElementById('volume-slider') as HTMLInputElement | null;
const volumeIconEl = document.getElementById('volume-icon') as HTMLButtonElement | null;
const volumePopoverEl = document.getElementById('volume-popover') as HTMLElement | null;
const saveOverlayEl = document.getElementById('save-overlay') as HTMLElement | null;
const saveOutlineEl = document.getElementById('save-outline') as HTMLElement | null;
const saveBannerEl = document.getElementById('save-banner') as HTMLElement | null;
const modeDefaultBtnEl = document.getElementById('mode-default') as HTMLButtonElement | null;
const modePickBtnEl = document.getElementById('mode-pick') as HTMLButtonElement | null;
const modeSaveBtnEl = document.getElementById('mode-save') as HTMLButtonElement | null;
const modeAnnotateBtnEl = document.getElementById('mode-annotate') as HTMLButtonElement | null;

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
let saveModeOn = false;
let annotator: Annotator | null = null;
type Mode = 'default' | 'pick' | 'save' | 'annotate';
let currentMode: Mode = 'default';

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
  if (document.activeElement !== urlInputEl) {
    urlInputEl.value = url;
  }
  lastUrl = url;
  // Gate the own-project badge: about:blank / empty has no meaningful target.
  if (!url || url === 'about:blank') {
    setOwnProject(false);
  }
  // Push to history (excludes about:blank and empty).
  if (url && url !== 'about:blank') {
    addRecentUrl(url);
  }
  // Toggle empty-state placeholder.
  updatePlaceholderVisibility();
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
  if (canvasEl) canvasEl.hidden = false;
  updatePlaceholderVisibility();
}

function updatePlaceholderVisibility(): void {
  if (!placeholderEl) return;
  // Only show the empty-state placeholder before the first frame ever arrives.
  // Once content has been seen, never re-show it — even on about:blank tabs —
  // because the URL/frame message ordering can otherwise leave the placeholder
  // covering a real page.
  const show = !firstFrameSeen;
  placeholderEl.style.display = show ? '' : 'none';
  if (show) renderPlaceholderRecents();
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
  if (ev.key === 'Escape' && isVolumePopoverOpen()) {
    ev.preventDefault();
    hideVolumePopover();
    return;
  }
  if (pickModeOn) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      setMode('default');
    }
    return;
  }
  if (saveModeOn) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      setMode('default');
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
  if (pickOverlayEl) {
    pickOverlayEl.hidden = false;
    pickOverlayEl.classList.add('active');
  }
  setPickOutline(null);
  setStatus('Pick mode — hover, then click an element');
}

function exitPickMode(): void {
  pickModeOn = false;
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
  setMode('default');
}

// ---------- Save mode (download assets) ----------

function setSaveOutline(box: { x: number; y: number; width: number; height: number } | null): void {
  if (!saveOutlineEl) return;
  if (!box) {
    saveOutlineEl.classList.remove('visible');
    return;
  }
  const geom = canvasGeometry();
  if (!geom) return;
  const css = pageBoxToCanvasCss(box, geom);
  saveOutlineEl.style.left = `${css.left}px`;
  saveOutlineEl.style.top = `${css.top}px`;
  saveOutlineEl.style.width = `${css.width}px`;
  saveOutlineEl.style.height = `${css.height}px`;
  saveOutlineEl.classList.add('visible');
}

function setSaveBanner(text: string): void {
  if (saveBannerEl) saveBannerEl.textContent = text;
}

function enterSaveMode(): void {
  saveModeOn = true;
  if (saveOverlayEl) {
    saveOverlayEl.hidden = false;
    saveOverlayEl.classList.add('active');
  }
  setSaveOutline(null);
  setSaveBanner('Save mode — click an image / video / background to download. Esc to cancel.');
  setStatus('Save mode — click an asset to download');
}

function exitSaveMode(): void {
  saveModeOn = false;
  if (saveOverlayEl) {
    saveOverlayEl.hidden = true;
    saveOverlayEl.classList.remove('active');
  }
  setSaveOutline(null);
  setStatus('Ready');
  send({ kind: 'saveAsset', action: 'cancel' });
}

function onSaveOverlayMove(ev: MouseEvent): void {
  if (!saveModeOn) return;
  const c = pageCoords(ev);
  if (!c) return;
  send({ kind: 'saveAsset', action: 'hover', x: c.x, y: c.y });
}

function onSaveOverlayClick(ev: MouseEvent): void {
  if (!saveModeOn) return;
  const c = pageCoords(ev);
  if (!c) return;
  ev.preventDefault();
  ev.stopPropagation();
  send({ kind: 'saveAsset', action: 'click', x: c.x, y: c.y });
  setMode('default');
}

interface SaveAssetHoverInfo {
  bbox: { x: number; y: number; width: number; height: number };
  kind: string;
  url: string;
}

function handleSaveAssetHover(info: SaveAssetHoverInfo | null): void {
  if (!saveModeOn) return;
  if (!info) {
    setSaveOutline(null);
    setSaveBanner('No asset under cursor — click on an image, video, or background to download.');
    return;
  }
  setSaveOutline(info.bbox);
  // Trim long URLs for display
  let urlPreview = info.url;
  if (urlPreview.length > 80) urlPreview = urlPreview.slice(0, 77) + '…';
  setSaveBanner(`${info.kind} → ${urlPreview}`);
}

// ---------- Annotate mode (Phase 8) ----------

function setOwnProject(on: boolean): void {
  if (ownBadgeEl) ownBadgeEl.hidden = !on;
  if (modeAnnotateBtnEl) {
    if (on) {
      modeAnnotateBtnEl.removeAttribute('disabled');
      modeAnnotateBtnEl.title = 'Annotate (own project)';
    } else {
      modeAnnotateBtnEl.setAttribute('disabled', 'true');
      modeAnnotateBtnEl.title = 'Available on your own project (localhost / file:// / configured hosts)';
      // Auto-exit annotate mode if it was active.
      if (currentMode === 'annotate') setMode('default');
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
  ann.enter();
  if (annotateBarEl) annotateBarEl.hidden = false;
  ann.setTool('rect');
  setAnnotateToolButtonState('rect');
  setStatus('Annotate mode — draw, then Send to Claude');
}

function exitAnnotateMode(): void {
  if (!annotator) return;
  annotator.exit();
  if (annotateBarEl) annotateBarEl.hidden = true;
  setStatus('Ready');
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
  setMode('default');
}

// ---------- Persisted state ----------

interface PersistedState {
  volume?: number;
  recentUrls?: string[];
}

const MAX_RECENT_URLS = 20;

function getPersisted(): PersistedState {
  return (vscodeApi.getState<PersistedState>() ?? {}) as PersistedState;
}

function patchPersisted(patch: Partial<PersistedState>): void {
  vscodeApi.setState({ ...getPersisted(), ...patch });
}

// ---------- URL history ----------

function getRecentUrls(): string[] {
  const s = getPersisted();
  return Array.isArray(s.recentUrls) ? s.recentUrls : [];
}

function addRecentUrl(url: string): void {
  const list = getRecentUrls();
  const filtered = list.filter((u) => u !== url);
  filtered.unshift(url);
  const trimmed = filtered.slice(0, MAX_RECENT_URLS);
  patchPersisted({ recentUrls: trimmed });
  syncUrlHistoryDatalist();
  renderPlaceholderRecents();
}

function syncUrlHistoryDatalist(): void {
  if (!urlHistoryEl) return;
  urlHistoryEl.innerHTML = '';
  for (const u of getRecentUrls()) {
    const opt = document.createElement('option');
    opt.value = u;
    urlHistoryEl.appendChild(opt);
  }
}

function renderPlaceholderRecents(): void {
  if (!placeholderRecentsEl) return;
  placeholderRecentsEl.innerHTML = '';
  const recents = getRecentUrls().slice(0, 6);
  for (const u of recents) {
    const btn = document.createElement('button');
    btn.className = 'placeholder-recent-btn';
    btn.type = 'button';
    btn.textContent = prettyUrl(u) || u;
    btn.title = u;
    btn.addEventListener('click', () => {
      send({ kind: 'navigate', url: u });
      if (urlInputEl) urlInputEl.value = u;
    });
    placeholderRecentsEl.appendChild(btn);
  }
}

// ---------- Volume control ----------

let currentVolume = 1.0; // 0..1
let preMuteVolume = 1.0;

function volumeIcon(v: number): string {
  if (v <= 0.001) return '🔇';
  if (v < 0.34) return '🔈';
  if (v < 0.67) return '🔉';
  return '🔊';
}

function applyVolumeUI(): void {
  if (volumeSliderEl) volumeSliderEl.value = String(Math.round(currentVolume * 100));
  if (volumeIconEl) volumeIconEl.textContent = volumeIcon(currentVolume);
}

function setVolume(v: number, opts: { persist: boolean; send: boolean }): void {
  const clamped = Math.max(0, Math.min(1, v));
  currentVolume = clamped;
  applyVolumeUI();
  if (opts.send) send({ kind: 'setVolume', volume: clamped });
  if (opts.persist) patchPersisted({ volume: clamped });
}

function loadPersistedVolume(): void {
  const state = getPersisted();
  if (typeof state.volume === 'number') {
    currentVolume = Math.max(0, Math.min(1, state.volume));
  }
  applyVolumeUI();
}

function showVolumePopover(): void {
  if (!volumePopoverEl) return;
  volumePopoverEl.hidden = false;
}

function hideVolumePopover(): void {
  if (!volumePopoverEl) return;
  volumePopoverEl.hidden = true;
}

function isVolumePopoverOpen(): boolean {
  return !!volumePopoverEl && !volumePopoverEl.hidden;
}

function toggleVolumePopover(): void {
  if (isVolumePopoverOpen()) hideVolumePopover();
  else showVolumePopover();
}

function onVolumeInput(): void {
  if (!volumeSliderEl) return;
  const v = Number(volumeSliderEl.value) / 100;
  if (v > 0) preMuteVolume = v;
  setVolume(v, { persist: true, send: true });
}

function onVolumeIconClick(): void {
  toggleVolumePopover();
}

function onVolumeIconDoubleClick(): void {
  // Cancel any popover toggle that the first click triggered.
  hideVolumePopover();
  if (currentVolume > 0) {
    preMuteVolume = currentVolume;
    setVolume(0, { persist: true, send: true });
  } else {
    setVolume(preMuteVolume > 0 ? preMuteVolume : 1, { persist: true, send: true });
  }
}

// ---------- Mode dispatcher (Browse / Pick / Save / Annotate) ----------

function setMode(target: Mode): void {
  if (currentMode === target) return;
  // Exit current mode first (always — exits cancel any pending host work).
  if (currentMode === 'pick') exitPickMode();
  else if (currentMode === 'save') exitSaveMode();
  else if (currentMode === 'annotate') exitAnnotateMode();
  currentMode = target;
  // Enter new mode.
  if (target === 'pick') enterPickMode();
  else if (target === 'save') enterSaveMode();
  else if (target === 'annotate') enterAnnotateMode();
  syncModeSegments();
  // Belt-and-braces: ensure annotate-bar reflects current mode (#1a fix).
  if (annotateBarEl) annotateBarEl.hidden = target !== 'annotate';
  // Send button only relevant in annotate mode.
  if (sendBtnEl) {
    sendBtnEl.hidden = target !== 'annotate';
  }
}

function syncModeSegments(): void {
  const map: Array<[HTMLButtonElement | null, Mode]> = [
    [modeDefaultBtnEl, 'default'],
    [modePickBtnEl, 'pick'],
    [modeSaveBtnEl, 'save'],
    [modeAnnotateBtnEl, 'annotate']
  ];
  for (const [btn, mode] of map) {
    if (!btn) continue;
    const active = mode === currentMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
  }
}

function onModeSegmentClick(target: Mode): void {
  // Clicking the active segment returns to default.
  if (currentMode === target) {
    setMode('default');
  } else {
    setMode(target);
  }
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
  if (navTabNewBtnEl) navTabNewBtnEl.addEventListener('click', () => send({ kind: 'tab', action: 'new' }));
  // Mode segmented control (replaces standalone Pick / Save / Annotate buttons).
  if (modeDefaultBtnEl) modeDefaultBtnEl.addEventListener('click', () => onModeSegmentClick('default'));
  if (modePickBtnEl) modePickBtnEl.addEventListener('click', () => onModeSegmentClick('pick'));
  if (modeSaveBtnEl) modeSaveBtnEl.addEventListener('click', () => onModeSegmentClick('save'));
  if (modeAnnotateBtnEl) modeAnnotateBtnEl.addEventListener('click', () => {
    if (modeAnnotateBtnEl.disabled) return;
    onModeSegmentClick('annotate');
  });
  if (pickOverlayEl) {
    pickOverlayEl.addEventListener('mousemove', throttle(onPickOverlayMove, 80));
    pickOverlayEl.addEventListener('click', onPickOverlayClick);
    pickOverlayEl.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  if (saveOverlayEl) {
    saveOverlayEl.addEventListener('mousemove', throttle(onSaveOverlayMove, 80));
    saveOverlayEl.addEventListener('click', onSaveOverlayClick);
    saveOverlayEl.addEventListener('contextmenu', (e) => e.preventDefault());
  }
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
  if (volumeSliderEl) {
    volumeSliderEl.addEventListener('input', onVolumeInput);
  }
  if (volumeIconEl) {
    volumeIconEl.addEventListener('click', onVolumeIconClick);
    volumeIconEl.addEventListener('dblclick', onVolumeIconDoubleClick);
  }
  // Close the volume popover on click-outside.
  document.addEventListener('click', (ev) => {
    if (!isVolumePopoverOpen()) return;
    const target = ev.target as Node | null;
    if (!target) return;
    if (volumeIconEl && volumeIconEl.contains(target)) return;
    if (volumePopoverEl && volumePopoverEl.contains(target)) return;
    hideVolumePopover();
  });
  loadPersistedVolume();
  syncUrlHistoryDatalist();
  renderPlaceholderRecents();
  syncModeSegments();
  updatePlaceholderVisibility();
  // Push the persisted volume to the extension so the browser starts at the right level.
  send({ kind: 'setVolume', volume: currentVolume });
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

  const strip = tabStripEl;
  if (!strip) return;
  // Hide the strip entirely when there's at most one tab (the nav-row + button covers new-tab).
  strip.hidden = tabs.length <= 1;
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
      if (pm.on && currentMode !== 'pick') setMode('pick');
      else if (!pm.on && currentMode === 'pick') setMode('default');
      break;
    }
    case 'saveAssetHover': {
      const m = msg as unknown as { info: SaveAssetHoverInfo | null };
      handleSaveAssetHover(m.info);
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
