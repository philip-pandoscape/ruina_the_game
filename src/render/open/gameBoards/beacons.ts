import * as THREE from 'three';
import { MINIGAMES, SEAT_COLORS } from '../../../content/minigames';
import { minigameLayout } from '../../../engine/minigames';
import { hexCentre } from '../../../util/hex';
import { PAL, Parts, box, cyl, mix } from '../../models/kit';
import type { TableBoard } from '../gameTables';

// Beacons' board on a table in the world (src/render/open/gameTables.ts), so onlookers can follow
// the game: a dark hexagonal plank with a brass rim, each hex in its good's colour, the Old Beacon
// dark with a little brass lantern; every lit beacon a peg in its player's colour, and a gold ring
// round each hex of a winning row. Laid out as Beacons' rules lay the board out (beacons.rs
// `layout`), in the table's frame with its top at y = 0.

/** A board hex, middle to corner (m). */
const HEX = 0.05;

interface BeaconsRules {
  goods: Array<{ color: string }>;
}
interface BeaconsLayout {
  hexes: Array<{ q: number; r: number; good: number | null }>;
  centre: number;
}
/** What everyone sees of a game of Beacons (beacons.rs `board`): who lit each hex (0 nobody, 1 seat 0, 2 seat 1) and the winning row. */
interface BeaconsShown {
  lit?: number[];
  row?: number[];
}

export const board: TableBoard = {
  build(game) {
    const layout = minigameLayout<BeaconsLayout>(game);
    const goods = (MINIGAMES[game]?.rules as BeaconsRules | undefined)?.goods ?? [];
    const radius = Math.max(...layout.hexes.map((h) => Math.max(Math.abs(h.q), Math.abs(h.r), Math.abs(h.q + h.r))));
    const p = new Parts();
    // The plank: a hexagon a little wider than the hexes, with a brass rim.
    const plankR = HEX * Math.sqrt(3) * (radius + 0.75);
    p.add(cyl(plankR + 0.02, plankR + 0.02, 0.012, 6), PAL.brass, [0, 0.006, 0], [0, Math.PI / 6, 0]);
    p.add(cyl(plankR, plankR, 0.016, 6), PAL.woodDeep, [0, 0.01, 0], [0, Math.PI / 6, 0]);
    // Each hex in its good's colour; the Old Beacon dark, with a little brass lantern.
    for (const h of layout.hexes) {
      const c = hexCentre(h.q, h.r, HEX);
      const good = h.good === null ? undefined : goods[h.good];
      const colour = good ? mix(new THREE.Color(good.color), 0xf6ecd2, 0.25) : PAL.iron;
      p.add(cyl(HEX * 0.9, HEX * 0.9, 0.012, 6), colour, [c.x, 0.022, c.y]);
    }
    const old = layout.hexes[layout.centre];
    const o = old ? hexCentre(old.q, old.r, HEX) : { x: 0, y: 0 };
    p.add(cyl(0.012, 0.016, 0.05, 6), PAL.brass, [o.x, 0.05, o.y]);
    p.add(box(0.03, 0.03, 0.03), PAL.glow, [o.x, 0.085, o.y], undefined, undefined, { glow: 1.4 });
    p.add(cyl(0.004, 0.022, 0.02, 4), PAL.brass, [o.x, 0.108, o.y], [0, Math.PI / 4, 0]);
    return p.build();
  },

  pieces(game, shown) {
    const layout = minigameLayout<BeaconsLayout>(game);
    const { lit = [], row = [] } = (shown ?? {}) as BeaconsShown;
    const p = new Parts();
    let count = 0;
    for (let i = 0; i < lit.length && i < layout.hexes.length; i++) {
      if (!lit[i]) continue;
      count++;
      const c = hexCentre(layout.hexes[i].q, layout.hexes[i].r, HEX);
      const colour = new THREE.Color(SEAT_COLORS[lit[i] - 1] ?? '#ffffff');
      const tall = i === layout.centre ? 0.02 : 0;
      p.add(cyl(0.017, 0.02, 0.045, 7), colour, [c.x, 0.05 + tall, c.y]);
      p.add(cyl(0.006, 0.017, 0.016, 7), mix(colour, 0xffffff, 0.45), [c.x, 0.08 + tall, c.y], undefined, undefined, { glow: 1.2 });
    }
    for (const i of row) {
      const h = layout.hexes[i];
      if (!h) continue;
      const c = hexCentre(h.q, h.r, HEX);
      p.add(cyl(HEX * 0.98, HEX * 0.98, 0.006, 6), PAL.gold, [c.x, 0.031, c.y], undefined, undefined, { glow: 1.3 });
    }
    return { geometry: p.empty ? null : p.build(), count };
  },
};
