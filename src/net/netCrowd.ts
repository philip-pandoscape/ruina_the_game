import type { CrowdSource } from '../crowd/crowdView';
import { ActorTimeline } from './actorTimeline';
import { ON_FOOT, type Mode, type PlayerState } from '../sim/types';
import { resolveSkills, SKILL_WORDS } from '../skills';
import { HOTBAR_SLOTS, MOVEMENT_SKILL_CAP, MOVEMENT_SLOTS, NO_ABILITY, NO_MOVEMENT, variantBits } from '../tuning';
import { TAU } from '../util/math';

// The raw per-input bytes: move_x, move_z, buttons, aim_x, aim_z, slot, movement held, face.
export type RawInput = [number, number, number, number, number, number, number, number];

// Receives the battle from the Rust server (crates/server/src/protocol.rs describes the bytes) and
// smoothly moves each fighter between updates. Nearby fighters arrive 20 times a second,
// mid-range ones 5 times, and everyone else once a second. Also carries real players: the
// others near you, and your own exact state for correcting the browser's prediction.

const MSG_WELCOME = 1;
const MSG_SNAPSHOT = 2;
const MSG_FAR = 3;
const MSG_STATS = 4;
const SEND_VIEW = 1;
const SEND_INPUT = 3;
const SEND_JOIN = 4;
const SEND_LAG = 5;
const SEND_BUILD = 6;

const PLAYER_ENTRY = 31;
// Must match YOU_ENTRY in crates/server/src/protocol.rs: id + ack + 16 f64 + (16 + a cooldown per hotbar
// slot and per possible movement skill) i16 + the learned set + (17 + hotbar + movement slots) u8.
const YOU_F64S = 16;
const YOU_I16S = 16 + HOTBAR_SLOTS + MOVEMENT_SKILL_CAP;
const YOU_U8S = 17 + HOTBAR_SLOTS + MOVEMENT_SLOTS;
const YOU_ENTRY = 2 + 4 + YOU_F64S * 8 + YOU_I16S * 2 + SKILL_WORDS * 4 + YOU_U8S;
const ARROW_ENTRY = 15;
const METEOR_ENTRY = 10;
// Must match ACTOR_ENTRY in crates/server/src/protocol.rs.
const ACTOR_ENTRY = 19;
const EVENT_ENTRY = 8;
// Order must match Mode in crates/engine/src/player.rs; MODE_DOWN sits one past the last of these.
export const MODES: Mode[] = ['normal', 'attack', 'cast', 'action', 'swim', 'glide', 'ride'];
export const MODE_DOWN = 7;

// Another real player near you, as of the latest update.
export interface RemoteRecord {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  mode: number; // 0 normal, 1 slide, 2 attack, 3 cast, 4 knocked down
  team: number;
  grounded: boolean;
  attackIndex: number;
  attackFrame: number;
  flipFrame: number;
  hp: number;
  stun: number;
  landFrame: number;
  weapon: number;
  comboVariants: number;
  actionId: number;
  actionFrame: number;
  castAbility: number;
  castFrame: number;
  castTargetX: number;
  castTargetZ: number;
}

export interface ArrowRecord {
  id: number;
  owner: number; // player id of the shooter
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  team: number;
}

export interface MeteorRecord {
  id: number;
  x: number;
  z: number;
  ticksLeft: number;
  fallTicks: number;
  team: number;
  radius: number; // the effect's own radius, so any delayedArea draws at its real size
}

// Something that just happened, for effects: 1 heal, 2 explosion, 3 arrow hit.
/** One actor as the server sees it. The browser knows the rest from shared/actors.json. */
export interface NetActor {
  id: number;
  /** Index into the kinds in shared/actors.json. */
  kind: number;
  x: number;
  y: number;
  z: number;
  facing: number;
  /** Which behaviour state it is in, and how far through it. */
  state: number;
  progress: number;
  /** 0..1 of its maximum. */
  hp: number;
  /** -1 while alive, otherwise frames since it went down. */
  deadFrame: number;
  /** Where a slam it is winding up will land. */
  targetX: number;
  targetZ: number;
}

