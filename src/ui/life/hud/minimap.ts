import { questsAt } from '../../../engine/island';
import { el } from '../../components/dom';
import type { IslandUI } from '../context';
import { type IslandPicture, questMark } from '../map';

// The minimap, top right: the island around you, north up, with the places, who has a quest for
// you, other players, the quest's goal, the way you're travelling and you. Zooms in and out.

export class Minimap {
  readonly el = el('div');
  private canvas = document.createElement('canvas');
  private zoom = 1;

  constructor(
    private ui: IslandUI,
    private picture: IslandPicture,
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

  /** The island around you, north up, with what you're looking for. */
  private draw(): void {
    const hf = this.ui.world.terrain;
    if (!hf) return;
    const image = this.picture.get();
    const g = this.canvas.getContext('2d')!;
    const N = this.canvas.width;
    const p = this.ui.sim.player;
    const toPx = (x: number, z: number): [number, number] => [((hf.max - x) / hf.size) * 768, ((hf.max - z) / hf.size) * 768];
    const [px, py] = toPx(p.pos.x, p.pos.z);
    const span = 150 / this.zoom; // map pixels across the minimap
    const k = N / span;
    const at = (x: number, z: number): [number, number] => {
      const [mx, my] = toPx(x, z);
      return [(mx - px) * k + N / 2, (my - py) * k + N / 2];
    };
    g.fillStyle = '#3f8fa6';
    g.fillRect(0, 0, N, N);
    g.imageSmoothingEnabled = true;
    g.drawImage(image, px - span / 2, py - span / 2, span, span, 0, 0, N, N);
    const life = this.ui.life;
    const r = life.zone.recipe;
    g.font = 'bold 20px "Ruina Serif", Georgia, serif';
    g.textAlign = 'center';
    for (const pl of r.places) {
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
