import * as THREE from 'three';

// Shared cel-shading look: three flat tones of light, plus dark outlines on characters.

let gradient: THREE.DataTexture | null = null;

function toonGradient(): THREE.DataTexture {
  if (gradient) return gradient;
  const tones = new Uint8Array([95, 170, 255]);
  gradient = new THREE.DataTexture(tones, tones.length, 1, THREE.RedFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
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
  if (opts.outline !== false) {
    const hull = new THREE.Mesh(geometry, outlineMaterial(opts.outline ?? 0.022));
    hull.castShadow = false;
    mesh.add(hull);
  }
  return mesh;
}
