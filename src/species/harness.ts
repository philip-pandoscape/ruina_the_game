import * as THREE from 'three';
import { SpeciesCrowd } from './crowd';
import { getSpecies, speciesIds } from './registry';
import { bindWorlds } from './pose';
import { MATRIX_STRIDE, clipByName, type SpeciesDef } from './types';

// A bench for one species at a time. Every number a test might assert on comes out of here, and
// so does every picture: pose a clip, read the joints, draw a crowd of them, measure the cost.
// Adding a monster means registering it and pointing this at it - no new harness per creature.

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1b20);
scene.add(new THREE.HemisphereLight(0xcfd8ff, 0x2a2f3a, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(3, 6, 4);
scene.add(key);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x23262e }),
);
ground.position.y = -0.001;
scene.add(ground);
const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 600);

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const label = document.getElementById('label')!;
let crowd: SpeciesCrowd | null = null;
let species: SpeciesDef | null = null;
let playing = false;
let playClip = 0;
let playStart = performance.now();

function teardown() {
  if (!crowd) return;
  scene.remove(crowd.group);
  crowd.dispose();
  crowd = null;
}

function render() {
  renderer.render(scene, camera);
}

/** Model-space translation of every joint on a given frame, straight out of the baked clip. */
function jointPositions(def: SpeciesDef, clipName: string, frame: number): number[][] {
  const clip = clipByName(def, clipName);
  if (!clip) throw new Error(`species ${def.id} has no clip "${clipName}"`);
  const f = Math.max(0, Math.min(frame, clip.frames - 1));
  const n = def.joints.length;
  const out: number[][] = [];
  for (let j = 0; j < n; j++) {
    const at = (f * n + j) * MATRIX_STRIDE;
    // The pose matrix maps bind space to posed space; the bind-space joint origin rides with it.
    out.push([clip.matrices[at + 3], clip.matrices[at + 7], clip.matrices[at + 11]]);
  }
  return out;
}

/** Where the proxy's corners end up on a frame: the silhouette a test can assert on. */
function posedBounds(def: SpeciesDef, clipName: string, frame: number) {
  const clip = clipByName(def, clipName);
  if (!clip) throw new Error(`species ${def.id} has no clip "${clipName}"`);
  const f = Math.max(0, Math.min(frame, clip.frames - 1));
  const n = def.joints.length;
  const box = new THREE.Box3();
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  for (const b of def.proxy) {
    const at = (f * n + b.joint) * MATRIX_STRIDE;
    const e = clip.matrices;
    m.set(
      e[at + 0], e[at + 1], e[at + 2], e[at + 3],
      e[at + 4], e[at + 5], e[at + 6], e[at + 7],
      e[at + 8], e[at + 9], e[at + 10], e[at + 11],
      0, 0, 0, 1,
    );
    const q = new THREE.Quaternion(...b.rot);
    for (let c = 0; c < 8; c++) {
      v.set(
        (c & 1 ? 0.5 : -0.5) * b.size[0],
        (c & 2 ? 0.5 : -0.5) * b.size[1],
        (c & 4 ? 0.5 : -0.5) * b.size[2],
      ).applyQuaternion(q).add(new THREE.Vector3(...b.pos)).applyMatrix4(m);
      box.expandByPoint(v);
    }
  }
  const size = box.getSize(new THREE.Vector3());
  return {
    min: [box.min.x, box.min.y, box.min.z].map((x) => +x.toFixed(4)),
    max: [box.max.x, box.max.y, box.max.z].map((x) => +x.toFixed(4)),
    size: [size.x, size.y, size.z].map((x) => +x.toFixed(4)),
  };
}

