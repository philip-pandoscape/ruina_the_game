import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { SpeciesDef } from './types';

// The proxy as the GPU sees it: one merged box soup, each vertex carrying the joint that drives
// it and the palette slot that tints it. Twelve triangles per box, and the whole thing is static
// - every frame of movement comes out of the pose texture.

export function buildProxyGeometry(species: SpeciesDef): THREE.BufferGeometry {
  const parts = species.proxy.map((b) => {
    const g = new THREE.BoxGeometry(b.size[0], b.size[1], b.size[2]);
    g.deleteAttribute('uv');
    g.applyQuaternion(new THREE.Quaternion(...b.rot));
    g.translate(b.pos[0], b.pos[1], b.pos[2]);
    const n = g.attributes.position.count;
    g.setAttribute('aJoint', new THREE.BufferAttribute(new Float32Array(n).fill(b.joint), 1));
    g.setAttribute('aMat', new THREE.BufferAttribute(new Float32Array(n).fill(b.mat), 1));
    const c = new THREE.Color(b.color);
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  });
  if (!parts.length) throw new Error(`species ${species.id} has no proxy boxes`);
  const merged = mergeGeometries(parts);
  if (!merged) throw new Error(`species ${species.id}: proxy boxes did not merge`);
  return merged;
}

export const proxyTriangles = (g: THREE.BufferGeometry): number => (g.index ? g.index.count : g.attributes.position.count) / 3;
