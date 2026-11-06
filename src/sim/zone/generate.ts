import { fbm, Heightfield, lerp, smoothstep, SURFACE } from '../terrain';
import { makeRng, range } from '../../util/rng';
import type { Obstacle } from '../types';
import { structureDef, propDef, type StructureDef } from '../../content/structures';
import { placedPlan, type BuildingPlan } from '../../content/buildings';
import { buildingColliders } from './buildings';
import type { BoxCollider, Deck, WaterfallInfo, ZoneRecipe, ZonePlacement } from './types';
import { TAU } from '../../util/math';

// Grows a zone from its recipe (shared/zones/*.json): coastline, cliffs, hills, mountains with a
// path carved up their face, flattened town squares, graded roads, then the trees and rocks, the
// buildings' colliders and the decks you can walk on. Same recipe, same seed, same island, every
// time - the rules and the renderer both build from this.
/** Half the width of the runnel a waterfall's spring spills to the lip along (src/render/open/falls.ts draws its water). */
export const RUNNEL = 2.2;

export interface Generated {
  terrain: Heightfield;
  obstacles: Obstacle[];
  boxes: BoxCollider[];
  decks: Deck[];
  /** Road centre-lines as sampled polylines, for the map and for lamp placement. */
  roads: Array<{ id: string; width: number; points: Array<[number, number]> }>;
  /** The carved mountain paths, for the map. */
  ramps: Array<Array<[number, number]>>;
  /** Cells kept free of trees and rocks (and of scarecrows, unless they are farmland). */
  clear: Uint8Array;
  /** Static decoration placed from the recipe, resolved to heights. */
  placements: ZonePlacement[];
  /** The waterfalls, as cut. */
  falls: WaterfallInfo[];
  /** The buildings you can walk into (src/content/buildings.ts), with their plans and the boxes that are their walls. */
  buildings: PlacedBuilding[];
}

export interface PlacedBuilding {
  id: string;
  plan: BuildingPlan;
  x: number;
  y: number;
  z: number;
  rot: number;
  mirror: boolean;
  /** Its solid parts in the zone's lists (the camera sees through the walls of the one you are in). */
  boxes: BoxCollider[];
}

