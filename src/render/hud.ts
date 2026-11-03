import * as THREE from 'three';
import type { Device } from '../input/input';

const key = (label: string, cls = '') => `<span class="key ${cls}">${label}</span>`;
const item = (keys: string, action: string) => `<span>${keys}${action}</span>`;

const HINTS: Record<Device, string> = {
  keyboard: [
    item(key('WASD'), 'Move'),
    item(key('Mouse'), 'Camera (click to capture)'),
    item(key('Space'), 'Jump ×2'),
    item(key('LMB') + key('J'), 'Attack'),
    item(key('Shift'), 'Slide'),
    item(key('E') + key('Q'), 'Abilities'),
    item(key('T'), 'Skills'),
  ].join(''),
  gamepad: [
    item(key('L', 'stick'), 'Move'),
    item(key('R', 'stick'), 'Camera'),
    item(key('A', 'pad pad-a'), 'Jump ×2'),
    item(key('X', 'pad pad-x'), 'Attack'),
    item(key('B', 'pad pad-b'), 'Slide'),
    item(key('Y', 'pad pad-y') + key('RB', 'stick'), 'Abilities'),
    item(key('View', 'stick'), 'Skills'),
  ].join(''),
};

// What's shown on the ability bar.
export interface Loadout {
  weapon: number;
  ability1: number;
  ability2: number;
  cooldown1: number; // frames left
  cooldown2: number;
  castKind: number;
  castSlot: number;
  castFrame: number;
  castFrames: number; // how long the current cast takes
  stun: number;
  downFrame: number;
}

interface Floater {
  el: HTMLDivElement;
  pos: THREE.Vector3;
  age: number;
  life: number;
}

// On-screen text: controls hint, stats, the dummy's health bar and floating damage numbers.
export class Hud {
  private stats = document.getElementById('stats') as HTMLDivElement;
  private hint = document.getElementById('hint') as HTMLDivElement;
  private hpBar = document.getElementById('dummy-hp') as HTMLDivElement;
  private hpFill = this.hpBar.querySelector('.fill') as HTMLDivElement;
  private floaters: Floater[] = [];
  private v = new THREE.Vector3();
  private bar = document.getElementById('abilities') as HTMLDivElement;
  private castBar = document.getElementById('castbar') as HTMLDivElement;
  private barKey = '';
  private wasCasting = 0; // castKind last frame
  private castName = '';
  private castEnd: { text: string; cls: string; until: number } | null = null;
  private finished = false;
  onSkillsClick: (() => void) | null = null;

  constructor() {
    this.bar.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.skills-btn')) this.onSkillsClick?.();
    });
  }

  setDevice(d: Device): void {
    this.hint.innerHTML = HINTS[d];
    this.hint.dataset.device = d;
  }

  setStats(text: string): void {
    this.stats.textContent = text;
  }

  // Your own health bar (networked play). Pass null to hide it.
  setPlayerHp(hp: number | null, max: number, team = 0): void {
    const bar = document.getElementById('player-hp') as HTMLDivElement;
    if (hp === null) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'block';
    bar.classList.toggle('hurt', hp < max * 0.35);
    (bar.querySelector('.fill') as HTMLDivElement).style.width = `${Math.round((hp / max) * 100)}%`;
    (bar.querySelector('.label') as HTMLSpanElement).textContent =
      hp > 0 ? `${team === 0 ? 'Blue' : 'Red'} team · ${Math.round(hp)} / ${max}` : 'Knocked down…';
  }

  // The ability bar: weapon, two ability slots with cooldowns, and the skills button.
  // names/icons come from the caller so this file doesn't need the game's tables.
  setAbilities(
    l: Loadout,
    device: Device,
    pointsLeft: number,
    look: { weapon: [string, string]; ability: (a: number) => [string, string] | null; cooldownFrames: (a: number) => number },
  ): void {
    const binds = device === 'gamepad' ? ['Y', 'RB', 'View'] : ['E', 'Q', 'T'];
    const slots = [l.ability1, l.ability2];
    const key = [l.weapon, ...slots, device, pointsLeft].join(',');
    if (key !== this.barKey) {
      this.barKey = key;
      const slot = (a: number, i: number) => {
        const info = look.ability(a);
        return `<div class="slot${info ? '' : ' empty'}" data-slot="${i + 1}" title="${info ? info[1] : 'Empty slot: learn an ability in the skill trees'}">
          <span class="icon">${info ? info[0] : ''}</span><span class="cd"></span><span class="secs"></span><span class="bind">${binds[i]}</span></div>`;
      };
      this.bar.innerHTML =
        `<div class="weapon" title="${look.weapon[1]}"><span class="icon">${look.weapon[0]}</span><span class="name">${look.weapon[1]}</span></div>` +
        slots.map(slot).join('') +
        `<div class="skills-btn${pointsLeft > 0 ? ' unspent' : ''}"><span class="bind">${binds[2]}</span>Skills${pointsLeft > 0 ? ` <b>${pointsLeft}</b>` : ''}</div>`;
    }
    // Cooldown sweeps.
    slots.forEach((a, i) => {
      const el = this.bar.querySelector(`.slot[data-slot="${i + 1}"]`) as HTMLDivElement | null;
      if (!el || !look.ability(a)) return;
      const left = i === 0 ? l.cooldown1 : l.cooldown2;
      const total = Math.max(left, look.cooldownFrames(a));
      const cd = el.querySelector('.cd') as HTMLSpanElement;
      cd.style.background = left > 0 ? `conic-gradient(rgba(10, 16, 24, 0.72) ${(left / total) * 360}deg, transparent 0)` : 'none';
      (el.querySelector('.secs') as HTMLSpanElement).textContent = left > 0 ? (left / 60).toFixed(left > 60 ? 0 : 1) : '';
      el.classList.toggle('casting', l.castSlot === i + 1 && l.castKind > 0);
      el.classList.toggle('ready', left === 0);
    });

    // Cast bar: fills while casting; says how it ended.
    const now = performance.now();
    if (l.castKind > 0) {
      const a = l.castSlot === 1 ? l.ability1 : l.ability2;
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
    this.wasCasting = l.castKind;
  }

  // The cast on the bar went off (rather than being cancelled or interrupted).
  castFinished(): void {
    this.finished = true;
  }

  hideAbilities(): void {
    this.bar.style.display = 'none';
  }

  damage(x: number, y: number, z: number, amount: number, big: boolean): void {
    const el = document.createElement('div');
    el.className = big ? 'dmg big' : 'dmg';
    el.textContent = String(amount);
    document.body.appendChild(el);
    // Scatter numbers a little so quick hits in a row stay readable.
    const jitter = () => (Math.random() - 0.5) * 0.7;
    this.floaters.push({ el, pos: new THREE.Vector3(x + jitter(), y + 0.4, z + jitter()), age: 0, life: 0.8 });
  }

  clear(): void {
    for (const f of this.floaters) f.el.remove();
    this.floaters = [];
  }

  step(dt: number): void {
    for (const f of this.floaters) f.age += dt;
    const done = this.floaters.filter((f) => f.age >= f.life);
    for (const f of done) f.el.remove();
    this.floaters = this.floaters.filter((f) => f.age < f.life);
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
      this.v.copy(f.pos);
      this.v.y += k * 0.9;
      const s = toScreen(this.v);
      f.el.style.left = `${s.x}px`;
      f.el.style.top = `${s.y}px`;
      f.el.style.opacity = String(k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4);
      f.el.style.display = s.visible ? 'block' : 'none';
    }
  }
}
