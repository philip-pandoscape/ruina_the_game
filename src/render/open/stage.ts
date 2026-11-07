import * as THREE from 'three';
import { streamFrom } from '../../assets/loader';
import type { World } from '../../engine/rules';
import type { DungeonDef, Ground, RegionData, WorldLayout } from '../../engine/zone';
import { GRAPHICS, PALETTE, POST } from '../look';
import { windowGlow } from '../models/glb';
import { glowMaterial } from '../models/kit';
import { groundMaterial, type TerrainView } from './terrain';
import { type SeaDepth, seaDepthTexture, WaterView } from './water';
import { horizonIsles } from './horizon';
import { foliageTime } from './leaves';
import { SkyView, seaFar, SKY_HORIZON } from './sky';
import type { FoliageView } from './foliage';
import type { ZoneDressing } from './dressing';
import { WorldPost } from './post';
import type { FallsView } from './falls';
import type { GrottoView } from './grotto';
import { ArenaView } from './arenaView';
import { DungeonView } from './dungeonView';
import { Village } from '../village/village';
import type { ModelKit } from './models';
import { RegionView } from './regionView';
import { nextOrigin, sceneOrigin, setSceneOrigin } from '../origin';

// Everything around the player in an open world: lights, sky, sea, and each region held round you,
// drawn where the world places it (regionView.ts: its ground, trees, buildings and falls), added as
// the page's worker grows them and let go behind you (src/app/regions.ts). Same surface as the
// training Stage (renderer, scene, follow, resize) so main.ts drives either. The frame goes through
// WorldPost's screen effects; how much of everything is drawn is the quality's (src/render/look.ts).
// The scene's origin moves with you (rebase, src/render/origin.ts): the camera is the scene's, and
// what the graphics card is handed stays near its origin however far you travel.

const SUN_DIR = new THREE.Vector3(14, 24, 9).normalize();
/** Milliseconds a frame spent building regions as they arrive. */
const BUILD_MS = 3;

