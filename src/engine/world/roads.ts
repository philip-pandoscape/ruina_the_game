import type { World } from '../shapes';
import { SURFACE } from './terrain';
import { MinHeap, WalkGrid, pathLength, type Point } from './localPath';

// The island's roads as a network you can be led along: the centre-lines the generator keeps
// (Generated.roads), joined where one road starts on another and across a town square where several
// start in the same one (the roads only come near each other there, so junctions are found by
// distance, not by shared points). A route runs from where you stand - on a road, or on a square
// one starts from - along the roads to the road point nearest where you are going, then on foot over
// the last stretch when that is short. Plain data and arithmetic, no page: the same island, start
// and end always give the same way.

export type { Point } from './localPath';

/** Within this far of a road's centre-line you count as on it (half a road and a few steps more). */
export const ON_ROAD = 8;
/** A destination up to this far from the nearest road is walked to; further, the route stops at the road. */
export const TAIL_MAX = 25;
/**
 * Choosing which road to leave from, a metre off the road counts as this many along it: a road that
 * runs right up to the place beats one that passes by further off, even if cutting across is shorter.
 */
const OFF_ROAD_WEIGHT = 3;
/** A road whose end is this close to another road joins it there. */
const JOIN = 6;
/** Two road ends this close together, not on the same square, join with a short walk between them. */
const JOIN_ENDS = 14;
/** How far from anything solid the walks off the centre-lines keep your middle: room for a horse too. */
const CLEARANCE = 0.9;
/** A square is crossed on its own paving and the roads, as long as there is a way. */
const PAVED: ReadonlySet<number> = new Set([SURFACE.road, SURFACE.plaza]);

interface Edge {
  to: number;
  cost: number;
  /** The points walked between the two nodes, when that isn't a straight line (across a square). */
  via: Point[] | null;
}

interface RoadNode {
  x: number;
  z: number;
  edges: Edge[];
}

interface Road {
  id: string;
  points: Point[];
  /** Metres along the road at each point. */
  along: number[];
  /** The node of its first point; the rest follow in order. */
  first: number;
}

interface Square {
  /** Road ends on or beside it. */
  ends: number[];
  /** Its extent: x0, z0, x1, z1. */
  box: [number, number, number, number];
}

/** The nearest point on one road's centre-line to somewhere. */
export interface RoadPoint {
  road: number;
  /** The stretch between points `seg` and `seg + 1` it lies on. */
  seg: number;
  x: number;
  z: number;
  dist: number;
}

/** A way from where you stand to where you are going, as points to walk through. */
export interface Route {
  points: Point[];
  /** Metres along the route at each point. */
  at: number[];
  length: number;
  /** Per stretch between two points: across a square or off the road, so followed closely. */
  tight: boolean[];
  /** Where you asked to go. */
  dest: Point;
  /** How far short of it the route ends (0 when it gets there): it keeps to the roads. */
  short: number;
}

export type Plan = { ok: true; route: Route } | { ok: false; why: 'offRoad' | 'noWay' };

interface Source {
  node: number;
  cost: number;
  /** What is walked before reaching the node. */
  lead: Point[];
  tight: boolean;
}

export class RoadNetwork {
  private roads: Road[] = [];
  private nodes: RoadNode[] = [];
  private squares: Square[] = [];
  /** Which square each paved terrain cell belongs to, for the cells found so far. */
  private squareOf = new Map<number, number>();

  constructor(private world: World) {
    const gen = world.zone?.gen;
    if (!gen || !world.terrain) return;
    for (const r of gen.roads) {
      const first = this.nodes.length;
      const along = [0];
      r.points.forEach(([x, z], k) => {
        this.nodes.push({ x, z, edges: [] });
        if (k === 0) return;
        const d = Math.hypot(x - r.points[k - 1][0], z - r.points[k - 1][1]);
        along.push(along[k - 1] + d);
        this.link(first + k - 1, first + k, d, null);
      });
      this.roads.push({ id: r.id, points: r.points, along, first });
    }
    this.join();
  }

