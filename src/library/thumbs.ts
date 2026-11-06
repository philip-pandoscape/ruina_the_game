import * as THREE from 'three';
import { LOOK } from '../render/look';
import type { Options, Subject } from './types';

// Small portraits for the character list: each subject on its idle (or first) animation, drawn once
// by a little renderer of its own and kept in this browser.

const CACHE = `ruina.animLibrary.thumbs.v1.${LOOK}`;
const SIZE = 112;

export async function thumbnails(subjects: Subject[], done: (id: string, url: string) => void): Promise<void> {
  let cache: Record<string, string> = {};
  try {
    cache = JSON.parse(localStorage.getItem(CACHE) ?? '{}') as Record<string, string>;
  } catch {
    cache = {};
  }
  const missing = subjects.filter((s) => {
    if (cache[s.id]) done(s.id, cache[s.id]);
    return !cache[s.id];
  });
  if (!missing.length) return;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x4a4f5a, 1.7));
  const key = new THREE.DirectionalLight(0xfff4e2, 2.2);
  key.position.set(-3, 6, 5);
  scene.add(key);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.02, 100);

  for (const s of missing) {
    try {
      const opts: Options = Object.fromEntries(s.options.map((o) => [o.id, o.value]));
      await s.ready?.(opts);
      const anims = s.anims(opts);
      const anim = anims.find((a) => a.id === 'idle') ?? anims[0];
      if (!anim) continue;
      const take = s.take(anim.id, opts);
      const f = Math.min(take.frames - 1, 12);
      take.bake(f + 1);
      take.show(f);
      take.root.position.set(0, 0, 0);
      scene.add(take.root);
      const t = new THREE.Vector3(...take.framing.target);
      const h = take.framing.height;
      // Head and shoulders for the tall, the whole body for the small.
      const look = h > 1.2 ? new THREE.Vector3(t.x, h * 0.72, t.z) : t;
      const dist = h > 1.2 ? h * 1.35 : Math.max(0.9, take.framing.distance * 0.55);
      camera.position.copy(look).add(new THREE.Vector3(-0.55, 0.22, 1).normalize().multiplyScalar(dist));
      camera.lookAt(look);
      renderer.render(scene, camera);
      const url = renderer.domElement.toDataURL('image/png');
      scene.remove(take.root);
      take.dispose();
      cache[s.id] = url;
      done(s.id, url);
    } catch (e) {
      console.warn('thumbnail', s.id, e);
    }
    await new Promise((r) => setTimeout(r, 16));
  }
  renderer.dispose();
  renderer.forceContextLoss();
  try {
    localStorage.setItem(CACHE, JSON.stringify(cache));
  } catch {
    // Out of room: they are made again next time.
  }
}
