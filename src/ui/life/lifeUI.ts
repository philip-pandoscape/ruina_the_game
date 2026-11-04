import * as THREE from 'three';
import type { Life, LifeEvent } from '../../sim/life/life';
import type { Sim } from '../../sim/sim';
import type { World } from '../../sim/types';
import { itemDef, recipesAt, vendorFor, BAG_SLOTS, recipe as recipeDef } from '../../content/items';
import { packDef, PACKS, route, placeName, LABOR, CONTRACTS } from '../../content/trade';
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
import { WEAPON_ICONS, WEAPON_NAMES } from '../icons';
import { iconHtml, iconUrl, money } from '../theme/icons';
import { GOLD_STAR, pixelIcon } from '../theme/pixelIcons';
import { setUserScale, uiRoot, userScale, UI_SCALE_MAX, UI_SCALE_MIN } from '../theme/scale';
import { addTipSource, hideTip, tipFor, wireTips } from '../theme/tooltip';

// The open world's HUD and windows. Everything here only reads the life state and queues commands;
// nothing in the UI changes the world directly. Windows dock at the side and leave the world
// running (the map is the one that takes over), the bag docks on the right, and the person you talk
// to looks out of the corner of the window.

export type LifePress = 'interact' | 'drop' | 'mount' | 'glider' | 'seed' | 'bag' | 'map' | 'garage' | 'quests' | 'character' | 'settings' | 'escape' | 'dev';

export interface LifeUIDeps {
  life: Life;
  sim: Sim;
  world: World;
  camera: () => THREE.Camera;
  yaw: () => number;
  device: () => 'keyboard' | 'gamepad';
}

type Panel =
  | { kind: 'dialog'; id: string; quest?: string; trade?: boolean }
  | { kind: 'shop'; id: string; tab: 'buy' | 'sell' }
  | { kind: 'craft'; id: string }
  | { kind: 'storage'; id: string }
  | { kind: 'map' | 'garage' | 'dev' | 'log' | 'character' | 'settings' };

type Handler = (arg: string, e: MouseEvent | null) => void;
type View = { title: string; sub?: string; portrait?: string; body: string; foot?: string; cls?: string; w: number; h?: number; handlers?: Record<string, Handler> };

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
/** How far you can walk from whoever you're dealing with before their window closes. */
const WALK_AWAY = 9;
const CAT: Record<string, string> = { seed: 'Seed', produce: 'Produce', material: 'Material', consumable: 'Consumable', placeable: 'Placeable', glider: 'Glider', deed: 'Vehicle deed', mount: 'Mount' };

