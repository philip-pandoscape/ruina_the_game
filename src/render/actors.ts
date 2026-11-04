import * as THREE from 'three';
import { SpeciesCrowd } from '../species/crowd';
import { getSpecies } from '../species/registry';
import { actorKind } from '../content/actors';
import { actorKindAt } from '../content/actors';
import { isAlive, type Actor } from '../sim/actor';
import { behaviour, stateName, stateProgress } from '../sim/ai/brain';
import type { NetActor } from '../net/netCrowd';

// Draws every actor that has a species, whatever kind it is. One instanced crowd per species,
// so a yard with five slimes and a yard with five hundred cost the same number of draw calls,
// and adding a monster needs no renderer at all - only a content entry naming its species.

const HIDDEN_Y = -1000; // where an actor waits out its respawn

const packKey = (k: { species: string | null; palette?: { teamA: number; teamB: number } }): string =>
  k.palette ? `${k.species}:${k.palette.teamA}:${k.palette.teamB}` : `${k.species}`;

/** The neutral shape both the local rules and the server's snapshots are turned into. */
interface Shown {
  kindId: string;
  x: number;
  y: number;
  z: number;
  facing: number;
  state: string;
  progress: number;
  alive: boolean;
  deadFrame: number;
  flash: number;
}

interface Pack {
  crowd: SpeciesCrowd;
  clipIndex: Map<string, number>;
  clipSeconds: Map<string, number>;
  used: number;
}

export class ActorView {
  readonly group = new THREE.Group();
  private packs = new Map<string, Pack>();

  /**
   * `capacity` is the most actors of any one species that can be on screen at once. `ground`, in
   * an open world, is the terrain height to stand them on.
   */
  constructor(kinds: readonly string[], private capacity = 64, private ground: ((x: number, z: number) => number) | null = null) {
    for (const id of kinds) {
      const kind = actorKind(id);
      // One crowd per body and colouring: villagers in different clothes share the body, not the paint.
      if (!kind.species || this.packs.has(packKey(kind))) continue;
      const species = getSpecies(kind.species);
      const crowd = new SpeciesCrowd(species, capacity, {
        tint: true,
        outlineThickness: 0.015,
        palette: kind.palette,
      });
      crowd.setCount(capacity);
      this.group.add(crowd.group);
      const clipIndex = new Map<string, number>();
      const clipSeconds = new Map<string, number>();
      species.clips.forEach((c, i) => {
        clipIndex.set(c.name, i);
        clipSeconds.set(c.name, c.frames / c.fps);
      });
      this.packs.set(packKey(kind), { crowd, clipIndex, clipSeconds, used: 0 });
    }
  }

  /**
   * Draws what the server says is out there. The wire carries the behaviour state and how far
   * through it the actor is, which is all the clip choice needs - the rest the browser already
   * knows from shared/actors.json.
   */
  fromNetwork(actors: readonly NetActor[]): void {
    this.draw(
      actors.map((a) => {
        const kind = actorKindAt(a.kind);
        const b = kind?.brain ? behaviour(kind.brain) : undefined;
        return {
          kindId: kind?.id ?? '',
          x: a.x,
          y: a.y,
          z: a.z,
          facing: a.facing,
          state: b?.states[a.state]?.name ?? 'idle',
          progress: a.progress,
          alive: a.deadFrame < 0,
          deadFrame: Math.max(0, a.deadFrame),
          flash: 999,
        };
      }),
    );
  }

  update(actors: readonly Actor[]): void {
    this.draw(
      actors.map((a) => ({
        kindId: a.kind,
        x: a.x,
        y: a.y,
        z: a.z,
        facing: a.facing,
        state: stateName(a),
        progress: stateProgress(a),
        alive: isAlive(a),
        deadFrame: Math.max(0, a.deadFrame),
        flash: a.flashFrame,
      })),
    );
  }

  private draw(actors: readonly Shown[]): void {
    for (const p of this.packs.values()) p.used = 0;

    for (const a of actors) {
      if (!a.kindId) continue;
      const kind = actorKind(a.kindId);
      if (!kind.species) continue;
      const pack = this.packs.get(packKey(kind));
      if (!pack || pack.used >= this.capacity) continue;
      const slot = pack.used++;

      const dead = !a.alive;
      const want = dead ? kind.clips.dead : kind.clips[a.state];
      const clip = pack.clipIndex.get(want ?? '') ?? 0;
      const seconds = pack.clipSeconds.get(want ?? '') ?? 1;

      if (dead && a.deadFrame > seconds * 60) {
        // The death animation has played out; wait out the rest of the respawn off-screen.
        pack.crowd.place(slot, a.x, HIDDEN_Y, a.z, a.facing);
        pack.crowd.animate(slot, clip, seconds);
        continue;
      }
      // The clips carry their own vertical motion, and the rules mirror it in a.y, so placing
      // the actor on the ground here keeps the two from drifting apart.
      pack.crowd.place(slot, a.x, this.ground ? this.ground(a.x, a.z) : 0, a.z, a.facing);
      pack.crowd.animate(slot, clip, dead ? a.deadFrame / 60 : a.progress * seconds);
      if (pack.crowd.flash) pack.crowd.flash[slot] = Math.max(0, 1 - a.flash / 7);
    }

    for (const p of this.packs.values()) {
      // Park every instance we did not use this frame.
      for (let i = p.used; i < this.capacity; i++) p.crowd.place(i, 0, HIDDEN_Y, 0, 0);
      p.crowd.flush();
    }
  }

  dispose(): void {
    for (const p of this.packs.values()) p.crowd.dispose();
  }
}
