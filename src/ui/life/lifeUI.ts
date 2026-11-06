import * as THREE from 'three';
import type { Life, LifeEvent } from '../../sim/life/life';
import type { Sim } from '../../sim/sim';
import type { World } from '../../sim/types';
import { itemDef, recipesAt, vendorFor, BAG_SLOTS, recipe as recipeDef, RECIPES, VENDORS } from '../../content/items';
import { packDef, PACKS, route, placeName, LABOR, CONTRACTS } from '../../content/trade';
import { QUESTS, questDef, objectiveTarget, type QuestDef } from '../../content/quests';
import { rideable, glider as gliderDef, isBoat, isMount } from '../../content/vehicles';
import { cropDef, CLIMATES, GATHERING } from '../../content/farming';
import { blueprintDef } from '../../content/housing';
import { structureDef } from '../../content/structures';
import { questsAt, isReady } from '../../sim/life/quests';
import { quote, demandAt, freshness, carried } from '../../sim/life/trade';
import { ridden, sailEfficiency } from '../../sim/life/vehicles';
import { heightAboveGround } from '../../sim/player/traverse';
import { angleDiff } from '../../sim/math';
import { SURFACE } from '../../sim/terrain';
import { isComplete, stillNeeds, housePose, stageReady } from '../../sim/life/housing';
import { nodeReady, shortTime } from '../../sim/life/interact';
import { shipFinished, shipNeeds, shipOn, shipStageReady } from '../../sim/life/shipyard';
import { raining, hourOfDay, stormAt } from '../../sim/life/weather';
import { WEAPON_ICONS, WEAPON_NAMES } from '../icons';
import { comboDamage } from '../skills/describe';
import { pointsLeft } from '../../build';
import { skillBudget } from '../../sim/life/progress';
import { iconHtml, iconImage, iconUrl, money, uiIcon, uiImage } from '../theme/icons';
import { setUserScale, uiRoot, userScale, UI_SCALE_MAX, UI_SCALE_MIN } from '../theme/scale';
import { addTipSource, hideTip, tipFor, wireTips } from '../theme/tooltip';
import { closeMenu, menuPress, openMenu, type MenuEntry } from '../theme/contextMenu';
import { adminListHtml, openDevPage } from '../admin/adminMenu';
import type { Vitals } from '../../render/hud';
import type { AutoWalk } from '../../app/autoWalk';
import { TravelUI } from './travelUI';
import { dungeonDef } from '../../sim/zone/dungeon';
import { esc } from '../../util/html';

// The open world's HUD and windows. Everything here only reads the life state and queues commands;
// nothing in the UI changes the world directly. Windows dock at the side and leave the world
// running (the map is the one that takes over), the bag docks on the right, and the person you talk
// to looks out of the corner of the window.

export type LifePress =
  | 'interact'
  | 'drop'
  | 'mount'
  | 'glider'
  | 'seed'
  | 'autorun'
  | 'bag'
  | 'map'
  | 'garage'
  | 'quests'
  | 'character'
  | 'party'
  | 'settings'
  | 'escape'
  | 'dev'
  | 'admin';

export interface LifeUIDeps {
  life: Life;
  sim: Sim;
  world: World;
  camera: () => THREE.Camera;
  yaw: () => number;
  device: () => 'keyboard' | 'gamepad';
  /** Auto-run and travel by road (src/app/autoWalk.ts), shown on the map and under the compass. */
  walk?: AutoWalk;
}

type Panel =
  | { kind: 'dialog'; id: string; quest?: string; trade?: boolean }
  | { kind: 'shop'; id: string; tab: ShopTab }
  | { kind: 'craft'; id: string }
  | { kind: 'storage'; id: string }
  | { kind: 'map' | 'garage' | 'dev' | 'admin' | 'log' | 'character' | 'settings' };

/**
 * Whether the window open (`LifeUI.openPanel`) docks on the left, where the party frame and a
 * mini-game's window go: every one of them but the bag.
 */
export const docksLeft = (open: string | null): boolean => open !== null && open !== 'bag';

type ShopTab = 'buy' | 'sell' | 'buyback';

/** Somewhere a quest leads you: the ring on the maps and the marker on the compass. */
type Goal = { x: number; z: number; label: string };
type Handler = (arg: string, e: MouseEvent | null) => void;
type View = {
  title: string;
  sub?: string;
  portrait?: string;
  body: string;
  foot?: string;
  cls?: string;
  w: number;
  h?: number;
  handlers?: Record<string, Handler>;
};

