import * as THREE from 'three';
import type { Life } from '../../sim/life/life';
import type { Sim } from '../../sim/sim';
import type { Hero } from '../character';
import type { Vehicle } from '../../sim/life/state';
import { rideable, glider as gliderDef, isBoat, isMount, isWheeled, type RideableDef } from '../../content/vehicles';
import { packDef } from '../../content/trade';
import { FARM, cropDef } from '../../content/farming';
import { structureDef } from '../../content/structures';
import { blueprintDef } from '../../content/housing';
import { cellCentre, scarecrowPost, stageOf } from '../../sim/life/farming';
import { housePose, isComplete } from '../../sim/life/housing';
import { nodeReady } from '../../sim/life/interact';
import { anchorWorld, sailEfficiency } from '../../sim/life/vehicles';
import { stormAt } from '../../sim/life/weather';
import { angleDiff } from '../../sim/math';
import { toon } from '../toon';
import { tryBuild, type Models, type VehicleAnim } from './models';
import { toWorld } from '../../sim/zone/generate';
import { shipDesign } from '../../content/shipyard';

// Draws what the life systems own: vehicles and mounts, every trade pack (on a back, in a cart,
// on the ground), scarecrow plots and what grows in them, houses as far as they are built, the
// resource nodes, the glider over your head and the scarecrow you are about to place.

interface Shown {
  root: THREE.Object3D;
  animate?: (dt: number, s: VehicleAnim) => void;
  mount?: (dt: number, s: { speed: number; grounded: boolean }) => void;
  def: RideableDef;
  cargo: THREE.Object3D[];
}

const box = (w: number, h: number, d: number, color: number, y = h / 2): THREE.Mesh => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), toon(color));
  m.position.y = y;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
};

/** A plain model of anything rideable, for when the model library has none. */
function standInVehicle(def: RideableDef): THREE.Group {
  const g = new THREE.Group();
  if (isBoat(def)) {
    const hull = box(def.width, 0.9, def.length, 0x8d5a3b, 0);
    g.add(hull);
    if (def.sail) {
      const mast = box(0.2, def.mast?.height ?? 6, 0.2, 0x734828, (def.mast?.height ?? 6) / 2);
      mast.position.z = def.mast?.z ?? 0;
      g.add(mast);
    }
  } else if (isMount(def)) {
    g.add(box(def.width, def.height * 0.45, def.length * 0.8, def.id === 'horse' ? 0x6b4a33 : 0x8f8478, def.height * 0.62));
    const head = box(def.width * 0.6, def.height * 0.35, def.length * 0.3, 0x5a4636, def.height * 0.9);
    head.position.z = def.length * 0.45;
    g.add(head);
  } else {
    g.add(box(def.width, def.height * 0.45, def.length, def.id === 'roadster' ? 0xc4553f : 0xa8743f, def.height * 0.4));
    for (const w of isWheeled(def) ? def.wheels : []) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(w.r, w.r, 0.25, 12).rotateZ(Math.PI / 2), toon(0x333333));
      wheel.position.set(w.x, w.r, w.z);
      g.add(wheel);
    }
  }
  return g;
}

function standInPack(id: string): THREE.Group {
  const g = new THREE.Group();
  const kind = (packDef(id) as { kind?: string }).kind;
  const m = box(0.6, 0.55, 0.5, kind === 'material' ? 0x9a9a94 : 0xb07a45);
  m.position.z = -0.25;
  g.add(m);
  return g;
}

