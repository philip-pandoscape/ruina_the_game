import * as THREE from 'three';
import { STOREY, turn, WALL, type BuildingPlan, type FurnitureDef } from '../../content/buildings';
import type { PlacedBuilding, BoxCollider } from '../../engine/zone';
import { track } from '../assets';
import { assemble, at, type Assembled } from './assemble';
import { batch, kitItem, type BatchItem } from './batch';
import { fireTime, Furnisher, fireMesh, type FirePlacement } from './furnish';
import { cut, indoorAmbient, loadKit, PARTS, type Kit } from './kit';

// The buildings you can walk into, drawn from the village kit, in as few draw calls as their
// distance allows:
//   - the town's shells (walls, roofs, floors, corners) merged by material per neighbourhood,
//     always drawn and casting the sun's shadows;
//   - the finer pieces (windows, shutters, door frames, stairs, rails) likewise, drawn within
//     DETAIL_REACH;
//   - each building's furniture, drawn only near it, where it can be seen through a door or a
//     window, or from inside;
//   - the doors (which swing open as anyone comes up to them) and the fires in the hearths,
//     instanced;
//   - the lamps and hearths, lit by a few shared lights that follow you from house to house;
//   - players' houses (src/render/open/land.ts hands them over as they are built), each a few
//     meshes of its own, rebuilt when a stage is finished.
// Indoors, the house you stand in is drawn cut open above your storey, and the camera stays
// inside its walls (main.ts asks `indoors`).

/** Where you are indoors: the building, the storey, and the heights that bound it. */
export interface Indoors {
  index: number;
  building: { id: string; plan: BuildingPlan; x: number; y: number; z: number; rot: number };
  storey: number;
  floor: number;
  /** Everything of the building above this height is cut away. */
  ceiling: number;
  /** Its four walls whole, doorways and all, which hold the camera in up to the ceiling. */
  shell: BoxCollider[];
}

/** A player's house as the village draws it: its plan, where it stands, and how far it is built. */
export interface HouseView {
  id: string;
  plan: BuildingPlan;
  x: number;
  y: number;
  z: number;
  rot: number;
  stage: number;
}

interface Entry {
  b: { id: string; plan: BuildingPlan; x: number; y: number; z: number; rot: number };
  world: THREE.Matrix4;
  parts: Assembled;
  storeys: number;
  shell: BoxCollider[];
  /** Its number in aPart (the cut uses it). */
  index: number;
  /** Walled in yet (a house still being built isn't). */
  walled: boolean;
}

interface Door {
  meshes: THREE.InstancedMesh[];
  slot: number;
  base: THREE.Matrix4;
  /** The doorway (world), for telling who is near it. */
  x: number;
  z: number;
  open: number;
  shown: number;
}

interface Glow {
  x: number;
  y: number;
  z: number;
  def: NonNullable<FurnitureDef['light']>;
  phase: number;
}

/** What one set of buildings (the town, or one player's houses) draws. */
interface Set {
  entries: Entry[];
  doors: Door[];
  glows: Glow[];
  group: THREE.Group;
}

/** Lights shared by every house's lamps: a fixed number, so shaders never recompile as you walk. */
const POOL = 4;
/** How near a door has to be before it opens for you, and how far it swings. */
const DOOR_REACH = 2.6;
const DOOR_OPEN = 1.75;
/** How near the camera has to be to draw a building's finer pieces, and its furniture. */
const DETAIL_REACH = 140;
const FURNITURE_REACH = 36;
/** Neighbourhoods share their merged meshes: buildings in the same square of this size. */
const CLUSTER = 64;
/** Players' houses are numbered from here in aPart. */
const HOUSES = 1000;

/**
 * The roofs and plaster a house can have, so a street isn't one house over and over: weathered
 * reds and browns of tile, plaster from white lime to ochre. Picked by where the house stands.
 */
