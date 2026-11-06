import { angleDiff } from '../../../sim/math';
import { esc } from '../../../util/html';
import { el } from '../../components/dom';
import { iconHtml } from '../../theme/icons';
import type { IslandUI } from '../context';

// The compass along the top of the screen: the four points, the places within sight, and where
// your quest leads, pinned to an edge while it's behind you.

export class Compass {
  readonly el = el('div', 'lui');

  constructor(private ui: IslandUI) {
    this.el.id = 'lui-compass';
  }

  update(): void {
    const yaw = this.ui.yaw();
    const p = this.ui.sim.player;
    const width = 560;
    const fov = Math.PI * 0.9;
    const xOf = (bearing: number): number | null => {
      const d = angleDiff(yaw, bearing);
      if (Math.abs(d) > fov / 2) return null;
      return width / 2 - (d / (fov / 2)) * (width / 2);
    };
    let html = '<div class="centre"></div>';
    const cards: Array<[string, number]> = [
      ['N', 0],
      ['W', Math.PI / 2],
      ['S', Math.PI],
      ['E', -Math.PI / 2],
    ];
    for (const [c, b] of cards) {
      const x = xOf(b);
      if (x !== null) html += `<div class="tick card" style="left:${x}px">${c}</div>`;
    }
    for (let k = 0; k < 8; k++) {
      const x = xOf((k * Math.PI) / 4 + Math.PI / 8);
      if (x !== null) html += `<div class="tick" style="left:${x}px;opacity:0.4">·</div>`;
    }
    for (const pl of this.ui.life.zone.recipe.places) {
      const dist = Math.hypot(pl.x - p.pos.x, pl.z - p.pos.z);
      if (dist < 30 || dist > 900) continue;
      const x = xOf(Math.atan2(pl.x - p.pos.x, pl.z - p.pos.z));
      if (x !== null) html += `<div class="poi" style="left:${x}px" title="${esc(pl.name)}">${iconHtml(pl.icon, undefined, 18)}</div>`;
    }
    const goal = this.ui.goal();
    if (goal) {
      const dist = Math.hypot(goal.x - p.pos.x, goal.z - p.pos.z);
      let x = xOf(Math.atan2(goal.x - p.pos.x, goal.z - p.pos.z));
      const off = x === null;
      if (off) x = angleDiff(yaw, Math.atan2(goal.x - p.pos.x, goal.z - p.pos.z)) > 0 ? 12 : width - 12;
      html += `<div class="goal" style="left:${x}px">${off ? '◆' : '▼'}<small>${Math.round(dist)} m</small></div>`;
    }
    this.el.innerHTML = html;
  }
}