  /** How many places the roads meet (for tests): links that aren't along a single road. */
  get junctions(): number {
    let n = 0;
    this.roads.forEach((r) => {
      const last = r.first + r.points.length - 1;
      for (let k = r.first; k <= last; k++) for (const e of this.nodes[k].edges) if (e.to < r.first || e.to > last) n++;
    });
    return n / 2;
  }

  /** Which roads can be reached from which: one group per connected set (for tests). */
  groups(): string[][] {
    const seen = new Int32Array(this.nodes.length).fill(-1);
    let g = 0;
    for (let s = 0; s < this.nodes.length; s++) {
      if (seen[s] >= 0) continue;
      const stack = [s];
      seen[s] = g;
      while (stack.length) for (const e of this.nodes[stack.pop()!].edges) if (seen[e.to] < 0) (seen[e.to] = g), stack.push(e.to);
      g++;
    }
    const out: string[][] = Array.from({ length: g }, () => []);
    for (const r of this.roads) out[seen[r.first]].push(r.id);
    return out.filter((x) => x.length);
  }

  private link(a: number, b: number, cost: number, via: Point[] | null): void {
    this.nodes[a].edges.push({ to: b, cost, via });
    this.nodes[b].edges.push({ to: a, cost, via: via ? [...via].reverse() : null });
  }

  private point(n: number): Point {
    return [this.nodes[n].x, this.nodes[n].z];
  }