export function generateZone(z: ZoneRecipe): Generated {
  const t = z.terrain;
  const hf = new Heightfield(t.cells, t.cell, t.water);
  const n = hf.n;
  const H = hf.heights;
  const seed = z.seed;

  // ---------- Coast: how far inland each point is, in metres (negative out at sea) ----------
  const isl = t.island;
  const landness = (x: number, zz: number): number => {
    const dx = x - isl.x;
    const dz = zz - isl.z;
    const r = Math.sqrt(dx * dx + dz * dz);
    const a = Math.atan2(dz, dx);
    let R = isl.radius;
    for (const [k, amp, ph] of isl.lobes) R += amp * Math.sin(k * a + ph);
    R += isl.warp * fbm(x / isl.warpScale, zz / isl.warpScale, 3, seed + 11);
    let d = R - r;
    for (const h of t.headlands) {
      if (h.r <= 0) continue;
      const hd = Math.hypot(x - h.x, zz - h.z);
      d += h.push * smoothstep(h.r, 0, hd);
    }
    for (const b of t.bays) d = Math.min(d, Math.hypot(x - b.x, zz - b.z) - b.r + 14 * fbm(x / 34, zz / 34, 2, seed + 17));
    for (const i of t.islets) d = Math.max(d, i.r - Math.hypot(x - i.x, zz - i.z) + 9 * fbm(x / 40, zz / 40, 2, seed + 23));
    return d;
  };

  const sh = t.shore;
  const shoreProfile = (d: number): number => {
    if (d >= 0) return sh.beachHeight * smoothstep(0, sh.beach, d) + Math.max(0, d - sh.beach) * sh.inlandRise;
    const out = -d;
    return -Math.min(sh.maxDepth, out * sh.seabedSlope + out * out * sh.seabedCurve);
  };

  const hills = t.hills;
  const coast = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const zz = hf.vx(j);
    for (let i = 0; i < n; i++) {
      const x = hf.vx(i);
      const d = landness(x, zz);
      coast[j * n + i] = d;
      let h = shoreProfile(d);
      // Sea cliffs: the same coastline, but it rears straight up instead of shelving.
      for (const c of t.cliffs) {
        const k = smoothstep(c.r, c.r * 0.45, Math.hypot(x - c.x, zz - c.z));
        if (k <= 0) continue;
        const cliff = d >= 0 ? c.h * smoothstep(0, 9, d) + Math.max(0, d - 9) * sh.inlandRise : -Math.min(sh.maxDepth, -d * 0.45);
        h = lerp(h, cliff, k);
      }
      if (d > 0) {
        const k = smoothstep(hills.inlandFrom, hills.inlandTo, d);
        const near = smoothstep(4, 40, d);
        h += (fbm(x / hills.scale, zz / hills.scale, 4, seed + 31) * 0.5 + 0.5) * hills.height * k;
        h += fbm(x / hills.detailScale, zz / hills.detailScale, 3, seed + 37) * hills.detail * near;
      } else {
        h += fbm(x / 60, zz / 60, 2, seed + 41) * 1.2;
      }
      H[j * n + i] = h;
    }
  }

  // ---------- Mountains: flat top, sheer cliff band, walkable skirt ----------
  const mountainAt = new Map<string, ZoneRecipe['terrain']['mountains'][number]>();
  for (const m of t.mountains) {
    mountainAt.set(m.id, m);
    const reach = m.skirt * (1 + m.rugged) + 4;
    eachVertexNear(hf, m.x, m.z, reach, (i, j, x, zz) => {
      const dx = x - m.x;
      const dz = zz - m.z;
      const dm = Math.sqrt(dx * dx + dz * dz);
      const phi = Math.atan2(dz, dx);
      const wobble = 0.55 * Math.sin(3 * phi + 1.1) + 0.3 * Math.sin(7 * phi + 2.3) + 0.35 * fbm(Math.cos(phi) * 2.2 + 9, Math.sin(phi) * 2.2, 2, seed + 51);
      const tt = dm / (1 + m.rugged * wobble);
      const lowTop = m.top * (1 - m.cliffDrop);
      let mh: number;
      let cliffness = 0;
      if (tt <= m.plateau) mh = m.top;
      else if (tt <= m.cliff) {
        const s = smoothstep(m.plateau, m.cliff, tt);
        mh = m.top - (m.top - lowTop) * s;
        cliffness = s * (1 - s) * 4;
      } else mh = lowTop * (1 - smoothstep(m.cliff, m.skirt, tt));
      mh += m.crag * fbm(x / 9, zz / 9, 3, seed + 57) * cliffness;
      const k = j * n + i;
      // Only where the mountain actually stands: its zero-height fringe must not fill in the sea.
      if (mh > 0.05 && mh > H[k]) H[k] = mh;
    });
  }

  // ---------- Ramps: a ledge path climbing the cliff along its own contour lines ----------
  const ramps: Array<Array<[number, number]>> = [];
  for (const r of t.ramps) {
    const m = mountainAt.get(r.mountain);
    if (!m) continue;
    const steps = Math.max(200, Math.round(r.turns * 900));
    const pts: Array<{ x: number; z: number; h: number; rho: number }> = [];
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      const phi = r.startAngle + r.direction * u * r.turns * TAU;
      const target = lerp(r.from, r.to, u);
      // Where along this bearing the cliff is exactly at the height the path wants to be.
      let lo = m.plateau * 0.7;
      let hi = m.skirt;
      for (let it = 0; it < 30; it++) {
        const mid = (lo + hi) / 2;
        const h = hf.height(m.x + Math.cos(phi) * mid, m.z + Math.sin(phi) * mid);
        if (h > target) lo = mid;
        else hi = mid;
      }
      pts.push({ x: 0, z: 0, h: target, rho: (lo + hi) / 2 });
    }
    // The cliff is craggy; the path should not be.
    for (let pass = 0; pass < 3; pass++) {
      const rho = pts.map((p) => p.rho);
      for (let s = 0; s < pts.length; s++) {
        let sum = 0;
        let cnt = 0;
        for (let o = -12; o <= 12; o++) {
          const q = s + o;
          if (q < 0 || q >= pts.length) continue;
          sum += rho[q];
          cnt++;
        }
        pts[s].rho = sum / cnt;
      }
    }
    pts.forEach((p, s) => {
      const phi = r.startAngle + r.direction * (s / steps) * r.turns * TAU;
      p.x = m.x + Math.cos(phi) * p.rho;
      p.z = m.z + Math.sin(phi) * p.rho;
    });
    ramps.push(pts.map((p) => [p.x, p.z]));
    const half = r.width / 2;
    const edge = 2.0;
    eachVertexNear(hf, m.x, m.z, m.skirt + 10, (i, j, x, zz) => {
      let best = Infinity;
      let bh = 0;
      for (let s = 0; s < pts.length; s += 2) {
        const p = pts[s];
        const d2 = (p.x - x) * (p.x - x) + (p.z - zz) * (p.z - zz);
        if (d2 < best) {
          best = d2;
          bh = p.h;
        }
      }
      const d = Math.sqrt(best);
      if (d > half + edge) return;
      const w = 1 - smoothstep(half, half + edge, d);
      const k = j * n + i;
      H[k] = lerp(H[k], bh, w);
    });
  }

  // ---------- Pits (the quarry) ----------
  for (const p of t.pits) {
    eachVertexNear(hf, p.x, p.z, p.r + 2, (i, j, x, zz) => {
      const d = Math.hypot(x - p.x, zz - p.z);
      H[j * n + i] -= p.depth * (1 - smoothstep(p.r * p.floor, p.r, d));
    });
  }

  // ---------- Flattened ground: squares, fields, plots ----------
  const clear = new Uint8Array(t.cells * t.cells);
  const surf = hf.surface;
  const setCellSurface = (x: number, zz: number, s: number) => {
    const i = Math.floor((x - hf.min) / hf.cell);
    const j = Math.floor((zz - hf.min) / hf.cell);
    if (i >= 0 && j >= 0 && i < t.cells && j < t.cells) surf[j * t.cells + i] = s;
  };
  const markClear = (x: number, zz: number) => {
    const i = Math.floor((x - hf.min) / hf.cell);
    const j = Math.floor((zz - hf.min) / hf.cell);
    if (i >= 0 && j >= 0 && i < t.cells && j < t.cells) clear[j * t.cells + i] = 1;
  };
  // Surfaces are painted into this overlay first, then win over the automatic ones at the end.
  const painted = new Int16Array(t.cells * t.cells).fill(-1);
  const paint = (x: number, zz: number, s: number) => {
    const i = Math.floor((x - hf.min) / hf.cell);
    const j = Math.floor((zz - hf.min) / hf.cell);
    if (i >= 0 && j >= 0 && i < t.cells && j < t.cells) painted[j * t.cells + i] = s;
  };

  for (const f of t.flatten) {
    const target = f.h === 'auto' ? hf.height(f.x, f.z) : f.h;
    const isRect = f.w !== undefined && f.d !== undefined;
    const reach = (isRect ? Math.hypot(f.w! / 2, f.d! / 2) : f.r!) + f.fall + 2;
    const surfCode = f.surface ? SURFACE[f.surface as keyof typeof SURFACE] : -1;
    eachVertexNear(hf, f.x, f.z, reach, (i, j, x, zz) => {
      const k = j * n + i;
      let dist: number;
      if (isRect) {
        const ox = Math.max(0, Math.abs(x - f.x) - f.w! / 2);
        const oz = Math.max(0, Math.abs(zz - f.z) - f.d! / 2);
        dist = Math.sqrt(ox * ox + oz * oz);
      } else dist = Math.max(0, Math.hypot(x - f.x, zz - f.z) - f.r!);
      const fall = f.seaFall !== undefined && coast[k] < 0 ? f.seaFall : f.fall;
      const w = 1 - smoothstep(0, fall, dist);
      if (w > 0) H[k] = lerp(H[k], target, w);
      if (dist <= 0.01 && i < t.cells && j < t.cells) {
        const cx = x + hf.cell / 2;
        const cz = zz + hf.cell / 2;
        if (f.keepClear !== false) markClear(cx, cz);
        if (surfCode >= 0) {
          const inSurf = isRect ? true : Math.hypot(cx - f.x, cz - f.z) <= (f.surfaceR ?? f.r!);
          if (inSurf) paint(cx, cz, surfCode);
        }
      }
    });
  }

  // ---------- Structure pads: each building sits on level ground ----------
  const placements: ZonePlacement[] = [];
  const buildings: PlacedBuilding[] = [];
  const boxes: BoxCollider[] = [];
  const decks: Deck[] = [];
  const obstacles: Obstacle[] = [];
  for (const s of z.structures) {
    const def = structureDef(s.id);
    const deckish = def.deck !== undefined;
    if (!deckish && def.pad !== false) {
      const pad = hf.height(s.x, s.z);
      const reach = Math.hypot(def.w, def.d) / 2 + 3;
      eachVertexNear(hf, s.x, s.z, reach + 2, (i, j, x, zz) => {
        const [lx, lz] = toLocal(x - s.x, zz - s.z, s.rot);
        const ox = Math.max(0, Math.abs(lx) - def.w / 2 - 0.6);
        const oz = Math.max(0, Math.abs(lz) - def.d / 2 - 0.6);
        const w = 1 - smoothstep(0, 3, Math.sqrt(ox * ox + oz * oz));
        const k = j * n + i;
        if (w > 0) H[k] = lerp(H[k], pad, w);
      });
    }
  }

  // ---------- Roads: graded, smoothed, blended into the land ----------
  const roads: Generated['roads'] = [];
  for (const road of t.roads) {
    const pts = catmullRom(road.points, 2);
    // Height profile: follow the land, but smoothly, never steeper than a cart can pull.
    let prof = pts.map(([x, zz]) => Math.max(0.7, hf.height(x, zz)));
    for (let pass = 0; pass < 3; pass++) prof = movingAverage(prof, 7);
    const grade = 0.16;
    for (let k = 1; k < prof.length; k++) prof[k] = Math.max(prof[k - 1] - grade * 2, Math.min(prof[k - 1] + grade * 2, prof[k]));
    for (let k = prof.length - 2; k >= 0; k--) prof[k] = Math.max(prof[k + 1] - grade * 2, Math.min(prof[k + 1] + grade * 2, prof[k]));
    roads.push({ id: road.id, width: road.width, points: pts });
    const half = road.width / 2;
    const shoulder = 5;
    // Bucket the segments so each vertex only looks at the few nearby.
    const B = 16;
    const buckets = new Map<number, number[]>();
    const key = (bx: number, bz: number) => (bx + 1000) * 4096 + (bz + 1000);
    for (let k = 0; k < pts.length - 1; k++) {
      const [ax, az] = pts[k];
      const [bx, bz] = pts[k + 1];
      const x0 = Math.floor((Math.min(ax, bx) - half - shoulder) / B);
      const x1 = Math.floor((Math.max(ax, bx) + half + shoulder) / B);
      const z0 = Math.floor((Math.min(az, bz) - half - shoulder) / B);
      const z1 = Math.floor((Math.max(az, bz) + half + shoulder) / B);
      for (let gx = x0; gx <= x1; gx++)
        for (let gz = z0; gz <= z1; gz++) {
          const kk = key(gx, gz);
          let list = buckets.get(kk);
          if (!list) buckets.set(kk, (list = []));
          list.push(k);
        }
    }
    const nearest = (x: number, zz: number): { d: number; h: number } => {
      const list = buckets.get(key(Math.floor(x / B), Math.floor(zz / B)));
      let bd = Infinity;
      let bh = 0;
      if (!list) return { d: bd, h: bh };
      for (const k of list) {
        const [ax, az] = pts[k];
        const [bx, bz] = pts[k + 1];
        const ex = bx - ax;
        const ez = bz - az;
        const l2 = ex * ex + ez * ez || 1;
        let u = ((x - ax) * ex + (zz - az) * ez) / l2;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const px = ax + ex * u - x;
        const pz = az + ez * u - zz;
        const d = Math.sqrt(px * px + pz * pz);
        if (d < bd) {
          bd = d;
          bh = prof[k] + (prof[k + 1] - prof[k]) * u;
        }
      }
      return { d: bd, h: bh };
    };
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [x, zz] of pts) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, zz);
      maxZ = Math.max(maxZ, zz);
    }
    const pad = half + shoulder + 2;
    const i0 = Math.max(0, Math.floor((minX - pad - hf.min) / hf.cell));
    const i1 = Math.min(n - 1, Math.ceil((maxX + pad - hf.min) / hf.cell));
    const j0 = Math.max(0, Math.floor((minZ - pad - hf.min) / hf.cell));
    const j1 = Math.min(n - 1, Math.ceil((maxZ + pad - hf.min) / hf.cell));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const x = hf.vx(i);
        const zz = hf.vx(j);
        const near = nearest(x, zz);
        if (near.d > half + shoulder) continue;
        const w = 1 - smoothstep(half, half + shoulder, near.d);
        const k = j * n + i;
        H[k] = lerp(H[k], near.h, w);
        if (i < t.cells && j < t.cells) {
          const c = nearest(x + hf.cell / 2, zz + hf.cell / 2);
          const cell = j * t.cells + i;
          if (c.d <= half && painted[cell] !== SURFACE.plaza) painted[cell] = SURFACE.road;
          if (c.d <= half + (z.scatter.clearOfRoad ?? 4)) clear[cell] = 1;
        }
      }
  }

  // ---------- Surfaces ----------
  for (let j = 0; j < t.cells; j++)
    for (let i = 0; i < t.cells; i++) {
      const cell = j * t.cells + i;
      const x = hf.vx(i) + hf.cell / 2;
      const zz = hf.vx(j) + hf.cell / 2;
      if (painted[cell] >= 0) {
        surf[cell] = painted[cell];
        continue;
      }
      const h = hf.height(x, zz);
      const slope = hf.slope(x, zz);
      let s: number = SURFACE.grass;
      for (const f of z.forests) if (Math.hypot(x - f.x, zz - f.z) < f.r * 0.85) s = SURFACE.forest;
      if (h < t.sandBelow && coast[j * n + i] < 70) s = SURFACE.sand;
      if (slope > t.rockSlope) s = SURFACE.rock;
      surf[cell] = s;
    }

  // ---------- Buildings: colliders, decks, and what to draw where ----------
  for (const s of z.structures) {
    const def = structureDef(s.id);
    const y = def.seaLevel ? t.water : hf.height(s.x, s.z);
    placements.push({ kind: 'structure', id: s.id, x: s.x, y, z: s.z, rot: s.rot, tint: s.tint, seed: s.seed, decor: s.decor, mirror: s.mirror });
    const plan = def.collider === 'building' ? placedPlan(s.id, s.mirror) : undefined;
    if (plan) {
      const solid = buildingColliders(plan, s.x, s.z, s.rot, y);
      boxes.push(...solid.boxes);
      decks.push(...solid.decks);
      obstacles.push(...solid.obstacles);
      buildings.push({ id: s.id, plan, x: s.x, y, z: s.z, rot: s.rot, mirror: !!s.mirror, boxes: solid.boxes });
    } else addCollider(def, s.x, s.z, s.rot, y, boxes, obstacles);
    if (def.deck !== undefined) decks.push(rect(s.x, s.z, def.w / 2, def.d / 2, s.rot, y + def.deck));
    // Keep trees out of the way of everything built.
    const margin = def.clearMargin ?? z.scatter.clearOfStructure ?? 4;
    forCellsInRect(hf, s.x, s.z, def.w / 2 + margin, def.d / 2 + margin, s.rot, (cx, cz) => markClear(cx, cz));
    // Some say what the ground under them is (tilled soil under a farm plot).
    const ground = surfaceCode(def.surface);
    if (ground >= 0) forCellsInRect(hf, s.x, s.z, def.w / 2, def.d / 2, s.rot, (cx, cz) => setCellSurface(cx, cz, ground));
  }
  for (const p of z.housePlots) forCellsInRect(hf, p.x, p.z, 9, 9, p.rot, (cx, cz) => markClear(cx, cz));
  for (const nd of z.nodes) {
    const def = structureDef(nd.kind);
    const y = hf.height(nd.x, nd.z);
    placements.push({ kind: 'node', id: nd.kind, x: nd.x, y, z: nd.z, rot: nd.rot });
    addCollider(def, nd.x, nd.z, nd.rot, y, boxes, obstacles);
    forCellsInRect(hf, nd.x, nd.z, def.w / 2 + 2, def.d / 2 + 2, nd.rot, (cx, cz) => markClear(cx, cz));
  }
  for (const npc of z.npcs) forCellsInRect(hf, npc.x, npc.z, 2.5, 2.5, 0, (cx, cz) => markClear(cx, cz));
  forCellsInRect(hf, z.spawn.x, z.spawn.z, 4, 4, 0, (cx, cz) => markClear(cx, cz));
  for (const u of z.updrafts) forCellsInRect(hf, u.x, u.z, u.r, u.r, 0, (cx, cz) => markClear(cx, cz));

  // Props: placed one by one, in rings, along roads, or along fence lines.
  for (const p of z.props) {
    const def = propDef(p.id);
    const put = (x: number, zz: number, rot: number) => {
      const y = hf.height(x, zz);
      placements.push({ kind: 'prop', id: p.id, x, y, z: zz, rot });
      if (def.collider === 'post') obstacles.push({ kind: 'post' as Obstacle['kind'], x, z: zz, r: def.r ?? 0.2, scale: 1, rot });
      else if (def.collider === 'box') boxes.push(rect(x, zz, def.w / 2, def.d / 2, rot, y + def.h));
      markClear(x, zz);
    };
    if (p.ring) {
      for (let k = 0; k < p.ring.count; k++) {
        const a = p.ring.phase + (k / p.ring.count) * TAU;
        put(p.ring.x + Math.cos(a) * p.ring.r, p.ring.z + Math.sin(a) * p.ring.r, -a);
      }
    } else if (p.along) {
      const road = roads.find((r) => r.id === p.along);
      if (!road) continue;
      let acc = p.every! / 2;
      let side = 1;
      for (let k = 1; k < road.points.length; k++) {
        const [ax, az] = road.points[k - 1];
        const [bx, bz] = road.points[k];
        const seg = Math.hypot(bx - ax, bz - az);
        acc += seg;
        if (acc < p.every!) continue;
        acc = 0;
        const nx = -(bz - az) / (seg || 1);
        const nz = (bx - ax) / (seg || 1);
        const off = road.width / 2 + 1.2;
        put(bx + nx * off * side, bz + nz * off * side, Math.atan2(bx - ax, bz - az));
        side = -side;
      }
    } else if (p.line) {
      const [[ax, az], [bx, bz]] = p.line;
      const len = Math.hypot(bx - ax, bz - az);
      const count = Math.max(1, Math.round(len / def.w));
      const rot = Math.atan2(bx - ax, bz - az) + Math.PI / 2;
      for (let k = 0; k < count; k++) {
        const u = (k + 0.5) / count;
        put(ax + (bx - ax) * u, az + (bz - az) * u, rot);
      }
    } else put(p.x!, p.z!, p.rot ?? 0);
  }

  // ---------- Trees and rocks ----------
  const rng = makeRng(seed + 101);
  const G = 7;
  const span = hf.size;
  const cellsAcross = Math.floor(span / G);
  for (let gj = 0; gj < cellsAcross; gj++)
    for (let gi = 0; gi < cellsAcross; gi++) {
      const x = hf.min + (gi + rng()) * G;
      const zz = hf.min + (gj + rng()) * G;
      const roll = rng();
      const scale = range(rng, 0.8, 1.45);
      const rot = rng() * TAU;
      const h = hf.height(x, zz);
      if (h < 1.6) continue;
      const ci = Math.floor((x - hf.min) / hf.cell);
      const cj = Math.floor((zz - hf.min) / hf.cell);
      if (clear[cj * t.cells + ci]) continue;
      const s = surf[cj * t.cells + ci];
      const slope = hf.slope(x, zz);
      let density = z.scatter.trees;
      for (const f of z.forests) density += f.density * smoothstep(f.r, f.r * 0.35, Math.hypot(x - f.x, zz - f.z));
      if ((s === SURFACE.grass || s === SURFACE.forest) && slope < 0.75 && roll < density * G * G) {
        obstacles.push({ kind: 'tree', x, z: zz, r: 0.45 * scale, scale, rot });
        continue;
      }
      const rockChance = s === SURFACE.rock ? 0.09 : s === SURFACE.sand ? 0.004 : z.scatter.rocks * G * G;
      if (s !== SURFACE.road && s !== SURFACE.plaza && s !== SURFACE.soil && rng() < rockChance) {
        const rs = range(rng, 0.5, 1.5) * (s === SURFACE.rock ? 1.6 : 1);
        obstacles.push({ kind: 'rock', x, z: zz, r: 0.55 * rs, scale: rs, rot });
      }
    }

  // ---------- Waterfalls: a slot cut down the face for the water to fall free ----------
  // Cut last, so every tree and rock elsewhere stands where it always did (they're scattered from
  // one stream of random numbers, cell by cell): only what stood in the slot or a pool goes.
  const falls: WaterfallInfo[] = [];
  for (const f of t.falls ?? []) {
    const m = mountainAt.get(f.mountain);
    if (!m) continue;
    const ux = Math.cos(f.bearing);
    const uz = Math.sin(f.bearing);
    const vx = -uz;
    const vz = ux;
    const along = (x: number, zz: number) => (x - m.x) * ux + (zz - m.z) * uz;
    const across = (x: number, zz: number) => (x - m.x) * vx + (zz - m.z) * vz;
    const half = f.width / 2;
    const shelfEnd = f.lip + f.shelf.depth;
    const floorAt = (s: number) => lerp(f.floor[0], f.floor[1], Math.min(1, Math.max(0, (s - shelfEnd) / (f.foot - shelfEnd))));
    const sx = m.x + ux * f.spring.at;
    const sz = m.z + uz * f.spring.at;
    const springLevel = hf.height(sx, sz) - 0.06;
    const lipY = springLevel;
    const px = m.x + ux * f.plunge.at;
    const pz = m.z + uz * f.plunge.at;
    // A little under the floor at the pool's lowest edge (the floor falls toward the foot).
    const plungeLevel = floorAt(f.plunge.at + f.plunge.along) - 0.1;
    const inPlunge = (x: number, zz: number) => Math.hypot((along(x, zz) - f.plunge.at) / f.plunge.along, across(x, zz) / f.plunge.across);
    eachVertexNear(hf, m.x, m.z, f.foot + 12, (i, j, x, zz) => {
      const k = j * n + i;
      const s = along(x, zz);
      const tt = Math.abs(across(x, zz));
      // The spring: a shallow basin, its water just below the summit, and a runnel to the lip.
      const ds = Math.hypot(x - sx, zz - sz);
      if (ds < f.spring.r + 1) H[k] = Math.min(H[k], springLevel - f.spring.depth * (1 - smoothstep(f.spring.r * 0.55, f.spring.r, ds)));
      if (s > f.spring.at && s < f.lip + 0.5 && tt < RUNNEL) H[k] = Math.min(H[k], springLevel - 0.16);
      // The slot: sheer at the back, the ledge, then down to its floor; its walls blend into the face.
      if (s >= f.lip && s <= f.foot + 2 && tt <= half + f.blend) {
        const w = (1 - smoothstep(half, half + f.blend, tt)) * (1 - smoothstep(f.foot - 1, f.foot + 2, s));
        const target = s <= shelfEnd ? f.shelf.top : floorAt(s);
        if (w > 0 && target < H[k]) H[k] = lerp(H[k], target, w);
      }
      // The plunge pool, in the slot's floor.
      const e = inPlunge(x, zz);
      if (e < 1.15) H[k] = Math.min(H[k], plungeLevel - f.plunge.depth * (1 - smoothstep(0.6, 1, e)));
    });
    // Nothing grows, stands or lies about in the slot or the pools; their ground is bare.
    const inSlot = (x: number, zz: number, pad: number) => {
      const s = along(x, zz);
      return s >= f.lip - pad && s <= f.foot + 2 + pad && Math.abs(across(x, zz)) <= half + f.blend + pad;
    };
    for (let j = 0; j < t.cells; j++)
      for (let i = 0; i < t.cells; i++) {
        const x = hf.vx(i) + hf.cell / 2;
        const zz = hf.vx(j) + hf.cell / 2;
        if (Math.abs(x - m.x) > f.foot + 14 || Math.abs(zz - m.z) > f.foot + 14) continue;
        const cell = j * t.cells + i;
        const spring =
          Math.hypot(x - sx, zz - sz) < f.spring.r + 0.8 || (along(x, zz) > f.spring.at && along(x, zz) < f.lip + 0.5 && Math.abs(across(x, zz)) < RUNNEL);
        const plunge = inPlunge(x, zz) < 1.1;
        if (spring || plunge) {
          clear[cell] = 1;
          surf[cell] = SURFACE.sand;
        } else if (inSlot(x, zz, 0.5)) {
          clear[cell] = 1;
          surf[cell] = SURFACE.rock;
        }
      }
    for (let k = obstacles.length - 1; k >= 0; k--) {
      const o = obstacles[k];
      if (inSlot(o.x, o.z, 1.5) || Math.hypot(o.x - sx, o.z - sz) < f.spring.r + 1.5 || inPlunge(o.x, o.z) < 1.3) obstacles.splice(k, 1);
    }
    // The hood over the ledge: solid on top, open underneath for whoever glides in under it. Below
    // it, the goblins' landing stage (a deck you glide down onto) and their totem (a post).
    const turn = Math.PI / 2 - f.bearing;
    const at = (s: number, tt: number): [number, number] => [m.x + ux * s + vx * tt, m.z + uz * s + vz * tt];
    const roofTop = f.shelf.top + f.roof.above;
    const r0 = f.lip - 0.5;
    const r1 = f.lip + f.roof.depth;
    decks.push(rect(...at((r0 + r1) / 2, 0), half, (r1 - r0) / 2, turn, roofTop));
    const l0 = f.lip + f.landing.from;
    const l1 = f.lip + f.landing.to;
    const landingTop = f.shelf.top + f.landing.above;
    decks.push(rect(...at((l0 + l1) / 2, 0), f.landing.half, (l1 - l0) / 2, turn, landingTop));
    const totemTop = f.shelf.top + f.totem.above;
    boxes.push(rect(...at(f.lip + f.totem.at, f.totem.across), 0.35, 0.35, turn, totemTop));
    // The ledge's walls, as clean as the hood over them: the ground's cut is a slope a cell wide
    // (two metres), which whoever hits the back wall would otherwise slide down and off the side.
    boxes.push(rect(...at(f.lip + 1, 0), half + 1.2, 1.6, turn, roofTop));
    for (const side of [-1, 1]) boxes.push(rect(...at((f.lip - 1 + l1) / 2, side * (half + 0.9)), 1.2, (l1 - f.lip + 1) / 2, turn, roofTop));
    falls.push({
      id: f.id,
      cx: m.x,
      cz: m.z,
      ux,
      uz,
      vx,
      vz,
      lip: f.lip,
      lipY,
      foot: f.foot,
      width: f.width,
      speed: f.speed,
      shelf: { s0: f.lip, s1: shelfEnd, top: f.shelf.top },
      roof: { s0: r0, s1: r1, top: roofTop },
      landing: { s0: l0, s1: l1, half: f.landing.half, top: landingTop },
      totem: { s: f.lip + f.totem.at, t: f.totem.across, top: totemTop },
      floor: [f.floor[0], f.floor[1]],
      spring: { x: sx, z: sz, at: f.spring.at, r: f.spring.r, level: springLevel },
      plunge: { x: px, z: pz, s: f.plunge.at, along: f.plunge.along, across: f.plunge.across, level: plungeLevel },
    });
  }

  return { terrain: hf, obstacles, boxes, decks, roads, ramps, clear, placements, buildings, falls };
}

