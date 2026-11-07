import { asset } from './manifest';

// The loader (docs/assets.md): every file the game fetches after the page waits its turn here, so
// what is needed first arrives first, and a game far bigger than its first download streams in as
// it is needed. What draws a file asks for it with what it is needed for:
//
//   front  the title screen, sign-in and character select (the hero and their weapons)
//   zone   what the zone you are going into can't be drawn without: its ground, the town you stand in
//   near   what is placed in the zone, nearest the camera first; past `reach` it waits until you come near
//
// and draws a stand-in until it arrives (the procedural models, the ground's plain colours, the box
// hero): low detail first. A few files load at once, the most needed next. Nothing is ever thrown at
// the game: a file that fails is logged by whoever asked for it, and its stand-in stays.

export type Need = 'front' | 'zone' | 'near';
const RANK: Record<Need, number> = { front: 0, zone: 1, near: 2 };

/** Files loading at once: enough to fill the line, few enough that the nearest arrive first. */
const AT_ONCE = 6;

export interface Wanted {
  need?: Need;
  /** Where it is (a placed model), read when its turn might come; nearest the camera loads first. */
  at?: () => { x: number; z: number } | null;
}

/** Bytes asked for and bytes arrived, from the manifest's sizes. */
export interface Bytes {
  wanted: number;
  done: number;
}

interface Request {
  id: string;
  need: Need;
  /** Where it is wanted (as near as its nearest), or null where something wants it wherever it is. */
  at: Array<NonNullable<Wanted['at']>> | null;
  promise: Promise<unknown>;
  start(): void;
  state: 'waiting' | 'loading' | 'done';
  /** Bytes, by the manifest. */
  size: number;
}

export class Loader {
  private requests = new Map<string, Request>();
  private loading = 0;
  /** Where files are wanted from (the camera), and how far round it they load; null until something draws. */
  private focus: { x: number; z: number; reach: number } | null = null;
  private pumping = false;
  private listeners = new Set<(p: Bytes) => void>();

  /** `files` finds a file's address and size by id (the manifest's, in the game). */
  constructor(
    private files: (id: string) => { url: string; size: number } | undefined,
    private atOnce = AT_ONCE,
  ) {}

  /**
   * Fetches file `id` when its turn comes, with `load` given its address; one request per file,
   * whoever else asks for it (a more urgent need, a nearer place or no place at all moves it up).
   * Rejects for a file the manifest doesn't have, or one that fails to load.
   */
  want<T>(id: string, load: (url: string) => Promise<T>, wanted: Wanted = {}): Promise<T> {
    const need = wanted.need ?? 'near';
    const known = this.requests.get(id);
    if (known) {
      if (known.state === 'waiting') {
        if (RANK[need] < RANK[known.need]) known.need = need;
        known.at = wanted.at && known.at ? [...known.at, wanted.at] : null;
        this.pump();
      }
      return known.promise as Promise<T>;
    }
    const file = this.files(id);
    if (!file) return Promise.reject(new Error(`no asset ${id} in the manifest (src/assets/catalog.ts)`));
    const r: Request = { id, need, at: wanted.at ? [wanted.at] : null, promise: Promise.resolve(), start: () => {}, state: 'waiting', size: file.size };
    r.promise = new Promise<T>((resolve, reject) => {
      r.start = () => {
        r.state = 'loading';
        this.loading++;
        load(file.url)
          .then(resolve, reject)
          .finally(() => {
            r.state = 'done';
            this.loading--;
            this.changed();
            this.pump();
          });
      };
    });
    this.requests.set(id, r);
    this.changed();
    this.pump();
    return r.promise as Promise<T>;
  }

  /**
   * Where files are wanted from (the camera), and how far round it a placed file loads: called by
   * whatever draws a zone, every frame. Files placed further away wait until it comes nearer.
   */
  streamFrom(x: number, z: number, reach: number): void {
    const was = this.focus;
    this.focus = { x, z, reach };
    // Only worth a look for newly near files once it has moved a little.
    if (!was || Math.hypot(was.x - x, was.z - z) > 8 || was.reach !== reach) this.pump();
  }

