import * as THREE from 'three';
import { Hero } from '../render/character';
import { LifeView, sitIn, type Seated } from '../render/open/life';
import type { HouseView } from '../render/village/village';
import type { Models } from '../render/open/models';
import { addScarecrowCollider } from '../sim/life/farming';
import { addHouseColliders } from '../sim/life/housing';
import { Life, type OthersVehicle } from '../sim/life/life';
import type { House, Pack, Scarecrow, ShipBuild, Vehicle } from '../sim/life/state';
import { angleDiff } from '../sim/math';
import type { Sim } from '../sim/sim';
import type { Mover, PlayerState } from '../sim/types';
import { vehicleBodies } from '../sim/life/vehicles';
import type { ZoneData } from '../sim/zone/world';
import { blankState } from './netPlayer';
import type { Estate, EstateEntry, PeerEntry, WorldLink } from './worldLink';

// Everyone else in your channel of Emberholm, as the server plays them (crates/server/src/world_game.rs):
// each player as they move (about 20 times a second, drawn a few frames behind so there is always
// a next one to blend toward), with their glider, pack, vehicles and mounts; and everything every
// resident has built, their houses and farms, which stay standing while they're away. Houses and
// farm posts are solid, as yours are.

/** The player fields drawing someone needs (src/render/character.ts and the life view); the server sends these. */
const SHOWN = [
  'facing', 'mode', 'grounded', 'attackIndex', 'attackFrame', 'flipFrame', 'landFrame', 'landImpact', 'takeoffFrame', 'runPhase',
  'stun', 'downFrame', 'weapon', 'comboVariants', 'actionId', 'actionFrame', 'castAbility', 'castFrame', 'bank', 'pack', 'vehicle',
  'seat', 'host', 'glider', 'airspeed', 'sprinting', 'crouching', 'crouchFrame', 'hp',
] as const;

/**
 * Frame counters that go up by one a frame for as long as what they count goes on: run on between
 * updates, so someone's swing, cast or flip is drawn as smoothly as their movement.
 */
const COUNTERS = ['attackFrame', 'actionFrame', 'castFrame', 'flipFrame', 'landFrame', 'takeoffFrame', 'downFrame'] as const;

/** Frames behind the newest presence that others are drawn at (100 ms). */
const DELAY = 6;

interface Sample {
  fr: number;
  p: Record<string, unknown> & { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number }; facing: number; vehicles?: Vehicle[]; packs?: Pack[] };
}

interface Peer {
  id: number;
  name: string;
  hero: Hero;
  life: Life;
  view: LifeView;
  shown: PlayerState;
  samples: Sample[];
  clock: number;
  online: boolean;
  label: THREE.Sprite;
  /** How far they are from you (m), as of the last frame. */
  away: number;
  estateKey: string;
  solid: Set<string>;
  /** When we last heard from them (ms, performance.now()). */
  heard: number;
}

/** Everyone reports 20 times a second, even standing still; this long without a word, they've gone. */
const SILENT_MS = 5000;

/** Riding along in someone else's vehicle (as last drawn). */
const along = (p: Peer): boolean => p.shown.mode === 'ride' && !!p.shown.host;

/**
 * Names over other players, by their distance from you in metres: whole within `fullWithin`, fading
 * out to nothing by `goneBy`, where the townsfolk's names go too (an MMO's range: the people around
 * you are named, a crowd far off isn't a cloud of names). From you rather than the camera, so the
 * crew beside you stay named when the camera pulls back behind a boat. Past `shrinkFrom` they also
 * shrink a little, to `farScale` of their size by `goneBy`, so a far name looks far.
 */
const NAME_PLATE = { fullWithin: 30, goneBy: 45, shrinkFrom: 10, farScale: 0.8 };
/** A name plate's height as a sprite's scale, which without size attenuation is a size on screen. */
const PLATE_HEIGHT = 0.04;

export class WorldPeers {
  private peers = new Map<number, Peer>();
  /** Called when the ground under someone's new farm or house needs its grass cleared. */
  onGroundChanged: (() => void) | null = null;
  /** What draws your own vehicles, for anyone riding along in one of them. */
  mineView: LifeView | null = null;
  /** Where someone sits at a mini-game's table, if they're at one (src/render/open/gameTables.ts). */
  stoolFor: ((id: number) => Seated | null) | null = null;
  /** Where everyone's houses are drawn (the island's Village), by owner. */
  houseSink: ((owner: string, houses: HouseView[]) => void) | null = null;

