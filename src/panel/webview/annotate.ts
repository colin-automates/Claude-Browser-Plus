// Annotate layer: SVG overlay rendered on top of the live screencast.
// Coordinates are page-bitmap coords (0..canvas.width / 0..canvas.height) so they
// match the underlying frame, regardless of how the canvas is letterboxed in CSS.

export type AnnotationTool = 'rect' | 'free' | 'arrow' | 'text';

export interface Annotation {
  id: string;
  type: AnnotationTool;
  color: string;
  bbox: { x: number; y: number; width: number; height: number };
  // Geometry detail for rendering:
  points?: { x: number; y: number }[]; // freehand
  from?: { x: number; y: number };     // arrow
  to?: { x: number; y: number };       // arrow
  text?: string;                       // text marker
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface CanvasGeom {
  rect: DOMRect;
  displayW: number;
  displayH: number;
  offX: number;
  offY: number;
  bw: number;
  bh: number;
}

export class Annotator {
  private layer: HTMLElement;
  private svg: SVGSVGElement;
  private textInput: HTMLElement;
  private textField: HTMLInputElement;
  private getGeom: () => CanvasGeom | null;
  private getCanvas: () => HTMLCanvasElement | null;

  private active = false;
  private tool: AnnotationTool = 'rect';
  private color = '#ff3b30';
  private annotations: Annotation[] = [];

  // In-progress drawing state:
  private drawing = false;
  private current: Annotation | null = null;
  private currentEl: SVGElement | null = null;

  // Pending text-input position:
  private pendingText: { x: number; y: number } | null = null;

  constructor(opts: {
    layerEl: HTMLElement;
    svgEl: SVGSVGElement;
    textInputEl: HTMLElement;
    textFieldEl: HTMLInputElement;
    getGeom: () => CanvasGeom | null;
    getCanvas: () => HTMLCanvasElement | null;
  }) {
    this.layer = opts.layerEl;
    this.svg = opts.svgEl;
    this.textInput = opts.textInputEl;
    this.textField = opts.textFieldEl;
    this.getGeom = opts.getGeom;
    this.getCanvas = opts.getCanvas;

    this.layer.addEventListener('pointerdown', this.onDown);
    this.layer.addEventListener('pointermove', this.onMove);
    this.layer.addEventListener('pointerup', this.onUp);
    this.layer.addEventListener('pointercancel', this.onUp);
    this.textField.addEventListener('keydown', this.onTextKey);
    this.textField.addEventListener('blur', this.onTextBlur);

    window.addEventListener('resize', () => this.relayout());
  }

  isActive(): boolean {
    return this.active;
  }

  enter(): void {
    this.active = true;
    this.layer.hidden = false;
    this.layer.classList.add('active');
    this.relayout();
  }

  exit(): void {
    this.active = false;
    this.layer.hidden = true;
    this.layer.classList.remove('active');
    this.dismissTextInput();
  }

  setTool(tool: AnnotationTool): void {
    this.tool = tool;
    this.dismissTextInput();
  }

  setColor(c: string): void {
    this.color = c;
  }

  hasContent(): boolean {
    return this.annotations.length > 0;
  }

  clearAll(): void {
    this.annotations = [];
    this.svg.replaceChildren();
  }

  undo(): void {
    const last = this.annotations.pop();
    if (!last) return;
    const node = this.svg.querySelector(`[data-id="${last.id}"]`);
    if (node) node.remove();
  }

  /** Returns annotations + the canvas pixel size used to render them. */
  snapshot(): { annotations: Annotation[]; viewport: { width: number; height: number } } {
    const c = this.getCanvas();
    return {
      annotations: this.annotations.map((a) => ({ ...a })),
      viewport: { width: c?.width ?? 0, height: c?.height ?? 0 }
    };
  }

  /** Composite frame + annotations into one PNG ArrayBuffer. */
  async compositePng(): Promise<ArrayBuffer | null> {
    const canvas = this.getCanvas();
    if (!canvas) return null;
    const w = canvas.width;
    const h = canvas.height;
    if (w === 0 || h === 0) return null;

    const off = new OffscreenCanvas(w, h);
    const ctx = off.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(canvas, 0, 0);

    if (this.annotations.length > 0) {
      const svgClone = this.svg.cloneNode(true) as SVGSVGElement;
      svgClone.setAttribute('width', String(w));
      svgClone.setAttribute('height', String(h));
      svgClone.setAttribute('viewBox', `0 0 ${w} ${h}`);
      const xml = new XMLSerializer().serializeToString(svgClone);
      const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = reject;
          im.src = url;
        });
        ctx.drawImage(img, 0, 0, w, h);
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    const out = await off.convertToBlob({ type: 'image/png' });
    return await out.arrayBuffer();
  }

