import type { World } from '../../sim/types';
import type { AutoWalk, Refusal, WalkEvent } from '../../app/autoWalk';
import { routeFrom, type Point } from '../../sim/zone/roads';
import { openMenu } from '../theme/contextMenu';
import { uiIcon } from '../theme/icons';
import { uiRoot } from '../theme/scale';
import { esc } from '../../util/html';

// Travel by road and auto-run, as the island's UI shows them. On the map a click marks a spot and
// sets off along the roads to it (a right-click offers the rest), the arrows or the D-pad pick a
// place and Enter or A sets off; the way is drawn on the map and the minimap. Under the compass, a
// readout while something walks for you, saying how to stop. The walking is src/app/autoWalk.ts.

interface Place {
  id: string;
  name: string;
  icon: string;
  x: number;
  z: number;
}

type Handler = (arg: string, e: MouseEvent | null) => void;
type Press = 'up' | 'down' | 'left' | 'right' | 'select' | 'back' | 'reset' | 'tab' | 'toggle' | 'tree';

export interface TravelDeps {
  walk: AutoWalk;
  world: World;
  places: () => Place[];
  /** Where you are. */
  player: () => Point;
  device: () => 'keyboard' | 'gamepad';
  toast: (text: string, kind?: string) => void;
}

/** A click this close to a place on the big map (its pixels) is a click on the place. */
const SNAP_PX = 14;
/** The map is drawn this many pixels across. */
const MAP_PX = 768;
/** What the map calls a spot that isn't a place. */
const SPOT = 'Marked Spot';
const GOLD = '#ffd166';
const INK = 'rgba(43, 26, 14, 0.85)';

export class TravelUI {
  private readout = document.createElement('div');
  private shown = '';

  constructor(private d: TravelDeps) {
    this.readout.id = 'lui-walk';
    this.readout.className = 'lui';
    uiRoot().appendChild(this.readout);
    d.walk.onEvent = (e) => this.said(e);
  }

  private get walk(): AutoWalk {
    return this.d.walk;
  }

  /** How to set off with the auto-walk key on this device, for the toasts. */
  private key(): string {
    return this.d.device() === 'gamepad' ? 'click the left stick' : 'press H';
  }

  /** Why travel can't start, as the toasts put it; `brief` for a menu entry's note. */
  private refusal(why: Refusal, brief = false): string {
    switch (why) {
      case 'offRoad':
        return brief ? 'No road under your feet' : `No road under your feet - get onto one, then ${this.key()} to follow it there`;
      case 'noWay':
        return 'No road leads there from here';
      case 'swim':
        return 'Swim ashore and find a road first';
      case 'glide':
        return 'Land on a road first';
      case 'boat':
        return 'Boats keep to the water - the roads are for feet, hooves and wheels';
      case 'down':
        return 'Get back on your feet first';
      case 'here':
        return "You're already there";
      case 'along':
        return "You're riding along - whoever's vehicle it is does the driving";
    }
  }

  private said(e: WalkEvent): void {
    const t = this.d.toast;
    if (e.t === 'arrived') t(`Arrived at ${e.label}`, 'good');
    else if (e.t === 'roadEnds') t(`The road goes no nearer - ${e.label} is ${Math.round(e.left)} m on`, 'info');
    else if (e.t === 'stuck') t("Something's in the way - you'll have to go round it", 'bad');
    else if (e.t === 'lost') t("You've left the road", 'info');
    else if (e.t === 'water') t('In the water - swim back to the road', 'info');
    else if (e.t === 'refused') t(this.refusal(e.why), 'bad');
  }

  /** The auto-walk key (H, Num Lock, a click of the left stick). */
  toggle(): void {
    this.walk.toggle();
  }

  /** You did something by hand (F): stop walking for you, unless it's the glider's gust. */
  interrupt(gliding: boolean): void {
    if (!gliding) this.walk.stop();
  }

  // ---------- The readout under the compass ----------

  update(): void {
    const w = this.walk;
    const pad = this.d.device() === 'gamepad';
    let html = '';
    if (w.mode === 'run') {
      const stop = pad ? '<span class="key">L</span>' : '<span class="key">W</span><span class="key">S</span>';
      html = `${uiIcon('stamina', 20)}<span class="lbl">Auto-Run</span><span class="stop">${stop}Stop</span>`;
    } else if (w.mode === 'travel') {
      const stop = pad ? '<span class="key">L</span>' : '<span class="key">WASD</span>';
      const to = w.marker?.label ?? SPOT;
      html = `${uiIcon('compass', 20)}<span class="lbl">Travelling to ${esc(to)}</span><span class="dist">${Math.round(w.left)} m</span><span class="stop">${stop}Stop</span>`;
    }
    if (html === this.shown) return;
    this.shown = html;
    this.readout.innerHTML = html;
    this.readout.classList.toggle('show', !!html);
  }

