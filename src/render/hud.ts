import * as THREE from 'three';
import type { Device } from '../input/input';
import { iconHtml } from '../ui/theme/icons';

const key = (label: string, cls = '') => `<span class="key ${cls}">${label}</span>`;
const item = (keys: string, action: string) => `<span>${keys}${action}</span>`;

const HINTS: Record<Device, string> = {
  keyboard: [
    item(key('WASD'), 'Move'),
    item(key('Shift'), 'Sprint'),
    item(key('Ctrl'), 'Crouch'),
    item(key('Space'), 'Jump ×2'),
    item(key('LMB') + key('J'), 'Attack'),
    item(key('C'), 'Slide'),
    item(key('1') + key('–') + key('8'), 'Hotbar (hold to aim)'),
    item(key('Q') + key('E'), 'Dodge / block'),
    item(key('Tab'), 'Next target'),
    item(key('T'), 'Skills'),
  ].join(''),
  gamepad: [
    item(key('L', 'stick'), 'Move'),
    item(key('R', 'stick'), 'Camera'),
    item(key('LS', 'stick'), 'Sprint'),
    item(key('RS', 'stick'), 'Crouch'),
    item(key('A', 'pad pad-a'), 'Jump ×2'),
    item(key('X', 'pad pad-x'), 'Attack'),
    item(key('B', 'pad pad-b'), 'Slide'),
    item(key('LT', 'stick') + key('RT', 'stick') + key('+ABXY'), 'Hotbar (hold to aim)'),
    item(key('LB', 'stick') + key('RB', 'stick'), 'Dodge / block'),
    item(key('D-pad', 'stick'), 'Next target'),
    item(key('View', 'stick'), 'Skills'),
  ].join(''),
};

// What's shown on the hotbar.
export interface Loadout {
  weapon: number;
  abilities: number[]; // one per slot, 255 for empty
  cooldowns: number[]; // frames left, per slot
  castAbility: number; // 255 when not casting
  castSlot: number; // 1..slots while casting, else 0
  castFrame: number;
  castFrames: number; // how long the current cast takes
  stun: number;
  downFrame: number;
}

// What each hotbar slot is bound to, shown in its corner.
const KEY_BINDS = ['1', '2', '3', '4', '5', '6', '7', '8'];
const PAD_BINDS = ['LT+A', 'LT+B', 'LT+X', 'LT+Y', 'RT+A', 'RT+B', 'RT+X', 'RT+Y'];

// What a floating number means. 'hit' is damage you dealt, 'hurt' damage you took, 'heal'
// healing you gave. They are coloured apart rather than left for the player to work out.
export type MarkerKind = 'hit' | 'hurt' | 'heal';

// A hit of this much or more reads as a heavy one and gets the crit treatment.
const CRIT_AT = 25;
// Every hit gets its own number, the way WoW does it, so they fan out left and right instead of
// stacking. Successive numbers alternate sides and vary a little so a fast combo reads as a spray.
const FAN_SPREAD = 0.55; // metres the arc carries a number sideways
const FAN_RISE = 1.05; // metres it climbs over its life
// A ceiling only so a meteor into a crowd can't leave hundreds of live DOM nodes behind. Numbers
// are recycled rather than rebuilt, and the oldest is retired first if the cap is reached.
const MAX_FLOATERS = 72;

interface Floater {
  el: HTMLDivElement;
  pos: THREE.Vector3;
  age: number;
  life: number;
  side: number; // -1 or 1: which way this one arcs
  spread: number;
  rise: number;
}

// The enemy the game is aiming at for you, for the plate over their head.
export interface TargetInfo {
  pos: THREE.Vector3;
  hp: number; // 0..1
  name: string;
  locked: boolean; // true once you picked it with Tab rather than it being chosen for you
  /** A cast it is in the middle of: interrupt it before the bar fills. */
  cast?: { label: string; progress: number } | null;
}

