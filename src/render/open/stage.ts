import * as THREE from 'three';
import type { World } from '../../sim/types';
import { NEW_LOOK, PALETTE, POST } from '../look';
import { glowMaterial } from '../models/kit';
import { TerrainView } from './terrain';
import { WaterView } from './water';
import { SkyView, seaFar, SKY_HORIZON } from './sky';
import { FoliageView } from './foliage';
import { ZoneDressing } from './dressing';
import { WorldPost } from './post';
import type { Models } from './models';

// Everything around the player in an open world: lights, sky, sea, ground, trees and buildings.
// Same surface as the training Stage (renderer, scene, follow, resize) so main.ts drives either.
// In the new look (src/render/look.ts) the frame goes through WorldPost's screen effects.

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
  readonly hemi: THREE.HemisphereLight;
  /** The new look's screen effects; null in the classic look, which draws straight to the screen. */
  readonly post: WorldPost | null;
  private time = 0;
  private sunDir = SUN_DIR.clone();
  private c1 = new THREE.Color();
  private c2 = new THREE.Color();

  constructor(canvas: HTMLCanvasElement, world: World, models: Models) {
    const hf = world.terrain!;
    const zone = world.zone!;
    const light = PALETTE.light;
    // The new look draws into its own multisampled buffer, so the canvas needs no antialiasing.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !NEW_LOOK, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Portraits are drawn straight to the canvas; this keeps their colours close to the graded frame.
    if (NEW_LOOK) this.renderer.toneMapping = THREE.NeutralToneMapping;
    // Ships under construction are drawn cut off at the height built so far.
    this.renderer.localClippingEnabled = true;
    this.scene.background = new THREE.Color(SKY_HORIZON);
    // The new look's haze comes from the depth buffer instead (post.ts).
    this.scene.fog = NEW_LOOK ? null : new THREE.Fog(SKY_HORIZON, 160, 1150);

    this.hemi = new THREE.HemisphereLight(light.sky, light.ground, light.fill);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(light.sun, light.sunIntensity);
    this.sun.castShadow = true;
    const reach = NEW_LOOK ? POST.shadow.reach : 30;
    const mapSize = NEW_LOOK ? POST.shadow.mapSize : 2048;
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
    if (NEW_LOOK) this.sun.shadow.radius = POST.shadow.softness;
    this.scene.add(this.sun, this.sun.target);

    this.sky = new SkyView(SUN_DIR);
    this.terrain = new TerrainView(hf);
    this.water = new WaterView(hf);
    this.foliage = new FoliageView(hf, world.obstacles, zone.gen.clear, world.seed);
    this.dressing = new ZoneDressing(world, models);
    this.scene.add(this.sky.group, this.terrain.group, this.water.mesh, this.foliage.group, this.dressing.group);
    this.post = NEW_LOOK ? new WorldPost(this.renderer, this.scene) : null;
    if (this.post) this.post.base = hf.water;
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
    this.sun.intensity = night > 0.6 ? 0.75 * (night - 0.6) / 0.4 + 0.2 : light.sunIntensity * Math.max(0.12, day) * (1 - gold * 0.3);
    this.hemi.color.setHex(light.sky).lerp(C(light.nightSky), night * 0.85);
    this.hemi.groundColor.setHex(light.ground).lerp(C(light.nightGround), night * 0.8);
    this.hemi.intensity = light.fill * (1 - night * 0.36);
    const horizon = new THREE.Color(SKY_HORIZON).lerp(C(sky.goldHorizon), gold * 0.85).lerp(C(sky.nightHorizon), night);
    const top = new THREE.Color(sky.top).lerp(C(sky.goldTop), gold * 0.6).lerp(C(sky.nightTop), night);
    (this.scene.background as THREE.Color).copy(horizon);
    if (this.scene.fog) (this.scene.fog as THREE.Fog).color.copy(horizon);
    this.sky.setLight(top, horizon, sun, sunCol, night, moon);
    this.water.setBrightness(1 - night * 0.55, gold);
    // The new look's sea reflects the sky a little above the horizon, and the sun (or moon) glints on it.
    if (NEW_LOOK) this.water.setSky(this.sunDir, night > 0.6 ? C(light.moon) : sunCol, horizon.clone().lerp(top, 0.3), 1 - night * 0.7);
    if (this.post) {
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
    }
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
  }

  /** Draws the frame: through the new look's screen effects, or straight to the screen. */
  render(camera: THREE.PerspectiveCamera): void {
    if (this.post) this.post.render(camera);
    else this.renderer.render(this.scene, camera);
  }

  /** Per frame: the sea moves, clouds drift, grass follows you. */
  update(dt: number, camera: THREE.Camera, playerX: number, playerZ: number): void {
    this.time += dt;
    this.water.update(this.time);
    this.sky.update(this.time, camera.position.x, camera.position.z);
    this.foliage.update(playerX, playerZ);
    this.dressing.update(this.time);
  }
}
