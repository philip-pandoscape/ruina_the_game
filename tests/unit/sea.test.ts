import { expect, test } from 'vitest';
import * as THREE from 'three';
import { WaterView } from '../../src/render/open/water';
import { Heightfield } from '../../src/engine/zone';

// The sea along the shore is drawn in tiles, so the positions the GPU works out stay where they
// really are (tests/integration/sea.spec.ts checks the foam on screen).

test('the sea is drawn in tiles of 50 m or less, not one sheet', () => {
  const sea = new WaterView(new Heightfield(8, 4, 0));
  const g = sea.mesh.geometry as THREE.PlaneGeometry;
  expect(g.parameters.width / g.parameters.widthSegments).toBeLessThanOrEqual(50);
  expect(g.parameters.height / g.parameters.heightSegments).toBeLessThanOrEqual(50);
});