export class LifeView {
  readonly group = new THREE.Group();
  private vehicles = new Map<number, Shown>();
  private packMeshes = new Map<number, THREE.Object3D>();
  private plots = new THREE.Group();
  private houses = new THREE.Group();
  private slips = new THREE.Group();
  private shipKey = '';
  /** Finished houses you can walk into: their footprint, and the plane that cuts the walls down. */
  private homes: Array<{ x: number; z: number; rot: number; hw: number; hd: number; floor: number; plane: THREE.Plane }> = [];
  /** Townsfolk drawn with their own models (empty when the library has none: the crowd stand-ins are used). */
  private villagers: Array<{ holder: THREE.Group; animate: (dt: number, s: { time: number; talking: boolean }) => void; id: string; facing: number; x: number; z: number }> = [];
  /** True when the townsfolk are drawn here, so the crowd renderer should leave them out. */
  readonly drawsTownsfolk: boolean;
  /** The NPC whose dialog is open, so they gesture while you talk. */
  talkingTo: string | null = null;
  /** The house you are standing in, if any (the camera stops treating its walls as solid). */
  inside: { x: number; z: number; rot: number; hw: number; hd: number } | null = null;
  private nodes: Array<{ root: THREE.Object3D; i: number } | null> = [];
  private ghost: THREE.Mesh;
  private gliderModel: { root: THREE.Object3D; animate?: (dt: number, s: { bank: number; pitch: number; speed: number }) => void } | null = null;
  private gliderShown = '';
  private builtRevision = -1;
  private houseKey = '';
  private rain: THREE.Points;
  private rainOn = 0;
  private updrafts: THREE.Group;
  private time = 0;
  private cropGeoCache = new Map<string, THREE.BufferGeometry>();
  private cropMat = toon(0xffffff, { vertexColors: true });
  private plotCount = -1;
  /** Farm animals in plot cells, with what they need to animate. */
  private animals: Array<{ root: THREE.Object3D; sc: number; idx: number; animate?: (dt: number, s: { time: number; hungry: boolean; ready: boolean }) => void; phase: number }> = [];
  /** Called when the ground changes under the grass (a plot placed, a house begun). */
  onGroundChanged: (() => void) | null = null;

