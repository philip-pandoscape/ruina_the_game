import * as THREE from 'three';

// Portraits for the UI (your face by the health bar, the person you're talking to, you in the
// character window), taken from the live scene. A queued portrait is drawn into a corner of the
// game's canvas just before the frame's real render, copied out, and then painted over by the
// frame itself, so it costs one small extra render and looks exactly like the game.

interface Job {
  key: string;
  eye: THREE.Vector3;
  target: THREE.Vector3;
  w: number;
  h: number;
  layer: number;
}

export class Portraits {
  private cam = new THREE.PerspectiveCamera(26, 1, 0.05, 80);
  private out = document.createElement('canvas');
  private shots = new Map<string, { url: string; at: number }>();
  private queue: Job[] = [];
  private size = new THREE.Vector2();

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
  ) {}

  /** The latest portrait for a key, and how old it is in milliseconds. */
  get(key: string): { url: string; age: number } | null {
    const s = this.shots.get(key);
    return s ? { url: s.url, age: performance.now() - s.at } : null;
  }

  /**
   * Asks for a portrait from `eye` looking at `target`, `w` x `h` pixels; it is taken on the next frame.
   * With a `layer`, only what is on that layer is drawn (one character, nothing in the way).
   */
  request(key: string, eye: THREE.Vector3, target: THREE.Vector3, w = 128, h = 128, layer = 0): void {
    if (this.queue.some((j) => j.key === key)) return;
    this.queue.push({ key, eye: eye.clone(), target: target.clone(), w, h, layer });
  }

  /** Takes the queued portraits. Call right before the frame's own render. */
  flush(): void {
    if (!this.queue.length) return;
    const r = this.renderer;
    const pr = r.getPixelRatio();
    r.getDrawingBufferSize(this.size);
    r.setScissorTest(true);
    for (const job of this.queue.splice(0)) {
      const w = Math.min(job.w, this.size.x);
      const h = Math.min(job.h, this.size.y);
      r.setViewport(0, 0, w / pr, h / pr);
      r.setScissor(0, 0, w / pr, h / pr);
      this.cam.layers.set(job.layer);
      this.cam.aspect = w / h;
      this.cam.position.copy(job.eye);
      this.cam.lookAt(job.target);
      this.cam.updateProjectionMatrix();
      r.render(this.scene, this.cam);
      this.out.width = w;
      this.out.height = h;
      // The viewport sits at the bottom left of the drawing buffer; images count from the top.
      this.out.getContext('2d')!.drawImage(r.domElement, 0, this.size.y - h, w, h, 0, 0, w, h);
      this.shots.set(job.key, { url: this.out.toDataURL('image/png'), at: performance.now() });
    }
    r.setScissorTest(false);
    r.setViewport(0, 0, this.size.x / pr, this.size.y / pr);
    r.setScissor(0, 0, this.size.x / pr, this.size.y / pr);
  }
}