export interface EffectEvent {
  kind: number;
  x: number;
  y: number;
  z: number;
  size: number;
}

function readYou(v: DataView, o: number): { id: number; ack: number; player: PlayerState } {
  const I16S = o + 6 + YOU_F64S * 8; // after the f64 block
  const SKILLS_AT = I16S + YOU_I16S * 2;
  const U8S = SKILLS_AT + SKILL_WORDS * 4;
  const skills = Array.from({ length: SKILL_WORDS }, (_, k) => v.getUint32(SKILLS_AT + k * 4, true));
  const f = (k: number) => v.getFloat64(o + 6 + k * 8, true);
  const i = (k: number) => v.getInt16(I16S + k * 2, true);
  const b = (k: number) => v.getUint8(U8S + k);
  const pos = { x: f(0), y: f(1), z: f(2) };
  return {
    id: v.getUint16(o, true),
    ack: v.getUint32(o + 2, true),
    player: {
      pos,
      prevPos: { ...pos },
      vel: { x: f(3), y: f(4), z: f(5) },
      facing: f(6),
      prevFacing: f(6),
      actionDirX: f(7),
      actionDirZ: f(8),
      landImpact: f(9),
      runPhase: f(10),
      hp: f(11),
      castTargetX: f(12),
      castTargetZ: f(13),
      stamina: f(14),
      mp: f(15),
      jumpsUsed: i(0),
      coyote: i(1),
      jumpBuffer: i(2),
      attackBuffer: i(3),
      actionBuffer: i(4),
      attackFrame: i(5),
      flipFrame: i(6),
      landFrame: i(7),
      takeoffFrame: i(8),
      stun: i(9),
      downFrame: i(10),
      abilityBuffer: i(11),
      castFrame: i(12),
      crouchFrame: i(13),
      actionFrame: i(14),
      staminaDelay: i(15),
      cooldowns: Array.from({ length: HOTBAR_SLOTS }, (_, k) => i(16 + k)),
      movementCooldowns: Array.from({ length: MOVEMENT_SKILL_CAP }, (_, k) => i(16 + HOTBAR_SLOTS + k)),
      skills,
      comboVariants: variantBits(resolveSkills(skills)),
      mode: MODES[b(0)] ?? 'normal',
      grounded: b(1) === 1,
      jumpCutDone: b(2) === 1,
      attackIndex: b(3),
      attackQueued: b(4) === 1,
      attackHit: b(5) === 1,
      team: b(6),
      weapon: b(7),
      castAbility: b(8),
      castSlot: b(9),
      firedAbility: b(10),
      abilityBufferSlot: b(11),
      sprinting: b(12) === 1,
      crouching: b(13) === 1,
      actionId: b(14),
      actionSlot: b(15),
      ...ON_FOOT,
      actionBufferId: b(16),
      abilities: Array.from({ length: HOTBAR_SLOTS }, (_, k) => b(17 + k)),
      movement: Array.from({ length: MOVEMENT_SLOTS }, (_, k) => b(17 + HOTBAR_SLOTS + k)),
    },
  };
}

const FLAG_TEAM = 1;
const FLAG_DOWN = 2;
const NEAR_ENTRY = 10;
const MID_ENTRY = 8;

// How long to take moving to each new position: a little longer than the gap between updates,
// so fighters keep moving smoothly instead of stopping and starting.
const NEAR_MS = 70;
const MID_MS = 230;
const FAR_MS = 1050;
const FINE_HOLD_MS = 600; // ignore coarse once-a-second positions for fighters we've seen up close
// A jump bigger than TELEPORT_SLACK + TELEPORT_SPEED × (seconds since the last update) is a teleport.
const TELEPORT_SLACK = 2; // metres
const TELEPORT_SPEED = 8; // m/s, faster than any fighter runs
// Other players (and monsters) are drawn this many server ticks behind the newest update (100 ms
// at 20 Hz), so there's always a next update to blend toward.
export const INTERP_TICKS = 2;