  constructor(
    scene: THREE.Scene,
    private life: Life,
    private models: Models,
    private hero: Hero,
  ) {
    scene.add(this.group);
    this.group.add(this.plots, this.houses, this.slips);
    const hf = life.zone.gen.terrain;
    // Resource nodes (they vanish while picked clean).
    life.zone.recipe.nodes.forEach((nd, i) => {
      const built = tryBuild(models.buildStructure ? () => models.buildStructure!(nd.kind) : null);
      const def = structureDef(nd.kind);
      const root = built?.root ?? box(def.w, def.h, def.d, 0x8d8a85);
      root.position.set(nd.x, hf.height(nd.x, nd.z), nd.z);
      root.rotation.y = nd.rot;
      this.group.add(root);
      this.nodes.push({ root, i });
    });
    // Townsfolk with their own looks, standing at their posts.
    for (const n of life.zone.recipe.npcs) {
      const m = tryBuild(models.buildVillager ? () => models.buildVillager!(n.id) : null);
      if (!m) continue;
      const holder = new THREE.Group();
      holder.add(m.root);
      holder.position.set(n.x, hf.height(n.x, n.z), n.z);
      holder.rotation.y = n.facing;
      this.group.add(holder);
      this.villagers.push({ holder, animate: m.animate.bind(m), id: n.id, facing: n.facing, x: n.x, z: n.z });
    }
    this.drawsTownsfolk = this.villagers.length === life.zone.recipe.npcs.length;
    if (!this.drawsTownsfolk) {
      for (const v of this.villagers) this.group.remove(v.holder);
      this.villagers = [];
    }

    // Placement ghost: the 8 x 8 plot outline, green when it fits, red when it does not.
    const half = (FARM.scarecrowCells * FARM.cell) / 2;
    const ghostGeo = new THREE.PlaneGeometry(half * 2, half * 2).rotateX(-Math.PI / 2);
    this.ghost = new THREE.Mesh(ghostGeo, new THREE.MeshBasicMaterial({ color: 0x7bed9f, transparent: true, opacity: 0.38, depthWrite: false }));
    this.ghost.visible = false;
    this.ghost.renderOrder = 3;
    this.group.add(this.ghost);
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
    this.group.add(this.rain);
    // Updrafts: spiralling wisps so you can find the rising air.
    this.updrafts = new THREE.Group();
    for (const u of life.zone.recipe.updrafts) {
      const wisp = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.32, depthWrite: false });
      for (let k = 0; k < 26; k++) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 3.2), mat);
        m.userData = { phase: k / 26, r: u.r * (0.35 + 0.6 * ((k * 7) % 10) / 10) };
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
      g = tryBuild(this.models.cropGeometry ? () => this.models.cropGeometry!(id, stage) : null) ?? undefined;
      if (!g) {
        g = new THREE.ConeGeometry(0.25 + stage * 0.1, 0.2 + stage * 0.35, 6).translate(0, 0.1 + stage * 0.17, 0).toNonIndexed();
        const c = new THREE.Color(stage >= 3 ? 0xe2c158 : 0x4caf50);
        const col = new Float32Array(g.attributes.position.count * 3);
        for (let i = 0; i < col.length; i += 3) col.set([c.r, c.g, c.b], i);
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        g.computeVertexNormals();
      }
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
    }
    const half = (FARM.scarecrowCells * FARM.cell) / 2;
    const byGeo = new Map<string, THREE.Matrix4[]>();
    for (const sc of this.life.state.scarecrows) {
      // Soil, draped over the ground.
      const soil = new THREE.PlaneGeometry(half * 2, half * 2, 8, 8).rotateX(-Math.PI / 2);
      const p = soil.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const [ox, oz] = toWorld(p.getX(i), p.getZ(i), sc.rot);
        p.setXYZ(i, sc.x + ox, hf.height(sc.x + ox, sc.z + oz) + 0.05, sc.z + oz);
      }
      soil.computeVertexNormals();
      const soilMesh = new THREE.Mesh(soil, toon(0x6e4a2e));
      soilMesh.receiveShadow = true;
      this.plots.add(soilMesh);
      // Furrows: darker rows.
      for (let row = 0; row < FARM.scarecrowCells; row++) {
        const fur = new THREE.Mesh(new THREE.BoxGeometry(half * 2 - 0.4, 0.08, 0.35), toon(0x5a3a22));
        const [ox, oz] = toWorld(0, (row - (FARM.scarecrowCells - 1) / 2) * FARM.cell, sc.rot);
        fur.position.set(sc.x + ox, hf.height(sc.x + ox, sc.z + oz) + 0.07, sc.z + oz);
        fur.rotation.y = sc.rot;
        this.plots.add(fur);
      }
      const post = scarecrowPost(sc);
      const built = tryBuild(this.models.buildStructure ? () => this.models.buildStructure!('scarecrow') : null);
      const sc3 = built?.root ?? box(0.5, 2.2, 0.3, 0xe2c158);
      sc3.position.set(post.x, hf.height(post.x, post.z), post.z);
      sc3.rotation.y = sc.rot + Math.PI;
      this.plots.add(sc3);
      sc.cells.forEach((pl, idx) => {
        if (!pl) return;
        const c = cellCentre(sc, idx);
        if (pl.animal) {
          const grown = pl.growth >= 1 ? 1 : 0;
          const m = tryBuild(this.models.buildAnimal ? () => this.models.buildAnimal!(pl.crop, grown) : null);
          const size = (pl.crop === 'cow' ? 1.4 : pl.crop === 'sheep' ? 0.9 : 0.4) * (grown ? 1 : 0.6);
          const model = m?.root ?? box(size * 0.7, size, size, pl.crop === 'cow' ? 0x8d6e5a : pl.crop === 'sheep' ? 0xf3efe6 : 0xffffff);
          // The model animates its own root (a skip, a peck), so it lives inside a holder we place.
          const root = new THREE.Group();
          root.add(model);
          root.position.set(c.x, hf.height(c.x, c.z) + 0.05, c.z);
          root.rotation.y = sc.rot + idx * 1.3;
          this.plots.add(root);
          this.animals.push({ root, sc: sc.id, idx, animate: m?.animate.bind(m), phase: idx * 0.7 });
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
          const wet = new THREE.Mesh(new THREE.CircleGeometry(0.75, 10).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x3b2614, transparent: true, opacity: 0.45, depthWrite: false }));
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
  }

  private rebuildHouses(): void {
    const hf = this.life.zone.gen.terrain;
    for (const c of [...this.houses.children]) this.houses.remove(c);
    for (const plot of this.life.zone.recipe.housePlots) {
      const h = this.life.state.houses.find((x) => x.plot === plot.id);
      if (!h) {
        const built = tryBuild(this.models.buildStructure ? () => this.models.buildStructure!('housePlot') : null);
        const root = built?.root ?? box(0.2, 1, 0.2, 0xa8743f);
        root.position.set(plot.x, hf.height(plot.x, plot.z), plot.z);
        root.rotation.y = plot.rot;
        this.houses.add(root);
        continue;
      }
      const bp = blueprintDef(h.blueprint);
      const pose = housePose(this.life, h);
      const def = structureDef(bp.structure);
      const built = tryBuild(this.models.buildStructure ? () => this.models.buildStructure!(bp.structure, { stage: h.stage }) : null);
      const root = built?.root ?? box(def.w, h.stage === 0 ? 0.1 : (def.h * h.stage) / bp.stages.length, def.d, isComplete(h) ? 0xf3e7c9 : 0xc8995f);
      const y = hf.height(pose.x, pose.z);
      root.position.set(pose.x, y, pose.z);
      root.rotation.y = pose.rot;
      this.houses.add(root);
      if (isComplete(h)) {
        // Its own copies of the materials, so cutting its walls down leaves every other model whole.
        const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
        root.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          const cut = mats.map((mt) => {
            const c = (mt as THREE.Material).clone();
            c.clippingPlanes = [plane];
            return c;
          });
          mesh.material = Array.isArray(mesh.material) ? cut : cut[0];
        });
        this.homes.push({ x: pose.x, z: pose.z, rot: pose.rot, hw: def.w / 2, hd: def.d / 2, floor: y + (def.floor ?? 0.25), plane });
      }
    }
  }

  /** Walls down while you are indoors, the way a dollhouse opens. */
  private updateIndoors(px: number, py: number, pz: number): void {
    this.inside = null;
    for (const h of this.homes) {
      const dx = px - h.x;
      const dz = pz - h.z;
      const lx = dx * Math.cos(h.rot) - dz * Math.sin(h.rot);
      const lz = dx * Math.sin(h.rot) + dz * Math.cos(h.rot);
      const indoors = Math.abs(lx) < h.hw - 0.2 && Math.abs(lz) < h.hd - 0.2 && py > h.floor - 0.6 && py < h.floor + 3;
      h.plane.constant = indoors ? h.floor + 1.3 : 1e6;
      if (indoors) this.inside = { x: h.x, z: h.z, rot: h.rot, hw: h.hw, hd: h.hd };
    }
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
      const b = this.life.state.ships.find((x) => x.slip === sy.id);
      if (b) {
        const design = shipDesign(b.design);
        const def = rideable(design.vehicle);
        const m = tryBuild(this.models.buildVehicle && !isMount(def) ? () => this.models.buildVehicle!(def as never) : null);
        const reveal = b.stage > 0 ? design.stages[b.stage - 1].reveal : -1.6;
        const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
        const ship = m?.root ?? standInVehicle(def);
        ship.position.set(0, deckY, 0);
        ship.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          if ((mesh.material as THREE.Material).type === 'ShaderMaterial') {
            mesh.visible = b.stage >= design.stages.length; // outlines only once she is whole
            return;
          }
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
    if (isMount(def)) {
      const m = tryBuild(this.models.buildMount ? () => this.models.buildMount!(def) : null);
      root = m && m.root.children.length ? m.root : standInVehicle(def);
      if (m && m.root.children.length) mount = m.animate.bind(m);
    } else {
      const m = tryBuild(this.models.buildVehicle ? () => this.models.buildVehicle!(def) : null);
      root = m?.root ?? standInVehicle(def);
      if (m) animate = m.animate.bind(m);
    }
    root.rotation.order = 'YXZ';
    this.group.add(root);
    s = { root, animate, mount, def, cargo: [] };
    this.vehicles.set(v.id, s);
    return s;
  }

  private packModel(id: string): THREE.Object3D {
    return tryBuild(this.models.buildPack ? () => this.models.buildPack!(id) : null) ?? standInPack(id);
  }

  update(sim: Sim, dt: number, cameraPos: THREE.Vector3): void {
    this.time += dt;
    const life = this.life;
    const hf = life.zone.gen.terrain;
    const p = sim.player;

    if (life.revision !== this.builtRevision) {
      this.builtRevision = life.revision;
      const plots = life.state.scarecrows.length + life.state.houses.length * 100;
      if (plots !== this.plotCount) {
        this.plotCount = plots;
        this.onGroundChanged?.();
      }
      this.rebuildPlots();
      const sk = (life.state.ships ?? []).map((b) => `${b.slip}:${b.stage}`).join(',') + '|';
      if (sk !== this.shipKey) {
        this.shipKey = sk;
        this.rebuildSlips();
      }
      const key = life.state.houses.map((h) => `${h.plot}:${h.stage}`).join(',');
      if (key !== this.houseKey || this.houses.children.length === 0) {
        this.houseKey = key;
        this.homes = [];
        this.rebuildHouses();
      }
      for (const n of this.nodes) if (n) n.root.visible = nodeReady(life, n.i);
    }
    if (life.state.clock % 1 < dt) for (const n of this.nodes) if (n) n.root.visible = nodeReady(life, n.i);

    this.updateIndoors(this.hero.root.position.x, this.hero.root.position.y, this.hero.root.position.z);

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
      const sc = life.state.scarecrows.find((s) => s.id === a.sc);
      const pl = sc?.cells[a.idx];
      if (!pl) continue;
      const hungry = (pl.fedUntil ?? 0) <= life.state.clock;
      const ready = pl.growth >= 1 && (pl.produce ?? 0) >= 1;
      a.animate?.(dt, { time: this.time + a.phase, hungry, ready });
      if (!hungry) a.root.rotation.y += Math.sin(this.time * 0.3 + a.phase) * dt * 0.4;
    }

    // Vehicles: the one you ride is drawn where your interpolated body is, so you never slide in the seat.
    const live = new Set<number>();
    for (const v of life.state.vehicles) {
      live.add(v.id);
      const s = this.shownVehicle(v);
      const def = s.def;
      let x = v.x;
      let y = v.y;
      let z = v.z;
      if (v.ridden) {
        const seat = def.seats[0];
        const [ox, oz] = toWorld(seat.x, seat.z, v.heading);
        const hp = this.hero.root.position;
        x = hp.x - ox;
        z = hp.z - oz;
        y = hp.y - (anchorWorld(v, seat).y - v.y);
        this.hero.seatPose = seat.pose;
      }
      let pitch = v.pitch;
      let roll = v.roll;
      if (isBoat(def)) {
        // Swell, much heavier out at sea in a storm.
        const rough = 1 + 3 * stormAt(life, hf.water - hf.height(v.x, v.z));
        const swell = Math.sin(this.time * 1.3 + v.x * 0.05) * 0.12 + Math.sin(this.time * 0.8 + v.z * 0.07) * 0.08;
        y += swell * (def.length > 8 ? 0.5 : 1) * rough;
        pitch += Math.sin(this.time * 1.1 + v.z * 0.05) * 0.025 * rough;
        roll += Math.sin(this.time * 0.9 + v.x * 0.04) * 0.035 * rough;
      }
      s.root.position.set(x, y, z);
      s.root.rotation.set(-pitch, v.heading, roll);
      if (s.animate) {
        const rel = angleDiff(life.state.weather.windDir, v.heading);
        s.animate(dt, {
          speed: v.speed,
          steer: v.steer,
          throttle: v.throttle,
          sail: isBoat(def) && def.sail ? v.sail : 0,
          boom: isBoat(def) && def.sail ? Math.max(-1.1, Math.min(1.1, -rel * 0.55)) * (sailEfficiency(rel) > 0.3 ? 1 : 0.4) : 0,
          time: this.time,
        });
      }
      if (s.mount) s.mount(dt, { speed: Math.abs(v.speed), grounded: v.grounded });
    }
    for (const [id, s] of this.vehicles) {
      if (live.has(id)) continue;
      this.group.remove(s.root);
      this.vehicles.delete(id);
    }
    if (!p.vehicle) this.hero.seatPose = '';

    // Packs: on your back, in a vehicle's slot, or on the ground.
    const seen = new Set<number>();
    for (const pk of life.state.packs) {
      seen.add(pk.id);
      let m = this.packMeshes.get(pk.id);
      if (!m) {
        m = this.packModel(pk.def);
        this.packMeshes.set(pk.id, m);
      }
      if (pk.at === 'back' && p.pack === pk.id && p.mode !== 'ride') {
        if (m.parent !== this.hero.torsoJoint) this.hero.torsoJoint.add(m);
        m.position.set(0, 0.0, -0.17);
        m.rotation.set(0, Math.PI, 0);
        m.scale.setScalar(0.92);
      } else if (pk.at === 'back') {
        // Riding with a pack: it goes in the seat behind you (a donkey's pannier, a cart bench).
        if (m.parent !== this.group) this.group.add(m);
        const v = life.state.vehicles.find((x) => x.id === p.vehicle);
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
        const m = tryBuild(this.models.buildGlider ? () => this.models.buildGlider!(def) : null);
        if (m) this.gliderModel = { root: m.root, animate: m.animate.bind(m) };
        else {
          const wing = new THREE.Mesh(new THREE.ConeGeometry(def.span / 2, 2.2, 3).rotateX(Math.PI / 2).scale(1, 0.1, 1), toon(0xf3e7c9));
          wing.position.y = 2.5;
          const g = new THREE.Group();
          g.add(wing);
          this.gliderModel = { root: g };
        }
        this.gliderShown = p.glider;
      }
      const g = this.gliderModel!;
      if (g.root.parent !== this.hero.root) this.hero.root.add(g.root);
      g.root.visible = true;
      // The model banks and pitches its own wing (positive bank dips the left wing, nose up for a climb).
      g.root.rotation.set(0, 0, 0);
      g.animate?.(dt, { bank: p.bank * 0.6, pitch: Math.max(-0.35, Math.min(0.3, p.vel.y / 12)), speed: p.airspeed });
    } else if (this.gliderModel) this.gliderModel.root.visible = false;

    // Placement ghost.
    const pl = life.placing;
    this.ghost.visible = !!pl;
    if (pl) {
      this.ghost.position.set(pl.x, hf.height(pl.x, pl.z) + 0.12, pl.z);
      this.ghost.rotation.y = pl.rot;
      (this.ghost.material as THREE.MeshBasicMaterial).color.setHex(pl.problem ? 0xff6b6b : 0x7bed9f);
    }

    // Rain, fading in and out.
    const raining = life.state.clock < life.state.weather.rainUntil;
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
        m.lookAt(cameraPos.x, m.getWorldPosition(new THREE.Vector3()).y, cameraPos.z);
        ((m as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.3;
      }
    }
  }
}