const api = {
  list: () => speciesIds(),

  /** Loads a species and builds a crowd of `capacity`, returning everything worth asserting on. */
  load(id: string, capacity = 1, opts: { smooth?: boolean; outlines?: boolean } = {}) {
    teardown();
    species = getSpecies(id);
    crowd = new SpeciesCrowd(species, capacity, { smooth: opts.smooth, outlines: opts.outlines });
    scene.add(crowd.group);
    crowd.setCount(0);
    label.textContent = `${id}  joints=${species.joints.length}  boxes=${species.proxy.length}  tris=${crowd.trianglesPerInstance}`;
    return {
      id,
      joints: species.joints.length,
      jointNames: species.joints.map((j) => j.name),
      boxes: species.proxy.length,
      triangles: crowd.trianglesPerInstance,
      height: +species.height.toFixed(4),
      clips: species.clips.map((c) => ({ name: c.name, frames: c.frames, fps: c.fps, loop: c.loop })),
    };
  },

  /** One instance, framed, on a given clip and time. */
  solo(clipName = '', seconds = 0) {
    if (!crowd || !species) throw new Error('load() first');
    const idx = Math.max(0, species.clips.findIndex((c) => c.name === clipName));
    crowd.setCount(1);
    crowd.place(0, 0, 0, 0, 0);
    crowd.animate(0, idx, seconds, 0);
    crowd.flush();
    // Frame on the posed silhouette, not on height: a quadruped is long before it is tall.
    const clip = species.clips[idx];
    const b = posedBounds(species, clip.name, Math.round(seconds * clip.fps) % clip.frames);
    const reach = Math.max(b.size[0], b.size[1], b.size[2], 0.4);
    const mid = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    camera.position.set(mid[0] + reach * 1.1, mid[1] + reach * 0.55, mid[2] + reach * 2.3);
    camera.lookAt(mid[0], mid[1], mid[2]);
    playing = false;
    render();
    return api.stats();
  },

  /** A block of them at a distance, which is the way the crowd is actually seen. */
  grid(count: number, clipName = '', spacing = 1.8, distance = 0) {
    if (!crowd || !species) throw new Error('load() first');
    const idx = Math.max(0, species.clips.findIndex((c) => c.name === clipName));
    const n = Math.min(count, crowd.capacity);
    const cols = Math.ceil(Math.sqrt(n));
    for (let i = 0; i < n; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      crowd.place(i, (c - cols / 2) * spacing, 0, -r * spacing, ((i * 37) % 360) * (Math.PI / 180));
      crowd.animate(i, idx, (i % 97) * 0.031, i % 2);
    }
    crowd.setCount(n);
    crowd.flush();
    const span = cols * spacing;
    const d = distance || span * 1.1 + 6;
    camera.position.set(0, Math.max(2.5, span * 0.3), d);
    camera.lookAt(0, species.height * 0.4, -span * 0.4);
    playing = false;
    render();
    return api.stats();
  },

  /** Runs the clip in real time, for a recorded sequence rather than a still. */
  play(clipName = '', fromSeconds = 0) {
    if (!crowd || !species) throw new Error('load() first');
    playClip = Math.max(0, species.clips.findIndex((c) => c.name === clipName));
    playStart = performance.now() - fromSeconds * 1000;
    playing = true;
  },
  pause() {
    playing = false;
  },

  stats() {
    const info = renderer.info.render;
    return { draws: info.calls, triangles: info.triangles };
  },

  /**
   * What a frame of this crowd actually costs. Three numbers, because no single one is honest:
   * gl.finish() does not block on Chrome's GPU process, so wall-clock around draw calls only
   * measures how fast JavaScript can enqueue them.
   */
  async bench(count: number, clipName = '', millis = 1500) {
    if (!crowd || !species) throw new Error('load() first');
    api.grid(count, clipName);
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const idx = Math.max(0, species.clips.findIndex((c) => c.name === clipName));
    const n = Math.min(count, crowd.capacity);
    const step = (t: number) => {
      for (let i = 0; i < n; i++) crowd!.animate(i, idx, t + (i % 97) * 0.031, i % 2);
      crowd!.flush();
      render();
    };
    for (let i = 0; i < 5; i++) step(i / 60); // compile shaders, settle buffers

    // CPU: how long the main thread spends building and submitting one frame.
    const c0 = performance.now();
    const warm = 30;
    for (let f = 0; f < warm; f++) step(f / 60);
    const cpuMs = (performance.now() - c0) / warm;

    // GPU: a real timer query, where the driver exposes one.
    let gpuMs: number | null = null;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    if (ext) {
      const q = gl.createQuery();
      if (q) {
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        step(0.5);
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        const deadline = performance.now() + 2000;
        while (performance.now() < deadline) {
          await new Promise((r) => requestAnimationFrame(r));
          if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
        }
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
        if (!disjoint && gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
          gpuMs = +(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6).toFixed(3);
        }
        gl.deleteQuery(q);
      }
    }

    // Sustained: what the page actually achieves, vsync and all. Pinned at 60 means it fits.
    let drawn = 0;
    const t0 = performance.now();
    await new Promise<void>((done) => {
      const tick = () => {
        step((performance.now() - t0) / 1000);
        drawn++;
        if (performance.now() - t0 >= millis) done();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const elapsed = (performance.now() - t0) / 1000;

    return {
      count: n,
      trianglesPerInstance: crowd.trianglesPerInstance,
      cpuMsPerFrame: +cpuMs.toFixed(2),
      gpuMsPerFrame: gpuMs,
      sustainedFps: +(drawn / elapsed).toFixed(1),
      vsyncCapped: drawn / elapsed > 57,
      ...api.stats(),
    };
  },

  /**
   * Where each joint actually ends up on a frame, in world metres. This is the number a species
   * test asserts on: a foot that should be planted, a slime's crown that should dip when it
   * lands. Pure data - no GPU involved, so it is stable in headless CI.
   */
  jointWorld(clipName: string, frame: number) {
    if (!species) throw new Error('load() first');
    const clip = clipByName(species, clipName);
    if (!clip) throw new Error(`species ${species.id} has no clip "${clipName}"`);
    const f = Math.max(0, Math.min(frame, clip.frames - 1));
    const n = species.joints.length;
    const bind = bindWorlds(species.joints);
    const e = clip.matrices;
    return bind.map((b, j) => {
      const at = (f * n + j) * MATRIX_STRIDE;
      const p = new THREE.Vector3().setFromMatrixPosition(b);
      return [
        e[at + 0] * p.x + e[at + 1] * p.y + e[at + 2] * p.z + e[at + 3],
        e[at + 4] * p.x + e[at + 5] * p.y + e[at + 6] * p.z + e[at + 7],
        e[at + 8] * p.x + e[at + 9] * p.y + e[at + 10] * p.z + e[at + 11],
      ].map((x) => +x.toFixed(4));
    });
  },

  /**
   * Runs a creature's close-up poses directly, for the same moment a baked clip covers, and
   * reports where the joints land. A test comparing this with jointWorld() is what proves the
   * crowd is showing the same animation as the close-up renderer rather than a copy of it.
   */
  async poseWorld(creature: string, clipName: string, frame: number) {
    const { HERO_CLIPS, HERO_RIG } = await import('../content/creatures/hero');
    const { DetailRig } = await import('../render/detail/rig');
    const { poseHumanoid } = await import('../render/detail/humanoid');
    const { pose } = await import('../content/pose');
    if (creature !== 'hero') throw new Error(`poseWorld only knows the hero, not "${creature}"`);
    const driver = HERO_CLIPS.find((c) => c.name === clipName);
    if (!driver) throw new Error(`hero has no clip "${clipName}"`);
    const rig = new DetailRig(HERO_RIG);
    rig.showAttachment('sword');
    const t = driver.frames === 1 ? 0 : frame / (driver.loop === false ? driver.frames - 1 : driver.frames);
    poseHumanoid(rig, pose(driver.at(t, frame)));
    rig.root.updateMatrixWorld(true);
    return HERO_RIG.joints.map((j) => {
      const p = new THREE.Vector3();
      rig.joint(j.name).getWorldPosition(p);
      return [j.name, +p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)] as const;
    });
  },

  jointPositions: (clipName: string, frame: number) => {
    if (!species) throw new Error('load() first');
    return jointPositions(species, clipName, frame).map((p) => p.map((x) => +x.toFixed(4)));
  },
  bounds: (clipName: string, frame: number) => {
    if (!species) throw new Error('load() first');
    return posedBounds(species, clipName, frame);
  },

};

function frame() {
  if (playing && crowd && species) {
    const t = (performance.now() - playStart) / 1000;
    const n = Math.max(1, (crowd.group.children[0] as THREE.Mesh).geometry instanceof THREE.InstancedBufferGeometry
      ? ((crowd.group.children[0] as THREE.Mesh).geometry as THREE.InstancedBufferGeometry).instanceCount
      : 1);
    for (let i = 0; i < n; i++) crowd.animate(i, playClip, t + (i % 97) * 0.031, i % 2);
    crowd.flush();
    render();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

(window as unknown as { __species: typeof api }).__species = api;
render();
