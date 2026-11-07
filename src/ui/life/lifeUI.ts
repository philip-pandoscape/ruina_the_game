import type * as THREE from 'three';
import type { AutoWalk } from '../../input/autoWalk';
import { packDef } from '../../content/trade';
import type { Vitals } from '../hud';
import { housePose, stillNeeds, type Command, type IslandView, type LifeEvent } from '../../engine/island';
import type { SimView, World } from '../../engine/rules';
import type { WorldLayout } from '../../engine/zone';
import { DockedWindow, type View } from '../components/window';
import { closeMenu, menuPress } from '../theme/contextMenu';
import { uiRoot } from '../theme/scale';
import { addTipSource, wireTips } from '../theme/tooltip';
import type { IslandUI, Panel } from './context';
import { Banner, Prompt } from './hud/banner';
import { ClockHud } from './hud/clock';
import { Compass } from './hud/compass';
import { type Goal, questGoal } from './hud/goal';
import { MenuBar } from './hud/menu';
import { Minimap } from './hud/minimap';
import { Hints, Plates } from './hud/plates';
import { PortraitHud } from './hud/portrait';
import { QuestTracker, Untracked } from './hud/quests';
import { RideBox } from './hud/ride';
import { Toasts } from './hud/toasts';
import { WorldPictures } from './map';
import { islandTip } from './tips';
import { TravelUI } from './travelUI';
import { adminView } from './windows/admin';
import { BagWindow } from './windows/bag';
import { characterView, tickVitals } from './windows/character';
import { craftView } from './windows/craft';
import { devView } from './windows/dev';
import { dialogView } from './windows/dialog';
import { MapWindow } from './windows/map';
import { QuestLog } from './windows/questLog';
import { ridesView } from './windows/rides';
import { onSettingsInput, settingsView } from './windows/settings';
import { shopView } from './windows/shop';
import { storageView } from './windows/storage';

// The open world's HUD and windows. Everything here only reads the life state and queues commands;
// nothing in the UI changes the world directly. Windows dock at the side and leave the world
// running (the map is the one that takes over), the bag docks on the right, and the person you talk
// to looks out of the corner of the window.
//
// LifeUI holds it together: the HUD's widgets (hud/), a module for each window (windows/) drawn in
// the frames of src/ui/components/, which window is open, the keys and the controller, and the
// hooks the app sets. The widgets and windows see it through an IslandUI (context.ts).

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
  life: IslandView;
  /** Gives the island a command (the app notes it for bug reports and passes it to the rules). */
  command: (c: Command) => void;
  sim: SimView;
  world: World;
  camera: () => THREE.Camera;
  yaw: () => number;
  device: () => 'keyboard' | 'gamepad';
  /** Auto-run and travel by road (src/input/autoWalk.ts), shown on the map and under the compass. */
  walk?: AutoWalk;
  /** Where the world's regions stand, for the maps (null: the region you're in alone). */
  layout?: WorldLayout | null;
}

/**
 * Whether the window open (`LifeUI.openPanel`) docks on the left, where the party frame and a
 * mini-game's window go: every one of them but the bag.
 */
export const docksLeft = (open: string | null): boolean => open !== null && open !== 'bag';

/** How far you can walk from whoever you're dealing with before their window closes. */
const WALK_AWAY = 9;

/** Whoever looks out of a window's medallion: their portrait (`url`), else their face as an emoji (an NPC's `portrait`). */
const faceHtml = (url: string | null, emoji = '🙂'): string => (url ? `<img src="${url}" alt="">` : `<span class="emoji">${emoji}</span>`);

export class LifeUI {
  /** What the widgets and windows see of this. */
  private ui: IslandUI;
  /** The world's regions as the maps draw them: each region's picture is handed over as the page's worker grows it (src/app/regions.ts). */
  readonly pictures: WorldPictures;
  // HUD
  private portrait: PortraitHud;
  private minimap: Minimap;
  private clock: ClockHud;
  private compass: Compass;
  private banner: Banner;
  private toasts = new Toasts();
  private prompt: Prompt;
  private quests: QuestTracker;
  private rideBox: RideBox;
  private menuBar = new MenuBar((k) => this.press(k as LifePress));
  private plates: Plates;
  private hints: Hints;
  // Windows: the main one docks left (the map takes the centre), the bag docks right.
  private card = new DockedWindow('lui-card', 'left', () => this.close());
  private bag: BagWindow;
  private map: MapWindow;
  private questLog: QuestLog;
  private panel: Panel | null = null;
  private bagOpen = false;
  /**
   * Whether the mouse was steering the camera when the open windows took it (a window frees the
   * pointer as it opens). A window that closes itself after something clicked in it gives it back.
   */
  private hadMouse = false;
  private panelSig = '';
  private bagSig = '';
  private frameNo = 0;
  /** Which button a controller (or the arrow keys) has highlighted in the open window, -1 for none. */
  private menuFocus = -1;
  /** Health, MP and stamina, as the app last said (setVitals). */
  private vit: Vitals | null = null;
  /** Travel by road on the map, and the auto-walk readout (src/ui/life/travelUI.ts). */
  private travel: TravelUI | null = null;

