import { dungeonDef } from '../../../engine/zone';
import type { ZonePlace } from '../../../engine/zone';
import { esc } from '../../../util/html';
import { el } from '../../components/dom';
import { withIcons } from '../../theme/icons';
import type { IslandUI } from '../context';

// The banner that names a place as you come to it, and the prompt that says what F (Y on a
// controller) does here.

export class Banner {
  readonly el = el('div', 'lui');
  private place = '';
  private time = 0;

  constructor(
    private ui: IslandUI,
    /** Every region's places, as the maps know them (the region you start in's alone without them). */
    private places: () => Array<{ place: ZonePlace; region: string }> = () =>
      ui.life.zone.recipe.places.map((place) => ({ place, region: ui.life.zone.recipe.name })),
  ) {
    this.el.id = 'lui-banner';
  }

  update(dt: number): void {
    const life = this.ui.life;
    const p = this.ui.sim.player;
    let here = '';
    let best = Infinity;
    const places = this.places();
    for (const { place: pl } of places) {
      const r = pl.kind === 'village' ? 75 : pl.kind === 'forest' ? 140 : 55;
      const d = Math.hypot(pl.x - p.pos.x, pl.z - p.pos.z);
      if (d < r && d < best) {
        best = d;
        here = pl.id;
      }
    }
    // Inside a dungeon, its name: nowhere on the island is here.
    const dungeon = life.dungeon ? dungeonDef(life.dungeon) : undefined;
    if (dungeon) here = `dungeon:${dungeon.id}`;
    if (here && here !== this.place) {
      const at = places.find((x) => x.place.id === here);
      const [name, sub] = dungeon ? [dungeon.name, 'Dungeon'] : [at?.place.name ?? '', at?.region ?? life.zone.recipe.name];
      this.el.innerHTML = `<div class="name">${esc(name)}</div><div class="sub">${esc(sub)}</div>`;
      this.el.classList.add('show');
      this.time = 0;
    }
    this.place = here;
    this.time += dt;
    if (this.time > 2.8) this.el.classList.remove('show');
  }
}

export class Prompt {
  readonly el = el('div', 'lui');

  constructor(private ui: IslandUI) {
    this.el.id = 'lui-prompt';
  }

  update(): void {
    const f = this.ui.life.focus;
    if (!f || this.ui.talkingTo() || this.ui.modal()) {
      this.el.classList.remove('show');
      return;
    }
    const key = this.ui.device() === 'gamepad' ? 'Y' : 'F';
    this.el.className = `lui show${f.ok ? '' : ' off'}`;
    this.el.innerHTML = `${f.ok ? `<span class="key">${key}</span>` : ''}<span>${withIcons(f.label)}</span>${f.detail ? `<span class="detail">${withIcons(f.detail)}</span>` : ''}`;
  }
}