const ROOFS: Array<[number, number, number]> = [
  [1, 1, 1],
  [0.9, 0.74, 0.7],
  [0.84, 0.72, 0.62],
  [1, 0.9, 0.82],
  [0.78, 0.64, 0.6],
];
const PLASTERS: Array<[number, number, number]> = [
  [1, 1, 1],
  [1, 0.94, 0.82],
  [1.04, 1.02, 0.98],
  [0.98, 0.88, 0.74],
];

/** Pieces too small to matter from afar, or never seen from outside. */
const DETAIL = /^(Window|WindowShutters|DoorFrame|Stair|Balcony|HoleCover|Prop_Vine)/;

/** Four slabs along a building's walls, doorways and all. */
function shellOf(b: Entry['b']): BoxCollider[] {
  const hw = b.plan.w / 2;
  const hd = b.plan.d / 2;
  const slab = (lx: number, lz: number, w: number, d: number): BoxCollider => {
    const [ox, oz] = turn(lx, lz, b.rot);
    return { x: b.x + ox, z: b.z + oz, hw: w / 2, hd: d / 2, rot: b.rot, cos: Math.cos(b.rot), sin: Math.sin(b.rot), top: Infinity };
  };
  return [
    slab(0, hd - WALL / 2, b.plan.w, WALL),
    slab(0, -hd + WALL / 2, b.plan.w, WALL),
    slab(hw - WALL / 2, 0, WALL, b.plan.d),
    slab(-hw + WALL / 2, 0, WALL, b.plan.d),
  ];
}

export class Village {
  readonly group = new THREE.Group();
  private town: Set = { entries: [], doors: [], glows: [], group: new THREE.Group() };
  private houses = new Map<string, Set>();
  private nextHouse = HOUSES;
  private pool: THREE.PointLight[] = [];
  private details: Array<{ meshes: THREE.Mesh[]; centre: THREE.Vector3; radius: number }> = [];
  private furniture: Array<{ meshes: THREE.Object3D[]; x: number; z: number; index: number }> = [];
  private time = 0;
  private m = new THREE.Matrix4();
  private spin = new THREE.Matrix4();
  private kit: Kit | null = null;
  /** Set when everything is built (tests wait on it through the asset tracker). */
  ready = false;
  indoors: Indoors | null = null;
  /** How brightly the lamps burn: full at night, lower by day (OpenStage.setTime). */
  lampLevel = 1;

  constructor(buildings: PlacedBuilding[]) {
    this.group.name = 'village';
    this.group.add(this.town.group);
    buildings.forEach((b, i) => this.town.entries.push(this.entry(b, i, 4)));
    for (const e of this.town.entries) this.town.glows.push(...this.glowsOf(e));
    for (let i = 0; i < POOL; i++) {
      const light = new THREE.PointLight(0xffb060, 0, 8, 2);
      this.pool.push(light);
      this.group.add(light);
    }
    track(
      loadKit().then((kit) => {
        this.kit = kit;
        this.buildTown(kit);
        for (const [owner, set] of this.houses) this.buildHouses(owner, set);
        this.ready = true;
      }),
    );
  }

  private entry(b: Entry['b'], index: number, stage: number): Entry {
    return {
      b,
      world: at(b.x, b.y, b.z, b.rot),
      parts: assemble(b.plan, Math.round(b.x * 13 + b.z * 7), stage),
      storeys: b.plan.storeys.length,
      shell: shellOf(b),
      index,
      walled: stage >= 3,
    };
  }

  private glowsOf(e: Entry): Glow[] {
    return e.parts.lights.map((l) => {
      const [ox, oz] = turn(l.x, l.z, e.b.rot);
      return { x: e.b.x + ox, y: e.b.y + l.y, z: e.b.z + oz, def: l.def, phase: (e.index * 7.3 + l.x * 3.1) % 6.28 };
    });
  }

