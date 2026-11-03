import type { CrowdSource } from '../crowd/crowdView';
import type { Mode, PlayerState } from '../sim/types';

// Receives the battle from the Rust server (server/src/protocol.rs describes the bytes) and
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
const YOU_ENTRY = 171;
const ARROW_ENTRY = 15;
const METEOR_ENTRY = 9;
const EVENT_ENTRY = 8;
const MODES: Mode[] = ['normal', 'slide', 'attack', 'cast'];

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
  slideFrame: number;
  flipFrame: number;
  hp: number;
  stun: number;
  landFrame: number;
  weapon: number;
  perks: number;
  castKind: number;
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
}

// Something that just happened, for effects: 1 heal, 2 explosion, 3 arrow hit.
export interface EffectEvent {
  kind: number;
  x: number;
  y: number;
  z: number;
  size: number;
}

function readYou(v: DataView, o: number): { id: number; ack: number; player: PlayerState } {
  const f = (k: number) => v.getFloat64(o + 6 + k * 8, true);
  const i = (k: number) => v.getInt16(o + 118 + k * 2, true);
  const b = (k: number) => v.getUint8(o + 158 + k);
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
      slideDirX: f(7),
      slideDirZ: f(8),
      landImpact: f(9),
      runPhase: f(10),
      hp: f(11),
      castTargetX: f(12),
      castTargetZ: f(13),
      jumpsUsed: i(0),
      coyote: i(1),
      jumpBuffer: i(2),
      attackBuffer: i(3),
      slideBuffer: i(4),
      slideFrame: i(5),
      slideCooldown: i(6),
      attackFrame: i(7),
      flipFrame: i(8),
      landFrame: i(9),
      takeoffFrame: i(10),
      stun: i(11),
      downFrame: i(12),
      abilityBuffer1: i(13),
      abilityBuffer2: i(14),
      cooldown1: i(15),
      cooldown2: i(16),
      castFrame: i(17),
      perks: v.getUint32(o + 154, true),
      mode: MODES[b(0)] ?? 'normal',
      grounded: b(1) === 1,
      jumpCutDone: b(2) === 1,
      attackIndex: b(3),
      attackQueued: b(4) === 1,
      attackHit: b(5) === 1,
      team: b(6),
      weapon: b(7),
      ability1: b(8),
      ability2: b(9),
      castKind: b(10),
      castSlot: b(11),
      firedCast: b(12),
    },
  };
}

const FLAG_TEAM = 1;
const FLAG_DOWN = 2;
const NEAR_ENTRY = 10;
const MID_ENTRY = 8;
const TAU = Math.PI * 2;

// How long to take moving to each new position: a little longer than the gap between updates,
// so fighters keep moving smoothly instead of stopping and starting.
const NEAR_MS = 70;
const MID_MS = 230;
const FAR_MS = 1050;
const FINE_HOLD_MS = 600; // ignore coarse once-a-second positions for fighters we've seen up close
// A jump bigger than TELEPORT_SLACK + TELEPORT_SPEED × (seconds since the last update) is a teleport.
const TELEPORT_SLACK = 2; // metres
const TELEPORT_SPEED = 8; // m/s, faster than any fighter runs
// Other players are drawn this many server ticks behind the newest update (100 ms at 20 Hz),
// so there's always a next update to blend toward.
const INTERP_TICKS = 2;

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
  private ws: WebSocket;
  private bytes = 0;
  private messages = 0;
  private rateStart = performance.now();

  constructor(private url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => (this.connected = this.everConnected = true);
    this.ws.onclose = () => {
      this.connected = false;
      if (this.everConnected) this.waitForServer();
    };
    this.ws.onmessage = (e) => this.receive(e.data as ArrayBuffer);
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
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(bytes);
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
  sendInput(seq: number, view: number, raw: [number, number, number, number, number]): void {
    const msg = new DataView(new ArrayBuffer(15));
    msg.setUint8(0, SEND_INPUT);
    msg.setUint8(1, 1);
    msg.setUint32(2, seq, true);
    msg.setUint32(6, view, true);
    raw.forEach((byte, k) => msg.setUint8(10 + k, byte));
    this.send(new Uint8Array(msg.buffer));
  }

  // Your skills and loadout. The server checks the build before using it.
  sendBuild(perks: number, weapon: number, ability1: number, ability2: number): void {
    this.send(new Uint8Array([SEND_BUILD, perks & 255, (perks >> 8) & 255, weapon, ability1, ability2]));
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
    if (this.ws.readyState !== WebSocket.OPEN) return;
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
            slideFrame: v.getUint8(o + 17),
            flipFrame: v.getInt8(o + 18),
            hp: v.getUint8(o + 19),
            stun: v.getUint8(o + 20),
            landFrame: v.getUint8(o + 21),
            weapon: v.getUint8(o + 22),
            perks: v.getUint16(o + 23, true),
            castKind: v.getUint8(o + 25),
            castFrame: v.getUint8(o + 26),
            castTargetX: v.getInt16(o + 27, true) / 100,
            castTargetZ: v.getInt16(o + 29, true) / 100,
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
