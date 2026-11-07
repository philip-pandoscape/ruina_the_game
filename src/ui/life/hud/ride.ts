import { packDef } from '../../../content/trade';
import { glider as gliderDef, isBoat, isMount, rideable } from '../../../content/vehicles';
import { carried, ridden, sailEfficiency, stormAt } from '../../../engine/life';
import { angleDiff, heightAboveGround } from '../../../engine/rules';
import { SURFACE } from '../../../engine/zone';
import { iconHtml, withIcons } from '../../theme/icons';
import { el } from '../../components/dom';
import type { IslandUI } from '../context';

// The ride readout at the bottom right, while you glide or ride: the glider's height, speed, climb
// and rising air; a vehicle's speed, the road, its cargo slots, a boat's hull, the sea and the
// wind in its sail; the pack on a mount's back.

export class RideBox {
  readonly el = el('div', 'lui');
  /** How fast you climb (m/s), smoothed. */
  private vario = 0;
  private lastAlt = 0;

  constructor(private ui: IslandUI) {
    this.el.id = 'lui-ride';
  }

  update(dt: number): void {
    const life = this.ui.life;
    const sim = this.ui.sim;
    const p = sim.player;
    if (p.mode === 'glide') {
      const alt = heightAboveGround(sim);
      const climb = dt > 0 ? p.vel.y : 0;
      this.vario += (climb - this.vario) * Math.min(1, dt * 4);
      this.lastAlt = alt;
      const g = gliderDef(p.glider);
      const hf = sim.world.terrain!;
      const lift = life.zone.recipe.updrafts.some((u) => Math.hypot(u.x - p.pos.x, u.z - p.pos.z) < u.r && p.pos.y < u.top);
      this.el.className = 'lui show';
      this.el.innerHTML =
        `<div style="color:var(--ink-2)">${withIcons(`${g.icon} ${g.name}`)}</div><div class="big">${Math.round(this.lastAlt)}<small>m Up</small></div>` +
        `<div>${Math.round(p.airspeed * 3.6)} km/h · <span class="vario ${this.vario > 0.2 ? 'up' : this.vario < -2.5 ? 'down' : ''}">${this.vario >= 0 ? '▲' : '▼'} ${Math.abs(this.vario).toFixed(1)} m/s</span></div>` +
        `${lift ? '<div style="color:var(--good);font-weight:700">⤒ Rising Air!</div>' : ''}${p.pos.y < hf.water + 6 ? '<div style="color:var(--sea)">Over Water</div>' : ''}` +
        (g.gust
          ? `<div style="margin-top:4px;color:var(--ink-2)">F · Gust ${p.gustFrames > 0 ? `in ${Math.ceil(p.gustFrames / 60)}s` : '<b style="color:var(--accent)">Ready</b>'}</div>`
          : '');
      return;
    }
    const v = ridden(life, sim);
    if (!v) {
      this.el.className = 'lui';
      return;
    }
    const def = rideable(v.def);
    const slots = v.cargo.map((id) => {
      const pk = id ? life.land.packs.find((x) => x.id === id) : null;
      return `<div class="slot">${pk ? iconHtml(packDef(pk.def).icon, undefined, 20) : ''}</div>`;
    });
    let extra = '';
    if (isBoat(def)) {
      const hull = Math.max(0, v.hp / def.hp);
      const storm = stormAt(life, sim.world.terrain!.water - sim.world.terrain!.height(v.x, v.z));
      extra += `<div style="margin-top:4px">Hull <b style="color:${hull > 0.5 ? 'var(--good)' : hull > 0.25 ? 'var(--accent)' : 'var(--bad)'}">${Math.round(hull * 100)}%</b>${storm > 0 ? ' · <b style="color:var(--bad)">Rough Seas</b>' : ''}</div>`;
    }
    if (isBoat(def) && def.sail) {
      const rel = angleDiff(life.weather.windDir, v.heading);
      const eff = sailEfficiency(rel);
      extra += `<div class="wind">Wind <span class="arrow" style="transform:rotate(${(rel * 180) / Math.PI}deg)">⬆</span> ${Math.round(eff * 100)}% · Sail</div><div class="trim"><i style="width:${v.sail * 100}%"></i></div><div style="color:var(--ink-2);margin-top:3px">W/S Raise / Lower Sail</div>`;
    }
    const surf = sim.world.terrain!.surfaceAt(v.x, v.z);
    const road =
      !isBoat(def) && !isMount(def)
        ? surf === SURFACE.road || surf === SURFACE.plaza
          ? '<span style="color:var(--good)">on road</span>'
          : '<span style="color:var(--ink-2)">off road</span>'
        : '';
    this.el.className = 'lui show';
    const back = carried(life, sim);
    const load = isMount(def)
      ? back
        ? `<div style="margin-top:4px">${withIcons(`${packDef(back.def).icon} ${packDef(back.def).name}`)}</div>`
        : ''
      : def.cargo.length
        ? `<div class="slots">${slots.join('')}</div>`
        : '';
    this.el.innerHTML = `<div style="color:var(--ink-2)">${withIcons(`${def.icon} ${def.name}`)} ${road}</div><div class="big">${Math.round(Math.abs(v.speed) * 3.6)}<small>km/h</small></div>${load}${extra}`;
  }
}
