import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import emberholm from '../../../../shared/regions/emberholm.json' with { type: 'json' };
import { GLIDERS, MOUNTS, VEHICLES, isBoat } from '../../../content/vehicles';
import { ANIMALS } from '../../../content/farming';
import { part, toon } from '../../../render/toon';
import { CROPS, PACKS, PROPS, STRUCTURES } from '../../../render/models/data';
import { buildAnimal } from '../../../render/models/animals';
import { buildVillager } from '../../../render/models/villagers';
import { PAL, cost, vcMaterial } from '../../../render/models/kit';
import { buildCrop, cropStages } from '../../../render/models/crops';
import { buildGlider } from '../../../render/models/gliders';
import { buildMount } from '../../../render/models/mounts';
import { buildPack } from '../../../render/models/packs';
import { propGeometry } from '../../../render/models/props';
import { buildStructure } from '../../../render/models/structures';
import { buildVehicle } from '../../../render/models/vehicles';
import { h } from '../dom';
import type { AnimDef, Gallery, Options, Subject } from '../types';
import type { ZoneNpc } from '../../../engine/zone';

// Every procedural model (src/render/models), side by side next to a 1.9 m figure, as the model
// gallery always drew them: a category at a time or all of them, one close up, turned, with the
// seats, cargo slots and footprints the rules lean on marked. Library routes:
//   #/models/<all|vehicles|mounts|gliders|packs|crops|structures|props|livestock|villagers>
//   ?only=<id>        one model, close up
//   &label=<text>     only models whose label holds it (a cottage stage)
//   &yaw=<radians>    every model turned to this heading (0 faces the camera)
//   &anchors=1        seat, cargo and footprint markers
// Drag to orbit, wheel to zoom. window.__library.gallery() = { ready, ids, stats, probe, ray,
// seaInside, cat, frames } (tests/integration/models.spec.ts).

const CATS = ['vehicles', 'mounts', 'gliders', 'packs', 'crops', 'structures', 'props', 'livestock', 'villagers'] as const;
type Cat = (typeof CATS)[number];
const CAT_LABELS: Record<Cat, string> = {
  vehicles: 'Vehicles',
  mounts: 'Mounts',
  gliders: 'Gliders',
  packs: 'Trade Packs',
  crops: 'Crops',
  structures: 'Structures',
  props: 'Props',
  livestock: 'Livestock',
  villagers: 'Villagers',
};

interface Item {
  id: string;
  label: string;
  object: THREE.Object3D;
  update?: (dt: number, t: number) => void;
  /** Sits in the sea strip (origin at sea level). */
  water?: boolean;
  /** Stand a reference figure beside it (default true). */
  figure?: boolean;
  /** Display yaw; models face +Z, so a little turn shows their front and left side. */
  yaw?: number;
  anchors?: Array<{ p: [number, number, number]; kind: 'seat' | 'cargo' | 'mark' }>;
  /** Items sharing a row key are laid out on one row (a crop's stages). */
  row?: string;
  /** What the stats measure, if not the whole object (leaves out preview soil and pilots). */
  stat?: THREE.Object3D;
}

/** A model's triangles and draws, its size and its bounds in its own frame. */
interface Stat {
  triangles: number;
  draws: number;
  size: number[];
  min: number[];
  max: number[];
}

const NPCS = (emberholm as unknown as { npcs: ZoneNpc[] }).npcs;

/** A plain 1.9 m person in the hero's colours, for scale. */
function figure(): THREE.Group {
  const g = new THREE.Group();
  const skin = toon(0xf1c27d);
  const tunic = toon(0x3a6ea5);
  const pants = toon(0x2f3e46);
  const hair = toon(0x5b3a29);
  const B = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  for (const x of [-0.1, 0.1]) part(g, B(0.15, 0.85, 0.18), pants, x, 0.425, 0);
  part(g, B(0.44, 0.62, 0.28), tunic, 0, 1.15, 0);
  for (const x of [-0.29, 0.29]) part(g, B(0.13, 0.6, 0.15), tunic, x, 1.12, 0);
  part(g, B(0.4, 0.4, 0.38), skin, 0, 1.66, 0);
  part(g, B(0.42, 0.1, 0.4), hair, 0, 1.86, -0.01);
  g.userData.figure = true;
  return g;
}

