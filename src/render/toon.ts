import * as THREE from 'three';
import { NEW_LOOK, OUTLINES } from './look';

// Shared cel-shading look: three flat tones of light, plus dark outlines on characters. The new
// look (src/render/look.ts) shades smoothly instead and draws no outlines.

let gradient: THREE.DataTexture | null = null;

function toonGradient(): THREE.DataTexture {
  if (gradient) return gradient;
  if (NEW_LOOK) return (gradient = softGradient());
  const tones = new Uint8Array([95, 170, 255]);
  gradient = new THREE.DataTexture(tones, tones.length, 1, THREE.RedFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}

// The toon material looks the light up by (n·l + 1) / 2. This ramp turns that back into ordinary
// diffuse light, wrapped a little past the edge so the terminator is soft; faces turned away get
// no sunlight at all, only the sky's fill, which is what gives shapes their form.
function softGradient(): THREE.DataTexture {
  const n = 256;
  const wrap = 0.2;
  const tones = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const ndl = (i / (n - 1)) * 2 - 1;
    tones[i] = Math.round(255 * Math.max(0, (ndl + wrap) / (1 + wrap)));
  }
  const tex = new THREE.DataTexture(tones, n, 1, THREE.RedFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export function toon(color: THREE.ColorRepresentation, extra: THREE.MeshToonMaterialParameters = {}): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color, gradientMap: toonGradient(), ...extra });
}

const outlineCache = new Map<string, THREE.ShaderMaterial>();

// Inverted-hull outline: a slightly inflated copy drawn inside-out in a dark colour.
export function outlineMaterial(thickness = 0.022, color: THREE.ColorRepresentation = 0x1d2733): THREE.ShaderMaterial {
  const key = `${thickness}:${String(color)}`;
  let mat = outlineCache.get(key);
  if (!mat) {
    mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uThickness: { value: thickness },
      },
      vertexShader: /* glsl */ `
        uniform float uThickness;
        void main() {
          vec3 p = position + normal * uThickness;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        void main() {
          gl_FragColor = vec4(uColor, 1.0);
          #include <colorspace_fragment>
        }
      `,
      side: THREE.BackSide,
    });
    outlineCache.set(key, mat);
  }
  return mat;
}

export interface PartOptions {
  outline?: number | false;
  castShadow?: boolean;
}

// Adds a mesh to a parent at a position, with an outline and shadow by default.
export function part(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
  opts: PartOptions = {},
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = opts.castShadow ?? true;
  parent.add(mesh);
  if (opts.outline !== false && OUTLINES) {
    const hull = new THREE.Mesh(geometry, outlineMaterial(opts.outline ?? 0.022));
    hull.castShadow = false;
    mesh.add(hull);
  }
  return mesh;
}