export interface ServerStats {
  tick: number;
  bots: number;
  alive: number;
  realPlayers: number;
  virtualPlayers: number;
  tickMs: number;
  simMs: number;
  updatesMs: number;
  bytesPerPlayer: number;
  dropped: number;
  pvpHits: number;
  botHitsOnPlayers: number;
  rewindMs: number; // average rewind applied to player-vs-player hits
  savedByRewind: number; // hits that only landed because of lag compensation
  hitsOnBots: number;
}

export class NetCrowd implements CrowdSource {
  n = 0;
  rx = new Float32Array(0);
  rz = new Float32Array(0);
  ryaw = new Float32Array(0);
  rspeed = new Float32Array(0);
  down = new Uint8Array(0);
  known = new Uint8Array(0);
  swings = new Uint8Array(0);
  hp = new Uint8Array(0); // 0..255 of full health; only fighters in the near set keep this current
  team = new Uint8Array(0);
  teleported = new Uint8Array(0); // set when a fighter jumps (respawns); the renderer clears it

  connected = false;
  everConnected = false;
  stats: ServerStats | null = null;
  bytesPerSec = 0;
  messagesPerSec = 0;
  onReady: ((n: number) => void) | null = null;

  // Real players: your own exact state (once you've joined) and the other players near you.
  you: { id: number; ack: number; player: PlayerState } | null = null;
  players: RemoteRecord[] = [];
  arrows: ArrowRecord[] = []; // arrows in flight near you, as of server tick arrowsTick
  arrowsTick = 0;
  meteors: MeteorRecord[] = [];
  events: EffectEvent[] = []; // effects to show; the game takes them out as it shows them
  /** Monsters, NPCs and props near you, as the server last described them. */
  actors: NetActor[] = [];
  /** The last second of those descriptions, for drawing them between updates (actorTimeline.ts). */
  readonly actorTimeline = new ActorTimeline();
  snapshots = 0; // counts up with every update, so the game can tell when new data has arrived
  lastTick = 0; // server tick of the newest update
  private tickMs = 50;
  private tickOffset: number | null = null; // smoothed (arrival time − tick × tickMs)

  private fromX = new Float32Array(0);
  private fromZ = new Float32Array(0);
  private toX = new Float32Array(0);
  private toZ = new Float32Array(0);
  private fromYaw = new Float32Array(0);
  private toYaw = new Float32Array(0);
  private start = new Float64Array(0);
  private dur = new Float32Array(0);
  private lastFine = new Float64Array(0);
  private ws: WebSocket | null = null;
  /** Open worlds: where inputs go instead of a battlefield socket (src/net/worldLink.ts). */
  private sender: ((seq: number, view: number, raw: RawInput, stick: [number, number]) => void) | null = null;
  private bytes = 0;
  private messages = 0;
  private rateStart = performance.now();

  private url = '';

  constructor(url: string | null) {
    if (url === null) return;
    // The battlefield lives at /ws/battle on the game server; a bare ws://host:port means it.
    this.url = /^wss?:\/\/[^/]+\/?$/.test(url) ? `${url.replace(/\/$/, '')}/ws/battle` : url;
    const ws = (this.ws = new WebSocket(this.url));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => (this.connected = this.everConnected = true);
    ws.onclose = () => {
      this.connected = false;
      if (this.everConnected) this.waitForServer();
    };
    ws.onmessage = (e) => this.receive(e.data as ArrayBuffer);
  }

  /**
   * For an open world, which the server plays over its own connection (src/net/worldLink.ts):
   * inputs go to `send`, and what the server says arrives through applyWorld(). Everything that
   * reads a NetCrowd (prediction, other players' spells, the monsters) works the same.
   */
  static detached(send: (seq: number, view: number, raw: RawInput, stick: [number, number]) => void): NetCrowd {
    const n = new NetCrowd(null);
    n.sender = send;
    n.connected = n.everConnected = true;
    return n;
  }

