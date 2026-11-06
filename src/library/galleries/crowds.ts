import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SpeciesCrowd } from '../../render/creatures/crowd';
import { getSpecies, speciesIds } from '../../render/creatures/registry';
import type { SpeciesDef } from '../../render/creatures/species';
import { jointPositions, jointWorld, posedBounds, poseWorld, speciesInfo } from '../bench/species';
import { h } from '../dom';
import type { AnimDef, Gallery, Options, Subject } from '../types';

// The crowd bench: one species at a time as the crowd draws it (src/render/creatures/crowd.ts, every body an
// instance of one mesh): one body close up on a moment of a clip, or a block of them as a crowd is
// seen, playing or still, with what a frame of them costs. As the species harness drew it (a dark
// room, a dark floor), in the library's viewport. Library routes:
//   #/crowds/<species>/<clip>?show=solo|crowd&count=400&play=0&t=0.4&smooth=0
// window.__library.gallery() = { list, load, solo, grid, play, pause, stats, bench, jointWorld,
// poseWorld, jointPositions, bounds } (tests/integration/species.spec.ts; the numbers alone, no
// drawing: tests/unit/species.test.ts and bench/species.ts).

const NAMES: Record<string, string> = { fighter: 'Fighter', hero: 'Hero, Far Away', quadruped: 'Four-Legged Beast', slime: 'Slime' };
const nameOf = (id: string) => NAMES[id] ?? id[0].toUpperCase() + id.slice(1);
const clipLabel = (c: string) => c.replace(/(\d+)$/, ' $1').replace(/^./, (x) => x.toUpperCase());

