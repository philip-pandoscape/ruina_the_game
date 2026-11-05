import type { Command, LifeEvent } from '../sim/life/life';
import type { Placement } from '../sim/life/interact';
import type { LifeState, Vehicle, Weather } from '../sim/life/state';
import type { Build } from '../tuning';
import { currentAccount, ServerDown } from './account';
import type { ArrowRecord, EffectEvent, MeteorRecord, NetActor } from './netCrowd';
import { resumeAfterReload } from '../app/resume';

// Your connection to the game server (server/src/world_socket.rs), which plays Emberholm: your
// browser sends what you press (about 60 inputs a second) and what you ask your island to do
// (commands), and the server runs them through the island's rules, keeps the island in Postgres,
// and answers 20 times a second with where you really are, what your island holds, and what
// everyone else in your channel is doing. Your own player is predicted with the same rules in the
// meantime (src/net/netPlayer.ts) and corrected to what arrives here. Only one window plays a
// character at a time. /ws/world?character=<id> plays that one of your characters.
//
// When the server is updated, it says so (updating), writes your island and hangs up as a service
// restart (1012); a connection can also just drop. Either way the game freezes while this keeps
// trying, and carries on once the server is back. If the page is out of date by then (the server
// speaks another protocol, or a new build of the game is out), it reloads and comes straight back
// into the world with the same character (src/app/resume.ts).
//
//   server → browser  (text) welcome {protocol, character, account, build, now, channel, dev, estates, claims}
//                     tick {tick, you, peers, actors, arrows, meteors, events, lifeEvents?, life?, tables?}
//                     estate {id, name, estate} | claims {claims} | left {id} | saved {at}
//                     | challenges {sent, waiting} | table {table}   (mini-games, src/ui/minigames)
//                     | reset | kicked | error {text} | updating
//   browser → server  (binary) inputs: 7, count, then per input a u32 sequence number and 10 bytes
//                     (text) cmd {s, c} | build {build} | reset
//                     | challenge {to, game, stake, seed?} | withdraw | answer {from, accept}
//                     | move {table, m} | concede {table}

export interface Welcome {
  character: { id: number; name: string };
  account: string;
  build: unknown;
  /** The server's clock (ms since 1970) as it sent this: online, the sky's time of day runs on it. */
  now: number;
  /** Which copy of Emberholm this character lives in. */
  channel: number;
  /** Whether this server offers the developer panel (development and beta). */
  dev: boolean;
  /** What everyone else living in this channel has built. */
  estates: EstateEntry[];
  /** House plot -> the name of whoever holds it. */
  claims: Record<string, string>;
}

/** Someone's houses, farms and ships on the slipway, as the server shares them. */
export interface Estate {
  houses: unknown[];
  scarecrows: unknown[];
  ships: unknown[];
}

export interface EstateEntry {
  id: number;
  name: string;
  estate: Estate;
}

/** Another player right now: what they're doing, and the vehicles and packs they own. */
export interface PeerEntry {
  id: number;
  name: string;
  p: Record<string, unknown>;
}

/** Your own player as the server has it after input `ack`, with the parts of your island that move with you. */
export interface YouState {
  /** Your slot, which arrows and effects you caused are marked with. */
  id: number;
  ack: number;
  p: Record<string, unknown>;
  clock: number;
  labor: number;
  resting: boolean;
  vehicles: Vehicle[];
  weather: Weather;
  placing: Placement | null;
}

/** One of the server's ticks, as it reaches you. */
export interface WorldTick {
  tick: number;
  you: YouState;
  peers: PeerEntry[];
  actors: NetActor[];
  arrows: ArrowRecord[];
  meteors: MeteorRecord[];
  events: EffectEvent[];
  /** Toasts, panels to open and the like, from your island since the last tick. */
  lifeEvents?: LifeEvent[];
  /** Your whole island, when it changed (and every couple of seconds anyway). */
  life?: { rev: number; state: LifeState; placing: Placement | null; resting: boolean };
  /** Mini-game tables near you, as everyone sees them (none: no table near). */
  tables?: TableShown[];
}