const FACES: Record<string, string> = {
  hollis: '🧓',
  mara: '👩‍🌾',
  tamsin: '🧑‍🔧',
  bertram: '🧔',
  sela: '👩‍🦰',
  ilsa: '🧑‍✈️',
  quill: '🧐',
  ysolde: '🧝',
  dunmore: '🧑‍💼',
  pell: '🎩',
  hob: '🪓',
  brenna: '⛏️',
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
const CAT: Record<string, string> = {
  seed: 'Seed',
  produce: 'Produce',
  material: 'Material',
  consumable: 'Consumable',
  placeable: 'Placeable',
  glider: 'Glider',
  deed: 'Vehicle Deed',
  mount: 'Mount',
};

/** "☀️ 14:20" or "🌙 23:05" for an hour of the day. */
function clock(h: number, sky: { sunrise: number; sunset: number }): string {
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  const icon = h >= sky.sunrise && h < sky.sunset ? (h < sky.sunrise + 1.5 || h > sky.sunset - 1.5 ? '🌅' : '☀️') : '🌙';
  return `${icon} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

const EMOJI = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}️?)*/gu;
/** Text with its emoji drawn as painted icons where there are any. */
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
  /**
   * Whether the mouse was steering the camera when the open windows took it (a window frees the
   * pointer as it opens). A window that closes itself after something clicked in it gives it back.
   */
  private hadMouse = false;
  private panelSig = '';
  private bagSig = '';
  private sel = -1;
  private logSel = '';
  /** The quest whose Abandon was pressed once: the log asks before giving it up. */
  private abandonAsk = '';
  private untrackedFor = '';
  private untrackedSet = new Set<string>();
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
  /** Health, MP and stamina, as the app last said (setVitals). */
  private vit: Vitals | null = null;
  /** What each vital's bar and the character window last showed, so only changes touch the page. */
  private vitalsShown = new Map<string, string>();
  /** Travel by road on the map, and the auto-walk readout (src/ui/life/travelUI.ts). */
  private travel: TravelUI | null = null;
  private travelSig = '';

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
      '<span class="zoom in" data-zoom="1" title="Zoom In">+</span><span class="zoom out" data-zoom="-1" title="Zoom Out">−</span>';
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
      btn('bag', uiIcon('bag', 34), 'Bag', 'I') +
      btn('character', uiIcon('helm', 34), 'Character', 'P') +
      btn('quests', uiIcon('scroll', 34), 'Quests', 'L') +
      btn('map', uiIcon('map', 34), 'Map', 'M') +
      btn('garage', uiIcon('wheel', 34), 'Rides', 'V') +
      btn('settings', uiIcon('gear', 34), 'Settings', '');
    this.menuEl.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-press]') as HTMLElement | null;
      if (b) this.press(b.dataset.press as LifePress);
    });
    this.card.hidden = true;
    this.bagEl.hidden = true;
    for (const w of [this.card, this.bagEl]) {
      w.addEventListener('click', (e) => this.onWindowClick(e, w));
      w.addEventListener('contextmenu', (e) => this.onWindowMenu(e, w));
      w.addEventListener('input', (e) => {
        const t = e.target as HTMLInputElement;
        if (t.dataset.set === 'uiScale') {
          setUserScale(Number(t.value) / 100);
          const out = t.parentElement?.querySelector('b');
          if (out) out.textContent = `${t.value}%`;
        }
      });
    }
    for (const e of [
      this.portrait,
      this.vitals,
      this.minimap,
      this.clockEl,
      this.compass,
      this.banner,
      this.toasts,
      this.prompt,
      this.quests,
      this.rideBox,
      this.menuEl,
      this.card,
      this.bagEl,
    ])
      root.appendChild(e);
    wireTips();
    addTipSource((tip) => this.tip(tip));
    if (d.walk) {
      const player = (): [number, number] => [d.sim.player.pos.x, d.sim.player.pos.z];
      this.travel = new TravelUI({
        walk: d.walk,
        world: d.world,
        places: () => this.life.zone.recipe.places,
        player,
        device: d.device,
        toast: (t, k) => this.toast(t, k),
      });
      this.travel.attachMap(this.bigMap);
    }
  }

  /**
   * Adds a button to the menu at the bottom right, before Settings (the Party window, online): it
   * presses `press` as its key does.
   */
  addMenuButton(press: LifePress, icon: string, label: string, key: string): void {
    const b = document.createElement('div');
    b.className = 'hud-mbtn';
    b.dataset.press = press;
    b.title = `${label}${key ? ` (${key})` : ''}`;
    b.innerHTML = `${icon}${key ? `<span class="k">${key}</span>` : ''}<span class="lbl">${label}</span>`;
    this.menuEl.insertBefore(b, this.menuEl.querySelector('[data-press="settings"]'));
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

  /** Your health, MP and stamina, for the vitals beside your portrait and the character window. */
  setVitals(v: Vitals): void {
    this.vit = v;
    this.hp = v.hp;
    this.maxHp = v.maxHp;
  }

  // ---------- Input ----------

  press(k: LifePress): void {
    // Mini-games first (src/ui/minigames): F on another player challenges them, and at a table the
    // world's keys wait and Escape offers to concede.
    if (this.intercept?.(k)) return;
    const life = this.life;
    const p = this.d.sim.player;
    if (k === 'escape') {
      if (this.panel) return this.close();
      if (this.bagOpen) return this.closeBag();
      if (life.placing) return life.command({ t: 'cancelPlace' });
      return;
    }
    // The map takes over; with anything else open the world keys still work.
    if (this.modal && !['bag', 'map', 'garage', 'dev', 'admin', 'quests', 'character', 'settings', 'autorun'].includes(k)) return;
    switch (k) {
      case 'autorun':
        return this.travel?.toggle();
      case 'interact': {
        const f = life.focus;
        // Doing something here means stopping here (the glider's gust aside).
        this.travel?.interrupt(p.mode === 'glide');
        if (p.mode === 'ride') life.command({ t: 'exit' });
        else if (p.mode === 'glide') life.command({ t: 'gust' });
        // Someone else's vehicle isn't on your island: say whose, and the channel seats you.
        else if (f?.action === 'ride' && f.host && f.vehicle) life.command({ t: 'ride', host: f.host, vehicle: f.vehicle });
        else life.command({ t: 'interact' });
        return;
      }
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
      case 'admin':
        return this.devTools ? this.toggle({ kind: 'admin' }) : undefined;
    }
  }

  /**
   * Menu presses (D-pad, stick, A / B, arrow keys) while a window is open: move the highlight over
   * its buttons, press the highlighted one, or close. Returns false when no window took it.
   */
  menu(m: 'toggle' | 'up' | 'down' | 'left' | 'right' | 'select' | 'back' | 'reset' | 'tab' | 'tree'): boolean {
    if (!this.panel && !this.bagOpen) return false;
    // The skill book and tree have their own keys, open window or not.
    if (m === 'tab' || m === 'tree' || m === 'toggle') return false;
    // An item's menu, while it's open, takes the presses.
    if ((m === 'up' || m === 'down' || m === 'select' || m === 'back') && menuPress(m)) return true;
    if (m === 'left' || m === 'right' || m === 'reset') closeMenu();
    // On the map the arrows, D-pad and stick pick a place to travel to, and A or Enter sets off.
    if (this.panel?.kind === 'map' && m !== 'back' && this.travel?.mapPress(m)) return true;
    if (m === 'back') {
      if (this.panel) this.close();
      else this.closeBag();
      return true;
    }
    const buttons = this.focusables();
    if (!buttons.length) return true;
    if (m === 'up' || m === 'left') this.menuFocus = this.menuFocus <= 0 ? buttons.length - 1 : this.menuFocus - 1;
    else if (m === 'down' || m === 'right') this.menuFocus = (this.menuFocus + 1) % buttons.length;
    else if ((m === 'select' || m === 'reset') && this.menuFocus >= 0) {
      const b = buttons[Math.min(this.menuFocus, buttons.length - 1)];
      // An item in the bag: A does its main thing, as a double-click would, and Y opens its menu.
      if (b.dataset.act === 'sel' && this.bagEl.contains(b)) {
        if (m === 'select') this.itemPrimary(Number(b.dataset.arg));
        else {
          const r = b.getBoundingClientRect();
          this.itemMenu(Number(b.dataset.arg), r.right, r.top);
        }
      } else if (m === 'select') b.click();
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
    this.freeMouse();
    this.renderPanel(!same);
  }

  close(): void {
    const wasShop = this.panel?.kind === 'shop';
    this.panel = null;
    this.card.hidden = true;
    this.card.innerHTML = '';
    this.handlers = {};
    hideTip();
    closeMenu();
    if (wasShop) this.closeBag();
    if (!this.bagOpen) this.hadMouse = false;
  }

  openBag(): void {
    this.bagOpen = true;
    this.bagSig = '';
    this.bagEl.hidden = false;
    this.freeMouse();
    this.renderBag();
  }

  closeBag(): void {
    this.bagOpen = false;
    this.bagEl.hidden = true;
    this.bagEl.innerHTML = '';
    hideTip();
    closeMenu();
    if (!this.panel) this.hadMouse = false;
  }

  /** Closes every window. */
  closeAll(): void {
    this.close();
    this.closeBag();
  }

  /** A window opening frees the mouse to use it, remembering whether the camera had it. */
  private freeMouse(): void {
    if (!document.pointerLockElement) return;
    this.hadMouse = true;
    document.exitPointerLock?.();
  }

  /**
   * Closes the window (or every window) once something clicked in it is under way: a pack made, a
   * vehicle summoned, off to place or ride something. The mouse goes back to steering the camera if
   * it was when the windows opened, unless a window is still open. Closing a window yourself (its
   * Close button, Escape, B) leaves the mouse free.
   */
  private finish(all = false): void {
    const hadMouse = this.hadMouse;
    if (all) this.closeAll();
    else this.close();
    if (hadMouse && !this.panel && !this.bagOpen) this.onMouseBack?.();
  }

  /** Set by the app: capture the mouse for the camera again (a window that took it has finished). */
  onMouseBack: (() => void) | null = null;

  /** Set by the app: a key for the mini-games to take before the world does; true if they took it. */
  intercept: ((k: LifePress) => boolean) | null = null;

  private onWindowClick(e: MouseEvent, w: HTMLElement): void {
    const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!b || b.hasAttribute('disabled')) return;
    e.stopPropagation();
    const act = b.dataset.act!;
    if (act === 'close') return w === this.bagEl ? this.closeBag() : this.close();
    const h = (w === this.bagEl ? this.bagHandlers : this.handlers)[act];
    h?.(b.dataset.arg ?? '', e);
  }

  /** Right-click on an item, in the bag or a merchant's window: what can be done with it. */
  private onWindowMenu(e: MouseEvent, w: HTMLElement): void {
    e.preventDefault();
    const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    const act = b?.dataset.act ?? '';
    if (!b) return;
    if (w === this.bagEl && act === 'sel') this.itemMenu(Number(b.dataset.arg), e.clientX, e.clientY);
    else if (w === this.card && (act === 'buy' || act === 'sell' || act === 'buyback'))
      this.shopMenu(act, b.dataset.arg ?? '', b.hasAttribute('disabled'), e.clientX, e.clientY);
  }

  /** A merchant's item: buy or sell one, or a handful. */
  private shopMenu(act: 'buy' | 'sell' | 'buyback', item: string, cant: boolean, x: number, y: number): void {
    const p = this.panel;
    if (p?.kind !== 'shop') return;
    const life = this.life;
    const def = itemDef(item);
    const go = (t: 'buy' | 'sell' | 'buyback', n: number) => () => life.command({ t, npc: p.id, item, n });
    const broke = cant ? 'Not enough money' : undefined;
    const entries: MenuEntry[] =
      act === 'buy'
        ? [
            { label: 'Buy One', primary: true, disabled: broke, run: go('buy', 1) },
            ...(def.stack > 1 ? [{ label: 'Buy Five', disabled: broke, run: go('buy', 5) }] : []),
          ]
        : act === 'sell'
          ? [
              { label: 'Sell One', primary: true, run: go('sell', 1) },
              { label: 'Sell All', run: go('sell', 9999) },
            ]
          : [
              { label: 'Buy Back One', primary: true, disabled: broke, run: go('buyback', 1) },
              { label: 'Buy Back All', disabled: broke, run: go('buyback', 9999) },
            ];
    openMenu(x, y, def.name, entries);
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
    // Inside a dungeon the island's map has nothing to show of where you are.
    this.minimap.style.display = this.life.dungeon ? 'none' : '';
    if (this.frameNo % 2 === 0 && !this.life.dungeon) this.drawMinimap();
    this.updateClock();
    this.updateCompass();
    this.updateBanner(dt);
    this.updatePrompt();
    this.updateQuests();
    this.updateRide(dt);
    this.placeToasts();
    this.updatePlates();
    this.updateHints();
    this.walkAway();
    this.travel?.update();
    if (this.frameNo % 15 === 0) this.refreshPortraits();
    if (this.panel?.kind === 'map') {
      // The map's foot follows travel by road; the map itself is drawn every frame.
      if (this.travel && this.travel.sig() !== this.travelSig) this.renderPanel(false);
      this.drawBigMap();
    } else if (this.panel && this.signature() !== this.panelSig) this.renderPanel(false);
    if (this.bagOpen && this.signature() !== this.bagSig) this.renderBag();
  }

  private signature(): string {
    const s = this.life.state;
    return [
      s.coins,
      s.seals,
      Math.floor(s.labor / 5),
      this.life.revision,
      s.bag.map((b) => `${b.item}${b.n}`).join(),
      s.quests.active.map((q) => `${q.id}${q.step}${q.counts}`).join(),
      s.quests.done.length,
      this.logSel,
      this.d.sim.player.pack,
      this.d.sim.player.weapon,
      this.d.sim.player.skills.join(),
      s.vehicles.length,
      s.glider,
      s.seed,
      s.contracts?.active.length,
      s.contracts?.offered.length,
      s.buyback?.map((b) => `${b.npc}${b.item}${b.n}`).join(),
      Math.round(this.hp),
    ].join('|');
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

  /** Health, MP, stamina and labor beside your portrait, and the purse under them. */
  private updateVitals(): void {
    const s = this.life.state;
    const v = this.vit;
    // Built once; after that only the fills, the numbers and the purse change (stamina refills
    // every frame after a dodge).
    if (!this.vitals.firstChild) {
      const bar = (k: string, icon: string, c: string, title: string, slim = true) =>
        `<div class="hud-bar v-${k}${slim ? ' slim' : ''}" style="--c:${c}" title="${title}"><span class="cap">${icon}</span><div class="track"><div class="fill"></div><span class="txt"></span></div></div>`;
      this.vitals.innerHTML =
        bar('hp', uiIcon('heart', 24), 'var(--hp)', 'Health', false) +
        bar('mp', uiIcon('mana', 19), 'var(--mp)', 'MP') +
        bar('st', uiIcon('stamina', 19), 'var(--stamina)', 'Stamina') +
        bar('labor', uiIcon('labor', 19), 'var(--labor)', 'Labor') +
        '<div class="hud-purse"></div>';
    }
    const shown = this.vitalsShown;
    const set = (k: string, frac: number, text: string) => {
      const width = `calc((100% - 12px) * ${Math.max(0, Math.min(1, frac)).toFixed(3)})`;
      if (shown.get(k) !== width) {
        shown.set(k, width);
        (this.vitals.querySelector(`.v-${k} .fill`) as HTMLElement).style.width = width;
      }
      if (shown.get(`${k}.text`) !== text) {
        shown.set(`${k}.text`, text);
        (this.vitals.querySelector(`.v-${k} .txt`) as HTMLElement).textContent = text;
      }
    };
    const mp = v ? `${Math.floor(v.mp)} / ${v.maxMp}` : '';
    const stamina = v ? `${Math.floor(v.stamina)} / ${v.maxStamina}` : '';
    if (v) {
      set('hp', v.hp / v.maxHp, `${Math.max(0, Math.round(v.hp))} / ${v.maxHp}`);
      set('mp', v.mp / v.maxMp, mp);
      set('st', v.stamina / v.maxStamina, stamina);
    }
    set('labor', s.labor / LABOR.max, `${Math.floor(s.labor)} / ${LABOR.max}${this.life.resting ? ' · Resting ×3' : ''}`);
    const purse = `${s.coins}|${s.seals}`;
    if (purse !== this.vitalsKey) {
      this.vitalsKey = purse;
      (this.vitals.querySelector('.hud-purse') as HTMLElement).innerHTML =
        `<span class="hud-pill" title="Money">${money(s.coins, 16)}</span><span class="hud-pill" title="Seals">${uiIcon('seal', 20)}${s.seals}</span>`;
    }
    // The character window's MP and stamina tick along with the bars, without drawing it again.
    if (v && this.panel?.kind === 'character') {
      for (const el of this.card.querySelectorAll<HTMLElement>('[data-vital]')) {
        const text = el.dataset.vital === 'mp' ? mp : stamina;
        if (el.textContent !== text) el.textContent = text;
      }
    }
  }

  private updateClock(): void {
    const life = this.life;
    const climate = CLIMATES[life.zone.recipe.climate];
    const wind = life.state.weather;
    const rel = angleDiff(this.d.yaw(), wind.windDir);
    const weather = raining(life) ? '🌧️' : (climate?.icon ?? '');
    const text = `${clock(this.skyHour?.() ?? hourOfDay(life), life.zone.recipe.sky)} ${weather}`;
    const key = `${text}|${Math.round(wind.windSpeed * 100)}|${Math.round((rel * 180) / Math.PI / 10)}`;
    if (key === this.clockKey) return;
    this.clockKey = key;
    this.clockEl.firstElementChild!.innerHTML =
      `${withIcons(text, 14)} · Wind <b style="transform:rotate(${(-rel * 180) / Math.PI}deg)">⬆</b> ${Math.round(wind.windSpeed * 100)}%`;
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
    // Townsfolk with something for you. A quest to hand in always shows: off the map, it is pinned
    // to the rim in their direction. One on offer shows while they are in view.
    const rim = N / 2 - 18;
    for (const n of r.npcs) {
      const qa = questsAt(this.life, n.id);
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
    this.travel?.draw(g, at, 2, { cx: N / 2, cy: N / 2, r: rim });
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
  goal(): Goal | null {
    const life = this.life;
    const r = life.zone.recipe;
    const npc = (id: string) => r.npcs.find((n) => n.id === id);
    const place = (id: string) => r.places.find((pl) => pl.id === id);
    for (const qp of life.state.quests.active) {
      const q = questDef(qp.id);
      if (q.milestone) continue; // something to work toward, not somewhere to go
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
        if (o.type === 'gather') {
          const nd = this.nodeFor(o.kind);
          if (nd) return nd;
        }
        if (o.type === 'craftPack')
          return (o.pack ? this.benchFor(o.pack) : null) ?? { x: r.workbenches[0].x, z: r.workbenches[0].z, label: 'Specialty Workbench' };
        if (o.type === 'placeScarecrow') return { x: r.farmland.x, z: r.farmland.z, label: 'Barleybrook Fields' };
        if ((o.type === 'plant' || o.type === 'harvest' || o.type === 'raise') && life.state.scarecrows[0])
          return { x: life.state.scarecrows[0].x, z: life.state.scarecrows[0].z, label: 'Your Plot' };
        if (o.type === 'contract') {
          const k = life.state.contracts?.active[0];
          const op = r.outposts.find((x) => x.id === (k?.outpost ?? 'westwatch'));
          if (op) return { x: op.x, z: op.z, label: placeName(op.id) };
        }
        if ((o.type === 'layKeel' || o.type === 'shipStage' || o.type === 'launch') && r.shipyards?.[0]) {
          const sy = r.shipyards[0];
          const slip = { x: sy.x, z: sy.z, label: sy.name };
          const b = shipOn(life, sy.id);
          return o.type === 'shipStage' && b && !shipFinished(b) ? this.fetchFor(shipNeeds(b), shipStageReady(b), slip) : slip;
        }
        if (o.type === 'summon' && o.vehicle && isBoat(rideable(o.vehicle))) return { x: place('docks')!.x, z: place('docks')!.z, label: 'The Docks' };
        if (o.type === 'load' && life.state.vehicles[0]) return { x: life.state.vehicles[0].x, z: life.state.vehicles[0].z, label: 'Your Vehicle' };
        if (o.type === 'placeHouse' || o.type === 'buildStage') {
          const h = life.state.houses[0];
          if (h) {
            const pose = housePose(life, h);
            const site = { x: pose.x, z: pose.z, label: 'Your House' };
            return isComplete(h) ? site : this.fetchFor(stillNeeds(h), stageReady(h), site);
          }
          // No blueprint to place yet: whoever sells them.
          const vendor = VENDORS.find((v) => v.sells.some((s) => s.item.startsWith('blueprint.')));
          const seller = vendor ? npc(vendor.npc) : undefined;
          if (seller && !life.state.bag.some((s) => s.item.startsWith('blueprint.'))) return { x: seller.x, z: seller.z, label: seller.name };
          return { x: place('hearthside')!.x, z: place('hearthside')!.z, label: 'Hearthside Rise' };
        }
        if (o.type === 'glide')
          return { x: r.places.find((pl) => pl.id === 'lanternwick')!.x, z: r.places.find((pl) => pl.id === 'lanternwick')!.z, label: 'Lanternwick' };
      }
    }
    return null;
  }

  /** The nearest resource node that gives `kind` (timber, stone...), one ready to work before one picked clean. */
  private nodeFor(kind?: string): Goal | null {
    const life = this.life;
    const p = this.d.sim.player.pos;
    const nodes = life.zone.recipe.nodes;
    let best: Goal | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      const g = GATHERING[nd.kind];
      if (!g || (kind && g.kind !== kind)) continue;
      const score = Math.hypot(nd.x - p.x, nd.z - p.z) + (nodeReady(life, i) ? 0 : 1e5);
      if (score < bestScore) {
        bestScore = score;
        best = { x: nd.x, z: nd.z, label: structureDef(nd.kind).name };
      }
    }
    return best;
  }

  /** The workbench that makes a pack. */
  private benchFor(pack: string): Goal | null {
    const rc = RECIPES.find((x) => x.makes.pack === pack);
    const b = rc ? this.life.zone.recipe.workbenches.find((w) => w.id === rc.bench) : undefined;
    return b ? { x: b.x, z: b.z, label: (b as { name?: string }).name ?? 'Workbench' } : null;
  }

  /**
   * Where to go next for a stage of your house or ship: the site, once it has all it needs or you
   * have a pack it wants on your back or aboard a vehicle; a pack it wants that you left lying
   * somewhere; otherwise the bench that makes the first pack it still wants.
   */
  private fetchFor(needs: Array<{ pack: string; have: number; need: number }>, ready: boolean, site: Goal): Goal {
    const want = needs.filter((n) => n.have < n.need).map((n) => n.pack);
    if (ready || !want.length) return site;
    const mine = this.life.state.packs.filter((pk) => want.includes(pk.def));
    if (mine.some((pk) => pk.at !== 'ground')) return site;
    const p = this.d.sim.player.pos;
    const lying = mine.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
    if (lying) return { x: lying.x, z: lying.z, label: packDef(lying.def).name };
    return this.benchFor(want[0]) ?? site;
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
    // Inside a dungeon, its name: nowhere on the island is here.
    const dungeon = this.life.dungeon ? dungeonDef(this.life.dungeon) : undefined;
    if (dungeon) here = `dungeon:${dungeon.id}`;
    if (here && here !== this.bannerPlace) {
      const pl = this.life.zone.recipe.places.find((x) => x.id === here);
      const [name, sub] = dungeon ? [dungeon.name, 'Dungeon'] : [pl?.name ?? '', this.life.zone.recipe.name];
      this.banner.innerHTML = `<div class="name">${esc(name)}</div><div class="sub">${esc(sub)}</div>`;
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

  /** Quests you've taken off the tracker, kept in this browser for each name you play under. */
  private untracked(): Set<string> {
    if (this.untrackedFor !== this.playerName) {
      this.untrackedFor = this.playerName;
      try {
        this.untrackedSet = new Set(JSON.parse(localStorage.getItem(`ruina.untracked.${this.playerName}`) ?? '[]') as string[]);
      } catch {
        this.untrackedSet = new Set();
      }
    }
    return this.untrackedSet;
  }

  private setTracked(id: string, on: boolean): void {
    const u = this.untracked();
    if (on) u.delete(id);
    else u.add(id);
    try {
      localStorage.setItem(`ruina.untracked.${this.playerName}`, JSON.stringify([...u]));
    } catch {
      /* storage unavailable */
    }
  }

  private updateQuests(): void {
    const life = this.life;
    const parts: string[] = [];
    const hidden = this.untracked();
    let untracked = 0;
    for (const qp of life.state.quests.active) {
      const q = questDef(qp.id);
      if (q.milestone) continue; // the log keeps those
      if (hidden.has(qp.id)) {
        untracked++;
        continue;
      }
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
      parts.push(
        `<div class="q"><div class="qt"><i></i>Contract · ${esc(placeName(k.outpost))}</div><div class="step">${k.count} × ${esc(packDef(k.pack).name)} <span class="count">${k.delivered}/${k.count}</span> · ${shortTime(k.expires - life.state.clock)} Left</div><div class="q-bar"><i style="width:${(k.delivered / k.count) * 100}%"></i></div></div>`,
      );
    }
    if (untracked) parts.push(`<div class="hint">${untracked} more in your quest log (L)</div>`);
    const offers = QUESTS.filter((q) => !q.auto && questsAt(life, q.giver).offer.includes(q)).length;
    if (offers) parts.push(`<div class="hint">${offers} quest${offers > 1 ? 's' : ''} on offer: look for ${uiIcon('quest-new', 15)}</div>`);
    if (!parts.length) parts.push(`<div class="hint">Nothing under way. Look for ${uiIcon('quest-new', 15)} over people's heads.</div>`);
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
      extra += `<div style="margin-top:4px">Hull <b style="color:${hull > 0.5 ? 'var(--good)' : hull > 0.25 ? 'var(--accent)' : 'var(--bad)'}">${Math.round(hull * 100)}%</b>${storm > 0 ? ' · <b style="color:var(--bad)">Rough Seas</b>' : ''}</div>`;
    }
    if (isBoat(def) && def.sail) {
      const rel = angleDiff(life.state.weather.windDir, v.heading);
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
    this.rideBox.className = 'lui show';
    const back = carried(life, sim);
    const load = isMount(def)
      ? back
        ? `<div style="margin-top:4px">${withIcons(`${packDef(back.def).icon} ${packDef(back.def).name}`)}</div>`
        : ''
      : def.cargo.length
        ? `<div class="slots">${slots.join('')}</div>`
        : '';
    this.rideBox.innerHTML = `<div style="color:var(--ink-2)">${withIcons(`${def.icon} ${def.name}`)} ${road}</div><div class="big">${Math.round(Math.abs(v.speed) * 3.6)}<small>km/h</small></div>${load}${extra}`;
  }

  /** Toasts sit at the bottom right above the menu buttons, and above the ride readout while it's up. */
  private placeToasts(): void {
    const r = this.rideBox;
    const bottom = r.classList.contains('show') ? `${parseFloat(getComputedStyle(r).bottom) + r.offsetHeight + 8}px` : '';
    if (this.toasts.style.bottom !== bottom) this.toasts.style.bottom = bottom;
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

  private updateHints(): void {
    const p = this.d.sim.player;
    const pad = this.d.device() === 'gamepad';
    const key = (k: string) => `<span class="key">${k}</span>`;
    const item = (k: string, a: string) => `<span>${k}${a}</span>`;
    let mode = p.mode === 'ride' ? 'ride' : p.mode === 'glide' ? 'glide' : p.mode === 'swim' ? 'swim' : p.pack ? 'carry' : 'foot';
    const v = mode === 'ride' ? ridden(this.life, this.d.sim) : undefined;
    if (v && isBoat(rideable(v.def))) mode = 'boat';
    if (v && isMount(rideable(v.def))) mode = 'mount';
    if (mode === 'ride' && p.host) mode = 'along';
    const sig = `${mode}${pad}`;
    if (sig === this.hintKey) return;
    this.hintKey = sig;
    const hint = document.getElementById('hint');
    if (!hint) return;
    const parts: string[] = [];
    // Auto-walk (src/app/autoWalk.ts): H or Num Lock, a click of the left stick at rest on a pad.
    // In a cart or a boat it holds the throttle: cruising.
    const auto = this.travel ? (mode === 'ride' || mode === 'boat' ? 'Cruise' : 'Auto-Run') : '';
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
      const sells =
        v && v.buys.includes(id)
          ? `<div class="row"><span class="muted">${esc(n?.name.split(' ')[0] ?? 'They')} Pays</span>${money(Math.max(1, Math.round(it.value * v.buyRate)), 12)}</div>`
          : it.value
            ? `<div class="row"><span class="muted">Worth</span>${money(it.value, 12)}</div>`
            : '';
      return `<h5>${esc(it.name)}</h5><div class="ty">${CAT[it.cat] ?? it.cat}${it.stack > 1 ? ` · Stacks to ${it.stack}` : ''}</div><p>${esc(it.desc)}</p>${extra}${sells ? `<hr>${sells}` : ''}`;
    }
    if (kind === 'pack') {
      try {
        const pk = packDef(id);
        if (pk.kind === 'material')
          return `<h5>${esc(pk.name)}</h5><div class="ty">Building Material</div><p>Made at ${esc(placeName(pk.origin))}. Haul it to a building site: your house, or a ship on the slipway.</p>`;
        return `<h5>${esc(pk.name)}</h5><div class="ty">Trade Pack</div><p>Made at ${esc(placeName(pk.origin))}. Carry it to another town's trader to sell.</p>`;
      } catch {
        return null;
      }
    }
    if (kind === 'slot') return `<h5>${esc(id)}</h5><div class="ty">Empty</div><p>There's nothing to wear here yet.</p>`;
    if (kind === 'weapon')
      return `<h5>${esc(WEAPON_NAMES[Number(id)] ?? '')}</h5><div class="ty">Main Hand</div><p>Change your weapon in the skill book (T).</p>`;
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
      this.travelSig = this.travel?.sig() ?? '';
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
      case 'map': {
        const foot = this.travel?.foot();
        return {
          title: this.life.zone.recipe.name,
          sub: esc(this.life.zone.recipe.subtitle),
          cls: 'center map',
          w: 734,
          body: '',
          foot: foot?.html,
          handlers: foot?.handlers,
        };
      }
      case 'garage':
        return this.garageView();
      case 'dev':
        return this.devView();
      case 'admin':
        return this.adminView();
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
    if (r.skillPoints)
      rows.push(
        `<div class="rw"><div class="ib">${uiIcon('star', 32)}</div><span class="nm">${r.skillPoints} Skill Point${r.skillPoints > 1 ? 's' : ''}</span></div>`,
      );
    if (r.labor) rows.push(`<div class="rw"><div class="ib">${uiIcon('labor', 32)}</div><span class="nm">${r.labor} Labor</span></div>`);
    if (r.seals) rows.push(`<div class="rw"><div class="ib">${uiIcon('seal', 32)}</div><span class="nm">${r.seals} Seal${r.seals > 1 ? 's' : ''}</span></div>`);
    if (r.coins) rows.push(`<div class="rw"><div class="ib">${uiIcon('coins', 32)}</div><span class="nm">${money(r.coins, 12)}</span></div>`);
    return rows.length ? `<div class="h">Rewards</div><div class="q-rewards">${rows.join('')}</div>` : '';
  }

  private objectives(q: QuestDef, qp?: { step: number; counts: number[] }): string {
    return `<ul class="q-objs">${q.steps
      .map((s, i) => {
        // One objective counts up; several (places to see) count how many are done.
        const many = s.objectives.length > 1;
        const o = s.objectives[0];
        const t = many ? s.objectives.length : o ? objectiveTarget(o) : 1;
        const now =
          many && qp && i === qp.step ? s.objectives.filter((x, k) => (qp.counts[k] ?? 0) >= objectiveTarget(x)).length : Math.floor(qp?.counts[0] ?? 0);
        const have = qp ? (i < qp.step ? t : i === qp.step ? now : 0) : 0;
        const done = !!qp && i < qp.step;
        const count =
          t > 1 ? ` <b>${have}/${t}</b>${qp && i === qp.step ? `<div class="q-bar"><i style="width:${Math.min(100, (have / t) * 100)}%"></i></div>` : ''}` : '';
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
    if (vendorFor(npcId)) talk.push(['shop', '', `${uiIcon('coins', 24)}<span>Browse ${esc(n.name.split(' ')[0])}'s Goods</span>`]);
    if (outpost) talk.push(['trade', '', `${uiIcon('scroll', 24)}<span>Trade Packs and Contracts</span>`]);
    if (recipesAt(npcId).length) talk.push(['craft', npcId, `${uiIcon('craft', 24)}<span>Commission Work</span>`]);
    if (BENCH_OF[npcId]) talk.push(['craft', BENCH_OF[npcId], `${uiIcon('craft', 24)}<span>Use the Workbench</span>`]);
    const base = { title: n.name, sub: esc(n.title), portrait: this.face(npcId), w: 424, h: 560 };
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
          return `<div class="lui-row" data-tip="pack:${pk.id}"><div class="ib">${iconHtml(pk.icon)}</div><div class="body"><b>${esc(pk.name)}</b><small>From ${esc(placeName(pk.origin))} · Demand ${Math.round(dmd * 100)}%</small></div><div class="price">${money(fresh, 12)}${r.seals ? ` +${r.seals} ${uiIcon('seal', 14)}` : ''}</div></div>`;
        })
        .join('');
      const cs = life.state.contracts;
      const mine = (cs?.active ?? []).filter((k) => k.outpost === outpost.id);
      const offered = (cs?.offered ?? []).filter((k) => k.outpost === outpost.id);
      const contracts =
        mine.length || offered.length
          ? `<div class="h">Contracts</div><div class="lui-list">${mine.map((k) => `<div class="lui-row"><div class="ib">${uiIcon('scroll', 32)}</div><div class="body"><b>${k.count} × ${esc(packDef(k.pack).name)}</b><small>Taken · ${k.delivered}/${k.count} Delivered · ${shortTime(k.expires - life.state.clock)} Left</small></div><div class="price">+${money(k.bonusCoins, 12)}</div></div>`).join('')}${offered.map((k) => `<div class="lui-row"><div class="ib">${uiIcon('scroll', 32)}</div><div class="body"><b>${k.count} × ${esc(packDef(k.pack).name)}</b><small>A bonus on the normal price · ${shortTime(CONTRACTS.durationSeconds)} to fill once taken</small></div><div class="price">+${money(k.bonusCoins, 12)}</div><button class="lui-btn small gold" data-act="contract" data-arg="${k.id}">Take</button></div>`).join('')}</div>`
          : '';
      const pk = carried(life, this.d.sim);
      const q = pk ? quote(life, pk, outpost.id) : null;
      return {
        ...base,
        h: 650,
        body: `<div class="h">Buying Today (Fresh Packs)</div><div class="lui-list">${rows}</div><p class="note" style="margin-top:8px">Carry a pack here and press F to sell. Each sale lowers demand by 5%; it recovers over time. Fresh packs earn up to +15%; stale ones lose up to 12%.</p>${contracts}`,
        foot: `<button class="lui-btn" data-act="back">Back</button>${pk && q ? `<button class="lui-btn gold" data-act="sellpack">Sell ${esc(packDef(pk.def).name)} for ${money(q.coins, 12)}</button>` : '<button class="lui-btn" data-act="close">Goodbye</button>'}`,
        handlers,
      };
    }

    if (questId) {
      const q = questDef(questId);
      const qp = life.state.quests.active.find((x) => x.id === questId);
      if (qa.turnIn.some((t) => t.id === questId)) {
        return {
          ...base,
          body: `<h2 class="q-title">${esc(q.name)}</h2><p class="q-story">${dropcap(q.outro)}</p>${this.rewards(q)}`,
          foot: `<button class="lui-btn gold" data-act="complete" data-arg="${q.id}">Complete Quest</button><button class="lui-btn" data-act="back">Cancel</button>`,
          handlers,
        };
      }
      if (qa.offer.some((t) => t.id === questId)) {
        return {
          ...base,
          body: `<h2 class="q-title">${esc(q.name)}</h2><p class="q-story">${dropcap(q.intro)}</p><div class="h">Objectives</div>${this.objectives(q)}${this.rewards(q)}`,
          foot: `<button class="lui-btn gold" data-act="accept" data-arg="${q.id}">Accept</button><button class="lui-btn" data-act="back">Decline</button>`,
          handlers,
        };
      }
      return {
        ...base,
        body: `<h2 class="q-title">${esc(q.name)}</h2><p class="q-story">${dropcap(q.intro)}</p><div class="h">Objectives</div>${this.objectives(q, qp)}${this.rewards(q)}`,
        foot: `<button class="lui-btn" data-act="back">Back</button><button class="lui-btn" data-act="close">Goodbye</button>`,
        handlers,
      };
    }

    const quests = [
      ...qa.turnIn.map((q) => `<li data-act="quest" data-arg="${q.id}">${uiIcon('quest-done', 24)}<span>${esc(q.name)}</span><small>Complete</small></li>`),
      ...qa.offer.map((q) => `<li data-act="quest" data-arg="${q.id}">${uiIcon('quest-new', 24)}<span>${esc(q.name)}</span></li>`),
      ...active.map(
        (qp) =>
          `<li class="prog" data-act="quest" data-arg="${qp.id}">${uiIcon('quest-active', 24)}<span>${esc(questDef(qp.id).name)}</span><small>In Progress</small></li>`,
      ),
    ];
    const talkHtml = talk.map(([act, arg, html]) => `<li class="talk" data-act="${act}" data-arg="${arg}">${html}</li>`);
    return {
      ...base,
      body: `<p class="g-say">“${esc(GREETINGS[npcId] ?? 'Good day.')}”</p>${quests.length ? `<div class="h">Quests</div><ul class="g-opts">${quests.join('')}</ul>` : ''}${talkHtml.length ? `<div class="h">Talk</div><ul class="g-opts">${talkHtml.join('')}</ul>` : ''}`,
      foot: `<span></span><button class="lui-btn" data-act="close">Goodbye</button>`,
      handlers,
    };
  }

  private shopView(npcId: string, tab: ShopTab): View {
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
          return `<div class="m-item${can ? '' : ' cant'}" data-act="buy" data-arg="${o.item}" data-tip="item:${o.item}"${can ? '' : ' disabled'}><div class="ib">${iconHtml(it.icon, o.item)}</div><div><div class="nm">${esc(it.name)}</div><div class="pr">${money(o.price, 12)}${o.seals ? ` + ${o.seals} ${uiIcon('seal', 14)}` : ''}</div></div></div>`;
        })
        .join('');
    } else if (tab === 'sell') {
      const have = v.buys.filter((i) => life.count(i) > 0);
      grid = have
        .map((i) => {
          const it = itemDef(i);
          const price = Math.max(1, Math.round(it.value * v.buyRate));
          return `<div class="m-item" data-act="sell" data-arg="${i}" data-tip="item:${i}"><div class="ib">${iconHtml(it.icon, i)}<span class="n">${life.count(i)}</span></div><div><div class="nm">${esc(it.name)}</div><div class="pr">${money(price, 12)} Each</div></div></div>`;
        })
        .join('');
      if (!have.length) grid = `<div class="m-empty" style="grid-column:1/-1">Nothing ${esc(n.name.split(' ')[0])} wants in your bag.</div>`;
    } else {
      // What you sold here, held at what it fetched until you walk off (src/sim/life/trade.ts).
      const held = (s.buyback ?? []).filter((b) => b.npc === npcId);
      grid = held
        .map((b) => {
          const it = itemDef(b.item);
          const can = s.coins >= b.price;
          return `<div class="m-item${can ? '' : ' cant'}" data-act="buyback" data-arg="${b.item}" data-tip="item:${b.item}"${can ? '' : ' disabled'}><div class="ib">${iconHtml(it.icon, b.item)}<span class="n">${b.n}</span></div><div><div class="nm">${esc(it.name)}</div><div class="pr">${money(b.price, 12)} Each</div></div></div>`;
        })
        .join('');
      if (!held.length)
        grid = `<div class="m-empty" style="grid-column:1/-1">Nothing to buy back. ${esc(n.name.split(' ')[0])} holds what you sell here until you walk off.</div>`;
    }
    const how = {
      buy: 'Click to buy one, shift-click for five.',
      sell: 'Click to sell one, shift-click to sell them all.',
      buyback: 'Click to buy one back, shift-click for all of it.',
    }[tab];
    const buys = v.buys
      .map((id) => itemDef(id)?.name)
      .filter(Boolean)
      .join(', ');
    return {
      title: v.name,
      sub: esc(n.title),
      portrait: this.face(npcId),
      w: 440,
      h: 500,
      body: `<div class="m-tabs">${(['buy', 'sell', 'buyback'] as const).map((t) => `<span class="m-tab${tab === t ? ' on' : ''}" data-act="tab" data-arg="${t}">${{ buy: 'Buy', sell: 'Sell', buyback: 'Buyback' }[t]}</span>`).join('')}</div>
        <div class="m-grid${tab === 'sell' ? ' m-sell' : ''}">${grid}</div>
        <div class="m-buys"><b>${esc(n.name.split(' ')[0])} Buys:</b> ${esc(buys)}. ${how}</div>`,
      foot: `<span>${money(s.coins)}&nbsp; ${uiIcon('seal', 18)} <b>${s.seals}</b></span><span style="display:flex;gap:12px"><button class="lui-btn small" data-act="sellall">Sell All Produce</button><button class="lui-btn small" data-act="back">Back</button></span>`,
      handlers: {
        tab: (t) => this.open({ kind: 'shop', id: npcId, tab: t as ShopTab }),
        buy: (item, e) => life.command({ t: 'buy', npc: npcId, item, n: e?.shiftKey && itemDef(item).stack > 1 ? 5 : 1 }),
        sell: (item, e) => life.command({ t: 'sell', npc: npcId, item, n: e?.shiftKey ? 9999 : 1 }),
        buyback: (item, e) => life.command({ t: 'buyback', npc: npcId, item, n: e?.shiftKey ? 9999 : 1 }),
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
    const title = bench ? ((bench as { name?: string }).name ?? 'Workbench') : `${npc?.name ?? ''}'s Workshop`;
    const rows = recipes
      .map((r) => {
        const pack = r.makes.pack ? packDef(r.makes.pack) : null;
        const item = r.makes.item ? itemDef(r.makes.item) : null;
        const inputs = pack ? pack.inputs : (r.inputs ?? []);
        const coins = pack ? pack.fee : (r.coins ?? 0);
        const labor = pack ? pack.labor : (r.labor ?? 0);
        const have = inputs.every((i) => life.count(i.item) >= i.n) && life.state.coins >= coins && life.state.labor >= labor;
        const need = inputs
          .map((i) => `<span class="${life.count(i.item) >= i.n ? 'have' : 'lack'}">${life.count(i.item)}/${i.n} ${esc(itemDef(i.item).name)}</span>`)
          .join(' · ');
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
        const icon = pack ? iconHtml(pack.icon) : item ? iconHtml(item.icon, r.makes.item) : uiIcon('craft', 32);
        // Short of a raw material: where it comes from (its description says).
        const short = inputs.find((i) => life.count(i.item) < i.n && itemDef(i.item).cat === 'material');
        const desc = (item?.desc ? `<small>${esc(item.desc)}</small>` : '') + (short ? `<small>${esc(itemDef(short.item).desc)}</small>` : '');
        const tip = item ? ` data-tip="item:${r.makes.item}"` : pack ? ` data-tip="pack:${pack.id}"` : '';
        return `<div class="lui-row"${tip}><div class="ib">${icon}</div><div class="body"><b>${esc(name)}</b><small>${need}${coins ? ` · ${money(coins, 11)}` : ''}${labor ? ` · ${labor} Labor` : ''}</small>${sells}${desc}</div><button class="lui-btn small ${have ? 'gold' : ''}" data-act="make" data-arg="${r.id}" ${have ? '' : 'disabled'}>${pack ? 'Pack It' : 'Make'}</button></div>`;
      })
      .join('');
    const backLine = this.d.sim.player.pack ? '<p style="color:var(--bad)">Your back is full: set your pack down (X) before packing another.</p>' : '';
    return {
      title,
      sub: npc ? esc(npc.title) : '',
      portrait: npc ? this.face(benchOrNpc) : uiIcon('craft'),
      w: 520,
      h: 520,
      body: backLine + `<div class="lui-list">${rows}</div>`,
      foot: `<span>${money(life.state.coins)}&nbsp; ${uiIcon('labor', 18)} <b>${Math.floor(life.state.labor)}</b> Labor</span><button class="lui-btn" data-act="close">Close</button>`,
      handlers: {
        make: (id) => {
          life.command({ t: 'craft', recipe: id });
          if (recipeDef(id)?.makes.pack) setTimeout(() => this.finish(), 60);
        },
      },
    };
  }

  private storageView(houseId: number): View {
    const life = this.life;
    const h = life.state.houses.find((x) => x.id === houseId);
    if (!h || !isComplete(h)) return { title: 'Storage Chest', w: 420, body: '<p>Gone.</p>' };
    const bp = blueprintDef(h.blueprint);
    const list = (stacks: Array<{ item: string; n: number }>, act: string) =>
      stacks
        .map(
          (st) =>
            `<div class="lui-row" data-tip="item:${st.item}"><div class="ib">${iconHtml(itemDef(st.item).icon, st.item)}<span class="n">${st.n}</span></div><div class="body"><b>${esc(itemDef(st.item).name)}</b></div><button class="lui-btn small" data-act="${act}" data-arg="${st.item}">${act === 'store' ? 'Store' : 'Take'}</button></div>`,
        )
        .join('') || '<p class="muted">Empty</p>';
    return {
      title: 'Storage Chest',
      sub: `${h.storage.length}/${bp.perks.storageSlots} Kinds Stored`,
      w: 620,
      h: 520,
      body: `<div class="lui-cols"><div><div class="h">Your Bag</div><div class="lui-list">${list(life.state.bag, 'store')}</div></div><div><div class="h">Chest</div><div class="lui-list">${list(h.storage, 'take')}</div></div></div>`,
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
      cells.push(
        `<div class="ib sm${this.sel === i ? ' sel' : ''}" data-act="sel" data-arg="${i}" data-tip="item:${st.item}">${iconHtml(def.icon, st.item)}${st.n > 1 ? `<span class="n">${st.n}</span>` : ''}</div>`,
      );
    }
    const pk = carried(life, this.d.sim);
    this.bagEl.style.width = '452px';
    this.bagEl.innerHTML =
      `<div class="mw-bar">Bag <small>${s.bag.length} / ${BAG_SLOTS}</small></div><div class="mw-x" data-act="close" title="Close (I)">✕</div>` +
      `<div class="mw-body" style="overflow:hidden"><div class="bag-grid">${cells.join('')}</div>${pk ? `<div class="note" style="margin-top:8px">On Your Back: ${withIcons(`${packDef(pk.def).icon} ${packDef(pk.def).name}`, 14)}</div>` : ''}</div>` +
      `<div class="mw-foot"><span>${money(s.coins)}&nbsp; ${uiIcon('seal', 18)} <b>${s.seals}</b></span><span>${uiIcon('labor', 18)} <b>${Math.floor(s.labor)}</b> Labor</span></div>`;
    this.bagHandlers = {
      // A click picks an item out; a double-click does its main thing (right-click: everything else).
      sel: (i, e) => {
        if (e?.detail === 2) return this.itemPrimary(Number(i));
        this.sel = Number(i);
        for (const c of this.bagEl.querySelectorAll('.bag-grid [data-act="sel"]')) c.classList.toggle('sel', c.getAttribute('data-arg') === i);
      },
    };
  }

  /**
   * What can be done with the item in bag slot `i` right now, its main action first: using it
   * (placing a scarecrow, equipping a glider...), or selling or storing it while a merchant's or
   * your chest's window is open, which then comes first.
   */
  private itemActions(i: number): MenuEntry[] {
    const life = this.life;
    const s = life.state;
    const st = s.bag[i];
    if (!st) return [];
    const item = st.item;
    const def = itemDef(item);
    const out: MenuEntry[] = [];
    const use = (label: string): MenuEntry => ({ label, run: () => this.useItem(item) });
    if (def.cat === 'seed') out.push(s.seed === item ? { label: 'Planting This', disabled: 'F plants this seed already' } : use('Plant This'));
    else if (def.cat === 'placeable') out.push(use('Place'));
    else if (def.cat === 'glider') out.push(s.glider === def.glider ? { label: 'Equipped', disabled: 'This is the glider you fly' } : use('Equip'));
    else if (def.cat === 'deed') out.push(use('Summon'));
    else if (def.cat === 'mount') out.push(use('Call'));
    else if (def.cat === 'consumable') out.push(use('Use'));
    const p = this.panel;
    const trade: MenuEntry[] = [];
    if (p?.kind === 'shop') {
      const v = vendorFor(p.id);
      const who = life.zone.recipe.npcs.find((n) => n.id === p.id)?.name.split(' ')[0] ?? 'They';
      if (v?.buys.includes(item)) {
        trade.push({ label: 'Sell One', run: () => life.command({ t: 'sell', npc: p.id, item, n: 1 }) });
        if (st.n > 1) trade.push({ label: 'Sell All', run: () => life.command({ t: 'sell', npc: p.id, item, n: 9999 }) });
      } else trade.push({ label: 'Sell', disabled: `${who} doesn't buy this` });
    } else if (p?.kind === 'storage') {
      trade.push({ label: 'Store in Chest', run: () => life.command({ t: 'store', house: Number(p.id), item, n: life.count(item) }) });
    } else if (def.cat === 'produce' || def.cat === 'material') {
      out.push({ label: 'Sell', disabled: 'Talk to a merchant who buys it' });
    }
    // At a merchant or your chest, that comes first: a double-click sells or stores.
    const all = trade.some((e) => !e.disabled) ? [...trade, ...out] : [...out, ...trade];
    const first = all.find((e) => !e.disabled);
    return all.map((e) => ({ ...e, primary: e === first }));
  }

  /** A double-click (or A on a controller): the item's main action. */
  private itemPrimary(i: number): void {
    this.itemActions(i)
      .find((e) => e.primary)
      ?.run?.();
  }

  /** The right-click menu for bag slot `i`, at a point on screen. */
  private itemMenu(i: number, x: number, y: number): void {
    const st = this.life.state.bag[i];
    if (!st) return;
    this.sel = i;
    for (const c of this.bagEl.querySelectorAll('.bag-grid [data-act="sel"]')) c.classList.toggle('sel', c.getAttribute('data-arg') === String(i));
    openMenu(x, y, st.n > 1 ? `${itemDef(st.item).name} ×${st.n}` : itemDef(st.item).name, this.itemActions(i));
  }

  private useItem(item: string): void {
    this.life.command({ t: 'use', item });
    const cat = itemDef(item).cat;
    // Out of the way of the world: you walk off to place it, or get on what you called.
    if (cat === 'deed' || cat === 'placeable' || cat === 'mount') this.finish(true);
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
        const where = out
          ? `${Math.round(Math.hypot(out.x - p.pos.x, out.z - p.pos.z))} m Away${out.cargo.some(Boolean) ? ` · ${out.cargo.filter(Boolean).length} Packs Aboard` : ''}`
          : 'Stabled';
        const stats = isMount(r)
          ? `${r.runSpeed} m/s · ${r.canCarryPack ? 'Carries a Pack' : 'No Packs'}`
          : `${r.maxSpeed} m/s · ${r.cargo.length} Pack Slots · ${r.seats.length} Seats`;
        return `<div class="lui-row" data-tip="item:${s.item}"><div class="ib">${iconHtml(r.icon)}</div><div class="body"><b>${esc(r.name)}</b><small>${stats}</small><small>${where}</small></div>${isMount(r) ? `<button class="lui-btn small gold" data-act="mount">Call (R)</button>` : `<button class="lui-btn small gold" data-act="summon" data-arg="${s.item}">${out ? 'Bring Here' : 'Summon'}</button>`}${out && !isMount(r) ? `<button class="lui-btn small" data-act="recall" data-arg="${out.id}">Send Home</button>` : ''}</div>`;
      })
      .join('');
    return {
      title: 'Vehicles & Mounts',
      sub: 'Boats appear at the nearest deep water',
      portrait: uiIcon('wheel'),
      w: 480,
      h: 430,
      body: `<div class="lui-list">${rows || '<p>You own no vehicles yet. Bertram (carts and cars), Captain Ilsa (boats) and Sela (mounts) are in Lanternwick.</p>'}</div>`,
      handlers: {
        summon: (item) => {
          life.command({ t: 'summon', item });
          this.finish();
        },
        recall: (id) => life.command({ t: 'recall', vehicle: Number(id) }),
        mount: () => {
          life.command({ t: 'mount' });
          this.finish();
        },
      },
    };
  }

  private logView(): View {
    const life = this.life;
    const all = life.state.quests.active;
    const active = all.filter((qp) => !questDef(qp.id).milestone);
    const milestones = all.filter((qp) => questDef(qp.id).milestone);
    if (!this.logSel || !all.some((q) => q.id === this.logSel)) this.logSel = active[0]?.id ?? milestones[0]?.id ?? '';
    const row = (qp: { id: string }) =>
      `<div class="ql-q${qp.id === this.logSel ? ' sel' : ''}${isReady(life, qp.id) ? ' ready' : ''}" data-act="logsel" data-arg="${qp.id}"><i class="dot"></i>${esc(questDef(qp.id).name)}</div>`;
    const done = life.state.quests.done;
    const list =
      `<div class="ql-zone"><span>${esc(life.zone.recipe.name)}</span><span>${active.length}</span></div>` +
      active.map(row).join('') +
      (milestones.length
        ? `<div class="ql-zone" style="margin-top:14px"><span>Milestones</span><span>${milestones.length}</span></div>` + milestones.map(row).join('')
        : '') +
      `<div class="ql-zone" style="margin-top:14px"><span>Completed</span><span>${done.length}</span></div>` +
      done
        .map(
          (id) =>
            `<div class="ql-q done"><i class="dot done"></i>${esc(questDef(id).name)}<small>✓ ${questDef(id).milestone ? 'Milestone' : 'Done'}</small></div>`,
        )
        .join('');
    let page = '<p class="muted">No quests under way. Look for people with a gold mark over their heads.</p>';
    const qp = all.find((x) => x.id === this.logSel);
    if (qp) {
      const q = questDef(qp.id);
      const who = life.zone.recipe.npcs.find((n) => n.id === (q.turnIn ?? q.giver))?.name ?? '';
      const kind = q.milestone ? '<div class="sd-type">Milestone · done the moment you get there</div>' : '';
      page = `<h2 class="q-title">${esc(q.name)}</h2>${kind}<p class="q-story">${dropcap(q.intro)}</p><div class="h">Objectives</div>${this.objectives(q, qp)}${isReady(life, q.id) ? `<p style="margin-top:6px;color:var(--good);font-weight:700">Ready: return to ${esc(who)}.</p>` : ''}${this.rewards(q)}`;
    }
    const quests = QUESTS.filter((q) => !q.milestone);
    const doneQuests = done.filter((id) => !questDef(id).milestone).length;
    // A quest under way can come off the tracker, and be given up (asked once more first); a
    // milestone can't be either, and the quests that start by themselves can't be given up.
    let foot: string | undefined;
    const sel = qp ? questDef(qp.id) : null;
    if (sel && !sel.milestone) {
      const tracked = !this.untracked().has(sel.id);
      const track = `<button class="lui-btn gold small" data-act="track" data-arg="${sel.id}">${tracked ? 'Untrack' : 'Track on Screen'}</button>`;
      const give = sel.auto
        ? '<span></span>'
        : this.abandonAsk === sel.id
          ? `<span style="display:flex;gap:10px;align-items:center"><span class="muted">Give it up?</span><button class="lui-btn small" data-act="abandon" data-arg="${sel.id}">Abandon</button><button class="lui-btn small" data-act="keep">Keep</button></span>`
          : `<button class="lui-btn small" data-act="ask" data-arg="${sel.id}">Abandon</button>`;
      foot = give + track;
    }
    return {
      title: 'Quest Log',
      sub: `${doneQuests} of ${quests.length} Quests · ${done.length - doneQuests} of ${QUESTS.length - quests.length} Milestones`,
      portrait: uiIcon('scroll'),
      w: 700,
      h: 520,
      body: `<div class="ql"><div class="ql-list">${list}</div><div>${page}</div></div>`,
      foot,
      handlers: {
        logsel: (id) => {
          this.logSel = id;
          this.abandonAsk = '';
          this.renderPanel(false);
        },
        ask: (id) => {
          this.abandonAsk = id;
          this.renderPanel(false);
        },
        keep: () => {
          this.abandonAsk = '';
          this.renderPanel(false);
        },
        abandon: (id) => {
          this.abandonAsk = '';
          this.life.command({ t: 'abandon', quest: id });
          this.renderPanel(false);
        },
        track: (id) => {
          this.setTracked(id, this.untracked().has(id));
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
          <div class="ch-weap">${slot('Main Hand', `<div class="ib big">${iconHtml(WEAPON_ICONS[weapon] ?? '🗡️', undefined, 48)}</div>`, '🗡️', `weapon:${weapon}`)}${slot('Off Hand', null, '🛡️', 'slot:Off Hand')}${slot('Tool', null, '🔨', 'slot:Tool')}</div></div>
        <div class="ch-col">${slot('Legs', null, '👖', 'slot:Legs')}${slot('Feet', null, '🥾', 'slot:Feet')}${slot('Mount', mount ? item(mount) : null, '🐎', mount ? `item:${mount}` : 'slot:Mount')}${slot('Pack', back ? `<div class="ib big">${iconHtml(packDef(back.def).icon, undefined, 48)}</div>` : null, '📦', back ? `pack:${back.def}` : 'slot:Pack')}</div>
        <div class="ch-stats"><h4>${esc(this.playerName)}</h4>
          ${this.maxHp ? `<div class="r"><span>Health</span><b>${Math.round(this.hp)} / ${this.maxHp}</b></div>` : ''}
          ${this.vit ? `<div class="r"><span>MP</span><b data-vital="mp">${Math.floor(this.vit.mp)} / ${this.vit.maxMp}</b></div>` : ''}
          ${this.vit ? `<div class="r"><span>Stamina</span><b data-vital="stamina">${Math.floor(this.vit.stamina)} / ${this.vit.maxStamina}</b></div>` : ''}
          <div class="r"><span>Labor</span><b>${Math.floor(life.state.labor)} / ${LABOR.max}</b></div>
          <div class="r"><span>Weapon</span><b>${esc(WEAPON_NAMES[weapon] ?? '')}</b></div>
          <div class="r"><span>Combo Damage</span><b>${comboDamage(weapon, this.d.sim.stats)}</b></div>
          <div class="r"><span>Skill Points</span><b>${pointsLeft(p.skills, skillBudget(life.state))} Left</b></div>
          <div class="r"><span>Glider</span><b>${life.state.glider ? esc(gliderDef(life.state.glider).name) : 'None'}</b></div>
          <div class="r"><span>Money</span>${money(life.state.coins, 12)}</div>
          <div class="r"><span>Seals</span><b>${life.state.seals}</b></div>
          <div class="note">Head, chest, hands, legs, feet, off hand and tool are slots for armour and tools still to come.</div></div>
      </div>`,
    };
  }

  private settingsView(): View {
    const v = Math.round(userScale() * 100);
    // Online: back to the character select screen (the server keeps the island).
    const exit = this.onExitToSelect
      ? `<div class="h">Character</div><p class="note">Play someone else: your island is saved on the server as you go.</p><button class="lui-btn" data-act="exitToSelect">Exit to Character Select</button>`
      : '';
    return {
      title: 'Settings',
      portrait: uiIcon('gear'),
      w: 420,
      h: exit ? 430 : 330,
      body: `<div class="h">Interface</div><div class="set-row"><span>UI Size</span><input type="range" min="${UI_SCALE_MIN * 100}" max="${UI_SCALE_MAX * 100}" step="5" value="${v}" data-set="uiScale"><b>${v}%</b></div><p class="note">The UI keeps its size relative to the window; this makes it bigger or smaller on top of that.</p>${exit}<div class="h">Credits</div><p class="note">Type: TeX Gyre Pagella (GUST Font License) and Alegreya SC (SIL Open Font License). Ground and grain textures from ambientCG and Poly Haven, CC0.</p>`,
      foot: `<button class="lui-btn small" data-act="resetScale">Reset</button><button class="lui-btn" data-act="close">Done</button>`,
      handlers: {
        resetScale: () => {
          setUserScale(1);
          this.renderPanel(false);
        },
        exitToSelect: () => this.onExitToSelect?.(),
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
      // What it is, above the ring.
      g.font = 'bold 12px "Ruina Serif", Georgia, serif';
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(43,26,14,0.8)';
      g.strokeText(goal.label, px, py - 16);
      g.fillStyle = '#ffd166';
      g.fillText(goal.label, px, py - 16);
    }
    this.travel?.draw(g, toPx, 1.8);
    const p = this.d.sim.player;
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

  /** The Admin window, for admins only: Developer Tools, then every developer zone and page. */
  private adminView(): View {
    return {
      title: 'Admin',
      sub: 'For admins only. The zones and pages open in a new tab.',
      w: 600,
      h: 640,
      body:
        '<div class="lui-admin"><div class="h">In the World</div><div class="adm-row"><button class="lui-btn small" data-act="devtools">Developer Tools</button>' +
        `<span class="adm-about">Gifts, island time, teleports, starting the island over and bug reports. <b>\`</b> opens it too.</span></div>${adminListHtml()}</div>`,
      handlers: {
        devtools: () => this.open({ kind: 'dev' }),
        devpage: (id) => openDevPage(id),
      },
    };
  }

  private devView(): View {
    const life = this.life;
    // The dungeons' doors too (they're no place on the map: the way in is a secret).
    const doors = (life.zone.recipe.dungeons ?? []).map(
      (d) => `<button class="lui-btn small" data-act="tp" data-arg="door:${d.id}">${esc(dungeonDef(d.id)?.name ?? d.id)} Door</button>`,
    );
    const places =
      life.zone.recipe.places.map((pl) => `<button class="lui-btn small" data-act="tp" data-arg="${pl.id}">${esc(pl.name)}</button>`).join('') + doors.join('');
    return {
      title: 'Developer Tools',
      sub: 'For trying things out quickly. ` toggles this window.',
      w: 560,
      h: 600,
      body: `<div class="lui-dev"><div class="h">Give</div>
      <button class="lui-btn small" data-act="grant" data-arg="coins">+1 Gold</button>
      <button class="lui-btn small" data-act="grant" data-arg="seals">+10 Seals</button>
      <button class="lui-btn small" data-act="grant" data-arg="labor">+500 Labor</button>
      <button class="lui-btn small" data-act="grant" data-arg="seeds">Seeds, Saplings & Young Animals</button>
      <button class="lui-btn small" data-act="grant" data-arg="produce">Produce for Packs</button>
      <button class="lui-btn small" data-act="grant" data-arg="mats">Building Materials</button>
      <button class="lui-btn small" data-act="grant" data-arg="rides">Every Vehicle, Mount & Glider</button>
      <button class="lui-btn small" data-act="grant" data-arg="house">Cottage Blueprint, Cog Design, Scarecrows</button>
      <div class="h">Island Time</div>
      <button class="lui-btn small" data-act="warp" data-arg="60">+1 Minute</button>
      <button class="lui-btn small" data-act="warp" data-arg="600">+10 Minutes</button>
      <button class="lui-btn small" data-act="warp" data-arg="3600">+1 Hour</button>
      <div class="note">Skips ahead on your island: crops grow, and labor and prices recover. ${this.skyHour ? "The sky and the weather keep the world's time, the same for everyone." : 'The sky and the weather move on with it.'}</div>
      <div class="h">Teleport</div>${places}
      <div class="h">Save</div><button class="lui-btn small" data-act="reset">Start Emberholm Over</button>
      ${this.onBugReport ? `<div class="h">Bug Report</div><button class="lui-btn small" data-act="bug">Record a Bug Report</button><div class="note">Or press <b>${esc(this.bugKey())}</b> any time (click both sticks on a controller). It keeps the last 30 seconds of play, then records your voice and the screen until you press it again.</div>` : ''}</div>`,
      handlers: {
        grant: (what) => {
          const g = (item: string, n = 1) => life.command({ t: 'grant', item, n });
          if (what === 'coins') life.command({ t: 'grant', coins: 10000 });
          if (what === 'seals') life.command({ t: 'grant', seals: 10 });
          if (what === 'labor') life.command({ t: 'grant', labor: 500 });
          if (what === 'seeds')
            ['seed.sunroot', 'seed.barley', 'seed.flax', 'seed.emberberry'].forEach((s) => g(s, 20)),
              g('sapling.apple', 4),
              g('sapling.pine', 4),
              g('animal.chick', 3),
              g('animal.lamb', 2),
              g('animal.calf', 2);
          if (what === 'produce')
            g('sunroot', 30), g('barley', 40), g('flax', 16), g('emberberry', 16), g('apple', 16), g('egg', 8), g('milk', 6), g('wool', 16);
          if (what === 'mats') g('lumber', 120), g('stone', 40), g('ironOre', 30), g('flax', 30);
          if (what === 'rides')
            [
              'deed.farmCart',
              'deed.roadster',
              'deed.hauler',
              'deed.rowboat',
              'deed.sloop',
              'deed.cog',
              'whistle.donkey',
              'whistle.horse',
              'glider.wayfarer',
              'glider.swiftwing',
            ].forEach((i) => life.count(i) || g(i));
          if (what === 'house') g('blueprint.cottage'), g('scarecrow', 2), g('design.cog');
          if (what === 'rides' && !life.state.glider) life.command({ t: 'use', item: 'glider.wayfarer' });
        },
        warp: (s) => life.command({ t: 'warp', seconds: Number(s) }),
        tp: (id) => {
          const door = id.startsWith('door:') ? life.zone.recipe.dungeons?.find((d) => d.id === id.slice(5)) : undefined;
          if (door) this.onTeleport?.(door.outside.x, door.outside.z, door.outside.facing + Math.PI);
          else {
            const pl = life.zone.recipe.places.find((x) => x.id === id)!;
            this.onTeleport?.(pl.x, pl.z);
          }
          this.finish();
        },
        reset: () => this.onReset?.(),
        bug: () => {
          // Close first, so the report's screenshot shows the game rather than this window. The
          // mouse stays free: the bug reporter may ask for a microphone, or for the bug in writing.
          this.closeAll();
          this.onBugReport?.();
        },
      },
    };
  }

  /** Set by the app: move the player somewhere (dev panel). */
  onTeleport: ((x: number, z: number, facing?: number) => void) | null = null;
  onReset: (() => void) | null = null;
  /** Set by the app online: leave the world for the character select screen (Settings offers it). */
  onExitToSelect: (() => void) | null = null;
  /** Whether the developer panel and the Admin window open: online, for admins only (the server says, in its welcome); offline, always. */
  devTools = true;
  /**
   * Set by the app online: the hour of the day the sky shows, from the server's clock, the same for
   * everyone. Offline the island's own clock tells the hour.
   */
  skyHour: (() => number) | null = null;
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
    return stillNeeds(h)
      .map((n) => `${packDef(n.pack).name} ${n.have}/${n.need}`)
      .join(', ');
  }
}