// ---------- the categories ----------

function vehicles(): Item[] {
  return VEHICLES.map((def) => {
    const m = buildVehicle(def);
    const boat = isBoat(def);
    return {
      id: def.id,
      label: def.name,
      object: m.root,
      water: boat,
      anchors: [
        ...def.seats.map((s) => ({ p: [s.x, s.y, s.z] as [number, number, number], kind: 'seat' as const })),
        ...def.cargo.map((c) => ({ p: [c.x, c.y, c.z] as [number, number, number], kind: 'cargo' as const })),
      ],
      update: (dt, t) =>
        m.animate(dt, {
          speed: boat ? 2.5 : 4,
          steer: Math.sin(t * 0.7) * 0.8,
          throttle: 0.85,
          sail: 1,
          boom: Math.sin(t * 0.35) * 0.5,
          time: t,
        }),
    };
  });
}

function mounts(): Item[] {
  return MOUNTS.flatMap((def) =>
    (['walk', 'gallop'] as const).map((gait) => {
      const m = buildMount(def);
      const speed = gait === 'walk' ? def.walkSpeed : def.gallopSpeed;
      return {
        id: def.id,
        label: `${def.name} · ${gait}`,
        object: m.root,
        anchors: [
          ...def.seats.map((s) => ({ p: [s.x, s.y, s.z] as [number, number, number], kind: 'seat' as const })),
          ...def.cargo.map((c) => ({ p: [c.x, c.y, c.z] as [number, number, number], kind: 'cargo' as const })),
        ],
        update: (dt: number) => m.animate(dt, { speed, grounded: true }),
      };
    }),
  );
}

function gliders(): Item[] {
  return GLIDERS.map((def) => {
    const m = buildGlider(def);
    const holder = new THREE.Group();
    holder.add(m.root, figure());
    return {
      id: def.id,
      label: def.name,
      object: holder,
      stat: m.root,
      figure: false,
      yaw: -0.7,
      update: (dt, t) => m.animate(dt, { bank: Math.sin(t * 0.6) * 0.3, pitch: Math.sin(t * 0.43) * 0.12, speed: def.cruiseSpeed }),
    };
  });
}

function packs(): Item[] {
  return PACKS.flatMap((p) => {
    const worn = figure();
    const pack = buildPack(p.id);
    pack.position.set(0, 0.8, -0.14);
    worn.add(pack);
    return [
      { id: p.id, label: p.name, object: buildPack(p.id), figure: false, yaw: -0.6 },
      { id: p.id, label: 'worn', object: worn, figure: false, yaw: Math.PI - 0.7 },
    ];
  });
}

function soil(w: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, w), toon(PAL.soil));
  m.position.y = -0.015;
  m.receiveShadow = true;
  return m;
}

function crops(): Item[] {
  return CROPS.flatMap((c) =>
    cropStages(c.id).map((stage) => {
      const g = new THREE.Group();
      const crop = buildCrop(c.id, stage);
      g.add(soil(2), crop);
      return { id: c.id, label: `${c.id} ${stage}`, object: g, stat: crop, figure: stage === c.stages - 1, yaw: 0, row: c.id };
    }),
  );
}

function structures(): Item[] {
  return STRUCTURES.flatMap((s) => {
    const stages = s.stages?.length ? s.stages.map((name, i) => ({ name, i })) : [{ name: '', i: undefined as number | undefined }];
    return stages.map(({ name, i }) => {
      const m = buildStructure(s.id, { stage: i });
      return {
        id: s.id,
        label: name ? `${s.id} · ${name}` : s.id,
        object: m.root,
        water: s.id === 'dock',
        row: name ? s.id : undefined,
        yaw: -0.45,
        anchors: footprintMarks(s.w, s.d, s.deck),
        update: m.animate ? (_dt: number, t: number) => m.animate!(t) : undefined,
      };
    });
  });
}

