import type { Island } from '../app/save';
import type { Build } from '../tuning';
import { currentAccount, ServerDown } from './account';

// Your island's connection to the game server (server/src/world_socket.rs). Phase 1 of moving
// online: the browser still runs Emberholm's rules, and the server keeps the island in Postgres,
// hands it back when you arrive, and lets only one window play a character at a time.
//
// JSON text messages:
//   server → browser  welcome {character, account, island, build, savedAt, now}
//                     saved {at} | reset | kicked | error {text}
//   browser → server  save {save, build?} | build {build} | reset

export interface Welcome {
  character: { id: number; name: string };
  account: string;
  /** Null for a new character, or after starting over. */
  island: Island | null;
  build: unknown;
  /** The server's clock (ms) at the last save and now, so time away is measured on one clock. */
  savedAt: number | null;
  now: number;
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
  onReconnect: (() => void) | null = null;
  /** Something the server wants the player to know (a save it couldn't write, say). */
  onError: ((text: string) => void) | null = null;
  private resetDone: Array<() => void> = [];

  private constructor(private ws: WebSocket) {
    this.attach(ws);
  }

  /** Connects and waits for the welcome. Rejects with ServerDown if the server can't be reached. */
  static async open(): Promise<{ link: WorldLink; welcome: Welcome }> {
    const { ws, welcome } = await connect();
    return { link: new WorldLink(ws), welcome };
  }

  /** Sends the island. False (nothing sent) while the connection is down. */
  save(island: Island, build?: Build): boolean {
    return this.send({ t: 'save', save: island, build });
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
    let msg: { t?: string; at?: number; text?: string };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.t === 'saved') this.lastSaved = msg.at ?? Date.now();
    else if (msg.t === 'reset') for (const done of this.resetDone.splice(0)) done();
    else if (msg.t === 'kicked') this.setStatus('kicked');
    else if (msg.t === 'error') this.onError?.(msg.text ?? 'The server had a problem.');
  }

  private async lost(): Promise<void> {
    if (this.status === 'kicked' || this.status === 'signed-out') return;
    this.setStatus('reconnecting');
    for (let attempt = 0; ; attempt++) {
      await new Promise((r) => setTimeout(r, RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]));
      try {
        const { ws } = await connect();
        this.ws = ws;
        this.attach(ws);
        this.setStatus('online');
        this.onReconnect?.();
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