  constructor(private d: LifeUIDeps) {
    const root = uiRoot();
    this.ui = {
      life: d.life,
      command: (c) => this.command(c),
      sim: d.sim,
      world: d.world,
      app: this,
      camera: () => d.camera(),
      yaw: () => d.yaw(),
      device: () => d.device(),
      travel: () => this.travel,
      panel: () => this.panel,
      modal: () => this.modal,
      talkingTo: () => this.talkingTo,
      vitals: () => this.vit,
      goal: () => this.goal(),
      open: (p) => this.open(p),
      redraw: () => this.renderPanel(false),
      finish: (all) => this.finish(all),
      closeAll: () => this.closeAll(),
      face: (id) => faceHtml(this.portraitOf(id), d.life.zone.recipe.npcs.find((n) => n.id === id)?.portrait),
    };
    const untracked = new Untracked(() => this.playerName);
    this.pictures = new WorldPictures(d.world, d.layout ?? null);
    const picture = this.pictures;
    this.portrait = new PortraitHud(this.ui);
    this.minimap = new Minimap(this.ui, picture);
    const pictures = this.pictures;
    this.clock = new ClockHud(this.ui, () => pictures.at(d.sim.player.pos.x, d.sim.player.pos.z).climate);
    this.compass = new Compass(this.ui);
    this.banner = new Banner(this.ui, () => pictures.places());
    this.prompt = new Prompt(this.ui);
    this.quests = new QuestTracker(this.ui, untracked);
    this.rideBox = new RideBox(this.ui);
    this.plates = new Plates(this.ui);
    this.hints = new Hints(this.ui);
    this.bag = new BagWindow(this.ui, () => this.closeBag());
    this.map = new MapWindow(this.ui, picture);
    this.questLog = new QuestLog(this.ui, untracked);
    for (const w of [this.card.el, this.bag.el]) w.addEventListener('input', onSettingsInput);
    for (const e of [
      this.portrait.portrait,
      this.portrait.vitals,
      this.minimap.el,
      this.clock.el,
      this.compass.el,
      this.banner.el,
      this.toasts.el,
      this.prompt.el,
      this.quests.el,
      this.rideBox.el,
      this.menuBar.el,
      this.card.el,
      this.bag.el,
    ])
      root.appendChild(e);
    wireTips();
    addTipSource((tip) => islandTip(this.ui, tip));
    if (d.walk) {
      const player = (): [number, number] => [d.sim.player.pos.x, d.sim.player.pos.z];
      this.travel = new TravelUI({
        walk: d.walk,
        world: d.world,
        frame: () => ({ ...this.map.frame(), world: this.map.world }),
        places: () => this.life.zone.recipe.places,
        player,
        device: d.device,
        toast: (t, k) => this.toast(t, k),
      });
      this.travel.attachMap(this.map.canvas);
    }
  }

  /**
   * Adds a button to the menu at the bottom right, before Settings (the Party window, online): it
   * presses `press` as its key does.
   */
  addMenuButton(press: LifePress, icon: string, label: string, key: string): void {
    this.menuBar.add(press, icon, label, key);
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

  get life(): IslandView {
    return this.d.life;
  }

  /** Gives the island a command: the app passes it on to the rules (online, to the server too). */
  command(c: Command): void {
    this.d.command(c);
  }

  /** Your health, MP and stamina, for the vitals beside your portrait and the character window. */
  setVitals(v: Vitals): void {
    this.vit = v;
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
      if (life.placing) return this.command({ t: 'cancelPlace' });
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
        if (p.mode === 'ride') this.command({ t: 'exit' });
        else if (p.mode === 'glide') this.command({ t: 'gust' });
        // Someone else's vehicle isn't on your island: say whose, and the channel seats you.
        else if (f?.action === 'ride' && f.host && f.vehicle) this.command({ t: 'ride', host: f.host, vehicle: f.vehicle });
        else this.command({ t: 'interact' });
        return;
      }
      case 'drop':
        return this.command({ t: 'drop' });
      case 'mount':
        return this.command({ t: 'mount' });
      case 'glider':
        return this.command({ t: 'glider' });
      case 'seed':
        return this.command({ t: 'cycleSeed' });
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
    const buttons = this.focused().focusables();
    if (!buttons.length) return true;
    if (m === 'up' || m === 'left') this.menuFocus = this.menuFocus <= 0 ? buttons.length - 1 : this.menuFocus - 1;
    else if (m === 'down' || m === 'right') this.menuFocus = (this.menuFocus + 1) % buttons.length;
    else if ((m === 'select' || m === 'reset') && this.menuFocus >= 0) {
      const b = buttons[Math.min(this.menuFocus, buttons.length - 1)];
      // An item in the bag: A does its main thing, as a double-click would, and Y opens its menu.
      if (b.dataset.act === 'sel' && this.bag.el.contains(b)) {
        if (m === 'select') this.bag.primary(Number(b.dataset.arg));
        else {
          const r = b.getBoundingClientRect();
          this.bag.menu(Number(b.dataset.arg), r.right, r.top);
        }
      } else if (m === 'select') b.click();
      return true;
    }
    this.showMenuFocus();
    return true;
  }

