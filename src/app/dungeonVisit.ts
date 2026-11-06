import type { Life } from '../sim/life/life';
import type { Sim } from '../sim/sim';
import type { OpenStage } from '../render/open/stage';
import { arrivalOf, dungeonDef, dungeonDoor, inWorld, setDungeonSolid, type DungeonSolids } from '../sim/zone/dungeon';

// Going into a copy of a dungeon and out again, as this browser sees it: the dungeon's boxes and
// decks made solid in your world (and taken away again after), its cave drawn and the island put
// away, the portals' prompts told where you are, no rain under the rock. Offline (?world&test) this
// is the whole visit and it moves you too; online the server takes you (and your party) through and
// moves you, and this only follows (main.ts: onPortal and the server's word).

export interface VisitParts {
  sim: Sim;
  life: Life | null;
  stage: OpenStage | null;
  /** Puts the player down at a point, on whatever is solid there (offline only: online the server moves you). */
  place: (x: number, y: number, z: number, facing: number) => void;
  /** Under a roof of rock or out in the weather. */
  indoors?: (inside: boolean) => void;
}

export class DungeonVisit {
  /** The dungeon you're inside a copy of (null out on the island). */
  inside: string | null = null;
  private solids = new Map<string, DungeonSolids>();

  constructor(private d: VisitParts) {}

  /** Into a copy of `id`: solid, drawn, prompts and weather told; `move` puts you at its arrival point too. */
  enterDungeonHere(id: string, move: boolean): boolean {
    const def = dungeonDef(id);
    const index = this.d.sim.world.index;
    if (!def || !index) return false;
    if (this.inside && this.inside !== id) this.leaveDungeonHere(false);
    this.solids.set(id, setDungeonSolid(index, def, this.solids.get(id) ?? null, true));
    this.inside = id;
    // Knocked down in it, you get up where it's entered (as the server has it: open/dungeon.rs).
    this.d.sim.world.respawnAt = arrivalOf(def);
    if (this.d.life) this.d.life.dungeon = id;
    this.d.stage?.enterDungeon(def);
    this.d.indoors?.(true);
    if (move) {
      const a = arrivalOf(def);
      this.d.place(a.x, a.y, a.z, a.facing);
    }
    return true;
  }

  /** Out again: the dungeon's boxes and decks gone from your world; `move` puts you outside its door. */
  leaveDungeonHere(move: boolean): boolean {
    const id = this.inside;
    if (!id) return false;
    const def = dungeonDef(id);
    const index = this.d.sim.world.index;
    const had = this.solids.get(id);
    if (def && index && had) setDungeonSolid(index, def, had, false);
    this.inside = null;
    this.d.sim.world.respawnAt = undefined;
    if (this.d.life) this.d.life.dungeon = null;
    this.d.stage?.leaveDungeon();
    this.d.indoors?.(false);
    const zone = this.d.sim.world.zone;
    const door = zone ? dungeonDoor(zone.recipe, id) : undefined;
    if (move && door) this.d.place(door.outside.x, door.portal.y, door.outside.z, door.outside.facing);
    return true;
  }

  /** Offline: fallen out of the bottom of the dungeon, you're back where you came in (the server does this online). */
  catchFall(): boolean {
    const def = this.inside ? dungeonDef(this.inside) : undefined;
    if (!def) return false;
    const p = this.d.sim.player;
    if (p.pos.y >= def.origin.y + def.fall) return false;
    const a = arrivalOf(def);
    this.d.place(a.x, a.y, a.z, a.facing);
    return true;
  }

  /** The floor's height inside the dungeon you're in (null out on the island). */
  floorHere(): number | null {
    const def = this.inside ? dungeonDef(this.inside) : undefined;
    return def ? def.origin.y : null;
  }

  /** For tests: where you are and whether the dungeon is solid in your world. */
  state(): { inside: string | null; solid: Record<string, boolean>; exit: { x: number; y: number; z: number } | null } {
    const def = this.inside ? dungeonDef(this.inside) : undefined;
    return {
      inside: this.inside,
      solid: Object.fromEntries([...this.solids].map(([k, s]) => [k, s.solid])),
      exit: def ? inWorld(def, def.exit.x, def.exit.z) : null,
    };
  }
}