/** A mini-game's table as everyone in the world sees it (server/src/minigames Table::shown). */
export interface TableShown {
  id: number;
  game: string;
  /** Its middle on the ground, and the way from seat 0 to seat 1 (x = sin, z = cos). */
  x: number;
  y: number;
  z: number;
  rot: number;
  /** Seat 0 was challenged and moves first. */
  seats: Array<{ id: number; name: string }>;
  /** Each player's stake (copper). */
  stake: number;
  /** Beacons: who lit each hex (0 nobody, 1 seat 0, 2 seat 1) and the winning row. */
  board: { lit: number[]; row: number[] };
  /** Once the game is over: who won (null: nobody) and why. */
  over?: { winner: number | null; why: 'rules' | 'conceded' | 'timeouts' | 'away' | 'aborted' };
}

/** Your own table as you may see it (Table::view): the clock, and the game as the rules show it to you. */
export interface TableView extends Omit<TableShown, 'seats'> {
  /** Your seat. */
  you: number;
  seats: Array<{ id: number; name: string; timeouts: number; away: boolean }>;
  turnSeconds: number;
  /** What was left on the clock of the player to move when this was sent. */
  ms: number;
  toMove: number | null;
  /** The game's own state (Beacons: src/ui/minigames/beacons.ts BeaconsState). */
  state: Record<string, unknown>;
}

/** A challenge as the server tells it to both players (server/src/minigames Challenge::json). */
export interface ChallengeView {
  from: number;
  fromName: string;
  to: number;
  toName: string;
  game: string;
  /** Each player's stake (copper). */
  stake: number;
  /** Time left to answer when this was sent. */
  ms: number;
}

/** Your challenge out, and one waiting for your answer. */
export interface Challenges {
  sent: ChallengeView | null;
  waiting: ChallengeView | null;
}

/**
 * online: connected. updating: the server is being updated (it said so, or hung up as a service
 * restart); reconnecting: the connection dropped. Either way the world waits until it's back.
 * kicked: another window took this character over. signed-out: the sign-in ended meanwhile.
 */
export type LinkStatus = 'online' | 'updating' | 'reconnecting' | 'kicked' | 'signed-out';

/** How long to wait between tries: an update's new server is usually there within seconds. */
const RETRY_MS = { updating: [500, 1000, 1500, 2000], reconnecting: [500, 1000, 2000, 4000] };
/** A WebSocket closed as a service restart: the server is being updated. */
const SERVICE_RESTART = 1012;
/** What this page speaks; the server says what it speaks in its welcome (server/src/world_socket.rs). */
const WORLD_PROTOCOL = 6;
const RELOADED = 'ruina.reloaded-for-server';
const RELOADED_BUILD = 'ruina.reloaded-for-build';
const SEND_INPUTS = 7;
/** Bytes per input: the battlefield's 8 (src/net/netPlayer.ts quantize) and the raw stick. */
const OPEN_INPUT = 10;

