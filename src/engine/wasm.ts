// The engine's WebAssembly (crates/engine-wasm, built by `npm run engine`): the server's rules,
// compiled for the browser and asked synchronously once a page has loaded it. A page loads it at
// its start (`loadEngine`, src/engine/load.ts has the file's address); the tests in Node load it
// from the file (tests/support/engineSetup.ts). Nothing here knows the TypeScript rules: they and
// the rest of the client ask through the bridge, which hands back what they need in their shapes.
//
// Text goes both ways through the module's memory: input (a recipe, an id) is written into room
// `alloc` gives; an answer in text (JSON) is left at `out_ptr()`, its length returned. Big arrays
// (the island's heights) are copied out from where they lie.

interface Exports {
  memory: WebAssembly.Memory;
  alloc(n: number): number;
  dealloc(p: number, n: number): void;
  out_ptr(): number;
  zone_grow(p: number, n: number): number;
  zone_heights_ptr(): number;
  zone_heights_len(): number;
  zone_surface_ptr(): number;
  zone_surface_len(): number;
  zone_clear_ptr(): number;
  zone_clear_len(): number;
  zone_json(): number;
  zone_edges_ptr(): number;
  zone_edges_len(): number;
  world_layout(): number;
  region_grow(place: number): number;
  region_recipe(place: number): number;
  building_colliders(p: number, n: number, mirror: number, x: number, z: number, rot: number, y: number): number;
  content_use(p: number, n: number): number;
  session_new(p: number, n: number): number;
  session_free(h: number): void;
  session_step(
    h: number,
    moveX: number,
    moveZ: number,
    flags: number,
    abilitySlot: number,
    movementSlot: number,
    movementHeld: number,
    aimX: number,
    aimZ: number,
    faceX: number,
    faceZ: number,
    stickX: number,
    stickY: number,
  ): number;
  session_events(h: number): number;
  session_player(h: number): number;
  session_actors(h: number): number;
  session_life(h: number): number;
  session_call(h: number, p: number, n: number): number;
  session_world_clock(h: number, t: number): void;
  session_take_life(h: number, p: number, n: number): number;
  session_view(h: number, events: number): number;
  session_solid_key(h: number): number;
  session_colliders(h: number): number;
  session_clear_ptr(h: number): number;
  session_clear_len(h: number): number;
  session_adopt_region(
    h: number,
    place: number,
    hp: number,
    hn: number,
    sp: number,
    sn: number,
    cp: number,
    cn: number,
    ep: number,
    en: number,
    jp: number,
    jn: number,
  ): number;
}

let engine: Exports | null = null;

/** Takes an instance of the engine's module as the one to ask (the tests', loaded from the file). */
export function useEngine(exports: WebAssembly.Exports): void {
  engine = exports as unknown as Exports;
}

/** Fetches and starts the engine, once per page. */
export async function loadEngine(url: string): Promise<void> {
  if (engine) return;
  const bytes = await (await fetch(url)).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  useEngine(instance.exports);
}

