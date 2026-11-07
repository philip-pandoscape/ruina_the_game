import { type Grown, growWhole, type RegionData, regionData, type WorldLayout, worldLayout } from '../engine/zone';
import { seaDepths } from '../render/open/seaDepths';
import { PICTURE_PX, paintMap } from '../ui/life/mapPaint';

// Growing the world's regions off the page's thread (R10.23): a Web Worker with an engine of its own
// (grower.worker.ts: the same WebAssembly, given the same content) grows each region whole as the
// page's game would (crates/engine/src/open/map.rs grow_whole), bakes its sea's depths and paints its
// map, and hands it all over with its arrays moved, not copied. The page asks for what's near you
// (regions.ts), nearest first, one at a time; nothing is grown on the page's own thread after the
// region you start in.
//
// The protocol, page to worker: `start` (the engine's file and any content given in place of the
// shipped, before it reads anything), then `grow` a region by its place in the world's map. Worker to
// page: `ready` (where the world's regions stand), `grown` (a region, and how long it took), `failed`.

/** What the page asks the worker. */
export type GrowerRequest = { t: 'start'; content: Record<string, unknown> | null } | { t: 'grow'; place: number };

/** A region as the worker hands it over: as the engine grew it (GrownWhole), with its sea's depths and map. */
export interface GrownMessage {
  t: 'grown';
  place: number;
  heights: Float32Array;
  surface: Uint8Array;
  clear: Uint8Array;
  edges: Float32Array;
  rest: Grown;
  recipe: string;
  /** How deep the sea is over each of its cells, a byte each (src/render/open/seaDepths.ts). */
  depths: Uint8Array;
  /** Its map from above, PICTURE_PX a side, RGBA (src/ui/life/mapPaint.ts). */
  picture: Uint8ClampedArray<ArrayBuffer>;
  /** Milliseconds the engine took to grow it, and all of it took. */
  growMs: number;
  allMs: number;
}

/** What the worker answers. */
export type GrowerReply = { t: 'ready'; layout: WorldLayout } | GrownMessage | { t: 'failed'; place: number; why: string };

/** The worker's side of one request, with the engine it has loaded (the tests call it on theirs): its reply, and the buffers to move with it. */
export function answer(req: GrowerRequest, now: () => number = () => performance.now()): { reply: GrowerReply; move: ArrayBuffer[] } {
  if (req.t === 'start') return { reply: { t: 'ready', layout: worldLayout() }, move: [] };
  const t0 = now();
  try {
    const g = growWhole<Grown>(req.place);
    const growMs = now() - t0;
    const region = regionData(req.place, g);
    const hf = region.gen.terrain;
    const depths = seaDepths(hf);
    const picture = paintMap(hf, { minX: hf.minX, minZ: hf.minZ, size: hf.size }, PICTURE_PX);
    const reply: GrownMessage = { t: 'grown', place: req.place, ...g, depths, picture, growMs, allMs: now() - t0 };
    return { reply, move: [g.heights.buffer, g.surface.buffer, g.clear.buffer, g.edges.buffer, depths.buffer, picture.buffer] as ArrayBuffer[] };
  } catch (e) {
    return { reply: { t: 'failed', place: req.place, why: String(e) }, move: [] };
  }
}

/** A region as the page holds it, from what the worker handed over. */
export function regionOf(m: GrownMessage): RegionData {
  return regionData(m.place, m);
}

/** Where the page talks to the worker (a Worker, or in the tests anything that answers the same way). */
export interface GrowerPort {
  postMessage(req: GrowerRequest): void;
  onmessage: ((e: { data: GrowerReply }) => void) | null;
}

/** The page's side: asks the worker for regions, one at a time, and hears each as it's grown. */
export class RegionGrower {
  /** Where the world's regions stand, once the worker's engine has read them. */
  readonly ready: Promise<WorldLayout>;
  private waiting = new Map<number, { resolve: (m: GrownMessage) => void; reject: (e: Error) => void }>();
  private onReady!: (l: WorldLayout) => void;

  constructor(
    private port: GrowerPort,
    content: Record<string, unknown> | null = null,
  ) {
    this.ready = new Promise((resolve) => (this.onReady = resolve));
    port.onmessage = (e) => this.hear(e.data);
    port.postMessage({ t: 'start', content });
  }

  /** The region at `place`, grown in the worker. */
  grow(place: number): Promise<GrownMessage> {
    const had = this.waiting.get(place);
    if (had)
      return new Promise((resolve, reject) =>
        this.waiting.set(place, { resolve: (m) => (had.resolve(m), resolve(m)), reject: (e) => (had.reject(e), reject(e)) }),
      );
    return new Promise((resolve, reject) => {
      this.waiting.set(place, { resolve, reject });
      this.port.postMessage({ t: 'grow', place });
    });
  }

  /** Regions asked for and not yet handed over. */
  get pending(): number[] {
    return [...this.waiting.keys()];
  }

  private hear(r: GrowerReply): void {
    if (r.t === 'ready') return this.onReady(r.layout);
    const w = this.waiting.get(r.place);
    this.waiting.delete(r.place);
    if (r.t === 'grown') w?.resolve(r);
    else w?.reject(new Error(`region ${r.place}: ${r.why}`));
  }
}
