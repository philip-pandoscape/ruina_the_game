import { expect, test } from 'vitest';
import { EMBERHOLM, inRect, makeZoneWorld, RoadNetwork, type Route, routePoint, SURFACE, TAIL_MAX } from '../../src/engine/zone';

// Auto-run's road network and its routes (src/engine/world/roads.ts), checked without a page. Walking
// them in the game, the map and the readout: tests/integration/travel.spec.ts.

const PAVED = new Set<number>([SURFACE.road, SURFACE.plaza]);

// ---------- The road network, in Node ----------

test('the road network: every road on Emberholm joins the rest, at the square and where roads branch', () => {
  const net = new RoadNetwork(makeZoneWorld());
  const groups = net.groups();
  expect(groups).toHaveLength(1);
  expect(groups[0].sort()).toEqual(EMBERHOLM.terrain.roads.map((r) => r.id).sort());
  // Four roads start in Lanternwick's square and three branch off others.
  expect(net.junctions).toBeGreaterThanOrEqual(9);
});

test('routes between places keep to the roads and squares, clear of what stands on them, the same every time', () => {
  const world = makeZoneWorld();
  const net = new RoadNetwork(world);
  const hf = world.terrain!;
  const idx = world.index!;
  const npcs = EMBERHOLM.npcs;
  const places = EMBERHOLM.places;
  const starts = [{ id: 'spawn', ...EMBERHOLM.spawn }, ...places].filter((p) => net.onRoad(p.x, p.z));
  expect(starts.map((s) => s.id)).toEqual(expect.arrayContaining(['spawn', 'lanternwick', 'hearthside', 'westwatch']));
  /**
   * How close anything solid comes to a point (edge to centre); small posts and lamps the walker
   * steers round. The routes share their roads, so each half-metre spot is only measured once.
   */
  const measured = new Map<string, number>();
  const room = (x: number, z: number): number => {
    const key = `${Math.round(x * 2)},${Math.round(z * 2)}`;
    const known = measured.get(key);
    if (known !== undefined) return known;
    let min = Infinity;
    const g = hf.height(x, z);
    idx.eachObstacle(x, z, 3, (o) => {
      if (o.r >= 0.3) min = Math.min(min, Math.hypot(x - o.x, z - o.z) - o.r);
    });
    idx.eachBox(x, z, 3, (b) => {
      if (b.top > g + 0.45 && inRect(b, x, z, 0.45)) min = Math.min(min, 0);
    });
    for (const n of npcs) min = Math.min(min, Math.hypot(x - n.x, z - n.z) - 0.4);
    measured.set(key, min);
    return min;
  };
  for (const a of starts)
    for (const b of places) {
      if (a.id === b.id) continue;
      const plan = net.plan(a.x, a.z, b.x, b.z);
      expect(plan.ok, `${a.id} to ${b.id}`).toBe(true);
      if (!plan.ok) continue;
      const r: Route = plan.route;
      let paved = 0;
      let counted = 0;
      const cramped: string[] = [];
      for (let s = 2; s <= r.length; s += 0.5) {
        const [x, z] = routePoint(r, s);
        // Off the road only on the last stretch to a place close to one.
        if (Math.hypot(x - b.x, z - b.z) > TAIL_MAX + 1) {
          counted++;
          if (PAVED.has(hf.surfaceAt(x, z))) paved++;
        }
        if (room(x, z) <= 0.45) cramped.push(`${s.toFixed(1)} m along, at ${x.toFixed(1)}, ${z.toFixed(1)}`);
      }
      expect(cramped, `${a.id} to ${b.id}: something solid in the way`).toEqual([]);
      if (counted) expect(paved / counted, `${a.id} to ${b.id} paved`).toBeGreaterThan(0.98);
      // Deterministic: the same region, start and end give the same way.
      const again = net.plan(a.x, a.z, b.x, b.z);
      expect(again.ok && again.route.points).toEqual(r.points);
    }
});

test('a destination off the road: walked to when it is a few steps off, the road goes as near as it can when it is far', () => {
  const net = new RoadNetwork(makeZoneWorld());
  const at = (id: string) => EMBERHOLM.places.find((p) => p.id === id)!;
  const sp = EMBERHOLM.spawn;
  const ww = net.plan(sp.x, sp.z, at('westwatch').x, at('westwatch').z);
  expect(ww.ok && ww.route.short).toBeLessThan(1);
  // The Windspire stands 64 m beyond the end of the north road: the route stops at the road's end.
  const spire = net.plan(sp.x, sp.z, at('windspire').x, at('windspire').z);
  expect(spire.ok).toBe(true);
  if (!spire.ok) return;
  const end = spire.route.points[spire.route.points.length - 1];
  const north = EMBERHOLM.terrain.roads.find((r) => r.id === 'north')!.points;
  expect(Math.hypot(end[0] - north[north.length - 1][0], end[1] - north[north.length - 1][1])).toBeLessThan(1);
  expect(spire.route.short).toBeGreaterThan(50);
  // Far from any road there is no setting off.
  expect(net.plan(60, -150, at('westwatch').x, at('westwatch').z)).toEqual({ ok: false, why: 'offRoad' });
});