  /** Joins the roads where they meet: road ends on other roads, across squares, and ends close together. */
  private join(): void {
    const ends: number[] = [];
    const roadOf = new Map<number, number>();
    this.roads.forEach((r, ri) => {
      for (const e of [r.first, r.first + r.points.length - 1]) {
        if (roadOf.has(e)) continue; // a road of one point
        ends.push(e);
        roadOf.set(e, ri);
      }
    });
    const met = new Set<string>();
    const meet = (a: number, b: number) => met.add(a < b ? `${a},${b}` : `${b},${a}`);
    // A road that starts or ends on another joins it there (both ways along it).
    for (const e of ends) {
      const ri = roadOf.get(e)!;
      const [x, z] = this.point(e);
      this.roads.forEach((q, qi) => {
        if (qi === ri) return;
        const p = this.nearestOn(qi, x, z);
        if (p.dist > JOIN) return;
        const a = q.first + p.seg;
        this.link(e, a, Math.hypot(this.nodes[a].x - x, this.nodes[a].z - z), null);
        this.link(e, a + 1, Math.hypot(this.nodes[a + 1].x - x, this.nodes[a + 1].z - z), null);
        meet(ri, qi);
      });
    }
    // Roads that start from the same square join across it, round whatever stands on it.
    const bySquare = new Map<number, number[]>();
    for (const e of ends) {
      const [x, z] = this.point(e);
      const s = this.squareNear(x, z, 2);
      if (s < 0) continue;
      this.squares[s].ends.push(e);
      bySquare.set(s, [...(bySquare.get(s) ?? []), e]);
    }
    for (const [s, list] of bySquare) {
      if (list.length < 2) continue;
      const [x0, z0, x1, z1] = this.squares[s].box;
      const paved = new WalkGrid(this.world, x0 - 4, z0 - 4, x1 + 4, z1 + 4, { clearance: CLEARANCE, surfaces: PAVED });
      let open: WalkGrid | null = null;
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const a = this.point(list[i]);
          const b = this.point(list[j]);
          let walk = paved.path(a, b);
          if (!walk) walk = (open ??= new WalkGrid(this.world, x0 - 8, z0 - 8, x1 + 8, z1 + 8, { clearance: CLEARANCE })).path(a, b);
          if (!walk) continue;
          this.link(list[i], list[j], pathLength(walk), walk.slice(1, -1));
          meet(roadOf.get(list[i])!, roadOf.get(list[j])!);
        }
    }
    // Two road ends close together anywhere else: a short walk between them.
    for (let i = 0; i < ends.length; i++)
      for (let j = i + 1; j < ends.length; j++) {
        const ra = roadOf.get(ends[i])!;
        const rb = roadOf.get(ends[j])!;
        if (ra === rb || met.has(ra < rb ? `${ra},${rb}` : `${rb},${ra}`)) continue;
        const a = this.point(ends[i]);
        const b = this.point(ends[j]);
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) > JOIN_ENDS) continue;
        const walk = this.walk(a, b);
        if (walk) this.link(ends[i], ends[j], pathLength(walk), walk.slice(1, -1));
      }
  }

  /** A short walk between two points over any ground, round what is in the way. */
  private walk(a: Point, b: Point, goalReach = 1): Point[] | null {
    const m = 10;
    const grid = new WalkGrid(this.world, Math.min(a[0], b[0]) - m, Math.min(a[1], b[1]) - m, Math.max(a[0], b[0]) + m, Math.max(a[1], b[1]) + m, {
      clearance: CLEARANCE,
    });
    return grid.path(a, b, goalReach);
  }

  /** The square (a stretch of paving) a point is on or within `reach` terrain cells of, or -1. */
  private squareNear(x: number, z: number, reach: number): number {
    const hf = this.world.terrain!;
    const i0 = Math.floor((x - hf.min) / hf.cell);
    const j0 = Math.floor((z - hf.min) / hf.cell);
    let best = -1;
    let bestD = Infinity;
    for (let j = j0 - reach; j <= j0 + reach; j++)
      for (let i = i0 - reach; i <= i0 + reach; i++) {
        if (i < 0 || j < 0 || i >= hf.cells || j >= hf.cells) continue;
        const c = j * hf.cells + i;
        if (hf.surface[c] !== SURFACE.plaza) continue;
        const d = (i - i0) * (i - i0) + (j - j0) * (j - j0);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
    return best < 0 ? -1 : this.squareOfCell(best);
  }

  /** The square a paved cell belongs to, flooding out over the paving the first time one is met. */
  private squareOfCell(c: number): number {
    const known = this.squareOf.get(c);
    if (known !== undefined) return known;
    const hf = this.world.terrain!;
    const n = hf.cells;
    const id = this.squares.length;
    const stack = [c];
    this.squareOf.set(c, id);
    let i0 = Infinity;
    let j0 = Infinity;
    let i1 = -Infinity;
    let j1 = -Infinity;
    while (stack.length) {
      const k = stack.pop()!;
      const i = k % n;
      const j = Math.floor(k / n);
      i0 = Math.min(i0, i);
      j0 = Math.min(j0, j);
      i1 = Math.max(i1, i);
      j1 = Math.max(j1, j);
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        const m = nj * n + ni;
        if (hf.surface[m] !== SURFACE.plaza || this.squareOf.has(m)) continue;
        this.squareOf.set(m, id);
        stack.push(m);
      }
    }
    this.squares.push({ ends: [], box: [hf.min + i0 * hf.cell, hf.min + j0 * hf.cell, hf.min + (i1 + 1) * hf.cell, hf.min + (j1 + 1) * hf.cell] });
    return id;
  }

  /** The nearest point on one road's centre-line. */
  nearestOn(ri: number, x: number, z: number): RoadPoint {
    const pts = this.roads[ri].points;
    let best: RoadPoint = { road: ri, seg: 0, x: pts[0][0], z: pts[0][1], dist: Infinity };
    for (let k = 0; k < pts.length - 1; k++) {
      const [ax, az] = pts[k];
      const [bx, bz] = pts[k + 1];
      const ex = bx - ax;
      const ez = bz - az;
      const l2 = ex * ex + ez * ez;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
      const px = ax + ex * t;
      const pz = az + ez * t;
      const d = Math.hypot(px - x, pz - z);
      if (d < best.dist) best = { road: ri, seg: k, x: px, z: pz, dist: d };
    }
    return best;
  }

  /** The nearest point on any road's centre-line, or null on an island without roads. */
  nearest(x: number, z: number): RoadPoint | null {
    let best: RoadPoint | null = null;
    for (let ri = 0; ri < this.roads.length; ri++) {
      const p = this.nearestOn(ri, x, z);
      if (!best || p.dist < best.dist) best = p;
    }
    return best;
  }

  /** Whether you are on the road network here: on or beside a road, or on a square a road starts from. */
  onRoad(x: number, z: number): boolean {
    const p = this.nearest(x, z);
    if (p && p.dist <= ON_ROAD) return true;
    const s = this.squareNear(x, z, 0);
    return s >= 0 && this.squares[s].ends.length > 0;
  }

  /**
   * The way along the roads from (fromX, fromZ) toward (toX, toZ): from the road you stand on (or
   * the square you stand on) to the road point nearest the destination - weighing every road near it
   * by the whole trip - and on foot from there when the destination is within TAIL_MAX of it.
   */
  plan(fromX: number, fromZ: number, toX: number, toZ: number): Plan {
    if (!this.nodes.length) return { ok: false, why: 'noWay' };
    const P: Point = [fromX, fromZ];
    const D: Point = [toX, toZ];
    const sources: Source[] = [];
    // On a road: in from the nearest point of each road close enough.
    const starts: RoadPoint[] = [];
    for (let ri = 0; ri < this.roads.length; ri++) {
      const q = this.nearestOn(ri, fromX, fromZ);
      if (q.dist > ON_ROAD) continue;
      starts.push(q);
      for (const n of [this.roads[ri].first + q.seg, this.roads[ri].first + q.seg + 1]) {
        sources.push({ node: n, cost: q.dist + Math.hypot(this.nodes[n].x - q.x, this.nodes[n].z - q.z), lead: [P, [q.x, q.z]], tight: false });
      }
    }
    // On a square: across it to each road starting from it.
    const sq = this.squareNear(fromX, fromZ, 0);
    if (sq >= 0 && this.squares[sq].ends.length) {
      const [x0, z0, x1, z1] = this.squares[sq].box;
      const grid = new WalkGrid(this.world, x0 - 4, z0 - 4, x1 + 4, z1 + 4, { clearance: CLEARANCE, surfaces: PAVED });
      for (const e of this.squares[sq].ends) {
        const walk = grid.path(P, this.point(e));
        if (walk) sources.push({ node: e, cost: pathLength(walk), lead: walk.slice(0, -1), tight: true });
      }
    }
    if (!sources.length) return { ok: false, why: 'offRoad' };

    // Dijkstra from every way in at once.
    const n = this.nodes.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const via: Array<Edge | null> = new Array(n).fill(null);
    const from = new Int32Array(n).fill(-1); // which source a node was first reached from
    const open = new MinHeap();
    sources.forEach((s, i) => {
      if (s.cost >= dist[s.node]) return;
      dist[s.node] = s.cost;
      from[s.node] = i;
      open.push(s.cost, s.node);
    });
    const done = new Uint8Array(n);
    while (open.size) {
      const k = open.pop();
      if (done[k]) continue;
      done[k] = 1;
      for (const e of this.nodes[k].edges) {
        const c = dist[k] + e.cost;
        if (c >= dist[e.to]) continue;
        dist[e.to] = c;
        prev[e.to] = k;
        via[e.to] = e;
        from[e.to] = -1;
        open.push(c, e.to);
      }
    }

    // Out to the road point nearest the destination; when several roads come near it, whichever
    // makes the best trip, the last stretch off the road counted as the crow flies and weighed heavier.
    const near = this.roads.map((_, ri) => this.nearestOn(ri, toX, toZ)).filter((p) => p.dist < Infinity);
    const closest = Math.min(...near.map((p) => p.dist));
    const goals = closest > TAIL_MAX ? near.filter((p) => p.dist === closest).slice(0, 1) : near.filter((p) => p.dist <= TAIL_MAX);
    let best: { total: number; goal: RoadPoint; node: number; direct: RoadPoint | null } | null = null;
    for (const g of goals) {
      const r = this.roads[g.road];
      const off = g.dist * OFF_ROAD_WEIGHT;
      for (const node of [r.first + g.seg, r.first + g.seg + 1]) {
        const total = dist[node] + Math.hypot(this.nodes[node].x - g.x, this.nodes[node].z - g.z) + off;
        if (total < (best?.total ?? Infinity)) best = { total, goal: g, node, direct: null };
      }
      // Starting and finishing between the same two points of one road: straight along it.
      for (const q of starts) {
        if (q.road !== g.road || q.seg !== g.seg) continue;
        const total = q.dist + Math.hypot(q.x - g.x, q.z - g.z) + off;
        if (total < (best?.total ?? Infinity)) best = { total, goal: g, node: -1, direct: q };
      }
    }
    if (!best) return { ok: false, why: 'noWay' };

    const pts: Point[] = [];
    const tight: boolean[] = [];
    const add = (p: Point, t: boolean) => {
      const last = pts[pts.length - 1];
      if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) < 0.05) return;
      if (pts.length) tight.push(t);
      pts.push(p);
    };
    const g = best.goal;
    if (best.direct) {
      add(P, false);
      add([best.direct.x, best.direct.z], false);
    } else {
      const chain: number[] = [];
      for (let k = best.node; k >= 0; k = prev[k]) chain.push(k);
      chain.reverse();
      const s = sources[from[chain[0]]];
      for (const p of s.lead) add(p, s.tight);
      add(this.point(chain[0]), s.tight);
      for (let i = 1; i < chain.length; i++) {
        const e = via[chain[i]]!;
        for (const p of e.via ?? []) add(p, true);
        add(this.point(chain[i]), !!e.via);
      }
    }
    add([g.x, g.z], false);
    // The last stretch on foot, when the destination is close enough to the road to call it there.
    let short = g.dist;
    if (short > 1 && short <= TAIL_MAX) {
      const walk = this.walk([g.x, g.z], D, 6);
      if (walk) {
        for (const p of walk.slice(1)) add(p, true);
        const end = pts[pts.length - 1];
        short = Math.hypot(end[0] - toX, end[1] - toZ);
      }
    }
    const at = [0];
    for (let k = 1; k < pts.length; k++) at.push(at[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    return { ok: true, route: { points: pts, at, length: at[at.length - 1], tight, dest: D, short } };
  }
}

