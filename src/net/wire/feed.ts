import { GLIDERS, MOUNTS, VEHICLES } from '../../content/vehicles';
import { PACKS } from '../../content/trade';
import type { Pack, Vehicle } from '../../engine/life';
import type { FeedTick, PeerSample } from '../feedTick';
import type { ArrowRecord, MeteorRecord, NetActor } from '../worldFeed';
import { ackBytes, type Ent, Heard, type State } from './heard';
import { EVERY, FRAMES_PER_TICK, fieldIndex, guess, kindNamed, MODES, YOU } from './schema';

// The wire for crowds into the feed (src/net/feedTick.ts): what this browser has heard of the world
// (heard.ts), turned each update into the same FeedTick today's JSON ticks become, so nothing that
// draws the world knows which way it came. Fields go back into metres, radians and the content's ids;
// a player's vehicles and packs are gathered under them; and what's near but wasn't sent, because
// nothing about it changed but what runs on by itself, is run on to now, as the server guessed it
// would be.

const TAU = Math.PI * 2;
/** 65536ths of a turn to radians. */
const turn = (q: number): number => (q / 65536) * TAU;
const RIDEABLES = [...VEHICLES, ...MOUNTS];

/** A pack on someone's back has no id of its own on the wire: this stands in for it. */
export const ON_BACK = -1;
/** A pack in a vehicle's cargo slot neither: one of these does, by the vehicle and the slot. */
const cargoPack = (vehicle: number, slot: number): number => -(2 + vehicle * 100 + slot);

const PLAYER = kindNamed('player');
const CREATURE = kindNamed('creature');
const VEHICLE = kindNamed('vehicle');
const P = Object.fromEntries(PLAYER.fields.map((f, i) => [f.name, i])) as Record<string, number>;
const C = Object.fromEntries(CREATURE.fields.map((f, i) => [f.name, i])) as Record<string, number>;
const V = Object.fromEntries(VEHICLE.fields.map((f, i) => [f.name, i])) as Record<string, number>;
const CARGO0 = fieldIndex(VEHICLE, 'cargo0');

/** An entity's newest state run on to `tick`, as the server guessed it would run. */
function runOn(e: Ent, tick: number): State {
  const s = e.states[e.states.length - 1];
  const ticks = (tick - s.tick) >>> 0;
  if (ticks === 0) return s;
  const fields = new Int32Array(s.fields.length);
  e.kind.fields.forEach((f, i) => {
    fields[i] = guess(f.run, s.fields[i], ticks);
  });
  return { seq: s.seq, tick, fields };
}

interface Things {
  vehicles: Vehicle[];
  packs: Pack[];
  /** Something of theirs has a fresh state this tick. */
  fresh: boolean;
  /** Where one of their things is (for an owner not in sight). */
  at: { x: number; y: number; z: number };
}

function vehicleOf(id: number, def: number, f: Int32Array, things: Things): Vehicle {
  const d = RIDEABLES[def];
  const cargo: number[] = [];
  for (let k = 0; k < 16; k++) {
    const pack = f[CARGO0 + k];
    if (pack <= 0) continue;
    while (cargo.length < k) cargo.push(0);
    const pid = cargoPack(id, k);
    cargo[k] = pid;
    things.packs.push({ id: pid, def: PACKS[pack - 1]?.id ?? '', made: 0, origin: '', at: 'cargo', x: 0, y: 0, z: 0, rot: 0, vehicle: id, slot: k });
  }
  return {
    id,
    def: d?.id ?? '',
    x: f[V.x] / 100,
    y: f[V.y] / 100,
    z: f[V.z] / 100,
    heading: turn(f[V.heading]),
    vx: 0,
    vy: 0,
    vz: 0,
    speed: f[V.speed] / 100,
    steer: f[V.steer] / 1000,
    throttle: f[V.throttle] / 1000,
    sail: f[V.sail] / 1000,
    grounded: (f[V.flags] & 1) !== 0,
    pitch: turn(f[V.pitch]),
    roll: turn(f[V.roll]),
    hp: (d as { hp?: number } | undefined)?.hp ?? 1,
    cargo,
    ridden: false,
    swimming: (f[V.flags] & 2) !== 0,
  };
}