  /**
   * Open worlds: you've gone into another game (a dungeon's copy, or back out), whose ticks count
   * from somewhere else: what came before is forgotten, and the clock lines up again on the next.
   */
  resetWorld(): void {
    this.tickOffset = null;
    this.actors = [];
    this.arrows = [];
    this.meteors = [];
    this.actorTimeline.reset();
  }

  /** Open worlds: one tick from the server (already turned into the battlefield's shapes). */
  applyWorld(
    tick: number,
    you: { id: number; ack: number; player: PlayerState },
    arrows: ArrowRecord[],
    meteors: MeteorRecord[],
    events: EffectEvent[],
    actors: NetActor[],
  ): void {
    this.noteTick(tick, performance.now());
    this.you = you;
    this.arrows = arrows;
    this.meteors = meteors;
    this.events.push(...events);
    this.actors = actors;
    this.actorTimeline.push(tick, actors, performance.now());
    this.arrowsTick = this.lastTick;
    this.snapshots++;
  }

  // The server went away (usually restarted with new code): reload the page once it's back, so
  // the game reconnects and joins again by itself.
  private waitForServer(): void {
    const probe = new WebSocket(this.url);
    probe.onopen = () => {
      probe.close();
      location.reload();
    };
    probe.onerror = () => setTimeout(() => this.waitForServer(), 1500);
  }

  private send(bytes: Uint8Array<ArrayBuffer>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(bytes);
  }

  // Ask to play as a fighter (team 0 or 1, or 255 for either).
  join(team: number): void {
    this.send(new Uint8Array([SEND_JOIN, team]));
  }

  // Testing: ask the server to delay this connection's traffic by `ms` each way.
  setLag(ms: number): void {
    this.send(new Uint8Array([SEND_LAG, ms & 255, (ms >> 8) & 255]));
  }

  // One frame of input: sequence number, the server tick on screen (× 16, for rewinding hits),
  // and the rounded stick, buttons and aim bytes.
  sendInput(seq: number, view: number, raw: RawInput, stick: [number, number] = [0, 0]): void {
    if (this.sender) {
      this.sender(seq, view, raw, stick);
      return;
    }
    const msg = new DataView(new ArrayBuffer(2 + 8 + raw.length));
    msg.setUint8(0, SEND_INPUT);
    msg.setUint8(1, 1);
    msg.setUint32(2, seq, true);
    msg.setUint32(6, view, true);
    raw.forEach((byte, k) => msg.setUint8(10 + k, byte));
    this.send(new Uint8Array(msg.buffer));
  }

  // Your skills and loadout, one ability per hotbar slot. The server checks it before using it.
  sendBuild(skills: number[], weapon: number, abilities: number[], movement: number[]): void {
    const base = 2 + SKILL_WORDS * 4;
    const out = new Uint8Array(base + HOTBAR_SLOTS + MOVEMENT_SLOTS);
    const v = new DataView(out.buffer);
    out[0] = SEND_BUILD;
    out[1] = weapon;
    for (let k = 0; k < SKILL_WORDS; k++) v.setUint32(2 + k * 4, skills[k] ?? 0, true);
    for (let k = 0; k < HOTBAR_SLOTS; k++) out[base + k] = abilities[k] ?? NO_ABILITY;
    for (let k = 0; k < MOVEMENT_SLOTS; k++) out[base + HOTBAR_SLOTS + k] = movement[k] ?? NO_MOVEMENT;
    this.send(out);
  }

  // Keeps a running estimate of how server ticks line up with this browser's clock.
  private noteTick(tick: number, now: number): void {
    this.lastTick = tick;
    const offset = now - tick * this.tickMs;
    if (this.tickOffset === null || Math.abs(offset - this.tickOffset) > 300) this.tickOffset = offset;
    else this.tickOffset += (offset - this.tickOffset) * 0.05;
  }

  // The (fractional) server tick that other players are drawn at right now.
  renderTick(now: number): number {
    if (this.tickOffset === null) return 0;
    return (now - this.tickOffset) / this.tickMs - INTERP_TICKS;
  }