  /** The furniture, doors and fires of these entries, into `set`; their pieces to `pieces`. */
  private furnish(kit: Kit, set: Set, pieces: (e: Entry, piece: string, item: BatchItem) => void): void {
    const furnisher = new Furnisher(kit);
    const fires: FirePlacement[] = [];
    const doors = new Map<string, Array<{ base: THREE.Matrix4; tag: number; x: number; z: number }>>();
    for (const e of set.entries) {
      const pick = Math.abs(Math.round(e.b.x * 7 + e.b.z * 13));
      const tint = { MI_RoundTiles: ROOFS[pick % ROOFS.length], MI_Plaster: PLASTERS[(pick >> 2) % PLASTERS.length] };
      for (const p of e.parts.pieces) {
        const it = kitItem(kit, p.piece, e.world.clone().multiply(p.matrix), e.index, p.part);
        if (it) pieces(e, p.piece, { ...it, tint });
      }
      const things: BatchItem[] = [];
      for (const it of e.parts.items) furnisher.place(it.def, it.def, e.world.clone().multiply(it.matrix), e.index, it.part, things, fires);
      const meshes = batch(things, (name) => furnisher.material(name), `furniture:${e.b.id}`);
      for (const mesh of meshes) {
        mesh.castShadow = false;
        set.group.add(mesh);
      }
      this.furniture.push({ meshes, x: e.b.x, z: e.b.z, index: e.index });
      for (const d of e.parts.doors) {
        const base = e.world.clone().multiply(d.matrix);
        const mid = new THREE.Vector3(0.55, 0, 0).applyMatrix4(base);
        let list = doors.get(d.piece);
        if (!list) doors.set(d.piece, (list = []));
        list.push({ base, tag: e.index * PARTS + d.part, x: mid.x, z: mid.z });
      }
    }
    // Doors: one instanced mesh per door piece and material, a slot for each door.
    for (const [piece, list] of doors) {
      const parts = kit.pieces.get(piece);
      if (!parts) continue;
      const meshes: THREE.InstancedMesh[] = [];
      for (const p of parts) {
        const mat = kit.materials.get(p.material);
        if (!mat) continue;
        const g = p.geometry.clone();
        g.setAttribute('aPart', new THREE.InstancedBufferAttribute(Float32Array.from(list.map((d) => d.tag)), 1));
        const mesh = new THREE.InstancedMesh(g, mat, list.length);
        mesh.name = `doors:${piece}:${p.material}`;
        mesh.receiveShadow = true;
        list.forEach((d, k) => mesh.setMatrixAt(k, d.base));
        mesh.computeBoundingSphere();
        meshes.push(mesh);
        set.group.add(mesh);
      }
      list.forEach((d, k) => set.doors.push({ meshes, slot: k, base: d.base, x: d.x, z: d.z, open: 0, shown: 0 }));
    }
    if (fires.length) set.group.add(fireMesh(fires));
  }