/** A player's presence, in the shape the JSON ticks carry (worldPeers.ts SHOWN, crates/server presence_json). */
function presence(f: Int32Array, tick: number, host: number, things: Things | undefined): Record<string, unknown> {
  const flags = f[P.flags];
  const packs = [...(things?.packs ?? [])];
  if (f[P.pack] > 0)
    packs.push({ id: ON_BACK, def: PACKS[f[P.pack] - 1]?.id ?? '', made: 0, origin: '', at: 'back', x: 0, y: 0, z: 0, rot: 0, vehicle: 0, slot: 0 });
  return {
    fr: tick * FRAMES_PER_TICK,
    pos: { x: f[P.x] / 100, y: f[P.y] / 100, z: f[P.z] / 100 },
    vel: { x: f[P.vx] / 100, y: f[P.vy] / 100, z: f[P.vz] / 100 },
    facing: turn(f[P.facing]),
    mode: MODES[f[P.mode]] ?? 'normal',
    grounded: (flags & 1) !== 0,
    sprinting: (flags & 2) !== 0,
    crouching: (flags & 4) !== 0,
    attackIndex: f[P.attackIndex],
    attackFrame: f[P.attackFrame],
    flipFrame: f[P.flipFrame],
    landFrame: f[P.landFrame],
    landImpact: f[P.landImpact] / 100,
    takeoffFrame: f[P.takeoffFrame],
    runPhase: f[P.run] / 100,
    stun: f[P.stun],
    downFrame: f[P.downFrame],
    team: f[P.team],
    weapon: f[P.weapon],
    comboVariants: f[P.comboVariants],
    actionId: f[P.actionId],
    actionFrame: f[P.actionFrame],
    castAbility: f[P.castAbility],
    castFrame: f[P.castFrame],
    bank: f[P.bank] / 1000,
    pack: f[P.pack] > 0 ? ON_BACK : 0,
    vehicle: f[P.vehicle],
    seat: f[P.seat],
    host,
    glider: f[P.glider] > 0 ? (GLIDERS[f[P.glider] - 1]?.id ?? '') : '',
    airspeed: f[P.airspeed] / 100,
    crouchFrame: f[P.crouchFrame],
    hp: f[P.hp] / 100,
    vehicles: things?.vehicles ?? [],
    packs,
  };
}

/** A presence for an owner out of sight whose things are in sight: where one of them is, and them. */
function hiddenPresence(tick: number, things: Things): Record<string, unknown> {
  const f = new Int32Array(PLAYER.fields.length);
  f[P.x] = Math.round(things.at.x * 100);
  f[P.y] = Math.round(things.at.y * 100);
  f[P.z] = Math.round(things.at.z * 100);
  for (const name of ['attackFrame', 'castFrame', 'actionFrame', 'flipFrame', 'downFrame']) f[P[name]] = -1;
  return presence(f, tick, 0, things);
}

export class WireFeed {
  readonly heard = new Heard();

  /** The acknowledgement to send back after an update, as bytes. */
  ack(): ArrayBuffer {
    return ackBytes(this.heard.ack());
  }

  /** Forgets everything heard (you went to another space; the server forgets what it sent). */
  reset(): void {
    this.heard.reset();
  }