/** A painted icon centred on a map, with a shadow to stand off the ground (nothing until it has loaded). */
function mapIcon(g: CanvasRenderingContext2D, img: HTMLImageElement | null, x: number, y: number, size: number): void {
  if (!img) return;
  g.save();
  g.shadowColor = 'rgba(20, 10, 4, 0.7)';
  g.shadowBlur = size * 0.18;
  g.shadowOffsetY = size * 0.06;
  g.drawImage(img, x - size / 2, y - size / 2, size, size);
  g.restore();
}

/**
 * A quest marker on a map: the mark over people's heads (! for a quest on offer, ? for one to hand
 * in) on a dark disc with a brass rim, to stand out from the ground. `r` is its radius in the canvas's pixels.
 */
function questMark(g: CanvasRenderingContext2D, x: number, y: number, ready: boolean, r: number): void {
  g.save();
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  const fill = g.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
  fill.addColorStop(0, '#7a4a2a');
  fill.addColorStop(1, '#2b1a0e');
  g.fillStyle = fill;
  g.shadowColor = 'rgba(20, 10, 4, 0.6)';
  g.shadowBlur = r * 0.5;
  g.shadowOffsetY = r * 0.1;
  g.fill();
  g.shadowColor = 'transparent';
  g.lineWidth = Math.max(1.5, r * 0.16);
  g.strokeStyle = '#e0a84a';
  g.stroke();
  const img = uiImage(ready ? 'quest-done' : 'quest-new');
  if (img) g.drawImage(img, x - r * 0.95, y - r * 0.95, r * 1.9, r * 1.9);
  g.restore();
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
        col = [base[0] * shade * lift, base[1] * shade * lift, base[2] * shade * lift].map((v) => Math.max(0, Math.min(255, Math.round(v)))) as [
          number,
          number,
          number,
        ];
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