export class WorldLink {
  status: LinkStatus = 'online';
  onStatus: ((s: LinkStatus) => void) | null = null;
  /** The connection came back (the server may have restarted, or another window let go). */
  onReconnect: ((welcome: Welcome) => void) | null = null;
  /** Something the server wants the player to know (a save it couldn't write, say). */
  onError: ((text: string) => void) | null = null;
  onTick: ((t: WorldTick) => void) | null = null;
  onPeers: ((list: PeerEntry[]) => void) | null = null;
  onEstate: ((e: EstateEntry) => void) | null = null;
  onClaims: ((claims: Record<string, string>) => void) | null = null;
  onLeft: ((id: number) => void) | null = null;
  /** Mini-games: your table's game changed (null: you're up from the table), and your challenges. */
  onTable: ((t: TableView | null) => void) | null = null;
  onChallenges: ((c: Challenges) => void) | null = null;
  /** Your table as last heard (null when you aren't at one), and when it came (performance.now()). */
  table: TableView | null = null;
  tableHeard = 0;
  /** Your challenges as last heard, and when they came. */
  challenges: Challenges = { sent: null, waiting: null };
  challengesHeard = 0;
  private resetDone: Array<() => void> = [];
  /** The channel as last heard, kept here so nothing is missed before the game is ready to draw it. */
  readonly peers = new Map<number, PeerEntry>();
  readonly estates = new Map<number, EstateEntry>();
  claims: Record<string, string> = {};
  /** The server's clock when it last wrote your island to the database. */
  lastSaved = 0;
  /** Ticks heard since connecting (tests wait on this). */
  ticks = 0;
  /** The newest tick, and the newest whole island, for whatever arrives before the game is listening. */
  latest: WorldTick | null = null;
  latestLife: WorldTick['life'] | null = null;
  /** The server said it is stopping for an update. */
  private updating = false;
  /**
   * Testing: holds everything going out and coming in for this long (ms) each way, as a server far
   * away would (?lag=ms), so a local server can be played as the deployed one feels.
   */
  lag = 0;
  /** The server's clock in its last welcome (ms since 1970), and when that came (performance.now()). */
  private clock = { server: 0, heard: 0 };

  private constructor(
    private ws: WebSocket,
    welcome: Welcome,
    heard: number,
    /** The character this connection plays (and comes back with). */
    readonly character: number,
  ) {
    this.welcomed(welcome, heard);
    this.attach(ws);
  }

  private welcomed(w: Welcome, heard: number): void {
    this.peers.clear();
    this.estates.clear();
    for (const e of w.estates ?? []) this.estates.set(e.id, e);
    this.claims = w.claims ?? {};
    this.clock = { server: w.now, heard };
    // A game or a challenge that's still on comes again from the server, after its welcome.
    const hadTable = this.table !== null;
    const hadChallenges = !!(this.challenges.sent || this.challenges.waiting);
    this.table = null;
    this.challenges = { sent: null, waiting: null };
    if (hadTable) this.onTable?.(null);
    if (hadChallenges) this.onChallenges?.(this.challenges);
  }

  /**
   * The server's clock now (ms since 1970), counted on from its last welcome: the same for everyone
   * playing, whatever their own computer's clock says. A reconnection's welcome sets it again.
   */
  serverNow(): number {
    return this.clock.server + (performance.now() - this.clock.heard);
  }

  /**
   * Connects to play `character` (one of yours; without one, the one you played last) and waits for
   * the welcome. Rejects with ServerDown if the server can't be reached.
   */
  static async open(character?: number): Promise<{ link: WorldLink; welcome: Welcome }> {
    const { ws, welcome, heard } = await connect(character);
    return { link: new WorldLink(ws, welcome, heard, welcome.character.id), welcome };
  }

  get open(): boolean {
    return this.status === 'online' && this.ws.readyState === WebSocket.OPEN;
  }

  /** One frame of what you pressed: its sequence number and the 10 bytes netPlayer.ts packs. */
  sendInput(seq: number, raw: readonly number[]): boolean {
    if (!this.open) return false;
    const msg = new DataView(new ArrayBuffer(2 + 4 + OPEN_INPUT));
    msg.setUint8(0, SEND_INPUTS);
    msg.setUint8(1, 1);
    msg.setUint32(2, seq, true);
    for (let k = 0; k < OPEN_INPUT; k++) msg.setUint8(6 + k, (raw[k] ?? 0) & 255);
    this.out(msg.buffer);
    return true;
  }

  /** Sends now, or after the test lag (to the connection open then). */
  private out(data: string | ArrayBuffer): void {
    if (!this.lag) return this.ws.send(data);
    setTimeout(() => this.open && this.ws.send(data), this.lag);
  }

  /** Asks your island to do something, on the input with sequence number `seq`. */
  command(seq: number, c: Command): boolean {
    return this.send({ t: 'cmd', s: seq, c });
  }

  saveBuild(build: Build): boolean {
    return this.send({ t: 'build', build });
  }

  // ---------- Mini-games (server/src/world_game/tables.rs) ----------

