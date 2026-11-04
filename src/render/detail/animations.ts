import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Hero, traceSwing } from '../character';
import { pose, type PoseFeedback, type PoseInput } from '../../content/pose';
import { HERO_BOW, HERO_TRAIL_EDGES, HERO_WEAPONS } from '../../content/creatures/hero';
import { GLIDERS, MOUNTS, VEHICLES } from '../../content/vehicles';
import { buildGlider, buildMount, buildVehicle } from '../models';
import { gliderGrip } from '../models/gliders';
import type { Holds } from '../models/vehicles';
import { SCENARIOS, scenario, type Moment, type Scenario } from './scenarios';

// The hero's animations, one at a time, for looking at and for tests to measure.
//   /animations.html                   pick one on the left; drag to orbit, wheel to zoom
//   ?anim=<id>                         start on that one (ids in src/render/detail/scenarios.ts)
//   &speed=0.25                        slow motion
//   &view=side|front|back|three        camera
// The floor slides under the hero at the speed it is moving, so a foot that is planted should
// stay put on the grid. window.__anims draws contact sheets and reports where the joints are.

const STEP = 1 / 60;
const TAU = Math.PI * 2;
const params = new URLSearchParams(location.search);

// ---------- scene ----------

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fc9dc);
scene.add(new THREE.HemisphereLight(0xe4f2ff, 0x5d6b4a, 1.3));
const sun = new THREE.DirectionalLight(0xfff2dc, 2.4);
sun.position.set(-4, 9, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -12;
sun.shadow.camera.right = 12;
sun.shadow.camera.top = 12;
sun.shadow.camera.bottom = -12;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

function gridTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#8fa36b';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#86995f';
  g.fillRect(0, 0, 64, 64);
  g.fillRect(64, 64, 64, 64);
  g.strokeStyle = 'rgba(40, 50, 30, 0.35)';
  g.lineWidth = 2;
  g.strokeRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const FLOOR = 40;
const floorTex = gridTexture();
floorTex.repeat.set(FLOOR, FLOOR); // one tile per metre, two checks a tile
const floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR, FLOOR).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: floorTex }));
floor.receiveShadow = true;
scene.add(floor);
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(FLOOR, FLOOR).rotateX(-Math.PI / 2),
  new THREE.MeshLambertMaterial({ color: 0x3f8fb5, transparent: true, opacity: 0.55, depthWrite: false }),
);
water.renderOrder = 5;
water.visible = false;
scene.add(water);

const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 400);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 400);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.95, 0);

