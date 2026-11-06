import * as THREE from 'three';
import { BEACONS, HEXES, OLD_BEACON, SEAT_COLORS, TABLE, hexCentre } from '../../content/minigames';
import type { PlayerState } from '../../sim/types';
import { PAL, Parts, TAU, box, cyl, mesh, mix } from '../models/kit';
import type { Seated } from './life';

// The tables thrown down for mini-games (src/ui/minigames), as everyone in the channel sees them:
// a round tavern table with the game's board on it and a stool either side, the two players
// sitting at it with their hands on the table. Beacons' board shows each hex's good in its colour
// and every lit beacon as a peg in its player's colour, so onlookers can follow the game. Drawn
// from the server's ticks (src/net/worldLink.ts TableShown); the table is gone when the server
// clears it.
//
// Model conventions as src/render/models: metres, +Y up, the table's seat 1 along +Z of its own
// frame (rot, a heading, turns that to the world).

/** Heights above the ground: the table's top, and a stool's seat. */
const TOP = 0.72;
const STOOL = 0.42;
const TABLE_R = 0.62;
/** Board hexes, middle to corner. */
const HEX = 0.05;
/** Where a seated player's feet go: on the ground, this far in front of the stool. */
const FEET_AHEAD = 0.3;
/** Hands on the table: this far in from its edge, and apart. */
const HANDS_IN = 0.16;
const HANDS_APART = 0.36;

const TABLE_WOOD = 0x9a6a3c;

let tableGeo: THREE.BufferGeometry | null = null;

/** The table and both stools in the table's own frame (cached: every table is alike). */
function tableGeometry(): THREE.BufferGeometry {
  if (tableGeo) return tableGeo;
  const p = new Parts();
  // Round top on a turned pedestal, three feet.
  p.add(cyl(TABLE_R, TABLE_R, 0.05, 20), TABLE_WOOD, [0, TOP - 0.025, 0]);
  p.add(cyl(TABLE_R - 0.03, TABLE_R - 0.06, 0.05, 20), PAL.woodDark, [0, TOP - 0.075, 0]);
  p.add(cyl(0.07, 0.09, TOP - 0.12, 8), PAL.woodDark, [0, (TOP - 0.12) / 2 + 0.03, 0]);
  p.add(cyl(0.13, 0.16, 0.06, 8), PAL.woodDark, [0, 0.03, 0]);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU + 0.5;
    p.add(box(0.07, 0.05, 0.42), PAL.woodDeep, [Math.sin(a) * 0.2, 0.025, Math.cos(a) * 0.2], [0, a, 0]);
  }
  // The board: a dark hexagonal plank with a brass rim.
  const boardR = HEX * Math.sqrt(3) * 3.75;
  p.add(cyl(boardR + 0.02, boardR + 0.02, 0.012, 6), PAL.brass, [0, TOP + 0.006, 0], [0, Math.PI / 6, 0]);
  p.add(cyl(boardR, boardR, 0.016, 6), PAL.woodDeep, [0, TOP + 0.01, 0], [0, Math.PI / 6, 0]);
  // Each hex in its good's colour; the Old Beacon dark, with a little brass lantern.
  for (let i = 0; i < HEXES.length; i++) {
    const h = HEXES[i];
    const c = hexCentre(h, HEX);
    const good = BEACONS.goods[h.good];
    const colour = good ? mix(new THREE.Color(good.color), 0xf6ecd2, 0.25) : PAL.iron;
    p.add(cyl(HEX * 0.9, HEX * 0.9, 0.012, 6), colour, [c.x, TOP + 0.022, c.y]);
  }
  p.add(cyl(0.012, 0.016, 0.05, 6), PAL.brass, [0, TOP + 0.05, 0]);
  p.add(box(0.03, 0.03, 0.03), PAL.glow, [0, TOP + 0.085, 0], undefined, undefined, { glow: 1.4 });
  p.add(cyl(0.004, 0.022, 0.02, 4), PAL.brass, [0, TOP + 0.108, 0], [0, Math.PI / 4, 0]);
  // A stool either side, three-legged.
  for (const side of [-1, 1]) {
    const z = side * TABLE.seat;
    p.add(cyl(0.17, 0.16, 0.05, 10), PAL.wood, [0, STOOL - 0.025, z]);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * TAU;
      const [lx, lz] = [Math.sin(a) * 0.11, Math.cos(a) * 0.11];
      p.add(cyl(0.022, 0.026, STOOL - 0.05, 5), PAL.woodDark, [lx, (STOOL - 0.05) / 2, z + lz], [-lz * 0.6, 0, lx * 0.6]);
    }
  }
  tableGeo = p.build();
  tableGeo.name = 'gameTable';
  return tableGeo;
}

/** The pegs of the lit beacons, and a gold ring round each hex of a winning row. */
function pegGeometry(lit: readonly number[], row: readonly number[]): THREE.BufferGeometry | null {
  const p = new Parts();
  for (let i = 0; i < lit.length && i < HEXES.length; i++) {
    if (!lit[i]) continue;
    const c = hexCentre(HEXES[i], HEX);
    const colour = new THREE.Color(SEAT_COLORS[lit[i] - 1] ?? '#ffffff');
    const tall = i === OLD_BEACON ? 0.02 : 0;
    p.add(cyl(0.017, 0.02, 0.045, 7), colour, [c.x, TOP + 0.05 + tall, c.y]);
    p.add(cyl(0.006, 0.017, 0.016, 7), mix(colour, 0xffffff, 0.45), [c.x, TOP + 0.08 + tall, c.y], undefined, undefined, { glow: 1.2 });
  }
  for (const i of row) {
    const h = HEXES[i];
    if (!h) continue;
    const c = hexCentre(h, HEX);
    p.add(cyl(HEX * 0.98, HEX * 0.98, 0.006, 6), PAL.gold, [c.x, TOP + 0.031, c.y], undefined, undefined, { glow: 1.3 });
  }
  return p.empty ? null : p.build();
}

