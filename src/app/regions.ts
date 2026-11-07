import { asset } from '../assets/manifest';
import { propDef, structureDef } from '../content/structures';
import type { Engine } from '../engine/engine';
import { distanceTo, regionBounds, regionsNear, type WorldLayout, type ZoneRecipe } from '../engine/zone';
import { model } from '../render/assets';
import type { OpenStage } from '../render/open/stage';
import { PICTURE_PX, type WorldPictures } from '../ui/life/map';
import { type GrownMessage, type RegionGrower, regionOf } from './grower';

// The world's regions round you (R10.23): the page's worker grows those within GROW of you ahead of
// you, nearest first (grower.ts); as each arrives the page's game adopts it (its ground the rules',
// what's on it solid: Engine.adoptRegion), the stage draws it where the world places it, and the maps
// have its picture. Those you leave more than DROP behind are let go, from the rules and the drawing
// alike. Nothing is grown on the page's own thread after the region you start in, so crossing into a
// region loads nothing: it was there before you reached it.

/** Regions with a chunk this near you are grown ahead of you (m). */
export const GROW = 600;
/** And let go once you're this far from them (m): further than GROW, so turning back loses nothing. */
export const DROP = 900;

/**
 * The files a region's drawing wants (by id: its made buildings', props' and village kit's), which
 * the asset catalogue names among the files regions use (src/assets/catalog.ts).
 */
export function regionFiles(recipe: ZoneRecipe): string[] {
  const ids = new Set<string>();
  const made = (files: string[] | undefined) => {
    for (const f of files ?? []) ids.add(`models/${f}`);
  };
  for (const s of recipe.structures ?? []) {
    const def = structureDef(s.id);
    made(def.look?.model?.files);
    if (def.collider === 'building') {
      ids.add('village/kit');
      ids.add('village/props');
    }
  }
  for (const p of recipe.props ?? []) made(propDef(p.id).look?.model?.files);
  return [...ids].sort();
}

/** What happened to a region, for the tests: grown and handed over (on which frame, and how long it took), or let go. */
export interface RegionEvent {
  t: 'arrived' | 'dropped';
  place: number;
  id: string;
  /** The page's frame count when it happened. */
  frame: number;
  growMs?: number;
  allMs?: number;
  /** Milliseconds the page took to take it in (adopted, drawn, its picture). */
  takeMs?: number;
}

export interface RegionsDeps {
  engine: Engine;
  stage: OpenStage | null;
  pictures: WorldPictures | null;
  grower: RegionGrower;
  /** The page's frame count. */
  frame: () => number;
}

export class Regions {
  /** Every region's arrival and leaving, in order. */
  readonly log: RegionEvent[] = [];
  /** The place of the region you start in: kept (lives belong to it). */
  private readonly home: number;
  private inFlight: number | null = null;
  private waiters: Array<{ x: number; z: number; resolve: () => void }> = [];
  /** Places made ready for you to be put at (a teleport's): what's near them is kept until you've been there. */
  private pins: Array<{ x: number; z: number }> = [];
  private last = { x: Number.NaN, z: Number.NaN };

  constructor(private d: RegionsDeps) {
    this.home = [...d.engine.regions.keys()][0] ?? -1;
  }

  /** Each frame, where you are: what's near grown ahead of you, what's far behind let go. */
  update(x: number, z: number): void {
    const layout = this.d.engine.layout;
    if (!layout) return;
    this.last = { x, z };
    const held = this.d.engine.regions;
    // The nearest region wanted that isn't held, one at a time, so the worker always grows the nearest next.
    if (this.inFlight === null) {
      const next = regionsNear(layout, x, z, GROW).find((p) => !held.has(p));
      if (next !== undefined) this.ask(next);
    }
    // A place made ready is kept until you've been there.
    this.pins = this.pins.filter((p) => Math.hypot(p.x - x, p.z - z) > GROW);
    const far = (place: number) => [{ x, z }, ...this.pins].every((p) => distanceTo(layout, layout.regions[place], p.x, p.z) > DROP);
    for (const place of [...held.keys()]) if (place !== this.home && far(place)) this.drop(place);
    this.wake();
  }

  /** The regions held now (places), and the one on its way. */
  get held(): number[] {
    return [...this.d.engine.regions.keys()];
  }

  get pending(): number | null {
    return this.inFlight;
  }

  /** Resolves once every region within GROW of (x, z) is held: a teleport's arrival, and the tests', as if you'd come from afar. */
  readyAt(x: number, z: number): Promise<void> {
    this.pins.push({ x, z });
    return new Promise((resolve) => {
      this.waiters.push({ x, z, resolve });
      this.wake();
    });
  }

  private wake(): void {
    const layout = this.d.engine.layout;
    if (!layout) return;
    this.waiters = this.waiters.filter((w) => {
      const done = regionsNear(layout, w.x, w.z, GROW).every((p) => this.d.engine.regions.has(p));
      if (done) w.resolve();
      return !done;
    });
    // Waiting for somewhere you aren't: grow what's near it too.
    const w = this.waiters[0];
    if (w && this.inFlight === null) {
      const next = regionsNear(layout, w.x, w.z, GROW).find((p) => !this.d.engine.regions.has(p));
      if (next !== undefined) this.ask(next);
    }
  }

  private ask(place: number): void {
    this.inFlight = place;
    this.d.grower.grow(place).then(
      (m) => this.arrive(m),
      (e) => {
        console.error(e);
        this.inFlight = null;
      },
    );
  }

  /** A region handed over: adopted by the rules, drawn, on the maps. */
  private arrive(m: GrownMessage): void {
    this.inFlight = null;
    const layout = this.d.engine.layout!;
    // Turned back meanwhile: no longer wanted.
    const near = [this.last, ...this.pins].some((p) => !(distanceTo(layout, layout.regions[m.place], p.x, p.z) > DROP));
    if (!near) return this.wake();
    const t0 = performance.now();
    const region = regionOf(m);
    this.d.engine.adoptRegion(region);
    // Its files are wanted from the nearest point of it, so they come as you approach it, nearest
    // first, before its buildings and props are in view (src/assets/loader.ts).
    if (this.d.stage) this.fetchFiles(layout, m.place, region.recipe);
    this.d.stage?.addRegion(region, m.depths);
    this.d.pictures?.arrive(m.place, region.recipe, m.picture, PICTURE_PX);
    this.log.push({
      t: 'arrived',
      place: m.place,
      id: region.recipe.id,
      frame: this.d.frame(),
      growMs: m.growMs,
      allMs: m.allMs,
      takeMs: performance.now() - t0,
    });
    this.wake();
  }

  /** Asks the loader for a region's files, each wanted from the point of the region nearest you. */
  private fetchFiles(layout: WorldLayout, place: number, recipe: ZoneRecipe): void {
    const [x0, z0, x1, z1] = regionBounds(layout, layout.regions[place]);
    const at = () => ({ x: Math.min(Math.max(this.last.x, x0), x1), z: Math.min(Math.max(this.last.z, z0), z1) });
    for (const id of regionFiles(recipe)) if (asset(id)) void model(id, { need: 'near', at }).catch(() => undefined);
  }

  private drop(place: number): void {
    const id = this.d.engine.layout?.regions[place]?.id ?? String(place);
    this.d.engine.releaseRegion(place);
    this.d.stage?.removeRegion(place);
    this.log.push({ t: 'dropped', place, id, frame: this.d.frame() });
  }
}