class CrowdBench implements Gallery {
  readonly el: HTMLElement;
  readonly api: Record<string, unknown>;
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.05, 600);
  private readonly controls: OrbitControls;
  private readonly label = h('div', { class: 'gl-label dark' });
  private readonly resizer: ResizeObserver;
  private crowd: SpeciesCrowd | null = null;
  private species: SpeciesDef | null = null;
  private playing = false;
  private playClip = 0;
  private playStart = performance.now();
  /** Drawn by bench() alone while it measures. */
  private benching = false;
  private dirty = true;
  private cost: Record<string, number | boolean | null> | null = null;
  /** The clip and crowd the address asked for. */
  private entry = { clip: '', count: 400 };

  constructor(
    private readonly host: HTMLElement,
    entry: string,
    o: Options,
  ) {
    const r = this.renderer;
    r.setPixelRatio(1);
    this.el = h('div', { class: 'gallery' }, r.domElement, this.label);
    this.scene.background = new THREE.Color(0x1a1b20);
    this.scene.add(new THREE.HemisphereLight(0xcfd8ff, 0x2a2f3a, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 6, 4);
    this.scene.add(key);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x23262e }));
    ground.position.y = -0.001;
    this.scene.add(ground);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.addEventListener('change', () => (this.dirty = true));
    this.resizer = new ResizeObserver(() => this.resize());
    this.resizer.observe(host);
    this.resize();

    const api = {
      list: () => speciesIds(),
      /** Loads a species and builds a crowd of `capacity`, returning everything worth asserting on. */
      load: (id: string, capacity = 1, opts: { smooth?: boolean } = {}) => this.load(id, capacity, opts),
      /** One instance, framed, on a given clip and time. */
      solo: (clipName = '', seconds = 0) => this.solo(clipName, seconds),
      /** A block of them at a distance, which is the way the crowd is actually seen. */
      grid: (count: number, clipName = '', spacing = 1.8, distance = 0) => this.grid(count, clipName, spacing, distance),
      /** Runs the clip in real time, for a recorded sequence rather than a still. */
      play: (clipName = '', fromSeconds = 0) => this.play(clipName, fromSeconds),
      pause: () => {
        this.playing = false;
      },
      stats: () => this.stats(),
      bench: (count: number, clipName = '', millis = 1500) => this.bench(count, clipName, millis),
      jointWorld: (clipName: string, frame: number) => jointWorld(this.loaded(), clipName, frame),
      poseWorld: (creature: string, clipName: string, frame: number) => poseWorld(creature, clipName, frame),
      jointPositions: (clipName: string, frame: number) => jointPositions(this.loaded(), clipName, frame),
      bounds: (clipName: string, frame: number) => posedBounds(this.loaded(), clipName, frame),
    };
    this.api = api;

    // What the address asks for: <species>/<clip>, one close up or a crowd, playing or still.
    const [id, clip = ''] = entry.split('/');
    const crowd = o.show === 'crowd';
    const count = Number(o.count) || 400;
    this.entry = { clip, count };
    this.load(speciesIds().includes(id) ? id : speciesIds()[0], crowd ? count : 1, { smooth: o.smooth !== '0' });
    const seconds = Number(o.t) || 0;
    if (crowd) this.grid(count, clip);
    else this.solo(clip, seconds);
    if (o.play !== '0') this.play(clip, seconds);
  }

  private loaded(): SpeciesDef {
    if (!this.species) throw new Error('load() first');
    return this.species;
  }

  private clipIndex(name: string): number {
    return Math.max(
      0,
      this.loaded().clips.findIndex((c) => c.name === name),
    );
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const hh = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, hh, false);
    this.camera.aspect = w / hh;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  private render(): void {
    this.renderer.render(this.scene, this.camera);
    this.dirty = false;
  }

  /** Where the camera looks from and at, the orbit kept round it. */
  private look(from: THREE.Vector3, at: THREE.Vector3): void {
    this.camera.position.copy(from);
    this.camera.lookAt(at);
    this.controls.target.copy(at);
  }

  private load(id: string, capacity: number, opts: { smooth?: boolean }) {
    if (this.crowd) {
      this.scene.remove(this.crowd.group);
      this.crowd.dispose();
    }
    const species = (this.species = getSpecies(id));
    const crowd = (this.crowd = new SpeciesCrowd(species, capacity, { smooth: opts.smooth }));
    this.scene.add(crowd.group);
    crowd.setCount(0);
    this.playing = false;
    this.cost = null;
    this.dirty = true;
    this.label.textContent = `${id}  joints=${species.joints.length}  boxes=${species.proxy.length}  tris=${crowd.trianglesPerInstance}`;
    return speciesInfo(id, crowd);
  }

  private solo(clipName: string, seconds: number) {
    const crowd = this.crowd;
    const species = this.loaded();
    if (!crowd) throw new Error('load() first');
    const idx = this.clipIndex(clipName);
    crowd.setCount(1);
    crowd.place(0, 0, 0, 0, 0);
    crowd.animate(0, idx, seconds, 0);
    crowd.flush();
    // Frame on the posed silhouette, not on height: a quadruped is long before it is tall.
    const clip = species.clips[idx];
    const b = posedBounds(species, clip.name, Math.round(seconds * clip.fps) % clip.frames);
    const reach = Math.max(b.size[0], b.size[1], b.size[2], 0.4);
    const mid = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    this.look(new THREE.Vector3(mid.x + reach * 1.1, mid.y + reach * 0.55, mid.z + reach * 2.3), mid);
    this.playing = false;
    this.render();
    return this.stats();
  }

  private grid(count: number, clipName: string, spacing = 1.8, distance = 0) {
    const crowd = this.crowd;
    const species = this.loaded();
    if (!crowd) throw new Error('load() first');
    const idx = this.clipIndex(clipName);
    const n = Math.min(count, crowd.capacity);
    const cols = Math.ceil(Math.sqrt(n));
    for (let i = 0; i < n; i++) {
      const c = i % cols;
      const row = Math.floor(i / cols);
      crowd.place(i, (c - cols / 2) * spacing, 0, -row * spacing, ((i * 37) % 360) * (Math.PI / 180));
      crowd.animate(i, idx, (i % 97) * 0.031, i % 2);
    }
    crowd.setCount(n);
    crowd.flush();
    const span = cols * spacing;
    const d = distance || span * 1.1 + 6;
    this.look(new THREE.Vector3(0, Math.max(2.5, span * 0.3), d), new THREE.Vector3(0, species.height * 0.4, -span * 0.4));
    this.playing = false;
    this.render();
    return this.stats();
  }

  private play(clipName: string, fromSeconds: number): void {
    this.loaded();
    this.playClip = this.clipIndex(clipName);
    this.playStart = performance.now() - fromSeconds * 1000;
    this.playing = true;
  }

  private stats(): { draws: number; triangles: number } {
    const info = this.renderer.info.render;
    return { draws: info.calls, triangles: info.triangles };
  }

  /**
   * What a frame of this crowd actually costs. Three numbers, because no single one is honest:
   * gl.finish() does not block on Chrome's GPU process, so wall-clock around draw calls only
   * measures how fast JavaScript can enqueue them.
   */
  private async bench(count: number, clipName: string, millis: number) {
    const crowd = this.crowd;
    if (!crowd) throw new Error('load() first');
    this.benching = true;
    try {
      this.grid(count, clipName);
      const gl = this.renderer.getContext() as WebGL2RenderingContext;
      const idx = this.clipIndex(clipName);
      const n = Math.min(count, crowd.capacity);
      const step = (t: number) => {
        for (let i = 0; i < n; i++) crowd.animate(i, idx, t + (i % 97) * 0.031, i % 2);
        crowd.flush();
        this.render();
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
          if (!disjoint && gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) gpuMs = +(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6).toFixed(3);
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
      const out = {
        count: n,
        trianglesPerInstance: crowd.trianglesPerInstance,
        cpuMsPerFrame: +cpuMs.toFixed(2),
        gpuMsPerFrame: gpuMs,
        sustainedFps: +(drawn / elapsed).toFixed(1),
        vsyncCapped: drawn / elapsed > 57,
        ...this.stats(),
      };
      this.cost = out;
      return out;
    } finally {
      this.benching = false;
    }
  }

  ready(): boolean {
    return true;
  }

  frame(): void {
    if (this.benching) return;
    const crowd = this.crowd;
    if (this.playing && crowd) {
      const t = (performance.now() - this.playStart) / 1000;
      const n = Math.max(1, (crowd.group.children[0] as THREE.Mesh<THREE.InstancedBufferGeometry>).geometry.instanceCount);
      for (let i = 0; i < n; i++) crowd.animate(i, this.playClip, t + (i % 97) * 0.031, i % 2);
      crowd.flush();
      this.dirty = true;
    }
    if (this.dirty) this.render();
  }

  actions(): Array<{ label: string; run(): unknown }> {
    return [{ label: `Measure a Crowd of ${this.entry.count}`, run: () => this.bench(this.entry.count, this.entry.clip, 1500) }];
  }

  numbers(): Array<{ heading: string; rows: Array<[string, string]> }> {
    const s = this.species;
    if (!s || !this.crowd) return [];
    const st = this.stats();
    const out: Array<{ heading: string; rows: Array<[string, string]> }> = [
      {
        heading: nameOf(s.id),
        rows: [
          ['Joints', `${s.joints.length}: ${s.joints.map((j) => j.name).join(', ')}`],
          ['Boxes', String(s.proxy.length)],
          ['Triangles', `${this.crowd.trianglesPerInstance} a body`],
          ['Height', `${s.height.toFixed(2)} m`],
        ],
      },
      { heading: 'Clips', rows: s.clips.map((c): [string, string] => [c.name, `${c.frames} frames at ${c.fps} fps${c.loop ? ', loops' : ''}`]) },
      {
        heading: 'The Last Frame Drawn',
        rows: [
          ['Draw calls', String(st.draws)],
          ['Triangles', String(st.triangles)],
        ],
      },
    ];
    if (this.cost) out.push({ heading: 'What a Frame Costs', rows: Object.entries(this.cost).map(([k, v]): [string, string] => [k, String(v)]) });
    return out;
  }

  dispose(): void {
    this.resizer.disconnect();
    this.controls.dispose();
    this.crowd?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

const SHOW = [
  { value: 'solo', label: 'One, Close Up' },
  { value: 'crowd', label: 'A Crowd' },
];

export const crowdsSubject: Subject = {
  id: 'crowds',
  name: 'Crowd Bench',
  group: 'Galleries',
  blurb: 'One species as the crowd draws it, one or thousands',
  options: [
    { id: 'show', label: 'Show', value: 'solo', choices: SHOW },
    {
      id: 'count',
      label: 'A Crowd Of',
      value: '400',
      choices: ['100', '400', '2000', '10000'].map((v) => ({ value: v, label: v })),
    },
    {
      id: 'play',
      label: 'Clip',
      value: '1',
      choices: [
        { value: '1', label: 'Playing' },
        { value: '0', label: 'Still' },
      ],
    },
    { id: 't', label: 'From', value: '', hint: 'seconds into the clip' },
    {
      id: 'smooth',
      label: 'Between Frames',
      value: '1',
      choices: [
        { value: '1', label: 'Blended' },
        { value: '0', label: 'Stepped' },
      ],
    },
  ],
  anims: (): AnimDef[] =>
    speciesIds().flatMap((id) =>
      getSpecies(id).clips.map((c) => ({ id: `${id}/${c.name}`, label: clipLabel(c.name), group: nameOf(id), frames: c.frames, fps: c.fps, loop: c.loop })),
    ),
  gallery: (host, entry, o) => new CrowdBench(host, entry, o),
  source: () => ({
    system:
      "Bodies seen from afar, many at once: a species is a skeleton, boxes hung off its joints (its proxy) and clips baked to a matrix per joint per frame (src/species/), drawn by one instanced mesh whose shader poses every body from a texture of those matrices (src/render/creatures/crowd.ts): any number of them in a draw call. A slime, the battlefield's fighters, a test beast, and the hero, baked from its own close-up poses (src/render/creatures/fromRig.ts).",
    files: [
      { path: 'src/render/creatures/registry.ts', what: 'every species, by id' },
      { path: 'src/render/creatures/builtin/', what: "each species' skeleton, boxes and clips" },
      { path: 'src/render/creatures/clips.ts', what: 'baking clips to matrices' },
      { path: 'src/render/creatures/crowd.ts', what: 'drawing them, an instance each' },
      { path: 'src/library/bench/species.ts', what: 'their joints and silhouettes measured on any frame' },
    ],
    conventions: "A body faces +Z with its root on the ground; a clip's matrices map the bind pose to the posed one, joint by joint.",
    checks: [
      { command: 'npx vitest run tests/unit/species.test.ts', what: 'every species in budget, its clips moving as they should, the hero baked as it poses' },
      { command: 'npx playwright test tests/integration/species.spec.ts', what: 'any number of them in two draw calls; pictures of each' },
    ],
  }),
  animSource: (entry) => {
    const [id, clip] = entry.split('/');
    return `clip '${clip}' of the ${id} species (src/render/creatures/builtin/${id}.ts), baked and drawn by src/render/creatures/crowd.ts`;
  },
};