  private buildTown(kit: Kit): void {
    const clusters = new Map<string, { shell: BatchItem[]; detail: BatchItem[]; box: THREE.Box3 }>();
    this.furnish(kit, this.town, (e, piece, it) => {
      const key = `${Math.floor(e.b.x / CLUSTER)}:${Math.floor(e.b.z / CLUSTER)}`;
      let c = clusters.get(key);
      if (!c) clusters.set(key, (c = { shell: [], detail: [], box: new THREE.Box3() }));
      c.box.union(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(e.b.x, e.b.y + 6, e.b.z), new THREE.Vector3(e.b.plan.w + 2, 14, e.b.plan.d + 2)));
      (DETAIL.test(piece) ? c.detail : c.shell).push(it);
    });
    for (const [key, c] of clusters) {
      for (const mesh of batch(c.shell, (name) => kit.materials.get(name), `village:${key}`)) this.town.group.add(mesh);
      const detail = batch(c.detail, (name) => kit.materials.get(name), `detail:${key}`);
      for (const mesh of detail) {
        mesh.castShadow = false;
        this.town.group.add(mesh);
      }
      const sphere = c.box.getBoundingSphere(new THREE.Sphere());
      this.details.push({ meshes: detail, centre: sphere.center, radius: sphere.radius });
    }
  }

  /**
   * One owner's houses (yours, or another player's here), as far as each is built; replaces what
   * that owner had before. Drawn once the kit has loaded.
   */
  setHouses(owner: string, houses: HouseView[]): void {
    const old = this.houses.get(owner);
    if (old) {
      this.group.remove(old.group);
      old.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      const gone = new Set(old.entries.map((e) => e.index));
      this.furniture = this.furniture.filter((f) => !gone.has(f.index));
    }
    if (!houses.length) {
      this.houses.delete(owner);
      return;
    }
    const set: Set = { entries: [], doors: [], glows: [], group: new THREE.Group() };
    set.group.name = `houses:${owner}`;
    for (const h of houses) set.entries.push(this.entry(h, this.nextHouse++, h.stage));
    for (const e of set.entries) set.glows.push(...this.glowsOf(e));
    this.houses.set(owner, set);
    this.group.add(set.group);
    if (this.kit) this.buildHouses(owner, set);
  }

  private buildHouses(owner: string, set: Set): void {
    if (!this.kit) return;
    const pieces: BatchItem[] = [];
    this.furnish(this.kit, set, (_e, _piece, it) => pieces.push(it));
    for (const mesh of batch(pieces, (name) => this.kit!.materials.get(name), `houses:${owner}`)) set.group.add(mesh);
  }

  /** Works out whether (x, y, z) is indoors, and cuts that building open above its storey. Call before the camera moves. */
  locate(x: number, y: number, z: number): void {
    this.indoors = null;
    for (const set of [this.town, ...this.houses.values()])
      for (const e of set.entries) {
        if (!e.walled) continue;
        const b = e.b;
        const [lx, lz] = turn(x - b.x, z - b.z, -b.rot);
        if (Math.abs(lx) > b.plan.w / 2 - WALL + 0.15 || Math.abs(lz) > b.plan.d / 2 - WALL + 0.15) continue;
        const up = y - b.y;
        if (up < -0.8 || up > e.storeys * STOREY - 0.4) continue;
        const storey = Math.max(0, Math.min(e.storeys - 1, Math.floor((up + 0.8) / STOREY)));
        const floor = b.y + storey * STOREY;
        this.indoors = { index: e.index, building: b, storey, floor, ceiling: floor + STOREY + 0.15, shell: e.shell };
        break;
      }
    cut.building.value = this.indoors ? this.indoors.index : -1;
    cut.part.value = this.indoors ? this.indoors.storey : PARTS;
  }

  /**
   * Every building's walls whole (doorways and all) near (x, z), and how high each stops the camera:
   * the one you are in up to where it is cut open, the rest up to their ridges. Doorways let you
   * through; the camera they don't.
   */
  eachShell(x: number, z: number, reach: number, fn: (wall: BoxCollider, top: number) => void): void {
    const home = this.indoors?.index ?? -1;
    for (const set of [this.town, ...this.houses.values()])
      for (const e of set.entries) {
        if (!e.walled) continue;
        const r = Math.hypot(e.b.plan.w, e.b.plan.d) / 2;
        if (Math.hypot(e.b.x - x, e.b.z - z) > reach + r) continue;
        const top = e.index === home && this.indoors ? this.indoors.ceiling : e.b.y + e.storeys * STOREY + 3;
        for (const w of e.shell) fn(w, top);
      }
  }

  /** Is (x, z) within the footprint of the building you are in (its walls are the camera's to see over)? */
  inIndoors(x: number, z: number, margin = 0.4): boolean {
    const i = this.indoors;
    if (!i) return false;
    const [lx, lz] = turn(x - i.building.x, z - i.building.z, -i.building.rot);
    return Math.abs(lx) < i.building.plan.w / 2 + margin && Math.abs(lz) < i.building.plan.d / 2 + margin;
  }

  /**
   * Doors swing open for whoever is near them; the lamps nearest you are lit; what is too far from
   * `eye` (the camera) to be seen is left out.
   */
  update(
    dt: number,
    people: Array<{ x: number; z: number }>,
    viewer: { x: number; y: number; z: number },
    eye: { x: number; y: number; z: number } = viewer,
  ): void {
    this.time += dt;
    fireTime.value = this.time;
    // A room is lit warm by day through its windows; by night its lamps carry it.
    const night = Math.min(1, Math.max(0, (this.lampLevel - 0.55) / 0.45));
    indoorAmbient.value.setRGB(0.62 - 0.4 * night, 0.5 - 0.34 * night, 0.4 - 0.26 * night);
    const sets = [this.town, ...this.houses.values()];
    for (const set of sets)
      for (const d of set.doors) {
        let near = false;
        for (const p of people) if (Math.hypot(p.x - d.x, p.z - d.z) < DOOR_REACH) near = true;
        // With no time passing (a test stepping the game and drawing once) a door is where it is going.
        d.open = dt > 0 ? d.open + ((near ? 1 : 0) - d.open) * (1 - Math.exp(-dt * 6)) : near ? 1 : 0;
        if (Math.abs(d.open - d.shown) < 1e-3) continue;
        d.shown = d.open;
        this.m.copy(d.base).multiply(this.spin.makeRotationY(d.open * DOOR_OPEN));
        for (const mesh of d.meshes) {
          mesh.setMatrixAt(d.slot, this.m);
          mesh.instanceMatrix.needsUpdate = true;
        }
      }
    for (const det of this.details) {
      const far = Math.hypot(det.centre.x - eye.x, det.centre.y - eye.y, det.centre.z - eye.z) - det.radius;
      for (const mesh of det.meshes) mesh.visible = far < DETAIL_REACH;
    }
    const home = this.indoors?.index ?? -1;
    for (const f of this.furniture) {
      const shown = f.index === home || Math.hypot(f.x - eye.x, f.z - eye.z) < FURNITURE_REACH;
      for (const mesh of f.meshes) mesh.visible = shown;
    }
    // The few lamps nearest you, among the buildings around.
    const ranked = sets
      .flatMap((s) => s.glows)
      .map((g) => ({ g, d: Math.hypot(g.x - viewer.x, g.z - viewer.z) + Math.abs(g.y - viewer.y) * 0.5 }))
      .filter((r) => r.d < 40)
      .sort((a, b) => a.d - b.d);
    this.pool.forEach((light, k) => {
      const r = ranked[k];
      if (!r) {
        light.intensity = 0;
        return;
      }
      const g = r.g;
      light.position.set(g.x, g.y, g.z);
      light.color.setHex(g.def.color ?? 0xffb060);
      light.distance = g.def.distance;
      const flicker = g.def.flicker ? 0.86 + 0.08 * Math.sin(this.time * 11 + g.phase) + 0.06 * Math.sin(this.time * 23.7 + g.phase * 2) : 1;
      // Fade a lamp out as it drops off the end of the list, so lights don't pop.
      const fade = Math.min(1, Math.max(0, (40 - r.d) / 10));
      light.intensity = g.def.intensity * flicker * fade * this.lampLevel;
    });
  }

  /** The meshes the village draws: triangles each, whether drawn now and whether they cast shadows. */
  stats(): { meshes: number; drawn: number; triangles: number; shadowTriangles: number; list: Array<{ name: string; triangles: number; visible: boolean }> } {
    const list: Array<{ name: string; triangles: number; visible: boolean }> = [];
    let triangles = 0;
    let shadowTriangles = 0;
    let drawn = 0;
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const g = mesh.geometry;
      const per = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
      const n = per * ((mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1);
      list.push({ name: mesh.name, triangles: n, visible: mesh.visible });
      if (!mesh.visible) return;
      drawn++;
      triangles += n;
      if (mesh.castShadow) shadowTriangles += n;
    });
    return { meshes: list.length, drawn, triangles, shadowTriangles, list };
  }
}