  /**
   * An update's bytes, heard: what the feed takes from it, or null if it was stale or broken (dropped,
   * and not acknowledged). `me`: your character's id, which handle 1 (you) stands for.
   */
  hear(bytes: Uint8Array, me: number): FeedTick | null {
    const done = this.heard.hear(bytes);
    if (!done) return null;
    const tick = done.tick;
    const fresh = new Set(done.fresh);
    const ents = this.heard.ents;
    // Each one as of now: freshly sent; near and not sent, run on (nothing but what runs on changed,
    // or it would have been sent); further off and not sent, not known (null).
    const now = (h: number, e: Ent): State | null => (fresh.has(h) ? e.states[e.states.length - 1] : e.tier === 'near' ? runOn(e, tick) : null);
    // Handles to the game's ids, for what names another (a rider's host, an arrow's shooter).
    const idOf = (h: number): number => {
      if (h === YOU) return me;
      const e = ents.get(h);
      return e?.intro.kind === 'player' ? e.intro.id : 0;
    };

    // Vehicles and packs on the ground, under their owners.
    const things = new Map<number, Things>();
    const owned = (owner: number, x: number, y: number, z: number): Things => {
      let t = things.get(owner);
      if (!t) {
        t = { vehicles: [], packs: [], fresh: false, at: { x, y, z } };
        things.set(owner, t);
      }
      return t;
    };
    for (const [h, e] of ents) {
      const i = e.intro;
      if (i.kind !== 'vehicle' && i.kind !== 'item') continue;
      const s = now(h, e) ?? e.states[e.states.length - 1];
      const f = s.fields;
      const t = owned(i.owner, f[0] / 100, f[2] / 100, f[1] / 100);
      t.fresh ||= fresh.has(h);
      if (i.kind === 'vehicle') t.vehicles.push(vehicleOf(i.id, i.def, f, t));
      else
        t.packs.push({
          id: i.id,
          def: PACKS[i.def]?.id ?? '',
          made: 0,
          origin: '',
          at: 'ground',
          x: f[0] / 100,
          y: f[2] / 100,
          z: f[1] / 100,
          rot: turn(f[3]),
          vehicle: 0,
          slot: 0,
        });
    }

    const out: FeedTick = { tick, peers: [], kept: [], actors: [], actorsKept: [], arrows: [], meteors: [], events: [] };
    for (const [h, e] of ents) {
      const i = e.intro;
      if (i.kind === 'player') {
        let s = now(h, e);
        const theirs = things.get(i.id);
        // Further off and not sent, but something of theirs was: they were due too (their vehicles go
        // with them), so nothing about them changed but what runs on.
        if (!s && theirs?.fresh) s = runOn(e, tick);
        things.delete(i.id);
        if (!s) {
          out.kept?.push(i.id);
          continue;
        }
        const sample: PeerSample = { id: i.id, name: i.name, bot: i.bot, every: EVERY[e.tier], p: presence(s.fields, tick, idOf(s.fields[P.host]), theirs) };
        out.peers.push(sample);
      } else if (i.kind === 'creature') {
        const s = now(h, e);
        if (!s) {
          out.actorsKept?.push(i.id);
          continue;
        }
        const f = s.fields;
        const wait = f[C.wait];
        const a: NetActor = {
          id: i.id,
          kind: f[C.kind],
          x: f[C.x] / 100,
          y: f[C.y] / 100,
          z: f[C.z] / 100,
          facing: turn(f[C.facing]),
          state: f[C.state],
          progress: wait > 0 ? Math.min(1, Math.max(0, f[C.stateFrame] / wait)) : 0,
          hp: f[C.hp] / 10000,
          deadFrame: f[C.deadFrame],
          targetX: f[C.targetX] / 100,
          targetZ: f[C.targetZ] / 100,
          every: EVERY[e.tier],
        };
        out.actors.push(a);
      } else if (i.kind === 'arrow') {
        // As of the tick its state is from: it flies on from there.
        const s = e.states[e.states.length - 1];
        const f = s.fields;
        const arrow: ArrowRecord = {
          id: i.id,
          owner: idOf(f[6]),
          mine: f[6] === YOU,
          x: f[0] / 100,
          y: f[2] / 100,
          z: f[1] / 100,
          vx: f[3] / 100,
          vz: f[4] / 100,
          team: f[5],
          tick: s.tick,
        };
        out.arrows.push(arrow);
      } else if (i.kind === 'meteor') {
        const s = e.states[e.states.length - 1];
        const f = s.fields;
        const meteor: MeteorRecord = { id: i.id, x: f[0] / 100, z: f[1] / 100, ticksLeft: f[2], fallTicks: f[3], team: f[4], radius: f[5] / 100, tick: s.tick };
        out.meteors.push(meteor);
      }
    }
    // Owners out of sight whose things are in sight: nobody to draw, but their things are.
    for (const [owner, t] of things) {
      if (t.fresh) out.peers.push({ id: owner, name: '', bot: false, every: 1, hidden: true, p: hiddenPresence(tick, t) });
      else out.kept?.push(owner);
    }
    out.events = done.events.map((e) => ({ kind: e[3], x: e[0] / 100, y: e[2] / 100, z: e[1] / 100, size: e[4] }));
    return out;
  }
}
