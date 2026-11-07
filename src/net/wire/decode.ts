// Reading an update as it is on the wire, before anything is applied (crates/wire/src/decode.rs):
//
//   update  [1][seq u32][tick u32]
//           [removals varint] then a u16 handle each
//           [intros varint]   then each: u16 handle, u8 kind, and the kind's own:
//                             player: zigzag id, u8 flags (1 a bot), varint length and the name's UTF-8
//                             creature, arrow, meteor: zigzag id
//                             vehicle, item: zigzag owner, zigzag id, varint place in its list
//           [records varint]  then each: u16 handle, u8 base (tier << 6 | updates back, 0 for none),
//                             varint mask, a zigzag varint per field in the mask
//           [events varint]   then each: varint mask, a zigzag varint per field in it

import { BadMessage, bit, Reader, unzigzag32 } from './bytes';
import { EVENT, type KindDef, kindOfByte, MAX_FIELDS, type Tier, TIERS, UPDATE } from './schema';

/** What the browser is told once of each thing, beside its handle. */
export type Intro =
  | { kind: 'player'; id: number; name: string; bot: boolean }
  | { kind: 'creature'; id: number }
  | { kind: 'vehicle'; owner: number; id: number; def: number }
  | { kind: 'item'; owner: number; id: number; def: number }
  | { kind: 'arrow'; id: number }
  | { kind: 'meteor'; id: number };

/** One record as written: what it's measured against, and the changes. */
export interface Entry {
  handle: number;
  tier: Tier;
  /** How many updates back its baseline is; 0: against zeros. */
  back: number;
  mask: number;
  /** The change to each field in the mask, the rest 0. */
  deltas: Int32Array;
}

export interface Update {
  seq: number;
  tick: number;
  removals: number[];
  intros: Array<{ handle: number; intro: Intro }>;
  records: Entry[];
  /** Each as x, z, y (centimetres), kind, size. */
  events: number[][];
}

const utf8 = new TextDecoder();

/** The update's number, without reading the rest (a stale one isn't read further). */
export function updateSeq(bytes: Uint8Array): number {
  const r = new Reader(bytes);
  if (r.u8() !== UPDATE) throw new BadMessage('not an update');
  return r.u32();
}

/** Reads an update. `kindOf` says what kind each handle already heard is. */
export function readUpdate(bytes: Uint8Array, kindOf: (handle: number) => KindDef | undefined): Update {
  const r = new Reader(bytes);
  if (r.u8() !== UPDATE) throw new BadMessage('not an update');
  const seq = r.u32();
  const tick = r.u32();
  const removals: number[] = [];
  for (let n = count(r); n > 0; n--) removals.push(r.u16());
  const intros: Update['intros'] = [];
  for (let n = count(r); n > 0; n--) {
    const handle = r.u16();
    const kind = kindOfByte(r.u8());
    if (!kind) throw new BadMessage('an unknown kind');
    intros.push({ handle, intro: readIntro(r, kind) });
  }
  const records: Entry[] = [];
  for (let n = count(r); n > 0; n--) {
    const handle = r.u16();
    const base = r.u8();
    const tier = TIERS[base >> 6];
    if (!tier) throw new BadMessage('an unknown tier');
    let kind: KindDef | undefined;
    for (let i = intros.length - 1; i >= 0 && !kind; i--) if (intros[i].handle === handle) kind = kindOfByte(byteOf(intros[i].intro));
    kind ??= kindOf(handle);
    if (!kind) throw new BadMessage('a record for nobody');
    const { mask, deltas } = readFields(r, kind.fields.length);
    records.push({ handle, tier, back: base & 63, mask, deltas });
  }
  const events: number[][] = [];
  for (let n = count(r); n > 0; n--) events.push([...readFields(r, EVENT.length).deltas.subarray(0, EVENT.length)]);
  if (!r.done) throw new BadMessage('an update with more after it');
  return { seq, tick, removals, intros, records, events };
}

function count(r: Reader): number {
  const n = r.varint();
  if (n > 65536) throw new BadMessage('a count past the handles');
  return n;
}

function readFields(r: Reader, n: number): { mask: number; deltas: Int32Array } {
  const mask = r.varint();
  if (mask >= 2 ** n) throw new BadMessage("a mask past the kind's fields");
  const deltas = new Int32Array(MAX_FIELDS);
  for (let i = 0; i < n; i++) if (bit(mask, i)) deltas[i] = unzigzag32(r.varint32());
  return { mask, deltas };
}

const BYTES: Record<Intro['kind'], number> = { player: 1, creature: 2, vehicle: 3, item: 4, arrow: 5, meteor: 6 };

function byteOf(i: Intro): number {
  return BYTES[i.kind];
}

function readIntro(r: Reader, kind: KindDef): Intro {
  switch (kind.name) {
    case 'player': {
      const id = r.zigzag();
      const bot = (r.u8() & 1) === 1;
      const name = utf8.decode(r.bytesOf(r.varint()));
      return { kind: 'player', id, name, bot };
    }
    case 'vehicle':
    case 'item': {
      const owner = r.zigzag();
      const id = r.zigzag();
      const def = r.varint();
      return { kind: kind.name, owner, id, def };
    }
    default:
      return { kind: kind.name, id: r.zigzag() };
  }
}
