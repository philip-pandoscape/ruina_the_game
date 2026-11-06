import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildingPlan, buildingPlanIds, mirrorPlan, STOREY } from '../../../content/buildings';
import { buildingColliders, type PlacedBuilding } from '../../../engine/zone';
import { assetsReady } from '../../../render/assets';
import { windowGlow } from '../../../render/models/glb';
import { Village } from '../../../render/village/village';
import { h } from '../dom';
import type { AnimDef, Gallery, Options, Subject } from '../types';

// The buildings you can walk into, as the game draws them (src/render/village), as their viewer
// always showed them: every plan in a row, or one, by day or night. Library routes:
//   #/buildings/<all|plan id>
//   ?cut=0               cut open above that storey, as seen from inside it
//   &colliders=1         the rules' walls (red), decks (blue) and posts (yellow) over it
//   &mirror=1            mirrored
//   &night=1             after dark (windows lit, lamps up)
//   &cam=x,y,z&at=x,y,z  where the camera is and what it looks at
// window.__library.gallery() = { ready(), plans, colliders } (tests/integration/buildings.spec.ts).

const label = (id: string): string => id.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
const vec = (s: string | undefined): [number, number, number] | null => {
  const v = s?.split(',').map(Number);
  return v && v.length === 3 && v.every(Number.isFinite) ? (v as [number, number, number]) : null;
};

class BuildingsGallery implements Gallery {
  readonly el: HTMLElement;
  readonly api: Record<string, unknown>;
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  private readonly controls: OrbitControls;
  private readonly village: Village;
  private readonly placed: PlacedBuilding[] = [];
  private readonly solids: Array<{ id: string; boxes: number; decks: number; posts: number }> = [];
  private readonly resizer: ResizeObserver;
  private readonly cut: number | null;
  private readonly night: boolean;

  constructor(
    private readonly host: HTMLElement,
    plan: string,
    o: Options,
  ) {
    const ids = plan !== 'all' && buildingPlan(plan) ? [plan] : buildingPlanIds();
    const r = this.renderer;
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.NeutralToneMapping;
    const tag = h('div', { class: 'gl-label', style: 'padding:4px 8px;background:rgba(255,255,255,0.7)' });
    this.el = h('div', { class: 'gallery' }, r.domElement, tag);
    const night = (this.night = o.night === '1');
    const scene = this.scene;
    scene.background = new THREE.Color(night ? 0x16233d : 0xbcd8e6);
    scene.add(new THREE.HemisphereLight(night ? 0x40528a : 0xc4dbf2, night ? 0x141c22 : 0x6f7a4a, night ? 0.8 : 1.3));
    const sun = new THREE.DirectionalLight(night ? 0x8fa6e8 : 0xfff3e0, night ? 0.5 : 3.2);
    sun.position.set(14, 24, 9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 120 });
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.04;
    scene.add(sun, sun.target);
    windowGlow.value = night ? 1 : 0;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshLambertMaterial({ color: 0x7d9a55 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // The plans side by side along X, 6 m apart.
    const mirror = o.mirror === '1';
    let x = 0;
    for (const id of ids) {
      const base = buildingPlan(id);
      if (!base) continue;
      const p = mirror ? mirrorPlan(base) : base;
      const px = x + p.w / 2;
      const solid = buildingColliders(id, mirror, px, 0, 0, 0);
      if (!solid) continue;
      this.placed.push({ id, plan: p, x: px, y: 0, z: 0, rot: 0, mirror, boxes: solid.boxes });
      this.solids.push({ id, boxes: solid.boxes.length, decks: solid.decks.length, posts: solid.obstacles.length });
      x += p.w + 6;
      if (o.colliders === '1') {
        const line = (color: number) => new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85 });
        const show = (b: { x: number; z: number; hw: number; hd: number; rot: number; top: number }, bottom: number, color: number) => {
          const box = new THREE.Box3(new THREE.Vector3(-b.hw, bottom, -b.hd), new THREE.Vector3(b.hw, b.top, b.hd));
          const helper = new THREE.Box3Helper(box, color);
          (helper.material as THREE.Material).depthTest = false;
          const holder = new THREE.Group();
          holder.position.set(b.x, 0, b.z);
          holder.rotation.y = b.rot;
          holder.add(helper);
          scene.add(holder);
        };
        for (const b of solid.boxes) show(b, 0, 0xff3040);
        for (const d of solid.decks) show(d, d.top - 0.05, 0x3080ff);
        for (const ob of solid.obstacles) {
          const c = new THREE.LineLoop(new THREE.CircleGeometry(ob.r, 20).rotateX(-Math.PI / 2), line(0xffd000));
          c.position.set(ob.x, 0.05, ob.z);
          scene.add(c);
        }
      }
    }
    this.village = new Village(this.placed);
    scene.add(this.village.group);

    this.controls = new OrbitControls(this.camera, r.domElement);
    const width = Math.max(10, x - 6);
    this.camera.position.set(...(vec(o.cam) ?? [width / 2 - width * 0.35, 14 + width * 0.3, 18 + width * 0.6]));
    this.controls.target.set(...(vec(o.at) ?? [width / 2, 2, 0]));
    this.controls.update();
    this.resizer = new ResizeObserver(() => this.resize());
    this.resizer.observe(host);
    this.resize();

