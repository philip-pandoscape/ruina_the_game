import * as THREE from 'three';
import type { DungeonDef, DungeonPiece } from '../../engine/zone';
import { toon } from '../toon';
import { portalVeil } from './goblinKit';

// A developer zone drawn as an open arena (content/dungeons/<id>.json with `style: "arena"`: the
// yard, the battlefield): its floor, rails, posts and rocks as sand, timber and stone under the
// island's own sky, and its way out as a portal. Like a dungeon's cave it's drawn only while you're
// in a copy of it (stage.ts enterDungeon); unlike a cave it keeps the world's light, so it isn't
// `dark`, and the island stays in view far below.

const SAND = 0xcdb68b;
const TIMBER = 0x7a5233;
const STONE = 0x8d8a82;

/** What a piece is made of, by its name in the zone's file. */
function colourOf(p: DungeonPiece, floor: boolean): number {
  if (floor) return SAND;
  return /rock|ramp/i.test(p.id) ? STONE : TIMBER;
}

export class ArenaView {
  readonly group = new THREE.Group();
  /** Lit by the world's sky, not by its own light as a cave is. */
  readonly dark = false;
  private veil = { uTime: { value: 0 } as THREE.IUniform };

  constructor(readonly def: DungeonDef) {
    this.group.name = `arena-${def.id}`;
    for (const b of def.boxes) this.group.add(this.piece(b, b.id === 'floor'));
    for (const d of def.decks) this.group.add(this.piece(d, true));
    // The way out, standing on the floor, facing into the arena.
    const veil = portalVeil(2.2, 3.2, this.veil);
    veil.position.set(def.exit.x, 0, def.exit.z);
    veil.name = 'arena-exit';
    this.group.add(veil);
    this.group.visible = false;
  }

  /** A box of the zone's: a floor is a slab under its top; anything else stands from the floor up to its top. */
  private piece(p: DungeonPiece, floor: boolean): THREE.Mesh {
    const height = floor ? 2 : Math.max(0.1, p.top);
    const m = new THREE.Mesh(new THREE.BoxGeometry(p.hw * 2, height, p.hd * 2), toon(colourOf(p, floor)));
    m.position.set(p.x, p.top - height / 2, p.z);
    m.rotation.y = p.rot;
    m.castShadow = !floor;
    m.receiveShadow = true;
    m.name = `arena-${p.id}`;
    return m;
  }

  update(time: number): void {
    this.veil.uTime.value = time;
  }
}