// On-screen text: controls hint, stats, the dummy's health bar and floating damage numbers.
export class Hud {
  private stats = document.getElementById('stats') as HTMLDivElement;
  private hint = document.getElementById('hint') as HTMLDivElement;
  private hpBar = document.getElementById('dummy-hp') as HTMLDivElement;
  private hpFill = this.hpBar.querySelector('.fill') as HTMLDivElement;
  private floaters: Floater[] = [];
  private free: HTMLDivElement[] = []; // recycled number elements
  private fan = 1; // flips per number so they alternate sides
  private log: Array<{ kind: MarkerKind; amount: number; icon: string }> = []; // for tests
  private plate = document.getElementById('target-plate') as HTMLDivElement;
  private plateFill = this.plate.querySelector('.fill') as HTMLDivElement;
  private plateName = this.plate.querySelector('.name') as HTMLSpanElement;
  private plateCast = this.plate.querySelector('.cast') as HTMLDivElement;
  private plateCastFill = this.plate.querySelector('.cast .fill') as HTMLDivElement;
  private plateCastLabel = this.plate.querySelector('.cast .label') as HTMLSpanElement;
  private target: TargetInfo | null = null;
  private v = new THREE.Vector3();
  private bar = document.getElementById('abilities') as HTMLDivElement;
  private castBar = document.getElementById('castbar') as HTMLDivElement;
  private barKey = '';
  private wasCasting = 0; // castKind last frame
  private castName = '';
  private castEnd: { text: string; cls: string; until: number } | null = null;
  private finished = false;
  onSkillsClick: (() => void) | null = null;
  // Dragging one hotbar slot onto another, straight from the bar. 0-based slot indices.
  onSwapSlots: ((a: number, b: number) => void) | null = null;
  private dragFrom = -1;

