import type { Phase } from './types';

// The timeline under the picture: frame numbers, what the animation is doing when (bands from the
// rules' own frame counts: a swing's wind-up, strike and recovery, the air, a landing), the notes
// along it, a stretch of frames picked out, and the playhead. Drag to scrub, shift-drag (or [ and ])
// to pick a stretch, double-click a band to pick it, wheel to zoom, shift-wheel to pan.

export const PHASE_COLOURS: Record<string, string> = {
  windup: '#e9b949',
  strike: '#ef5b5b',
  recover: '#5b8def',
  air: '#9a7cf2',
  land: '#36c2b4',
  hurt: '#e0517a',
  move: '#4caf7a',
  travel: '#2fa6d6',
  cast: '#c86cf0',
  idle: '#4b5361',
  other: '#8a94a6',
};

export interface Marker {
  id: string;
  kind: 'anim' | 'range' | 'frame';
  from: number;
  to: number;
  done: boolean;
  fix: boolean;
  text: string;
}

const RULER = 20;
const BAND = 22;
const NOTES = 18;
const PAD = 10;

export class Timeline {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private tip: HTMLElement;
  frames = 1;
  fps = 60;
  frame = 0;
  range: [number, number] | null = null;
  phases: Phase[] = [];
  markers: Marker[] = [];
  baked = 0;
  /** The visible window, in frames. */
  private v0 = 0;
  private v1 = 1;
  private drag: { mode: 'scrub' | 'range' | 'pan'; start: number; x: number; v0: number } | null = null;
  onSeek: (f: number) => void = () => {};
  onRange: (r: [number, number] | null) => void = () => {};
  onMarker: (id: string) => void = () => {};
  onScrubStart: () => void = () => {};

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'timeline';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'timeline-canvas';
    this.tip = document.createElement('div');
    this.tip.className = 'timeline-tip';
    this.el.append(this.canvas, this.tip);
    new ResizeObserver(() => this.draw()).observe(this.el);
    this.canvas.addEventListener('pointerdown', (e) => this.down(e));
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    this.canvas.addEventListener('pointerup', (e) => this.up(e));
    this.canvas.addEventListener('pointerleave', () => (this.tip.style.opacity = '0'));
    this.canvas.addEventListener('dblclick', (e) => this.dbl(e));
    this.canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
  }

  get height(): number {
    return RULER + BAND + NOTES + 8;
  }

  set(frames: number, fps: number, phases: Phase[]): void {
    this.frames = Math.max(1, frames);
    this.fps = fps;
    this.phases = phases;
    this.v0 = 0;
    this.v1 = this.frames;
    this.range = null;
    this.draw();
  }

  /** Keeps the playhead in view when zoomed in. */
  follow(): void {
    const span = this.v1 - this.v0;
    if (span >= this.frames) return;
    if (this.frame < this.v0 || this.frame > this.v1 - 1) {
      this.v0 = Math.max(0, Math.min(this.frames - span, this.frame - span * 0.2));
      this.v1 = this.v0 + span;
    }
  }

  private width(): number {
    return this.canvas.clientWidth;
  }

  private x(f: number): number {
    const w = this.width() - PAD * 2;
    return PAD + ((f - this.v0) / (this.v1 - this.v0)) * w;
  }

  private f(x: number): number {
    const w = this.width() - PAD * 2;
    return this.v0 + ((x - PAD) / w) * (this.v1 - this.v0);
  }

  private frameAt(x: number): number {
    return Math.max(0, Math.min(this.frames - 1, Math.floor(this.f(x))));
  }

  draw(): void {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.el.clientWidth;
    const h = this.height;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const fw = (w - PAD * 2) / (this.v1 - this.v0);

    // Ruler: a tick a frame when there's room, numbers at a round step.
    g.fillStyle = '#1b1f27';
    g.fillRect(0, 0, w, RULER);
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const label = steps.find((s) => s * fw >= 46) ?? 1200;
    const minor = steps.find((s) => s * fw >= 7) ?? label;
    g.font = '10px ui-monospace, SFMono-Regular, Consolas, monospace';
    g.textBaseline = 'middle';
    const first = Math.max(0, Math.floor(this.v0 / minor) * minor);
    for (let f = first; f <= Math.min(this.frames, this.v1); f += minor) {
      const x = Math.round(this.x(f)) + 0.5;
      const big = f % label === 0;
      g.strokeStyle = big ? 'rgba(200,210,230,0.45)' : 'rgba(200,210,230,0.16)';
      g.beginPath();
      g.moveTo(x, big ? 4 : RULER - 6);
      g.lineTo(x, RULER);
      g.stroke();
      if (big) {
        g.fillStyle = '#8f9bb0';
        g.fillText(String(f), x + 3, 8);
      }
    }

    // Bands: what it's doing when.
    const by = RULER + 2;
    for (const p of this.phases) {
      if (p.to + 1 < this.v0 || p.from > this.v1) continue;
      const x0 = this.x(p.from);
      const x1 = this.x(p.to + 1);
      g.fillStyle = PHASE_COLOURS[p.kind] ?? PHASE_COLOURS.other;
      g.globalAlpha = p.kind === 'idle' ? 0.55 : 0.82;
      roundRect(g, x0 + 0.5, by, Math.max(1, x1 - x0 - 1), BAND - 4, 3);
      g.fill();
      g.globalAlpha = 1;
      if (x1 - x0 > 46) {
        g.save();
        g.beginPath();
        g.rect(x0, by, x1 - x0 - 2, BAND - 4);
        g.clip();
        g.fillStyle = 'rgba(12,14,18,0.86)';
        g.font = '600 10px system-ui, sans-serif';
        g.fillText(p.label, x0 + 5, by + (BAND - 4) / 2 + 0.5);
        g.restore();
      }
    }

    // Notes along it.
    const ny = RULER + BAND + 1;
    g.fillStyle = 'rgba(255,255,255,0.03)';
    g.fillRect(0, ny, w, NOTES);
    for (const m of this.markers) {
      if (m.kind === 'anim') continue;
      const colour = m.done ? '#5f6b7d' : m.fix ? '#3ddc97' : '#ffcf5a';
      if (m.kind === 'range') {
        const x0 = this.x(m.from);
        const x1 = this.x(m.to + 1);
        g.fillStyle = colour;
        g.globalAlpha = 0.35;
        roundRect(g, x0, ny + 4, Math.max(3, x1 - x0), NOTES - 8, 3);
        g.fill();
        g.globalAlpha = 1;
        g.fillRect(x0, ny + 3, 2, NOTES - 6);
        g.fillRect(x1 - 2, ny + 3, 2, NOTES - 6);
      } else {
        const x = this.x(m.from + 0.5);
        g.fillStyle = colour;
        g.beginPath();
        g.moveTo(x, ny + 3);
        g.lineTo(x + 5, ny + NOTES / 2);
        g.lineTo(x, ny + NOTES - 3);
        g.lineTo(x - 5, ny + NOTES / 2);
        g.closePath();
        g.fill();
      }
    }

    // Not worked out yet.
    if (this.baked < this.frames) {
      const x = this.x(this.baked);
      g.fillStyle = 'rgba(10,12,16,0.45)';
      g.fillRect(x, RULER, w - x, BAND + NOTES);
    }

    // The picked stretch.
    if (this.range) {
      const x0 = this.x(this.range[0]);
      const x1 = this.x(this.range[1] + 1);
      g.fillStyle = 'rgba(120,170,255,0.16)';
      g.fillRect(x0, 0, x1 - x0, h);
      g.fillStyle = '#78aaff';
      g.fillRect(x0 - 1, 0, 2, h);
      g.fillRect(x1 - 1, 0, 2, h);
    }

    // The playhead: as wide as a frame when zoomed in.
    const px0 = this.x(this.frame);
    const pw = Math.max(2, fw);
    g.fillStyle = 'rgba(255,255,255,0.12)';
    if (fw > 4) g.fillRect(px0, RULER, pw, h - RULER);
    const pc = px0 + (fw > 4 ? pw / 2 : 0);
    g.fillStyle = '#ffffff';
    g.fillRect(Math.round(pc) - 1, 0, 2, h);
    g.beginPath();
    g.moveTo(pc - 6, 0);
    g.lineTo(pc + 6, 0);
    g.lineTo(pc, 7);
    g.closePath();
    g.fill();
  }

  private down(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    this.canvas.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.altKey) {
      this.drag = { mode: 'pan', start: 0, x, v0: this.v0 };
      return;
    }
    // A note's marker: jump to it.
    if (!e.shiftKey && y > RULER + BAND) {
      const hit = this.markerAt(x);
      if (hit) {
        this.onMarker(hit.id);
        return;
      }
    }
    const f = this.frameAt(x);
    if (e.shiftKey) {
      this.drag = { mode: 'range', start: f, x, v0: this.v0 };
      this.range = [f, f];
      this.onRange(this.range);
    } else {
      this.drag = { mode: 'scrub', start: f, x, v0: this.v0 };
      this.onScrubStart();
      this.onSeek(f);
    }
    this.draw();
  }

  private move(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const d = this.drag;
    if (d?.mode === 'pan') {
      const span = this.v1 - this.v0;
      const df = ((x - d.x) / (this.width() - PAD * 2)) * span;
      this.v0 = Math.max(0, Math.min(this.frames - span, d.v0 - df));
      this.v1 = this.v0 + span;
      this.draw();
      return;
    }
    if (d) {
      const f = this.frameAt(x);
      if (d.mode === 'scrub') this.onSeek(f);
      else {
        this.range = [Math.min(d.start, f), Math.max(d.start, f)];
        this.onRange(this.range);
      }
      this.draw();
    }
    this.hover(x, y);
  }

  private up(e: PointerEvent): void {
    this.canvas.releasePointerCapture(e.pointerId);
    this.drag = null;
  }

  private dbl(e: MouseEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (y < RULER || y > RULER + BAND) return;
    const f = this.frameAt(x);
    const p = this.phases.find((q) => f >= q.from && f <= q.to);
    if (!p) return;
    this.range = [p.from, p.to];
    this.onRange(this.range);
    this.draw();
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const span = this.v1 - this.v0;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const df = ((e.shiftKey ? e.deltaY : e.deltaX) / (this.width() - PAD * 2)) * span;
      this.v0 = Math.max(0, Math.min(this.frames - span, this.v0 + df));
      this.v1 = this.v0 + span;
    } else {
      const at = this.f(x);
      const k = Math.exp(e.deltaY * 0.0015);
      const next = Math.max(Math.min(12, this.frames), Math.min(this.frames, span * k));
      this.v0 = Math.max(0, Math.min(this.frames - next, at - ((at - this.v0) / span) * next));
      this.v1 = this.v0 + next;
    }
    this.draw();
  }

  private markerAt(x: number): Marker | null {
    let best: Marker | null = null;
    let bestD = 8;
    for (const m of this.markers) {
      if (m.kind === 'anim') continue;
      if (m.kind === 'range' && x >= this.x(m.from) && x <= this.x(m.to + 1)) return m;
      const d = Math.abs(this.x(m.from + 0.5) - x);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  private hover(x: number, y: number): void {
    let text = '';
    if (y > RULER + BAND) {
      const m = this.markerAt(x);
      if (m) text = `${m.kind === 'range' ? `Frames ${m.from}–${m.to}` : `Frame ${m.from}`}${m.fix ? ' · pose fix' : ''}: ${m.text || '(no words)'}`;
    } else if (y > RULER) {
      const f = this.frameAt(x);
      const p = this.phases.find((q) => f >= q.from && f <= q.to);
      if (p) text = `${p.label} · frames ${p.from}–${p.to} (${p.to - p.from + 1})`;
    } else {
      const f = this.frameAt(x);
      text = `Frame ${f} · ${(f / this.fps).toFixed(2)} s`;
    }
    this.tip.textContent = text;
    this.tip.style.opacity = text ? '1' : '0';
    const w = this.el.clientWidth;
    this.tip.style.left = `${Math.min(w - 12, Math.max(12, x))}px`;
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const k = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + k, y);
  g.arcTo(x + w, y, x + w, y + h, k);
  g.arcTo(x + w, y + h, x, y + h, k);
  g.arcTo(x, y + h, x, y, k);
  g.arcTo(x, y, x + w, y, k);
  g.closePath();
}