  private relayout(): void {
    const g = this.getGeom();
    if (!g) return;
    this.svg.style.left = `${g.offX}px`;
    this.svg.style.top = `${g.offY}px`;
    this.svg.style.width = `${g.displayW}px`;
    this.svg.style.height = `${g.displayH}px`;
    this.svg.setAttribute('viewBox', `0 0 ${g.bw} ${g.bh}`);
    this.svg.setAttribute('width', `${g.displayW}`);
    this.svg.setAttribute('height', `${g.displayH}`);
  }

  private clientToPage(ev: PointerEvent): { x: number; y: number } | null {
    const g = this.getGeom();
    if (!g) return null;
    const cssX = ev.clientX - g.rect.left - g.offX;
    const cssY = ev.clientY - g.rect.top - g.offY;
    if (cssX < 0 || cssY < 0 || cssX > g.displayW || cssY > g.displayH) return null;
    return {
      x: Math.round((cssX * g.bw) / g.displayW),
      y: Math.round((cssY * g.bh) / g.displayH)
    };
  }

  private uid(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  private onDown = (ev: PointerEvent): void => {
    if (!this.active) return;
    if (this.tool === 'text') {
      const p = this.clientToPage(ev);
      if (!p) return;
      this.openTextInput(ev.clientX, ev.clientY, p);
      return;
    }
    const p = this.clientToPage(ev);
    if (!p) return;
    ev.preventDefault();
    this.drawing = true;
    this.layer.setPointerCapture(ev.pointerId);
    const id = this.uid();
    if (this.tool === 'rect') {
      const ann: Annotation = {
        id,
        type: 'rect',
        color: this.color,
        bbox: { x: p.x, y: p.y, width: 0, height: 0 }
      };
      const el = document.createElementNS(SVG_NS, 'rect');
      el.setAttribute('data-id', id);
      el.setAttribute('x', String(p.x));
      el.setAttribute('y', String(p.y));
      el.setAttribute('width', '0');
      el.setAttribute('height', '0');
      el.setAttribute('fill', `${this.color}22`);
      el.setAttribute('stroke', this.color);
      el.setAttribute('stroke-width', '3');
      this.svg.appendChild(el);
      this.current = ann;
      this.currentEl = el;
    } else if (this.tool === 'free') {
      const ann: Annotation = {
        id,
        type: 'free',
        color: this.color,
        bbox: { x: p.x, y: p.y, width: 0, height: 0 },
        points: [p]
      };
      const el = document.createElementNS(SVG_NS, 'polyline');
      el.setAttribute('data-id', id);
      el.setAttribute('points', `${p.x},${p.y}`);
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', this.color);
      el.setAttribute('stroke-width', '3');
      el.setAttribute('stroke-linecap', 'round');
      el.setAttribute('stroke-linejoin', 'round');
      this.svg.appendChild(el);
      this.current = ann;
      this.currentEl = el;
    } else if (this.tool === 'arrow') {
      const ann: Annotation = {
        id,
        type: 'arrow',
        color: this.color,
        bbox: { x: p.x, y: p.y, width: 0, height: 0 },
        from: p,
        to: p
      };
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('data-id', id);
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(p.x));
      line.setAttribute('y1', String(p.y));
      line.setAttribute('x2', String(p.x));
      line.setAttribute('y2', String(p.y));
      line.setAttribute('stroke', this.color);
      line.setAttribute('stroke-width', '3');
      g.appendChild(line);
      const head = document.createElementNS(SVG_NS, 'polygon');
      head.setAttribute('fill', this.color);
      head.setAttribute('points', `${p.x},${p.y} ${p.x},${p.y} ${p.x},${p.y}`);
      g.appendChild(head);
      this.svg.appendChild(g);
      this.current = ann;
      this.currentEl = g;
    }
  };

  private onMove = (ev: PointerEvent): void => {
    if (!this.active || !this.drawing || !this.current || !this.currentEl) return;
    const p = this.clientToPage(ev);
    if (!p) return;

    if (this.current.type === 'rect') {
      const x0 = this.current.bbox.x;
      const y0 = this.current.bbox.y;
      const x = Math.min(x0, p.x);
      const y = Math.min(y0, p.y);
      const w = Math.abs(p.x - x0);
      const h = Math.abs(p.y - y0);
      const rect = this.currentEl as SVGRectElement;
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', String(w));
      rect.setAttribute('height', String(h));
      this.current.bbox = { x, y, width: w, height: h };
    } else if (this.current.type === 'free') {
      this.current.points!.push(p);
      const poly = this.currentEl as SVGPolylineElement;
      poly.setAttribute(
        'points',
        this.current.points!.map((q) => `${q.x},${q.y}`).join(' ')
      );
    } else if (this.current.type === 'arrow') {
      this.current.to = p;
      const g = this.currentEl as SVGGElement;
      const line = g.firstChild as SVGLineElement;
      line.setAttribute('x2', String(p.x));
      line.setAttribute('y2', String(p.y));
      const head = g.lastChild as SVGPolygonElement;
      const from = this.current.from!;
      const dx = p.x - from.x;
      const dy = p.y - from.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const size = Math.max(10, Math.min(28, len * 0.18));
      const tipX = p.x;
      const tipY = p.y;
      const baseX = p.x - ux * size;
      const baseY = p.y - uy * size;
      const perpX = -uy * size * 0.5;
      const perpY = ux * size * 0.5;
      head.setAttribute(
        'points',
        `${tipX},${tipY} ${baseX + perpX},${baseY + perpY} ${baseX - perpX},${baseY - perpY}`
      );
    }
  };

