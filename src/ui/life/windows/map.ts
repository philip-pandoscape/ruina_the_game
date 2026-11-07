import { rideable } from '../../../content/vehicles';
import { housePose, questsAt } from '../../../engine/island';
import { esc } from '../../../util/html';
import type { View } from '../../components/window';
import { iconImage } from '../../theme/icons';
import type { IslandUI } from '../context';
import { type MapFrame, type MapRegion, toMapPx, type WorldPictures, mapIcon, questMark } from '../map';

// The map (M), the one window that takes over the screen: the region you're in from above with its
// places, your things (scarecrows, house, vehicles), who has a quest for you, other players, the
// quest's goal, the way you're travelling and you; or, with World Map, the whole world: every region
// where it stands, named, the sea between, and you. A click on the region's map travels there by road
// (src/ui/life/travelUI.ts, which also says in its foot what is marked); drawn again every frame while
// it's open.

export class MapWindow {
  readonly canvas = document.createElement('canvas');
  /** World Map and back, over the map. */
  readonly scope = document.createElement('button');
  /** What travel by road said when the foot was drawn. */
  private travelSig = '';
  /** Showing the whole world, not the region you're in. */
  private wide = false;

  constructor(
    private ui: IslandUI,
    private pictures: WorldPictures,
  ) {
    this.canvas.width = this.canvas.height = 768;
    this.scope.className = 'map-scope';
    this.scope.addEventListener('click', () => {
      this.wide = !this.wide;
      this.ui.redraw();
    });
  }

  /** The region the map shows: the one you're in (or nearest). */
  region(): MapRegion {
    const p = this.ui.sim.player;
    return this.pictures.at(p.pos.x, p.pos.z);
  }

  /** The square of the world the map shows now. */
  frame(): MapFrame {
    return this.wide ? this.pictures.worldFrame() : this.region().frame;
  }

  /** Whether it shows the whole world (travel by road takes no clicks on it then). */
  get world(): boolean {
    return this.wide;
  }

  view(): View {
    const r = this.region();
    const foot = this.ui.travel()?.foot();
    return {
      title: this.wide ? 'World Map' : r.name,
      sub: esc(this.wide ? `${this.pictures.all().length} regions` : r.subtitle),
      cls: 'center map',
      w: 734,
      body: '',
      foot: foot?.html,
      handlers: foot?.handlers,
    };
  }

  /** Puts the map in the window's body and draws it. */
  show(body: HTMLElement): void {
    this.travelSig = this.ui.travel()?.sig() ?? '';
    // Only where the world has more than one region is there a world to show.
    this.scope.textContent = this.wide ? 'Region Map' : 'World Map';
    if (this.pictures.all().length > 1) body.append(this.scope);
    body.append(this.canvas);
    this.draw();
  }

  /** Travel by road has changed what the window's foot says. */
  stale(): boolean {
    const travel = this.ui.travel();
    return !!travel && travel.sig() !== this.travelSig;
  }