  /** The window the controller's highlight moves in: the main one, else the bag. */
  private focused(): DockedWindow {
    return this.panel ? this.card : this.bag.win;
  }

  private showMenuFocus(): void {
    this.focused().highlight(this.menuFocus);
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
    this.card.show();
    this.freeMouse();
    this.renderPanel(!same);
  }

  close(): void {
    const wasShop = this.panel?.kind === 'shop';
    this.panel = null;
    this.card.hide();
    if (wasShop) this.closeBag();
    if (!this.bagOpen) this.hadMouse = false;
  }

  openBag(): void {
    this.bagOpen = true;
    this.bagSig = '';
    this.bag.win.show();
    this.freeMouse();
    this.renderBag();
  }

  closeBag(): void {
    this.bagOpen = false;
    this.bag.win.hide();
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
    this.toasts.add(text, kind);
  }

  // ---------- Every frame ----------

  update(dt: number): void {
    this.frameNo++;
    this.toasts.age(dt);
    this.portrait.update(this.frameNo);
    // The character window's MP and stamina tick along with the bars, without drawing it again.
    if (this.vit && this.panel?.kind === 'character') tickVitals(this.card.el, this.vit);
    this.minimap.update(this.frameNo);
    this.clock.update();
    this.compass.update();
    this.banner.update(dt);
    this.prompt.update();
    this.quests.update();
    this.rideBox.update(dt);
    this.toasts.place(this.rideBox.el);
    this.plates.update();
    this.hints.update();
    this.walkAway();
    this.travel?.update();
    if (this.frameNo % 15 === 0) this.refreshPortraits();
    if (this.panel?.kind === 'map') {
      // The map's foot follows travel by road; the map itself is drawn every frame.
      if (this.map.stale()) this.renderPanel(false);
      this.map.draw();
    } else if (this.panel && this.signature() !== this.panelSig) this.renderPanel(false);
    if (this.bagOpen && this.signature() !== this.bagSig) this.renderBag();
  }

  /** What the open windows show, in short: when it changes, they're drawn again. */
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
      this.questLog.sel,
      this.d.sim.player.pack,
      this.d.sim.player.weapon,
      this.d.sim.player.skills.join(),
      s.vehicles.length,
      s.glider,
      s.seed,
      s.contracts?.active.length,
      s.contracts?.offered.length,
      s.buyback?.map((b) => `${b.npc}${b.item}${b.n}`).join(),
      Math.round(this.vit?.hp ?? 0),
    ].join('|');
  }

  /** Portraits arrive a frame or two after a window opens and are retaken now and then: show the latest. */
  private refreshPortraits(): void {
    const p = this.panel;
    if (!p) return;
    const card = this.card.el;
    const set = (sel: string, who: string, fallback: string) => {
      const url = this.portraitOf(who);
      if (!url) return;
      const img = card.querySelector(sel + ' img') as HTMLImageElement | null;
      if (img) {
        if (img.getAttribute('src') !== url) img.src = url;
      } else if (card.querySelector(sel + ' ' + fallback)) this.renderPanel(false);
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

  /** Where the first unfinished quest wants you to go. */
  goal(): Goal | null {
    return questGoal(this.life, this.d.sim);
  }

  // ---------- Windows ----------

  private renderPanel(fresh: boolean): void {
    const p = this.panel;
    if (!p) return;
    this.panelSig = this.signature();
    const view = this.view(p);
    this.card.render(view, fresh, p.kind === 'map' ? (body) => this.map.show(body) : undefined);
    if (this.menuFocus >= 0) this.showMenuFocus();
  }

  private renderBag(): void {
    this.bagSig = this.signature();
    this.bag.render();
  }

  private view(p: Panel): View {
    switch (p.kind) {
      case 'dialog':
        return dialogView(this.ui, p.id, p.quest, p.trade);
      case 'shop':
        return shopView(this.ui, p.id, p.tab);
      case 'craft':
        return craftView(this.ui, p.id);
      case 'storage':
        return storageView(this.ui, Number(p.id));
      case 'map':
        return this.map.view();
      case 'garage':
        return ridesView(this.ui);
      case 'dev':
        return devView(this.ui);
      case 'admin':
        return adminView(this.ui);
      case 'log':
        return this.questLog.view();
      case 'character':
        return characterView(this.ui);
      case 'settings':
        return settingsView(this.ui);
    }
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
  /** Set by the app online, for admins: into a developer zone (the yard, the battlefield). */
  onEnterZone: ((id: string) => void) | null = null;
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