  /** Challenges another player here to `game` for `stake` copper each (development servers: `seed` deals a known game). */
  challenge(to: number, game: string, stake: number, seed?: number): boolean {
    return this.send({ t: 'challenge', to, game, stake, ...(seed !== undefined ? { seed } : {}) });
  }

  /** Takes your challenge back. */
  withdraw(): boolean {
    return this.send({ t: 'withdraw' });
  }

  /** Accepts or declines the challenge from `from`. */
  answer(from: number, accept: boolean): boolean {
    return this.send({ t: 'answer', from, accept });
  }

  /** A move at your table, in the game's own terms. */
  move(table: number, m: Record<string, unknown>): boolean {
    return this.send({ t: 'move', table, m });
  }

  /** Gives your game up: the other player wins it. */
  concede(table: number): boolean {
    return this.send({ t: 'concede', table });
  }

  /** Starts the island over on the server. Resolves once it's done (or after 3 s). */
  reset(): Promise<void> {
    return new Promise((resolve) => {
      this.resetDone.push(resolve);
      if (!this.send({ t: 'reset' })) resolve();
      setTimeout(resolve, 3000);
    });
  }

  private send(msg: object): boolean {
    if (!this.open) return false;
    this.out(JSON.stringify(msg));
    return true;
  }

  private attach(ws: WebSocket): void {
    ws.binaryType = 'arraybuffer';
    // Only the current connection speaks for the link; a replaced one is ignored.
    ws.onmessage = (e) => {
      if (ws !== this.ws) return;
      if (this.lag) setTimeout(() => ws === this.ws && this.receive(e.data), this.lag);
      else this.receive(e.data);
    };
    ws.onclose = (e) => {
      if (ws === this.ws) void this.lost(e.code);
    };
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return;
    let msg: { t?: string; text?: string; id?: number; name?: string; estate?: Estate; claims?: Record<string, string>; at?: number } & Partial<WorldTick>;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.t === 'tick' && msg.you) {
      const t = msg as WorldTick;
      this.ticks++;
      this.latest = t;
      if (t.life) this.latestLife = t.life;
      for (const e of t.peers ?? []) this.peers.set(e.id, e);
      this.onPeers?.(t.peers ?? []);
      this.onTick?.(t);
    } else if (msg.t === 'saved') this.lastSaved = msg.at ?? Date.now();
    else if (msg.t === 'reset') {
      // Anything heard before this was the island that's gone.
      this.latestLife = null;
      for (const done of this.resetDone.splice(0)) done();
    }
    else if (msg.t === 'kicked') this.setStatus('kicked');
    else if (msg.t === 'updating') {
      // The server is stopping for an update: nothing more counts until the new one is up.
      this.updating = true;
      this.setStatus('updating');
    } else if (msg.t === 'error') this.onError?.(msg.text ?? 'The server had a problem.');
    else if (msg.t === 'estate' && msg.estate) {
      const e = { id: msg.id ?? 0, name: msg.name ?? '', estate: msg.estate };
      this.estates.set(e.id, e);
      this.onEstate?.(e);
    } else if (msg.t === 'claims') {
      this.claims = msg.claims ?? {};
      this.onClaims?.(this.claims);
    } else if (msg.t === 'left') {
      this.peers.delete(msg.id ?? 0);
      this.onLeft?.(msg.id ?? 0);
    } else if (msg.t === 'table') {
      this.table = (msg as { table?: TableView | null }).table ?? null;
      this.tableHeard = performance.now();
      this.onTable?.(this.table);
    } else if (msg.t === 'challenges') {
      const c = msg as { sent?: ChallengeView | null; waiting?: ChallengeView | null };
      this.challenges = { sent: c.sent ?? null, waiting: c.waiting ?? null };
      this.challengesHeard = performance.now();
      this.onChallenges?.(this.challenges);
    }
  }

  /** The connection closed (`code`: the WebSocket's close code). Keeps trying until it's back. */
  private async lost(code: number): Promise<void> {
    if (this.status === 'kicked' || this.status === 'signed-out') return;
    if (code === SERVICE_RESTART) this.updating = true;
    this.setStatus(this.updating ? 'updating' : 'reconnecting');
    for (let attempt = 0; ; attempt++) {
      const waits = RETRY_MS[this.updating ? 'updating' : 'reconnecting'];
      await new Promise((r) => setTimeout(r, waits[Math.min(attempt, waits.length - 1)]));
      // A new build of the game came out (with the new server, most likely): load it, and come
      // straight back in.
      if (await newBuildOut()) {
        reloadInto(this.character);
        return;
      }
      try {
        const { ws, welcome, heard } = await connect(this.character);
        this.ws = ws;
        this.welcomed(welcome, heard);
        this.attach(ws);
        this.updating = false;
        this.setStatus('online');
        this.onReconnect?.(welcome);
        return;
      } catch (e) {
        if (e instanceof Reloading) return;
        // Signed out meanwhile (expired, or signed out in another window): retrying won't help.
        if ((await currentAccount().catch(() => undefined)) === null) {
          this.setStatus('signed-out');
          return;
        }
      }
    }
  }

  private setStatus(s: LinkStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.onStatus?.(s);
  }
}

