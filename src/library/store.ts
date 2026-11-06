import type { FrameInfo, Options, Snapshot, Vec3 } from './types';

// The notes on animations: on a whole animation, on a stretch of frames, or on one frame, which may
// carry a corrected pose. Kept by the dev server in reviews/animations/review.json (tools/
// animReviews.ts), and in this browser too, so they outlive the reload that follows every code
// change; a prompt is made from the open ones (prompt.ts).

export type NoteKind = 'anim' | 'range' | 'frame';

/** A corrected pose: the frame as it was, as the user put it, and what they moved. */
export interface PoseFix {
  before: Snapshot;
  after: Snapshot;
  /** Bones the user turned or moved by hand. */
  touched: string[];
  /** Where each joint was and is now, in the body's own space (metres). */
  model: { before: Record<string, Vec3>; after: Record<string, Vec3> };
  camera: { position: Vec3; target: Vec3 };
  /** The picture of it (before beside after), a file in the review folder's images/. */
  image?: string;
}

export interface Note {
  id: string;
  subject: string;
  subjectName: string;
  options: Options;
  anim: string;
  animLabel: string;
  kind: NoteKind;
  /** The frame (kind 'frame') or the first and last frames (kind 'range'). */
  frame?: number;
  range?: [number, number];
  text: string;
  fix?: PoseFix;
  /** What the rules had the body doing on that frame (or the first of the range), when noted. */
  state?: FrameInfo;
  /** The animation's length and rate when noted. */
  frames: number;
  fps: number;
  status: 'open' | 'done';
  created: number;
  updated: number;
  /** When it last went out in a prompt. */
  sent?: number;
}

export interface Review {
  version: 1;
  notes: Note[];
}

const LOCAL = 'ruina.animReview.v1';
const params = new URLSearchParams(location.search);
/** Tests keep their notes apart (test-results/anim-reviews/) and start with none. */
const TEST = params.has('test');
const HEADER = { 'x-anim-review': TEST ? 'test' : '1' };

export const noteKey = (subject: string, anim: string, options: Options): string => `${subject}|${anim}|${JSON.stringify(Object.entries(options).sort())}`;

export const newId = (): string => Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 6);

class Store {
  review: Review = { version: 1, notes: [] };
  /** Where the dev server keeps the notes (an absolute path), or null when there is none to keep them. */
  dir: string | null = null;
  /** The same folder as the dev server serves it. */
  private url = '';
  private listeners = new Set<() => void>();
  private timer = 0;
  private saving: Promise<void> = Promise.resolve();
  /** Pictures not kept on disk (no dev server): data URLs, for this session only. */
  readonly memoryImages = new Map<string, string>();

  async load(): Promise<void> {
    let fromServer: Review | null = null;
    try {
      const r = await fetch('/__anim-review/review', { headers: HEADER });
      if (r.ok) {
        const body = (await r.json()) as { dir: string; url: string; review: Review | null };
        this.dir = body.dir;
        this.url = body.url;
        fromServer = body.review;
      }
    } catch {
      this.dir = null;
    }
    const local = TEST ? null : this.readLocal();
    // The newer of the two wins (a note made while the dev server was down is kept).
    const pick = [fromServer, local].filter((r): r is Review => !!r && Array.isArray(r.notes)).sort((a, b) => latest(b) - latest(a))[0];
    this.review = pick ?? { version: 1, notes: [] };
    this.emit();
  }

  private readLocal(): Review | null {
    try {
      const s = localStorage.getItem(LOCAL);
      return s ? (JSON.parse(s) as Review) : null;
    } catch {
      return null;
    }
  }

  /** Notes changed in another tab of the library (this browser): take its copy. */
  watchOtherTabs(): void {
    if (TEST) return;
    window.addEventListener('storage', (e) => {
      if (e.key !== LOCAL || !e.newValue) return;
      try {
        this.review = JSON.parse(e.newValue) as Review;
        this.emit();
      } catch {
        // A half-written copy: the next change brings a whole one.
      }
    });
  }

  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Keeps the notes a moment after the last change (and at once in this browser). */
  private changed(): void {
    this.emit();
    if (!TEST) {
      try {
        localStorage.setItem(LOCAL, JSON.stringify(this.review));
      } catch {
        // Too big for this browser's storage: the dev server's copy is the one that counts.
      }
    }
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), 250);
  }

  /** Writes the notes to the dev server now. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.dir === null) return Promise.resolve();
    const body = JSON.stringify(this.review);
    this.saving = this.saving.then(() =>
      fetch('/__anim-review/review', { method: 'PUT', headers: { ...HEADER, 'content-type': 'application/json' }, body })
        .then(() => undefined)
        .catch(() => undefined),
    );
    return this.saving;
  }

  get notes(): Note[] {
    return this.review.notes;
  }

  add(n: Note): Note {
    this.review.notes.push(n);
    this.changed();
    return n;
  }

  update(id: string, patch: Partial<Note>): void {
    const n = this.review.notes.find((x) => x.id === id);
    if (!n) return;
    Object.assign(n, patch, { updated: Date.now() });
    this.changed();
  }

  remove(id: string): void {
    this.review.notes = this.review.notes.filter((x) => x.id !== id);
    this.changed();
  }

  /** Clears notes that are done. */
  clearDone(): number {
    const before = this.review.notes.length;
    this.review.notes = this.review.notes.filter((n) => n.status !== 'done');
    this.changed();
    return before - this.review.notes.length;
  }

  forAnim(subject: string, anim: string, options: Options): Note[] {
    const key = noteKey(subject, anim, options);
    return this.review.notes.filter((n) => noteKey(n.subject, n.anim, n.options) === key);
  }

  count(filter: (n: Note) => boolean): number {
    return this.review.notes.reduce((k, n) => k + (filter(n) ? 1 : 0), 0);
  }

  /** Keeps a picture; returns its file name (kept on disk by the dev server, or in memory). */
  async putImage(name: string, canvas: HTMLCanvasElement): Promise<string> {
    if (this.dir !== null) {
      const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'));
      if (blob) {
        const r = await fetch(`/__anim-review/images/${name}`, { method: 'PUT', headers: HEADER, body: blob }).catch(() => null);
        if (r?.ok) return name;
      }
    }
    this.memoryImages.set(name, canvas.toDataURL('image/png'));
    return name;
  }

  /** Where a picture is: a URL to show it, and the file on disk for the prompt (null if not kept). */
  image(name: string): { url: string; file: string | null } {
    const mem = this.memoryImages.get(name);
    if (mem) return { url: mem, file: null };
    const sep = this.dir?.includes('\\') ? '\\' : '/';
    return { url: `${this.url}/images/${name}`, file: this.dir ? `${this.dir}${sep}images${sep}${name}` : null };
  }

  /** Keeps a prompt on disk; returns the file, or null without a dev server. */
  async savePrompt(text: string): Promise<string | null> {
    if (this.dir === null) return null;
    const r = await fetch('/__anim-review/prompt', { method: 'POST', headers: { ...HEADER, 'content-type': 'text/markdown' }, body: text }).catch(() => null);
    if (!r?.ok) return null;
    return ((await r.json()) as { path: string }).path;
  }
}

function latest(r: Review): number {
  return r.notes.reduce((t, n) => Math.max(t, n.updated ?? 0), 0);
}

export const store = new Store();