function props(): Item[] {
  return PROPS.map((p) => {
    const m = new THREE.Mesh(propGeometry(p.id), vcMaterial());
    m.castShadow = true;
    m.receiveShadow = true;
    return { id: p.id, label: p.id, object: m, yaw: -0.5, anchors: footprintMarks(p.w, p.d) };
  });
}

const LIVESTOCK = [
  { name: 'young', stage: 0, hungry: false, ready: false },
  { name: 'adult', stage: 1, hungry: false, ready: false },
  { name: 'hungry', stage: 1, hungry: true, ready: false },
  { name: 'ready', stage: 1, hungry: false, ready: true },
];

function livestock(): Item[] {
  return ANIMALS.map((a) => a.id).flatMap((id) =>
    LIVESTOCK.map((st, i) => {
      const m = buildAnimal(id, st.stage);
      const g = new THREE.Group();
      const pen = new THREE.Mesh(new THREE.BoxGeometry(2, 0.04, 2), toon(0xd9c27a));
      pen.position.y = -0.015;
      pen.receiveShadow = true;
      g.add(pen, m.root);
      return {
        id,
        label: `${id} · ${st.name}`,
        object: g,
        stat: m.root,
        figure: i === LIVESTOCK.length - 1,
        yaw: -0.6,
        row: id,
        update: (dt: number, t: number) => m.animate(dt, { time: t, hungry: st.hungry, ready: st.ready }),
      };
    }),
  );
}

function villagers(): Item[] {
  return NPCS.map((n, i) => {
    const m = buildVillager(n.id, n.look);
    const talking = i % 2 === 1;
    return {
      id: n.id,
      label: `${n.id} · ${n.title ?? ''}${talking ? ' (talking)' : ''}`,
      object: m.root,
      figure: false,
      yaw: -0.35,
      update: (dt: number, t: number) => m.animate(dt, { time: t, talking }),
    };
  });
}

function footprintMarks(w: number, d: number, deck?: number): Item['anchors'] {
  const y = deck ?? 0.02;
  return [
    [-w / 2, y, -d / 2],
    [w / 2, y, -d / 2],
    [-w / 2, y, d / 2],
    [w / 2, y, d / 2],
  ].map((p) => ({ p: p as [number, number, number], kind: 'mark' as const }));
}

const BUILD: Record<Cat, () => Item[]> = { vehicles, mounts, gliders, packs, crops, structures, props, livestock, villagers };

/** How many models a category shows, without building them. */
const COUNT: Record<Cat, () => number> = {
  vehicles: () => VEHICLES.length,
  mounts: () => MOUNTS.length * 2,
  gliders: () => GLIDERS.length,
  packs: () => PACKS.length * 2,
  crops: () => CROPS.reduce((n, c) => n + cropStages(c.id).length, 0),
  structures: () => STRUCTURES.reduce((n, s) => n + Math.max(1, s.stages?.length ?? 0), 0),
  props: () => PROPS.length,
  livestock: () => ANIMALS.length * LIVESTOCK.length,
  villagers: () => NPCS.length,
};

/** Size of the model itself, without the reference figure unless asked. */
function measure(obj: THREE.Object3D, withFigures = false): THREE.Box3 {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const v3 = new THREE.Vector3();
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    if (!withFigures) for (let p: THREE.Object3D | null = m; p; p = p.parent) if (p.userData.figure) return;
    // Exact: transform every vertex (a rotated box's bounds would overstate it).
    const pos = m.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) box.expandByPoint(v3.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
  });
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
  return box;
}