/** The page is reloading to come back as the newer game: nothing more to do here. */
export class Reloading extends ServerDown {}

/** Reloads into the world with `character`, without the intro or the character select screen. */
function reloadInto(character: number | undefined): void {
  if (character !== undefined) resumeAfterReload(character);
  location.reload();
}

/** The game's build a page loads: its module scripts (hashed file names in production). */
function buildOf(doc: Document): string {
  return [...doc.querySelectorAll('script[type="module"][src]')].map((s) => s.getAttribute('src')).join(' ');
}

/**
 * Whether a newer build of the game is out than this page: its own module scripts against those of
 * a fresh copy of the page. (In development both are /src/main.ts.) Not if it already reloaded for
 * that build once and still isn't it: a cache in the way mustn't make it reload forever.
 */
async function newBuildOut(): Promise<boolean> {
  try {
    const res = await fetch(location.pathname, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return false;
    const theirs = buildOf(new DOMParser().parseFromString(await res.text(), 'text/html'));
    // Not the game's page (a proxy's error page, say), or the same build.
    if (!theirs || theirs === buildOf(document)) {
      sessionStorage.removeItem(RELOADED_BUILD);
      return false;
    }
    if (sessionStorage.getItem(RELOADED_BUILD) === theirs) return false;
    sessionStorage.setItem(RELOADED_BUILD, theirs);
    return true;
  } catch {
    return false;
  }
}

/** A connection and its welcome, with when the welcome came (performance.now()). */
function connect(character?: number): Promise<{ ws: WebSocket; welcome: Welcome; heard: number }> {
  return new Promise((resolve, reject) => {
    const which = character === undefined ? '' : `?character=${character}`;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/world${which}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new ServerDown("The game server didn't answer."));
    }, 10_000);
    ws.onmessage = (e) => {
      const heard = performance.now();
      if (typeof e.data !== 'string') return;
      let msg: Welcome & { t?: string };
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t !== 'welcome') return;
      clearTimeout(timer);
      ws.onmessage = null;
      ws.onclose = null;
      // The server was updated since this page loaded: load the new game, straight back into the
      // world with this character (once; if that didn't help, say so rather than reloading forever).
      if ((msg as { protocol?: number }).protocol !== WORLD_PROTOCOL) {
        ws.close();
        if (!sessionStorage.getItem(RELOADED)) {
          sessionStorage.setItem(RELOADED, '1');
          reloadInto(character ?? msg.character?.id);
          reject(new Reloading('The game was updated. Loading the new version…'));
          return;
        }
        reject(new ServerDown('The game was updated. Reload the page to play.'));
        return;
      }
      sessionStorage.removeItem(RELOADED);
      resolve({ ws, welcome: msg, heard });
    };
    ws.onclose = () => {
      clearTimeout(timer);
      reject(new ServerDown("Can't reach the game server."));
    };
  });
}
