import { rideable } from '../../../content/vehicles';
import { housePose } from '../../../sim/life/housing';
import { questsAt } from '../../../sim/life/quests';
import { esc } from '../../../util/html';
import type { View } from '../../components/window';
import { iconImage } from '../../theme/icons';
import type { IslandUI } from '../context';
import { type IslandPicture, mapIcon, questMark } from '../map';

// The map (M), the one window that takes over the screen: the island from above with its places,
// your things (scarecrows, house, vehicles), who has a quest for you, other players, the quest's
// goal, the way you're travelling and you. A click on it travels there by road (src/ui/life/travelUI.ts,
// which also says in its foot what is marked); drawn again every frame while it's open.

export class MapWindow {
  readonly canvas = document.createElement('canvas');
  /** What travel by road said when the foot was drawn. */
  private travelSig = '';

  constructor(
    private ui: IslandUI,
    private picture: IslandPicture,
  ) {
    this.canvas.width = this.canvas.height = 768;
  }

  view(): View {
    const r = this.ui.life.zone.recipe;
    const foot = this.ui.travel()?.foot();
    return {
      title: r.name,
      sub: esc(r.subtitle),
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
    body.append(this.canvas);
    this.draw();
  }

  /** Travel by road has changed what the window's foot says. */
  stale(): boolean {
    const travel = this.ui.travel();
    return !!travel && travel.sig() !== this.travelSig;
  }

  /** The island from above with places, your things, other players, the goal and you. */
  draw(): void {
    const life = this.ui.life;
    const hf = this.ui.world.terrain!;
    const image = this.picture.get();
    const g = this.canvas.getContext('2d')!;
    g.drawImage(image, 0, 0);
    const toPx = (x: number, z: number): [number, number] => [((hf.max - x) / hf.size) * 768, ((hf.max - z) / hf.size) * 768];
    g.textAlign = 'center';
    for (const pl of life.zone.recipe.places) {
      const [px, py] = toPx(pl.x, pl.z);
      mapIcon(g, iconImage(pl.icon), px, py - 2, 30);
      g.font = 'bold 12px "Ruina Serif", Georgia, serif';
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(43,26,14,0.8)';
      g.strokeText(pl.name, px, py + 20);
      g.fillStyle = '#fff6e2';
      g.fillText(pl.name, px, py + 20);
    }
    for (const sc of life.state.scarecrows) {
      const [px, py] = toPx(sc.x, sc.z);
      g.fillStyle = '#7e5636';
      g.fillRect(px - 4, py - 4, 8, 8);
    }
    for (const h of life.state.houses) {
      const pose = housePose(life, h);
      const [px, py] = toPx(pose.x, pose.z);
      mapIcon(g, iconImage('🏠'), px, py, 26);
    }
    for (const v of life.state.vehicles) {
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
}
