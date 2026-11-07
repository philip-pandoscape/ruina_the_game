import { toScene } from '../../../render/origin';
import * as THREE from 'three';
import { questDef } from '../../../content/quests';
import { isBoat, isMount, rideable } from '../../../content/vehicles';
import { questsAt, ridden } from '../../../engine/life';
import { esc } from '../../../util/html';
import { el } from '../../components/dom';
import { uiIcon } from '../../theme/icons';
import type { LifeContext } from '../context';

// Over the townsfolk's heads, their name, title and what they have for you (a quest on offer, one
// to hand in, something to talk about); and along the bottom of the screen, the controls for what
// you're doing now, on the keyboard or a controller.

export class Plates {
  private plates = new Map<string, HTMLDivElement>();
  private v = new THREE.Vector3();

  constructor(private ui: LifeContext) {}

  update(): void {
    const cam = this.ui.camera();
    const life = this.ui.life;
    const p = this.ui.sim.player;
    const w = innerWidth;
    const h = innerHeight;
    const hf = this.ui.world.terrain!;
    const modal = this.ui.modal();
    for (const n of life.zone.recipe.npcs) {
      let plate = this.plates.get(n.id);
      if (!plate) {
        plate = el('div', 'lui-plate');
        document.body.appendChild(plate);
        this.plates.set(n.id, plate);
      }
      const dist = Math.hypot(n.x - p.pos.x, n.z - p.pos.z);
      toScene(this.v.set(n.x, hf.height(n.x, n.z) + 2.25, n.z)).project(cam);
      if (dist > 45 || this.v.z > 1 || this.v.z < -1 || modal) {
        plate.style.display = 'none';
        continue;
      }
      const qa = questsAt(life, n.id);
      const talk = life.state.quests.active.some((qp) => questDef(qp.id).steps[qp.step]?.objectives.some((o) => o.type === 'talk' && o.npc === n.id));
      const mark = qa.turnIn.length
        ? `<div class="mark">${uiIcon('quest-done', 30)}</div>`
        : qa.offer.length
          ? `<div class="mark">${uiIcon('quest-new', 30)}</div>`
          : talk
            ? `<div class="mark">${uiIcon('talk', 28)}</div>`
            : '';
      plate.style.display = 'block';
      plate.style.left = `${(this.v.x * 0.5 + 0.5) * w}px`;
      plate.style.top = `${(-this.v.y * 0.5 + 0.5) * h}px`;
      plate.style.opacity = String(Math.max(0.35, 1 - dist / 50));
      const html = `${mark}<div class="n">${esc(n.name)}</div><div class="t">${esc(n.title)}</div>`;
      if (plate.innerHTML !== html) plate.innerHTML = html;
    }
  }
}

export class Hints {
  private key = '';

  constructor(private ui: LifeContext) {}

  update(): void {
    const p = this.ui.sim.player;
    const pad = this.ui.device() === 'gamepad';
    const key = (k: string) => `<span class="key">${k}</span>`;
    const item = (k: string, a: string) => `<span>${k}${a}</span>`;
    let mode = p.mode === 'ride' ? 'ride' : p.mode === 'glide' ? 'glide' : p.mode === 'swim' ? 'swim' : p.pack ? 'carry' : 'foot';
    const v = mode === 'ride' ? ridden(this.ui.life, this.ui.sim) : undefined;
    if (v && isBoat(rideable(v.def))) mode = 'boat';
    if (v && isMount(rideable(v.def))) mode = 'mount';
    if (mode === 'ride' && p.host) mode = 'along';
    const sig = `${mode}${pad}`;
    if (sig === this.key) return;
    this.key = sig;
    const hint = document.getElementById('hint');
    if (!hint) return;
    const parts: string[] = [];
    // Auto-walk (src/input/autoWalk.ts): H or Num Lock, a click of the left stick at rest on a pad.
    // In a cart or a boat it holds the throttle: cruising.
    const auto = this.ui.travel() ? (mode === 'ride' || mode === 'boat' ? 'Cruise' : 'Auto-Run') : '';
    const autoItem = (k: string) => (auto && mode !== 'glide' ? [item(key(k), auto)] : []);
    // Riding along in someone else's vehicle, they drive: all you can do is get out.
    if (mode === 'along') parts.push(item(key(pad ? 'Y' : 'F'), 'Get Out'));
    else if (pad) {
      if (mode === 'ride' || mode === 'boat') parts.push(item(key('L'), 'Drive'), item(key('A'), 'Handbrake'), item(key('Y'), 'Get Out'), ...autoItem('LS'));
      else
        parts.push(
          item(key('L'), 'Move'),
          item(key('A'), mode === 'glide' ? 'Fold' : 'Jump · Glide'),
          item(key('Y'), 'Interact'),
          item(key('▼'), 'Mount'),
          ...autoItem('LS'),
          item(key('☰'), 'Bag'),
          item(key('▲'), 'Map'),
        );
    } else if (mode === 'ride')
      parts.push(
        item(key('W') + key('S'), 'Throttle'),
        item(key('A') + key('D'), 'Steer'),
        item(key('Space'), 'Handbrake'),
        item(key('Shift'), 'Boost'),
        ...autoItem('H'),
        item(key('F'), 'Get Out'),
      );
    else if (mode === 'boat')
      parts.push(
        item(key('W') + key('S'), 'Oars / Sail'),
        item(key('A') + key('D'), 'Rudder'),
        ...autoItem('H'),
        item(key('F'), 'Get Out'),
        item(key('M'), 'Map'),
      );
    else if (mode === 'mount')
      parts.push(item(key('WASD'), 'Ride'), item(key('Shift'), 'Gallop'), item(key('Space'), 'Jump'), ...autoItem('H'), item(key('R'), 'Dismount'));
    else if (mode === 'glide')
      parts.push(item(key('WASD'), 'Steer'), item(key('Shift'), 'Dive'), item(key('C'), 'Flare'), item(key('F'), 'Gust'), item(key('Space'), 'Fold'));
    else {
      parts.push(item(key('WASD'), 'Move'), item(key('Space'), 'Jump ×2 · ×3 Glide'), item(key('F'), 'Interact'));
      if (mode === 'carry') parts.push(item(key('X'), 'Drop Pack'));
      parts.push(item(key('R'), 'Mount'), ...autoItem('H'), item(key('T'), 'Skills'));
    }
    hint.innerHTML = parts.join('');
  }
}