class ModelsGallery implements Gallery {
  readonly el: HTMLElement;
  readonly api: Record<string, unknown>;
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 2000);
  private readonly controls: OrbitControls;
  private readonly tags = h('div', { class: 'gl-tags' });
  private readonly placed: Array<{ item: Item; box: THREE.Box3; holder: THREE.Group; fig?: THREE.Object3D }> = [];
  private readonly stats: Record<string, Stat> = {};
  private tagEls: HTMLElement[] = [];
  private tagPoints: THREE.Vector3[] = [];
  /** The sea's surface, when there are boats. */
  private seaSurface: THREE.Mesh | null = null;
  private readonly resizer: ResizeObserver;
  private time = 0;
  private frames = 0;
  private readonly v = new THREE.Vector3();

  constructor(
    private readonly host: HTMLElement,
    cat: string,
    o: Options,
  ) {
    const cats: Cat[] = (CATS as readonly string[]).includes(cat) ? [cat as Cat] : [...CATS];
    const only = o.only || null;
    const pick = o.label || null;
    const r = this.renderer;
    r.setPixelRatio(1);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    const label = h('div', { class: 'gl-label' });
    this.el = h('div', { class: 'gallery' }, r.domElement, this.tags, label);
    const scene = this.scene;
    scene.background = new THREE.Color(PAL.sky);
    scene.add(new THREE.HemisphereLight(0xdff1ff, 0x5d7f3a, 1.25));
    const sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
    sun.castShadow = true;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    scene.add(sun, sun.target);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.resizer = new ResizeObserver(() => this.resize());
    this.resizer.observe(host);
    this.resize();

    // ---------- layout ----------
    const items: Item[] = [];
    for (const c of cats) items.push(...BUILD[c]().filter((it) => (!only || it.id === only) && (!pick || it.label.includes(pick))));
    for (const item of items) {
      // Measure in the model's own frame first, for the stats a test asserts on.
      item.update?.(0.016, 0.5);
      const local = measure(item.stat ?? item.object);
      const c = cost(item.stat ?? item.object);
      this.stats[item.label === 'worn' ? `${item.id}:worn` : item.label] = {
        ...c,
        size: local
          .getSize(new THREE.Vector3())
          .toArray()
          .map((v) => +v.toFixed(3)),
        min: local.min.toArray().map((v) => +v.toFixed(3)),
        max: local.max.toArray().map((v) => +v.toFixed(3)),
      };
      const holder = new THREE.Group();
      holder.add(item.object);
      item.object.rotation.y = o.yaw !== undefined && o.yaw !== '' ? Number(o.yaw) : (item.yaw ?? -0.55);
      let fig: THREE.Object3D | undefined;
      if (item.figure !== false) {
        fig = figure();
        holder.add(fig);
      }
      if (o.anchors === '1' && item.anchors) {
        for (const a of item.anchors) {
          const colour = a.kind === 'seat' ? 0x22dd55 : a.kind === 'cargo' ? 0xff8800 : 0xff2266;
          const marker = new THREE.Mesh(
            a.kind === 'cargo' ? new THREE.BoxGeometry(0.5, 0.02, 0.5) : new THREE.SphereGeometry(0.07, 8, 6),
            new THREE.MeshBasicMaterial({ color: colour, depthTest: false, transparent: true, opacity: 0.85 }),
          );
          marker.position.set(...a.p);
          marker.renderOrder = 10;
          item.object.add(marker);
        }
      }
      scene.add(holder);
      this.placed.push({ item, box: measure(item.object, true), holder, fig });
    }
    const placed = this.placed;

    // Rows along +X, front to back; boats get their own rows at the back, over the sea strip.
    const GAP = 1.6;
    const land = placed.filter((p) => !p.item.water);
    const sea = placed.filter((p) => p.item.water);
    const width = (p: (typeof placed)[number]) => p.box.max.x - p.box.min.x + (p.fig ? 1.2 : 0);
    const area = placed.reduce((s, p) => s + (width(p) + GAP) * (p.box.max.z - p.box.min.z + GAP * 2), 0);
    const rowWidth = Math.max(...placed.map(width), Math.sqrt(area * 2.6));
    let z = 0;
    let seaFront = 0;
    let seaBack = 0;
    for (const [group, isSea] of [
      [land, false],
      [sea, true],
    ] as const) {
      if (!group.length) continue;
      if (isSea) seaFront = z + GAP / 2;
      let i = 0;
      while (i < group.length) {
        const row: typeof placed = [];
        let w = 0;
        const key = group[i].item.row;
        while (i < group.length && (!row.length || (key ? group[i].item.row === key : !group[i].item.row && w + width(group[i]) <= rowWidth))) {
          w += width(group[i]) + GAP;
          row.push(group[i++]);
        }
        const depth = Math.max(...row.map((p) => p.box.max.z - p.box.min.z));
        let x = -w / 2;
        for (const p of row) {
          const fx = x + 0.4;
          if (p.fig) x += 1.2;
          p.holder.position.set(x - p.box.min.x, 0, z - p.box.max.z);
          p.fig?.position.set(fx - p.holder.position.x, 0, z - 0.4 - p.holder.position.z);
          x += p.box.max.x - p.box.min.x + GAP;
        }
        z -= depth + GAP * 2;
      }
      if (isSea) seaBack = z + GAP;
    }

    const all = new THREE.Box3();
    for (const p of placed) all.union(measure(p.holder, true));
    if (all.isEmpty()) all.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
    const centre = all.getCenter(new THREE.Vector3());
    const size = all.getSize(new THREE.Vector3());

    // Ground: grass, with a strip of sea where the boats float.
    const extent = Math.max(size.x, size.z) * 3 + 200;
    const grass = (z0: number, z1: number) => {
      if (z1 - z0 < 0.01) return;
      const g = new THREE.Mesh(new THREE.PlaneGeometry(extent, z1 - z0).rotateX(-Math.PI / 2), toon(PAL.grass));
      g.position.set(centre.x, 0, (z0 + z1) / 2);
      g.receiveShadow = true;
      scene.add(g);
    };
    if (sea.length) {
      grass(seaFront, centre.z + extent / 2);
      grass(centre.z - extent / 2, seaBack);
      const depth = 6;
      const water = new THREE.Mesh(
        new THREE.PlaneGeometry(extent, seaFront - seaBack).rotateX(-Math.PI / 2),
        toon(PAL.sea, { transparent: true, opacity: 0.72, depthWrite: false }),
      );
      water.position.set(centre.x, 0, (seaFront + seaBack) / 2);
      water.renderOrder = 5;
      water.receiveShadow = true;
      scene.add(water);
      this.seaSurface = water;
      const bed = new THREE.Mesh(new THREE.PlaneGeometry(extent, seaFront - seaBack).rotateX(-Math.PI / 2), toon(0x2f7fa8));
      bed.position.set(centre.x, -depth, (seaFront + seaBack) / 2);
      scene.add(bed);
      for (const zz of [seaFront, seaBack]) {
        const bank = new THREE.Mesh(new THREE.PlaneGeometry(extent, depth), toon(0x7a5a3a, { side: THREE.DoubleSide }));
        bank.position.set(centre.x, -depth / 2, zz);
        scene.add(bank);
      }
    } else {
      grass(centre.z - extent / 2, centre.z + extent / 2);
    }

    // Camera and sun frame whatever was built.
    const camera = this.camera;
    const radius = Math.max(2, size.length() / 2);
    const elev = only ? 0.38 : 0.62;
    const target = new THREE.Vector3(centre.x, only ? centre.y * 0.9 : Math.min(size.y * 0.35, all.max.y * 0.5), centre.z);
    // Pull back just far enough that every corner of the gallery (and the labels above it) is in frame.
    const view = new THREE.Vector3(0, Math.sin(elev), Math.cos(elev));
    const corners: THREE.Vector3[] = [];
    for (const x of [all.min.x, all.max.x])
      for (const y of [all.min.y, all.max.y + 0.8]) for (const zz of [all.min.z, all.max.z]) corners.push(new THREE.Vector3(x, y, zz));
    let near = 0.5;
    let far = 1500;
    for (let i = 0; i < 40; i++) {
      const d = (near + far) / 2;
      camera.position.copy(target).addScaledVector(view, d);
      camera.lookAt(target);
      camera.updateMatrixWorld(true);
      const fits = corners.every((c) => {
        if (c.clone().applyMatrix4(camera.matrixWorldInverse).z > -camera.near) return false;
        const p = c.clone().project(camera);
        return Math.abs(p.x) < 0.94 && p.y < 0.86 && p.y > -0.94;
      });
      if (fits) far = d;
      else near = d;
    }
    camera.position.copy(target).addScaledVector(view, far);
    camera.lookAt(target);
    this.controls.target.copy(target);
    this.controls.update();
    sun.position.set(target.x + radius * 0.6, target.y + radius * 1.4, target.z + radius * 0.9);
    sun.target.position.copy(target);
    const sc = sun.shadow.camera;
    sc.left = -radius * 1.1;
    sc.right = radius * 1.1;
    sc.top = radius * 1.1;
    sc.bottom = -radius * 1.1;
    sc.near = 0.5;
    sc.far = radius * 5;
    sc.updateProjectionMatrix();
    sun.shadow.mapSize.set(radius > 30 ? 4096 : 2048, radius > 30 ? 4096 : 2048);

    // Labels float above each model.
    this.tagEls = placed.map((p) => this.tags.appendChild(h('div', { class: 'tag' }, p.item.label)));
    this.tagPoints = placed.map((p) => {
      const b = measure(p.item.object, true);
      return new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y + 0.3, (b.min.z + b.max.z) / 2);
    });
    label.textContent = `${cats.length === 1 ? cats[0] : 'all'}${only ? ` · ${only}` : ''} · ${placed.length} models · figure 1.9 m`;

    const self = this;
    this.api = {
      ready: true,
      ids: [...new Set(placed.map((p) => p.item.id))],
      stats: this.stats,
      cat: cats.length === 1 ? cats[0] : 'all',
      /** Frames drawn so far (the models animate a frame at a time). */
      get frames() {
        return self.frames;
      },
      probe: (l: string, x: number, zz: number, from = 60) => this.probe(l, x, zz, from),
      ray: (l: string, from: [number, number, number], dir: [number, number, number]) => this.ray(l, from, dir),
      seaInside: (l: string, swell: { bob?: number; pitch?: number; roll?: number } = {}) => this.seaInside(l, swell),
    };
    this.frame(0);
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const hh = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, hh, false);
    this.camera.aspect = w / hh;
    this.camera.updateProjectionMatrix();
  }

  ready(): boolean {
    return true;
  }

  frame(dt: number): void {
    const step = Math.min(0.05, dt);
    this.time += step;
    for (const p of this.placed) p.item.update?.(step, this.time);
    this.renderer.render(this.scene, this.camera);
    this.frames++;
    const w = this.host.clientWidth;
    const hh = this.host.clientHeight;
    this.tagPoints.forEach((pt, i) => {
      this.v.copy(pt).project(this.camera);
      const el = this.tagEls[i];
      el.style.display = this.v.z > 1 ? 'none' : '';
      el.style.left = `${((this.v.x + 1) / 2) * w}px`;
      el.style.top = `${((1 - this.v.y) / 2) * hh}px`;
    });
  }

  numbers(): Array<{ heading: string; rows: Array<[string, string]> }> {
    const rows = Object.entries(this.stats).map(([k, s]): [string, string] => [k, `${s.triangles} triangles · ${s.draws} draws · ${s.size.join(' × ')} m`]);
    const tris = Object.values(this.stats).reduce((n, s) => n + s.triangles, 0);
    return [
      {
        heading: 'In All',
        rows: [
          ['Models', String(rows.length)],
          ['Triangles', String(tris)],
        ],
      },
      { heading: 'Each Model', rows },
    ];
  }

  /**
   * Height of the first surface straight down through a model at (x, z) in its own frame,
   * starting from `from` (so a probe can start under a roof): checks decks and floors.
   */
  private probe(label: string, x: number, z: number, from = 60): number | null {
    return this.ray(label, [x, from, z], [0, -1, 0])?.[1] ?? null;
  }

  /** First surface hit by a ray in a model's own frame; returns the hit point in that frame. */
  private ray(label: string, from: [number, number, number], dir: [number, number, number]): number[] | null {
    const p = this.placed.find((q) => q.item.label === label);
    if (!p) return null;
    const obj = p.item.stat ?? p.item.object;
    obj.updateMatrixWorld(true);
    const origin = new THREE.Vector3(...from).applyMatrix4(obj.matrixWorld);
    const d = new THREE.Vector3(...dir).transformDirection(obj.matrixWorld);
    const caster = new THREE.Raycaster(origin, d);
    const hits = caster.intersectObject(obj, true).filter((hit) => !(hit.object as THREE.Mesh).userData.figure);
    if (!hits.length) return null;
    const local = hits[0].point.clone().applyMatrix4(obj.matrixWorld.clone().invert());
    return local.toArray().map((v) => +v.toFixed(4));
  }

  /**
   * Whether the sea shows inside a boat's hull. Draws the boat from straight above twice, as it is and
   * with neither the sea nor the hull's seal (vehicles.ts sealHull), and compares the two over the
   * hull's opening (a mask drawn from the seal): the sea drawn over the floor, or anything inside
   * hidden by the seal, is a difference there. `swell` first lowers and tips the boat into the sea, as
   * src/render/open/life.ts rocks one at sea. Returns how many pixels inside the opening differ, out of
   * how many, and the share of the pixels outside it that differ (the sea, which should be drawn).
   */
  private seaInside(label: string, swell: { bob?: number; pitch?: number; roll?: number }): { inside: number; of: number; around: number } | null {
    const p = this.placed.find((q) => q.item.label === label);
    const seaSurface = this.seaSurface;
    if (!p || !seaSurface) return null;
    const renderer = this.renderer;
    const scene = this.scene;
    const obj = p.item.object;
    const seals: THREE.Mesh[] = [];
    obj.traverse((o) => o.name === 'seal' && seals.push(o as THREE.Mesh));
    if (!seals.length) return null;
    const was = { y: obj.position.y, rot: obj.rotation.clone() };
    obj.rotation.set(-(swell.pitch ?? 0), was.rot.y, swell.roll ?? 0, 'YXZ');
    obj.position.y = swell.bob ?? 0;
    scene.updateMatrixWorld(true);
    // Straight down on the boat, framing it.
    const box = measure(obj);
    const c = box.getCenter(new THREE.Vector3());
    const half = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.6;
    const w = renderer.domElement.width;
    const hh = renderer.domElement.height;
    const cam = new THREE.OrthographicCamera((-half * w) / hh, (half * w) / hh, half, -half, 0.1, 200);
    cam.position.set(c.x, c.y + 60, c.z);
    cam.up.set(0, 0, -1);
    cam.lookAt(c);
    cam.updateMatrixWorld(true);
    const gl = renderer.getContext();
    const shot = (s: THREE.Scene) => {
      renderer.render(s, cam);
      const px = new Uint8Array(w * hh * 4);
      gl.readPixels(0, 0, w, hh, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const real = shot(scene);
    seaSurface.visible = false;
    for (const s of seals) s.visible = false;
    const bare = shot(scene);
    seaSurface.visible = true;
    for (const s of seals) s.visible = true;
    const maskScene = new THREE.Scene();
    maskScene.background = new THREE.Color(0x000000);
    const white = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    for (const s of seals) {
      const m = new THREE.Mesh(s.geometry, white);
      m.matrixAutoUpdate = false;
      m.matrix.copy(s.matrixWorld);
      maskScene.add(m);
    }
    const mask = shot(maskScene);
    obj.position.y = was.y;
    obj.rotation.copy(was.rot);
    // Inside: well inside the opening (two pixels in from its edge, clear of the antialiasing).
    const open = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < hh && mask[(y * w + x) * 4] > 128;
    const differs = (i: number) => Math.max(Math.abs(real[i] - bare[i]), Math.abs(real[i + 1] - bare[i + 1]), Math.abs(real[i + 2] - bare[i + 2])) > 4;
    let inside = 0;
    let of = 0;
    let out = 0;
    let outDiffer = 0;
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (open(x, y)) {
          if (!open(x - 2, y) || !open(x + 2, y) || !open(x, y - 2) || !open(x, y + 2)) continue;
          of++;
          if (differs(i)) inside++;
        } else {
          out++;
          if (differs(i)) outDiffer++;
        }
      }
    }
    return { inside, of, around: +(outDiffer / Math.max(1, out)).toFixed(3) };
  }

  dispose(): void {
    this.resizer.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

const total = (): number => CATS.reduce((n, c) => n + COUNT[c](), 0);

export const modelsSubject: Subject = {
  id: 'models',
  name: 'Models',
  group: 'Galleries',
  blurb: 'Every model side by side, beside a figure 1.9 m tall',
  options: [
    {
      id: 'anchors',
      label: 'Anchors',
      value: '0',
      choices: [
        { value: '0', label: 'Hidden' },
        { value: '1', label: 'Seats, Cargo, Corners' },
      ],
    },
    { id: 'only', label: 'Only', value: '', hint: 'an id, as rowboat' },
    { id: 'label', label: 'Label Holds', value: '', hint: 'a cottage stage, as complete' },
    { id: 'yaw', label: 'Turned', value: '', hint: 'radians, 0 facing you' },
  ],
  anims: (): AnimDef[] => [
    { id: 'all', label: 'Everything', group: 'Categories', frames: 0, fps: 60, loop: true, tag: String(total()) },
    ...CATS.map((c) => ({ id: c, label: CAT_LABELS[c], group: 'Categories', frames: 0, fps: 60, loop: true, tag: String(COUNT[c]()) })),
  ],
  gallery: (host, cat, o) => new ModelsGallery(host, cat, o),
  source: () => ({
    system:
      "Low-poly models built in code (src/render/models/) to the data's exact footprints and anchors (shared/*.json): each a few merged meshes for few draw calls, with an animate() for what moves (wheels, oars, sails, legs, a windmill's sails). The made models (Meshy, src/render/assets/models/) are swapped in for some of them by id in the game (models/glb.ts); this gallery shows the procedural ones, which the rules' anchors are measured against.",
    files: [
      {
        path: 'src/render/models/',
        what: 'every builder: vehicles.ts, mounts.ts, gliders.ts, packs.ts, crops.ts, structures.ts, props.ts, animals.ts, villagers.ts',
      },
      { path: 'src/render/models/kit.ts', what: 'the blocks, palette (PAL) and cost()' },
      { path: 'shared/vehicles.json, shared/structures.json, shared/trade.json, shared/farming.json', what: 'footprints, seats, cargo slots, decks, draft' },
      { path: 'src/dev/library/galleries/models.ts', what: 'this gallery: layout, anchors, the numbers and probes the tests read' },
    ],
    conventions: 'Models face +Z with their origin on the ground (a boat at sea level). Seats are green, cargo slots orange, footprint corners red (Anchors).',
    checks: [
      {
        command: 'npx playwright test tests/integration/models.spec.ts',
        what: 'every category builds in budget; wheels, hulls, seats, cargo, decks and walls where the data says; no sea in a hull',
      },
    ],
  }),
  animSource: (cat) => (cat === 'all' ? 'every builder in src/render/models/' : `the ${cat} builders in src/render/models/`),
};