  get ticksPerSecond(): number {
    return 1000 / this.tickMs;
  }

  // Tells the server where the player is, so it knows which fighters count as nearby.
  sendView(x: number, z: number): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const msg = new DataView(new ArrayBuffer(9));
    msg.setUint8(0, SEND_VIEW);
    msg.setFloat32(1, x, true);
    msg.setFloat32(5, z, true);
    this.ws.send(msg.buffer);
  }

  private allocate(n: number): void {
    this.n = n;
    const f32 = () => new Float32Array(n);
    this.rx = f32();
    this.rz = f32();
    this.ryaw = f32();
    this.rspeed = f32();
    this.fromX = f32();
    this.fromZ = f32();
    this.toX = f32();
    this.toZ = f32();
    this.fromYaw = f32();
    this.toYaw = f32();
    this.dur = f32().fill(1);
    this.start = new Float64Array(n);
    this.lastFine = new Float64Array(n).fill(-1e9);
    this.down = new Uint8Array(n);
    this.known = new Uint8Array(n);
    this.hp = new Uint8Array(n).fill(255);
    this.swings = new Uint8Array(n);
    this.team = new Uint8Array(n);
    this.teleported = new Uint8Array(n);
  }

  // Starts a new smooth move for fighter i, from where it's drawn right now to the new position.
  private moveTo(i: number, x: number, z: number, yaw: number, flags: number, now: number, ms: number): void {
    // Further than anyone could run since the last update (e.g. respawning at the back of the
    // army): jump straight there instead of sliding across the battlefield.
    const jx = x - this.toX[i];
    const jz = z - this.toZ[i];
    const possible = TELEPORT_SLACK + TELEPORT_SPEED * ((now - this.start[i]) / 1000);
    const teleport = this.known[i] === 1 && jx * jx + jz * jz > possible * possible;
    if (!this.known[i] || teleport) {
      this.known[i] = 1;
      this.fromX[i] = this.toX[i] = this.rx[i] = x;
      this.fromZ[i] = this.toZ[i] = this.rz[i] = z;
      this.fromYaw[i] = this.toYaw[i] = this.ryaw[i] = yaw;
      if (teleport) this.teleported[i] = 1;
    } else {
      this.fromX[i] = this.rx[i];
      this.fromZ[i] = this.rz[i];
      this.fromYaw[i] = this.ryaw[i];
      this.toX[i] = x;
      this.toZ[i] = z;
      this.toYaw[i] = yaw;
    }
    this.start[i] = now;
    this.dur[i] = ms;
    this.team[i] = flags & FLAG_TEAM ? 1 : 0;
    this.down[i] = flags & FLAG_DOWN ? 1 : 0;
  }

  private receive(buf: ArrayBuffer): void {
    this.bytes += buf.byteLength;
    this.messages++;
    const v = new DataView(buf);
    const type = v.getUint8(0);
    const now = performance.now();

    if (type === MSG_WELCOME) {
      this.allocate(v.getUint32(1, true));
      const hz = v.getUint8(5);
      if (hz > 0) this.tickMs = 1000 / hz;
      this.onReady?.(this.n);
    } else if (type === MSG_SNAPSHOT && this.n) {
      this.noteTick(v.getUint32(1, true), now);
      let o = 5;
      const near = v.getUint16(o, true);
      o += 2;
      for (let k = 0; k < near; k++, o += NEAR_ENTRY) {
        const id = v.getUint16(o, true);
        const yaw = (v.getUint8(o + 6) / 256) * TAU;
        this.moveTo(id, v.getInt16(o + 2, true) / 100, v.getInt16(o + 4, true) / 100, yaw, v.getUint8(o + 7), now, NEAR_MS);
        this.swings[id] = v.getUint8(o + 8);
        this.hp[id] = v.getUint8(o + 9);
        this.lastFine[id] = now;
      }
      const mid = v.getUint16(o, true);
      o += 2;
      for (let k = 0; k < mid; k++, o += MID_ENTRY) {
        const id = v.getUint16(o, true);
        const yaw = (v.getUint8(o + 6) / 256) * TAU;
        this.moveTo(id, v.getInt16(o + 2, true) / 100, v.getInt16(o + 4, true) / 100, yaw, v.getUint8(o + 7), now, MID_MS);
        this.lastFine[id] = now;
      }
      // Real players near you, then your own exact state (if you've joined).
      if (o < v.byteLength) {
        const count = v.getUint8(o);
        o += 1;
        const list: RemoteRecord[] = [];
        for (let k = 0; k < count; k++, o += PLAYER_ENTRY) {
          const flags = v.getUint8(o + 14);
          list.push({
            id: v.getUint16(o, true),
            x: v.getInt16(o + 2, true) / 100,
            y: v.getInt16(o + 4, true) / 100,
            z: v.getInt16(o + 6, true) / 100,
            yaw: (v.getUint8(o + 8) / 256) * TAU,
            vx: v.getInt16(o + 9, true) / 100,
            vz: v.getInt16(o + 11, true) / 100,
            mode: v.getUint8(o + 13),
            team: flags & 1,
            grounded: (flags & 2) !== 0,
            attackIndex: v.getUint8(o + 15),
            attackFrame: v.getUint8(o + 16),
            flipFrame: v.getInt8(o + 17),
            hp: v.getUint8(o + 18),
            stun: v.getUint8(o + 19),
            landFrame: v.getUint8(o + 20),
            weapon: v.getUint8(o + 21),
            comboVariants: v.getUint8(o + 22),
            castAbility: v.getUint8(o + 23),
            castFrame: v.getUint8(o + 24),
            castTargetX: v.getInt16(o + 25, true) / 100,
            castTargetZ: v.getInt16(o + 27, true) / 100,
            actionId: v.getUint8(o + 29),
            actionFrame: v.getUint8(o + 30),
          });
        }
        this.players = list;
        if (v.getUint8(o) === 1) {
          this.you = readYou(v, o + 1);
          o += YOU_ENTRY;
        }
        o += 1;
        // Arrows in flight, meteors falling, and effects that just happened, near you.
        const arrows: ArrowRecord[] = [];
        for (let k = v.getUint8(o++); k > 0; k--, o += ARROW_ENTRY) {
          arrows.push({
            id: v.getUint16(o, true),
            owner: v.getUint16(o + 2, true),
            x: v.getInt16(o + 4, true) / 100,
            y: v.getInt16(o + 6, true) / 100,
            z: v.getInt16(o + 8, true) / 100,
            vx: v.getInt16(o + 10, true) / 100,
            vz: v.getInt16(o + 12, true) / 100,
            team: v.getUint8(o + 14),
          });
        }
        const meteors: MeteorRecord[] = [];
        for (let k = v.getUint8(o++); k > 0; k--, o += METEOR_ENTRY) {
          meteors.push({
            id: v.getUint16(o, true),
            x: v.getInt16(o + 2, true) / 100,
            z: v.getInt16(o + 4, true) / 100,
            ticksLeft: v.getUint8(o + 6),
            fallTicks: v.getUint8(o + 7),
            team: v.getUint8(o + 8),
            radius: v.getUint8(o + 9) / 10,
          });
        }
        for (let k = v.getUint8(o++); k > 0; k--, o += EVENT_ENTRY) {
          this.events.push({
            kind: v.getUint8(o),
            x: v.getInt16(o + 1, true) / 100,
            y: v.getInt16(o + 3, true) / 100,
            z: v.getInt16(o + 5, true) / 100,
            size: v.getUint8(o + 7),
          });
        }
        const actors: NetActor[] = [];
        for (let k = v.getUint8(o++); k > 0; k--, o += ACTOR_ENTRY) {
          const dead = v.getUint8(o + 16);
          const x = v.getFloat32(o + 3, true);
          const z = v.getFloat32(o + 7, true);
          actors.push({
            id: v.getUint16(o, true),
            kind: v.getUint8(o + 2),
            x,
            z,
            y: v.getUint8(o + 11) / 50,
            facing: (v.getUint8(o + 12) / 255) * TAU,
            state: v.getUint8(o + 13),
            progress: v.getUint8(o + 14) / 255,
            hp: v.getUint8(o + 15) / 255,
            // 0 means alive; otherwise how many frames it has been down, capped on the wire.
            deadFrame: dead === 0 ? -1 : dead - 1,
            targetX: x + v.getInt8(o + 17) / 10,
            targetZ: z + v.getInt8(o + 18) / 10,
          });
        }
        this.actors = actors;
        this.actorTimeline.push(this.lastTick, actors, now);
        this.arrows = arrows;
        this.meteors = meteors;
        this.arrowsTick = this.lastTick;
        this.snapshots++;
      }
    } else if (type === MSG_FAR && this.n) {
      const count = Math.min(this.n, v.getUint16(5, true));
      let o = 7;
      for (let i = 0; i < count; i++, o += 4) {
        if (now - this.lastFine[i] < FINE_HOLD_MS) continue;
        const packed = v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getUint8(o + 2) << 16);
        const x = ((packed & 4095) / 4095) * 320 - 160;
        const z = ((packed >> 12) / 4095) * 320 - 160;
        const f = v.getUint8(o + 3);
        this.moveTo(i, x, z, ((f >> 2) / 64) * TAU, f & 3, now, FAR_MS);
      }
    } else if (type === MSG_STATS) {
      this.stats = {
        tick: v.getUint32(1, true),
        bots: v.getUint32(5, true),
        alive: v.getUint32(9, true),
        realPlayers: v.getUint32(13, true),
        virtualPlayers: v.getUint32(17, true),
        tickMs: v.getFloat32(21, true),
        simMs: v.getFloat32(25, true),
        updatesMs: v.getFloat32(29, true),
        bytesPerPlayer: v.getFloat32(33, true),
        dropped: v.getUint32(37, true),
        pvpHits: v.byteLength >= 45 ? v.getUint32(41, true) : 0,
        botHitsOnPlayers: v.byteLength >= 49 ? v.getUint32(45, true) : 0,
        rewindMs: v.byteLength >= 53 ? v.getFloat32(49, true) : 0,
        savedByRewind: v.byteLength >= 57 ? v.getUint32(53, true) : 0,
        hitsOnBots: v.byteLength >= 61 ? v.getUint32(57, true) : 0,
      };
    }
  }

  // Works out where to draw every fighter right now.
  frame(now: number): void {
    const { fromX, fromZ, toX, toZ, fromYaw, toYaw, start, dur, rx, rz, ryaw, rspeed, known } = this;
    for (let i = 0; i < this.n; i++) {
      if (!known[i]) continue;
      const k = Math.min(1, Math.max(0, (now - start[i]) / dur[i]));
      const dx = toX[i] - fromX[i];
      const dz = toZ[i] - fromZ[i];
      rx[i] = fromX[i] + dx * k;
      rz[i] = fromZ[i] + dz * k;
      let dy = (toYaw[i] - fromYaw[i]) % TAU;
      if (dy > Math.PI) dy -= TAU;
      if (dy < -Math.PI) dy += TAU;
      ryaw[i] = fromYaw[i] + dy * Math.min(1, k * 2);
      rspeed[i] = k < 1 ? Math.sqrt(dx * dx + dz * dz) / (dur[i] / 1000) : 0;
    }
    const elapsed = now - this.rateStart;
    if (elapsed >= 1000) {
      this.bytesPerSec = (this.bytes * 1000) / elapsed;
      this.messagesPerSec = (this.messages * 1000) / elapsed;
      this.bytes = 0;
      this.messages = 0;
      this.rateStart = now;
    }
  }

  knownCount(): number {
    let c = 0;
    for (let i = 0; i < this.n; i++) c += this.known[i];
    return c;
  }
}
