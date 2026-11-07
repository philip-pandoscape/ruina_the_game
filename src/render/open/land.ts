import { toScene } from '../origin';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  type IslandView,
  type Scarecrow,
  type Vehicle,
  cellCentre,
  scarecrowPost,
  stageOf,
  housePose,
  isComplete,
  nodeReady,
  sailEfficiency,
  stormAt,
} from '../../engine/life';
import { type PlayerState, angleDiff } from '../../engine/rules';
import { toLocal, toWorld, type Heightfield } from '../../engine/zone';
import type { Hero, SeatPose } from '../character';
import { rideable, glider as gliderDef, isBoat, isMount, type RideableDef } from '../../content/vehicles';
import { FARM, cropDef } from '../../content/farming';
import { PLOT_MARKER, blueprintDef } from '../../content/housing';
import { groundPlaced } from '../../content/items';
import { buildingPlan } from '../../content/buildings';
import type { HouseView } from '../village/village';
import { toon } from '../toon';
import type { ModelKit } from './models';
import type { Holds, VehicleAnim } from '../models/vehicles';
import { shipDesign } from '../../content/shipyard';

// Draws what the life systems own: vehicles and mounts, every trade pack (on a back, in a cart,
// on the ground), scarecrow plots and what grows in them, houses as far as they are built, the
// resource nodes, the glider over your head and the scarecrow you are about to place.

/** A seat this frame: where it is and how it's turned, how to sit in it and what to hold (the driver's wheel or oars). */
export interface Seated extends SeatPose {
  pose: string;
  holds: Holds | null;
}