// ---------- helpers ----------

/** A surface's code by its name (SURFACE), or -1 for none or a name there's no surface of. */
function surfaceCode(name: string | undefined): number {
  return name !== undefined && Object.hasOwn(SURFACE, name) ? SURFACE[name as keyof typeof SURFACE] : -1;
}

function eachVertexNear(hf: Heightfield, cx: number, cz: number, r: number, fn: (i: number, j: number, x: number, z: number) => void): void {
  const i0 = Math.max(0, Math.floor((cx - r - hf.min) / hf.cell));
  const i1 = Math.min(hf.n - 1, Math.ceil((cx + r - hf.min) / hf.cell));
  const j0 = Math.max(0, Math.floor((cz - r - hf.min) / hf.cell));
  const j1 = Math.min(hf.n - 1, Math.ceil((cz + r - hf.min) / hf.cell));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(i, j, hf.vx(i), hf.vx(j));
}

/** World offset into a structure's own frame (its +Z is its front). */
export function toLocal(dx: number, dz: number, rot: number): [number, number] {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return [dx * c - dz * s, dx * s + dz * c];
}

/** A structure-local point back out into the world. */
export function toWorld(lx: number, lz: number, rot: number): [number, number] {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return [lx * c + lz * s, -lx * s + lz * c];
}

