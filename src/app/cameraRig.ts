// The camera's sense of where it is (src/render/camera.ts asks): over hills and water it doesn't dip
// into the ground or under the sea, indoors not below the floor of your storey; it pulls in rather
// than looking through a wall; and under a hood of rock it keeps the eye under the hood.
import type { Engine } from '../engine/engine';
import { inRect, type BoxCollider, type Deck } from '../engine/zone';
import type { FollowCamera } from '../render/camera';
import type { OpenStage } from '../render/open/stage';

export function rigCamera(follow: FollowCamera, engine: Engine, openStage: OpenStage | null): void {
  const { terrain, world } = engine;
  // Over hills and water the camera must not dip into the ground or under the sea, and it pulls in
  // rather than looking through a wall.
  if (terrain)
    follow.groundAt = (x, z) => {
      // Indoors, not below the floor of the storey you are on.
      const inside = openStage?.village.indoors;
      let floor = -Infinity;
      if (inside) {
        const b = inside.building;
        const c = Math.cos(b.rot);
        const s = Math.sin(b.rot);
        const lx = (x - b.x) * c - (z - b.z) * s;
        const lz = (x - b.x) * s + (z - b.z) * c;
        if (Math.abs(lx) < b.plan.w / 2 && Math.abs(lz) < b.plan.d / 2) floor = inside.floor + 0.45;
      }
      return Math.max(terrain.water + 0.35, terrain.height(x, z) + 0.45, floor);
    };
  // Goblin's Dread: under the hood of rock over the ledge behind the Windspire's falls the ground
  // behind you is the cliff above the hood, so the eye stays under the hood instead (camera.ts).
  if (terrain && world.index) {
    const idx = world.index;
    follow.terrainAt = (x, z) => terrain.height(x, z);
    follow.ceiling = (x, y, z) => {
      const found: { d: Deck | null } = { d: null };
      idx.eachDeck(x, z, 0.5, (d) => {
        if (d.top > y + 1 && d.top < y + 12 && inRect(d, x, z) && (!found.d || d.top < found.d.top)) found.d = d;
      });
      const hood = found.d;
      if (!hood) return null;
      const eye = hood.top - 2.1;
      // Only a hood with room for the eye under it, above the ground and the sea (not a pier over a swimmer).
      if (eye < Math.max(terrain.water, terrain.height(x, z)) + 1.2) return null;
      return { eye, under: (px, pz) => inRect(hood, px, pz, 0.6) };
    };
  }
  if (world.index) {
    const idx = world.index;
    follow.blocker = (fx, fy, fz, cx, cy, cz) => {
      let best = 1;
      const mx = (fx + cx) / 2;
      const mz = (fz + cz) / 2;
      const reach = Math.hypot(cx - fx, cz - fz) / 2 + 1;
      const village = openStage?.village ?? null;
      const indoors = village?.indoors ?? null;
      /** Where along the segment it first meets a box (padded), unless it passes over the box's top. */
      const meet = (b: BoxCollider, top: number, pad: number) => {
        // The segment in the box's own frame, clipped against its padded footprint.
        const ax = fx - b.x;
        const az = fz - b.z;
        const bx = cx - b.x;
        const bz = cz - b.z;
        const la = [ax * b.cos - az * b.sin, ax * b.sin + az * b.cos];
        const lb = [bx * b.cos - bz * b.sin, bx * b.sin + bz * b.cos];
        const half = [b.hw + pad, b.hd + pad];
        let t0 = 0;
        let t1 = 1;
        for (let k = 0; k < 2; k++) {
          const d = lb[k] - la[k];
          if (Math.abs(d) < 1e-9) {
            if (Math.abs(la[k]) > half[k]) return;
            continue;
          }
          const ta = (-half[k] - la[k]) / d;
          const tb = (half[k] - la[k]) / d;
          t0 = Math.max(t0, Math.min(ta, tb));
          t1 = Math.min(t1, Math.max(ta, tb));
          if (t0 > t1) return;
        }
        // Passing over the roof is fine.
        if (fy + (cy - fy) * t0 > top) return;
        best = Math.min(best, t0);
      };
      idx.eachBox(mx, mz, reach, (b) => {
        if (b.top < -1e8) return;
        // The building you are in holds the camera with its whole walls, below (indoors.shell).
        if (indoors && village?.inIndoors(b.x, b.z)) return;
        meet(b, b.top, 0.25);
      });
      // Every building's walls, doorways and all: the camera never slips into one through its door, and
      // indoors the room keeps it in up to where the house is cut open.
      village?.eachShell(mx, mz, reach, (w, top) => meet(w, top, 0.2));
      return Math.max(0.12, best - 0.03);
    };
  }
}
