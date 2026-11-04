import * as THREE from 'three';
import type { Life, LifeEvent } from '../../sim/life/life';
import type { Sim } from '../../sim/sim';
import type { World } from '../../sim/types';
import { injectLifeStyles } from './style';
import { itemDef, recipesAt, vendorFor, BAG_SLOTS, recipe as recipeDef } from '../../content/items';
import { formatCoins, packDef, PACKS, route, placeName, LABOR, CONTRACTS } from '../../content/trade';
import { QUESTS, questDef, objectiveTarget, type QuestDef } from '../../content/quests';
import { rideable, glider as gliderDef, isBoat, isMount } from '../../content/vehicles';
import { cropDef, CLIMATES } from '../../content/farming';
import { blueprintDef } from '../../content/housing';
import { questsAt, isReady } from '../../sim/life/quests';
import { quote, demandAt, freshness, carried } from '../../sim/life/trade';
import { ridden, sailEfficiency } from '../../sim/life/vehicles';
import { heightAboveGround } from '../../sim/player/traverse';
import { angleDiff } from '../../sim/math';
import { SURFACE } from '../../sim/terrain';
import { isComplete, stillNeeds, housePose } from '../../sim/life/housing';
import { shortTime } from '../../sim/life/interact';
import { raining, hourOfDay, stormAt } from '../../sim/life/weather';

// The open world's HUD and panels. Everything here only reads the life state and queues commands;
// nothing in the UI changes the world directly.

export type LifePress = 'interact' | 'drop' | 'mount' | 'glider' | 'seed' | 'bag' | 'map' | 'garage' | 'quests' | 'escape' | 'dev';

export interface LifeUIDeps {
  life: Life;
  sim: Sim;
  world: World;
  camera: () => THREE.Camera;
  yaw: () => number;
  device: () => 'keyboard' | 'gamepad';
}

type Panel = { kind: 'dialog' | 'shop' | 'craft'; id: string } | { kind: 'storage'; id: string } | { kind: 'bag' | 'map' | 'garage' | 'dev' | 'log' };

const FACES: Record<string, string> = {
  hollis: '🧓', mara: '👩‍🌾', tamsin: '🧑‍🔧', bertram: '🧔', sela: '👩‍🦰', ilsa: '🧑‍✈️', quill: '🧐',
  ysolde: '🧝', dunmore: '🧑‍💼', pell: '🎩', hob: '🪓', brenna: '⛏️',
};
const GREETINGS: Record<string, string> = {
  hollis: 'Lanternwick prospers when its people do. Plant, pack, haul - and keep your boots dry.',
  mara: "Seeds for sowing, coin for your crops. Sunroot's quick, emberberry's dear - and slow on this isle.",
  tamsin: "The bench is yours whenever you've the goods. Remember: a pack sold where it's made is worth nothing.",
  bertram: 'A cart for the patient, a roadster for the bold, a hauler for the ambitious. Bring timber and iron.',
  sela: 'A donkey will carry your pack and complain the whole way. A horse will outrun the wind and carry nothing.',
  ilsa: "Rowboats for the bay, a sloop for the open sea. Sail with the wind at your back and you'll fly.",
  quill: 'Land is granted by blueprint, and kept by paying your tax. Hearthside Rise has plots for claim.',
  ysolde: "Jump, jump again, then once more to open your wings. The warm air at the cliff's foot will lift you.",
  dunmore: 'Westwatch buys what the east grows. Prices fall as I fill my storeroom - they recover with time.',
  pell: "Gullrock's a long row from anywhere. That's why I pay in seals as well as silver.",
  hob: 'Fell the deadfall for timber, bundle ten at my sawhorse, and haul it wherever you build.',
  brenna: 'Stone and iron, raw or ready. Ten stone makes a block at the cutting table. Mind your back.',
};
/** Workbenches an NPC stands at (talking to them opens it). */
const BENCH_OF: Record<string, string> = { tamsin: 'lanternwickBench', hob: 'sawhorse', brenna: 'stonecutter' };

