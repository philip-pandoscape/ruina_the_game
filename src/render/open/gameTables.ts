import * as THREE from 'three';
import { MINIGAMES, TABLE } from '../../content/minigames';
import type { PlayerState } from '../../engine/rules';
import { PAL, Parts, TAU, box, cyl, mesh } from '../models/kit';
import type { Seated } from './life';

// The tables thrown down for mini-games (src/ui/minigames), as everyone in the channel sees them:
// a round tavern table with the game's board on it and a stool either side, the two players
// sitting at it with their hands on the table. Each game draws its own board and pieces on the
// table (gameBoards/<id>.ts, found by the game's id, as its board view in the game window is), so
// onlookers can follow the game. Drawn from the server's ticks (src/net/worldLink.ts TableShown);
// the table is gone when the server clears it.
//
// Model conventions as src/render/models: metres, +Y up, the table's seat 1 along +Z of its own
// frame (rot, a heading, turns that to the world).

/** A game's board on a table in the world: gameBoards/<id>.ts exports one as `board`. */
export interface TableBoard {
  /** The board itself, in the table's frame with its top at y = 0 (built once: every table of the game is alike). */
  build(game: number): THREE.BufferGeometry;
  /** Its pieces as the server shows the table (`board`, in the game's own terms), likewise, and how many there are. */
  pieces(game: number, shown: unknown): { geometry: THREE.BufferGeometry | null; count: number };
}

const BOARDS = import.meta.glob<TableBoard>('./gameBoards/*.ts', { eager: true, import: 'board' });

/** Game `game`'s board, if it has one to put on a table. */
function boardOf(game: number): TableBoard | undefined {
  const id = MINIGAMES[game]?.id;
  return id === undefined ? undefined : BOARDS[`./gameBoards/${id}.ts`];
}

/** Heights above the ground: the table's top, and a stool's seat. */
const TOP = 0.72;
const STOOL = 0.42;
const TABLE_R = 0.62;
/** Where a seated player's feet go: on the ground, this far in front of the stool. */
const FEET_AHEAD = 0.3;
/** Hands on the table: this far in from its edge, and apart. */
const HANDS_IN = 0.16;
const HANDS_APART = 0.36;

const TABLE_WOOD = 0x9a6a3c;

let tableGeo: THREE.BufferGeometry | null = null;
/** Each game's board, by its index (every table of a game is alike). */
const boardGeo = new Map<number, THREE.BufferGeometry | null>();

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

/** Game `game`'s board (cached), or null for a game with nothing to put on the table. */
function boardGeometry(game: number): THREE.BufferGeometry | null {
  if (!boardGeo.has(game)) {
    const geo = boardOf(game)?.build(game) ?? null;
    if (geo) geo.name = `gameBoard:${MINIGAMES[game]?.id}`;
    boardGeo.set(game, geo);
  }
  return boardGeo.get(game) ?? null;
}

/** A table as the server has it, as much as drawing it needs (src/net/worldLink.ts's TableShown). */
export interface ShownTable {
  id: number;
  /** The game played at it: its place in shared/minigames.json. */
  game: number;
  /** Its middle on the ground, and the way from seat 0 to seat 1 (x = sin, z = cos). */
  x: number;
  y: number;
  z: number;
  rot: number;
  /** Who sits in each seat. */
  seats: ReadonlyArray<{ id: number; name: string }>;
  /** What everyone sees of the game, in the game's own terms (its table board reads it). */
  board: unknown;
}

interface Shown {
  data: ShownTable;
  root: THREE.Group;
  pieces: THREE.Mesh | null;
  piecesKey: string;
  count: number;
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
      const key = JSON.stringify(t.board ?? null);
      if (key !== s.piecesKey) {
        s.piecesKey = key;
        if (s.pieces) {
          s.root.remove(s.pieces);
          s.pieces.geometry.dispose();
          s.pieces = null;
        }
        const pieces = boardOf(t.game)?.pieces(t.game, t.board) ?? { geometry: null, count: 0 };
        s.count = pieces.count;
        if (pieces.geometry) {
          s.pieces = mesh(s.root, pieces.geometry, { name: 'gameTablePieces', shadow: false });
          s.pieces.position.y = TOP;
        }
      }
      t.seats.forEach((seat, k) => this.seats.set(seat.id, { table: t.id, seat: k }));
    }
    for (const [id, s] of this.shown) {
      if (live.has(id)) continue;
      this.group.remove(s.root);
      s.pieces?.geometry.dispose();
      this.shown.delete(id);
    }
  }

  private build(t: ShownTable): Shown {
    const root = new THREE.Group();
    root.name = `gameTable:${t.id}`;
    root.position.set(t.x, t.y, t.z);
    root.rotation.y = t.rot;
    mesh(root, tableGeometry(), { name: 'gameTableBody' });
    const board = boardGeometry(t.game);
    if (board) mesh(root, board, { name: 'gameTableBoard' }).position.y = TOP;
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
    return { data: t, root, pieces: null, piecesKey: '', count: 0, holds };
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

  /** For tests: the tables drawn, with who sits at them and how many pieces are on the board. */
  list(): Array<{ id: number; x: number; z: number; seats: string[]; pieces: number }> {
    return [...this.shown.values()].map((s) => ({
      id: s.data.id,
      x: s.data.x,
      z: s.data.z,
      seats: s.data.seats.map((x) => x.name),
      pieces: s.count,
    }));
  }
}
