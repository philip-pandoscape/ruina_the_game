import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { cropGeometry } from '../../src/render/models/crops';
import { propGeometry } from '../../src/render/models/props';

// The procedural models that the island draws by the thousand (src/render/models): crops and props
// are instanced, so each one's geometry must be non-indexed and vertex-coloured, built once and kept,
// and a crop light enough to draw a field of. The models drawn, measured and held to their anchors:
// tests/integration/models.spec.ts, in the content library's model gallery.

const data = (file: string) => JSON.parse(readFileSync(new URL(`../../shared/${file}`, import.meta.url), 'utf8'));

test('crops and props are instancing-ready: non-indexed, vertex-coloured, cached', () => {
  const crops = data('farming.json').crops as Array<{ id: string; stages: number }>;
  const props = data('structures.json').props as Array<{ id: string }>;
  const out: Array<{ name: string; indexed: boolean; colour: boolean; cached: boolean; tris: number }> = [];
  const check = (name: string, g: ReturnType<typeof cropGeometry>, again: ReturnType<typeof cropGeometry>) =>
    out.push({ name, indexed: !!g.index, colour: !!g.getAttribute('color'), cached: g === again, tris: g.getAttribute('position').count / 3 });
  for (const c of crops) for (let s = 0; s < c.stages; s++) check(`${c.id}:${s}`, cropGeometry(c.id, s), cropGeometry(c.id, s));
  for (const p of props) check(p.id, propGeometry(p.id), propGeometry(p.id));
  expect(out.length).toBe(crops.reduce((n, c) => n + c.stages, 0) + props.length);
  for (const r of out) {
    expect.soft(r.indexed, `${r.name}: non-indexed`).toBe(false);
    expect.soft(r.colour, `${r.name}: has colours`).toBe(true);
    expect.soft(r.cached, `${r.name}: cached`).toBe(true);
    if (r.name.includes(':')) expect.soft(r.tris, `${r.name}: triangles`).toBeLessThanOrEqual(400);
  }
});