  /** The region you're in from above with places, your things, other players, the goal and you (or the world). */
  draw(): void {
    if (this.wide) return this.drawWorld();
    const life = this.ui.life;
    const region = this.region();
    const f = region.frame;
    const g = this.canvas.getContext('2d')!;
    const image = this.pictures.picture(region);
    g.fillStyle = '#3f8fa6';
    g.fillRect(0, 0, 768, 768);
    if (image) g.drawImage(image, 0, 0, 768, 768);
    const toPx = (x: number, z: number): [number, number] => toMapPx(f, x, z, 768);
    g.textAlign = 'center';
    for (const pl of region.places) {
      const [px, py] = toPx(pl.x, pl.z);
      mapIcon(g, iconImage(pl.icon), px, py - 2, 30);
      g.font = 'bold 12px "Ruina Serif", Georgia, serif';
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(43,26,14,0.8)';
      g.strokeText(pl.name, px, py + 20);
      g.fillStyle = '#fff6e2';
      g.fillText(pl.name, px, py + 20);
    }
    for (const sc of life.land.scarecrows) {
      const [px, py] = toPx(sc.x, sc.z);
      g.fillStyle = '#7e5636';
      g.fillRect(px - 4, py - 4, 8, 8);
    }
    for (const h of life.land.houses) {
      const pose = housePose(life, h);
      const [px, py] = toPx(pose.x, pose.z);
      mapIcon(g, iconImage('🏠'), px, py, 26);
    }
    for (const v of life.land.vehicles) {
      const [px, py] = toPx(v.x, v.z);
      mapIcon(g, iconImage(rideable(v.def).icon), px, py, 26);
    }
    // Townsfolk with a quest for you, or one to hand in.
    for (const n of life.zone.recipe.npcs) {
      const qa = questsAt(life, n.id);
      if (!qa.offer.length && !qa.turnIn.length) continue;
      const [px, py] = toPx(n.x, n.z);
      questMark(g, px, py - 16, qa.turnIn.length > 0, 11);
    }
    for (const o of this.ui.app.others()) {
      if (!o.online) continue;
      const [ox, oy] = toPx(o.x, o.z);
      g.fillStyle = '#5cc8ff';
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(ox, oy, 6, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.font = 'bold 12px "Ruina Serif", Georgia, serif';
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(43,26,14,0.8)';
      g.strokeText(o.name, ox, oy - 10);
      g.fillStyle = '#fff';
      g.fillText(o.name, ox, oy - 10);
    }
    const goal = this.ui.goal();
    if (goal) {
      const [px, py] = toPx(goal.x, goal.z);
      g.strokeStyle = '#ffd166';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(px, py, 10 + Math.sin(performance.now() / 200) * 2, 0, Math.PI * 2);
      g.stroke();
      // What it is, above the ring.
      g.font = 'bold 12px "Ruina Serif", Georgia, serif';
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(43,26,14,0.8)';
      g.strokeText(goal.label, px, py - 16);
      g.fillStyle = '#ffd166';
      g.fillText(goal.label, px, py - 16);
    }
    this.ui.travel()?.draw(g, toPx, 1.8);
    const p = this.ui.sim.player;
    const [px, py] = toPx(p.pos.x, p.pos.z);
    g.save();
    g.translate(px, py);
    g.rotate(-p.facing); // north up, as on the minimap
    g.fillStyle = '#ff5a5a';
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, -10);
    g.lineTo(7, 8);
    g.lineTo(0, 4);
    g.lineTo(-7, 8);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }

  /** The whole world: every region where it stands (its picture once painted, else its outline), named, and you. */
  private drawWorld(): void {
    const f = this.pictures.worldFrame();
    const g = this.canvas.getContext('2d')!;
    const toPx = (x: number, z: number): [number, number] => toMapPx(f, x, z, 768);
    g.fillStyle = '#3f8fa6';
    g.fillRect(0, 0, 768, 768);
    g.textAlign = 'center';
    for (const r of this.pictures.all()) {
      const [x0, y0] = toPx(r.frame.minX + r.frame.size, r.frame.minZ + r.frame.size);
      const w = (r.frame.size / f.size) * 768;
      const image = this.pictures.picture(r);
      if (image) g.drawImage(image, x0, y0, w, w);
      g.strokeStyle = 'rgba(255, 246, 226, 0.55)';
      g.lineWidth = 1.5;
      g.strokeRect(x0, y0, w, w);
      g.font = 'bold 14px "Ruina Serif", Georgia, serif';
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(43,26,14,0.8)';
      g.strokeText(r.name, x0 + w / 2, y0 + 16);
      g.fillStyle = '#fff6e2';
      g.fillText(r.name, x0 + w / 2, y0 + 16);
    }
    const p = this.ui.sim.player;
    const [px, py] = toPx(p.pos.x, p.pos.z);
    g.save();
    g.translate(px, py);
    g.rotate(-p.facing);
    g.fillStyle = '#ff5a5a';
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, -10);
    g.lineTo(7, 8);
    g.lineTo(0, 4);
    g.lineTo(-7, 8);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }
}
