import type { Engine } from '../engine/engine';
import type { OpenStage } from '../render/open/stage';
import { arrivalOf, dungeonDef, dungeonDoor } from '../engine/zone';

// Going into a copy of a dungeon and out again, as this browser sees it: a space of its own played
// in place of the world and the world back after (the engine's: Engine.enterDungeon), its cave or
// arena drawn and the island put away, no rain under the rock. Offline (?test) this is the
// whole visit and it moves you too; online the server takes you (and your party) through and moves
// you, and this only follows (main.ts: onPortal and the server's word).

export interface VisitParts {
  engine: Engine;
  stage: OpenStage | null;
  /** Puts the player down at a point, on whatever is solid there, the camera following. */
  place: (x: number, y: number, z: number, facing: number) => void;
  /** Under a roof of rock or out in the weather. */
  indoors?: (inside: boolean) => void;
}

export class DungeonVisit {
  constructor(private d: VisitParts) {}

  /** The dungeon you're inside a copy of (null out on the island). */
  get inside(): string | null {
    return this.d.engine.inside;
  }

  /** Into a copy of `id`: solid, drawn, prompts and weather told; `move` puts you at its arrival point too. */
  enterDungeonHere(id: string, move: boolean): boolean {
    const def = dungeonDef(id);
    if (!def || !this.d.engine.world.index) return false;
    if (this.inside && this.inside !== id) this.leaveDungeonHere(false);
    this.d.engine.enterDungeon(id);
    this.d.stage?.enterDungeon(def);
    this.d.indoors?.(true);
    if (move) {
      const a = arrivalOf(def);
      this.d.place(a.x, a.y, a.z, a.facing);
    }
    return true;
  }

  /** Out again: the dungeon's floors and walls gone from your world; `move` puts you outside its door. */
  leaveDungeonHere(move: boolean): boolean {
    const id = this.inside;
    if (!id) return false;
    this.d.engine.leaveDungeon();
    this.d.stage?.leaveDungeon();
    this.d.indoors?.(false);
    const zone = this.d.engine.world.zone;
    const door = zone ? dungeonDoor(zone.recipe, id) : undefined;
    if (move && door) this.d.place(door.outside.x, door.portal.y, door.outside.z, door.outside.facing);
    return true;
  }

  /** The floor at (x, z) of the dungeon you're in, where it has one (null out on the island, or off its floor). */
  floorAt(x: number, z: number): number | null {
    return this.d.engine.floorAt(x, z);
  }

  /** The floor's height inside the dungeon you're in (null out on the island). */
  floorHere(): number | null {
    return this.d.engine.floorHere();
  }

  /** For tests: where you are and whether the dungeon is solid in your world. */
  state(): { inside: string | null; solid: Record<string, boolean>; exit: { x: number; y: number; z: number } | null } {
    const def = this.inside ? dungeonDef(this.inside) : undefined;
    return { inside: this.inside, solid: this.d.engine.solidity(), exit: def ? { x: def.exit.x, y: 0, z: def.exit.z } : null };
  }
}