  constructor() {
    this.bar.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.skills-btn')) this.onSkillsClick?.();
    });
    this.bar.addEventListener('dragstart', (e) => {
      const el = (e.target as HTMLElement).closest('.slot') as HTMLElement | null;
      if (!el || el.classList.contains('empty')) {
        e.preventDefault();
        return;
      }
      this.dragFrom = Number(el.dataset.slot) - 1;
      el.classList.add('drag');
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer?.setData('text/plain', String(this.dragFrom));
    });
    this.bar.addEventListener('dragover', (e) => {
      if (this.dragFrom < 0) return;
      const el = (e.target as HTMLElement).closest('.slot') as HTMLElement | null;
      if (!el) return;
      e.preventDefault(); // without this the drop never fires
      for (const other of this.bar.querySelectorAll('.over')) other.classList.remove('over');
      el.classList.add('over');
    });
    this.bar.addEventListener('drop', (e) => {
      const from = this.dragFrom;
      const el = (e.target as HTMLElement).closest('.slot') as HTMLElement | null;
      this.endDrag();
      if (from < 0 || !el) return;
      e.preventDefault();
      const to = Number(el.dataset.slot) - 1;
      if (to !== from) this.onSwapSlots?.(from, to);
    });
    this.bar.addEventListener('dragend', () => this.endDrag());
  }

  private endDrag(): void {
    this.dragFrom = -1;
    for (const el of this.bar.querySelectorAll('.drag, .over')) el.classList.remove('drag', 'over');
  }

  setDevice(d: Device): void {
    this.hint.innerHTML = HINTS[d];
    this.hint.dataset.device = d;
  }

  setStats(text: string): void {
    this.stats.textContent = text;
  }

  // Your own health bar (networked play). Pass null to hide it.
  /** `team` is the battlefield's side; null where there are no sides (the open world). */
  setPlayerHp(hp: number | null, max: number, team: number | null = 0): void {
    const bar = document.getElementById('player-hp') as HTMLDivElement;
    if (hp === null) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'block';
    bar.classList.toggle('hurt', hp < max * 0.35);
    (bar.querySelector('.fill') as HTMLDivElement).style.width = `${Math.round((hp / max) * 100)}%`;
    (bar.querySelector('.label') as HTMLSpanElement).textContent =
      hp <= 0 ? 'Knocked down…' : team === null ? `${Math.round(hp)} / ${max}` : `${team === 0 ? 'Blue' : 'Red'} team · ${Math.round(hp)} / ${max}`;
  }

  // The ability bar: weapon, two ability slots with cooldowns, and the skills button.
  // names/icons come from the caller so this file doesn't need the game's tables.
  setAbilities(
    l: Loadout,
    device: Device,
    pointsLeft: number,
    look: { weapon: [string, string]; ability: (a: number) => [string, string] | null; cooldownFrames: (a: number) => number },
  ): void {
    const binds = device === 'gamepad' ? PAD_BINDS : KEY_BINDS;
    const skillsBind = device === 'gamepad' ? 'View' : 'T';
    const slots = l.abilities;
    const key = [l.weapon, ...slots, device, pointsLeft].join(',');
    if (key !== this.barKey) {
      this.barKey = key;
      const slot = (a: number, i: number) => {
        const info = look.ability(a);
        const title = info ? info[1] : 'Empty slot: drag an ability here from the skill trees';
        return `<div class="slot${info ? '' : ' empty'}" data-slot="${i + 1}" draggable="${info ? 'true' : 'false'}" title="${title}">
          <span class="icon">${info ? iconHtml(info[0], undefined, 36) : ''}</span><span class="cd"></span><span class="secs"></span><span class="bind">${binds[i]}</span></div>`;
      };
      this.bar.innerHTML =
        `<div class="weapon" title="${look.weapon[1]}"><span class="icon">${iconHtml(look.weapon[0], undefined, 40)}</span><span class="name">${look.weapon[1]}</span></div>` +
        slots.map(slot).join('') +
        `<div class="skills-btn${pointsLeft > 0 ? ' unspent' : ''}"><span class="bind">${skillsBind}</span>Skills${pointsLeft > 0 ? ` <b>${pointsLeft}</b>` : ''}</div>`;
    }
    // Cooldown sweeps.
    slots.forEach((a, i) => {
      const el = this.bar.querySelector(`.slot[data-slot="${i + 1}"]`) as HTMLDivElement | null;
      if (!el || !look.ability(a)) return;
      const left = l.cooldowns[i] ?? 0;
      const total = Math.max(left, look.cooldownFrames(a));
      const cd = el.querySelector('.cd') as HTMLSpanElement;
      cd.style.background = left > 0 ? `conic-gradient(rgba(10, 16, 24, 0.72) ${(left / total) * 360}deg, transparent 0)` : 'none';
      (el.querySelector('.secs') as HTMLSpanElement).textContent = left > 0 ? (left / 60).toFixed(left > 60 ? 0 : 1) : '';
      el.classList.toggle('casting', l.castSlot === i + 1 && l.castAbility !== 255);
      el.classList.toggle('ready', left === 0);
    });

    // Cast bar: fills while casting; says how it ended.
    const now = performance.now();
    if (l.castAbility !== 255) {
      const a = l.abilities[l.castSlot - 1] ?? 255;
      this.castName = look.ability(a)?.[1] ?? '';
      this.castEnd = null;
      this.finished = false;
      this.castBar.className = 'show';
      (this.castBar.querySelector('.fill') as HTMLDivElement).style.width = `${Math.min(100, (l.castFrame / Math.max(1, l.castFrames)) * 100)}%`;
      (this.castBar.querySelector('.label') as HTMLSpanElement).textContent = this.castName;
    } else if (this.wasCasting > 0) {
      const interrupted = l.stun > 0 || l.downFrame >= 0;
      this.castEnd = this.finished
        ? { text: this.castName, cls: 'show done', until: now + 250 }
        : interrupted
          ? { text: 'Interrupted!', cls: 'show interrupted', until: now + 900 }
          : { text: 'Cancelled', cls: 'show cancelled', until: now + 500 };
      this.castBar.className = this.castEnd.cls;
      if (this.finished) (this.castBar.querySelector('.fill') as HTMLDivElement).style.width = '100%';
      (this.castBar.querySelector('.label') as HTMLSpanElement).textContent = this.castEnd.text;
    } else if (this.castEnd && now > this.castEnd.until) {
      this.castEnd = null;
      this.castBar.className = '';
    }
    this.wasCasting = l.castAbility !== 255 ? 1 : 0;
  }

  // The cast on the bar went off (rather than being cancelled or interrupted).
  castFinished(): void {
    this.finished = true;
  }

  hideAbilities(): void {
    this.bar.style.display = 'none';
  }

  // One floating number per hit. `icon` is resolved by the caller, so this file still needs to
  // know nothing about weapons or abilities.
  marker(kind: MarkerKind, x: number, y: number, z: number, amount: number, icon = ''): void {
    const value = Math.max(1, Math.round(amount));
    const crit = kind !== 'heal' && value >= CRIT_AT;
    if (this.floaters.length >= MAX_FLOATERS) this.retire(0);
    const el = this.free.pop() ?? document.body.appendChild(document.createElement('div'));
    el.className = `dmg ${kind}${crit ? ' big' : ''}`;
    el.innerHTML = icon ? `<span class="icon"></span><span class="n"></span>` : `<span class="n"></span>`;
    if (icon) (el.querySelector('.icon') as HTMLSpanElement).innerHTML = iconHtml(icon, undefined, 16);
    (el.querySelector('.n') as HTMLSpanElement).textContent = `${kind === 'heal' ? '+' : ''}${value}`;
    el.style.display = 'block';
    // Restart the pop so a recycled element animates again.
    void el.offsetWidth;
    el.classList.add('pop');

    this.fan = -this.fan;
    if (this.log.length < 64) this.log.push({ kind, amount: value, icon });
    this.floaters.push({
      el,
      pos: new THREE.Vector3(x, y + 0.4, z),
      age: 0,
      life: crit ? 1.15 : kind === 'hurt' ? 1.0 : 0.85,
      side: this.fan,
      spread: FAN_SPREAD * (0.6 + Math.random() * 0.8),
      rise: FAN_RISE * (0.85 + Math.random() * 0.3),
    });
  }

  // Parks a floater's element for reuse instead of churning the DOM during an AOE burst.
  private retire(i: number): void {
    const f = this.floaters[i];
    f.el.style.display = 'none';
    f.el.classList.remove('pop');
    if (this.free.length < MAX_FLOATERS) this.free.push(f.el);
    else f.el.remove();
    this.floaters.splice(i, 1);
  }

  // The enemy the game is aiming at, or null for none.
  setTarget(t: TargetInfo | null): void {
    this.target = t;
  }

  // Every number drawn since the log was last cleared, for tests. Reading doesn't clear it, so
  // polling for one doesn't throw away the others.
  markerLog(): ReadonlyArray<{ kind: MarkerKind; amount: number; icon: string }> {
    return this.log;
  }

  clearMarkerLog(): void {
    this.log = [];
  }

  clear(): void {
    while (this.floaters.length) this.retire(0);
    this.target = null;
    this.plate.style.display = 'none';
  }

  step(dt: number): void {
    for (const f of this.floaters) f.age += dt;
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      if (this.floaters[i].age >= this.floaters[i].life) this.retire(i);
    }
  }

  // Places screen elements over their 3D positions. The health bar only shows when the dummy is close.
  layout(camera: THREE.Camera, width: number, height: number, dummyTop: THREE.Vector3, hpFraction: number, showDummy = true): void {
    const toScreen = (p: THREE.Vector3): { x: number; y: number; visible: boolean } => {
      this.v.copy(p).project(camera);
      return { x: ((this.v.x + 1) / 2) * width, y: ((1 - this.v.y) / 2) * height, visible: this.v.z < 1 };
    };
    const near = showDummy && camera.position.distanceTo(dummyTop) < 30;
    const hp = toScreen(dummyTop);
    this.hpBar.style.display = near && hp.visible ? 'block' : 'none';
    this.hpBar.style.left = `${hp.x}px`;
    this.hpBar.style.top = `${hp.y}px`;
    this.hpFill.style.width = `${Math.round(hpFraction * 100)}%`;

    for (const f of this.floaters) {
      const k = f.age / f.life;
      // Fast at first then slowing, arcing out to one side: WoW's spray rather than a straight rise.
      const ease = 1 - (1 - k) * (1 - k);
      this.v.copy(f.pos);
      this.v.y += f.rise * ease;
      this.v.x += f.side * f.spread * ease;
      const s = toScreen(this.v);
      f.el.style.left = `${s.x}px`;
      f.el.style.top = `${s.y}px`;
      f.el.style.opacity = String(k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4);
      f.el.style.display = s.visible ? 'block' : 'none';
    }

    const t = this.target;
    if (!t) {
      this.plate.style.display = 'none';
      return;
    }
    const at = toScreen(t.pos);
    this.plate.style.display = at.visible ? 'block' : 'none';
    this.plate.style.left = `${at.x}px`;
    this.plate.style.top = `${at.y}px`;
    this.plate.classList.toggle('locked', t.locked);
    this.plateFill.style.width = `${Math.round(Math.max(0, Math.min(1, t.hp)) * 100)}%`;
    this.plateName.textContent = t.name;
    this.plateCast.style.display = t.cast ? 'block' : 'none';
    if (t.cast) {
      this.plateCastFill.style.width = `${Math.round(Math.max(0, Math.min(1, t.cast.progress)) * 100)}%`;
      this.plateCastLabel.textContent = t.cast.label;
    }
  }
}