  /**
   * Files waiting their turn or loading (of these needs, or any), not counting those waiting for the
   * camera to come near.
   */
  pending(...needs: Need[]): number {
    let n = 0;
    for (const r of this.requests.values())
      if ((!needs.length || needs.includes(r.need)) && (r.state === 'loading' || (r.state === 'waiting' && !this.parked(r)))) n++;
    return n;
  }

  /** Whether a file is waiting for the camera to come near the places it's wanted. */
  waitingForCamera(id: string): boolean {
    const r = this.requests.get(id);
    return !!r && r.state === 'waiting' && this.parked(r);
  }

  /** Bytes asked for and bytes arrived so far (of the files of these needs, or all). */
  loaded(...needs: Need[]): Bytes {
    const bytes = { wanted: 0, done: 0 };
    for (const r of this.requests.values()) {
      if (needs.length && !needs.includes(r.need)) continue;
      bytes.wanted += r.size;
      if (r.state === 'done') bytes.done += r.size;
    }
    return bytes;
  }

  /** Called with the bytes asked for and arrived (of every file) whenever either changes; returns how to stop. */
  onLoaded(fn: (p: Bytes) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The ids of the files that have arrived (or failed), in the order they were asked for. */
  arrived(): string[] {
    return [...this.requests.values()].filter((r) => r.state === 'done').map((r) => r.id);
  }

  /** How far from the camera the nearest place a file is wanted is (0 for one wanted wherever it is). */
  private distance(r: Request): number {
    const focus = this.focus;
    if (!focus || !r.at) return 0;
    let d = Infinity;
    for (const at of r.at) {
      const p = at();
      d = Math.min(d, p ? Math.hypot(p.x - focus.x, p.z - focus.z) : 0);
    }
    return d;
  }

  /** Waiting for the camera to come near: placed past the reach of where files are wanted from. */
  private parked(r: Request, d = this.distance(r)): boolean {
    return !!this.focus && !!r.at && d > this.focus.reach;
  }

  /** Starts the most needed files, a few at a time (after whatever else is asked for this turn). */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    queueMicrotask(() => {
      this.pumping = false;
      while (this.loading < this.atOnce) {
        let best: Request | null = null;
        let bestKey = Infinity;
        for (const r of this.requests.values()) {
          if (r.state !== 'waiting') continue;
          const d = this.distance(r);
          if (this.parked(r, d)) continue;
          // Need first; then, among placed files, the nearest; otherwise in the order asked for.
          const key = RANK[r.need] * 1e7 + d;
          if (key < bestKey) {
            best = r;
            bestKey = key;
          }
        }
        if (!best) break;
        best.start();
      }
    });
  }

  private changed(): void {
    if (!this.listeners.size) return;
    const bytes = this.loaded();
    for (const fn of this.listeners) fn(bytes);
  }
}

/** The game's loader, fetching the files in the asset manifest. */
export const loader = new Loader(asset);

export const want = <T>(id: string, load: (url: string) => Promise<T>, wanted?: Wanted): Promise<T> => loader.want(id, load, wanted);
export const streamFrom = (x: number, z: number, reach: number): void => loader.streamFrom(x, z, reach);
export const onLoaded = (fn: (p: Bytes) => void): (() => void) => loader.onLoaded(fn);

// What the loader is doing, for tests that measure the first download before the game is there
// (window.__game comes with it): files waiting or loading, the ids arrived, the bytes.
if (typeof window !== 'undefined')
  Object.defineProperty(window, '__assets', {
    configurable: true,
    value: Object.freeze({ pending: () => loader.pending(), arrived: () => loader.arrived(), loaded: () => loader.loaded() }),
  });
