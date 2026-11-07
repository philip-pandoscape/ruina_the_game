import { questsAt } from '../../../engine/life';
import { el } from '../../components/dom';
import type { LifeContext } from '../context';
import { type WorldPictures, questMark } from '../map';

// The minimap, top right: the world around you, north up (each region's picture where the world
// places it, the sea between), with the places, who has a quest for you, other players, the quest's
// goal, the way you're travelling and you. Zooms in and out.

export class Minimap {
  readonly el = el('div');
  private canvas = document.createElement('canvas');
  private zoom = 1;

  constructor(
    private ui: LifeContext,
    private pictures: WorldPictures,
  ) {
    this.el.id = 'hud-minimap';
    this.el.innerHTML =
      '<div class="ring"></div><div class="rim"></div><i class="stud" style="left:50%;top:4.5px"></i><i class="stud" style="left:calc(100% - 4.5px);top:50%"></i>' +
      '<i class="stud" style="left:50%;top:calc(100% - 4.5px)"></i><i class="stud" style="left:4.5px;top:50%"></i><span class="n">N</span>' +
      '<span class="zoom in" data-zoom="1" title="Zoom In">+</span><span class="zoom out" data-zoom="-1" title="Zoom Out">−</span>';
    this.canvas.width = this.canvas.height = 280;
    this.el.prepend(this.canvas);
    this.el.addEventListener('click', (e) => {
      const z = (e.target as HTMLElement).closest('[data-zoom]') as HTMLElement | null;
      if (z) this.zoom = Math.max(0.5, Math.min(2.5, this.zoom * (Number(z.dataset.zoom) > 0 ? 1.4 : 1 / 1.4)));
    });
  }

  /** Every frame (`frame` counts them): drawn every other one. */
  update(frame: number): void {
    // Inside a dungeon the island's map has nothing to show of where you are.
    this.el.style.display = this.ui.life.dungeon ? 'none' : '';
    if (frame % 2 === 0 && !this.ui.life.dungeon) this.draw();
  }

  /** The world around you, north up, with what you're looking for. */
  private draw(): void {
    if (!this.ui.world.terrain) return;
    const g = this.canvas.getContext('2d')!;
    const N = this.canvas.width;
    const p = this.ui.sim.player;
    // 300 m across at the first zoom: north up, east to the right (x grows to the left).
    const span = 300 / this.zoom;
    const k = N / span;
    const at = (x: number, z: number): [number, number] => [(p.pos.x - x) * k + N / 2, (p.pos.z - z) * k + N / 2];
    g.fillStyle = '#3f8fa6';
    g.fillRect(0, 0, N, N);
    g.imageSmoothingEnabled = true;
    // Each region's picture where the world places it, those in view.
    for (const region of this.pictures.all()) {
      const f = region.frame;
      const [x0, y0] = at(f.minX + f.size, f.minZ + f.size);
      const w = f.size * k;
      if (x0 > N || y0 > N || x0 + w < 0 || y0 + w < 0) continue;
      const image = this.pictures.picture(region);
      if (image) g.drawImage(image, x0, y0, w, w);
    }
    const life = this.ui.life;
    const r = life.zone.recipe;
    g.font = 'bold 20px "Ruina Serif", Georgia, serif';
    g.textAlign = 'center';
    for (const pl of this.pictures.all().flatMap((region) => region.places)) {
      const [x, y] = at(pl.x, pl.z);
      if (x < -40 || y < -40 || x > N + 40 || y > N + 40) continue;
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(43,26,14,0.8)';
      g.strokeText(pl.name, x, y + 28);
      g.fillStyle = '#fff6e2';
      g.fillText(pl.name, x, y + 28);
    }
    // Townsfolk with something for you. A quest to hand in always shows: off the map, it is pinned
    // to the rim in their direction. One on offer shows while they are in view.
    const rim = N / 2 - 18;
    for (const n of r.npcs) {
      const qa = questsAt(life, n.id);
      const ready = qa.turnIn.length > 0;
      if (!ready && !qa.offer.length) continue;
      let [x, y] = at(n.x, n.z);
      const d = Math.hypot(x - N / 2, y - N / 2);
      if (d > rim) {
        if (!ready) continue;
        x = N / 2 + ((x - N / 2) / d) * rim;
        y = N / 2 + ((y - N / 2) / d) * rim;
      }
      questMark(g, x, y, ready, 15);
    }
    for (const o of this.ui.app.others()) {
      if (!o.online) continue;
      const [x, y] = at(o.x, o.z);
      g.fillStyle = '#5cc8ff';
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y, 7, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    const goal = this.ui.goal();
    if (goal) {
      let [gx, gy] = at(goal.x, goal.z);
      const d = Math.hypot(gx - N / 2, gy - N / 2);
      if (d > rim) {
        gx = N / 2 + ((gx - N / 2) / d) * rim;
        gy = N / 2 + ((gy - N / 2) / d) * rim;
      }
      g.strokeStyle = '#ffd166';
      g.lineWidth = 4;
      g.beginPath();
      g.arc(gx, gy, 11, 0, Math.PI * 2);
      g.stroke();
    }
    this.ui.travel()?.draw(g, at, 2, { cx: N / 2, cy: N / 2, r: rim });
    // You, pointing the way you face. North is up and east to the right, so a heading of `facing`
    // (x = sin, z = cos) points at (-sin, -cos) on the canvas: a turn of -facing from straight up.
    g.save();
    g.translate(N / 2, N / 2);
    g.rotate(-p.facing);
    g.fillStyle = '#ff5a5a';
    g.strokeStyle = '#fff';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(0, -16);
    g.lineTo(11, 12);
    g.lineTo(0, 6);
    g.lineTo(-11, 12);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }
}
