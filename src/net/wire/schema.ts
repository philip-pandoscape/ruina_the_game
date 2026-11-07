// What each kind of record holds, field by field, as crates/wire/src/schema.rs has it: the order is
// the wire's, each field's tier is the furthest one still refreshing it, and its run is how it goes
// on by itself between updates (a frame counter). tests/unit/wire.test.ts holds this to the Rust's
// list (tests/fixtures/wire/schema.json), so the two can't drift.

export type Tier = 'near' | 'mid' | 'far';
/** A tier's two bits on the wire. */
export const TIERS: readonly Tier[] = ['near', 'mid', 'far'];
/** Ticks between two refreshes at each tier, when the budget allows (crates/wire/src/interest.rs every). */
export const EVERY: Record<Tier, number> = { near: 1, mid: 4, far: 20 };

export type Run = { still: true } | { up: number; cap: number } | { down: number };

export interface Field {
  name: string;
  tier: Tier;
  run: Run;
}

export type KindName = 'player' | 'creature' | 'vehicle' | 'item' | 'arrow' | 'meteor';

export interface KindDef {
  name: KindName;
  /** Its byte on the wire. */
  byte: number;
  fields: readonly Field[];
  /** Which field names another entity, as a handle (null: none). */
  reference: number | null;
}

/** The first byte of an update, and of an acknowledgement. */
export const UPDATE = 1;
export const ACK = 8;
/** The most updates back a baseline may be. */
export const WINDOW = 63;
export const MAX_FIELDS = 40;
/** Handle 1 is you (0 is nobody). */
export const YOU = 1;

/** Rules frames in a server tick: a frame counter runs on three a tick. */
export const FRAMES_PER_TICK = 3;

const still: Run = { still: true };
const frames: Run = { up: FRAMES_PER_TICK, cap: 2147483647 };
const since: Run = { up: FRAMES_PER_TICK, cap: 999 };
const f = (name: string, tier: Tier, run: Run = still): Field => ({ name, tier, run });

const PLAYER: Field[] = [
  f('x', 'far'),
  f('z', 'far'),
  f('y', 'far'),
  f('facing', 'far'),
  f('run', 'near'),
  f('vx', 'mid'),
  f('vz', 'mid'),
  f('vy', 'mid'),
  f('mode', 'mid'),
  f('flags', 'mid'),
  f('attackIndex', 'mid'),
  f('attackFrame', 'mid', frames),
  f('castAbility', 'mid'),
  f('castFrame', 'mid', frames),
  f('actionId', 'near'),
  f('actionFrame', 'near', frames),
  f('flipFrame', 'near', frames),
  f('landFrame', 'near', since),
  f('landImpact', 'near'),
  f('takeoffFrame', 'near', since),
  f('stun', 'near', { down: FRAMES_PER_TICK }),
  f('downFrame', 'far', frames),
  f('hp', 'far'),
  f('team', 'far'),
  f('weapon', 'mid'),
  f('comboVariants', 'near'),
  f('bank', 'near'),
  f('crouchFrame', 'near'),
  f('airspeed', 'near'),
  f('glider', 'mid'),
  f('pack', 'mid'),
  f('vehicle', 'mid'),
  f('seat', 'mid'),
  f('host', 'mid'),
];

const CREATURE: Field[] = [
  f('x', 'far'),
  f('z', 'far'),
  f('y', 'far'),
  f('facing', 'far'),
  f('state', 'mid'),
  f('stateFrame', 'mid', frames),
  f('wait', 'mid'),
  f('hp', 'far'),
  f('deadFrame', 'far', frames),
  f('targetX', 'near'),
  f('targetZ', 'near'),
  f('kind', 'far'),
];

/** The most cargo slots a vehicle's record carries. */
export const CARGO_SLOTS = 16;

const VEHICLE: Field[] = [
  f('x', 'far'),
  f('z', 'far'),
  f('y', 'far'),
  f('heading', 'far'),
  f('pitch', 'mid'),
  f('roll', 'mid'),
  f('speed', 'mid'),
  f('steer', 'near'),
  f('throttle', 'near'),
  f('sail', 'mid'),
  f('flags', 'mid'),
  ...Array.from({ length: CARGO_SLOTS }, (_, k) => f(`cargo${k}`, 'mid')),
];

const ITEM: Field[] = [f('x', 'far'), f('z', 'far'), f('y', 'far'), f('rot', 'far')];

const ARROW: Field[] = [f('x', 'far'), f('z', 'far'), f('y', 'far'), f('vx', 'far'), f('vz', 'far'), f('team', 'far'), f('owner', 'far')];

const METEOR: Field[] = [f('x', 'far'), f('z', 'far'), f('ticksLeft', 'far', { down: 1 }), f('fallTicks', 'far'), f('team', 'far'), f('radius', 'far')];

export const KINDS: readonly KindDef[] = [
  { name: 'player', byte: 1, fields: PLAYER, reference: 33 },
  { name: 'creature', byte: 2, fields: CREATURE, reference: null },
  { name: 'vehicle', byte: 3, fields: VEHICLE, reference: null },
  { name: 'item', byte: 4, fields: ITEM, reference: null },
  { name: 'arrow', byte: 5, fields: ARROW, reference: 6 },
  { name: 'meteor', byte: 6, fields: METEOR, reference: null },
];

const BY_BYTE = new Map(KINDS.map((k) => [k.byte, k]));
const BY_NAME = new Map(KINDS.map((k) => [k.name, k]));

export function kindOfByte(b: number): KindDef | undefined {
  return BY_BYTE.get(b);
}

export function kindNamed(name: KindName): KindDef {
  return BY_NAME.get(name)!;
}

/** Something that happened: where (centimetres), what (the engine's effect kind and its cause), how big. */
export const EVENT = ['x', 'z', 'y', 'kind', 'size'] as const;

/** A player's modes, in the order the wire numbers them (the engine's Mode). */
export const MODES = ['normal', 'attack', 'cast', 'action', 'swim', 'glide', 'ride'] as const;

/** Whether an update sent at tier `sent` refreshes a field refreshed out to `field`. */
export function refreshes(sent: Tier, field: Tier): boolean {
  return TIERS.indexOf(field) >= TIERS.indexOf(sent);
}

/** The value `base` runs on to after `ticks` (crates/wire's Run::guess, to the bit). */
export function guess(run: Run, base: number, ticks: number): number {
  if ('up' in run) return base < 0 ? base : Math.min(run.cap, base + run.up * ticks);
  if ('down' in run) return base <= 0 ? base : Math.max(0, base - run.down * ticks);
  return base;
}

/** A field's index by name, for a kind. */
export function fieldIndex(kind: KindDef, name: string): number {
  const i = kind.fields.findIndex((x) => x.name === name);
  if (i < 0) throw new Error(`${kind.name} has no field ${name}`);
  return i;
}