/** Sits a body in a seat, or (null) back on its feet. */
export function sitIn(hero: Hero, s: Seated | null): void {
  hero.seat = s;
  hero.seatPose = s?.pose ?? '';
  hero.seatHolds = s?.holds ?? null;
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

interface Shown {
  root: THREE.Object3D;
  animate?: (dt: number, s: VehicleAnim) => void;
  mount?: (dt: number, s: { speed: number; grounded: boolean }) => void;
  /** What the rider's hands hold and feet rest on (vehicles.ts Holds). */
  holds?: Holds;
  def: RideableDef;
  cargo: THREE.Object3D[];
}

/** Everything the farm plots are drawn from: where each is, and what is in each cell at what stage. */
function plotKey(scarecrows: Scarecrow[]): string {
  const cell = (c: Scarecrow['cells'][number]) => (c ? `${c.crop}${stageOf(c)}${c.animal ? (c.growth >= 1 ? 'A' : 'a') : ''}${c.watered ? 'w' : ''}` : '');
  return scarecrows.map((sc) => `${sc.id}@${sc.x},${sc.z},${sc.rot}:${sc.cells.map(cell).join(',')}`).join('|');
}

/** How far over the terrain a farm's soil and its furrows are drawn (metres), and the furrows' size. */
const SOIL_LIFT = 0.05;
const FURROW = { lift: 0.07, height: 0.08, width: 0.35, inset: 0.4, segments: 16 };

/**
 * The most a mesh laid over the terrain (its vertices in world coordinates) stands above the ground
 * anywhere on it: every triangle sampled across, not just at its corners, as the terrain's own
 * triangles fold under it. A centimetre more, for what falls between the samples.
 */
function standsOver(hf: Heightfield, geo: THREE.BufferGeometry, steps = 6): number {
  const pos = geo.getAttribute('position');
  const index = geo.getIndex();
  const n = index ? index.count : pos.count;
  const at = (k: number) => (index ? index.getX(k) : k);
  let top = -Infinity;
  for (let t = 0; t + 2 < n; t += 3) {
    const a = at(t);
    const b = at(t + 1);
    const c = at(t + 2);
    for (let i = 0; i <= steps; i++)
      for (let j = 0; j <= steps - i; j++) {
        const u = i / steps;
        const v = j / steps;
        const w = 1 - u - v;
        const x = pos.getX(a) * w + pos.getX(b) * u + pos.getX(c) * v;
        const y = pos.getY(a) * w + pos.getY(b) * u + pos.getY(c) * v;
        const z = pos.getZ(a) * w + pos.getZ(b) * u + pos.getZ(c) * v;
        top = Math.max(top, y - hf.height(x, z));
      }
  }
  return top + 0.01;
}

export class LifeView {
  readonly group = new THREE.Group();
  private vehicles = new Map<number, Shown>();
  private packMeshes = new Map<number, THREE.Object3D>();
  private plots = new THREE.Group();
  private houses = new THREE.Group();
  private slips = new THREE.Group();
  private shipKey = '';
  /**
   * Where houses built from the village kit are drawn (src/render/village: the island's Village,
   * which also cuts them open when you are inside); without one they are drawn here.
   */
  houseSink: ((houses: HouseView[]) => void) | null = null;
  /** The townsfolk, drawn here with their own models (none for someone else's island). */
  private villagers: Array<{
    holder: THREE.Group;
    animate: (dt: number, s: { time: number; talking: boolean }) => void;
    id: string;
    facing: number;
    x: number;
    z: number;
  }> = [];
  /** True when the townsfolk are drawn here, so the crowd renderer should leave them out. */
  readonly drawsTownsfolk: boolean;
  /** The NPC whose dialog is open, so they gesture while you talk. */
  talkingTo: string | null = null;
  /** A townsperson's model (on the ground at their post, turned the way they face), if drawn here. */
  villager(id: string): THREE.Object3D | null {
    return this.villagers.find((v) => v.id === id)?.holder ?? null;
  }
  private nodes: Array<{ root: THREE.Object3D; id: string } | null> = [];
  private ghost: THREE.Mesh;
  private gliderModel: { root: THREE.Object3D; animate?: (dt: number, s: { bank: number; pitch: number; speed: number }) => void } | null = null;
  private gliderShown = '';
  private builtRevision = -1;
  private houseKey = '';
  private rain: THREE.Points;
  private rainOn = 0;
  /** Under a roof of rock (inside a dungeon): no rain falls here. */
  indoors = false;
  private updrafts: THREE.Group;
  private time = 0;
  private cropGeoCache = new Map<string, THREE.BufferGeometry>();
  private cropMat = toon(0xffffff, { vertexColors: true });
  private plotCount = -1;
  /** What the farm plots were last built from (plotKey). */
  private plotKey = '';
  /** Farm animals in plot cells, with what they need to animate. */
  private animals: Array<{
    root: THREE.Object3D;
    sc: number;
    idx: number;
    animate?: (dt: number, s: { time: number; hungry: boolean; ready: boolean }) => void;
    phase: number;
  }> = [];
  /** The farm plots as drawn: where each lies and how it's turned, half its side, and the most its soil and furrows stand over the terrain. */
  private plotGround: Array<{ x: number; z: number; rot: number; half: number; top: number }> = [];
  /** Those heights by where a plot lies, kept while it lies there (they only change when one is put down). */
  private plotTops = new Map<string, number>();
  private soilMat = toon(0x6e4a2e);
  private furrowMat = toon(0x5a3a22);
  private wetGeo = new THREE.CircleGeometry(0.75, 10).rotateX(-Math.PI / 2);
  private wetMat = new THREE.MeshBasicMaterial({ color: 0x3b2614, transparent: true, opacity: 0.45, depthWrite: false });
  /** Called when the ground changes under the grass (a plot placed, a house begun). */
  onGroundChanged: (() => void) | null = null;

  /** Draws someone else's things (their farms, house, vehicles, packs and glider) rather than yours and the island's: no nodes, townsfolk, weather or placement ghost. */
  readonly others: boolean;
  /** The vehicle placeRide put under its driver this frame, which update() leaves where it is. */
  private placed = -1;

  constructor(
    scene: THREE.Scene,
    private life: IslandView,
    private models: ModelKit,
    private hero: Hero,
    opts: { others?: boolean } = {},
  ) {
    this.others = !!opts.others;
    scene.add(this.group);
    this.group.add(this.plots, this.houses, this.slips);
    const hf = life.zone.gen.terrain;
    // Resource nodes (they vanish while picked clean).
    if (!this.others)
      for (const nd of life.zone.recipe.nodes) {
        const root = models.buildStructure(nd.kind).root;
        root.position.set(nd.x, hf.height(nd.x, nd.z), nd.z);
        root.rotation.y = nd.rot;
        this.group.add(root);
        this.nodes.push({ root, id: nd.id });
      }
    // The townsfolk as their looks say (content/npcs/<id>.json `look`), standing at their posts.
    for (const n of this.others ? [] : life.zone.recipe.npcs) {
      const m = models.buildVillager(n.id, n.look);
      const holder = new THREE.Group();
      holder.add(m.root);
      holder.position.set(n.x, hf.height(n.x, n.z), n.z);
      holder.rotation.y = n.facing;
      this.group.add(holder);
      this.villagers.push({ holder, animate: m.animate.bind(m), id: n.id, facing: n.facing, x: n.x, z: n.z });
    }
    this.drawsTownsfolk = !this.others;

    // Placement ghost: the 8 x 8 plot outline, green when it fits, red when it does not.
    const half = (FARM.scarecrowCells * FARM.cell) / 2;
    const ghostGeo = new THREE.PlaneGeometry(half * 2, half * 2).rotateX(-Math.PI / 2);
    this.ghost = new THREE.Mesh(ghostGeo, new THREE.MeshBasicMaterial({ color: 0x7bed9f, transparent: true, opacity: 0.38, depthWrite: false }));
    this.ghost.visible = false;
    this.ghost.renderOrder = 3;
    if (!this.others) this.group.add(this.ghost);
    // Rain: a column of streaks that follows the camera.
    const n = 2400;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 60;
      pos[i * 3 + 1] = Math.random() * 30;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 60;
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.rain = new THREE.Points(rg, new THREE.PointsMaterial({ color: 0xcfe6ff, size: 0.09, transparent: true, opacity: 0, depthWrite: false }));
    this.rain.frustumCulled = false;
    if (!this.others) this.group.add(this.rain);
    // Updrafts: spiralling wisps so you can find the rising air.
    this.updrafts = new THREE.Group();
    for (const u of this.others ? [] : life.zone.recipe.updrafts) {
      const wisp = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.32, depthWrite: false });
      for (let k = 0; k < 26; k++) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 3.2), mat);
        m.userData = { phase: k / 26, r: u.r * (0.35 + (0.6 * ((k * 7) % 10)) / 10) };
        wisp.add(m);
      }
      wisp.position.set(u.x, hf.height(u.x, u.z), u.z);
      wisp.userData = { top: u.top - hf.height(u.x, u.z) };
      this.updrafts.add(wisp);
    }
    this.group.add(this.updrafts);
  }

  private cropGeo(id: string, stage: number): THREE.BufferGeometry {
    const key = `${id}:${stage}`;
    let g = this.cropGeoCache.get(key);
    if (!g) {
      g = this.models.cropGeometry(id, stage);
      this.cropGeoCache.set(key, g);
    }
    return g;
  }

  /** Rebuilds farms when anything in them changed shape. */
  private rebuildPlots(): void {
    const hf = this.life.zone.gen.terrain;
    this.animals = [];
    for (const c of [...this.plots.children]) {
      this.plots.remove(c);
      if (c instanceof THREE.InstancedMesh) c.dispose();
      // The soil and furrows are made afresh each time (the models and crop shapes are shared).
      else if (c.userData.ground) (c as THREE.Mesh).geometry.dispose();
    }
    const half = (FARM.scarecrowCells * FARM.cell) / 2;
    const byGeo = new Map<string, THREE.Matrix4[]>();
    const tops = new Map<string, number>();
    this.plotGround = [];
    for (const sc of this.life.land.scarecrows) {
      // Soil, draped over the ground.
      const soil = new THREE.PlaneGeometry(half * 2, half * 2, 8, 8).rotateX(-Math.PI / 2);
      const p = soil.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const [ox, oz] = toWorld(p.getX(i), p.getZ(i), sc.rot);
        p.setXYZ(i, sc.x + ox, hf.height(sc.x + ox, sc.z + oz) + SOIL_LIFT, sc.z + oz);
      }
      soil.computeVertexNormals();
      const soilMesh = new THREE.Mesh(soil, this.soilMat);
      soilMesh.receiveShadow = true;
      soilMesh.userData.ground = true;
      this.plots.add(soilMesh);
      // Furrows: darker rows, following the ground along their length as the soil does (one long
      // box laid flat would float off a slope at one end and sink into it at the other).
      const rows: THREE.BufferGeometry[] = [];
      for (let row = 0; row < FARM.scarecrowCells; row++) {
        const rowZ = (row - (FARM.scarecrowCells - 1) / 2) * FARM.cell;
        const fur = new THREE.BoxGeometry(half * 2 - FURROW.inset, FURROW.height, FURROW.width, FURROW.segments, 1, 1);
        const fp = fur.attributes.position;
        for (let i = 0; i < fp.count; i++) {
          const [ox, oz] = toWorld(fp.getX(i), rowZ + fp.getZ(i), sc.rot);
          fp.setXYZ(i, sc.x + ox, hf.height(sc.x + ox, sc.z + oz) + FURROW.lift + fp.getY(i), sc.z + oz);
        }
        fur.computeVertexNormals();
        rows.push(fur);
      }
      const furrows = mergeGeometries(rows)!;
      for (const r of rows) r.dispose();
      const furrowMesh = new THREE.Mesh(furrows, this.furrowMat);
      furrowMesh.receiveShadow = true;
      furrowMesh.userData.ground = true;
      this.plots.add(furrowMesh);
      // How high all that stands over the terrain, so what lies on the ground can lie on top of it.
      const key = `${sc.x},${sc.z},${sc.rot}`;
      const top = this.plotTops.get(key) ?? Math.max(standsOver(hf, soil), standsOver(hf, furrows));
      tops.set(key, top);
      this.plotGround.push({ x: sc.x, z: sc.z, rot: sc.rot, half, top });
      // Its scarecrow, the structure the item that set it down places, at the corner post.
      const scarecrow = groundPlaced();
      if (scarecrow) {
        const post = scarecrowPost(sc);
        const root = this.models.buildStructure(scarecrow).root;
        root.position.set(post.x, hf.height(post.x, post.z), post.z);
        root.rotation.y = sc.rot + Math.PI;
        this.plots.add(root);
      }
      sc.cells.forEach((pl, idx) => {
        if (!pl) return;
        const c = cellCentre(sc, idx);
        if (pl.animal) {
          const grown = pl.growth >= 1 ? 1 : 0;
          const m = this.models.buildAnimal(pl.crop, grown);
          // The model animates its own root (a skip, a peck), so it lives inside a holder we place.
          const root = new THREE.Group();
          root.add(m.root);
          root.position.set(c.x, hf.height(c.x, c.z) + 0.05, c.z);
          root.rotation.y = sc.rot + idx * 1.3;
          this.plots.add(root);
          this.animals.push({ root, sc: sc.id, idx, animate: m.animate.bind(m), phase: idx * 0.7 });
          return;
        }
        const stage = stageOf(pl);
        const key = `${pl.crop}:${stage}`;
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(c.x, hf.height(c.x, c.z) + 0.04, c.z),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (idx * 1.7 + sc.id) % 6.28),
          new THREE.Vector3(1, 1, 1),
        );
        let list = byGeo.get(key);
        if (!list) byGeo.set(key, (list = []));
        list.push(m);
        if (pl.watered) {
          const wet = new THREE.Mesh(this.wetGeo, this.wetMat);
          wet.position.set(c.x, hf.height(c.x, c.z) + 0.11, c.z);
          this.plots.add(wet);
        }
      });
    }
    for (const [key, mats] of byGeo) {
      const [id, stage] = key.split(':');
      const mesh = new THREE.InstancedMesh(this.cropGeo(id, Number(stage)), this.cropMat, mats.length);
      mats.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = cropDef(id).kind === 'tree';
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      this.plots.add(mesh);
    }
    this.plotTops = tops;
  }

  /**
   * How far the ground drawn over the terrain (a farm's soil and furrows) stands above it, at most,
   * anywhere within `pad` metres of (x, z); 0 where there is none. What lies on the ground (a warning
   * circle, the shadow under you) lies on top of it there.
   */
  raisedAt(x: number, z: number, pad: number): number {
    let top = 0;
    for (const g of this.plotGround) {
      if (g.top <= top) continue;
      const dx = x - g.x;
      const dz = z - g.z;
      const reach = (g.half + pad) * Math.SQRT2;
      if (dx * dx + dz * dz > reach * reach) continue;
      const [lx, lz] = toLocal(dx, dz, g.rot);
      if (Math.abs(lx) <= g.half + pad && Math.abs(lz) <= g.half + pad) top = g.top;
    }
    return top;
  }

  /** For tests: the height of the farm ground drawn over (x, z) (soil or a furrow), or null where there is none. */
  farmGroundAt(x: number, z: number): number | null {
    const ray = new THREE.Raycaster(toScene(new THREE.Vector3(x, 1e4, z)), new THREE.Vector3(0, -1, 0), 0, 2e4);
    let best: number | null = null;
    for (const h of ray.intersectObjects(
      this.plots.children.filter((c) => c.userData.ground),
      false,
    ))
      best = Math.max(best ?? -Infinity, h.point.y);
    return best;
  }

  /** The camera's place in the scene (relative to its origin). */
  private eye = new THREE.Vector3();

  private rebuildHouses(): void {
    const hf = this.life.zone.gen.terrain;
    for (const c of [...this.houses.children]) this.houses.remove(c);
    const kit: HouseView[] = [];
    for (const plot of this.life.zone.recipe.housePlots) {
      const h = this.life.land.houses.find((x) => x.plot === plot.id);
      const bp = h ? blueprintDef(h.blueprint) : null;
      const pose = h ? housePose(this.life, h) : null;
      // From the foundation up a house is the village kit's, built as far as its stages go.
      const plan = bp ? buildingPlan(bp.structure) : undefined;
      if (h && pose && plan && h.stage >= 1 && this.houseSink) {
        kit.push({ id: `${plot.id}`, plan, x: pose.x, y: hf.height(pose.x, pose.z), z: pose.z, rot: pose.rot, stage: isComplete(h) ? 4 : h.stage });
        continue;
      }
      if (!h || !bp || !pose) {
        // Unclaimed: marked out (shared/housing.json plotMarker).
        if (PLOT_MARKER) {
          const root = this.models.buildStructure(PLOT_MARKER).root;
          root.position.set(plot.x, hf.height(plot.x, plot.z), plot.z);
          root.rotation.y = plot.rot;
          this.houses.add(root);
        }
        continue;
      }
      const root = this.models.buildStructure(bp.structure, { stage: h.stage }).root;
      root.position.set(pose.x, hf.height(pose.x, pose.z), pose.z);
      root.rotation.y = pose.rot;
      this.houses.add(root);
    }
    this.houseSink?.(kit);
  }

  /** Slipways: the cradle and crane, and a ship rising on it as far as it has been built. */
  private rebuildSlips(): void {
    for (const c of [...this.slips.children]) this.slips.remove(c);
    const hf = this.life.zone.gen.terrain;
    const wood = toon(0x8d5a3b);
    const dark = toon(0x5f3d27);
    for (const sy of this.life.zone.recipe.shipyards ?? []) {
      const g = new THREE.Group();
      g.position.set(sy.x, 0, sy.z);
      g.rotation.y = sy.rot;
      const deckY = 2.2; // the ship's waterline while it sits on the cradle
      // Cradle: sloped rails into the water and cross-blocks under the keel.
      for (const side of [-1.1, 1.1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 20), wood);
        rail.position.set(side, 0.9, -1);
        rail.rotation.x = -0.12;
        g.add(rail);
      }
      for (let k = -4; k <= 4; k++) {
        const z = k * 2;
        const ground = Math.max(hf.water - 0.6, hf.height(sy.x - Math.sin(sy.rot) * z, sy.z - Math.cos(sy.rot) * z));
        const h = Math.max(0.3, deckY - 2.1 - ground);
        const block = new THREE.Mesh(new THREE.BoxGeometry(2.8, h, 0.45), dark);
        block.position.set(0, ground + h / 2, z);
        g.add(block);
      }
      // A crane: two legs and a boom over the stern.
      const legGeo = new THREE.BoxGeometry(0.3, 11, 0.3);
      for (const side of [-3.6, 3.6]) {
        const leg = new THREE.Mesh(legGeo, wood);
        leg.position.set(side, 1.5 + 5.5, -7.5);
        leg.rotation.z = side > 0 ? 0.18 : -0.18;
        g.add(leg);
      }
      const boom = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 8), wood);
      boom.position.set(0, 12, -4);
      boom.rotation.x = 0.25;
      g.add(boom);
      g.traverse((o) => {
        o.castShadow = true;
        o.receiveShadow = true;
      });
      const b = this.life.land.ships.find((x) => x.slip === sy.id);
      if (b) {
        const design = shipDesign(b.design);
        const def = rideable(design.vehicle);
        const reveal = b.stage > 0 ? design.stages[b.stage - 1].reveal : -1.6;
        const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
        const ship = isMount(def) ? this.models.buildMount(def).root : this.models.buildVehicle(def).root;
        ship.position.set(0, deckY, 0);
        ship.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          const clipped = mats.map((mt) => {
            const c = (mt as THREE.Material).clone();
            c.clippingPlanes = [plane];
            c.clipShadows = true;
            c.side = THREE.DoubleSide;
            return c;
          });
          mesh.material = Array.isArray(mesh.material) ? clipped : clipped[0];
        });
        g.add(ship);
        g.updateMatrixWorld(true);
        // The cut, in world height: everything above the stage's line is not built yet.
        plane.constant = deckY + reveal;
        // Scaffolding while she is being built.
        if (b.stage < design.stages.length) {
          for (const side of [-1, 1])
            for (let k = -3; k <= 3; k++) {
              const pole = new THREE.Mesh(new THREE.BoxGeometry(0.16, 6.5, 0.16), wood);
              pole.position.set(side * (def.width / 2 + 0.9), deckY + 1.2, k * 2.4);
              g.add(pole);
            }
          for (const side of [-1, 1])
            for (const y of [1.2, 3.4]) {
              const plank = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 16), wood);
              plank.position.set(side * (def.width / 2 + 0.9), deckY + y, 0);
              g.add(plank);
            }
        }
      }
      this.slips.add(g);
    }
  }

  private shownVehicle(v: Vehicle): Shown {
    let s = this.vehicles.get(v.id);
    if (s) return s;
    const def = rideable(v.def);
    let root: THREE.Object3D;
    let animate: Shown['animate'];
    let mount: Shown['mount'];
    let holds: Shown['holds'];
    if (isMount(def)) {
      const m = this.models.buildMount(def);
      root = m.root;
      mount = m.animate.bind(m);
      holds = m.holds;
    } else {
      const m = this.models.buildVehicle(def);
      root = m.root;
      animate = m.animate.bind(m);
      holds = m.holds;
    }
    root.rotation.order = 'YXZ';
    this.group.add(root);
    s = { root, animate, mount, holds, def, cargo: [] };
    this.vehicles.set(v.id, s);
    return s;
  }

  private packModel(id: string): THREE.Object3D {
    return this.models.buildPack(id);
  }

  /**
   * Driving one of these vehicles: puts it under the driver as they are drawn (the rules' seat part
   * way between steps, plus `shift`, a correction being eased in), so the driver never slides in the
   * seat; adds the swell under a boat and moves its wheels and oars for this frame, so the hands
   * find them where they are now; and says where the seat is, for the driver to sit in. Call it
   * before the driver is posed, and before update(). Null when `p` isn't driving one of these.
   */
  placeRide(p: PlayerState, alpha: number, shift: THREE.Vector3 | null, dt: number): Seated | null {
    this.placed = -1;
    if (p.mode !== 'ride' || !p.vehicle || p.host) return null;
    const v = this.life.land.vehicles.find((x) => x.id === p.vehicle);
    if (!v) return null;
    const s = this.shownVehicle(v);
    const seat = s.def.seats[0];
    // The rules seat the driver at anchorWorld(v, seat) (src/engine/life/vehicles.ts): turned the
    // same way, the vehicle's middle is that far back from where the driver is drawn.
    const heading = p.prevFacing + angleDiff(p.prevFacing, p.facing) * alpha;
    _q.setFromEuler(_e.set(-v.pitch, heading, v.roll, 'YXZ'));
    _v.set(seat.x, seat.y, seat.z).applyQuaternion(_q);
    const at = _v2.set(
      p.prevPos.x + (p.pos.x - p.prevPos.x) * alpha,
      p.prevPos.y + (p.pos.y - p.prevPos.y) * alpha,
      p.prevPos.z + (p.pos.z - p.prevPos.z) * alpha,
    );
    if (shift) at.add(shift);
    at.sub(_v);
    this.dress(v, s, at.x, at.y, at.z, heading, this.time + dt, dt);
    this.placed = v.id;
    return this.seatIn(s, 0, s.holds ?? null);
  }

  /**
   * Where seat `k` of one of these vehicles is this frame, for someone riding along in it (already
   * placed this frame: by placeRide for the one being driven, else by update()).
   */
  seatOf(vehicle: number, k: number): Seated | null {
    const s = this.vehicles.get(vehicle);
    return s && s.def.seats[k] ? this.seatIn(s, k, null) : null;
  }

  /** For tests: where each vehicle is drawn this frame. */
  drawnVehicles(): Array<{ id: number; x: number; y: number; z: number }> {
    return [...this.vehicles].map(([id, s]) => ({ id, x: s.root.position.x, y: s.root.position.y, z: s.root.position.z }));
  }

  private seatIn(s: Shown, k: number, holds: Holds | null): Seated {
    const seat = s.def.seats[k];
    s.root.updateMatrix();
    return {
      position: new THREE.Vector3(seat.x, seat.y, seat.z).applyMatrix4(s.root.matrix),
      quaternion: s.root.quaternion.clone(),
      pose: seat.pose,
      holds,
    };
  }

  /** Puts a vehicle's model at (x, y, z) turned to `heading` (a boat on the swell), and moves its parts. */
  private dress(v: Vehicle, s: Shown, x: number, y: number, z: number, heading: number, time: number, dt: number): void {
    const def = s.def;
    let pitch = v.pitch;
    let roll = v.roll;
    if (isBoat(def)) {
      // Swell, much heavier out at sea in a storm.
      const hf = this.life.zone.gen.terrain;
      const rough = 1 + 3 * stormAt(this.life, hf.water - hf.height(v.x, v.z));
      const swell = Math.sin(time * 1.3 + v.x * 0.05) * 0.12 + Math.sin(time * 0.8 + v.z * 0.07) * 0.08;
      y += swell * (def.length > 8 ? 0.5 : 1) * rough;
      pitch += Math.sin(time * 1.1 + v.z * 0.05) * 0.025 * rough;
      roll += Math.sin(time * 0.9 + v.x * 0.04) * 0.035 * rough;
    }
    s.root.position.set(x, y, z);
    s.root.rotation.set(-pitch, heading, roll);
    if (s.animate) {
      const rel = angleDiff(this.life.weather.windDir, v.heading);
      s.animate(dt, {
        speed: v.speed,
        steer: v.steer,
        throttle: v.throttle,
        sail: isBoat(def) && def.sail ? v.sail : 0,
        boom: isBoat(def) && def.sail ? Math.max(-1.1, Math.min(1.1, -rel * 0.55)) * (sailEfficiency(rel) > 0.3 ? 1 : 0.4) : 0,
        time,
      });
    }
    if (s.mount) s.mount(dt, { speed: Math.abs(v.speed), grounded: v.grounded });
  }

  /** Draws the island's things as they are this frame; `p` is the one whose island it is (the pack on their back, the vehicle they drive). */
  update(p: PlayerState, dt: number, cameraPos: THREE.Vector3): void {
    this.time += dt;
    const life = this.life;
    const hf = life.zone.gen.terrain;

    if (life.revision !== this.builtRevision) {
      this.builtRevision = life.revision;
      const plots = life.land.scarecrows.length + life.land.houses.length * 100;
      if (plots !== this.plotCount) {
        this.plotCount = plots;
        this.onGroundChanged?.();
      }
      // Only when what grows in them changed: a pack picked up or a cart loaded changes the island
      // too, and building every plot again for that is a stutter you feel.
      const pk = plotKey(life.land.scarecrows);
      if (pk !== this.plotKey) {
        this.plotKey = pk;
        this.rebuildPlots();
      }
      const sk = (life.land.ships ?? []).map((b) => `${b.slip}:${b.stage}`).join(',') + '|';
      if (sk !== this.shipKey) {
        this.shipKey = sk;
        this.rebuildSlips();
      }
      const key = life.land.houses.map((h) => `${h.plot}:${h.stage}`).join(',');
      if (key !== this.houseKey || this.houses.children.length === 0) {
        this.houseKey = key;
        this.rebuildHouses();
      }
      for (const n of this.nodes) if (n) n.root.visible = nodeReady(life, n.id);
    }
    if (life.state.clock % 1 < dt) for (const n of this.nodes) if (n) n.root.visible = nodeReady(life, n.id);

    // Townsfolk turn to face you when you come close, and gesture while you talk.
    const hp = this.hero.root.position;
    for (const v of this.villagers) {
      const d = Math.hypot(hp.x - v.x, hp.z - v.z);
      const want = d < 6 ? Math.atan2(hp.x - v.x, hp.z - v.z) : v.facing;
      let diff = (want - v.holder.rotation.y) % (Math.PI * 2);
      if (diff > Math.PI) diff -= Math.PI * 2;
      if (diff < -Math.PI) diff += Math.PI * 2;
      v.holder.rotation.y += diff * Math.min(1, dt * 3);
      v.animate(dt, { time: this.time + v.x * 0.1, talking: this.talkingTo === v.id });
    }

    // Farm animals potter about their cell.
    for (const a of this.animals) {
      const sc = life.land.scarecrows.find((s) => s.id === a.sc);
      const pl = sc?.cells[a.idx];
      if (!pl) continue;
      const hungry = (pl.fedUntil ?? 0) <= life.state.clock;
      const ready = pl.growth >= 1 && (pl.produce ?? 0) >= 1;
      a.animate?.(dt, { time: this.time + a.phase, hungry, ready });
      if (!hungry) a.root.rotation.y += Math.sin(this.time * 0.3 + a.phase) * dt * 0.4;
    }

    // Vehicles where the rules have them; the one being driven was put under its driver already
    // (placeRide), before they were posed.
    const live = new Set<number>();
    for (const v of life.land.vehicles) {
      live.add(v.id);
      if (v.id === this.placed) continue;
      this.dress(v, this.shownVehicle(v), v.x, v.y, v.z, v.heading, this.time, dt);
    }
    this.placed = -1;
    for (const [id, s] of this.vehicles) {
      if (live.has(id)) continue;
      this.group.remove(s.root);
      this.vehicles.delete(id);
    }

    // Packs: on your back, in a vehicle's slot, or on the ground.
    const seen = new Set<number>();
    for (const pk of life.land.packs) {
      seen.add(pk.id);
      let m = this.packMeshes.get(pk.id);
      if (!m) {
        m = this.packModel(pk.def);
        this.packMeshes.set(pk.id, m);
      }
      if (pk.at === 'back' && p.pack === pk.id && p.mode !== 'ride') {
        if (m.parent !== this.hero.torsoJoint) this.hero.torsoJoint.add(m);
        // Pack models put their straps on +Z and the load toward -Z, and the hero faces +Z, so
        // unturned the pack hangs behind: strap face just off the cape on the back of the tunic.
        m.position.set(0, -0.02, -0.2);
        m.rotation.set(0, 0, 0);
        m.scale.setScalar(0.92);
      } else if (pk.at === 'back') {
        // Riding with a pack: it goes in the seat behind you (a donkey's pannier, a cart bench).
        if (m.parent !== this.group) this.group.add(m);
        const v = life.land.vehicles.find((x) => x.id === p.vehicle);
        const s = v ? this.vehicles.get(v.id) : undefined;
        if (v && s) {
          const a = s.def.cargo[0] ?? { x: 0, y: s.def.height * 0.6, z: -s.def.length * 0.3 };
          const w = s.root.localToWorld(new THREE.Vector3(a.x, a.y, a.z));
          m.position.copy(w);
          m.rotation.set(0, v.heading, 0);
        }
        m.scale.setScalar(1);
      } else if (pk.at === 'cargo') {
        const s = this.vehicles.get(pk.vehicle);
        const a = s?.def.cargo[pk.slot];
        if (s && a) {
          if (m.parent !== s.root) s.root.add(m);
          m.position.set(a.x, a.y, a.z + 0.25);
          m.rotation.set(0, 0, 0);
          m.scale.setScalar(1);
        }
      } else {
        if (m.parent !== this.group) this.group.add(m);
        // Cargo lost at sea bobs on the swell where it went down.
        const afloat = pk.y < hf.water + 0.05 && hf.height(pk.x, pk.z) < hf.water - 0.5;
        const bob = afloat ? Math.sin(this.time * 1.6 + pk.id) * 0.12 : 0;
        m.position.set(pk.x, pk.y + bob, pk.z);
        m.rotation.set(afloat ? Math.sin(this.time + pk.id) * 0.15 : 0, pk.rot + Math.PI, 0);
        m.scale.setScalar(1);
      }
    }
    for (const [id, m] of this.packMeshes) {
      if (seen.has(id)) continue;
      m.parent?.remove(m);
      this.packMeshes.delete(id);
    }

    // The glider over your head while it is open.
    if (p.mode === 'glide' && p.glider) {
      if (this.gliderShown !== p.glider) {
        if (this.gliderModel) this.gliderModel.root.parent?.remove(this.gliderModel.root);
        const def = gliderDef(p.glider);
        const m = this.models.buildGlider(def);
        this.gliderModel = { root: m.root, animate: m.animate.bind(m) };
        this.gliderShown = p.glider;
      }
      const g = this.gliderModel!;
      if (g.root.parent !== this.hero.root) this.hero.root.add(g.root);
      g.root.visible = true;
      // The model banks and pitches its own wing (positive bank dips the left wing, nose up for a climb).
      g.root.rotation.set(0, 0, 0);
      g.animate?.(dt, { bank: p.bank * 0.6, pitch: Math.max(-0.35, Math.min(0.3, p.vel.y / 12)), speed: p.airspeed });
    } else if (this.gliderModel) this.gliderModel.root.visible = false;

    if (this.others) return;

    // Placement ghost.
    const pl = life.placing;
    this.ghost.visible = !!pl;
    if (pl) {
      this.ghost.position.set(pl.x, hf.height(pl.x, pl.z) + 0.12, pl.z);
      this.ghost.rotation.y = pl.rot;
      (this.ghost.material as THREE.MeshBasicMaterial).color.setHex(pl.problem ? 0xff6b6b : 0x7bed9f);
    }

    // Rain, fading in and out.
    // No rain under a roof of rock (inside a dungeon: src/app/dungeonVisit.ts sets indoors).
    const raining = life.state.clock < life.weather.rainUntil && !this.indoors;
    this.rainOn += ((raining ? 1 : 0) - this.rainOn) * Math.min(1, dt * 0.8);
    const rm = this.rain.material as THREE.PointsMaterial;
    rm.opacity = this.rainOn * 0.7;
    this.rain.visible = this.rainOn > 0.01;
    if (this.rain.visible) {
      const pos = this.rain.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        let y = pos.getY(i) - dt * 22;
        if (y < 0) y += 30;
        pos.setY(i, y);
      }
      pos.needsUpdate = true;
      this.rain.position.set(cameraPos.x, cameraPos.y - 12, cameraPos.z);
    }

    // Updraft wisps rise and spiral.
    for (const wisp of this.updrafts.children) {
      const top = wisp.userData.top as number;
      for (const m of wisp.children) {
        const d = m.userData as { phase: number; r: number };
        const k = (d.phase + this.time * 0.09) % 1;
        const a = d.phase * 40 + this.time * 1.4;
        m.position.set(Math.cos(a) * d.r, k * top, Math.sin(a) * d.r);
        const eye = toScene(this.eye.copy(cameraPos));
        m.lookAt(eye.x, m.getWorldPosition(new THREE.Vector3()).y, eye.z);
        ((m as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.3;
      }
    }
  }
}