/** "☀️ 14:20" or "🌙 23:05" for an hour of the day. */
function clock(h: number, sky: { sunrise: number; sunset: number }): string {
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  const icon = h >= sky.sunrise && h < sky.sunset ? (h < sky.sunrise + 1.5 || h > sky.sunset - 1.5 ? '🌅' : '☀️') : '🌙';
  return `${icon} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

export class LifeUI {
  private wallet = el('div', 'lui');
  private compass = el('div', 'lui');
  private banner = el('div', 'lui');
  private toasts = el('div', 'lui');
  private prompt = el('div', 'lui');
  private quests = el('div', 'lui');
  private rideBox = el('div', 'lui');
  private plates = new Map<string, HTMLDivElement>();
  private panelEl = el('div', 'lui-panel');
  private card = el('div', 'lui-card');
  private panel: Panel | null = null;
  private panelSig = '';
  private sel = -1;
  private toastList: Array<{ e: HTMLDivElement; age: number }> = [];
  private bannerPlace = '';
  private bannerTime = 0;
  private mapImage: HTMLCanvasElement | null = null;
  private v = new THREE.Vector3();
  private hintKey = '';
  /** Which button a controller (or the arrow keys) has highlighted in the open panel, -1 for none. */
  private menuFocus = -1;
  private lastAlt = 0;
  private vario = 0;

  constructor(private d: LifeUIDeps) {
    injectLifeStyles();
    this.wallet.id = 'lui-wallet';
    this.compass.id = 'lui-compass';
    this.banner.id = 'lui-banner';
    this.toasts.id = 'lui-toasts';
    this.prompt.id = 'lui-prompt';
    this.quests.id = 'lui-quests';
    this.rideBox.id = 'lui-ride';
    this.panelEl.hidden = true;
    this.panelEl.appendChild(this.card);
    this.panelEl.addEventListener('mousedown', (e) => {
      if (e.target === this.panelEl) this.close();
    });
    for (const e of [this.wallet, this.compass, this.banner, this.toasts, this.prompt, this.quests, this.rideBox, this.panelEl]) document.body.appendChild(e);
    // The combat HUD's stats line is noise in the open world.
    const stats = document.getElementById('stats');
    if (stats) stats.style.opacity = '0.35';
  }

  /** The NPC whose dialog, shop or workshop is open, if any. */
  get talkingTo(): string | null {
    const p = this.panel;
    return p && (p.kind === 'dialog' || p.kind === 'shop' || (p.kind === 'craft' && this.life.zone.recipe.npcs.some((n) => n.id === (p as { id: string }).id))) ? (p as { id: string }).id : null;
  }

  /** A panel is open and wants the keyboard and mouse. */
  get modal(): boolean {
    return this.panel !== null;
  }

  get life(): Life {
    return this.d.life;
  }

  // ---------- Input ----------

  press(k: LifePress): void {
    const life = this.life;
    const p = this.d.sim.player;
    if (k === 'escape') {
      if (this.panel) return this.close();
      if (life.placing) return life.command({ t: 'cancelPlace' });
      return;
    }
    if (this.panel && k !== 'bag' && k !== 'map' && k !== 'garage' && k !== 'dev' && k !== 'quests') return;
    switch (k) {
      case 'interact':
        if (p.mode === 'ride') life.command({ t: 'exit' });
        else if (p.mode === 'glide') life.command({ t: 'gust' });
        else life.command({ t: 'interact' });
        return;
      case 'drop':
        return life.command({ t: 'drop' });
      case 'mount':
        return life.command({ t: 'mount' });
      case 'glider':
        return life.command({ t: 'glider' });
      case 'seed':
        return life.command({ t: 'cycleSeed' });
      case 'bag':
        return this.toggle({ kind: 'bag' });
      case 'map':
        return this.toggle({ kind: 'map' });
      case 'garage':
        return this.toggle({ kind: 'garage' });
      case 'quests':
        return this.toggle({ kind: 'log' });
      case 'dev':
        return this.toggle({ kind: 'dev' });
    }
  }

  /**
   * Menu presses (D-pad, stick, A / B, arrow keys) while a panel is open: move the highlight over
   * its buttons, press the highlighted one, or close. Returns false when no panel took it.
   */
  menu(m: 'toggle' | 'up' | 'down' | 'left' | 'right' | 'select' | 'back' | 'reset'): boolean {
    if (!this.panel) return false;
    const buttons = [...this.card.querySelectorAll<HTMLElement>('[data-act]:not([disabled])')];
    if (m === 'back') {
      this.close();
      return true;
    }
    if (!buttons.length) return true;
    if (m === 'up' || m === 'left') this.menuFocus = this.menuFocus <= 0 ? buttons.length - 1 : this.menuFocus - 1;
    else if (m === 'down' || m === 'right') this.menuFocus = (this.menuFocus + 1) % buttons.length;
    else if (m === 'select' && this.menuFocus >= 0) {
      const b = buttons[Math.min(this.menuFocus, buttons.length - 1)];
      b.click();
      return true;
    }
    this.showMenuFocus();
    return true;
  }

  private showMenuFocus(): void {
    const buttons = [...this.card.querySelectorAll<HTMLElement>('[data-act]:not([disabled])')];
    buttons.forEach((b, i) => b.classList.toggle('lui-focus', i === this.menuFocus));
    buttons[this.menuFocus]?.scrollIntoView({ block: 'nearest' });
  }

  private toggle(p: Panel): void {
    if (this.panel && this.panel.kind === p.kind) this.close();
    else this.open(p);
  }

  open(p: Panel): void {
    this.panel = p;
    this.panelSig = '';
    this.sel = -1;
    // A controller starts on the first button; a mouse user starts with nothing highlighted.
    this.menuFocus = this.d.device() === 'gamepad' ? 0 : -1;
    this.panelEl.hidden = false;
    if (document.pointerLockElement) document.exitPointerLock?.();
    this.renderPanel();
  }

  close(): void {
    this.panel = null;
    this.panelEl.hidden = true;
    this.card.innerHTML = '';
  }

  // ---------- Events from the world ----------

  onEvents(events: LifeEvent[]): void {
    for (const e of events) {
      if (e.t === 'toast') this.toast(e.text, e.kind);
      else if (e.t === 'open') {
        if (e.ui === 'dialog') this.open({ kind: 'dialog', id: e.id });
        else if (e.ui === 'craft') this.open({ kind: 'craft', id: e.id });
        else if (e.ui === 'storage') this.open({ kind: 'storage', id: e.id });
        else if (e.ui === 'shop') this.open({ kind: 'shop', id: e.id });
      }
    }
  }

  toast(text: string, kind = 'info'): void {
    const e = el('div', `t ${kind}`) as HTMLDivElement;
    e.textContent = text;
    this.toasts.appendChild(e);
    this.toastList.push({ e, age: 0 });
    while (this.toastList.length > 5) this.toastList.shift()!.e.remove();
  }

  // ---------- Every frame ----------

  update(dt: number): void {
    const life = this.life;
    const s = life.state;
    const p = this.d.sim.player;
    for (const t of this.toastList) {
      t.age += dt;
      if (t.age > 3.6) t.e.classList.add('fade');
    }
    while (this.toastList.length && this.toastList[0].age > 4.2) this.toastList.shift()!.e.remove();

    // Wallet, labor, weather.
    const climate = CLIMATES[life.zone.recipe.climate];
    const wind = s.weather;
    const rel = angleDiff(this.d.yaw(), wind.windDir);
    this.wallet.innerHTML =
      `<div class="row"><span class="coins">🪙 ${formatCoins(s.coins)}</span><span class="seals">📜 ${s.seals} seal${s.seals === 1 ? '' : 's'}</span></div>` +
      `<div class="bar"><div class="fill" style="width:${(s.labor / LABOR.max) * 100}%"></div><div class="txt">Labor ${Math.floor(s.labor)} / ${LABOR.max}${life.resting ? ' · resting ×3' : ''}</div></div>` +
      `<div class="meta"><span>${clock(hourOfDay(life), life.zone.recipe.sky)} · ${raining(life) ? '🌧️ Rain' : `${climate?.icon ?? ''} ${climate?.name ?? ''}`}</span><span>Wind <b style="display:inline-block;transform:rotate(${(-rel * 180) / Math.PI}deg)">⬆</b> ${Math.round(wind.windSpeed * 100)}%</span></div>`;

    this.updateCompass();
    this.updateBanner(dt);
    this.updatePrompt();
    this.updateQuests();
    this.updateRide(dt);
    this.updatePlates();
    this.updateHints();
    if (this.panel) {
      const sig = this.signature();
      if (sig !== this.panelSig || this.panel.kind === 'map') this.renderPanel();
    }
    void p;
  }

  private signature(): string {
    const s = this.life.state;
    return [s.coins, s.seals, Math.floor(s.labor / 5), this.life.revision, s.bag.map((b) => `${b.item}${b.n}`).join(), s.quests.active.map((q) => `${q.id}${q.step}${q.counts}`).join(), s.quests.done.length, this.sel, this.d.sim.player.pack, s.vehicles.length, s.glider, s.seed].join('|');
  }

  private updateCompass(): void {
    const yaw = this.d.yaw();
    const p = this.d.sim.player;
    const width = this.compass.clientWidth || 560;
    const fov = Math.PI * 0.9;
    const xOf = (bearing: number): number | null => {
      // Bearing in the world's yaw convention (0 = north, +Z); positive is to the left of north... map it.
      const d = angleDiff(yaw, bearing);
      if (Math.abs(d) > fov / 2) return null;
      return width / 2 - (d / (fov / 2)) * (width / 2);
    };
    let html = '<div class="centre"></div>';
    const cards: Array<[string, number]> = [['N', 0], ['W', Math.PI / 2], ['S', Math.PI], ['E', -Math.PI / 2]];
    for (const [c, b] of cards) {
      const x = xOf(b);
      if (x !== null) html += `<div class="tick card" style="left:${x}px">${c}</div>`;
    }
    for (let k = 0; k < 8; k++) {
      const x = xOf((k * Math.PI) / 4 + Math.PI / 8);
      if (x !== null) html += `<div class="tick" style="left:${x}px;opacity:0.4">·</div>`;
    }
    for (const pl of this.life.zone.recipe.places) {
      const dist = Math.hypot(pl.x - p.pos.x, pl.z - p.pos.z);
      if (dist < 30 || dist > 900) continue;
      const x = xOf(Math.atan2(pl.x - p.pos.x, pl.z - p.pos.z));
      if (x !== null) html += `<div class="poi" style="left:${x}px" title="${pl.name}">${pl.icon}</div>`;
    }
    const goal = this.goal();
    if (goal) {
      const dist = Math.hypot(goal.x - p.pos.x, goal.z - p.pos.z);
      let x = xOf(Math.atan2(goal.x - p.pos.x, goal.z - p.pos.z));
      const off = x === null;
      if (off) x = angleDiff(yaw, Math.atan2(goal.x - p.pos.x, goal.z - p.pos.z)) > 0 ? 10 : width - 10;
      html += `<div class="goal" style="left:${x}px">${off ? '◆' : '▼'}<small>${Math.round(dist)} m</small></div>`;
    }
    this.compass.innerHTML = html;
  }

  /** Where the first unfinished quest wants you to go. */
  goal(): { x: number; z: number; label: string } | null {
    const life = this.life;
    const r = life.zone.recipe;
    const npc = (id: string) => r.npcs.find((n) => n.id === id);
    const place = (id: string) => r.places.find((pl) => pl.id === id);
    for (const qp of life.state.quests.active) {
      const q = questDef(qp.id);
      if (qp.step >= q.steps.length) {
        const n = npc(q.turnIn ?? q.giver);
        if (n) return { x: n.x, z: n.z, label: n.name };
        continue;
      }
      const step = q.steps[qp.step];
      for (let i = 0; i < step.objectives.length; i++) {
        const o = step.objectives[i];
        if (qp.counts[i] >= objectiveTarget(o)) continue;
        if (o.npc && npc(o.npc)) return { x: npc(o.npc)!.x, z: npc(o.npc)!.z, label: npc(o.npc)!.name };
        if (o.type === 'reach' && o.place && place(o.place)) return { x: place(o.place)!.x, z: place(o.place)!.z, label: place(o.place)!.name };
        if (o.type === 'deliver' && o.outpost) {
          const op = r.outposts.find((x) => x.id === o.outpost);
          if (op) return { x: op.x, z: op.z, label: placeName(o.outpost) };
        }
        if (o.type === 'craftPack') return { x: r.workbenches[0].x, z: r.workbenches[0].z, label: 'Specialty Workbench' };
        if (o.type === 'placeScarecrow') return { x: r.farmland.x, z: r.farmland.z, label: 'Barleybrook Fields' };
        if ((o.type === 'plant' || o.type === 'harvest' || o.type === 'raise') && life.state.scarecrows[0]) return { x: life.state.scarecrows[0].x, z: life.state.scarecrows[0].z, label: 'Your plot' };
        if (o.type === 'contract') {
          const k = life.state.contracts?.active[0];
          const op = r.outposts.find((x) => x.id === (k?.outpost ?? 'westwatch'));
          if (op) return { x: op.x, z: op.z, label: placeName(op.id) };
        }
        if ((o.type === 'layKeel' || o.type === 'shipStage' || o.type === 'launch') && r.shipyards?.[0]) return { x: r.shipyards[0].x, z: r.shipyards[0].z, label: r.shipyards[0].name };
        if (o.type === 'summon' && o.vehicle && isBoat(rideable(o.vehicle))) return { x: place('docks')!.x, z: place('docks')!.z, label: 'The docks' };
        if (o.type === 'load' && life.state.vehicles[0]) return { x: life.state.vehicles[0].x, z: life.state.vehicles[0].z, label: 'Your vehicle' };
        if (o.type === 'placeHouse' || o.type === 'buildStage') {
          const h = life.state.houses[0];
          if (h) {
            const pose = housePose(life, h);
            return { x: pose.x, z: pose.z, label: 'Your house' };
          }
          return { x: place('hearthside')!.x, z: place('hearthside')!.z, label: 'Hearthside Rise' };
        }
        if (o.type === 'glide') return { x: r.places.find((pl) => pl.id === 'lanternwick')!.x, z: r.places.find((pl) => pl.id === 'lanternwick')!.z, label: 'Lanternwick' };
      }
    }
    return null;
  }

  private updateBanner(dt: number): void {
    const p = this.d.sim.player;
    let here = '';
    let best = Infinity;
    for (const pl of this.life.zone.recipe.places) {
      const r = pl.kind === 'village' ? 75 : pl.kind === 'forest' ? 140 : 55;
      const d = Math.hypot(pl.x - p.pos.x, pl.z - p.pos.z);
      if (d < r && d < best) {
        best = d;
        here = pl.id;
      }
    }
    if (here && here !== this.bannerPlace) {
      const pl = this.life.zone.recipe.places.find((x) => x.id === here)!;
      this.banner.innerHTML = `<div class="name">${pl.name}</div><div class="sub">${this.life.zone.recipe.name}</div>`;
      this.banner.classList.add('show');
      this.bannerTime = 0;
    }
    this.bannerPlace = here;
    this.bannerTime += dt;
    if (this.bannerTime > 2.8) this.banner.classList.remove('show');
  }

  private updatePrompt(): void {
    const f = this.life.focus;
    if (!f || this.panel) {
      this.prompt.classList.remove('show');
      return;
    }
    const key = this.d.device() === 'gamepad' ? 'Y' : 'F';
    this.prompt.className = `lui show${f.ok ? '' : ' off'}`;
    this.prompt.id = 'lui-prompt';
    this.prompt.innerHTML = `${f.ok ? `<span class="key">${key}</span>` : ''}<span>${f.label}</span>${f.detail ? `<span class="detail">${f.detail}</span>` : ''}`;
  }

  private updateQuests(): void {
    const life = this.life;
    let html = '';
    for (const qp of life.state.quests.active) {
      const q = questDef(qp.id);
      if (qp.step >= q.steps.length) {
        const who = life.zone.recipe.npcs.find((n) => n.id === (q.turnIn ?? q.giver))?.name ?? '';
        html += `<div class="q ready"><h4>✔ ${q.name}</h4><div class="step">Return to ${who}</div></div>`;
        continue;
      }
      const step = q.steps[qp.step];
      const counts = step.objectives
        .map((o, i) => {
          const t = objectiveTarget(o);
          return t > 1 ? `<span class="count">${o.type === 'glide' ? Math.floor(qp.counts[i]) : qp.counts[i]}/${t}${o.type === 'glide' ? 's' : ''}</span>` : '';
        })
        .join('');
      html += `<div class="q"><h4>${q.name}</h4><div class="step">${step.text}${counts}</div></div>`;
    }
    for (const k of life.state.contracts?.active ?? []) {
      html += `<div class="q"><h4>📋 Contract · ${placeName(k.outpost)}</h4><div class="step">${k.count} × ${packDef(k.pack).name}<span class="count">${k.delivered}/${k.count}</span> · ${shortTime(k.expires - life.state.clock)} left</div></div>`;
    }
    const offers = QUESTS.filter((q) => !q.auto && questsAt(life, q.giver).offer.includes(q)).length;
    if (offers) html += `<div class="hint">${offers} quest${offers > 1 ? 's' : ''} available - look for ❗</div>`;
    this.quests.innerHTML = html;
  }

  private updateRide(dt: number): void {
    const life = this.life;
    const sim = this.d.sim;
    const p = sim.player;
    if (p.mode === 'glide') {
      const alt = heightAboveGround(sim);
      const climb = dt > 0 ? p.vel.y : 0;
      this.vario += (climb - this.vario) * Math.min(1, dt * 4);
      this.lastAlt = alt;
      const g = gliderDef(p.glider);
      const hf = sim.world.terrain!;
      const lift = life.zone.recipe.updrafts.some((u) => Math.hypot(u.x - p.pos.x, u.z - p.pos.z) < u.r && p.pos.y < u.top);
      this.rideBox.className = 'lui show';
      this.rideBox.id = 'lui-ride';
      this.rideBox.innerHTML =
        `<div style="opacity:.75">${g.icon} ${g.name}</div><div class="big">${Math.round(this.lastAlt)}<small>m up</small></div>` +
        `<div>${Math.round(p.airspeed * 3.6)} km/h · <span class="vario ${this.vario > 0.2 ? 'up' : this.vario < -2.5 ? 'down' : ''}">${this.vario >= 0 ? '▲' : '▼'} ${Math.abs(this.vario).toFixed(1)} m/s</span></div>` +
        `${lift ? '<div style="color:var(--good);font-weight:800">⤒ Rising air!</div>' : ''}${p.pos.y < hf.water + 6 ? '<div style="color:var(--sea)">Over water</div>' : ''}` +
        (g.gust ? `<div style="margin-top:4px;opacity:.85">F · Gust ${p.gustFrames > 0 ? `in ${Math.ceil(p.gustFrames / 60)}s` : '<b style="color:var(--gold)">ready</b>'}</div>` : '');
      return;
    }
    const v = ridden(life, sim);
    if (!v) {
      this.rideBox.className = 'lui';
      this.rideBox.id = 'lui-ride';
      return;
    }
    const def = rideable(v.def);
    const slots = v.cargo.map((id) => {
      const pk = id ? life.state.packs.find((x) => x.id === id) : null;
      return `<div class="slot">${pk ? packDef(pk.def).icon : ''}</div>`;
    });
    let extra = '';
    if (isBoat(def)) {
      const hull = Math.max(0, v.hp / def.hp);
      const storm = stormAt(life, sim.world.terrain!.water - sim.world.terrain!.height(v.x, v.z));
      extra += `<div style="margin-top:4px">Hull <b style="color:${hull > 0.5 ? 'var(--good)' : hull > 0.25 ? 'var(--gold)' : 'var(--bad)'}">${Math.round(hull * 100)}%</b>${storm > 0 ? ' · <b style="color:var(--bad)">rough seas</b>' : ''}</div>`;
    }
    if (isBoat(def) && def.sail) {
      const rel = angleDiff(life.state.weather.windDir, v.heading);
      const eff = sailEfficiency(rel);
      extra += `<div class="wind">Wind <span class="arrow" style="transform:rotate(${(rel * 180) / Math.PI}deg)">⬆</span> ${Math.round(eff * 100)}% · sail</div><div class="trim"><i style="width:${v.sail * 100}%"></i></div><div style="opacity:.7;margin-top:3px">W/S raise / lower sail</div>`;
    }
    const surf = sim.world.terrain!.surfaceAt(v.x, v.z);
    const road = !isBoat(def) && !isMount(def) ? (surf === SURFACE.road || surf === SURFACE.plaza ? '<span style="color:var(--good)">on road</span>' : '<span style="opacity:.7">off road</span>') : '';
    this.rideBox.className = 'lui show';
    this.rideBox.id = 'lui-ride';
    const back = carried(life, sim);
    const load = isMount(def) ? (back ? `<div style="margin-top:4px">${packDef(back.def).icon} ${packDef(back.def).name}</div>` : '') : def.cargo.length ? `<div class="slots">${slots.join('')}</div>` : '';
    this.rideBox.innerHTML = `<div style="opacity:.75">${def.icon} ${def.name} ${road}</div><div class="big">${Math.round(Math.abs(v.speed) * 3.6)}<small>km/h</small></div>${load}${extra}`;
  }

  private updatePlates(): void {
    const cam = this.d.camera();
    const life = this.life;
    const p = this.d.sim.player;
    const w = innerWidth;
    const h = innerHeight;
    const hf = this.d.world.terrain!;
    for (const n of life.zone.recipe.npcs) {
      let plate = this.plates.get(n.id);
      if (!plate) {
        plate = el('div', 'lui-plate') as HTMLDivElement;
        document.body.appendChild(plate);
        this.plates.set(n.id, plate);
      }
      const dist = Math.hypot(n.x - p.pos.x, n.z - p.pos.z);
      this.v.set(n.x, hf.height(n.x, n.z) + 2.25, n.z).project(cam);
      if (dist > 45 || this.v.z > 1 || this.v.z < -1 || this.panel) {
        plate.style.display = 'none';
        continue;
      }
      const qa = questsAt(life, n.id);
      const talk = life.state.quests.active.some((qp) => questDef(qp.id).steps[qp.step]?.objectives.some((o) => o.type === 'talk' && o.npc === n.id));
      const mark = qa.turnIn.length ? '<div class="mark ready">?</div>' : qa.offer.length ? '<div class="mark">!</div>' : talk ? '<div class="mark">💬</div>' : '';
      plate.style.display = 'block';
      plate.style.left = `${(this.v.x * 0.5 + 0.5) * w}px`;
      plate.style.top = `${(-this.v.y * 0.5 + 0.5) * h}px`;
      plate.style.opacity = String(Math.max(0.35, 1 - dist / 50));
      const html = `${mark}<div class="n">${n.name}</div><div class="t">${n.title}</div>`;
      if (plate.innerHTML !== html) plate.innerHTML = html;
    }
  }

  private updateHints(): void {
    const p = this.d.sim.player;
    const pad = this.d.device() === 'gamepad';
    const key = (k: string) => `<span class="key">${k}</span>`;
    const item = (k: string, a: string) => `<span>${k}${a}</span>`;
    let mode = p.mode === 'ride' ? 'ride' : p.mode === 'glide' ? 'glide' : p.mode === 'swim' ? 'swim' : p.pack ? 'carry' : 'foot';
    const v = mode === 'ride' ? ridden(this.life, this.d.sim) : undefined;
    if (v && isBoat(rideable(v.def))) mode = 'boat';
    if (v && isMount(rideable(v.def))) mode = 'mount';
    const sig = `${mode}${pad}`;
    if (sig === this.hintKey) return;
    this.hintKey = sig;
    const hint = document.getElementById('hint');
    if (!hint) return;
    const parts: string[] = [];
    if (pad) {
      if (mode === 'ride' || mode === 'boat') parts.push(item(key('L'), 'Drive'), item(key('A'), 'Handbrake'), item(key('Y'), 'Get out'));
      else parts.push(item(key('L'), 'Move'), item(key('A'), mode === 'glide' ? 'Fold' : 'Jump · Glide'), item(key('Y'), 'Interact'), item(key('▼'), 'Mount'), item(key('☰'), 'Bag'), item(key('▲'), 'Map'));
    } else if (mode === 'ride') parts.push(item(key('W') + key('S'), 'Throttle'), item(key('A') + key('D'), 'Steer'), item(key('Space'), 'Handbrake'), item(key('Shift'), 'Boost'), item(key('F'), 'Get out'));
    else if (mode === 'boat') parts.push(item(key('W') + key('S'), 'Oars / sail'), item(key('A') + key('D'), 'Rudder'), item(key('F'), 'Get out'), item(key('M'), 'Map'));
    else if (mode === 'mount') parts.push(item(key('WASD'), 'Ride'), item(key('Shift'), 'Gallop'), item(key('Space'), 'Jump'), item(key('R'), 'Dismount'));
    else if (mode === 'glide') parts.push(item(key('WASD'), 'Steer'), item(key('Shift'), 'Dive'), item(key('Ctrl'), 'Flare'), item(key('F'), 'Gust'), item(key('Space'), 'Fold'));
    else {
      parts.push(item(key('WASD'), 'Move'), item(key('Space'), 'Jump ×2 · ×3 glide'), item(key('F'), 'Interact'));
      if (mode === 'carry') parts.push(item(key('X'), 'Drop pack'));
      parts.push(item(key('R'), 'Mount'), item(key('V'), 'Vehicles'), item(key('I'), 'Bag'), item(key('M'), 'Map'), item(key('L'), 'Quests'), item(key('T'), 'Skills'));
    }
    hint.innerHTML = parts.join('');
  }

  // ---------- Panels ----------

  private renderPanel(): void {
    const p = this.panel;
    if (!p) return;
    this.panelSig = this.signature();
    this.renderPanelBody(p);
    if (this.menuFocus >= 0) this.showMenuFocus();
  }

  private renderPanelBody(p: Panel): void {
    switch (p.kind) {
      case 'dialog':
        return this.renderDialog(p.id);
      case 'shop':
        return this.renderShop(p.id);
      case 'craft':
        return this.renderCraft(p.id);
      case 'storage':
        return this.renderStorage(Number(p.id));
      case 'bag':
        return this.renderBag();
      case 'map':
        return this.renderMap();
      case 'garage':
        return this.renderGarage();
      case 'dev':
        return this.renderDev();
      case 'log':
        return this.renderLog();
    }
  }

  private header(face: string, title: string, sub: string): string {
    return `<header><div class="face">${face}</div><div><h2>${title}</h2><div class="sub">${sub}</div></div><button class="lui-btn small x" data-act="close">Close · Esc</button></header>`;
  }

  private wire(handlers: Record<string, (arg: string) => void>): void {
    this.card.querySelectorAll<HTMLElement>('[data-act]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = b.dataset.act!;
        if (act === 'close') return this.close();
        handlers[act]?.(b.dataset.arg ?? '');
      });
    });
  }

  private renderDialog(npcId: string): void {
    const life = this.life;
    const n = life.zone.recipe.npcs.find((x) => x.id === npcId);
    if (!n) return this.close();
    const qa = questsAt(life, npcId);
    let body = '';
    const btns: string[] = [];
    if (qa.turnIn.length) {
      const q = qa.turnIn[0];
      body = `<p class="say">“${q.outro}”</p>${this.rewardLine(q)}`;
      btns.push(`<button class="lui-btn good" data-act="complete" data-arg="${q.id}">Complete: ${q.name}</button>`);
    } else if (qa.offer.length) {
      const q = qa.offer[0];
      body = `<p class="say">“${q.intro}”</p><h3>${q.name}</h3><p>${q.steps.map((s) => `• ${s.text}`).join('<br>')}</p>${this.rewardLine(q)}`;
      btns.push(`<button class="lui-btn gold" data-act="accept" data-arg="${q.id}">Accept: ${q.name}</button>`);
    } else {
      body = `<p class="say">“${GREETINGS[npcId] ?? 'Good day.'}”</p>`;
    }
    const outpost = life.zone.recipe.outposts.find((o) => o.npc === npcId);
    if (outpost) {
      const rows = PACKS.filter((pk) => (pk as { kind?: string }).kind !== 'material').map((pk) => {
        const r = route(pk.origin, outpost.id);
        if (!r) return '';
        const dmd = demandAt(life, outpost.id, pk.id);
        const fresh = Math.round(pk.base * r.factor * dmd * freshness(0));
        return `<div class="lui-row"><div class="ic">${pk.icon}</div><div class="body"><b>${pk.name}</b><small>from ${placeName(pk.origin)} · demand ${Math.round(dmd * 100)}%</small></div><div class="price">${formatCoins(fresh)}${r.seals ? ` + ${r.seals}📜` : ''}</div></div>`;
      });
      body += `<h3>Buying today (fresh packs)</h3><div class="lui-list">${rows.join('')}</div><p style="opacity:.7;font-size:12px;margin-top:8px">Carry a pack here and press F to sell. Each sale lowers demand by ${Math.round(5)}%; it recovers over time. Fresh packs earn up to +15%; stale ones lose up to 12%.</p>`;
      const pk = carried(life, this.d.sim);
      if (pk) {
        const q = quote(life, pk, outpost.id);
        if (q) btns.push(`<button class="lui-btn gold" data-act="sellpack">Sell ${packDef(pk.def).name} for ${formatCoins(q.coins)}</button>`);
      }
      const cs = life.state.contracts;
      const mine = (cs?.active ?? []).filter((k) => k.outpost === outpost.id);
      const offered = (cs?.offered ?? []).filter((k) => k.outpost === outpost.id);
      if (mine.length || offered.length) {
        body += `<h3 style="margin-top:12px">Contracts</h3><div class="lui-list">` +
          mine.map((k) => `<div class="lui-row"><div class="ic">📋</div><div class="body"><b>${k.count} × ${packDef(k.pack).name}</b><small>taken · ${k.delivered}/${k.count} delivered · ${shortTime(k.expires - life.state.clock)} left</small></div><div class="price">+${formatCoins(k.bonusCoins)} +${k.bonusSeals}📜</div></div>`).join('') +
          offered.map((k) => `<div class="lui-row"><div class="ic">📋</div><div class="body"><b>${k.count} × ${packDef(k.pack).name}</b><small>bonus on top of the normal price · ${shortTime(CONTRACTS.durationSeconds)} to fill once taken</small></div><div class="price">+${formatCoins(k.bonusCoins)} +${k.bonusSeals}📜</div><button class="lui-btn small gold" data-act="contract" data-arg="${k.id}">Take</button></div>`).join('') +
          `</div>`;
      }
    }
    if (vendorFor(npcId)) btns.push(`<button class="lui-btn" data-act="shop">Trade</button>`);
    if (recipesAt(npcId).length) btns.push(`<button class="lui-btn" data-act="craft" data-arg="${npcId}">Commission</button>`);
    if (BENCH_OF[npcId]) btns.push(`<button class="lui-btn" data-act="craft" data-arg="${BENCH_OF[npcId]}">Use the workbench</button>`);
    btns.push(`<button class="lui-btn" data-act="close">Goodbye</button>`);
    this.card.innerHTML = this.header(FACES[npcId] ?? '🙂', n.name, n.title) + body + `<div class="btns">${btns.join('')}</div>`;
    this.wire({
      accept: (id) => life.command({ t: 'accept', quest: id }),
      contract: (id) => life.command({ t: 'contract', id: Number(id) }),
      complete: (id) => life.command({ t: 'complete', quest: id }),
      shop: () => this.open({ kind: 'shop', id: npcId }),
      craft: (id) => this.open({ kind: 'craft', id }),
      sellpack: () => {
        life.command({ t: 'interact' });
        this.close();
      },
    });
  }

  private rewardLine(q: QuestDef): string {
    const r = q.rewards;
    const bits = [r.coins ? `🪙 ${formatCoins(r.coins)}` : '', r.seals ? `📜 ${r.seals}` : '', r.labor ? `⚡ ${r.labor} labor` : '', ...(r.items ?? []).map((i) => `${itemDef(i.item).icon} ${i.n > 1 ? `${i.n}× ` : ''}${itemDef(i.item).name}`)].filter(Boolean);
    return bits.length ? `<p style="font-size:13px"><b style="color:var(--gold)">Reward:</b> ${bits.join(' · ')}</p>` : '';
  }

  private renderShop(npcId: string): void {
    const life = this.life;
    const v = vendorFor(npcId);
    const n = life.zone.recipe.npcs.find((x) => x.id === npcId);
    if (!v || !n) return this.close();
    const sells = v.sells
      .map((o) => {
        const def = itemDef(o.item);
        const price = `${formatCoins(o.price)}${o.seals ? ` + ${o.seals}📜` : ''}`;
        const afford = life.state.coins >= o.price && life.state.seals >= (o.seals ?? 0);
        return `<div class="lui-row"><div class="ic">${def.icon}</div><div class="body"><b>${def.name}</b><small>${def.desc}</small></div><div class="price">${price}</div><button class="lui-btn small" data-act="buy" data-arg="${o.item}:1" ${afford ? '' : 'disabled'}>Buy</button>${def.stack > 1 ? `<button class="lui-btn small" data-act="buy" data-arg="${o.item}:5" ${life.state.coins >= o.price * 5 ? '' : 'disabled'}>×5</button>` : ''}</div>`;
      })
      .join('');
    const buys = v.buys
      .filter((i) => life.count(i) > 0)
      .map((i) => {
        const def = itemDef(i);
        const price = Math.max(1, Math.round(def.value * v.buyRate));
        return `<div class="lui-row"><div class="ic">${def.icon}</div><div class="body"><b>${def.name}</b><small>you have ${life.count(i)}</small></div><div class="price">${formatCoins(price)} ea</div><button class="lui-btn small" data-act="sell" data-arg="${i}:1">Sell 1</button><button class="lui-btn small" data-act="sell" data-arg="${i}:9999">All</button></div>`;
      })
      .join('');
    this.card.innerHTML =
      this.header(FACES[npcId] ?? '🛒', v.name, `${n.name} · you have 🪙 ${formatCoins(life.state.coins)} · 📜 ${life.state.seals}`) +
      `<h3>For sale</h3><div class="lui-list">${sells}</div>${v.buys.length ? `<h3 style="margin-top:14px">Buying from you</h3><div class="lui-list">${buys || '<p style="opacity:.7">Nothing they want in your bag.</p>'}</div>` : ''}` +
      `<div class="btns" style="margin-top:12px"><button class="lui-btn" data-act="back">Back</button></div>`;
    this.wire({
      buy: (a) => {
        const [item, n2] = a.split(':');
        life.command({ t: 'buy', npc: npcId, item, n: Number(n2) });
      },
      sell: (a) => {
        const [item, n2] = a.split(':');
        life.command({ t: 'sell', npc: npcId, item, n: Number(n2) });
      },
      back: () => this.open({ kind: 'dialog', id: npcId }),
    });
  }

  private renderCraft(benchOrNpc: string): void {
    const life = this.life;
    const bench = life.zone.recipe.workbenches.find((b) => b.id === benchOrNpc);
    const npc = life.zone.recipe.npcs.find((x) => x.id === benchOrNpc);
    const recipes = recipesAt(benchOrNpc);
    const title = bench ? ((bench as { name?: string }).name ?? 'Workbench') : `${npc?.name ?? ''}'s workshop`;
    const rows = recipes
      .map((r) => {
        const pack = r.makes.pack ? packDef(r.makes.pack) : null;
        const item = r.makes.item ? itemDef(r.makes.item) : null;
        const inputs = pack ? pack.inputs : (r.inputs ?? []);
        const coins = pack ? pack.fee : (r.coins ?? 0);
        const labor = pack ? pack.labor : (r.labor ?? 0);
        const have = inputs.every((i) => life.count(i.item) >= i.n) && life.state.coins >= coins && life.state.labor >= labor;
        const need = inputs.map((i) => `<span class="${life.count(i.item) >= i.n ? 'have' : 'lack'}">${itemDef(i.item).icon} ${life.count(i.item)}/${i.n} ${itemDef(i.item).name}</span>`).join(' · ');
        let sells = '';
        if (pack && (pack as { kind?: string }).kind !== 'material') {
          const quotes = life.zone.recipe.outposts
            .map((o) => {
              const rt = route(pack.origin, o.id);
              if (!rt) return '';
              return `${placeName(o.id)} ~${formatCoins(Math.round(pack.base * rt.factor * demandAt(life, o.id, pack.id) * freshness(0)))}${rt.seals ? ` +${rt.seals}📜` : ''}`;
            })
            .filter(Boolean);
          sells = `<small>Sells at ${quotes.join(' · ')}</small>`;
        } else if (pack) sells = '<small>Building material - haul it to a house site</small>';
        const name = pack?.name ?? item?.name ?? r.id;
        const icon = pack?.icon ?? item?.icon ?? '🛠️';
        const desc = item?.desc ? `<small>${item.desc}</small>` : '';
        return `<div class="lui-row"><div class="ic">${icon}</div><div class="body"><b>${name}</b><small>${need}${coins ? ` · 🪙 ${formatCoins(coins)}` : ''}${labor ? ` · ⚡ ${labor} labor` : ''}</small>${sells}${desc}</div><button class="lui-btn ${have ? 'gold' : ''} small" data-act="make" data-arg="${r.id}" ${have ? '' : 'disabled'}>${pack ? 'Pack it' : 'Make'}</button></div>`;
      })
      .join('');
    const backLine = this.d.sim.player.pack ? '<p style="color:var(--bad)">Your back is full - set your pack down (X) before packing another.</p>' : '';
    this.card.innerHTML = this.header(bench ? '🛠️' : (FACES[benchOrNpc] ?? '🛠️'), title, `🪙 ${formatCoins(life.state.coins)} · ⚡ ${Math.floor(life.state.labor)} labor`) + backLine + `<div class="lui-list">${rows}</div>`;
    this.wire({
      make: (id) => {
        life.command({ t: 'craft', recipe: id });
        if (recipeDef(id)?.makes.pack) setTimeout(() => this.close(), 60);
      },
    });
  }

  private renderBag(): void {
    const life = this.life;
    const s = life.state;
    const cells: string[] = [];
    for (let i = 0; i < BAG_SLOTS; i++) {
      const st = s.bag[i];
      if (!st) {
        cells.push('<div class="lui-cell empty"></div>');
        continue;
      }
      const def = itemDef(st.item);
      cells.push(`<div class="lui-cell${this.sel === i ? ' sel' : ''}" data-act="sel" data-arg="${i}" title="${def.name}">${def.icon}${st.n > 1 ? `<span class="n">${st.n}</span>` : ''}</div>`);
    }
    let detail = '<span style="opacity:.6">Select an item.</span>';
    const st = s.bag[this.sel];
    if (st) {
      const def = itemDef(st.item);
      const verb = def.cat === 'seed' ? (s.seed === st.item ? 'Planting this' : 'Plant with F') : def.cat === 'deed' ? 'Summon' : def.cat === 'mount' ? 'Call (R)' : def.cat === 'glider' ? (s.glider === def.glider ? 'Equipped' : 'Equip') : def.cat === 'placeable' ? 'Place' : def.cat === 'consumable' ? 'Use' : '';
      let extra = '';
      if (def.plants) {
        const c = cropDef(def.plants);
        extra = `<br><small>${CLIMATES[c.climate]?.icon ?? ''} ${CLIMATES[c.climate]?.name ?? c.climate} crop · ripens in ~${shortTime(c.growSeconds * (c.climate === life.zone.recipe.climate ? 1 : 1 / 0.7))} here · yields ${c.yield[0]}-${c.yield[1]}</small>`;
      }
      detail = `<b>${def.icon} ${def.name}</b> <span style="opacity:.6">×${st.n}</span><br><small>${def.desc}</small>${extra}<div class="btns" style="margin-top:8px">${verb ? `<button class="lui-btn gold small" data-act="use" data-arg="${st.item}">${verb}</button>` : ''}</div>`;
    }
    const pk = carried(life, this.d.sim);
    this.card.innerHTML =
      this.header('🎒', 'Bag', `${s.bag.length}/${BAG_SLOTS} slots`) +
      `<div class="lui-stats"><span style="color:var(--gold)">🪙 ${formatCoins(s.coins)}</span><span style="color:#b8d8ff">📜 ${s.seals} seals</span><span>⚡ ${Math.floor(s.labor)} labor</span><span>${s.glider ? `${gliderDef(s.glider).icon} ${gliderDef(s.glider).name}` : 'No glider'}</span><span>${pk ? `On your back: ${packDef(pk.def).icon} ${packDef(pk.def).name}` : 'Nothing on your back'}</span></div>` +
      `<div class="lui-grid">${cells.join('')}</div><div class="lui-detail">${detail}</div>`;
    this.wire({
      sel: (i) => {
        this.sel = Number(i);
        this.renderPanel();
      },
      use: (item) => {
        life.command({ t: 'use', item });
        const cat = itemDef(item).cat;
        if (cat === 'deed' || cat === 'placeable' || cat === 'mount') this.close();
      },
    });
  }

  private renderStorage(houseId: number): void {
    const life = this.life;
    const h = life.state.houses.find((x) => x.id === houseId);
    if (!h || !isComplete(h)) return this.close();
    const bp = blueprintDef(h.blueprint);
    const list = (stacks: Array<{ item: string; n: number }>, act: string) =>
      stacks.map((st) => `<div class="lui-row"><div class="ic">${itemDef(st.item).icon}</div><div class="body"><b>${itemDef(st.item).name}</b><small>×${st.n}</small></div><button class="lui-btn small" data-act="${act}" data-arg="${st.item}">${act === 'store' ? 'Store →' : '← Take'}</button></div>`).join('') || '<p style="opacity:.6">Empty</p>';
    this.card.innerHTML =
      this.header('🧰', 'Storage chest', `${h.storage.length}/${bp.perks.storageSlots} kinds stored`) +
      `<div class="lui-cols"><div><h3>Your bag</h3><div class="lui-list">${list(life.state.bag, 'store')}</div></div><div><h3>Chest</h3><div class="lui-list">${list(h.storage, 'take')}</div></div></div>`;
    this.wire({
      store: (item) => life.command({ t: 'store', house: houseId, item, n: life.count(item) }),
      take: (item) => life.command({ t: 'take', house: houseId, item, n: 9999 }),
    });
  }

  private renderGarage(): void {
    const life = this.life;
    const owned = life.state.bag.filter((s) => itemDef(s.item).cat === 'deed' || itemDef(s.item).cat === 'mount');
    const rows = owned
      .map((s) => {
        const def = itemDef(s.item);
        const vid = def.vehicle ?? def.mount!;
        const r = rideable(vid);
        const out = life.state.vehicles.find((v) => v.def === vid);
        const p = this.d.sim.player;
        const where = out ? `${Math.round(Math.hypot(out.x - p.pos.x, out.z - p.pos.z))} m away${out.cargo.some(Boolean) ? ` · ${out.cargo.filter(Boolean).length} packs aboard` : ''}` : 'stabled';
        const stats = isMount(r) ? `${r.runSpeed} m/s · ${r.canCarryPack ? 'carries a pack' : 'no packs'}` : `${r.maxSpeed} m/s · ${r.cargo.length} pack slots · ${r.seats.length} seats`;
        return `<div class="lui-row"><div class="ic">${r.icon}</div><div class="body"><b>${r.name}</b><small>${stats}</small><small>${where}</small></div>${isMount(r) ? `<button class="lui-btn small gold" data-act="mount">Call (R)</button>` : `<button class="lui-btn small gold" data-act="summon" data-arg="${s.item}">${out ? 'Bring here' : 'Summon'}</button>`}${out && !isMount(r) ? `<button class="lui-btn small" data-act="recall" data-arg="${out.id}">Send home</button>` : ''}</div>`;
      })
      .join('');
    this.card.innerHTML = this.header('🛞', 'Vehicles & mounts', 'Boats appear at the nearest deep water') + `<div class="lui-list">${rows || '<p style="opacity:.7">You own no vehicles yet. Bertram (carts and cars), Captain Ilsa (boats) and Sela (mounts) are in Lanternwick.</p>'}</div>`;
    this.wire({
      summon: (item) => {
        life.command({ t: 'summon', item });
        this.close();
      },
      recall: (id) => life.command({ t: 'recall', vehicle: Number(id) }),
      mount: () => {
        life.command({ t: 'mount' });
        this.close();
      },
    });
  }

  private renderLog(): void {
    const life = this.life;
    const active = life.state.quests.active
      .map((qp) => {
        const q = questDef(qp.id);
        const steps = q.steps.map((s, i) => `<div style="opacity:${i < qp.step ? 0.5 : i === qp.step ? 1 : 0.35}">${i < qp.step ? '✔' : i === qp.step ? '▶' : '·'} ${s.text}</div>`).join('');
        return `<div class="lui-row"><div class="ic">${isReady(life, q.id) ? '✔' : '📜'}</div><div class="body"><b>${q.name}</b><small>${steps}</small></div></div>`;
      })
      .join('');
    const done = life.state.quests.done.map((id) => `<span style="opacity:.7">✔ ${questDef(id).name}</span>`).join(' · ');
    this.card.innerHTML = this.header('📖', 'Quest log', `${life.state.quests.done.length}/${QUESTS.length} complete`) + `<div class="lui-list">${active || '<p>No active quests.</p>'}</div><h3 style="margin-top:12px">Completed</h3><p style="font-size:13px">${done || '—'}</p>`;
    this.wire({});
  }

  private renderMap(): void {
    const life = this.life;
    const hf = this.d.world.terrain!;
    if (!this.mapImage) this.mapImage = buildMapImage(this.d.world);
    if (!this.card.querySelector('canvas')) {
      this.card.innerHTML = this.header('🗺️', life.zone.recipe.name, life.zone.recipe.subtitle) + '<canvas width="768" height="768"></canvas>';
      this.card.style.width = 'auto';
      this.wire({});
    }
    const c = this.card.querySelector('canvas')!;
    const g = c.getContext('2d')!;
    g.drawImage(this.mapImage, 0, 0);
    const toPx = (x: number, z: number): [number, number] => [((hf.max - x) / hf.size) * 768, ((hf.max - z) / hf.size) * 768];
    g.font = 'bold 13px system-ui';
    g.textAlign = 'center';
    for (const pl of life.zone.recipe.places) {
      const [px, py] = toPx(pl.x, pl.z);
      g.font = '18px system-ui';
      g.fillText(pl.icon, px, py + 6);
      g.font = 'bold 11px system-ui';
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(0,0,0,0.7)';
      g.strokeText(pl.name, px, py + 20);
      g.fillStyle = '#fff';
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
      g.font = '16px system-ui';
      g.fillText('🏠', px, py + 5);
    }
    for (const v of life.state.vehicles) {
      const [px, py] = toPx(v.x, v.z);
      g.font = '14px system-ui';
      g.fillText(rideable(v.def).icon, px, py + 5);
    }
    const goal = this.goal();
    if (goal) {
      const [px, py] = toPx(goal.x, goal.z);
      g.strokeStyle = '#ffd166';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(px, py, 10 + Math.sin(performance.now() / 200) * 2, 0, Math.PI * 2);
      g.stroke();
    }
    const p = this.d.sim.player;
    const [px, py] = toPx(p.pos.x, p.pos.z);
    g.save();
    g.translate(px, py);
    g.rotate(-p.facing + Math.PI);
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

  private renderDev(): void {
    const life = this.life;
    const places = life.zone.recipe.places.map((pl) => `<button class="lui-btn small" data-act="tp" data-arg="${pl.id}">${pl.icon} ${pl.name}</button>`).join('');
    this.card.innerHTML =
      this.header('🧪', 'Developer tools', 'For trying things out quickly. ` toggles this panel.') +
      `<div class="lui-dev"><h3>Give</h3>
      <button class="lui-btn small" data-act="grant" data-arg="coins">+1 gold</button>
      <button class="lui-btn small" data-act="grant" data-arg="seals">+10 seals</button>
      <button class="lui-btn small" data-act="grant" data-arg="labor">+500 labor</button>
      <button class="lui-btn small" data-act="grant" data-arg="seeds">Seeds, saplings & young animals</button>
      <button class="lui-btn small" data-act="grant" data-arg="produce">Produce for packs</button>
      <button class="lui-btn small" data-act="grant" data-arg="mats">Building materials</button>
      <button class="lui-btn small" data-act="grant" data-arg="rides">Every vehicle, mount & glider</button>
      <button class="lui-btn small" data-act="grant" data-arg="house">Cottage blueprint, cog design, scarecrows</button>
      <h3>Time</h3>
      <button class="lui-btn small" data-act="warp" data-arg="60">+1 minute</button>
      <button class="lui-btn small" data-act="warp" data-arg="600">+10 minutes</button>
      <button class="lui-btn small" data-act="warp" data-arg="3600">+1 hour</button>
      <h3>Teleport</h3>${places}
      <h3>Save</h3><button class="lui-btn small" data-act="reset">Start Emberholm over</button>
      ${this.onBugReport ? `<h3>Bug report</h3><button class="lui-btn small" data-act="bug">🐞 Record a bug report</button><div style="font-size:12px;opacity:0.75">Or press <b>${this.bugKey().replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}</b> any time (click both sticks on a controller). It keeps the last 30 seconds of play, then records your voice and the screen until you press it again.</div>` : ''}</div>`;
    this.wire({
      grant: (what) => {
        const g = (item: string, n = 1) => life.command({ t: 'grant', item, n });
        if (what === 'coins') life.command({ t: 'grant', coins: 10000 });
        if (what === 'seals') life.command({ t: 'grant', seals: 10 });
        if (what === 'labor') life.command({ t: 'grant', labor: 500 });
        if (what === 'seeds') ['seed.sunroot', 'seed.barley', 'seed.flax', 'seed.emberberry'].forEach((s) => g(s, 20)), g('sapling.apple', 4), g('sapling.pine', 4), g('animal.chick', 3), g('animal.lamb', 2), g('animal.calf', 2);
        if (what === 'produce') g('sunroot', 30), g('barley', 40), g('flax', 16), g('emberberry', 16), g('apple', 16), g('egg', 8), g('milk', 6), g('wool', 16);
        if (what === 'mats') g('lumber', 120), g('stone', 40), g('ironOre', 30), g('flax', 30);
        if (what === 'rides') ['deed.farmCart', 'deed.roadster', 'deed.hauler', 'deed.rowboat', 'deed.sloop', 'deed.cog', 'whistle.donkey', 'whistle.horse', 'glider.wayfarer', 'glider.swiftwing'].forEach((i) => life.count(i) || g(i));
        if (what === 'house') g('blueprint.cottage'), g('scarecrow', 2), g('design.cog');
        if (what === 'rides' && !life.state.glider) life.command({ t: 'use', item: 'glider.wayfarer' });
      },
      warp: (s) => life.command({ t: 'warp', seconds: Number(s) }),
      tp: (id) => {
        const pl = life.zone.recipe.places.find((x) => x.id === id)!;
        this.onTeleport?.(pl.x, pl.z);
        this.close();
      },
      reset: () => this.onReset?.(),
      bug: () => {
        // Close first, so the report's screenshot shows the game rather than this panel.
        this.close();
        this.onBugReport?.();
      },
    });
  }

  /** Set by the app: move the player somewhere (dev panel). */
  onTeleport: ((x: number, z: number) => void) | null = null;
  onReset: (() => void) | null = null;
  /** Set by the app when bug reports are on: start (or finish) one. */
  onBugReport: (() => void) | null = null;
  /** How this keyboard labels the bug report key. */
  bugKey: () => string = () => '\\';

  /** Stand-in for the old stage name; kept so callers can check how much of a site is left. */
  siteSummary(houseId: number): string {
    const h = this.life.state.houses.find((x) => x.id === houseId);
    if (!h) return '';
    return stillNeeds(h).map((n) => `${packDef(n.pack).name} ${n.have}/${n.need}`).join(', ');
  }
}