  constructor(
    private scene: THREE.Scene,
    private zone: ZoneData,
    private models: Models,
    private sim: Sim,
    private mine: Life,
    private me: number,
    link: WorldLink,
  ) {
    for (const e of link.estates.values()) this.estate(e);
    this.receive([...link.peers.values()]);
    link.onPeers = (list) => this.receive(list);
    link.onEstate = (e) => this.estate(e);
    link.onLeft = (id) => this.left(id);
  }

  /**
   * For tests and the bug reporter: who is here and what of theirs is drawn, with how far they are
   * from you (metres) and how much of their name plate shows (0 hidden, 1 whole).
   */
  list(): Array<{ id: number; name: string; online: boolean; x: number; y: number; z: number; mode: string; houses: number; scarecrows: number; vehicles: number; away: number; plate: number }> {
    return [...this.peers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      online: p.online,
      x: p.shown.pos.x,
      y: p.shown.pos.y,
      z: p.shown.pos.z,
      mode: p.shown.mode,
      houses: p.life.state.houses.length,
      scarecrows: p.life.state.scarecrows.length,
      vehicles: p.life.state.vehicles.length,
      away: +p.away.toFixed(1),
      plate: p.label.visible && p.hero.root.visible ? +(p.label.material as THREE.SpriteMaterial).opacity.toFixed(3) : 0,
    }));
  }

  /** How far the farm ground drawn for anyone here stands over the terrain within `pad` metres of (x, z) (LifeView.raisedAt). */
  raisedAt(x: number, z: number, pad: number): number {
    let top = 0;
    for (const p of this.peers.values()) top = Math.max(top, p.view.raisedAt(x, z, pad));
    return top;
  }

  private peer(id: number, name: string): Peer {
    let p = this.peers.get(id);
    if (p) return p;
    const hero = new Hero();
    hero.root.visible = false;
    this.scene.add(hero.root);
    const life = new Life(this.zone);
    life.state.weather = this.mine.state.weather;
    const view = new LifeView(this.scene, life, this.models, hero, { others: true });
    view.onGroundChanged = () => this.onGroundChanged?.();
    view.houseSink = (houses) => this.houseSink?.(`peer:${id}`, houses);
    const label = nameTag(name);
    label.position.set(0, 2.45, 0);
    hero.root.add(label);
    p = { id, name, hero, life, view, shown: blankState(), samples: [], clock: -1, online: false, label, away: Infinity, estateKey: '', solid: new Set(), heard: 0 };
    this.peers.set(id, p);
    return p;
  }

  private receive(list: PeerEntry[]): void {
    for (const e of list) {
      if (e.id === this.me) continue;
      const s = e.p as Sample['p'];
      if (!s?.pos) continue;
      const p = this.peer(e.id, e.name);
      const fr = Number(s.fr) || 0;
      // A newer page (they reloaded) starts its frames again from zero.
      if (p.samples.length && fr <= p.samples[p.samples.length - 1].fr - 600) p.samples = [];
      if (p.samples.length && fr <= p.samples[p.samples.length - 1].fr) continue;
      p.heard = performance.now();
      p.samples.push({ fr, p: s });
      if (p.samples.length > 30) p.samples.shift();
      if (!p.online) {
        p.online = true;
        p.clock = -1;
      }
    }
  }

  private estate(e: EstateEntry): void {
    if (e.id === this.me) return;
    const est = e.estate as Estate;
    // Nothing built and nobody here: nothing to draw.
    if (!this.peers.has(e.id) && !est.houses?.length && !est.scarecrows?.length && !est.ships?.length) return;
    const p = this.peer(e.id, e.name);
    const key = JSON.stringify(est);
    if (key === p.estateKey) return;
    p.estateKey = key;
    const s = p.life.state;
    s.houses = (est.houses ?? []) as House[];
    s.scarecrows = (est.scarecrows ?? []) as Scarecrow[];
    s.ships = (est.ships ?? []) as ShipBuild[];
    p.life.revision++;
    // Their walls and farm posts are as solid as yours.
    let changed = false;
    for (const h of s.houses) {
      const k = `h${h.id}:${h.stage}`;
      if (p.solid.has(k)) continue;
      p.solid.add(k);
      addHouseColliders(p.life, this.sim, { ...h, id: -(e.id * 100_000 + h.id) });
      changed = true;
    }
    for (const sc of s.scarecrows) {
      const k = `s${sc.id}`;
      if (p.solid.has(k)) continue;
      p.solid.add(k);
      addScarecrowCollider(this.sim, sc);
      changed = true;
    }
    if (changed) this.onGroundChanged?.();
  }

  /** You've gone somewhere else (into a dungeon's copy, or back out): everyone you saw is gone from view. */
  everyoneLeft(): void {
    for (const id of this.peers.keys()) this.left(id);
  }

  private left(id: number): void {
    const p = this.peers.get(id);
    if (!p) return;
    p.online = false;
    p.samples = [];
    p.hero.root.visible = false;
    p.life.state.vehicles = [];
    p.life.state.packs = [];
  }

  /** Everyone's vehicles as drawn, with the seats taken in them (`you` too), for the prompt to ride along. */
  vehicles(you: PlayerState): OthersVehicle[] {
    const seated = (q: PlayerState) => (q.mode === 'ride' && q.host ? `${q.host}:${q.vehicle}` : '');
    const riders = [...this.peers.values()].filter((p) => p.online).map((p) => p.shown).concat(you);
    const out: OthersVehicle[] = [];
    for (const p of this.peers.values()) {
      if (!p.online) continue;
      for (const v of p.life.state.vehicles) {
        const here = `${p.id}:${v.id}`;
        out.push({ host: p.id, name: p.name, vehicle: v, taken: riders.filter((q) => seated(q) === here).map((q) => q.seat) });
      }
    }
    return out;
  }

  /** Where you sit riding along in someone's vehicle this frame (theirs is placed by frame(), so call that first). */
  seatFor(you: PlayerState): Seated | null {
    if (you.mode !== 'ride' || !you.host) return null;
    return this.peers.get(you.host)?.view.seatOf(you.vehicle, you.seat) ?? null;
  }

  /** Poses everyone for this frame. */
  frame(dt: number, frame: number, cameraPos: THREE.Vector3): void {
    const now = performance.now();
    const me = this.sim.player.pos;
    // Whoever drives (or walks) first, then whoever rides along with them: a vehicle has to be
    // where it is this frame before anyone sits down in it.
    const order = [...this.peers.values()].sort((a, b) => Number(along(a)) - Number(along(b)));
    const movers: Mover[] = [];
    for (const p of order) {
      if (p.online && now - p.heard > SILENT_MS) this.left(p.id);
      const s = p.life.state;
      s.clock = this.mine.state.clock;
      s.weather = this.mine.state.weather;
      if (p.online && p.samples.length) this.pose(p, dt, frame);
      p.view.update({ player: p.shown } as unknown as Sim, dt, cameraPos);
      for (const v of s.vehicles) movers.push(...vehicleBodies(v));
      p.away = Math.hypot(p.shown.pos.x - me.x, p.shown.pos.y - me.y, p.shown.pos.z - me.z);
      plateFor(p.label, p.away);
    }
    // Their vehicles are as solid to you as yours are, where you see them.
    this.sim.world.movers = movers;
  }

  private pose(p: Peer, dt: number, frame: number): void {
    const samples = p.samples;
    const newest = samples[samples.length - 1].fr;
    const target = newest - DELAY;
    if (p.clock < 0 || Math.abs(p.clock - target) > 45) p.clock = target;
    p.clock += dt * 60;
    // Stay about DELAY frames behind, easing back toward it if updates bunch up or stall.
    p.clock += (target - p.clock) * Math.min(1, dt * 2);
    let k = samples.length - 1;
    while (k > 0 && samples[k].fr > p.clock) k--;
    const a = samples[k];
    const b = samples[Math.min(k + 1, samples.length - 1)];
    const span = b.fr - a.fr;
    const jump = Math.hypot(b.p.pos.x - a.p.pos.x, b.p.pos.z - a.p.pos.z) > 25;
    const t = span > 0 && !jump ? Math.min(1, Math.max(0, (p.clock - a.fr) / span)) : 1;

    const sh = p.shown;
    const from = t < 0.5 ? a : b;
    const src = from.p as Record<string, unknown>;
    const shown = sh as unknown as Record<string, unknown>;
    for (const key of SHOWN) shown[key] = src[key];
    // As of the moment drawn, not of the update they came in (which may be a frame or two either side).
    for (const key of COUNTERS) {
      const v = shown[key];
      if (typeof v === 'number' && v >= 0) shown[key] = Math.max(0, v + p.clock - from.fr);
    }
    sh.pos = lerp3(a.p.pos, b.p.pos, t);
    sh.prevPos = { ...sh.pos };
    sh.facing = sh.prevFacing = a.p.facing + angleDiff(a.p.facing, b.p.facing) * t;
    sh.vel = { ...b.p.vel };
    sh.glider = (b.p.glider as string) ?? '';
    sh.host = Number(sh.host) || 0;

    // Their vehicles glide between updates the same way; packs ride on whatever carries them.
    const before = new Map((a.p.vehicles ?? []).map((v) => [v.id, v]));
    p.life.state.vehicles = (b.p.vehicles ?? []).map((v) => {
      const o = before.get(v.id);
      if (!o || jump) return v;
      return {
        ...v,
        x: o.x + (v.x - o.x) * t,
        y: o.y + (v.y - o.y) * t,
        z: o.z + (v.z - o.z) * t,
        heading: o.heading + angleDiff(o.heading, v.heading) * t,
        pitch: o.pitch + (v.pitch - o.pitch) * t,
        roll: o.roll + (v.roll - o.roll) * t,
      };
    });
    p.life.state.packs = b.p.packs ?? [];
    p.life.state.glider = sh.glider;

    // Driving, their vehicle goes under them; riding along, they sit in whoever's it is; at a
    // mini-game's table, on its stool.
    const host = sh.host === this.me ? this.mineView : this.peers.get(sh.host)?.view;
    const stool = this.stoolFor?.(p.id) ?? null;
    sitIn(p.hero, stool ?? (sh.mode === 'ride' && sh.host ? (host?.seatOf(sh.vehicle, sh.seat) ?? null) : p.view.placeRide(sh, 1, null, dt)));
    p.hero.root.visible = true;
    p.hero.update(stool ? { ...sh, mode: 'ride' } : sh, 1, frame);
  }
}