  // ---------- Drawing the way ----------

  /**
   * The way still to go and the marker, on a map canvas: `at` turns the world into its pixels,
   * `px` is how wide a line is there. On the minimap, `rim` pins a marker off its edge to the edge.
   */
  draw(g: CanvasRenderingContext2D, at: (x: number, z: number) => [number, number], px: number, rim?: { cx: number; cy: number; r: number }): void {
    const w = this.walk;
    const m = w.marker;
    if (!m) return;
    const r = w.route;
    if (r) {
      const left = routeFrom(r, w.progress).map(([x, z]) => at(x, z));
      line(g, left, px * 4, INK, []);
      line(g, left, px * 2.2, GOLD, []);
      // The rest of the way, off the road: dotted.
      if (r.short > 2) {
        const end = r.points[r.points.length - 1];
        const off = [at(end[0], end[1]), at(m.x, m.z)];
        line(g, off, px * 1.6, INK, [px * 2, px * 3]);
      }
    }
    let [mx, my] = at(m.x, m.z);
    if (rim) {
      const d = Math.hypot(mx - rim.cx, my - rim.cy);
      if (d > rim.r) {
        mx = rim.cx + ((mx - rim.cx) / d) * rim.r;
        my = rim.cy + ((my - rim.cy) / d) * rim.r;
      }
    }
    pin(g, mx, my, px * 3.4);
  }

  // ---------- The map window ----------