export function rect(x: number, z: number, hw: number, hd: number, rot: number, top: number): BoxCollider {
  return { x, z, hw, hd, rot, cos: Math.cos(rot), sin: Math.sin(rot), top };
}

function forCellsInRect(hf: Heightfield, x: number, z: number, hw: number, hd: number, rot: number, fn: (cx: number, cz: number) => void): void {
  const r = Math.hypot(hw, hd) + hf.cell;
  for (let cz = z - r; cz <= z + r; cz += hf.cell)
    for (let cx = x - r; cx <= x + r; cx += hf.cell) {
      const [lx, lz] = toLocal(cx - x, cz - z, rot);
      if (Math.abs(lx) <= hw && Math.abs(lz) <= hd) fn(cx, cz);
    }
}

function addCollider(def: StructureDef, x: number, z: number, rot: number, y: number, boxes: BoxCollider[], obstacles: Obstacle[]): void {
  if (def.collider === 'box') {
    const d = def.colliderD ?? def.d;
    const [ox, oz] = toWorld(0, def.colliderZ ?? 0, rot);
    boxes.push(rect(x + ox, z + oz, def.w / 2, d / 2, rot, y + def.h));
  } else if (def.collider === 'post') {
    obstacles.push({ kind: 'post' as Obstacle['kind'], x, z, r: def.r ?? 0.5, scale: 1, rot });
  } else if (def.collider === 'walls') {
    const t = def.wall ?? 0.3;
    const hw = def.w / 2;
    const hd = def.d / 2;
    const door = (def.door ?? 1.4) / 2;
    const top = y + def.h;
    const add = (lx: number, lz: number, w: number, d: number) => {
      const [ox, oz] = toWorld(lx, lz, rot);
      boxes.push(rect(x + ox, z + oz, w / 2, d / 2, rot, top));
    };
    add(0, -hd + t / 2, def.w, t); // back
    add(hw - t / 2, 0, t, def.d); // left side (+X)
    add(-hw + t / 2, 0, t, def.d); // right side (-X)
    const seg = hw - door;
    add(door + seg / 2, hd - t / 2, seg, t); // front, either side of the door
    add(-door - seg / 2, hd - t / 2, seg, t);
  }
}