    this.cut = o.cut !== undefined && o.cut !== '' ? Number(o.cut) : null;
    tag.textContent = `${ids.join(', ')}${this.cut !== null ? `\ncut open above storey ${this.cut}` : ''}`;
    this.api = {
      /** The village's kit and every asset it asked for have loaded. */
      ready: () => this.ready(),
      plans: ids,
      /** The rules' walls, decks and posts of each plan, as counted here. */
      colliders: this.solids,
      cut: this.cut,
      night,
    };
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const hh = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, hh, false);
    this.camera.aspect = w / hh;
    this.camera.updateProjectionMatrix();
  }

  ready(): boolean {
    return this.village.ready && assetsReady();
  }

  frame(dt: number): void {
    const b = this.placed[0];
    if (this.cut !== null && b) this.village.locate(b.x, this.cut * STOREY + 0.1, b.z);
    this.village.lampLevel = this.night ? 1 : 0.6;
    const t = this.controls.target;
    this.village.update(Math.min(0.05, dt), [], { x: t.x, y: t.y, z: t.z });
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  numbers(): Array<{ heading: string; rows: Array<[string, string]> }> {
    return this.placed.map((p, i) => ({
      heading: label(p.id),
      rows: [
        ['Footprint', `${p.plan.w} × ${p.plan.d} m`],
        ['Storeys', String(p.plan.storeys.length)],
        ['Stairs', String(p.plan.stairs?.length ?? 0)],
        ['Furniture', String(p.plan.items?.length ?? 0)],
        ['Walls', String(this.solids[i].boxes)],
        ['Decks', String(this.solids[i].decks)],
        ['Posts', String(this.solids[i].posts)],
      ],
    }));
  }

  dispose(): void {
    windowGlow.value = 0;
    this.resizer.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

const yesNo = (no: string, yes: string) => [
  { value: '0', label: no },
  { value: '1', label: yes },
];

export const buildingsSubject: Subject = {
  id: 'buildings',
  name: 'Buildings',
  group: 'Galleries',
  blurb: 'The buildings you can walk into, as the game draws them',
  options: [
    {
      id: 'cut',
      label: 'Cut Open',
      value: '',
      choices: [
        { value: '', label: 'Whole' },
        { value: '0', label: 'Storey 0' },
        { value: '1', label: 'Storey 1' },
      ],
    },
    { id: 'colliders', label: "The Rules' Walls", value: '0', choices: yesNo('Hidden', 'Shown') },
    { id: 'night', label: 'Time', value: '0', choices: yesNo('Day', 'Night') },
    { id: 'mirror', label: 'Mirrored', value: '0', choices: yesNo('No', 'Yes') },
    { id: 'cam', label: 'Camera At', value: '', hint: 'x,y,z' },
    { id: 'at', label: 'Looking At', value: '', hint: 'x,y,z' },
  ],
  anims: (): AnimDef[] => [
    { id: 'all', label: 'Every Plan', group: 'Plans', frames: 0, fps: 60, loop: true, tag: String(buildingPlanIds().length) },
    ...buildingPlanIds().map((id) => {
      const p = buildingPlan(id)!;
      return { id, label: label(id), group: 'Plans', frames: 0, fps: 60, loop: true, tag: `${p.w}×${p.d} m` };
    }),
  ],
  gallery: (host, plan, o) => new BuildingsGallery(host, plan, o),
  source: () => ({
    system:
      "Plans, not models (shared/buildings.json, src/content/buildings.ts): walls written as strings of the kit's 2 m modules (door, window, arch...) storey by storey, 3 m a storey, stairs, a roof and furniture, laid out from Quaternius' Medieval Village MegaKit by assemble.ts and drawn by village.ts in a few merged meshes, the house you are in cut open above your storey. The rules wall, floor and stair-step each one from the same plan (src/sim/zone/buildings.ts), shown here over it.",
    files: [
      { path: 'shared/buildings.json', what: 'the plans and the furniture catalogue' },
      { path: 'src/content/buildings.ts', what: 'reading plans: modules, openings, stairwells, mirroring' },
      { path: 'src/render/village/assemble.ts', what: "laying out the kit's pieces" },
      { path: 'src/render/village/village.ts', what: 'drawing the town: cut-away, doors, lamps' },
      { path: 'src/render/village/furnish.ts', what: 'furniture, rugs, straw, fire' },
      { path: 'src/sim/zone/buildings.ts', what: "the rules' walls, decks and posts" },
    ],
    conventions:
      'A plan faces +Z with its middle at its origin; storey 0 is the ground floor. Red boxes are walls, blue decks (floors, treads), yellow rings posts and furniture.',
    checks: [
      { command: 'npx vitest run tests/unit/buildings.test.ts', what: 'plans fit their footprints and the kit; doorways open' },
      { command: 'npx playwright test tests/integration/village.spec.ts', what: 'walking in, the cut-away, the stairs, in the game' },
      { command: 'npx playwright test tests/integration/buildings.spec.ts', what: 'every plan in this gallery, cut open, walled, by night' },
    ],
  }),
  animSource: (plan) => (plan === 'all' ? 'every plan in shared/buildings.json' : `plan '${plan}' in shared/buildings.json`),
};
