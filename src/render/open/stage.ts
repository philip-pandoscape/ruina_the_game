import * as THREE from 'three';
import type { World } from '../../sim/types';
import { TerrainView } from './terrain';
import { WaterView } from './water';
import { SkyView, SKY_HORIZON } from './sky';
import { FoliageView } from './foliage';
import { ZoneDressing } from './dressing';
import type { Models } from './models';

// Everything around the player in an open world: lights, sky, sea, ground, trees and buildings.
// Same surface as the training Stage (renderer, scene, follow, resize) so main.ts drives either.

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
  private time = 0;
  private sunDir = SUN_DIR.clone();
  private c1 = new THREE.Color();
  private c2 = new THREE.Color();

  constructor(canvas: HTMLCanvasElement, world: World, models: Models) {
    const hf = world.terrain!;
    const zone = world.zone!;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Ships under construction are drawn cut off at the height built so far.
    this.renderer.localClippingEnabled = true;
    this.scene.background = new THREE.Color(SKY_HORIZON);
    this.scene.fog = new THREE.Fog(SKY_HORIZON, 160, 1150);

    this.hemi = new THREE.HemisphereLight(0xe2f2ff, 0x5d7f3a, 1.25);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const cam = this.sun.shadow.camera;
    cam.left = -30;
    cam.right = 30;
    cam.top = 30;
    cam.bottom = -30;
    cam.near = 1;
    cam.far = 220;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);

    this.sky = new SkyView(SUN_DIR);
    this.terrain = new TerrainView(hf);
    this.water = new WaterView(hf);
    this.foliage = new FoliageView(hf, world.obstacles, zone.gen.clear, world.seed);
    this.dressing = new ZoneDressing(world, models);
    this.scene.add(this.sky.group, this.terrain.group, this.water.mesh, this.foliage.group, this.dressing.group);
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
    this.sunDir.copy(night > 0.6 ? moon : sun);
    const sunCol = this.c2.setHex(0xfff0d8).lerp(C(0xffa463), gold);
    this.sun.color.copy(night > 0.6 ? C(0x9fb4ff) : sunCol);
    this.sun.intensity = night > 0.6 ? 0.75 * (night - 0.6) / 0.4 + 0.2 : 2.6 * Math.max(0.12, day) * (1 - gold * 0.3);
    this.hemi.color.setHex(0xe2f2ff).lerp(C(0x5d74b8), night * 0.85);
    this.hemi.groundColor.setHex(0x5d7f3a).lerp(C(0x1e2c33), night * 0.8);
    this.hemi.intensity = 1.25 - night * 0.45;
    const horizon = new THREE.Color(SKY_HORIZON).lerp(C(0xf3c39b), gold * 0.85).lerp(C(0x1f2f52), night);
    const top = new THREE.Color(0x7fbde9).lerp(C(0x6c86c8), gold * 0.6).lerp(C(0x0a1533), night);
    (this.scene.background as THREE.Color).copy(horizon);
    (this.scene.fog as THREE.Fog).color.copy(horizon);
    this.sky.setLight(top, horizon, sun, sunCol, night, moon);
    this.water.setBrightness(1 - night * 0.55, gold);
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
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