/** A table as the server has it, as much as drawing it needs (src/net/worldLink.ts's TableShown). */
export interface ShownTable {
  id: number;
  /** Its middle on the ground, and the way from seat 0 to seat 1 (x = sin, z = cos). */
  x: number;
  y: number;
  z: number;
  rot: number;
  /** Who sits in each seat. */
  seats: ReadonlyArray<{ id: number; name: string }>;
  /** Beacons: who lit each hex (0 nobody, 1 seat 0, 2 seat 1) and the winning row. */
  board: { lit: readonly number[]; row: readonly number[] };
}

interface Shown {
  data: ShownTable;
  root: THREE.Group;
  pegs: THREE.Mesh | null;
  pegKey: string;
  /** Per seat: where the hands rest and the feet go. */
  holds: Array<{ hands: [THREE.Object3D, THREE.Object3D]; feet: THREE.Object3D }>;
}

/** A player at a table is drawn sitting: their state as the seated poses read it. */
export function seatedState(p: PlayerState): PlayerState {
  return { ...p, mode: 'ride' };
}

export class GameTables {
  readonly group = new THREE.Group();
  private shown = new Map<number, Shown>();
  /** Who sits where: character -> (table, seat). */
  private seats = new Map<number, { table: number; seat: number }>();

  constructor(scene: THREE.Scene) {
    this.group.name = 'gameTables';
    scene.add(this.group);
  }

  /** The tables near you this frame (from the server's newest tick). */
  update(list: readonly ShownTable[]): void {
    const live = new Set<number>();
    this.seats.clear();
    for (const t of list) {
      live.add(t.id);
      let s = this.shown.get(t.id);
      if (!s) {
        s = this.build(t);
        this.shown.set(t.id, s);
      }
      s.data = t;
      const key = `${t.board?.lit?.join('')}|${t.board?.row?.join(',')}`;
      if (key !== s.pegKey) {
        s.pegKey = key;
        if (s.pegs) {
          s.root.remove(s.pegs);
          s.pegs.geometry.dispose();
          s.pegs = null;
        }
        const geo = pegGeometry(t.board?.lit ?? [], t.board?.row ?? []);
        if (geo) s.pegs = mesh(s.root, geo, { name: 'gameTablePegs', shadow: false });
      }
      t.seats.forEach((seat, k) => this.seats.set(seat.id, { table: t.id, seat: k }));
    }
    for (const [id, s] of this.shown) {
      if (live.has(id)) continue;
      this.group.remove(s.root);
      s.pegs?.geometry.dispose();
      this.shown.delete(id);
    }
  }

  private build(t: ShownTable): Shown {
    const root = new THREE.Group();
    root.name = `gameTable:${t.id}`;
    root.position.set(t.x, t.y, t.z);
    root.rotation.y = t.rot;
    mesh(root, tableGeometry(), { name: 'gameTableBody' });
    this.group.add(root);
    const holds = [-1, 1].map((side) => {
      const z = side * (TABLE_R - HANDS_IN);
      const at = (x: number, y: number, zz: number) => {
        const o = new THREE.Object3D();
        o.position.set(x, y, zz);
        root.add(o);
        return o;
      };
      // Seat 0 (side -1) faces +Z: its left hand is on its +X side.
      const hands: [THREE.Object3D, THREE.Object3D] = [at((-side * HANDS_APART) / 2, TOP + 0.03, z), at((side * HANDS_APART) / 2, TOP + 0.03, z)];
      const feet = at(0, 0.02, side * (TABLE.seat - FEET_AHEAD));
      return { hands, feet };
    });
    root.updateMatrixWorld(true);
    return { data: t, root, pegs: null, pegKey: '', holds };
  }

  /** Where character `id` sits if they're at a table: their stool, turned to the board, with their hands on the table. */
  seatOf(id: number): Seated | null {
    const at = this.seats.get(id);
    const s = at ? this.shown.get(at.table) : undefined;
    if (!at || !s) return null;
    const t = s.data;
    const side = at.seat === 0 ? -1 : 1;
    const facing = at.seat === 0 ? t.rot : t.rot + Math.PI;
    const position = new THREE.Vector3(t.x + Math.sin(t.rot) * side * TABLE.seat, t.y + STOOL, t.z + Math.cos(t.rot) * side * TABLE.seat);
    const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), facing);
    return { position, quaternion, pose: 'drive', holds: s.holds[at.seat] };
  }

  /** For tests: the tables drawn, with who sits at them and how many pegs are lit. */
  list(): Array<{ id: number; x: number; z: number; seats: string[]; pegs: number }> {
    return [...this.shown.values()].map((s) => ({
      id: s.data.id,
      x: s.data.x,
      z: s.data.z,
      seats: s.data.seats.map((x) => x.name),
      pegs: (s.data.board?.lit ?? []).filter(Boolean).length,
    }));
  }
}