/** "☀️ 14:20" or "🌙 23:05" for an hour of the day. */
function clock(h: number, sky: { sunrise: number; sunset: number }): string {
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  const icon = h >= sky.sunrise && h < sky.sunset ? (h < sky.sunrise + 1.5 || h > sky.sunset - 1.5 ? '🌅' : '☀️') : '🌙';
  return `${icon} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const EMOJI = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}️?)*/gu;
/** Text with its emoji drawn as pixel icons where there are any. */
const withIcons = (text: string, px = 16) => esc(text).replace(EMOJI, (e) => (iconUrl(e) ? iconHtml(e, undefined, px) : e));
const dropcap = (t: string) => `<span class="dropcap">${esc(t[0])}</span>${esc(t.slice(1))}`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

export class LifeUI {
  // HUD
  private portrait = el('div', '', '<div class="frame"></div><div class="ribbon"></div>');
  private vitals = el('div');
  private minimap = el('div');
  private mapCanvas = document.createElement('canvas');
  private clockEl = el('div', '', '<span></span>');
  private compass = el('div', 'lui');
  private banner = el('div', 'lui');
  private toasts = el('div', 'lui');
  private prompt = el('div', 'lui');
  private quests = el('div', 'lui');
  private rideBox = el('div', 'lui');
  private menuEl = el('div');
  private plates = new Map<string, HTMLDivElement>();
  // Windows: the main one docks left (the map takes the centre), the bag docks right.
  private card = el('div', 'lui-card mw left');
  private bagEl = el('div', 'lui-bag mw right');
  private bigMap = document.createElement('canvas');
  private panel: Panel | null = null;
  private bagOpen = false;
  private panelSig = '';
  private bagSig = '';
  private sel = -1;
  private logSel = '';
  private handlers: Record<string, Handler> = {};
  private bagHandlers: Record<string, Handler> = {};
  private toastList: Array<{ e: HTMLDivElement; age: number }> = [];
  private bannerPlace = '';
  private bannerTime = 0;
  private mapImage: HTMLCanvasElement | null = null;
  private mapZoom = 1;
  private frameNo = 0;
  private v = new THREE.Vector3();
  private hintKey = '';
  private vitalsKey = '';
  private questsKey = '';
  private clockKey = '';
  private portraitUrl = '';
  /** Which button a controller (or the arrow keys) has highlighted in the open window, -1 for none. */
  private menuFocus = -1;
  private lastAlt = 0;
  private vario = 0;
  private hp = 0;
  private maxHp = 0;

  constructor(private d: LifeUIDeps) {
    const root = uiRoot();
    this.portrait.id = 'hud-portrait';
    this.vitals.id = 'hud-vitals';
    this.minimap.id = 'hud-minimap';
    this.clockEl.id = 'hud-clock';
    this.compass.id = 'lui-compass';
    this.banner.id = 'lui-banner';
    this.toasts.id = 'lui-toasts';
    this.prompt.id = 'lui-prompt';
    this.quests.id = 'lui-quests';
    this.rideBox.id = 'lui-ride';
    this.menuEl.id = 'hud-menu';
    this.minimap.innerHTML =
      '<div class="ring"></div><div class="rim"></div><i class="stud" style="left:50%;top:4.5px"></i><i class="stud" style="left:calc(100% - 4.5px);top:50%"></i>' +
      '<i class="stud" style="left:50%;top:calc(100% - 4.5px)"></i><i class="stud" style="left:4.5px;top:50%"></i><span class="n">N</span>' +
      '<span class="zoom in" data-zoom="1" title="Zoom in">+</span><span class="zoom out" data-zoom="-1" title="Zoom out">−</span>';
    this.mapCanvas.width = this.mapCanvas.height = 280;
    this.minimap.prepend(this.mapCanvas);
    this.minimap.addEventListener('click', (e) => {
      const z = (e.target as HTMLElement).closest('[data-zoom]') as HTMLElement | null;
      if (z) this.mapZoom = Math.max(0.5, Math.min(2.5, this.mapZoom * (Number(z.dataset.zoom) > 0 ? 1.4 : 1 / 1.4)));
    });
    this.bigMap.width = this.bigMap.height = 768;
    const btn = (press: LifePress, icon: string, label: string, key: string) =>
      `<div class="hud-mbtn" data-press="${press}" title="${label}${key ? ` (${key})` : ''}">${icon}${key ? `<span class="k">${key}</span>` : ''}<span class="lbl">${label}</span></div>`;
    this.menuEl.innerHTML =
      btn('bag', pixelIcon('bag', 24), 'Bag', 'I') + btn('character', pixelIcon('person', 24), 'Character', 'P') + btn('quests', pixelIcon('scroll', 24), 'Quests', 'L') +
      btn('map', pixelIcon('map', 24), 'Map', 'M') + btn('garage', pixelIcon('wheel', 24), 'Rides', 'V') + btn('settings', pixelIcon('gear', 24), 'Settings', '');
    this.menuEl.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-press]') as HTMLElement | null;
      if (b) this.press(b.dataset.press as LifePress);
    });
    this.card.hidden = true;
    this.bagEl.hidden = true;
    for (const w of [this.card, this.bagEl]) {
      w.addEventListener('click', (e) => this.onWindowClick(e, w));
      w.addEventListener('input', (e) => {
        const t = e.target as HTMLInputElement;
        if (t.dataset.set === 'uiScale') {
          setUserScale(Number(t.value) / 100);
          const out = t.parentElement?.querySelector('b');
          if (out) out.textContent = `${t.value}%`;
        }
      });
    }
    for (const e of [this.portrait, this.vitals, this.minimap, this.clockEl, this.compass, this.banner, this.toasts, this.prompt, this.quests, this.rideBox, this.menuEl, this.card, this.bagEl]) root.appendChild(e);
    wireTips();
    addTipSource((tip) => this.tip(tip));
  }

  /** The NPC whose dialog, shop or workshop is open, if any. */
  get talkingTo(): string | null {
    const p = this.panel;
    if (!p || !('id' in p)) return null;
    if (p.kind === 'dialog' || p.kind === 'shop') return p.id;
    if (p.kind === 'craft' && this.life.zone.recipe.npcs.some((n) => n.id === p.id)) return p.id;
    return null;
  }

  /** A window wants the keyboard and mouse to itself. Only the map does now; the others leave play running. */
  get modal(): boolean {
    return this.panel?.kind === 'map';
  }

  /** A window is open: on a controller it takes the D-pad, stick and buttons. */
  get takesPad(): boolean {
    return this.panel !== null || this.bagOpen;
  }

  /** Which window is open (the main one first), for tests and bug reports. */
  get openPanel(): string | null {
    return this.panel?.kind ?? (this.bagOpen ? 'bag' : null);
  }

  get life(): Life {
    return this.d.life;
  }

  /** Your health, for the vitals (the open world's health bar). */
  setHealth(hp: number, max: number): void {
    this.hp = hp;
    this.maxHp = max;
  }

  // ---------- Input ----------

  press(k: LifePress): void {
    const life = this.life;
    const p = this.d.sim.player;
    if (k === 'escape') {
      if (this.panel) return this.close();
      if (this.bagOpen) return this.closeBag();
      if (life.placing) return life.command({ t: 'cancelPlace' });
      return;
    }
    // The map takes over; with anything else open the world keys still work.
    if (this.modal && !['bag', 'map', 'garage', 'dev', 'quests', 'character', 'settings'].includes(k)) return;
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
        return this.bagOpen ? this.closeBag() : this.openBag();
      case 'map':
        return this.toggle({ kind: 'map' });
      case 'garage':
        return this.toggle({ kind: 'garage' });
      case 'quests':
        return this.toggle({ kind: 'log' });
      case 'character':
        return this.toggle({ kind: 'character' });
      case 'settings':
        return this.toggle({ kind: 'settings' });
      case 'dev':
        return this.devTools ? this.toggle({ kind: 'dev' }) : undefined;
    }
  }

  /**
   * Menu presses (D-pad, stick, A / B, arrow keys) while a window is open: move the highlight over
   * its buttons, press the highlighted one, or close. Returns false when no window took it.
   */
  menu(m: 'toggle' | 'up' | 'down' | 'left' | 'right' | 'select' | 'back' | 'reset'): boolean {
    if (!this.panel && !this.bagOpen) return false;
    if (m === 'back') {
      if (this.panel) this.close();
      else this.closeBag();
      return true;
    }
    const buttons = this.focusables();
    if (!buttons.length) return true;
    if (m === 'up' || m === 'left') this.menuFocus = this.menuFocus <= 0 ? buttons.length - 1 : this.menuFocus - 1;
    else if (m === 'down' || m === 'right') this.menuFocus = (this.menuFocus + 1) % buttons.length;
    else if (m === 'select' && this.menuFocus >= 0) {
      buttons[Math.min(this.menuFocus, buttons.length - 1)].click();
      return true;
    }
    this.showMenuFocus();
    return true;
  }

  private focusables(): HTMLElement[] {
    const w = this.panel ? this.card : this.bagEl;
    return [...w.querySelectorAll<HTMLElement>('[data-act]:not([disabled]):not(.mw-x)')];
  }

  private showMenuFocus(): void {
    const buttons = this.focusables();
    buttons.forEach((b, i) => b.classList.toggle('lui-focus', i === this.menuFocus));
    const b = buttons[this.menuFocus];
    if (b) {
      b.scrollIntoView({ block: 'nearest' });
      tipFor(b);
    }
  }

  private toggle(p: Panel): void {
    if (this.panel && this.panel.kind === p.kind) this.close();
    else this.open(p);
  }

  open(p: Panel | { kind: 'shop'; id: string }): void {
    const panel = (p.kind === 'shop' && !('tab' in p) ? { ...p, tab: 'buy' } : p) as Panel;
    const same = this.panel?.kind === panel.kind;
    this.panel = panel;
    if (!same) this.menuFocus = this.d.device() === 'gamepad' ? 0 : -1;
    this.panelSig = '';
    if (panel.kind === 'shop') this.openBag();
    this.card.hidden = false;
    if (document.pointerLockElement) document.exitPointerLock?.();
    this.renderPanel(!same);
  }

  close(): void {
    const wasShop = this.panel?.kind === 'shop';
    this.panel = null;
    this.card.hidden = true;
    this.card.innerHTML = '';
    this.handlers = {};
    hideTip();
    if (wasShop) this.closeBag();
  }

  openBag(): void {
    this.bagOpen = true;
    this.bagSig = '';
    this.bagEl.hidden = false;
    if (document.pointerLockElement) document.exitPointerLock?.();
    this.renderBag();
  }

  closeBag(): void {
    this.bagOpen = false;
    this.bagEl.hidden = true;
    this.bagEl.innerHTML = '';
    hideTip();
  }

  /** Closes every window. */
  closeAll(): void {
    this.close();
    this.closeBag();
  }

  private onWindowClick(e: MouseEvent, w: HTMLElement): void {
    const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!b || b.hasAttribute('disabled')) return;
    e.stopPropagation();
    const act = b.dataset.act!;
    if (act === 'close') return w === this.bagEl ? this.closeBag() : this.close();
    const h = (w === this.bagEl ? this.bagHandlers : this.handlers)[act];
    h?.(b.dataset.arg ?? '', e);
  }

  // ---------- Events from the world ----------

  onEvents(events: LifeEvent[]): void {
    for (const e of events) {
      if (e.t === 'toast') this.toast(e.text, e.kind);
      else if (e.t === 'open') {
        if (e.ui === 'dialog') this.open({ kind: 'dialog', id: e.id });
        else if (e.ui === 'craft') this.open({ kind: 'craft', id: e.id });
        else if (e.ui === 'storage') this.open({ kind: 'storage', id: e.id });
        else if (e.ui === 'shop') this.open({ kind: 'shop', id: e.id, tab: 'buy' });
      }
    }
  }

  toast(text: string, kind = 'info'): void {
    const e = el('div', `t ${kind}`, withIcons(text)) as HTMLDivElement;
    this.toasts.appendChild(e);
    this.toastList.push({ e, age: 0 });
    while (this.toastList.length > 5) this.toastList.shift()!.e.remove();
  }

  // ---------- Every frame ----------

  update(dt: number): void {
    this.frameNo++;
    for (const t of this.toastList) {
      t.age += dt;
      if (t.age > 3.6) t.e.classList.add('fade');
    }
    while (this.toastList.length && this.toastList[0].age > 4.2) this.toastList.shift()!.e.remove();

    this.updateVitals();
    this.updatePortrait();
    if (this.frameNo % 2 === 0) this.drawMinimap();
    this.updateClock();
    this.updateCompass();
    this.updateBanner(dt);
    this.updatePrompt();
    this.updateQuests();
    this.updateRide(dt);
    this.updatePlates();
    this.updateHints();
    this.walkAway();
    if (this.frameNo % 15 === 0) this.refreshPortraits();
    if (this.panel?.kind === 'map') this.drawBigMap();
    else if (this.panel && this.signature() !== this.panelSig) this.renderPanel(false);
    if (this.bagOpen && this.signature() !== this.bagSig) this.renderBag();
  }

  private signature(): string {
    const s = this.life.state;
    return [s.coins, s.seals, Math.floor(s.labor / 5), this.life.revision, s.bag.map((b) => `${b.item}${b.n}`).join(), s.quests.active.map((q) => `${q.id}${q.step}${q.counts}`).join(), s.quests.done.length, this.sel, this.logSel, this.d.sim.player.pack, this.d.sim.player.weapon, s.vehicles.length, s.glider, s.seed, s.contracts?.active.length, s.contracts?.offered.length, Math.round(this.hp)].join('|');
  }

  /** Portraits arrive a frame or two after a window opens and are retaken now and then: show the latest. */
  private refreshPortraits(): void {
    const p = this.panel;
    if (!p) return;
    const set = (sel: string, who: string, fallback: string) => {
      const url = this.portraitOf(who);
      if (!url) return;
      const img = this.card.querySelector(sel + ' img') as HTMLImageElement | null;
      if (img) {
        if (img.getAttribute('src') !== url) img.src = url;
      } else if (this.card.querySelector(sel + ' ' + fallback)) this.renderPanel(false);
    };
    if (p.kind === 'character') {
      set('.mw-portrait', 'player', '.emoji');
      set('.ch-model', 'body', 'div');
    } else if ('id' in p && this.life.zone.recipe.npcs.some((n) => n.id === p.id)) set('.mw-portrait', p.id, '.emoji');
  }

  /** Walking away from whoever you're dealing with closes their window, as it would in person. */
  private walkAway(): void {
    const p = this.panel;
    if (!p || !('id' in p)) return;
    const r = this.life.zone.recipe;
    const pos = this.d.sim.player.pos;
    let at: { x: number; z: number } | undefined;
    if (p.kind === 'storage') {
      const h = this.life.state.houses.find((x) => x.id === Number(p.id));
      if (h) at = housePose(this.life, h);
    } else at = r.npcs.find((n) => n.id === p.id) ?? r.workbenches.find((b) => b.id === p.id);
    if (at && Math.hypot(at.x - pos.x, at.z - pos.z) > WALK_AWAY) this.close();
  }

  // ---------- HUD ----------

  /** Set by the app: a portrait of the player or a townsperson ('player', 'body' or an NPC id), as an image URL. */
  portraitOf: (who: string) => string | null = () => null;
  /** Set by the app: the name on your ribbon. */
  playerName = 'Traveller';

  private updatePortrait(): void {
    if (this.frameNo % 30 !== 1) return;
    const url = this.portraitOf('player');
    const frame = this.portrait.querySelector('.frame')!;
    if (url && url !== this.portraitUrl) {
      this.portraitUrl = url;
      frame.innerHTML = `<img src="${url}" alt="">`;
    } else if (!url && !frame.firstChild) frame.innerHTML = '<div style="display:grid;place-items:center;height:100%;font-size:44px">🧑</div>';
    const ribbon = this.portrait.querySelector('.ribbon')!;
    if (ribbon.textContent !== this.playerName) ribbon.textContent = this.playerName;
  }

  private updateVitals(): void {
    const s = this.life.state;
    const key = [Math.round(this.hp), this.maxHp, Math.floor(s.labor), s.coins, s.seals, this.life.resting].join('|');
    if (key === this.vitalsKey) return;
    this.vitalsKey = key;
    const bar = (icon: string, c: string, frac: number, txt: string) =>
      `<div class="hud-bar" style="--c:${c}"><span class="cap">${icon}</span><div class="track"><div class="fill" style="width:calc((100% - 12px) * ${Math.max(0, Math.min(1, frac)).toFixed(3)})"></div><span class="txt">${txt}</span></div></div>`;
    this.vitals.innerHTML =
      (this.maxHp > 0 ? bar(pixelIcon('heart', 20), 'var(--hp)', this.hp / this.maxHp, `${Math.max(0, Math.round(this.hp))} / ${this.maxHp}`) : '') +
      bar(pixelIcon('bolt', 20), 'var(--labor)', s.labor / LABOR.max, `${Math.floor(s.labor)} / ${LABOR.max}${this.life.resting ? ' · resting ×3' : ''}`) +
      `<div class="hud-purse"><span class="hud-pill" title="Money">${money(s.coins, 16)}</span><span class="hud-pill" title="Seals">${pixelIcon('seal', 18)}${s.seals}</span></div>`;
  }

  private updateClock(): void {
    const life = this.life;
    const climate = CLIMATES[life.zone.recipe.climate];
    const wind = life.state.weather;
    const rel = angleDiff(this.d.yaw(), wind.windDir);
    const weather = raining(life) ? '🌧️' : (climate?.icon ?? '');
    const text = `${clock(hourOfDay(life), life.zone.recipe.sky)} ${weather}`;
    const key = `${text}|${Math.round(wind.windSpeed * 100)}|${Math.round((rel * 180) / Math.PI / 10)}`;
    if (key === this.clockKey) return;
    this.clockKey = key;
    this.clockEl.firstElementChild!.innerHTML = `${withIcons(text, 14)} · Wind <b style="transform:rotate(${(-rel * 180) / Math.PI}deg)">⬆</b> ${Math.round(wind.windSpeed * 100)}%`;
  }

  /** The island around you, north up, with what you're looking for. */
  private drawMinimap(): void {
    const hf = this.d.world.terrain;
    if (!hf) return;
    if (!this.mapImage) this.mapImage = buildMapImage(this.d.world);
    const g = this.mapCanvas.getContext('2d')!;
    const N = this.mapCanvas.width;
    const p = this.d.sim.player;
    const toPx = (x: number, z: number): [number, number] => [((hf.max - x) / hf.size) * 768, ((hf.max - z) / hf.size) * 768];
    const [px, py] = toPx(p.pos.x, p.pos.z);
    const span = 150 / this.mapZoom; // map pixels across the minimap
    const k = N / span;
    const at = (x: number, z: number): [number, number] => {
      const [mx, my] = toPx(x, z);
      return [(mx - px) * k + N / 2, (my - py) * k + N / 2];
    };
    g.fillStyle = '#3f8fa6';
    g.fillRect(0, 0, N, N);
    g.imageSmoothingEnabled = true;
    g.drawImage(this.mapImage, px - span / 2, py - span / 2, span, span, 0, 0, N, N);
    const r = this.life.zone.recipe;
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
    // Townsfolk with something for you.
    for (const n of r.npcs) {
      const qa = questsAt(this.life, n.id);
      if (!qa.offer.length && !qa.turnIn.length) continue;
      const [x, y] = at(n.x, n.z);
      g.fillStyle = qa.turnIn.length ? '#4fae3a' : '#f0b432';
      g.strokeStyle = '#2b1a0e';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(x, y, 9, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = '#fff';
      g.font = 'bold 14px Georgia, serif';
      g.fillText(qa.turnIn.length ? '?' : '!', x, y + 5);
    }
    for (const o of this.others()) {
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
    const goal = this.goal();
    if (goal) {
      const [gx, gy] = at(goal.x, goal.z);
      g.strokeStyle = '#ffd166';
      g.lineWidth = 4;
      g.beginPath();
      g.arc(Math.max(16, Math.min(N - 16, gx)), Math.max(16, Math.min(N - 16, gy)), 11, 0, Math.PI * 2);
      g.stroke();
    }
    g.save();
    g.translate(N / 2, N / 2);
    g.rotate(-p.facing + Math.PI);
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

  private updateCompass(): void {
    const yaw = this.d.yaw();
    const p = this.d.sim.player;
    const width = 560;
    const fov = Math.PI * 0.9;
    const xOf = (bearing: number): number | null => {
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
      if (x !== null) html += `<div class="poi" style="left:${x}px" title="${esc(pl.name)}">${iconHtml(pl.icon, undefined, 18)}</div>`;
    }
    const goal = this.goal();
    if (goal) {
      const dist = Math.hypot(goal.x - p.pos.x, goal.z - p.pos.z);
      let x = xOf(Math.atan2(goal.x - p.pos.x, goal.z - p.pos.z));
      const off = x === null;
      if (off) x = angleDiff(yaw, Math.atan2(goal.x - p.pos.x, goal.z - p.pos.z)) > 0 ? 12 : width - 12;
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
      this.banner.innerHTML = `<div class="name">${esc(pl.name)}</div><div class="sub">${esc(this.life.zone.recipe.name)}</div>`;
      this.banner.classList.add('show');
      this.bannerTime = 0;
    }
    this.bannerPlace = here;
    this.bannerTime += dt;
    if (this.bannerTime > 2.8) this.banner.classList.remove('show');
  }

  private updatePrompt(): void {
    const f = this.life.focus;
    if (!f || this.talkingTo || this.modal) {
      this.prompt.classList.remove('show');
      return;
    }
    const key = this.d.device() === 'gamepad' ? 'Y' : 'F';
    this.prompt.className = `lui show${f.ok ? '' : ' off'}`;
    this.prompt.innerHTML = `${f.ok ? `<span class="key">${key}</span>` : ''}<span>${withIcons(f.label)}</span>${f.detail ? `<span class="detail">${withIcons(f.detail)}</span>` : ''}`;
  }

  private updateQuests(): void {
    const life = this.life;
    const parts: string[] = [];
    for (const qp of life.state.quests.active) {
      const q = questDef(qp.id);
      if (qp.step >= q.steps.length) {
        const who = life.zone.recipe.npcs.find((n) => n.id === (q.turnIn ?? q.giver))?.name ?? '';
        parts.push(`<div class="q ready"><div class="qt"><i></i>${esc(q.name)}</div><div class="step">Return to ${esc(who)}</div></div>`);
        continue;
      }
      const step = q.steps[qp.step];
      let bars = '';
      const counts = step.objectives
        .map((o, i) => {
          const t = objectiveTarget(o);
          if (t <= 1) return '';
          const have = o.type === 'glide' ? Math.floor(qp.counts[i]) : qp.counts[i];
          bars += `<div class="q-bar"><i style="width:${Math.min(100, (have / t) * 100)}%"></i></div>`;
          return ` <span class="count">${have}/${t}${o.type === 'glide' ? 's' : ''}</span>`;
        })
        .join('');
      parts.push(`<div class="q"><div class="qt"><i></i>${esc(q.name)}</div><div class="step">${esc(step.text)}${counts}</div>${bars}</div>`);
    }
    for (const k of life.state.contracts?.active ?? []) {
      parts.push(`<div class="q"><div class="qt"><i></i>Contract · ${esc(placeName(k.outpost))}</div><div class="step">${k.count} × ${esc(packDef(k.pack).name)} <span class="count">${k.delivered}/${k.count}</span> · ${shortTime(k.expires - life.state.clock)} left</div><div class="q-bar"><i style="width:${(k.delivered / k.count) * 100}%"></i></div></div>`);
    }
    const offers = QUESTS.filter((q) => !q.auto && questsAt(life, q.giver).offer.includes(q)).length;
    if (offers) parts.push(`<div class="hint">${offers} quest${offers > 1 ? 's' : ''} on offer: look for ${pixelIcon('excl', 12)}</div>`);
    if (!parts.length) parts.push(`<div class="hint">Nothing under way. Look for ${pixelIcon('excl', 12)} over people's heads.</div>`);
    const html = `<div class="scroll"><h4>Quests</h4>${parts.join('')}</div>`;
    if (html !== this.questsKey) {
      this.questsKey = html;
      this.quests.innerHTML = html;
    }
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
      this.rideBox.innerHTML =
        `<div style="color:var(--ink-2)">${withIcons(`${g.icon} ${g.name}`)}</div><div class="big">${Math.round(this.lastAlt)}<small>m up</small></div>` +
        `<div>${Math.round(p.airspeed * 3.6)} km/h · <span class="vario ${this.vario > 0.2 ? 'up' : this.vario < -2.5 ? 'down' : ''}">${this.vario >= 0 ? '▲' : '▼'} ${Math.abs(this.vario).toFixed(1)} m/s</span></div>` +
        `${lift ? '<div style="color:var(--good);font-weight:700">⤒ Rising air!</div>' : ''}${p.pos.y < hf.water + 6 ? '<div style="color:var(--sea)">Over water</div>' : ''}` +
        (g.gust ? `<div style="margin-top:4px;color:var(--ink-2)">F · Gust ${p.gustFrames > 0 ? `in ${Math.ceil(p.gustFrames / 60)}s` : '<b style="color:var(--accent)">ready</b>'}</div>` : '');
      return;
    }
    const v = ridden(life, sim);
    if (!v) {
      this.rideBox.className = 'lui';
      return;
    }
    const def = rideable(v.def);
    const slots = v.cargo.map((id) => {
      const pk = id ? life.state.packs.find((x) => x.id === id) : null;
      return `<div class="slot">${pk ? iconHtml(packDef(pk.def).icon, undefined, 20) : ''}</div>`;
    });
    let extra = '';
    if (isBoat(def)) {
      const hull = Math.max(0, v.hp / def.hp);
      const storm = stormAt(life, sim.world.terrain!.water - sim.world.terrain!.height(v.x, v.z));
      extra += `<div style="margin-top:4px">Hull <b style="color:${hull > 0.5 ? 'var(--good)' : hull > 0.25 ? 'var(--accent)' : 'var(--bad)'}">${Math.round(hull * 100)}%</b>${storm > 0 ? ' · <b style="color:var(--bad)">rough seas</b>' : ''}</div>`;
    }
    if (isBoat(def) && def.sail) {
      const rel = angleDiff(life.state.weather.windDir, v.heading);
      const eff = sailEfficiency(rel);
      extra += `<div class="wind">Wind <span class="arrow" style="transform:rotate(${(rel * 180) / Math.PI}deg)">⬆</span> ${Math.round(eff * 100)}% · sail</div><div class="trim"><i style="width:${v.sail * 100}%"></i></div><div style="color:var(--ink-2);margin-top:3px">W/S raise / lower sail</div>`;
    }
    const surf = sim.world.terrain!.surfaceAt(v.x, v.z);
    const road = !isBoat(def) && !isMount(def) ? (surf === SURFACE.road || surf === SURFACE.plaza ? '<span style="color:var(--good)">on road</span>' : '<span style="color:var(--ink-2)">off road</span>') : '';
    this.rideBox.className = 'lui show';
    const back = carried(life, sim);
    const load = isMount(def) ? (back ? `<div style="margin-top:4px">${withIcons(`${packDef(back.def).icon} ${packDef(back.def).name}`)}</div>` : '') : def.cargo.length ? `<div class="slots">${slots.join('')}</div>` : '';
    this.rideBox.innerHTML = `<div style="color:var(--ink-2)">${withIcons(`${def.icon} ${def.name}`)} ${road}</div><div class="big">${Math.round(Math.abs(v.speed) * 3.6)}<small>km/h</small></div>${load}${extra}`;
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
      if (dist > 45 || this.v.z > 1 || this.v.z < -1 || this.modal) {
        plate.style.display = 'none';
        continue;
      }
      const qa = questsAt(life, n.id);
      const talk = life.state.quests.active.some((qp) => questDef(qp.id).steps[qp.step]?.objectives.some((o) => o.type === 'talk' && o.npc === n.id));
      const white = { y: '#ffffff', Y: '#ffe6b0' };
      const mark = qa.turnIn.length ? `<div class="mark ready">${pixelIcon('qmark', 14, white)}</div>` : qa.offer.length ? `<div class="mark">${pixelIcon('excl', 14, white)}</div>` : talk ? `<div class="mark">${pixelIcon('bubble', 14)}</div>` : '';
      plate.style.display = 'block';
      plate.style.left = `${(this.v.x * 0.5 + 0.5) * w}px`;
      plate.style.top = `${(-this.v.y * 0.5 + 0.5) * h}px`;
      plate.style.opacity = String(Math.max(0.35, 1 - dist / 50));
      const html = `${mark}<div class="n">${esc(n.name)}</div><div class="t">${esc(n.title)}</div>`;
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
      parts.push(item(key('R'), 'Mount'), item(key('T'), 'Skills'));
    }
    hint.innerHTML = parts.join('');
  }

  // ---------- Tooltips ----------

  private tip(tip: string): string | null {
    const i = tip.indexOf(':');
    const kind = tip.slice(0, i);
    const id = tip.slice(i + 1);
    if (kind === 'item') {
      let it: ReturnType<typeof itemDef>;
      try {
        it = itemDef(id);
      } catch {
        return null;
      }
      if (!it) return null;
      let extra = '';
      if (it.plants) {
        try {
          const c = cropDef(it.plants);
          extra = `<p class="g">${CLIMATES[c.climate]?.name ?? c.climate} crop · ripens in ~${shortTime(c.growSeconds * (c.climate === this.life.zone.recipe.climate ? 1 : 1 / 0.7))} here · yields ${c.yield[0]}-${c.yield[1]}</p>`;
        } catch {
          extra = '';
        }
      }
      const p = this.panel;
      const v = p && p.kind === 'shop' ? vendorFor(p.id) : null;
      const n = v && p && 'id' in p ? this.life.zone.recipe.npcs.find((x) => x.id === p.id) : null;
      const sells = v && v.buys.includes(id) ? `<div class="row"><span class="muted">${esc(n?.name.split(' ')[0] ?? 'They')} pays</span>${money(Math.max(1, Math.round(it.value * v.buyRate)), 12)}</div>` : it.value ? `<div class="row"><span class="muted">Worth</span>${money(it.value, 12)}</div>` : '';
      return `<h5>${esc(it.name)}</h5><div class="ty">${CAT[it.cat] ?? it.cat}${it.stack > 1 ? ` · stacks to ${it.stack}` : ''}</div><p>${esc(it.desc)}</p>${extra}${sells ? `<hr>${sells}` : ''}`;
    }
    if (kind === 'pack') {
      try {
        const pk = packDef(id);
        return `<h5>${esc(pk.name)}</h5><div class="ty">Trade pack</div><p>Made at ${esc(placeName(pk.origin))}. Carry it to another town's trader to sell.</p>`;
      } catch {
        return null;
      }
    }
    if (kind === 'slot') return `<h5>${esc(id)}</h5><div class="ty">Empty</div><p>There's nothing to wear here yet.</p>`;
    if (kind === 'weapon') return `<h5>${esc(WEAPON_NAMES[Number(id)] ?? '')}</h5><div class="ty">Main hand</div><p>Change your weapon in the skill book (T).</p>`;
    return null;
  }

  // ---------- Windows ----------

  private face(id: string): string {
    const url = this.portraitOf(id);
    return url ? `<img src="${url}" alt="">` : `<span class="emoji">${FACES[id] ?? '🙂'}</span>`;
  }

  private renderPanel(fresh: boolean): void {
    const p = this.panel;
    if (!p) return;
    this.panelSig = this.signature();
    const view = this.view(p);
    const body = this.card.querySelector('.mw-body');
    const keep = !fresh && body ? body.scrollTop : 0;
    this.card.className = `lui-card mw ${view.cls ?? 'left'}${view.portrait ? ' has-portrait' : ''}`;
    this.card.style.width = `${view.w}px`;
    this.card.style.height = view.h ? `${view.h}px` : '';
    this.card.innerHTML =
      (view.portrait ? `<div class="mw-portrait">${view.portrait}</div>` : '') +
      `<div class="mw-bar">${esc(view.title)}${view.sub ? ` <small>${view.sub}</small>` : ''}</div><div class="mw-x" data-act="close" title="Close (Esc)">✕</div>` +
      `<div class="mw-body">${view.body}</div>${view.foot ? `<div class="mw-foot">${view.foot}</div>` : ''}`;
    this.handlers = view.handlers ?? {};
    const nb = this.card.querySelector('.mw-body') as HTMLElement;
    if (p.kind === 'map') {
      nb.append(this.bigMap);
      this.drawBigMap();
    }
    nb.scrollTop = keep;
    nb.addEventListener('scroll', () => this.updateScroll(this.card));
    this.updateScroll(this.card);
    if (this.menuFocus >= 0) this.showMenuFocus();
  }

  /** A drawn scrollbar and a fade, when a window's text runs past its foot. */
  private updateScroll(w: HTMLElement): void {
    for (const x of w.querySelectorAll('.mw-track, .mw-fade')) x.remove();
    const body = w.querySelector('.mw-body') as HTMLElement | null;
    if (!body || body.scrollHeight <= body.clientHeight + 2) return;
    const top = body.offsetTop + 8;
    const hgt = body.clientHeight - 16;
    const thumb = Math.max(36, (hgt * body.clientHeight) / body.scrollHeight);
    const pos = ((hgt - thumb) * body.scrollTop) / (body.scrollHeight - body.clientHeight);
    const track = el('div', 'mw-track', `<i style="top:${pos}px;height:${thumb}px"></i>`);
    track.style.top = `${top}px`;
    track.style.height = `${hgt}px`;
    w.append(track);
    if (body.scrollTop + body.clientHeight < body.scrollHeight - 4) {
      const f = el('div', 'mw-fade');
      f.style.top = `${body.offsetTop + body.clientHeight - 46}px`;
      w.append(f);
    }
    if (body.scrollTop > 4) {
      const f = el('div', 'mw-fade up');
      f.style.top = `${body.offsetTop}px`;
      w.append(f);
    }
  }

  private view(p: Panel): View {
    switch (p.kind) {
      case 'dialog':
        return this.dialogView(p.id, p.quest, p.trade);
      case 'shop':
        return this.shopView(p.id, p.tab);
      case 'craft':
        return this.craftView(p.id);
      case 'storage':
        return this.storageView(Number(p.id));
      case 'map':
        return { title: this.life.zone.recipe.name, sub: esc(this.life.zone.recipe.subtitle), cls: 'center map', w: 734, body: '' };
      case 'garage':
        return this.garageView();
      case 'dev':
        return this.devView();
      case 'log':
        return this.logView();
      case 'character':
        return this.characterView();
      case 'settings':
        return this.settingsView();
    }
  }

  private rewards(q: QuestDef): string {
    const r = q.rewards as QuestDef['rewards'] & { skillPoints?: number };
    const rows = (r.items ?? []).map((i) => {
      const it = itemDef(i.item);
      return `<div class="rw" data-tip="item:${i.item}"><div class="ib">${iconHtml(it.icon, i.item)}${i.n > 1 ? `<span class="n">${i.n}</span>` : ''}</div><span class="nm">${esc(it.name)}</span></div>`;
    });
    if (r.skillPoints) rows.push(`<div class="rw"><div class="ib">${pixelIcon('star', 28, GOLD_STAR)}</div><span class="nm">${r.skillPoints} Skill Point${r.skillPoints > 1 ? 's' : ''}</span></div>`);
    if (r.labor) rows.push(`<div class="rw"><div class="ib">${pixelIcon('bolt', 28)}</div><span class="nm">${r.labor} Labor</span></div>`);
    if (r.seals) rows.push(`<div class="rw"><div class="ib">${pixelIcon('seal', 28)}</div><span class="nm">${r.seals} Seal${r.seals > 1 ? 's' : ''}</span></div>`);
    if (r.coins) rows.push(`<div class="rw"><div class="ib">${pixelIcon('coin', 28)}</div><span class="nm">${money(r.coins, 12)}</span></div>`);
    return rows.length ? `<div class="h">Rewards</div><div class="q-rewards">${rows.join('')}</div>` : '';
  }

  private objectives(q: QuestDef, qp?: { step: number; counts: number[] }): string {
    return `<ul class="q-objs">${q.steps
      .map((s, i) => {
        const o = s.objectives[0];
        const t = o ? objectiveTarget(o) : 1;
        const have = qp ? (i < qp.step ? t : i === qp.step ? Math.floor(qp.counts[0] ?? 0) : 0) : 0;
        const done = !!qp && i < qp.step;
        const count = t > 1 ? ` <b>${have}/${t}</b>${qp && i === qp.step ? `<div class="q-bar"><i style="width:${Math.min(100, (have / t) * 100)}%"></i></div>` : ''}` : '';
        return `<li class="${done ? 'done' : ''}">${esc(s.text)}${count}</li>`;
      })
      .join('')}</ul>`;
  }

  private dialogView(npcId: string, questId?: string, trade?: boolean): View {
    const life = this.life;
    const n = life.zone.recipe.npcs.find((x) => x.id === npcId)!;
    const qa = questsAt(life, npcId);
    const active = life.state.quests.active.filter((qp) => {
      const q = questDef(qp.id);
      return (q.turnIn ?? q.giver) === npcId && !qa.turnIn.some((t) => t.id === q.id);
    });
    const outpost = life.zone.recipe.outposts.find((o) => o.npc === npcId);
    const talk: Array<[string, string, string]> = [];
    if (vendorFor(npcId)) talk.push(['shop', '', `${pixelIcon('coin', 22)}<span>Browse ${esc(n.name.split(' ')[0])}'s goods</span>`]);
    if (outpost) talk.push(['trade', '', `${pixelIcon('scroll', 22)}<span>Trade packs and contracts</span>`]);
    if (recipesAt(npcId).length) talk.push(['craft', npcId, `${pixelIcon('star', 22)}<span>Commission work</span>`]);
    if (BENCH_OF[npcId]) talk.push(['craft', BENCH_OF[npcId], `${pixelIcon('star', 22)}<span>Use the workbench</span>`]);
    const base = { title: n.name, sub: esc(n.title), portrait: this.face(npcId), w: 424, h: 430 };
    const handlers: Record<string, Handler> = {
      quest: (id) => this.open({ kind: 'dialog', id: npcId, quest: id }),
      back: () => this.open({ kind: 'dialog', id: npcId }),
      accept: (id) => {
        life.command({ t: 'accept', quest: id });
        this.open({ kind: 'dialog', id: npcId });
      },
      complete: (id) => {
        life.command({ t: 'complete', quest: id });
        this.open({ kind: 'dialog', id: npcId });
      },
      shop: () => this.open({ kind: 'shop', id: npcId, tab: 'buy' }),
      trade: () => this.open({ kind: 'dialog', id: npcId, trade: true }),
      craft: (id) => this.open({ kind: 'craft', id }),
      contract: (id) => life.command({ t: 'contract', id: Number(id) }),
      sellpack: () => life.command({ t: 'interact' }),
    };
    // One quest and nothing else to talk about: open it straight away.
    const only = [...qa.turnIn, ...qa.offer];
    if (!questId && !trade && only.length === 1 && !active.length && !talk.length) questId = only[0].id;

    if (trade && outpost) {
      const rows = PACKS.filter((pk) => (pk as { kind?: string }).kind !== 'material')
        .map((pk) => {
          const r = route(pk.origin, outpost.id);
          if (!r) return '';
          const dmd = demandAt(life, outpost.id, pk.id);
          const fresh = Math.round(pk.base * r.factor * dmd * freshness(0));
          return `<div class="lui-row" data-tip="pack:${pk.id}"><div class="ib">${iconHtml(pk.icon)}</div><div class="body"><b>${esc(pk.name)}</b><small>from ${esc(placeName(pk.origin))} · demand ${Math.round(dmd * 100)}%</small></div><div class="price">${money(fresh, 12)}${r.seals ? ` +${r.seals} ${pixelIcon('seal', 12)}` : ''}</div></div>`;
        })
        .join('');
      const cs = life.state.contracts;
      const mine = (cs?.active ?? []).filter((k) => k.outpost === outpost.id);
      const offered = (cs?.offered ?? []).filter((k) => k.outpost === outpost.id);
      const contracts =
        mine.length || offered.length
          ? `<div class="h">Contracts</div><div class="lui-list">${mine.map((k) => `<div class="lui-row"><div class="ib">${pixelIcon('scroll', 28)}</div><div class="body"><b>${k.count} × ${esc(packDef(k.pack).name)}</b><small>taken · ${k.delivered}/${k.count} delivered · ${shortTime(k.expires - life.state.clock)} left</small></div><div class="price">+${money(k.bonusCoins, 12)}</div></div>`).join('')}${offered.map((k) => `<div class="lui-row"><div class="ib">${pixelIcon('scroll', 28)}</div><div class="body"><b>${k.count} × ${esc(packDef(k.pack).name)}</b><small>a bonus on the normal price · ${shortTime(CONTRACTS.durationSeconds)} to fill once taken</small></div><div class="price">+${money(k.bonusCoins, 12)}</div><button class="lui-btn small gold" data-act="contract" data-arg="${k.id}">Take</button></div>`).join('')}</div>`
          : '';
      const pk = carried(life, this.d.sim);
      const q = pk ? quote(life, pk, outpost.id) : null;
      return {
        ...base,
        h: 500,
        body: `<div class="h">Buying today (fresh packs)</div><div class="lui-list">${rows}</div><p class="note" style="margin-top:8px">Carry a pack here and press F to sell. Each sale lowers demand by 5%; it recovers over time. Fresh packs earn up to +15%; stale ones lose up to 12%.</p>${contracts}`,
        foot: `<button class="lui-btn" data-act="back">Back</button>${pk && q ? `<button class="lui-btn gold" data-act="sellpack">Sell ${esc(packDef(pk.def).name)} for ${money(q.coins, 12)}</button>` : '<button class="lui-btn" data-act="close">Goodbye</button>'}`,
        handlers,
      };
    }

    if (questId) {
      const q = questDef(questId);
      const qp = life.state.quests.active.find((x) => x.id === questId);
      if (qa.turnIn.some((t) => t.id === questId)) {
        return { ...base, body: `<h2 class="q-title">${esc(q.name)}</h2><p class="q-story">${dropcap(q.outro)}</p>${this.rewards(q)}`, foot: `<button class="lui-btn gold" data-act="complete" data-arg="${q.id}">Complete Quest</button><button class="lui-btn" data-act="back">Cancel</button>`, handlers };
      }
      if (qa.offer.some((t) => t.id === questId)) {
        return { ...base, body: `<h2 class="q-title">${esc(q.name)}</h2><p class="q-story">${dropcap(q.intro)}</p><div class="h">Objectives</div>${this.objectives(q)}${this.rewards(q)}`, foot: `<button class="lui-btn gold" data-act="accept" data-arg="${q.id}">Accept</button><button class="lui-btn" data-act="back">Decline</button>`, handlers };
      }
      return { ...base, body: `<h2 class="q-title">${esc(q.name)}</h2><p class="q-story">${dropcap(q.intro)}</p><div class="h">Objectives</div>${this.objectives(q, qp)}${this.rewards(q)}`, foot: `<button class="lui-btn" data-act="back">Back</button><button class="lui-btn" data-act="close">Goodbye</button>`, handlers };
    }

    const quests = [
      ...qa.turnIn.map((q) => `<li data-act="quest" data-arg="${q.id}">${pixelIcon('qmark', 22)}<span>${esc(q.name)}</span><small>complete</small></li>`),
      ...qa.offer.map((q) => `<li data-act="quest" data-arg="${q.id}">${pixelIcon('excl', 22)}<span>${esc(q.name)}</span></li>`),
      ...active.map((qp) => `<li class="prog" data-act="quest" data-arg="${qp.id}">${pixelIcon('qgray', 22)}<span>${esc(questDef(qp.id).name)}</span><small>in progress</small></li>`),
    ];
    const talkHtml = talk.map(([act, arg, html]) => `<li class="talk" data-act="${act}" data-arg="${arg}">${html}</li>`);
    return {
      ...base,
      body: `<p class="g-say">“${esc(GREETINGS[npcId] ?? 'Good day.')}”</p>${quests.length ? `<div class="h">Quests</div><ul class="g-opts">${quests.join('')}</ul>` : ''}${talkHtml.length ? `<div class="h">Talk</div><ul class="g-opts">${talkHtml.join('')}</ul>` : ''}`,
      foot: `<span></span><button class="lui-btn" data-act="close">Goodbye</button>`,
      handlers,
    };
  }

  private shopView(npcId: string, tab: 'buy' | 'sell'): View {
    const life = this.life;
    const v = vendorFor(npcId)!;
    const n = life.zone.recipe.npcs.find((x) => x.id === npcId)!;
    const s = life.state;
    let grid = '';
    if (tab === 'buy') {
      grid = v.sells
        .map((o) => {
          const it = itemDef(o.item);
          const can = s.coins >= o.price && s.seals >= (o.seals ?? 0);
          return `<div class="m-item${can ? '' : ' cant'}" data-act="buy" data-arg="${o.item}" data-tip="item:${o.item}"${can ? '' : ' disabled'}><div class="ib">${iconHtml(it.icon, o.item)}</div><div><div class="nm">${esc(it.name)}</div><div class="pr">${money(o.price, 12)}${o.seals ? ` + ${o.seals} ${pixelIcon('seal', 12)}` : ''}</div></div></div>`;
        })
        .join('');
    } else {
      const have = v.buys.filter((i) => life.count(i) > 0);
      grid = have
        .map((i) => {
          const it = itemDef(i);
          const price = Math.max(1, Math.round(it.value * v.buyRate));
          return `<div class="m-item" data-act="sell" data-arg="${i}" data-tip="item:${i}"><div class="ib">${iconHtml(it.icon, i)}<span class="n">${life.count(i)}</span></div><div><div class="nm">${esc(it.name)}</div><div class="pr">${money(price, 12)} each</div></div></div>`;
        })
        .join('');
      if (!have.length) grid = `<div class="m-empty" style="grid-column:1/-1">Nothing ${esc(n.name.split(' ')[0])} wants in your bag.</div>`;
    }
    const buys = v.buys.map((id) => itemDef(id)?.name).filter(Boolean).join(', ');
    return {
      title: v.name,
      sub: esc(n.title),
      portrait: this.face(npcId),
      w: 440,
      h: 500,
      body: `<div class="m-tabs"><span class="m-tab${tab === 'buy' ? ' on' : ''}" data-act="tab" data-arg="buy">Buy</span><span class="m-tab${tab === 'sell' ? ' on' : ''}" data-act="tab" data-arg="sell">Sell</span></div>
        <div class="m-grid${tab === 'sell' ? ' m-sell' : ''}">${grid}</div>
        <div class="m-buys"><b>${esc(n.name.split(' ')[0])} buys:</b> ${esc(buys)}. ${tab === 'buy' ? 'Click to buy one, shift-click for five.' : 'Click to sell one, shift-click to sell them all.'}</div>`,
      foot: `<span>${money(s.coins)}&nbsp; ${pixelIcon('seal', 16)} <b>${s.seals}</b></span><span style="display:flex;gap:12px"><button class="lui-btn small" data-act="sellall">Sell all produce</button><button class="lui-btn small" data-act="back">Back</button></span>`,
      handlers: {
        tab: (t) => this.open({ kind: 'shop', id: npcId, tab: t as 'buy' | 'sell' }),
        buy: (item, e) => life.command({ t: 'buy', npc: npcId, item, n: e?.shiftKey && itemDef(item).stack > 1 ? 5 : 1 }),
        sell: (item, e) => life.command({ t: 'sell', npc: npcId, item, n: e?.shiftKey ? 9999 : 1 }),
        sellall: () => {
          for (const i of v.buys) if (life.count(i) > 0 && itemDef(i).cat === 'produce') life.command({ t: 'sell', npc: npcId, item: i, n: 9999 });
        },
        back: () => this.open({ kind: 'dialog', id: npcId }),
      },
    };
  }

  private craftView(benchOrNpc: string): View {
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
        const need = inputs.map((i) => `<span class="${life.count(i.item) >= i.n ? 'have' : 'lack'}">${life.count(i.item)}/${i.n} ${esc(itemDef(i.item).name)}</span>`).join(' · ');
        let sells = '';
        if (pack && (pack as { kind?: string }).kind !== 'material') {
          const quotes = life.zone.recipe.outposts
            .map((o) => {
              const rt = route(pack.origin, o.id);
              if (!rt) return '';
              return `${esc(placeName(o.id))} ~${money(Math.round(pack.base * rt.factor * demandAt(life, o.id, pack.id) * freshness(0)), 11)}`;
            })
            .filter(Boolean);
          sells = `<small>Sells at ${quotes.join(' · ')}</small>`;
        } else if (pack) sells = '<small>Building material: haul it to a house site</small>';
        const name = pack?.name ?? item?.name ?? r.id;
        const icon = pack ? iconHtml(pack.icon) : item ? iconHtml(item.icon, r.makes.item) : pixelIcon('star', 28);
        const desc = item?.desc ? `<small>${esc(item.desc)}</small>` : '';
        const tip = item ? ` data-tip="item:${r.makes.item}"` : pack ? ` data-tip="pack:${pack.id}"` : '';
        return `<div class="lui-row"${tip}><div class="ib">${icon}</div><div class="body"><b>${esc(name)}</b><small>${need}${coins ? ` · ${money(coins, 11)}` : ''}${labor ? ` · ${labor} labor` : ''}</small>${sells}${desc}</div><button class="lui-btn small ${have ? 'gold' : ''}" data-act="make" data-arg="${r.id}" ${have ? '' : 'disabled'}>${pack ? 'Pack it' : 'Make'}</button></div>`;
      })
      .join('');
    const backLine = this.d.sim.player.pack ? '<p style="color:var(--bad)">Your back is full: set your pack down (X) before packing another.</p>' : '';
    return {
      title,
      sub: npc ? esc(npc.title) : '',
      portrait: npc ? this.face(benchOrNpc) : `<span class="emoji">${pixelIcon('star', 36)}</span>`,
      w: 520,
      h: 520,
      body: backLine + `<div class="lui-list">${rows}</div>`,
      foot: `<span>${money(life.state.coins)}&nbsp; ${pixelIcon('bolt', 16)} <b>${Math.floor(life.state.labor)}</b> labor</span><button class="lui-btn" data-act="close">Close</button>`,
      handlers: {
        make: (id) => {
          life.command({ t: 'craft', recipe: id });
          if (recipeDef(id)?.makes.pack) setTimeout(() => this.close(), 60);
        },
      },
    };
  }

  private storageView(houseId: number): View {
    const life = this.life;
    const h = life.state.houses.find((x) => x.id === houseId);
    if (!h || !isComplete(h)) return { title: 'Storage chest', w: 420, body: '<p>Gone.</p>' };
    const bp = blueprintDef(h.blueprint);
    const list = (stacks: Array<{ item: string; n: number }>, act: string) =>
      stacks.map((st) => `<div class="lui-row" data-tip="item:${st.item}"><div class="ib">${iconHtml(itemDef(st.item).icon, st.item)}<span class="n">${st.n}</span></div><div class="body"><b>${esc(itemDef(st.item).name)}</b></div><button class="lui-btn small" data-act="${act}" data-arg="${st.item}">${act === 'store' ? 'Store' : 'Take'}</button></div>`).join('') || '<p class="muted">Empty</p>';
    return {
      title: 'Storage chest',
      sub: `${h.storage.length}/${bp.perks.storageSlots} kinds stored`,
      w: 620,
      h: 520,
      body: `<div class="lui-cols"><div><div class="h">Your bag</div><div class="lui-list">${list(life.state.bag, 'store')}</div></div><div><div class="h">Chest</div><div class="lui-list">${list(h.storage, 'take')}</div></div></div>`,
      handlers: {
        store: (item) => life.command({ t: 'store', house: houseId, item, n: life.count(item) }),
        take: (item) => life.command({ t: 'take', house: houseId, item, n: 9999 }),
      },
    };
  }

  private renderBag(): void {
    const life = this.life;
    const s = life.state;
    this.bagSig = this.signature();
    const cells: string[] = [];
    for (let i = 0; i < BAG_SLOTS; i++) {
      const st = s.bag[i];
      if (!st) {
        cells.push('<div class="ib sm empty"></div>');
        continue;
      }
      const def = itemDef(st.item);
      cells.push(`<div class="ib sm${this.sel === i ? ' sel' : ''}" data-act="sel" data-arg="${i}" data-tip="item:${st.item}">${iconHtml(def.icon, st.item)}${st.n > 1 ? `<span class="n">${st.n}</span>` : ''}</div>`);
    }
    let detail = '<span class="muted">Click an item to use it.</span>';
    const st = s.bag[this.sel];
    if (st) {
      const def = itemDef(st.item);
      const verb = def.cat === 'seed' ? (s.seed === st.item ? 'Planting this' : 'Plant with F') : def.cat === 'deed' ? 'Summon' : def.cat === 'mount' ? 'Call (R)' : def.cat === 'glider' ? (s.glider === def.glider ? 'Equipped' : 'Equip') : def.cat === 'placeable' ? 'Place' : def.cat === 'consumable' ? 'Use' : '';
      detail = `<b>${esc(def.name)}</b> <span class="muted">×${st.n}</span>${verb ? ` <button class="lui-btn gold small" data-act="use" data-arg="${st.item}">${verb}</button>` : ''}`;
    }
    const pk = carried(life, this.d.sim);
    this.bagEl.style.width = '452px';
    this.bagEl.innerHTML =
      `<div class="mw-bar">Bag <small>${s.bag.length} / ${BAG_SLOTS}</small></div><div class="mw-x" data-act="close" title="Close (I)">✕</div>` +
      `<div class="mw-body" style="overflow:hidden"><div class="bag-grid">${cells.join('')}</div><div class="bag-detail">${detail}</div>${pk ? `<div class="note" style="margin-top:6px">On your back: ${withIcons(`${packDef(pk.def).icon} ${packDef(pk.def).name}`, 14)}</div>` : ''}</div>` +
      `<div class="mw-foot"><span>${money(s.coins)}&nbsp; ${pixelIcon('seal', 16)} <b>${s.seals}</b></span><span>${pixelIcon('bolt', 14)} <b>${Math.floor(s.labor)}</b> labor</span></div>`;
    this.bagHandlers = {
      sel: (i) => {
        this.sel = Number(i);
        this.renderBag();
      },
      use: (item) => {
        life.command({ t: 'use', item });
        const cat = itemDef(item).cat;
        if (cat === 'deed' || cat === 'placeable' || cat === 'mount') this.closeAll();
      },
    };
  }

  private garageView(): View {
    const life = this.life;
    const owned = life.state.bag.filter((s) => itemDef(s.item).cat === 'deed' || itemDef(s.item).cat === 'mount');
    const p = this.d.sim.player;
    const rows = owned
      .map((s) => {
        const def = itemDef(s.item);
        const vid = def.vehicle ?? def.mount!;
        const r = rideable(vid);
        const out = life.state.vehicles.find((v) => v.def === vid);
        const where = out ? `${Math.round(Math.hypot(out.x - p.pos.x, out.z - p.pos.z))} m away${out.cargo.some(Boolean) ? ` · ${out.cargo.filter(Boolean).length} packs aboard` : ''}` : 'stabled';
        const stats = isMount(r) ? `${r.runSpeed} m/s · ${r.canCarryPack ? 'carries a pack' : 'no packs'}` : `${r.maxSpeed} m/s · ${r.cargo.length} pack slots · ${r.seats.length} seats`;
        return `<div class="lui-row" data-tip="item:${s.item}"><div class="ib">${iconHtml(r.icon)}</div><div class="body"><b>${esc(r.name)}</b><small>${stats}</small><small>${where}</small></div>${isMount(r) ? `<button class="lui-btn small gold" data-act="mount">Call (R)</button>` : `<button class="lui-btn small gold" data-act="summon" data-arg="${s.item}">${out ? 'Bring here' : 'Summon'}</button>`}${out && !isMount(r) ? `<button class="lui-btn small" data-act="recall" data-arg="${out.id}">Send home</button>` : ''}</div>`;
      })
      .join('');
    return {
      title: 'Vehicles & mounts',
      sub: 'Boats appear at the nearest deep water',
      portrait: `<span class="emoji">${pixelIcon('wheel', 36)}</span>`,
      w: 480,
      h: 430,
      body: `<div class="lui-list">${rows || '<p>You own no vehicles yet. Bertram (carts and cars), Captain Ilsa (boats) and Sela (mounts) are in Lanternwick.</p>'}</div>`,
      handlers: {
        summon: (item) => {
          life.command({ t: 'summon', item });
          this.close();
        },
        recall: (id) => life.command({ t: 'recall', vehicle: Number(id) }),
        mount: () => {
          life.command({ t: 'mount' });
          this.close();
        },
      },
    };
  }

  private logView(): View {
    const life = this.life;
    const active = life.state.quests.active;
    if (!this.logSel || !active.some((q) => q.id === this.logSel)) this.logSel = active[0]?.id ?? '';
    const list =
      `<div class="ql-zone"><span>${esc(life.zone.recipe.name)}</span><span>${active.length}</span></div>` +
      active.map((qp) => `<div class="ql-q${qp.id === this.logSel ? ' sel' : ''}${isReady(life, qp.id) ? ' ready' : ''}" data-act="logsel" data-arg="${qp.id}"><i class="dot"></i>${esc(questDef(qp.id).name)}</div>`).join('') +
      `<div class="ql-zone" style="margin-top:14px"><span>Completed</span><span>${life.state.quests.done.length}</span></div>` +
      life.state.quests.done.map((id) => `<div class="ql-q done"><i class="dot done"></i>${esc(questDef(id).name)}<small>✓ done</small></div>`).join('');
    let page = '<p class="muted">No quests under way. Look for people with a gold mark over their heads.</p>';
    const qp = active.find((x) => x.id === this.logSel);
    if (qp) {
      const q = questDef(qp.id);
      const who = life.zone.recipe.npcs.find((n) => n.id === (q.turnIn ?? q.giver))?.name ?? '';
      page = `<h2 class="q-title">${esc(q.name)}</h2><p class="q-story">${dropcap(q.intro)}</p><div class="h">Objectives</div>${this.objectives(q, qp)}${isReady(life, q.id) ? `<p style="margin-top:6px;color:var(--good);font-weight:700">Ready: return to ${esc(who)}.</p>` : ''}${this.rewards(q)}`;
    }
    return {
      title: 'Quest Log',
      sub: `${life.state.quests.done.length} of ${QUESTS.length} complete`,
      portrait: `<span class="emoji">${pixelIcon('scroll', 40)}</span>`,
      w: 700,
      h: 520,
      body: `<div class="ql"><div class="ql-list">${list}</div><div>${page}</div></div>`,
      handlers: {
        logsel: (id) => {
          this.logSel = id;
          this.renderPanel(false);
        },
      },
    };
  }

  private characterView(): View {
    const life = this.life;
    const p = this.d.sim.player;
    const slot = (label: string, filled: string | null, emoji: string, tip: string) =>
      `<div class="ch-slot" data-tip="${tip}">${filled ?? `<div class="ib big empty ghost">${iconHtml(emoji, undefined, 48)}</div>`}<span>${label}</span></div>`;
    const item = (id: string) => `<div class="ib big">${iconHtml(itemDef(id).icon, id, 48)}</div>`;
    const glider = life.state.glider ? `glider.${life.state.glider}` : null;
    const mount = life.state.bag.find((s) => itemDef(s.item)?.cat === 'mount')?.item ?? null;
    const back = carried(life, this.d.sim);
    const body = this.portraitOf('body');
    const weapon = p.weapon;
    return {
      title: 'Character',
      sub: esc(this.playerName),
      portrait: this.face('player'),
      w: 620,
      h: 520,
      body: `<div class="ch">
        <div class="ch-col">${slot('Head', null, '🪖', 'slot:Head')}${slot('Back', glider ? item(glider) : null, '🪁', glider ? `item:${glider}` : 'slot:Back')}${slot('Chest', null, '👕', 'slot:Chest')}${slot('Hands', null, '🧤', 'slot:Hands')}</div>
        <div class="ch-mid"><div class="ch-model">${body ? `<img src="${body}" alt="">` : '<div style="display:grid;place-items:center;height:100%;font-size:90px">🧑</div>'}</div>
          <div class="ch-weap">${slot('Main hand', `<div class="ib big">${iconHtml(WEAPON_ICONS[weapon] ?? '🗡️', undefined, 48)}</div>`, '🗡️', `weapon:${weapon}`)}${slot('Off hand', null, '🛡️', 'slot:Off hand')}${slot('Tool', null, '🔨', 'slot:Tool')}</div></div>
        <div class="ch-col">${slot('Legs', null, '👖', 'slot:Legs')}${slot('Feet', null, '🥾', 'slot:Feet')}${slot('Mount', mount ? item(mount) : null, '🐎', mount ? `item:${mount}` : 'slot:Mount')}${slot('Pack', back ? `<div class="ib big">${iconHtml(packDef(back.def).icon, undefined, 48)}</div>` : null, '📦', back ? `pack:${back.def}` : 'slot:Pack')}</div>
        <div class="ch-stats"><h4>${esc(this.playerName)}</h4>
          ${this.maxHp ? `<div class="r"><span>Health</span><b>${Math.round(this.hp)} / ${this.maxHp}</b></div>` : ''}
          <div class="r"><span>Labor</span><b>${Math.floor(life.state.labor)} / ${LABOR.max}</b></div>
          <div class="r"><span>Weapon</span><b>${esc(WEAPON_NAMES[weapon] ?? '')}</b></div>
          <div class="r"><span>Glider</span><b>${life.state.glider ? esc(gliderDef(life.state.glider).name) : 'None'}</b></div>
          <div class="r"><span>Money</span>${money(life.state.coins, 12)}</div>
          <div class="r"><span>Seals</span><b>${life.state.seals}</b></div>
          <div class="note">Head, chest, hands, legs, feet, off hand and tool are slots for armour and tools still to come.</div></div>
      </div>`,
    };
  }

  private settingsView(): View {
    const v = Math.round(userScale() * 100);
    return {
      title: 'Settings',
      portrait: `<span class="emoji">${pixelIcon('gear', 36)}</span>`,
      w: 420,
      h: 330,
      body: `<div class="h">Interface</div><div class="set-row"><span>UI size</span><input type="range" min="${UI_SCALE_MIN * 100}" max="${UI_SCALE_MAX * 100}" step="5" value="${v}" data-set="uiScale"><b>${v}%</b></div><p class="note">The UI keeps its size relative to the window; this makes it bigger or smaller on top of that.</p><div class="h">Credits</div><p class="note">Item and skill icons drawn from Twemoji by Twitter and contributors, CC-BY 4.0. Type: TeX Gyre Pagella (GUST Font License) and Alegreya SC (SIL Open Font License).</p>`,
      foot: `<button class="lui-btn small" data-act="resetScale">Reset</button><button class="lui-btn" data-act="close">Done</button>`,
      handlers: {
        resetScale: () => {
          setUserScale(1);
          this.renderPanel(false);
        },
      },
    };
  }

  /** The island from above with places, your things, other players, the goal and you. */
  private drawBigMap(): void {
    const life = this.life;
    const hf = this.d.world.terrain!;
    if (!this.mapImage) this.mapImage = buildMapImage(this.d.world);
    const g = this.bigMap.getContext('2d')!;
    g.drawImage(this.mapImage, 0, 0);
    const toPx = (x: number, z: number): [number, number] => [((hf.max - x) / hf.size) * 768, ((hf.max - z) / hf.size) * 768];
    g.textAlign = 'center';
    for (const pl of life.zone.recipe.places) {
      const [px, py] = toPx(pl.x, pl.z);
      g.font = '18px system-ui';
      g.fillText(pl.icon, px, py + 6);
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
      g.font = '16px system-ui';
      g.fillText('🏠', px, py + 5);
    }
    for (const v of life.state.vehicles) {
      const [px, py] = toPx(v.x, v.z);
      g.font = '14px system-ui';
      g.fillText(rideable(v.def).icon, px, py + 5);
    }
    for (const o of this.others()) {
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

  private devView(): View {
    const life = this.life;
    const places = life.zone.recipe.places.map((pl) => `<button class="lui-btn small" data-act="tp" data-arg="${pl.id}">${esc(pl.name)}</button>`).join('');
    return {
      title: 'Developer tools',
      sub: 'For trying things out quickly. ` toggles this window.',
      w: 560,
      h: 600,
      body: `<div class="lui-dev"><div class="h">Give</div>
      <button class="lui-btn small" data-act="grant" data-arg="coins">+1 gold</button>
      <button class="lui-btn small" data-act="grant" data-arg="seals">+10 seals</button>
      <button class="lui-btn small" data-act="grant" data-arg="labor">+500 labor</button>
      <button class="lui-btn small" data-act="grant" data-arg="seeds">Seeds, saplings & young animals</button>
      <button class="lui-btn small" data-act="grant" data-arg="produce">Produce for packs</button>
      <button class="lui-btn small" data-act="grant" data-arg="mats">Building materials</button>
      <button class="lui-btn small" data-act="grant" data-arg="rides">Every vehicle, mount & glider</button>
      <button class="lui-btn small" data-act="grant" data-arg="house">Cottage blueprint, cog design, scarecrows</button>
      <div class="h">Time</div>
      <button class="lui-btn small" data-act="warp" data-arg="60">+1 minute</button>
      <button class="lui-btn small" data-act="warp" data-arg="600">+10 minutes</button>
      <button class="lui-btn small" data-act="warp" data-arg="3600">+1 hour</button>
      <div class="h">Teleport</div>${places}
      <div class="h">Save</div><button class="lui-btn small" data-act="reset">Start Emberholm over</button>
      ${this.onBugReport ? `<div class="h">Bug report</div><button class="lui-btn small" data-act="bug">Record a bug report</button><div class="note">Or press <b>${esc(this.bugKey())}</b> any time (click both sticks on a controller). It keeps the last 30 seconds of play, then records your voice and the screen until you press it again.</div>` : ''}</div>`,
      handlers: {
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
          // Close first, so the report's screenshot shows the game rather than this window.
          this.closeAll();
          this.onBugReport?.();
        },
      },
    };
  }

  /** Set by the app: move the player somewhere (dev panel). */
  onTeleport: ((x: number, z: number) => void) | null = null;
  onReset: (() => void) | null = null;
  /** Whether the developer panel opens (online, the server decides: development and beta only). */
  devTools = true;
  /** Online: everyone else in your channel, for the map. */
  others: () => Array<{ name: string; online: boolean; x: number; z: number }> = () => [];
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
