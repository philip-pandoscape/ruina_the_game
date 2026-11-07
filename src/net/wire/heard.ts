// The world as this browser has heard it from the server's updates (crates/wire/src/heard.rs is the
// same in Rust, held to this by the golden fixtures): every entity in sight by its handle, with its
// states from the oldest the server may still measure against to the newest, and the
// acknowledgement to send back after each update.
//
// An update is applied whole or not at all, and only in order: one no newer than the newest applied
// is stale and dropped, never acknowledged, so the server counts it lost; one naming a baseline this
// side doesn't have is broken, dropped the same way and counted in `errors` (the server can't send one).

import { type Intro, readUpdate, type Update, updateSeq } from './decode';
import { ACK, guess, type KindDef, kindNamed, MAX_FIELDS, refreshes, type Tier, WINDOW } from './schema';

/** An entity's state as of an update that held it. */
export interface State {
  seq: number;
  tick: number;
  fields: Int32Array;
}

/** Something in sight, by its handle. */
export interface Ent {
  intro: Intro;
  kind: KindDef;
  /** The tier it was last sent at. */
  tier: Tier;
  /** Oldest first; the newest is the last. */
  states: State[];
}

/** What applying an update did. */
export interface Applied {
  seq: number;
  tick: number;
  removed: number[];
  introduced: number[];
  /** Handles with a fresh state from this update. */
  fresh: number[];
  /** Of those, the ones sent whole (every field, whatever the tier). */
  whole: number[];
  events: number[][];
}

export interface Ack {
  seq: number;
  bits: number;
}

/** After applying update `seq`, given the acknowledgement before it (crates/wire's Ack::after). */
export function ackAfter(a: Ack, seq: number): Ack {
  if (a.seq === 0) return { seq, bits: 0 };
  const gap = (seq - a.seq) >>> 0;
  let bits: number;
  if (gap >= 33) bits = 0;
  else if (gap === 32) bits = 0x80000000;
  else bits = ((a.bits << gap) | (1 << (gap - 1))) >>> 0;
  return { seq, bits };
}

/** The acknowledgement as it goes on the wire: [8][seq u32][bits u32]. */
export function ackBytes(a: Ack): ArrayBuffer {
  const b = new DataView(new ArrayBuffer(9));
  b.setUint8(0, ACK);
  b.setUint32(1, a.seq, true);
  b.setUint32(5, a.bits, true);
  return b.buffer;
}

/** Whether u32 `a` comes before `b`, counting round. */
const before = (a: number, b: number): boolean => (a - b) >>> 0 >= 0x80000000;

const sameIntro = (a: Intro, b: Intro): boolean => JSON.stringify(a) === JSON.stringify(b);

export class Heard {
  readonly ents = new Map<number, Ent>();
  private acked: Ack = { seq: 0, bits: 0 };
  /** Updates that couldn't be applied (a baseline this side doesn't have): always 0 when both sides keep to the protocol. */
  errors = 0;
  /** Updates dropped as no newer than the newest applied. */
  stale = 0;

  /** What to send back now. */
  ack(): Ack {
    return this.acked;
  }

  /** Forgets everything heard (the server forgets what it sent at the same moment). */
  reset(): void {
    this.ents.clear();
  }

  private isStale(seq: number): boolean {
    return this.acked.seq !== 0 && (seq - this.acked.seq - 1) >>> 0 >= 0x80000000;
  }

  /** Reads and applies an update; null if it was stale or broken (dropped, and not acknowledged). */
  hear(bytes: Uint8Array): Applied | null {
    if (this.isStale(updateSeq(bytes))) {
      this.stale++;
      return null;
    }
    return this.apply(readUpdate(bytes, (h) => this.ents.get(h)?.kind));
  }

  apply(u: Update): Applied | null {
    if (this.isStale(u.seq)) {
      this.stale++;
      return null;
    }
    // Worked out first, so a broken update changes nothing.
    const states: Array<{ handle: number; state: State; base: number | null }> = [];
    for (const e of u.records) {
      let kind: KindDef | undefined;
      for (let i = u.intros.length - 1; i >= 0 && !kind; i--) if (u.intros[i].handle === e.handle) kind = kindNamed(u.intros[i].intro.kind);
      if (!kind) {
        if (u.removals.includes(e.handle)) return this.broken();
        kind = this.ents.get(e.handle)?.kind;
        if (!kind) return this.broken();
      }
      const n = kind.fields.length;
      const fields = new Int32Array(MAX_FIELDS);
      let base: number | null = null;
      if (e.back === 0) {
        fields.set(e.deltas.subarray(0, n));
      } else {
        const want = (u.seq - e.back) >>> 0;
        const from = this.ents.get(e.handle)?.states.find((s) => s.seq === want);
        if (!from) return this.broken();
        const ticks = (u.tick - from.tick) >>> 0;
        kind.fields.forEach((f, i) => {
          fields[i] = refreshes(e.tier, f.tier) ? (guess(f.run, from.fields[i], ticks) + e.deltas[i]) | 0 : from.fields[i];
        });
        base = want;
      }
      states.push({ handle: e.handle, state: { seq: u.seq, tick: u.tick, fields }, base });
    }

    const done: Applied = { seq: u.seq, tick: u.tick, removed: [], introduced: [], fresh: [], whole: [], events: u.events };
    for (const h of u.removals) if (this.ents.delete(h)) done.removed.push(h);
    for (const { handle, intro } of u.intros) {
      // Introduced again (the server says it until an introduction is acknowledged): the same
      // entity, whose states it may yet measure against. A handle is only given to something else
      // once its removal has been applied here, so one held already is this one.
      const held = this.ents.get(handle);
      if (held && sameIntro(held.intro, intro)) continue;
      this.ents.set(handle, { intro, kind: kindNamed(intro.kind), tier: 'near', states: [] });
      done.introduced.push(handle);
    }
    u.records.forEach((e, k) => {
      const { handle, state, base } = states[k];
      const ent = this.ents.get(handle);
      if (!ent) return;
      ent.tier = e.tier;
      // What the server may still measure against from now on: this baseline and what's newer (its
      // baselines only move on), within the window.
      while (ent.states.length && ((base !== null && before(ent.states[0].seq, base)) || (u.seq - ent.states[0].seq) >>> 0 > WINDOW)) ent.states.shift();
      ent.states.push(state);
      done.fresh.push(handle);
      if (e.back === 0) done.whole.push(handle);
    });
    this.acked = ackAfter(this.acked, u.seq);
    return done;
  }

  private broken(): null {
    this.errors++;
    return null;
  }
}