  private onUp = (ev: PointerEvent): void => {
    if (!this.drawing || !this.current) {
      this.drawing = false;
      return;
    }
    try {
      this.layer.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    this.drawing = false;

    // Discard zero-size shapes
    if (this.current.type === 'rect' && (this.current.bbox.width < 3 || this.current.bbox.height < 3)) {
      this.currentEl?.remove();
    } else if (this.current.type === 'arrow') {
      const f = this.current.from!;
      const t = this.current.to!;
      const len = Math.hypot(t.x - f.x, t.y - f.y);
      if (len < 8) {
        this.currentEl?.remove();
      } else {
        this.current.bbox = {
          x: Math.min(f.x, t.x),
          y: Math.min(f.y, t.y),
          width: Math.abs(t.x - f.x),
          height: Math.abs(t.y - f.y)
        };
        this.annotations.push(this.current);
      }
    } else if (this.current.type === 'free') {
      const pts = this.current.points!;
      if (pts.length < 2) {
        this.currentEl?.remove();
      } else {
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        const xMin = Math.min(...xs);
        const xMax = Math.max(...xs);
        const yMin = Math.min(...ys);
        const yMax = Math.max(...ys);
        this.current.bbox = { x: xMin, y: yMin, width: xMax - xMin, height: yMax - yMin };
        this.annotations.push(this.current);
      }
    } else if (this.current.type === 'rect') {
      this.annotations.push(this.current);
    }
    this.current = null;
    this.currentEl = null;
  };

  private openTextInput(clientX: number, clientY: number, pagePoint: { x: number; y: number }): void {
    this.dismissTextInput();
    this.pendingText = pagePoint;
    const layerRect = this.layer.getBoundingClientRect();
    this.textInput.style.left = `${clientX - layerRect.left}px`;
    this.textInput.style.top = `${clientY - layerRect.top}px`;
    this.textInput.hidden = false;
    this.textField.value = '';
    this.textField.focus();
  }

  private dismissTextInput(): void {
    this.textInput.hidden = true;
    this.pendingText = null;
  }

  private onTextKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      this.commitText();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      this.dismissTextInput();
    }
  };

  private onTextBlur = (): void => {
    // Defer so click-outside doesn't kill an immediate Enter.
    setTimeout(() => this.dismissTextInput(), 100);
  };

  private commitText(): void {
    if (!this.pendingText) return;
    const text = this.textField.value.trim();
    if (!text) {
      this.dismissTextInput();
      return;
    }
    const id = this.uid();
    const p = this.pendingText;
    const ann: Annotation = {
      id,
      type: 'text',
      color: this.color,
      bbox: { x: p.x, y: p.y, width: 0, height: 0 },
      text
    };

    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('data-id', id);

    // Approximate text bbox: 14px font * length * 0.6 char advance
    const fontPx = 14 * 1.5;
    const padX = 8;
    const padY = 4;
    const approxW = Math.max(40, text.length * fontPx * 0.55) + padX * 2;
    const approxH = fontPx + padY * 2;
    ann.bbox = { x: p.x, y: p.y, width: approxW, height: approxH };

    const bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('x', String(p.x));
    bg.setAttribute('y', String(p.y));
    bg.setAttribute('width', String(approxW));
    bg.setAttribute('height', String(approxH));
    bg.setAttribute('fill', this.color);
    bg.setAttribute('rx', '4');
    g.appendChild(bg);

    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', String(p.x + padX));
    t.setAttribute('y', String(p.y + padY + fontPx * 0.75));
    t.setAttribute('font-size', `${fontPx}`);
    t.setAttribute('font-family', 'sans-serif');
    t.setAttribute('fill', '#ffffff');
    t.textContent = text;
    g.appendChild(t);

    this.svg.appendChild(g);
    this.annotations.push(ann);
    this.dismissTextInput();
  }
}
