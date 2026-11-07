import * as THREE from 'three';
import { furnitureDef, furnitureIds, type FurnitureDef } from '../../content/buildings';
import { toon } from '../toon';
import type { BatchItem } from './batch';
import { cut, cuttable, PARTS, type Kit, type KitPart } from './kit';

// Furniture as the village draws it (shared/buildings.json furniture): a prop from the kit (a bed,
// a barrel), a group of them (a table laid with benches, plates and candles), or something made
// here: a woven rug, a straw bale, the fire in a hearth.

/** One piece of a furniture item: a model, where it sits in the item's frame, and how it is scaled. */
export interface FurniturePart {
  model: string;
  x?: number;
  y?: number;
  z?: number;
  rot?: number;
  scale?: number | [number, number, number];
}

/** What a furniture def is drawn from. */
export interface FurnitureLook {
  model?: string;
  parts?: FurniturePart[];
  /** Made here: 'rug' (with `variant`), 'hay', 'fire'. */
  make?: string;
  variant?: number;
}

const Y = new THREE.Vector3(0, 1, 0);

function partMatrix(p: FurniturePart): THREE.Matrix4 {
  const s = p.scale === undefined ? [1, 1, 1] : typeof p.scale === 'number' ? [p.scale, p.scale, p.scale] : p.scale;
  return new THREE.Matrix4().compose(
    new THREE.Vector3(p.x ?? 0, p.y ?? 0, p.z ?? 0),
    new THREE.Quaternion().setFromAxisAngle(Y, p.rot ?? 0),
    new THREE.Vector3(s[0], s[1], s[2]),
  );
}

// ---------- Made here: rugs and straw ----------

