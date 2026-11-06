import * as THREE from 'three';
import type { DungeonDoor, WaterfallInfo } from '../../engine/zone';
import { barrel, boulder, drawings, flicker, lantern, net, plankDeck, portalVeil, rockArch, rockSlab, totem, type Flickers } from './goblinKit';
import { merge, mesh, PAL, rod, tint, xf } from '../models/kit';

// The ledge hidden behind the Windspire's waterfall (crates/engine/src/open/generate.rs cuts it): a hood of
// rock over it, the goblins' landing stage of planks on barrels jutting out over the drop, catch
// nets slung along the walls, their totem, two lanterns whose glow shows through the falling water,
// pictures daubed round the portal, and the portal itself, a dark swirl in a rock arch, into
// Goblin's Dread. Drawing only: the rules know the ledge, the hood and stage (decks), the totem (a
// box) and the portal (the door in emberholm.json).

export class GrottoView {
  readonly group = new THREE.Group();
  private flickers: Flickers = { list: [] };
  private veil = { uTime: { value: 0 } as THREE.IUniform };

  constructor(f: WaterfallInfo, door: DungeonDoor | undefined) {
    this.group.name = 'grotto';
    // Laid out from the foot of the back wall: +Z out along the falls' bearing, +X across (its
    // right-hand side, looking out, is -X), +Y up from the ledge.
    this.group.position.set(f.cx + f.ux * f.shelf.s0, f.shelf.top, f.cz + f.uz * f.shelf.s0);
    this.group.rotation.y = Math.atan2(f.ux, f.uz);
    const g = this.group;
    const depth = f.shelf.s1 - f.shelf.s0;
    const roofUp = f.roof.top - f.shelf.top;
    // The hood: a slab of rock whose top is the roof deck, its underside the grotto's ceiling.
    const hood = rockSlab(f.width + 0.6, 1.9, f.roof.s1 - f.roof.s0 + 0.4, 71, 0.95);
    mesh(g, xf(hood, [0, roofUp - 0.95, (f.roof.s0 + f.roof.s1) / 2 - f.shelf.s0]), { name: 'grotto-hood' });
    // Rocks to close the hood's sides against the slot's walls and break its front edge.
    const rocks: THREE.BufferGeometry[] = [];
    for (const [x, y, z, r, seed] of [
      [-f.width / 2 + 0.2, roofUp - 1.2, 1.5, 1.6, 3],
      [f.width / 2 - 0.2, roofUp - 1.1, 2.5, 1.7, 5],
      [-f.width / 2 + 0.4, roofUp - 1.4, 6.5, 1.3, 7],
      [f.width / 2 - 0.3, roofUp - 1.3, 7.2, 1.4, 9],
      [-1.8, roofUp - 1.5, depth + 0.4, 0.9, 11],
      [2.2, roofUp - 1.4, depth + 0.3, 0.8, 13],
    ] as const)
      rocks.push(xf(boulder(r, seed), [x, y, z]));
    // The slot's walls beside the ledge, seen close up, are rock slabs rather than the ground's
    // stretched sheer step.
    for (const side of [-1, 1])
      for (const [z, h, seed] of [
        [1.3, 6.4, 51],
        [4.3, 6.8, 53],
        [7.2, 6.2, 57],
      ] as const)
        rocks.push(xf(rockSlab(1.5, h, 3.3, seed + side), [side * (f.width / 2 - 0.05), h / 2 - 0.6, z], [0, side * 0.08, side * 0.04]));
    mesh(g, merge(rocks), { name: 'grotto-rocks' });

    // The portal, at the back wall where the door stands.
    const pz = door ? (door.portal.x - f.cx) * f.ux + (door.portal.z - f.cz) * f.uz - f.shelf.s0 : 2.4;
    const wallZ = Math.max(0.3, pz - 0.3);
    mesh(g, xf(rockArch(2.6, 3.6, 21), [0, 0, wallZ]), { name: 'portal-arch' });
    const veil = portalVeil(2.7, 3.7, this.veil);
    veil.position.set(0, 0.05, wallZ + 0.05);
    g.add(veil);
    // Pictures either side of it.
    for (const [x, seed] of [
      [-2.9, 5],
      [2.9, 9],
    ] as const) {
      const d = drawings(2.2, 1.6, seed);
      d.position.set(x, 1.9, wallZ - 0.15);
      g.add(d);
    }
    // Lanterns hung from the hood either side of the portal.
    for (const [x, seed] of [
      [-1.9, 1],
      [1.9, 2],
    ] as const) {
      const l = lantern(this.flickers, seed);
      l.position.set(x, roofUp - 1.95, wallZ + 1.2);
      g.add(l);
    }
    // The landing stage: planks on barrels, jutting out over the drop.
    const stageDepth = f.landing.s1 - f.landing.s0;
    const stage = plankDeck(f.landing.half * 2, stageDepth, 31, f.landing.top - f.shelf.top);
    mesh(g, xf(stage, [0, f.landing.top - f.shelf.top, (f.landing.s0 + f.landing.s1) / 2 - f.shelf.s0]), { name: 'landing-stage' });
    // Struts under its front, where it hangs out past the ledge, down to the ledge's face.
    const struts: THREE.BufferGeometry[] = [];
    const lip = depth - 1.4;
    for (const x of [-f.landing.half * 0.66, f.landing.half * 0.66])
      struts.push(tint(rod([x, -2.2, lip], [x, 0.3, f.landing.s1 - f.shelf.s0 - 0.3], 0.09, 6), PAL.woodDark));
    struts.push(tint(rod([-f.landing.half * 0.66, -1.0, lip + 0.45], [f.landing.half * 0.66, -1.0, lip + 0.45], 0.06, 5), PAL.woodDark));
    mesh(g, merge(struts), { name: 'landing-struts' });
    // Catch nets along both walls, for anyone who comes in too fast, bellying in over the ledge.
    for (const side of [-1, 1]) {
      const n = net(depth - 1.2, roofUp - 1.6, 0.42, 0.35);
      const m = mesh(g, n, { shadow: false, name: 'catch-net' });
      m.position.set(side * (f.width / 2 - 0.95), 0.5, depth / 2 + 0.4);
      m.rotation.y = -side * (Math.PI / 2);
    }
    // The totem, where its post stands in the rules.
    const t = totem(this.flickers, f.totem.top - f.shelf.top, 3);
    t.position.set(-f.totem.t, 0, f.totem.s - f.shelf.s0);
    t.rotation.y = f.totem.t > 0 ? 0.6 : -0.6;
    g.add(t);
    // Stolen barrels in the far corner.
    const loot: THREE.BufferGeometry[] = [];
    loot.push(xf(barrel(0.9, 3), [f.totem.t - 0.2, 0, 1.8]));
    loot.push(xf(barrel(0.9, 4), [f.totem.t - 0.9, 0, 2.3]));
    loot.push(xf(barrel(0.9, 5), [f.totem.t - 0.5, 0, 3.0], [0, 0, Math.PI / 2]));
    mesh(g, merge(loot), { name: 'grotto-loot' });
  }

  update(time: number): void {
    this.veil.uTime.value = time;
    flicker(this.flickers, time);
  }
}
