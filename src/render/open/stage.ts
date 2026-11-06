import * as THREE from 'three';
import { streamFrom } from '../../assets/loader';
import type { World } from '../../engine/rules';
import type { DungeonDef, DungeonDoor, WaterfallInfo } from '../../engine/zone';
import { GRAPHICS, PALETTE, POST } from '../look';
import { windowGlow } from '../models/glb';
import { glowMaterial } from '../models/kit';
import { TerrainView } from './terrain';
import { WaterView } from './water';
import { horizonIsles } from './horizon';
import { foliageTime } from './leaves';
import { SkyView, seaFar, SKY_HORIZON } from './sky';
import { FoliageView } from './foliage';
import { ZoneDressing } from './dressing';
import { WorldPost } from './post';
import { FallsView } from './falls';
import { GrottoView } from './grotto';
import { ArenaView } from './arenaView';
import { DungeonView } from './dungeonView';
import { Village } from '../village/village';
import type { ModelKit } from './models';

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

// Everything around the player in an open world: lights, sky, sea, ground, trees and buildings.
// Same surface as the training Stage (renderer, scene, follow, resize) so main.ts drives either.
// The frame goes through WorldPost's screen effects; how much of everything is drawn is the
// quality's (src/render/look.ts).

const SUN_DIR = new THREE.Vector3(14, 24, 9).normalize();

export class OpenStage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly sun: THREE.DirectionalLight;
  readonly terrain: TerrainView;
  readonly water: WaterView;
  readonly sky: SkyView;
  readonly foliage: FoliageView;
  readonly dressing: ZoneDressing;
  /** The island's waterfalls, and the goblins' ledges behind them. */
  readonly falls: FallsView;
  readonly grottos: GrottoView[];
  /** The buildings you can walk into (src/render/village). */
  readonly village: Village;
  readonly hemi: THREE.HemisphereLight;
  /** The screen effects. */
  readonly post: WorldPost;
  private time = 0;
  private sunDir = SUN_DIR.clone();
  private c1 = new THREE.Color();
  private c2 = new THREE.Color();

  constructor(canvas: HTMLCanvasElement, world: World, models: ModelKit) {
    const hf = world.terrain!;
    const zone = world.zone!;
    const light = PALETTE.light;
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
    this.terrain = new TerrainView(hf);
    this.water = new WaterView(hf);
    const falls = zone.gen.falls ?? [];
    this.foliage = new FoliageView(hf, world.obstacles, zone.gen.clear, world.seed, (x, z, r) => overFalls(falls, x, z, r));
    this.dressing = new ZoneDressing(world, models);
    this.village = new Village(zone.gen.buildings);
    this.falls = new FallsView(falls);
    this.grottos = falls.map((f) => new GrottoView(f, doorOn(f, zone.recipe.dungeons ?? [])));
    this.scene.add(
      this.sky.group,
      this.terrain.group,
      this.water.mesh,
      this.foliage.group,
      this.dressing.group,
      this.village.group,
      this.falls.group,
      ...this.grottos.map((g) => g.group),
    );
    this.post = new WorldPost(this.renderer, this.scene);
    this.post.base = hf.water;
    // Other isles on the horizon, past where anyone can go (src/render/open/horizon.ts).
    if (GRAPHICS.isles) this.scene.add((this.isles = horizonIsles(hf.min + hf.size / 2, hf.min + hf.size / 2, hf.water)));
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
   * Into a dungeon: its cave drawn round its origin, the island put away, the cave's own light; or
   * into a developer zone, its arena drawn there under the sky, the island still in view below.
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
    if (!view.dark) return;
    for (const o of this.outdoors()) o.visible = false;
    this.lightInside();
  }

  /** Back out on the island: the cave put away, the island drawn again, lit by the sky (the next setTime). */
  leaveDungeon(): void {
    if (this.inside) this.inside.group.visible = false;
    this.inside = null;
    for (const o of this.outdoors()) o.visible = true;
    (this.scene.background as THREE.Color).set(SKY_HORIZON);
  }

  private outdoors(): THREE.Object3D[] {
    return [
      this.sky.group,
      this.terrain.group,
      this.water.mesh,
      this.foliage.group,
      this.dressing.group,
      this.village.group,
      this.falls.group,
      ...this.grottos.map((g) => g.group),
      ...(this.isles ? [this.isles] : []),
    ];
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
    // Whatever can be seen from here may load (src/assets/loader.ts), the nearest first.
    streamFrom(camera.position.x, camera.position.z, GRAPHICS.viewDistance);
    this.time += dt;
    this.water.update(this.time);
    foliageTime.value = this.time;
    this.sky.update(this.time, camera.position.x, camera.position.z);
    this.foliage.update(playerX, playerZ);
    this.dressing.update(this.time);
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 50;
    this.falls.update(this.time, this.renderer.getDrawingBufferSize(this.bufferSize).y, fov);
    for (const g of this.grottos) g.update(this.time);
    this.inside?.update(this.time);
  }

  private bufferSize = new THREE.Vector2();
}