/** The island drawn from above, once: shaded relief, sea by depth, roads and fields. */
export function buildMapImage(world: World): HTMLCanvasElement {
  const hf = world.terrain!;
  const N = 768;
  const c = document.createElement('canvas');
  c.width = N;
  c.height = N;
  const g = c.getContext('2d')!;
  const img = g.createImageData(N, N);
  const SURF: Record<number, [number, number, number]> = {
    [SURFACE.grass]: [128, 190, 88],
    [SURFACE.road]: [196, 160, 110],
    [SURFACE.sand]: [232, 214, 158],
    [SURFACE.rock]: [150, 150, 144],
    [SURFACE.soil]: [120, 86, 56],
    [SURFACE.plaza]: [214, 204, 180],
    [SURFACE.forest]: [88, 152, 72],
  };
  for (let py = 0; py < N; py++)
    for (let px = 0; px < N; px++) {
      const x = hf.max - ((px + 0.5) / N) * hf.size;
      const z = hf.max - ((py + 0.5) / N) * hf.size;
      const h = hf.height(x, z);
      let col: [number, number, number];
      if (h < hf.water) {
        const d = Math.min(1, (hf.water - h) / 20);
        col = [Math.round(96 - 56 * d), Math.round(200 - 96 * d), Math.round(214 - 50 * d)];
      } else {
        const base = SURF[hf.surfaceAt(x, z)] ?? SURF[SURFACE.grass];
        const gr = hf.gradient(x, z);
        const shade = Math.max(0.55, Math.min(1.3, 1 + gr.x * 0.55 - gr.z * 0.55));
        const lift = Math.min(1.2, 0.9 + h / 200);
        col = [base[0] * shade * lift, base[1] * shade * lift, base[2] * shade * lift].map((v) => Math.max(0, Math.min(255, Math.round(v)))) as [number, number, number];
      }
      const o = (py * N + px) * 4;
      img.data[o] = col[0];
      img.data[o + 1] = col[1];
      img.data[o + 2] = col[2];
      img.data[o + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return c;
}
