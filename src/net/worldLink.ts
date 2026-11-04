import type { Island } from '../app/save';
import type { Build } from '../tuning';
import { currentAccount, ServerDown } from './account';

// Your island's connection to the game server (server/src/world_socket.rs). The browser still runs
// Emberholm's rules; the server keeps the island in Postgres, hands it back when you arrive, lets
// only one window play a character at a time, and shares your channel of Emberholm: where everyone
// is (presences, about 20 a second), what each resident has built (estates) and who holds which
// house plot (claims).
//
// JSON text messages:
//   server → browser  welcome {character, account, island, build, savedAt, now, channel, dev, estates, claims}
//                     peers {list} | estate {id, name, estate} | claims {claims} | left {id}
//                     correct {x, y, z} | saved {at} | reset | kicked | error {text}
//   browser → server  presence {p} | save {save, build?} | build {build} | reset

export interface Welcome {
  character: { id: number; name: string };
  account: string;
  /** Null for a new character, or after starting over. */
  island: Island | null;
  build: unknown;
  /** The server's clock (ms) at the last save and now, so time away is measured on one clock. */
  savedAt: number | null;
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

/** Another player right now: what they look like they're doing, and the vehicles and packs they own. */
export interface PeerEntry {
  id: number;
  name: string;
  p: Record<string, unknown>;
}

/**
 * online: connected. reconnecting: the connection dropped; play goes on, unsaved, until it's back.
 * kicked: another window took this character over. signed-out: the sign-in ended meanwhile.
 */
export type LinkStatus = 'online' | 'reconnecting' | 'kicked' | 'signed-out';

const RETRY_MS = [500, 1000, 2000, 4000, 8000];

export class WorldLink {
  status: LinkStatus = 'online';
  /** The server's clock at the last save it confirmed. */
  lastSaved = 0;
  onStatus: ((s: LinkStatus) => void) | null = null;
  /** The connection came back: send the island straight away. */
  onReconnect: ((welcome: Welcome) => void) | null = null;
  /** Something the server wants the player to know (a save it couldn't write, say). */
  onError: ((text: string) => void) | null = null;
  onPeers: ((list: PeerEntry[]) => void) | null = null;
  onEstate: ((e: EstateEntry) => void) | null = null;
  onClaims: ((claims: Record<string, string>) => void) | null = null;
  onLeft: ((id: number) => void) | null = null;
  /** The server says where you are can't be right (under the ground, off the island). */
  onCorrect: ((x: number, y: number, z: number) => void) | null = null;
  private resetDone: Array<() => void> = [];
  /** The channel as last heard, kept here so nothing is missed before the game is ready to draw it. */
  readonly peers = new Map<number, PeerEntry>();
  readonly estates = new Map<number, EstateEntry>();
  claims: Record<string, string> = {};

  private constructor(
    private ws: WebSocket,
    welcome: Welcome,
  ) {
    this.welcomed(welcome);
    this.attach(ws);
  }

  private welcomed(w: Welcome): void {
    this.peers.clear();
    this.estates.clear();
    for (const e of w.estates ?? []) this.estates.set(e.id, e);
    this.claims = w.claims ?? {};
  }

  /** Connects and waits for the welcome. Rejects with ServerDown if the server can't be reached. */
  static async open(): Promise<{ link: WorldLink; welcome: Welcome }> {
    const { ws, welcome } = await connect();
    return { link: new WorldLink(ws, welcome), welcome };
  }

  /** Sends the island. False (nothing sent) while the connection is down. */
  save(island: Island, build?: Build): boolean {
    return this.send({ t: 'save', save: island, build });
  }

  /** Where you are and what you're doing, for everyone else in the channel. */
  presence(p: Record<string, unknown>): boolean {
    return this.send({ t: 'presence', p });
  }

  saveBuild(build: Build): boolean {
    return this.send({ t: 'build', build });
  }

  /** Throws the island away on the server, to start over. Resolves once it's gone (or after 3 s). */
  reset(): Promise<void> {
    return new Promise((resolve) => {
      this.resetDone.push(resolve);
      if (!this.send({ t: 'reset' })) resolve();
      setTimeout(resolve, 3000);
    });
  }

  private send(msg: object): boolean {
    if (this.status !== 'online' || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private attach(ws: WebSocket): void {
    // Only the current connection speaks for the link; a replaced one is ignored.
    ws.onmessage = (e) => {
      if (ws === this.ws) this.receive(e.data);
    };
    ws.onclose = () => {
      if (ws === this.ws) void this.lost();
    };
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return;
    let msg: { t?: string; at?: number; text?: string; list?: PeerEntry[]; id?: number; name?: string; estate?: Estate; claims?: Record<string, string>; x?: number; y?: number; z?: number };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.t === 'saved') this.lastSaved = msg.at ?? Date.now();
    else if (msg.t === 'reset') for (const done of this.resetDone.splice(0)) done();
    else if (msg.t === 'kicked') this.setStatus('kicked');
    else if (msg.t === 'error') this.onError?.(msg.text ?? 'The server had a problem.');
    else if (msg.t === 'peers') {
      const list = msg.list ?? [];
      for (const e of list) this.peers.set(e.id, e);
      this.onPeers?.(list);
    } else if (msg.t === 'estate' && msg.estate) {
      const e = { id: msg.id ?? 0, name: msg.name ?? '', estate: msg.estate };
      this.estates.set(e.id, e);
      this.onEstate?.(e);
    } else if (msg.t === 'claims') {
      this.claims = msg.claims ?? {};
      this.onClaims?.(this.claims);
    } else if (msg.t === 'left') {
      this.peers.delete(msg.id ?? 0);
      this.onLeft?.(msg.id ?? 0);
    }
    else if (msg.t === 'correct') this.onCorrect?.(msg.x ?? 0, msg.y ?? 0, msg.z ?? 0);
  }

  private async lost(): Promise<void> {
    if (this.status === 'kicked' || this.status === 'signed-out') return;
    this.setStatus('reconnecting');
    for (let attempt = 0; ; attempt++) {
      await new Promise((r) => setTimeout(r, RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]));
      try {
        const { ws, welcome } = await connect();
        this.ws = ws;
        this.welcomed(welcome);
        this.attach(ws);
        this.setStatus('online');
        this.onReconnect?.(welcome);
        return;
      } catch {
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

function connect(): Promise<{ ws: WebSocket; welcome: Welcome }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/world`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new ServerDown("The game server didn't answer."));
    }, 10_000);
    ws.onmessage = (e) => {
      let msg: Welcome & { t?: string };
      try {
        msg = JSON.parse(e.data as string);
      } catch {
        return;
      }
      if (msg.t !== 'welcome') return;
      clearTimeout(timer);
      ws.onmessage = null;
      ws.onclose = null;
      resolve({ ws, welcome: msg });
    };
    ws.onclose = () => {
      clearTimeout(timer);
      reject(new ServerDown("Can't reach the game server."));
    };
  });
}
