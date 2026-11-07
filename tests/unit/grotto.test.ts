import type * as THREE from 'three';
import { expect, test, vi } from 'vitest';
import { EMBERHOLM, generateZone, type WaterfallInfo } from '../../src/engine/zone';
import { GrottoView } from '../../src/render/open/grotto';

// The grotto behind a waterfall (src/render/open/grotto.ts) draws the goblins' landing stage and
// their totem only where the fall has them: a fall without either is drawn without it, and with
// everything else.

// Its pictures and the lanterns' glow are painted on canvases, which Node hasn't got: one that
// takes every stroke and keeps nothing.
const anything: unknown = new Proxy(() => {}, { get: () => anything, apply: () => anything, set: () => true });
vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => anything }) });

/** How many of each named part the grotto draws. */
function parts(f: WaterfallInfo): Map<string, number> {
  const n = new Map<string, number>();
  new GrottoView(f, undefined).group.traverse((o: THREE.Object3D) => {
    if (o.name) n.set(o.name, (n.get(o.name) ?? 0) + 1);
  });
  return n;
}

/** What `a` draws more of than `b`. */
function more(a: Map<string, number>, b: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, k] of a) if (k > (b.get(name) ?? 0)) out[name] = k - (b.get(name) ?? 0);
  return out;
}

test('a fall without a landing stage or a totem draws its grotto without them, and with the rest', () => {
  const fall = generateZone(EMBERHOLM).falls[0];
  expect(fall.landing).toBeDefined();
  expect(fall.totem).toBeDefined();
  const { landing, totem, ...bare } = fall;
  const all = parts(fall);
  // The landing stage and its struts; the totem, its jars of slime and the glow over them.
  expect(more(all, parts({ ...bare, totem }))).toEqual({ 'landing-stage': 1, 'landing-struts': 1 });
  expect(more(all, parts({ ...bare, landing }))).toEqual({ totem: 1, 'slime-jars': 1, halo: 1 });
  const none = parts(bare);
  expect(more(all, none)).toEqual({ 'landing-stage': 1, 'landing-struts': 1, totem: 1, 'slime-jars': 1, halo: 1 });
  expect(more(none, all)).toEqual({});
  // The rest is all there: the hood and rocks, the portal, the pictures, the lanterns, the nets, the loot.
  for (const name of ['grotto-hood', 'grotto-rocks', 'portal-arch', 'portal-veil', 'drawings', 'lantern', 'catch-net', 'grotto-loot'])
    expect(none.get(name), name).toBeGreaterThan(0);
});
