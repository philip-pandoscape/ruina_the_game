import * as THREE from 'three';
import type { DungeonDoor, Ground, RegionData, WaterfallInfo } from '../../engine/zone';
import { FoliageView } from './foliage';
import { ZoneDressing } from './dressing';
import { FallsView } from './falls';
import { GrottoView } from './grotto';
import { TerrainView } from './terrain';
import { Village } from '../village/village';
import type { ModelKit } from './models';

// One region of the world drawn where the world places it: its ground, its trees and rocks and the
// grass round you on it, what it was laid out with, its buildings and its waterfalls. The stage
// (stage.ts) holds one for each region held round you (src/app/regions.ts), and lets each go as you
// leave it behind.

/** Whether a crag `r` across at (x, z) would cover a waterfall's slot or the water falling down it. */
function overFalls(falls: WaterfallInfo[], x: number, z: number, r: number): boolean {
  return falls.some((f) => {
    const s = (x - f.cx) * f.ux + (z - f.cz) * f.uz;
    const t = (x - f.cx) * f.vx + (z - f.cz) * f.vz;
    return s > f.lip - r - 2 && s < f.foot + r && Math.abs(t) < f.width / 2 + 1.6 + r;
  });
}

/** The dungeon door whose portal stands on a waterfall's ledge, if one does. */
function doorOn(f: WaterfallInfo, doors: DungeonDoor[]): DungeonDoor | undefined {
  return doors.find((d) => {
    const s = (d.portal.x - f.cx) * f.ux + (d.portal.z - f.cz) * f.uz;
    const t = (d.portal.x - f.cx) * f.vx + (d.portal.z - f.cz) * f.vz;
    return s >= f.shelf.s0 - 1 && s <= f.shelf.s1 && Math.abs(t) < f.width / 2;
  });
}

export class RegionView {
  readonly group = new THREE.Group();
  readonly terrain: TerrainView;
  foliage: FoliageView | null = null;
  dressing: ZoneDressing | null = null;
  /** Its buildings you can walk into (none for a region without any). */
  village: Village | null = null;
  falls: FallsView | null = null;
  grottos: GrottoView[] = [];
  /** Its square in the world: min x, min z, max x, max z. */
  readonly bounds: [number, number, number, number];
  /** What's left to build, a step at a time, for a region arriving as you travel. */
  private steps: Array<(until: number) => boolean> = [];

  constructor(
    readonly region: RegionData,
    ground: Ground,
    models: ModelKit,
    groundMaterial: THREE.MeshToonMaterial,
    /** Its village drawn by the stage instead (the region you start in: the town whose doors and lamps the camera and players use). */
    village?: Village,
    /** Built a little each frame (`buildUntil`), not all at once: a region arriving as you travel. */
    later = false,
  ) {
    const gen = region.gen;
    const hf = gen.terrain;
    this.group.name = `region:${region.recipe.id}`;
    this.bounds = [hf.minX, hf.minZ, hf.maxX, hf.maxZ];
    this.terrain = new TerrainView(hf, groundMaterial, later);
    this.group.add(this.terrain.group);
    const falls = gen.falls ?? [];
    const once = (f: () => void) => () => (f(), true);
    this.steps = [
      (until) => this.terrain.buildUntil(until),
      once(() => {
        this.foliage = new FoliageView(hf, gen.obstacles, gen.clear, region.recipe.seed, (x, z, r) => overFalls(falls, x, z, r));
        this.group.add(this.foliage.group);
      }),
      once(() => {
        this.dressing = new ZoneDressing({ recipe: region.recipe, gen }, ground, models);
        this.group.add(this.dressing.group);
      }),
      once(() => {
        this.village = village ?? (gen.buildings.length ? new Village(gen.buildings) : null);
        if (this.village && !village) this.group.add(this.village.group);
        this.falls = new FallsView(falls);
        this.grottos = falls.map((f) => new GrottoView(f, doorOn(f, region.recipe.doors ?? [])));
        this.group.add(this.falls.group, ...this.grottos.map((g) => g.group));
      }),
    ];
    if (!later) this.buildUntil(Infinity);
  }

  /** Builds what's left of it until the clock (performance.now()) passes `until`: true once it's all built. */
  buildUntil(until: number): boolean {
    while (this.steps.length) {
      if (!this.steps[0](until)) return false;
      this.steps.shift();
      if (performance.now() > until) break;
    }
    return this.steps.length === 0;
  }

  /** Whether all of it is built. */
  get built(): boolean {
    return this.steps.length === 0;
  }

  /** How far a point is from its square (0 inside it). */
  distance(x: number, z: number): number {
    const [x0, z0, x1, z1] = this.bounds;
    return Math.hypot(Math.max(x0 - x, x - x1, 0), Math.max(z0 - z, z - z1, 0));
  }

  /** Per frame: the grass round you (only on it or near it), its crops and windmills, its falls. */
  update(time: number, playerX: number, playerZ: number, viewHeight: number, fov: number): void {
    this.foliage?.update(playerX, playerZ);
    this.dressing?.update(time);
    this.falls?.update(time, viewHeight, fov);
    for (const g of this.grottos) g.update(time);
  }

  /** Lets go of what it drew on the graphics card: its ground, and the instances it laid. */
  dispose(): void {
    this.steps = [];
    this.terrain.dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) o.dispose();
    });
  }
}