export class OpenStage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly sun: THREE.DirectionalLight;
  readonly water: WaterView;
  readonly sky: SkyView;
  /** The region you start in, drawn (Emberholm): its views are the stage's own below. */
  readonly home: RegionView;
  /** Every region drawn, by its place in the world's map. */
  readonly regions = new Map<number, RegionView>();
  /** The buildings you can walk into of the region you start in (src/render/village): its doors, lamps and the rooms the camera stays in. */
  readonly village: Village;
  readonly hemi: THREE.HemisphereLight;
  /** Every region's ground is drawn with one material, its textures loaded once. */
  private readonly groundMat: THREE.MeshToonMaterial;
  private readonly depths = new Map<number, SeaDepth>();
  /** Every region's ground there is near you, for the views that read it. */
  private readonly ground: Ground;
  /** The screen effects. */
  readonly post: WorldPost;
  private time = 0;
  private sunDir = SUN_DIR.clone();
  private c1 = new THREE.Color();
  private c2 = new THREE.Color();

  constructor(
    canvas: HTMLCanvasElement,
    world: World,
    private models: ModelKit,
    /** The region you start in, and where the world's regions stand. */
    home: RegionData,
    layout: WorldLayout,
    /** Its sea's depths, baked already (else baked here). */
    homeDepths?: Uint8Array,
  ) {
    const hf = home.gen.terrain;
    const light = PALETTE.light;
    this.ground = world.terrain!;
    // The scene is drawn into a buffer of its own (multisampled, above low quality), so the canvas
    // needs no antialiasing.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, GRAPHICS.pixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Portraits are drawn straight to the canvas; this keeps their colours close to the graded frame.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    // Ships under construction are drawn cut off at the height built so far.
    this.renderer.localClippingEnabled = true;
    this.scene.background = new THREE.Color(SKY_HORIZON);
    // No fog in the scene: the haze is laid on from the depth buffer (post.ts).

    this.hemi = new THREE.HemisphereLight(light.sky, light.ground, light.fill);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(light.sun, light.sunIntensity);
    this.sun.castShadow = true;
    const { reach, mapSize, softness } = GRAPHICS.shadow;
    this.sun.shadow.mapSize.set(mapSize, mapSize);
    const cam = this.sun.shadow.camera;
    cam.left = -reach;
    cam.right = reach;
    cam.top = reach;
    cam.bottom = -reach;
    cam.near = 1;
    cam.far = 220;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.radius = softness;
    this.scene.add(this.sun, this.sun.target);

    this.sky = new SkyView(SUN_DIR);
    this.water = new WaterView(hf.water);
    this.groundMat = groundMaterial();
    // The region you start in: its village is the stage's, whose doors, lamps and rooms the camera
    // and everyone's cottages use.
    this.village = new Village(home.gen.buildings);
    this.home = new RegionView(home, this.ground, models, this.groundMat, this.village);
    this.regions.set(home.place, this.home);
    this.depths.set(home.place, seaDepthTexture(hf, homeDepths));
    this.scene.add(this.sky.group, this.water.mesh, this.village.group, this.home.group);
    this.post = new WorldPost(this.renderer, this.scene);
    this.post.base = hf.water;
    // Other isles on the horizon, past where anyone can go (src/render/open/horizon.ts): none where
    // another region of the world stands.
    const others = layout.regions.filter((_, i) => i !== home.place);
    const clear = (x: number, z: number, r: number) =>
      others.every((o) => {
        const c = o.chunks;
        const [x0, z0, x1, z1] = [c.x * layout.chunk, c.z * layout.chunk, (c.x + c.w) * layout.chunk, (c.z + c.d) * layout.chunk];
        return Math.hypot(Math.max(x0 - x, x - x1, 0), Math.max(z0 - z, z - z1, 0)) > r + 400;
      });
    if (GRAPHICS.isles) this.scene.add((this.isles = horizonIsles(hf.minX + hf.size / 2, hf.minZ + hf.size / 2, hf.water, clear)));
    this.seaDepthsNear(hf.minX + hf.size / 2, hf.minZ + hf.size / 2);
  }

  // ---------- The regions round you ----------

  /** The region you start in's views (its ground, trees, dressing, falls), as the stage had them before there were others. */
  get terrain(): TerrainView {
    return this.home.terrain;
  }

  get foliage(): FoliageView {
    return this.home.foliage!;
  }

  get dressing(): ZoneDressing {
    return this.home.dressing!;
  }

  get falls(): FallsView {
    return this.home.falls!;
  }

  get grottos(): GrottoView[] {
    return this.home.grottos;
  }

  /** Draws a region the page's worker grew, where the world places it (with its sea's depths, if baked there). */
  addRegion(region: RegionData, depths?: Uint8Array): RegionView {
    const had = this.regions.get(region.place);
    if (had) return had;
    // Built a little each frame (`update`), so its arrival is no long frame.
    const view = new RegionView(region, this.ground, this.models, this.groundMat, undefined, true);
    this.regions.set(region.place, view);
    this.depths.set(region.place, seaDepthTexture(region.gen.terrain, depths));
    view.group.visible = !this.inside;
    this.scene.add(view.group);
    return view;
  }

  /** Lets a region's drawing go (behind you), and what it held on the graphics card. */
  removeRegion(place: number): void {
    const view = this.regions.get(place);
    if (!view || view === this.home) return;
    this.scene.remove(view.group);
    view.dispose();
    this.regions.delete(place);
    this.depths.get(place)?.texture.dispose();
    this.depths.delete(place);
  }

  /** The sea reads the depths of the regions nearest (x, z). */
  private seaDepthsNear(x: number, z: number): void {
    const near = [...this.regions.entries()].sort((a, b) => a[1].distance(x, z) - b[1].distance(x, z)).map(([p]) => this.depths.get(p)!);
    this.water.setDepths(near);
  }

  // ---------- The scene's origin, moving with you ----------

  /** The origin held where the tests put it (pinOrigin), instead of moving with the camera. */
  private pinned: [number, number] | null = null;

  /** Holds the scene's origin at a point, or (null) lets it move with the camera again: the tests compare drawings made from different origins, and with none. */
  pinOrigin(at: [number, number] | null): void {
    this.pinned = at;
  }

  /**
   * Moves the scene's origin once the camera is far from it (src/render/origin.ts): the scene stands
   * shifted by it, the camera with it, so what the graphics card is handed stays near its origin.
   * Returns whether it moved.
   */
  rebase(cameraX: number, cameraZ: number): boolean {
    const [ox, oz] = sceneOrigin();
    const [nx, nz] = this.pinned ?? nextOrigin(ox, oz, cameraX, cameraZ);
    if (nx === ox && nz === oz) return false;
    setSceneOrigin(nx, nz);
    this.scene.position.set(-nx, 0, -nz);
    this.scene.updateMatrixWorld(true);
    return true;
  }

  /** Keeps the sun's shadow box centred on the player, wherever they are and however high. */
  follow(x: number, z: number, y = 0): void {
    const d = this.sunDir;
    this.sun.position.set(x + d.x * 110, y + d.y * 110, z + d.z * 110);
    this.sun.target.position.set(x, y, z);
  }

  /**
   * Light for the hour: the sun rises in the east, crosses the south and sets in the west; dawn and
   * dusk turn gold; at night a moon lights the isle a cool blue (bright enough to play by).
   */
  setTime(hour: number, sunrise: number, sunset: number): void {
    // Inside a dungeon there's no sky to light it: its own light, whatever the hour. An arena keeps the sky.
    if (this.inside?.dark) return this.lightInside();
    const C = (hex: number) => this.c1.setHex(hex);
    const day = Math.min(1, Math.max(0, (hour - (sunrise - 0.75)) / 1.5)) * Math.min(1, Math.max(0, (sunset + 0.75 - hour) / 1.5));
    const u = (hour - sunrise) / (sunset - sunrise);
    const phi = Math.PI * Math.min(1, Math.max(0, u));
    const el = Math.max(0.06, Math.sin(phi) * 1.05);
    const sun = new THREE.Vector3(-Math.cos(phi) * Math.cos(el), Math.sin(el), -Math.sin(phi) * Math.cos(el) * 0.8 - 0.25).normalize();
    const moon = new THREE.Vector3(0.45, 0.62, -0.62).normalize();
    // Gold when the sun is low.
    const gold = day > 0 ? Math.max(0, 1 - Math.sin(phi) / 0.42) * day : 0;
    const night = 1 - day;
    const light = PALETTE.light;
    const sky = PALETTE.sky;
    this.sunDir.copy(night > 0.6 ? moon : sun);
    const sunCol = this.c2.setHex(light.sun).lerp(C(light.goldSun), gold);
    this.sun.color.copy(night > 0.6 ? C(light.moon) : sunCol);
    this.sun.intensity = night > 0.6 ? (0.75 * (night - 0.6)) / 0.4 + 0.2 : light.sunIntensity * Math.max(0.12, day) * (1 - gold * 0.3);
    this.hemi.color.setHex(light.sky).lerp(C(light.nightSky), night * 0.85);
    this.hemi.groundColor.setHex(light.ground).lerp(C(light.nightGround), night * 0.8);
    this.hemi.intensity = light.fill * (1 - night * 0.36);
    const horizon = new THREE.Color(SKY_HORIZON).lerp(C(sky.goldHorizon), gold * 0.85).lerp(C(sky.nightHorizon), night);
    const top = new THREE.Color(sky.top).lerp(C(sky.goldTop), gold * 0.6).lerp(C(sky.nightTop), night);
    (this.scene.background as THREE.Color).copy(horizon);
    this.sky.setLight(top, horizon, sun, sunCol, night, moon);
    this.water.setBrightness(1 - night * 0.55, gold);
    this.falls.setBrightness(1 - night * 0.6);
    // Lamps and hearths indoors burn all day; they only stand out after dark.
    this.village.lampLevel = 0.55 + 0.45 * night;
    // The sea reflects the sky a little above the horizon, and the sun (or moon) glints on it.
    this.water.setSky(this.sunDir, night > 0.6 ? C(light.moon) : sunCol, horizon.clone().lerp(top, 0.3), 1 - night * 0.7);
    this.post.setAtmosphere({
      fog: horizon,
      seaFar: seaFar(horizon, night),
      sun: night > 0.6 ? C(light.moon) : sunCol,
      sunDir: this.sunDir,
      sunGlow: POST.fog.sunGlow * (1 - night * 0.8),
      exposure: POST.exposure * (1 + night * 0.5),
    });
    // Lit windows and lanterns glow brighter than white after dark, so the bloom catches them.
    glowMaterial().color.setScalar(1.1 + night * 1.6);
    windowGlow.value = Math.max(0, night - 0.25) / 0.75;
  }

  // ---------- Inside a dungeon ----------

  private dungeons = new Map<string, DungeonView | ArenaView>();
  /** The isles on the horizon (none at low quality), put away with the rest of the island inside a dungeon. */
  private isles: THREE.Object3D | null = null;
  private inside: DungeonView | ArenaView | null = null;

  /** The dungeon you're inside a copy of, drawn (null out on the island). */
  get dungeon(): string | null {
    return this.inside?.def.id ?? null;
  }

  /**
   * Into a dungeon, a space of its own: its cave drawn round its origin, the island put away, the
   * cave's own light; or into a developer zone, its arena drawn there under the sky.
   */
  enterDungeon(def: DungeonDef): void {
    let view = this.dungeons.get(def.id);
    if (!view) {
      view = def.style === 'arena' ? new ArenaView(def) : new DungeonView(def);
      this.dungeons.set(def.id, view);
      this.scene.add(view.group);
    }
    if (this.inside && this.inside !== view) this.inside.group.visible = false;
    view.group.visible = true;
    this.inside = view;
    // The island isn't in its space (it would stand where the dungeon does); an arena keeps the sky.
    for (const o of this.outdoors()) o.visible = !view.dark && o === this.sky.group;
    if (view.dark) this.lightInside();
  }

  /** Back out on the island: the cave put away, the island drawn again, lit by the sky (the next setTime). */
  leaveDungeon(): void {
    if (this.inside) this.inside.group.visible = false;
    this.inside = null;
    for (const o of this.outdoors()) o.visible = true;
    (this.scene.background as THREE.Color).set(SKY_HORIZON);
  }

  private outdoors(): THREE.Object3D[] {
    return [this.sky.group, this.water.mesh, this.village.group, ...[...this.regions.values()].map((r) => r.group), ...(this.isles ? [this.isles] : [])];
  }

  /**
   * A cave's light: a dim cool fill, and the daylight through the falls at its south end as the one
   * light that casts shadows; its torches are in its own colours (dungeonView.ts).
   */
  private lightInside(): void {
    const dark = this.c2.setHex(0x07090b);
    this.hemi.color.setHex(0x6d8a96);
    this.hemi.groundColor.setHex(0x3b2b1f);
    this.hemi.intensity = 0.55;
    this.sunDir.set(0, 0.4, -1).normalize();
    this.sun.color.setHex(0xa6dbe4);
    this.sun.intensity = 1.1;
    (this.scene.background as THREE.Color).copy(dark);
    this.post.setAtmosphere({ fog: dark, seaFar: dark, sun: this.c1.setHex(0xa6dbe4), sunDir: this.sunDir, sunGlow: 0, exposure: POST.exposure });
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
  }

  /** Draws the frame, through the screen effects. */
  render(camera: THREE.PerspectiveCamera): void {
    this.post.render(camera);
  }

  /** Per frame: the sea moves, clouds drift, grass follows you, models stream in nearest the camera first. */
  update(dt: number, camera: THREE.Camera, playerX: number, playerZ: number): void {
    // The camera is the scene's: where it is in the world is its own position.
    const cx = camera.position.x;
    const cz = camera.position.z;
    if (this.rebase(cx, cz) || this.seaFrom.distanceTo(this.v.set(cx, 0, cz)) > 128) {
      this.seaFrom.set(cx, 0, cz);
      this.seaDepthsNear(cx, cz);
    }
    // Whatever can be seen from here may load (src/assets/loader.ts), the nearest first.
    streamFrom(cx, cz, GRAPHICS.viewDistance);
    this.time += dt;
    this.water.follow(cx, cz);
    this.water.update(this.time);
    foliageTime.value = this.time;
    this.sky.update(this.time, cx, cz);
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 50;
    const height = this.renderer.getDrawingBufferSize(this.bufferSize).y;
    // A region still arriving is built a little more, the nearest first, within BUILD_MS a frame.
    const until = performance.now() + BUILD_MS;
    for (const r of [...this.regions.values()].filter((v) => !v.built).sort((a, b) => a.distance(cx, cz) - b.distance(cx, cz)))
      if (!r.buildUntil(until) || performance.now() > until) break;
    for (const r of this.regions.values()) r.update(this.time, playerX, playerZ, height, fov);
    this.inside?.update(this.time);
  }

  private seaFrom = new THREE.Vector3(Infinity, 0, Infinity);
  private v = new THREE.Vector3();

  private bufferSize = new THREE.Vector2();
}
