import {
  LifeView,
  newLifeState,
  type OthersVehicle,
  type House,
  type Pack,
  type Scarecrow,
  type ShipBuild,
  type Vehicle,
  vehicleBodies,
} from '../engine/life';
import { angleDiff, type Mover, type PlayerState } from '../engine/rules';
import type { ZoneData } from '../engine/zone';
import type { Engine } from '../engine/engine';
import type { PeerSample } from './feedTick';
import { blankState } from './netPlayer';
import type { Estate, EstateEntry, WorldLink } from './worldLink';

// Everyone else in your channel of Emberholm, as the server plays them (crates/server/src/sim/mod.rs):
// each player as they move (near you about 20 times a second; on the wire for crowds, further off
// every fourth or twentieth tick: their `every`), kept far enough behind their newest that there is
// always a next one to blend toward, with their glider, pack, vehicles and mounts; and everything
// everyone's land, their houses, farms and ships, which stay standing while they're away. Houses
// and farm posts are solid, as yours are, and so are their vehicles where you see them. This keeps
// them as they are at the moment drawn; src/render/open/peersView.ts draws them. What it hears comes
// through src/net/feedTick.ts, the same whichever way the server sends it.

/** The player fields drawing someone needs (src/render/character.ts and the life view); the server sends these. */
const SHOWN = [
  'facing',
  'mode',
  'grounded',
  'attackIndex',
  'attackFrame',
  'flipFrame',
  'landFrame',
  'landImpact',
  'takeoffFrame',
  'runPhase',
  'stun',
  'downFrame',
  'weapon',
  'comboVariants',
  'actionId',
  'actionFrame',
  'castAbility',
  'castFrame',
  'bank',
  'pack',
  'vehicle',
  'seat',
  'host',
  'glider',
  'airspeed',
  'sprinting',
  'crouching',
  'crouchFrame',
  'hp',
  'team',
] as const;

/**
 * Frame counters that go up by one a frame for as long as what they count goes on: run on between
 * updates, so someone's swing, cast or flip is drawn as smoothly as their movement.
 */
const COUNTERS = ['attackFrame', 'actionFrame', 'castFrame', 'flipFrame', 'landFrame', 'takeoffFrame', 'downFrame'] as const;

/** Frames behind the newest presence that others are drawn at (100 ms), when they come every tick. */
const DELAY = 6;
/** Frames in a server tick. */
const FRAMES_PER_TICK = 3;
/** Further than this (frames) from where they should be drawn, they're put there at once. */
const SNAP_FRAMES = 90;

interface Sample {
  fr: number;
  p: Record<string, unknown> & {
    pos: { x: number; y: number; z: number };
    vel: { x: number; y: number; z: number };
    facing: number;
    vehicles?: Vehicle[];
    packs?: Pack[];
  };
}

/** Someone else here, as drawn this frame: what the drawing reads (src/render/open/peersView.ts). */
export interface Peer {
  readonly id: number;
  readonly name: string;
  /** A bot: no invitations or challenges for it. */
  readonly bot: boolean;
  /** Playing here now; someone who left is kept for what they built, which still stands. */
  readonly online: boolean;
  /** Playing here and heard from since they came: there's someone to draw. */
  readonly drawn: boolean;
  /** Their state at the moment drawn, between the server's updates. */
  readonly shown: PlayerState;
  /** What of theirs everyone sees: houses, farms and ships, and the vehicles, packs and glider they have out. */
  readonly life: LifeView;
  /** How far they are from you (m), as of the last frame. */
  readonly away: number;
}

interface Kept {
  id: number;
  name: string;
  bot: boolean;
  online: boolean;
  drawn: boolean;
  shown: PlayerState;
  life: LifeView;
  away: number;
  samples: Sample[];
  clock: number;
  estateKey: string;
  solid: Set<string>;
  /** When we last heard from them (ms, performance.now()). */
  heard: number;
  /** Their health as last drawn, to show a blow as it lands on screen. */
  hp: number;
  /** Ticks between their refreshes (PeerSample.every). */
  every: number;
  /** Not in sight, though something of theirs is: nobody to draw. */
  hidden: boolean;
}

/** Everyone reports 20 times a second, even standing still; this long without a word, they've gone. */
const SILENT_MS = 5000;