// ---------- Walking a route ----------

/** Which stretch of a route `s` metres along it falls on. */
function stretchAt(r: Route, s: number): number {
  let lo = 0;
  let hi = r.points.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (r.at[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The point `s` metres along a route (its ends beyond them). */
export function routePoint(r: Route, s: number): Point {
  if (r.points.length < 2 || s <= 0) return r.points[0];
  if (s >= r.length) return r.points[r.points.length - 1];
  const k = stretchAt(r, s);
  const [ax, az] = r.points[k];
  const [bx, bz] = r.points[k + 1];
  const l = r.at[k + 1] - r.at[k];
  const t = l > 0 ? (s - r.at[k]) / l : 0;
  return [ax + (bx - ax) * t, az + (bz - az) * t];
}

/** Whether the stretch `s` metres along a route is one to follow closely (across a square, off the road). */
export function routeTight(r: Route, s: number): boolean {
  return r.tight[stretchAt(r, Math.max(0, Math.min(r.length, s)))] ?? false;
}

/** The nearest point of a route to (x, z), looking only between `from` and `to` metres along it. */
export function routeNearest(r: Route, x: number, z: number, from: number, to: number): { at: number; dist: number } {
  let best = { at: Math.max(0, Math.min(r.length, from)), dist: Infinity };
  for (let k = 0; k < r.points.length - 1; k++) {
    if (r.at[k + 1] < from || r.at[k] > to) continue;
    const [ax, az] = r.points[k];
    const [bx, bz] = r.points[k + 1];
    const ex = bx - ax;
    const ez = bz - az;
    const l2 = ex * ex + ez * ez;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
    const d = Math.hypot(ax + ex * t - x, az + ez * t - z);
    const at = Math.max(from, Math.min(to, r.at[k] + (r.at[k + 1] - r.at[k]) * t));
    if (d < best.dist) best = { at, dist: d };
  }
  return best;
}

/** What is left of a route from `s` metres along it, for drawing. */
export function routeFrom(r: Route, s: number): Point[] {
  if (s <= 0) return r.points;
  if (s >= r.length) return [r.points[r.points.length - 1]];
  const k = stretchAt(r, s);
  return [routePoint(r, s), ...r.points.slice(k + 1)];
}