function lerp3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, t: number): { x: number; y: number; z: number } {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/** A name over someone's head, on a canvas as wide as the name, so a long one isn't cut off. */
function nameTag(name: string): THREE.Sprite {
  const font = 'bold 30px system-ui, -apple-system, "Segoe UI", sans-serif';
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  g.font = font;
  // Room either side for the outline.
  c.width = Math.max(64, Math.ceil(g.measureText(name).width) + 24);
  c.height = 64;
  // Sizing the canvas resets how it draws.
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(20, 30, 40, 0.85)';
  g.strokeText(name, c.width / 2, 32);
  g.fillStyle = '#ffffff';
  g.fillText(name, c.width / 2, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // The same size on screen at any distance, crisp and easy to read, until it is far enough away
  // to shrink a little and fade (plateFor).
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true, sizeAttenuation: false }));
  sprite.userData.aspect = c.width / c.height;
  sprite.scale.set(PLATE_HEIGHT * sprite.userData.aspect, PLATE_HEIGHT, 1);
  sprite.renderOrder = 5;
  return sprite;
}

/** Fades and sizes a name plate for how far its player is from you, in metres (NAME_PLATE). */
function plateFor(label: THREE.Sprite, distance: number): void {
  const { fullWithin, goneBy, shrinkFrom, farScale } = NAME_PLATE;
  const t = Math.min(1, Math.max(0, (distance - fullWithin) / (goneBy - fullWithin)));
  const shown = 1 - t * t * (3 - 2 * t);
  label.visible = shown > 0.01;
  (label.material as THREE.SpriteMaterial).opacity = shown;
  const k = 1 - (1 - farScale) * Math.min(1, Math.max(0, (distance - shrinkFrom) / (goneBy - shrinkFrom)));
  label.scale.set(PLATE_HEIGHT * label.userData.aspect * k, PLATE_HEIGHT * k, 1);
}