export class WorldPeers {
  private peers = new Map<number, Kept>();
  /** Called when someone's walls or farm posts became solid, so the grass is laid round them again. */
  onGroundChanged: (() => void) | null = null;
  /** A blow landing on someone as drawn here: where, how much, and the way it pushes them. */
  onHurt: ((x: number, y: number, z: number, damage: number, dirX: number, dirZ: number) => void) | null = null;

  constructor(
    private zone: ZoneData,
    private engine: Engine,
    private mine: LifeView,
    private me: number,
    link: WorldLink,
  ) {
    for (const e of link.estates.values()) this.estate(e);
    this.receive([...link.peers.values()], null);
    link.onPeers = (list, kept) => this.receive(list, kept);
    link.onEstate = (e) => this.estate(e);
    link.onLeft = (id) => this.left(id);
  }

  /** Everyone known here, those who left too (what they built stands), as drawn this frame. */
  all(): Iterable<Peer> {
    return this.peers.values();
  }

  /**
   * For tests and the bug reporter: who is here and what of theirs is drawn, with how far they are
   * from you (metres).
   */
  list(): Array<{
    id: number;
    name: string;
    bot: boolean;
    online: boolean;
    x: number;
    y: number;
    z: number;
    mode: string;
    houses: number;
    scarecrows: number;
    vehicles: number;
    away: number;
    team: number;
    hp: number;
    weapon: number;
  }> {
    return [...this.peers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      bot: p.bot,
      online: p.online,
      x: p.shown.pos.x,
      y: p.shown.pos.y,
      z: p.shown.pos.z,
      mode: p.shown.mode,
      houses: p.life.land.houses.length,
      scarecrows: p.life.land.scarecrows.length,
      vehicles: p.life.land.vehicles.length,
      away: +p.away.toFixed(1),
      team: p.shown.team,
      hp: p.shown.hp,
      weapon: p.shown.weapon,
    }));
  }

  /** Everyone playing here now as drawn this frame, for their cast warnings. */
  shownPlayers(): PlayerState[] {
    return [...this.peers.values()].filter((p) => p.online).map((p) => p.shown);
  }

  /** Everyone playing here now (list() keeps those who left too, for what they built). */
  present(): ReturnType<WorldPeers['list']> {
    return this.list().filter((p) => p.online);
  }

  private peer(id: number, name: string): Kept {
    let p = this.peers.get(id);
    if (p) return p;
    // What of theirs everyone sees (their houses, farms, ships, vehicles and packs), to draw.
    const life = new LifeView(this.zone, newLifeState({ coins: 0, labor: 0, seed: this.zone.recipe.seed }), () => {});
    life.weather = this.mine.weather;
    p = {
      id,
      name,
      bot: false,
      online: false,
      drawn: false,
      shown: blankState(),
      life,
      away: Infinity,
      samples: [],
      clock: -1,
      estateKey: '',
      solid: new Set(),
      heard: 0,
      hp: Infinity,
      every: 1,
      hidden: false,
    };
    this.peers.set(id, p);
    return p;
  }

  /**
   * Players with a fresh state this tick, and (on the wire for crowds) those still in sight that
   * weren't refreshed; null for `kept`: everyone in sight is in `list`.
   */
  private receive(list: PeerSample[], kept: readonly number[] | null): void {
    const now = performance.now();
    for (const e of list) {
      if (e.id === this.me) continue;
      const s = e.p as Sample['p'];
      if (!s?.pos) continue;
      const p = this.peer(e.id, e.name);
      if (e.name) p.name = e.name;
      p.bot = !!e.bot;
      const fr = Number(s.fr) || 0;
      // A newer page (they reloaded) starts its frames again from zero.
      if (p.samples.length && fr <= p.samples[p.samples.length - 1].fr - 600) p.samples = [];
      if (p.samples.length && fr <= p.samples[p.samples.length - 1].fr) continue;
      const every = Math.max(1, e.every);
      const before = p.samples[p.samples.length - 1];
      // Quiet for longer than they come: they stood as they were until just before this one.
      if (before && fr - before.fr > FRAMES_PER_TICK * (every + 1)) p.samples.push({ fr: fr - FRAMES_PER_TICK * every, p: before.p });
      p.heard = now;
      p.every = every;
      p.hidden = !!e.hidden;
      p.samples.push({ fr, p: s });
      if (p.samples.length > 30) p.samples.shift();
      if (!p.online) {
        p.online = true;
        p.clock = -1;
      }
    }
    if (!kept) return;
    // On the wire: those in sight but not refreshed are still here; anyone else has gone from sight.
    const inSight = new Set<number>(kept);
    for (const e of list) inSight.add(e.id);
    for (const p of this.peers.values()) {
      if (!p.online) continue;
      if (inSight.has(p.id)) p.heard = now;
      else this.left(p.id);
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
    const s = p.life.land;
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
      this.engine.addSolidHouse({ ...h, id: -(e.id * 100_000 + h.id) });
      changed = true;
    }
    for (const sc of s.scarecrows) {
      const k = `s${sc.id}`;
      if (p.solid.has(k)) continue;
      p.solid.add(k);
      this.engine.addSolidScarecrow(sc);
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
    p.drawn = false;
    p.samples = [];
    p.life.land.vehicles = [];
    p.life.land.packs = [];
  }

  /** Everyone's vehicles as drawn, with the seats taken in them (`you` too), for the prompt to ride along. */
  vehicles(you: PlayerState): OthersVehicle[] {
    const seated = (q: PlayerState) => (q.mode === 'ride' && q.host ? `${q.host}:${q.vehicle}` : '');
    const riders = [...this.peers.values()]
      .filter((p) => p.online)
      .map((p) => p.shown)
      .concat(you);
    const out: OthersVehicle[] = [];
    for (const p of this.peers.values()) {
      if (!p.online) continue;
      for (const v of p.life.land.vehicles) {
        const here = `${p.id}:${v.id}`;
        out.push({ host: p.id, name: p.name, vehicle: v, taken: riders.filter((q) => seated(q) === here).map((q) => q.seat) });
      }
    }
    return out;
  }

  /**
   * Brings everyone to the moment they're drawn this frame (`dt` seconds on), with their vehicles,
   * packs and gliders; their vehicles are as solid to you as yours are, where you see them.
   */
  frame(dt: number): void {
    const now = performance.now();
    const me = this.engine.player.pos;
    const movers: Mover[] = [];
    for (const p of this.peers.values()) {
      if (p.online && now - p.heard > SILENT_MS) this.left(p.id);
      p.life.state.clock = this.mine.state.clock;
      p.life.weather = this.mine.weather;
      p.life.now = this.mine.now;
      if (p.online && p.samples.length) this.pose(p, dt);
      for (const v of p.life.land.vehicles) movers.push(...vehicleBodies(v));
      p.away = Math.hypot(p.shown.pos.x - me.x, p.shown.pos.y - me.y, p.shown.pos.z - me.z);
    }
    this.engine.setOthersVehicles(movers);
  }

  private pose(p: Kept, dt: number): void {
    const samples = p.samples;
    const newest = samples[samples.length - 1].fr;
    // Those refreshed less often are drawn further behind, so there's still a next one to blend toward.
    const target = newest - DELAY - FRAMES_PER_TICK * (p.every - 1);
    if (p.clock < 0 || Math.abs(p.clock - target) > SNAP_FRAMES) p.clock = target;
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
    sh.team = Number(sh.team) || 0;
    // A blow shows the moment the drawn them takes it.
    if (sh.hp < p.hp) this.onHurt?.(sh.pos.x, sh.pos.y + 1.1, sh.pos.z, p.hp - sh.hp, -Math.sin(sh.facing), -Math.cos(sh.facing));
    p.hp = sh.hp;

    // Their vehicles glide between updates the same way; packs ride on whatever carries them.
    const before = new Map((a.p.vehicles ?? []).map((v) => [v.id, v]));
    p.life.land.vehicles = (b.p.vehicles ?? []).map((v) => {
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
    p.life.land.packs = b.p.packs ?? [];
    p.life.state.glider = sh.glider;
    // Only their things in sight: nobody to draw.
    p.drawn = !p.hidden;
  }
}

function lerp3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, t: number): { x: number; y: number; z: number } {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}