/** Four woven rugs on one canvas (2 x 2), so they draw as one material. */
function rugTexture(): THREE.Texture {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const palettes = [
    ['#7a2b22', '#c59a4a', '#2e3d5c', '#e3cfa2'],
    ['#2f4a6b', '#d2b071', '#8a3427', '#e8dcc0'],
    ['#5c3a1e', '#a8743f', '#3e5b3a', '#dcc79a'],
    ['#6b2232', '#d9b46a', '#284a4a', '#efe1bf'],
  ];
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  palettes.forEach(([field, accent, deep, light], k) => {
    const ox = (k % 2) * (size / 2);
    const oy = Math.floor(k / 2) * (size / 2);
    const s = size / 2;
    g.fillStyle = deep;
    g.fillRect(ox, oy, s, s);
    g.fillStyle = field;
    g.fillRect(ox + 14, oy + 14, s - 28, s - 28);
    // Borders: a light band, then a row of small diamonds.
    g.strokeStyle = light;
    g.lineWidth = 5;
    g.strokeRect(ox + 24, oy + 24, s - 48, s - 48);
    g.fillStyle = accent;
    for (let i = 0; i < 12; i++) {
      const t = 36 + (i * (s - 72)) / 11;
      for (const [px, py] of [
        [t, 36],
        [t, s - 36],
        [36, t],
        [s - 36, t],
      ]) {
        g.beginPath();
        g.moveTo(ox + px, oy + py - 5);
        g.lineTo(ox + px + 5, oy + py);
        g.lineTo(ox + px, oy + py + 5);
        g.lineTo(ox + px - 5, oy + py);
        g.fill();
      }
    }
    // The field: a big lozenge with a medallion.
    g.fillStyle = deep;
    g.beginPath();
    g.moveTo(ox + s / 2, oy + 56);
    g.lineTo(ox + s - 56, oy + s / 2);
    g.lineTo(ox + s / 2, oy + s - 56);
    g.lineTo(ox + 56, oy + s / 2);
    g.closePath();
    g.fill();
    g.fillStyle = accent;
    g.beginPath();
    g.arc(ox + s / 2, oy + s / 2, 34, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = light;
    g.beginPath();
    g.arc(ox + s / 2, oy + s / 2, 14, 0, Math.PI * 2);
    g.fill();
    // Wear and weave: faint threads and a little grime.
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(${rand() < 0.5 ? '0,0,0' : '255,240,210'},${0.05 + rand() * 0.06})`;
      g.fillRect(ox + rand() * s, oy + rand() * s, 1 + rand() * 6, 1);
    }
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function strawTexture(): THREE.Texture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#c9a24e';
  g.fillRect(0, 0, size, size);
  let seed = 11;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 2600; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const l = 6 + rand() * 18;
    const a = (rand() - 0.5) * 0.7;
    const shade = rand();
    g.strokeStyle = shade < 0.3 ? 'rgba(120,88,30,0.55)' : shade < 0.8 ? 'rgba(232,200,110,0.6)' : 'rgba(250,230,160,0.7)';
    g.lineWidth = 1 + rand();
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
  // Twine round the bale.
  g.fillStyle = 'rgba(90,60,30,0.75)';
  g.fillRect(size * 0.3, 0, 4, size);
  g.fillRect(size * 0.7, 0, 4, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A flat rug: one quarter of the rug canvas, a hair over the floor. */
function rugGeometry(w: number, d: number, variant: number): THREE.BufferGeometry {
  // Over the ground floor's tiles, which lie 3 cm up.
  const g = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2).translate(0, 0.045, 0);
  const uv = g.getAttribute('uv');
  const u0 = (variant % 2) * 0.5;
  const v0 = Math.floor((variant % 4) / 2) * 0.5;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * 0.5, v0 + uv.getY(i) * 0.5);
  return g;
}

/** A straw bale, slightly rounded at the top. */
function baleGeometry(w: number, d: number, h: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d, 2, 2, 2).translate(0, h / 2, 0);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) if (p.getY(i) > h * 0.9) p.setY(i, h - 0.04 * (Math.abs(p.getX(i)) / (w / 2) + Math.abs(p.getZ(i)) / (d / 2)));
  g.computeVertexNormals();
  return g;
}

// ---------- Fire ----------

/** Time for every fire in the village. */
export const fireTime = { value: 0 };

/** Flames: crossed quads drawn with a moving shader, bright enough to bloom; left out with the storey above you. */
function fireMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: fireTime, uCutBuilding: cut.building, uCutPart: cut.part },
    vertexShader: /* glsl */ `
      attribute float aPart;
      uniform float uCutBuilding;
      uniform float uCutPart;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 p4 = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          p4 = instanceMatrix * p4;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * p4;
        float b = floor((aPart + 0.5) / ${PARTS.toFixed(1)});
        float p = aPart - b * ${PARTS.toFixed(1)};
        if (abs(b - uCutBuilding) < 0.5 && p > uCutPart + 0.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      void main() {
        vec2 uv = vUv;
        float n = noise(vec2(uv.x * 5.0, uv.y * 3.0 - uTime * 2.6)) * 0.6 + noise(vec2(uv.x * 11.0, uv.y * 6.0 - uTime * 4.1)) * 0.4;
        // A flame: wide at the foot, narrowing and breaking up toward the tip.
        float width = (1.0 - uv.y) * 0.5 + 0.06;
        float body = smoothstep(width, width * 0.35, abs(uv.x - 0.5 + (n - 0.5) * 0.25 * uv.y));
        float f = body * smoothstep(1.0, 0.25, uv.y + n * 0.35) * smoothstep(0.0, 0.08, uv.y);
        if (f < 0.02) discard;
        vec3 col = mix(vec3(1.0, 0.32, 0.05), vec3(1.0, 0.85, 0.45), f);
        gl_FragColor = vec4(col * (1.6 + f * 2.2), f);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/** Three crossed flames over a bed of glowing logs, as one geometry. */
function fireGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) {
    const q = new THREE.PlaneGeometry(0.55, 0.75).translate(0, 0.42, 0).rotateY((k * Math.PI) / 3);
    parts.push(q);
  }
  const merged = new THREE.BufferGeometry();
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const p of parts) {
    const base = pos.length / 3;
    pos.push(...(p.getAttribute('position').array as Float32Array));
    uv.push(...(p.getAttribute('uv').array as Float32Array));
    idx.push(...Array.from(p.index!.array).map((i) => i + base));
  }
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  merged.setIndex(idx);
  return merged;
}

/** Logs in the fire: three short dark cylinders, ends glowing. */
function logsGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const all: THREE.BufferGeometry[] = [];
  for (const [a, x] of [
    [0.3, -0.05],
    [-0.4, 0.08],
    [1.6, 0],
  ] as Array<[number, number]>) {
    const c = new THREE.CylinderGeometry(0.06, 0.07, 0.6, 7)
      .rotateZ(Math.PI / 2)
      .rotateY(a)
      .translate(x, 0.07, 0);
    all.push(c.toNonIndexed());
  }
  const pos: number[] = [];
  const nor: number[] = [];
  for (const c of all) {
    pos.push(...(c.getAttribute('position').array as Float32Array));
    nor.push(...(c.getAttribute('normal').array as Float32Array));
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  const col = new Float32Array(pos.length);
  for (let i = 0; i < pos.length / 3; i++) col.set([0.26, 0.16, 0.1], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Where a fire burns, and the building and part it belongs to. */
export interface FirePlacement {
  matrix: THREE.Matrix4;
  tag: number;
}

/** Every fire in the village as one instanced mesh. */
export function fireMesh(fires: FirePlacement[]): THREE.InstancedMesh {
  const g = fireGeometry();
  g.setAttribute('aPart', new THREE.InstancedBufferAttribute(Float32Array.from(fires.map((f) => f.tag)), 1));
  const mesh = new THREE.InstancedMesh(g, fireMaterial(), fires.length);
  fires.forEach((f, i) => mesh.setMatrixAt(i, f.matrix));
  mesh.computeBoundingSphere();
  mesh.renderOrder = 2;
  mesh.name = 'fires';
  return mesh;
}

/**
 * Builds what an item is drawn with. Kit models (and what is made here) go into `items`, to be
 * merged with the rest of a building's furniture; fires, which flicker, into `fires`.
 */
export class Furnisher {
  private made = new Map<string, KitPart[]>();
  readonly materials = new Map<string, THREE.Material>();

  constructor(private kit: Kit) {
    this.materials.set('rug', cuttable(toon(0xffffff, { map: rugTexture() }), 'rug'));
    this.materials.set('hay', cuttable(toon(0xffffff, { map: strawTexture() }), 'hay'));
    this.materials.set('logs', cuttable(toon(0xffffff, { vertexColors: true, emissive: 0x5a1a04, emissiveIntensity: 0.6 }), 'logs'));
  }

  material(name: string): THREE.Material | undefined {
    return this.materials.get(name) ?? this.kit.materials.get(name);
  }

  private madeParts(key: string, build: () => KitPart[]): KitPart[] {
    let p = this.made.get(key);
    if (!p) this.made.set(key, (p = build()));
    return p;
  }

  /**
   * The item `def` (drawn as `look`) placed by `matrix`, tagged with building and part.
   */
  place(def: FurnitureDef, look: FurnitureLook, matrix: THREE.Matrix4, building: number, part: number, items: BatchItem[], fires: FirePlacement[]): void {
    const tag = building * PARTS + part;
    const parts: FurniturePart[] = look.parts ?? (look.model ? [{ model: look.model }] : []);
    for (const p of parts) {
      const geo = this.kit.pieces.get(p.model);
      if (!geo) {
        if (p.model.startsWith('@')) {
          // Another item of the catalogue (a bale in a stack), or something made here (a fire).
          const name = p.model.slice(1);
          const other = furnitureIds().includes(name) ? furnitureDef(name) : null;
          this.place(other ?? def, other ?? { make: name, variant: look.variant }, matrix.clone().multiply(partMatrix(p)), building, part, items, fires);
        } else console.warn(`no model "${p.model}" for ${def.id}`);
        continue;
      }
      items.push({ parts: geo, matrix: matrix.clone().multiply(partMatrix(p)), tag });
    }
    if (look.make === 'rug') {
      const v = look.variant ?? 0;
      items.push({ parts: this.madeParts(`rug:${def.w}:${def.d}:${v}`, () => [{ geometry: rugGeometry(def.w, def.d, v), material: 'rug' }]), matrix, tag });
    } else if (look.make === 'hay') {
      items.push({
        parts: this.madeParts(`hay:${def.w}:${def.d}:${def.h}`, () => [{ geometry: baleGeometry(def.w, def.d, def.h), material: 'hay' }]),
        matrix,
        tag,
      });
    } else if (look.make === 'fire') {
      items.push({ parts: this.madeParts('logs', () => [{ geometry: logsGeometry(), material: 'logs' }]), matrix, tag });
      fires.push({ matrix, tag });
    }
  }
}