/** Centripetal-ish Catmull-Rom through the control points, resampled about every `step` metres. */
function catmullRom(points: Array<[number, number]>, step: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const p = [points[0], ...points, points[points.length - 1]];
  for (let k = 1; k < p.length - 2; k++) {
    const [x0, z0] = p[k - 1];
    const [x1, z1] = p[k];
    const [x2, z2] = p[k + 1];
    const [x3, z3] = p[k + 2];
    const len = Math.hypot(x2 - x1, z2 - z1);
    const n = Math.max(1, Math.ceil(len / step));
    for (let s = 0; s < n; s++) {
      const u = s / n;
      const u2 = u * u;
      const u3 = u2 * u;
      const x = 0.5 * (2 * x1 + (-x0 + x2) * u + (2 * x0 - 5 * x1 + 4 * x2 - x3) * u2 + (-x0 + 3 * x1 - 3 * x2 + x3) * u3);
      const z = 0.5 * (2 * z1 + (-z0 + z2) * u + (2 * z0 - 5 * z1 + 4 * z2 - z3) * u2 + (-z0 + 3 * z1 - 3 * z2 + z3) * u3);
      out.push([x, z]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

function movingAverage(v: number[], half: number): number[] {
  return v.map((_, k) => {
    let s = 0;
    let c = 0;
    for (let o = -half; o <= half; o++) {
      const q = k + o;
      if (q < 0 || q >= v.length) continue;
      s += v[q];
      c++;
    }
    return s / c;
  });
}