function resize(): void {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

type View = 'side' | 'front' | 'back' | 'three';
/** Where the camera sits for each view, looking at the middle of the body. */
const VIEW_DIR: Record<View, THREE.Vector3> = {
  side: new THREE.Vector3(-1, 0.12, 0), // from the hero's right, so it faces right on screen
  front: new THREE.Vector3(0, 0.1, 1),
  back: new THREE.Vector3(0, 0.42, -1), // roughly the game's follow camera
  three: new THREE.Vector3(-0.75, 0.3, 0.75),
};
function placeCamera(view: View, distance = 5.2, target = new THREE.Vector3(0, 0.95, 0)): void {
  const d = VIEW_DIR[view].clone().normalize();
  camera.position.copy(target).addScaledVector(d, distance);
  controls.target.copy(target);
  controls.update();
}

// ---------- props: what the hero rides, flies or sits in ----------

interface Prop {
  root: THREE.Object3D;
  animate(dt: number, m: Moment, input: PoseInput): void;
  water?: number;
  /** What the first seat's hands hold and feet rest on, and which seat pose that is. */
  holds?: Holds;
  driver?: string;
}

function makeProp(kind: Scenario['prop'], hero: Hero): Prop | null {
  if (!kind) return null;
  if (kind === 'glider') {
    const g = buildGlider(GLIDERS[0]);
    hero.root.add(g.root);
    return {
      root: g.root,
      animate: (dt, m, input) =>
        g.animate(dt, { bank: input.bank * 0.6, pitch: Math.max(-0.35, Math.min(0.3, (input.rise * 9.2) / 12)), speed: m.speed }),
    };
  }
  if (kind === 'horse') {
    const def = MOUNTS.find((x) => x.id === 'horse')!;
    const h = buildMount(def);
    hero.root.add(h.root);
    return { root: h.root, animate: (dt, m) => h.animate(dt, { speed: m.speed, grounded: true }), holds: h.holds, driver: 'ride' };
  }
  const id = kind === 'cart' ? 'farmCart' : kind;
  const def = VEHICLES.find((x) => x.id === id)!;
  const v = buildVehicle(def);
  let t = 0;
  hero.root.add(v.root);
  const boat = def.class === 'boat';
  return {
    root: v.root,
    water: boat ? 0 : undefined,
    holds: v.holds,
    driver: def.seats[0].pose,
    animate: (dt, m, input) => {
      t += dt;
      v.animate(dt, { speed: m.speed, steer: input.bank, throttle: input.effort, sail: 0.8, boom: 0.3, time: t });
    },
  };
}

/**
 * Puts a ridden thing so the seat the hero uses sits on the hero's origin, as the game does, and
 * returns how high that seat is: the hero is lifted by it so the vehicle stands on the floor.
 */
function seatProp(prop: Prop, kind: Scenario['prop'], input: PoseInput): number {
  if (!kind || kind === 'glider') return 0;
  const def = kind === 'horse' ? MOUNTS.find((x) => x.id === 'horse')! : VEHICLES.find((x) => x.id === (kind === 'cart' ? 'farmCart' : kind))!;
  const seat = def.seats.find((s) => s.pose === input.travel) ?? def.seats[0];
  prop.root.position.set(-seat.x, -seat.y, -seat.z);
  return seat.y;
}

// ---------- one hero playing one scenario ----------

class Take {
  readonly hero = new Hero();
  readonly prop: Prop | null;
  frame = 0;
  distance = 0;
  /** How far the hero has travelled over the floor, metres (x left, z ahead). */
  travelled: [number, number] = [0, 0];
  /** Which way the hero faces over the floor, radians. */
  facing = 0;
  last: Moment | null = null;
  input: PoseInput = pose();
  fb: PoseFeedback | null = null;

  constructor(
    readonly s: Scenario,
    readonly weapon: number,
  ) {
    this.prop = makeProp(s.prop, this.hero);
  }

  step(): void {
    const m = this.s.at(this.frame);
    const input = pose({ time: this.frame * STEP, ...m.input, weapon: this.s.weapon ?? this.weapon });
    if (input.run > 0) this.distance += Math.abs(m.speed) * STEP;
    this.facing = m.facing ?? 0;
    const h = this.facing + (m.input.heading ?? 0);
    this.travelled[0] += m.speed * Math.sin(h) * STEP;
    this.travelled[1] += m.speed * Math.cos(h) * STEP;
    // The hero really moves over the floor, as in the game, so a planted foot stays put on it.
    const seat = this.prop ? seatProp(this.prop, this.s.prop, input) : 0;
    this.hero.root.position.set(this.travelled[0], (m.lift ?? 0) + seat, this.travelled[1]);
    this.hero.root.rotation.y = this.facing;
    // The vehicle moves first (its wheel turns, its oars sweep), then the hero takes hold of it.
    this.prop?.animate(STEP, m, input);
    this.hero.seatHolds = this.prop?.holds && input.travel === this.prop.driver ? this.prop.holds : null;
    this.fb = this.hero.drive(input, this.distance, STEP);
    this.last = m;
    this.input = input;
    this.frame++;
  }

  /** Plays from the start up to (and including) a frame, so transitions come out as in play. */
  seek(frame: number): void {
    while (this.frame <= frame) this.step();
  }

  dispose(): void {
    this.hero.root.removeFromParent();
  }
}

// ---------- playback ----------

let take: Take | null = null;
let speed = Number(params.get('speed')) || 1;
let paused = false;
let view: View = (params.get('view') as View) || 'three';
let weapon = 0;
let acc = 0;
const label = document.getElementById('label')!;
const side = document.getElementById('side')!;
const bar = document.getElementById('bar')!;

function showFloor(s: Scenario, t: Take): void {
  const swim = s.id === 'swim' || s.id === 'tread';
  const boat = t.prop?.water !== undefined;
  floor.visible = !boat;
  water.visible = swim || boat;
  water.position.y = swim ? 1.2 : (t.prop?.water ?? 0);
  floor.position.y = swim ? -1.5 : 0;
}

function play(id: string): void {
  const s = scenario(id);
  take?.dispose();
  take = new Take(s, weapon);
  scene.add(take.hero.root);
  followX = followZ = 0;
  floor.position.set(0, floor.position.y, 0);
  water.position.set(0, water.position.y, 0);
  showFloor(s, take);
  for (const b of side.querySelectorAll('button')) b.classList.toggle('on', b.dataset.id === id);
  const far = s.prop === 'sloop' ? 9 : s.prop ? 6.5 : 5.2;
  placeCamera(view, far, new THREE.Vector3(0, s.prop === 'glider' ? 1.5 : 0.95, 0));
  history.replaceState(null, '', `?anim=${id}${speed !== 1 ? `&speed=${speed}` : ''}${view !== 'three' ? `&view=${view}` : ''}`);
}

let followX = 0;
let followZ = 0;
function tick(): void {
  if (!take) return;
  take.step();
  // The camera goes along with the hero, and the floor and water keep up underneath (whole tiles,
  // so the checks stay where they are on the ground).
  const at = take.hero.root.position;
  camera.position.x += at.x - followX;
  camera.position.z += at.z - followZ;
  controls.target.x += at.x - followX;
  controls.target.z += at.z - followZ;
  followX = at.x;
  followZ = at.z;
  floor.position.set(Math.round(at.x), floor.position.y, Math.round(at.z));
  water.position.set(Math.round(at.x), water.position.y, Math.round(at.z));
  if (take.prop?.water === undefined) floor.position.y = take.s.id === 'swim' || take.s.id === 'tread' ? -1.5 : 0;
  const m = take.last!;
  const i = take.input;
  const state = [
    i.attackIndex >= 0 ? `swing ${i.attackIndex + 1} f${i.attackFrame}` : '',
    i.actionId >= 0 ? `action f${i.actionFrame}` : '',
    i.castAbility >= 0 ? `cast f${i.castFrame}` : '',
    !i.grounded ? `air rise ${i.rise.toFixed(2)}${i.flipFrame >= 0 ? ' flip' : ''}` : '',
    i.landFrame < 20 ? `land f${i.landFrame}` : '',
    i.run > 0 ? `run ${i.run.toFixed(2)}` : '',
    i.travel ? i.travel : '',
  ]
    .filter(Boolean)
    .join('  ');
  label.textContent = `${take.s.label}   frame ${(take.frame - 1) % take.s.frames}/${take.s.frames}   ${m.speed.toFixed(1)} m/s   ${state}`;
}

let lastT = performance.now();
function loop(now: number): void {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (!sheetMode && take && !paused) {
    acc += dt * speed;
    while (acc >= STEP) {
      tick();
      acc -= STEP;
    }
  }
  if (!sheetMode) {
    controls.update();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(loop);
}

// ---------- the side panel ----------

function buildUi(): void {
  let group = '';
  for (const s of SCENARIOS) {
    if (s.group !== group) {
      group = s.group;
      const h = document.createElement('h3');
      h.textContent = group;
      side.appendChild(h);
    }
    const b = document.createElement('button');
    b.textContent = s.label;
    b.dataset.id = s.id;
    b.onclick = () => play(s.id);
    side.appendChild(b);
  }
  const select = (name: string, options: Array<[string, string]>, value: string, on: (v: string) => void) => {
    const el = document.createElement('select');
    el.title = name;
    for (const [v, text] of options) el.add(new Option(text, v, false, v === value));
    el.onchange = () => on(el.value);
    bar.appendChild(el);
  };
  select('speed', [['1', '1x'], ['0.5', '1/2x'], ['0.25', '1/4x'], ['0.1', '1/10x']], String(speed), (v) => {
    speed = Number(v);
    if (take) play(take.s.id);
  });
  select('camera', [['three', 'three-quarter'], ['side', 'side'], ['front', 'front'], ['back', 'behind']], view, (v) => {
    view = v as View;
    if (take) play(take.s.id);
  });
  select('weapon', [['0', 'sword'], ['1', 'club'], ['2', 'staff'], ['3', 'bow']], '0', (v) => {
    weapon = Number(v);
    if (take) play(take.s.id);
  });
  const button = (text: string, on: () => void) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.onclick = on;
    bar.appendChild(b);
    return b;
  };
  const pauseButton = button('pause', () => {
    paused = !paused;
    pauseButton.textContent = paused ? 'play' : 'pause';
  });
  button('step', () => {
    paused = true;
    pauseButton.textContent = 'play';
    tick();
  });
  button('restart', () => take && play(take.s.id));
}

// ---------- contact sheets and measurements, for tests and screenshots ----------

let sheetMode = false;
let sheetTakes: Take[] = [];

function clearSheet(): void {
  for (const t of sheetTakes) t.dispose();
  sheetTakes = [];
}

const api = {
  ready: true,
  list: () => SCENARIOS.map((s) => ({ id: s.id, group: s.group, label: s.label, frames: s.frames })),
  play(id: string) {
    sheetMode = false;
    document.body.classList.remove('sheet');
    clearSheet();
    play(id);
  },

  /**
   * Heroes side by side, each one the same scenario played up to a different frame: a whole
   * motion in one picture. Frames default to `count` evenly spread over [from, to).
   */
  sheet(
    id: string,
    opts: { frames?: number[]; count?: number; from?: number; to?: number; view?: View; spacing?: number; weapon?: number; height?: number } = {},
  ) {
    sheetMode = true;
    document.body.classList.add('sheet');
    take?.dispose();
    take = null;
    clearSheet();
    const s = scenario(id);
    const count = opts.count ?? 8;
    const from = opts.from ?? 0;
    const to = opts.to ?? s.frames;
    const frames = opts.frames ?? Array.from({ length: count }, (_, i) => Math.round(from + ((to - from) * i) / count));
    const v: View = opts.view ?? 'side';
    const spacing = opts.spacing ?? (s.prop ? 3.4 : 1.35);
    const dir = VIEW_DIR[v].clone().normalize();
    // Left to right on screen, first frame first.
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
    frames.forEach((f, i) => {
      const t = new Take(s, opts.weapon ?? s.weapon ?? 0);
      t.seek(f);
      const offset = right.clone().multiplyScalar((i - (frames.length - 1) / 2) * spacing);
      t.hero.root.position.set(offset.x, t.hero.root.position.y, offset.z);
      scene.add(t.hero.root);
      sheetTakes.push(t);
    });
    const swim = id === 'swim' || id === 'tread';
    const boat = sheetTakes[0]?.prop?.water !== undefined;
    floor.visible = !boat;
    floor.position.y = swim ? -1.5 : 0;
    floor.position.set(0, floor.position.y, 0);
    water.position.set(0, water.position.y, 0);
    water.visible = swim || boat;
    water.position.y = swim ? 1.2 : (sheetTakes[0]?.prop?.water ?? 0);

    // An orthographic camera that fits the row.
    const w = window.innerWidth;
    const h = window.innerHeight;
    const halfW = (frames.length * spacing) / 2 + 0.2;
    const halfH = Math.max(halfW * (h / w), (opts.height ?? (s.prop ? 3.6 : 2.3)) / 2);
    ortho.left = -halfH * (w / h);
    ortho.right = halfH * (w / h);
    ortho.top = halfH;
    ortho.bottom = -halfH;
    ortho.updateProjectionMatrix();
    const seatY = sheetTakes[0] ? sheetTakes[0].hero.root.position.y - (sheetTakes[0].last?.lift ?? 0) : 0;
    const mid = new THREE.Vector3(0, s.prop === 'glider' ? 1.6 : seatY > 0 ? seatY + 0.2 : 0.95, 0);
    ortho.position.copy(mid).addScaledVector(dir, 30);
    ortho.lookAt(mid);
    renderer.render(scene, ortho);
    return { frames, draws: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  },

  /** Root-space position of every joint of the hero on a frame of a scenario. */
  joints(id: string, frame: number, weaponOverride?: number) {
    const t = new Take(scenario(id), weaponOverride ?? 0);
    t.seek(frame);
    const rig = t.hero.detail;
    t.hero.root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(t.hero.root.matrixWorld).invert();
    const out: Record<string, number[]> = {};
    for (const j of rig.def.joints) {
      const p = new THREE.Vector3().setFromMatrixPosition(rig.joint(j.name).matrixWorld).applyMatrix4(inv);
      out[j.name] = [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)];
    }
    return { joints: out, speed: t.last?.speed ?? 0, lift: t.last?.lift ?? 0 };
  },

  /** Every frame of a scenario: joints in root space plus how far the floor has moved. */
  track(id: string, names: string[], weaponOverride?: number) {
    const t = new Take(scenario(id), weaponOverride ?? 0);
    const rig = t.hero.detail;
    const out: Array<{ frame: number; travelled: [number, number]; facing: number; lift: number; standing: boolean; flip: number; action: number; stun: number; joints: Record<string, number[]> }> = [];
    const inv = new THREE.Matrix4();
    for (let f = 0; f < t.s.frames; f++) {
      t.step();
      t.hero.root.updateMatrixWorld(true);
      inv.copy(t.hero.root.matrixWorld).invert();
      const joints: Record<string, number[]> = {};
      for (const n of names) {
        // 'footL@0,-0.08,0.17' is a point in that joint's own space (here the ball of the foot).
        const [joint, at] = n.split('@');
        const local = at ? new THREE.Vector3(...at.split(',').map(Number)) : new THREE.Vector3();
        const p = local.applyMatrix4(rig.joint(joint).matrixWorld).applyMatrix4(inv);
        joints[n] = [p.x, p.y, p.z];
      }
      // On its feet: on the ground and not rolling or sliding, when planted feet must hold.
      const standing = t.input.grounded && t.input.actionId < 0 && !t.input.travel && !t.input.down;
      out.push({
        frame: f,
        travelled: [t.travelled[0], t.travelled[1]],
        facing: t.facing,
        lift: t.last?.lift ?? 0,
        standing,
        flip: t.input.flipFrame,
        action: t.input.actionId >= 0 ? t.input.actionFrame : -1,
        stun: t.input.stunned ? t.input.stunFrame : -1,
        joints,
      });
    }
    t.dispose();
    return out;
  },

  /** Lowest point of the whole body (boots included) over a scenario, for "never in the floor". */
  /**
   * Lowest point of the body over a scenario, and of what it carries, for "never in the floor":
   * metres above the ground, and the frame it happened on.
   */
  lowest(id: string, weaponOverride?: number) {
    const t = new Take(scenario(id), weaponOverride ?? 0);
    const rig = t.hero.detail;
    const out = { body: { low: Infinity, frame: -1 }, weapon: { low: Infinity, frame: -1 } };
    const box = new THREE.Box3();
    const corner = new THREE.Vector3();
    const e = new THREE.Matrix4();
    for (let f = 0; f < t.s.frames; f++) {
      t.step();
      t.hero.root.updateMatrixWorld(true);
      const ground = t.hero.root.position.y - (t.last?.lift ?? 0);
      // The body: each rounded box and ball exactly, from the rig's own part list.
      let low = Infinity;
      for (const part of rig.def.parts) {
        const m = e.copy(rig.joint(part.joint).matrixWorld).elements;
        const [px, py, pz] = part.pos ?? [0, 0, 0];
        const cy = m[1] * px + m[5] * py + m[9] * pz + m[13];
        const sh = part.shape;
        if (sh.kind === 'box') {
          const r = Math.min(sh.r ?? 0.05, sh.w / 2, sh.h / 2, sh.d / 2);
          low = Math.min(low, cy - (Math.abs(m[1]) * (sh.w / 2 - r) + Math.abs(m[5]) * (sh.h / 2 - r) + Math.abs(m[9]) * (sh.d / 2 - r)) - r);
        } else if (sh.kind === 'sphere') low = Math.min(low, cy - sh.r);
      }
      if (low - ground < out.body.low) {
        out.body.low = +(low - ground).toFixed(4);
        out.body.frame = f;
      }
      // What it carries: the corners of each piece's box (a touch generous for round things).
      for (const b of rig.built) {
        if (b.mesh.parent === rig.joint(b.joint)) continue;
        let shown = true;
        for (let n: THREE.Object3D | null = b.mesh; n; n = n.parent) if (!n.visible) shown = false;
        if (!shown) continue;
        b.mesh.geometry.computeBoundingBox();
        box.copy(b.mesh.geometry.boundingBox!);
        for (let c = 0; c < 8; c++) {
          corner.set(c & 1 ? box.max.x : box.min.x, c & 2 ? box.max.y : box.min.y, c & 4 ? box.max.z : box.min.z).applyMatrix4(b.mesh.matrixWorld);
          if (corner.y - ground < out.weapon.low) {
            out.weapon.low = +(corner.y - ground).toFixed(4);
            out.weapon.frame = f;
          }
        }
      }
    }
    t.dispose();
    return out;
  },

  /** Every frame's knee and elbow hinge angles: knees fold +, elbows fold -. */
  hinges(id: string) {
    const t = new Take(scenario(id), 0);
    const b = t.hero.detail;
    const out = { knee: [Infinity, -Infinity], elbow: [Infinity, -Infinity] };
    for (let f = 0; f < t.s.frames; f++) {
      t.step();
      for (const n of ['kneeL', 'kneeR']) {
        const x = new THREE.Euler().setFromQuaternion(b.joint(n).quaternion).x;
        out.knee = [Math.min(out.knee[0], x), Math.max(out.knee[1], x)];
      }
      for (const n of ['elbowL', 'elbowR']) {
        const x = new THREE.Euler().setFromQuaternion(b.joint(n).quaternion).x;
        out.elbow = [Math.min(out.elbow[0], x), Math.max(out.elbow[1], x)];
      }
    }
    t.dispose();
    return out;
  },

  /** How far the trail's leading edge is from the blade's tip, at worst, while a trail shows. */
  trailGap(id: string) {
    const t = new Take(scenario(id), 0);
    const rig = t.hero.detail;
    let worst = 0;
    let shown = 0;
    const inv = new THREE.Matrix4();
    for (let f = 0; f < t.s.frames; f++) {
      t.step();
      const tr = t.fb?.trail;
      const i = t.input;
      if (!tr || !i.step || tr.head >= 1) continue;
      const edges = traceSwing(i);
      const edge = HERO_TRAIL_EDGES[HERO_WEAPONS[i.weapon] ?? ''];
      if (!edges || !edge) continue;
      t.hero.root.updateMatrixWorld(true);
      inv.copy(t.hero.root.matrixWorld).invert();
      const tip = new THREE.Vector3(...edge.outer).applyMatrix4(rig.joint('handR').matrixWorld).applyMatrix4(inv);
      const at = tr.head * (edges.length - 1);
      const k = Math.min(edges.length - 2, Math.floor(at));
      const on = new THREE.Vector3().lerpVectors(edges[k][1], edges[k + 1][1], at - k);
      worst = Math.max(worst, tip.distanceTo(on));
      shown++;
    }
    t.dispose();
    return { worst: +worst.toFixed(4), shown };
  },

  /** On a frame of a bow shot: how far the string's nock is from the drawing hand, and the draw. */
  nockGap(id: string, frame: number) {
    const t = new Take(scenario(id), 3);
    t.seek(frame);
    const rig = t.hero.detail;
    t.hero.root.updateMatrixWorld(true);
    const bow = rig.joint('handL');
    const hand = new THREE.Vector3().setFromMatrixPosition(rig.joint('handR').matrixWorld);
    const nock = rig.built.find((b) => b.mat === 'string')!.mesh.getWorldPosition(new THREE.Vector3());
    const grip = new THREE.Vector3().setFromMatrixPosition(bow.matrixWorld);
    const out = { gap: +hand.distanceTo(nock).toFixed(4), drawn: +nock.distanceTo(grip).toFixed(4), rest: HERO_BOW.nock[1], draw: t.fb?.draw ?? 0 };
    t.dispose();
    return out;
  },

  /** The biggest jump any of these joints makes between two frames, metres, and where. */
  jumps(id: string, names: string[]) {
    const rows = api.track(id, names);
    let worst = 0;
    let at = -1;
    let joint = '';
    for (let f = 1; f < rows.length; f++) {
      for (const n of names) {
        const a = rows[f - 1].joints[n];
        const b = rows[f].joints[n];
        const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        if (d > worst) {
          worst = d;
          at = f;
          joint = n;
        }
      }
    }
    return { worst: +worst.toFixed(4), frame: at, joint };
  },

  /** Debugging the foot hold: per frame, each foot's plant weight, held offset and ball on the floor. */
  feet(id: string, from: number, to: number) {
    const t = new Take(scenario(id), 0);
    const rig = t.hero.detail;
    const rows: string[] = [];
    const v = new THREE.Vector3();
    for (let f = 0; f <= to; f++) {
      t.step();
      if (f < from) continue;
      t.hero.root.updateMatrixWorld(true);
      const holds = (t.hero as unknown as { holds: Record<string, { fix: THREE.Vector3; stepping: number }> }).holds;
      const cell = (n: 'L' | 'R', i: number) => {
        v.set(0, -0.08, 0.17).applyMatrix4(rig.joint('foot' + n).matrixWorld);
        const h = holds[n];
        return n + ' plant ' + (t.fb?.plant[i] ?? 0).toFixed(2) + ' fix ' + h.fix.x.toFixed(3) + ',' + h.fix.z.toFixed(3) + (h.stepping ? ' step ' + h.stepping.toFixed(2) : '') + ' ball ' + v.x.toFixed(3) + ',' + v.y.toFixed(3) + ',' + v.z.toFixed(3);
      };
      rows.push(f + ' run ' + t.input.run.toFixed(2) + ' stride ' + t.input.stride.toFixed(2) + ' | ' + cell('L', 0) + ' | ' + cell('R', 1));
    }
    t.dispose();
    return rows.join(String.fromCharCode(10));
  },

  /** Gliding: how far each hand is from its grip on the control bar, at worst, over the film. */
  glideGap(id = 'glide') {
    const t = new Take(scenario(id), 0);
    const rig = t.hero.detail;
    let worst = 0;
    const inv = new THREE.Matrix4();
    const grip = new THREE.Vector3();
    for (let f = 0; f < t.s.frames; f++) {
      t.step();
      t.hero.root.updateMatrixWorld(true);
      inv.copy(t.hero.root.matrixWorld).invert();
      const bank = Math.max(-0.9, Math.min(0.9, t.input.bank * 0.6));
      const pitch = Math.max(-0.35, Math.min(0.3, (t.input.rise * 9.2) / 12));
      for (const [n, side] of [['handL', 1], ['handR', -1]] as const) {
        const hand = new THREE.Vector3().setFromMatrixPosition(rig.joint(n).matrixWorld).applyMatrix4(inv);
        worst = Math.max(worst, hand.distanceTo(gliderGrip(side, bank, pitch, grip)));
      }
    }
    t.dispose();
    return +worst.toFixed(4);
  },

  /**
   * Seated in a vehicle's first seat: how far each hand gets, at worst, from what the vehicle gives
   * it to hold (its wheel's rim, its oars' handles) over the film, and where the feet are against
   * the footrest (null when the vehicle has none).
   */
  holdGap(id: string) {
    const t = new Take(scenario(id), 0);
    const rig = t.hero.detail;
    let hands = 0;
    let feet: number | null = null;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let f = 0; f < t.s.frames; f++) {
      t.step();
      const h = t.prop?.holds;
      if (!h || (!h.hands && !h.feet) || t.input.travel !== t.prop?.driver) continue;
      t.hero.root.updateMatrixWorld(true);
      h.hands?.forEach((o, i) => {
        rig.joint(i === 0 ? 'handL' : 'handR').getWorldPosition(a);
        hands = Math.max(hands, a.distanceTo(o.getWorldPosition(b)));
      });
      if (h.feet) {
        // How far the soles are above the footrest (each foot's own, a pair like stirrups): 0
        // resting on it, more hanging over it.
        for (const [i, n] of ['footL', 'footR'].entries()) {
          const rest = Array.isArray(h.feet) ? h.feet[i] : h.feet;
          rest.getWorldPosition(b);
          rig.joint(n).getWorldPosition(a);
          feet = Math.max(feet ?? 0, a.y - 0.08 - b.y);
        }
      }
    }
    t.dispose();
    return { hands: +hands.toFixed(4), feet: feet === null ? null : +feet.toFixed(3) };
  },

  /**
   * How squarely a vehicle's steering wheel faces the driver over a film, at worst: the cosine
   * between the way its face looks (back up its column) and the way from it to the driver's neck.
   * 1 is straight at them; null when the vehicle has no wheel.
   */
  wheelFacing(id: string) {
    const t = new Take(scenario(id), 0);
    let worst: number | null = null;
    const at = new THREE.Vector3();
    const to = new THREE.Vector3();
    const face = new THREE.Vector3();
    for (let f = 0; f < t.s.frames; f++) {
      t.step();
      const wheel = t.prop?.root.getObjectByName('steeringWheel');
      if (!wheel) break;
      t.hero.root.updateMatrixWorld(true);
      wheel.getWorldPosition(at);
      t.hero.detail.joint('neck').getWorldPosition(to);
      // The wheel's +Z runs down its column, away from the driver (vehicles.ts steeringWheel()).
      face.set(0, 0, -1).transformDirection(wheel.matrixWorld);
      worst = Math.min(worst ?? 1, face.dot(to.sub(at).normalize()));
    }
    t.dispose();
    return worst === null ? null : +worst.toFixed(3);
  },

  /**
   * The weapon's far end (a blade's tip, the staff's orb, the bow's top) frame by frame, in the
   * world, the stow on that frame, and whether the weapon hangs from a hand: for drawing and
   * sheathing, which must never make it jump.
   */
  weaponTrack(id: string, weapon = 0) {
    const t = new Take(scenario(id), weapon);
    const rig = t.hero.detail;
    const name = HERO_WEAPONS[weapon];
    const far: Record<string, [number, number, number]> = { sword: [0, -1.1, 0], club: [0, -0.6, 0], staff: [0, -1.2, 0], bow: [0, 0.275, 0.476] };
    const g = rig.attachment(name);
    const out: Array<{ frame: number; stow: number; inHand: boolean; tip: number[] }> = [];
    for (let f = 0; f < t.s.frames; f++) {
      t.step();
      t.hero.root.updateMatrixWorld(true);
      const p = new THREE.Vector3(...far[name]).applyMatrix4(g.matrixWorld);
      out.push({ frame: f, stow: t.input.stow, inHand: g.parent === rig.joint('handR') || g.parent === rig.joint('handL'), tip: [p.x, p.y, p.z] });
    }
    t.dispose();
    return out;
  },

  /** What posing one hero costs, microseconds a frame, once it's built and warmed up. */
  cost(id: string, frames = 600) {
    const t = new Take(scenario(id), 0);
    for (let i = 0; i < 60; i++) t.step();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) t.step();
    const us = ((performance.now() - t0) / frames) * 1000;
    t.dispose();
    return +us.toFixed(1);
  },
};

(window as unknown as { __anims: typeof api }).__anims = api;

buildUi();
play(params.get('anim') ?? 'run');
requestAnimationFrame(loop);
void TAU;