  /** Wires the big map's canvas: a click marks and goes, a right-click lists what you can do. */
  attachMap(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('click', (e) => {
      e.stopPropagation();
      const at = this.spotAt(canvas, e);
      const m = this.walk.marker;
      // A second click on the marker while on the way there: stop and forget it.
      if (m && this.walk.mode === 'travel' && this.nearMarker(canvas, e)) return this.walk.clearMarker();
      this.walk.mark(at.x, at.z, at.label);
      this.walk.travel();
    });
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const at = this.spotAt(canvas, e);
      const why = this.walk.refusal();
      openMenu(e.clientX, e.clientY, at.label, [
        {
          label: 'Travel Here',
          primary: true,
          disabled: why ? this.refusal(why, true) : undefined,
          run: () => {
            this.walk.mark(at.x, at.z, at.label);
            this.walk.travel();
          },
        },
        { label: 'Mark Here', run: () => this.walk.mark(at.x, at.z, at.label) },
        ...(this.walk.marker ? [{ label: 'Clear Marker', run: () => this.walk.clearMarker() }] : []),
      ]);
    });
    canvas.addEventListener('mousemove', (e) => {
      canvas.style.cursor = this.placeAt(canvas, e) ? 'pointer' : 'crosshair';
    });
  }

  /** The world under a point of the map, snapped to a place when it's on one. */
  private spotAt(canvas: HTMLCanvasElement, e: MouseEvent): { x: number; z: number; label: string } {
    const pl = this.placeAt(canvas, e);
    if (pl) return { x: pl.x, z: pl.z, label: pl.name };
    const [px, py] = this.pixel(canvas, e);
    const hf = this.d.world.terrain!;
    return { x: hf.max - (px / MAP_PX) * hf.size, z: hf.max - (py / MAP_PX) * hf.size, label: SPOT };
  }

  /** Where on the map's own pixels a mouse event is. */
  private pixel(canvas: HTMLCanvasElement, e: MouseEvent): Point {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * MAP_PX, ((e.clientY - r.top) / r.height) * MAP_PX];
  }

  private toPx(x: number, z: number): Point {
    const hf = this.d.world.terrain!;
    return [((hf.max - x) / hf.size) * MAP_PX, ((hf.max - z) / hf.size) * MAP_PX];
  }

  private placeAt(canvas: HTMLCanvasElement, e: MouseEvent): Place | null {
    const [px, py] = this.pixel(canvas, e);
    let best: Place | null = null;
    let bestD = SNAP_PX;
    for (const pl of this.d.places()) {
      const [x, y] = this.toPx(pl.x, pl.z);
      // The icon sits on the spot and the name under it: either counts.
      const d = Math.min(Math.hypot(x - px, y - py), Math.hypot(x - px, y + 18 - py));
      if (d < bestD) {
        bestD = d;
        best = pl;
      }
    }
    return best;
  }

  private nearMarker(canvas: HTMLCanvasElement, e: MouseEvent): boolean {
    const m = this.walk.marker;
    if (!m) return false;
    const [px, py] = this.pixel(canvas, e);
    const [x, y] = this.toPx(m.x, m.z);
    return Math.hypot(x - px, y - py) < SNAP_PX;
  }

  /** What the map window's foot needs to show changed: draw it again. */
  sig(): string {
    const w = this.walk;
    return `${w.revision}|${w.mode}|${this.d.device()}|${w.marker && w.mode !== 'travel' ? (w.refusal() ?? '') : ''}`;
  }

  /** The map window's foot: what is marked, and setting off, stopping or clearing it. */
  foot(): { html: string; handlers: Record<string, Handler> } {
    const w = this.walk;
    const m = w.marker;
    const pad = this.d.device() === 'gamepad';
    if (!m) {
      const how = pad ? 'Pick a place with the D-pad, then press A to travel there by road.' : 'Click a place to travel there by road. Right-click for more.';
      return { html: `<span class="note">${how}</span>`, handlers: {} };
    }
    const going = w.mode === 'travel';
    const why = going ? null : w.refusal();
    const status = going ? 'On the Way' : why === 'offRoad' ? 'Off the Road' : 'Marked';
    const go = going
      ? '<button class="lui-btn" data-act="halt">Stop</button>'
      : `<button class="lui-btn gold" data-act="go"${why ? ` disabled title="${esc(this.refusal(why))}"` : ''}>Travel</button>`;
    return {
      html: `<span>${uiIcon('flag', 20)} <b>${esc(m.label)}</b> · ${status}</span><span style="display:flex;gap:10px"><button class="lui-btn small" data-act="unmark">Clear Marker</button>${go}</span>`,
      handlers: {
        unmark: () => w.clearMarker(),
        halt: () => w.stop(),
        go: () => w.travel(),
      },
    };
  }

  /**
   * Arrows, the D-pad or the stick on the open map pick the next place that way, Enter or A sets
   * off (or stops), Y clears the marker. Returns false for presses that aren't the map's.
   */
  mapPress(m: Press): boolean {
    const w = this.walk;
    if (m === 'select') {
      if (w.mode === 'travel') w.stop();
      else if (w.marker) w.travel();
      return true;
    }
    if (m === 'reset') {
      w.clearMarker();
      return true;
    }
    if (m !== 'up' && m !== 'down' && m !== 'left' && m !== 'right') return false;
    // North is up the map and east to the right, which is -x. From the marker, or from you.
    const [dx, dz] = { up: [0, 1], down: [0, -1], left: [1, 0], right: [-1, 0] }[m];
    const [fx, fz] = w.marker ? [w.marker.x, w.marker.z] : this.d.player();
    let best: Place | null = null;
    let bestScore = Infinity;
    for (const pl of this.d.places()) {
      const ox = pl.x - fx;
      const oz = pl.z - fz;
      const dist = Math.hypot(ox, oz);
      if (dist < 1) continue;
      const cos = (ox * dx + oz * dz) / dist;
      if (cos < 0.34) continue; // within 70 degrees of the way pressed
      const score = dist * (2 - cos);
      if (score < bestScore) {
        bestScore = score;
        best = pl;
      }
    }
    if (best) w.mark(best.x, best.z, best.name);
    return true;
  }
}

/** A polyline on a canvas, `dash` empty for a solid one. */
function line(g: CanvasRenderingContext2D, pts: Point[], width: number, colour: string, dash: number[]): void {
  if (pts.length < 2) return;
  g.save();
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.setLineDash(dash);
  g.lineWidth = width;
  g.strokeStyle = colour;
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let k = 1; k < pts.length; k++) g.lineTo(pts[k][0], pts[k][1]);
  g.stroke();
  g.restore();
}

/** The marker: a gold pin whose point is on the spot. */
function pin(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  g.save();
  g.beginPath();
  g.moveTo(x, y);
  g.arc(x, y - r * 1.9, r, Math.PI * 0.75, Math.PI * 2.25);
  g.closePath();
  g.fillStyle = GOLD;
  g.strokeStyle = '#2b1a0e';
  g.lineWidth = Math.max(1.5, r * 0.35);
  g.fill();
  g.stroke();
  g.beginPath();
  g.arc(x, y - r * 1.9, r * 0.38, 0, Math.PI * 2);
  g.fillStyle = '#7a1f26';
  g.fill();
  g.restore();
}