/** The loaded engine's exports, for the bridge's other modules (src/engine/session.ts, minigames.ts). */
export function wasm(): Exports {
  if (!engine) throw new Error("the engine isn't loaded: await loadEngine() at the page's start (src/engine/load.ts)");
  return engine;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Calls `f` with `s` written into the engine's memory. */
export function withText<T>(s: string, f: (p: number, n: number) => T): T {
  const e = wasm();
  const bytes = encoder.encode(s);
  const p = e.alloc(bytes.length);
  new Uint8Array(e.memory.buffer, p, bytes.length).set(bytes);
  try {
    return f(p, bytes.length);
  } finally {
    e.dealloc(p, bytes.length);
  }
}

/** The answer an engine call left, `n` bytes of JSON. */
export function answer<T>(n: number): T {
  const e = wasm();
  return JSON.parse(decoder.decode(new Uint8Array(e.memory.buffer, e.out_ptr(), n))) as T;
}

/**
 * Content bundles for the engine to read in place of the ones built into it, each by its path under
 * shared/ ("items.json", "regions/emberholm.json"): before anything has asked the engine anything (the
 * tests that add content as data alone, tests/unit/newContent.test.ts).
 */
export function useContent(bundles: Record<string, unknown>): void {
  const e = wasm();
  if (!withText(JSON.stringify(bundles), (p, n) => e.content_use(p, n))) throw new Error('the engine has read its content already, or these are not bundles');
}

/** A zone as the engine grows it: the ground's arrays, and the rest as the engine writes it. */
export interface GrownZone<Rest> {
  /** Vertex heights, row by row. */
  heights: Float32Array;
  /** What each cell is made of. */
  surface: Uint8Array;
  /** Cells kept clear of trees and rocks. */
  clear: Uint8Array;
  /** The grid's shape (cells, cell, water, min), colliders, roads, ramps, placements, waterfalls, buildings. */
  rest: Rest;
}

/** Grows the zone a recipe describes (crates/engine/src/open/generate.rs). */
export function growZone<Rest>(recipe: object): GrownZone<Rest> {
  const e = wasm();
  if (!withText(JSON.stringify(recipe), (p, n) => e.zone_grow(p, n))) throw new Error('the engine could not read the zone recipe');
  const copy = <A extends Float32Array | Uint8Array>(make: new (b: ArrayBuffer, o: number, n: number) => A, p: number, n: number): A =>
    new make(e.memory.buffer, p, n).slice() as A;
  return {
    heights: copy(Float32Array, e.zone_heights_ptr(), e.zone_heights_len()),
    surface: copy(Uint8Array, e.zone_surface_ptr(), e.zone_surface_len()),
    clear: copy(Uint8Array, e.zone_clear_ptr(), e.zone_clear_len()),
    rest: answer<Rest>(e.zone_json()),
  };
}

/** A region of the world grown whole (crates/engine/src/open/map.rs grow_whole), as a worker hands it over. */
export interface GrownWhole<Rest> extends GrownZone<Rest> {
  /** Its edges as its recipe grew them, before its borders were blended (the outer two rows and columns). */
  edges: Float32Array;
  /** Its recipe as the engine reads it (JSON text). */
  recipe: string;
}

/** Grows the region at `place` in the world's map whole, its borders blended where the world places it. */
export function growWhole<Rest>(place: number): GrownWhole<Rest> {
  const e = wasm();
  if (!e.region_grow(place)) throw new Error(`the world has no region at ${place}`);
  const copy = <A extends Float32Array | Uint8Array>(make: new (b: ArrayBuffer, o: number, n: number) => A, p: number, n: number): A =>
    new make(e.memory.buffer, p, n).slice() as A;
  const grown = {
    heights: copy(Float32Array, e.zone_heights_ptr(), e.zone_heights_len()),
    surface: copy(Uint8Array, e.zone_surface_ptr(), e.zone_surface_len()),
    clear: copy(Uint8Array, e.zone_clear_ptr(), e.zone_clear_len()),
    edges: copy(Float32Array, e.zone_edges_ptr(), e.zone_edges_len()),
    rest: answer<Rest>(e.zone_json()),
  };
  const n = e.region_recipe(place);
  return { ...grown, recipe: decoder.decode(new Uint8Array(e.memory.buffer, e.out_ptr(), n)) };
}

/** Writes arrays into the engine's memory for one call, and gives the room back after. */
export function withArrays<T>(arrays: Array<Float32Array | Uint8Array>, f: (at: Array<[number, number]>) => T): T {
  const e = wasm();
  const rooms = arrays.map((a) => {
    const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const p = e.alloc(bytes.length);
    new Uint8Array(e.memory.buffer, p, bytes.length).set(bytes);
    return { p, n: bytes.length, count: a.length };
  });
  try {
    return f(rooms.map((r) => [r.p, r.count]));
  } finally {
    for (const r of rooms) e.dealloc(r.p, r.n);
  }
}

/** Everything solid about a building plan placed at (x, z), turned `rot`, on ground at `y`: as the engine has it. */
export function buildingSolids<Solids>(id: string, mirror: boolean, x: number, z: number, rot: number, y: number): Solids | null {
  const e = wasm();
  const n = withText(id, (p, len) => e.building_colliders(p, len, mirror ? 1 : 0, x, z, rot, y));
  return n ? answer<Solids>(n) : null;
}
