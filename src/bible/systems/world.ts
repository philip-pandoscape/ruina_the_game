// The World and Its Places: written from its rules (`rules` below); every number from the content and the rules.

import { CHALLENGE } from '../../content/minigames';
import { CARRY } from '../../content/trade';
import { GROUND } from '../../content/traversal';
import autoWalkSource from '../../input/autoWalk.ts?raw';
import interactSource from '../../sim/life/interact.ts?raw';
import generateSource from '../../../crates/engine/src/open/generate.rs?raw';
import localPathSource from '../../sim/zone/localPath.ts?raw';
import roadsSource from '../../sim/zone/roads.ts?raw';
import { ON_ROAD, TAIL_MAX, EMBERHOLM, makeZoneWorld } from '../../engine/zone';
import { count, degrees, frames, key, metres, num, pct, slopeDegrees } from '../format';
import { system, table } from '../kit';
import { link, md, phrase, raw } from '../md';
import { sourceNumber, tsConst } from '../source';
import { nearestPlace } from '../things/refs';

/** Every number the groups of `pattern` find in the rules' source; `what` names them for the error. */
function numbers(source: string, pattern: RegExp, what: string): number[] {
  const m = pattern.exec(source);
  const out = m ? m.slice(1).map(Number) : [];
  if (!out.length || out.some((n) => !Number.isFinite(n))) throw new Error(`the rules' source no longer says ${what} where the bible looks (${pattern})`);
  return out;
}

const Z = EMBERHOLM;

/** How far a point is from a stretch of road. */
function segmentDistance(x: number, z: number, [ax, az]: [number, number], [bx, bz]: [number, number]): number {
  const ex = bx - ax;
  const ez = bz - az;
  const l2 = ex * ex + ez * ez;
  const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
  return Math.hypot(ax + ex * u - x, az + ez * u - z);
}
const place = (x: number, z: number) => link(`places/${nearestPlace(x, z).id}`);

export const world = system({
  id: 'world',
  title: 'The World and Its Places',
  summary: 'How an island is grown from its recipe: coast, hills, mountains, roads and places; what you can walk on; and what F does where.',
  icon: '🗺️',
  keywords: ['island', 'map', 'terrain', 'ground', 'road', 'roads', 'travel', 'auto-run', 'interact', 'F key', 'coast', 'mountain', 'forest', 'trees'],
  rules: [
    'src/sim/terrain.ts',
    'crates/engine/src/open/generate.rs',
    'src/sim/zone/world.ts',
    'src/sim/zone/roads.ts',
    'src/sim/zone/localPath.ts',
    'src/sim/life/interact.ts',
    'src/input/autoWalk.ts',
    'crates/engine/src/open/mod.rs',
    'crates/engine/src/open/zone.rs',
    'crates/engine/src/open/generate.rs',
    'crates/engine/src/open/noise.rs',
    'crates/engine/src/life/interact.rs',
  ],
  content: ['shared/zones/*.json#terrain', 'shared/zones/*.json#forests', 'shared/zones/*.json#scatter', 'shared/zones/*.json#spawn'],
  body: () => {
    const t = Z.terrain;
    const gen = makeZoneWorld(Z).zone!.gen;
    const trees = gen.obstacles.filter((o) => o.kind === 'tree').length;
    const rocks = gen.obstacles.filter((o) => o.kind === 'rock').length;
    const mountain = t.mountains[0];
    const ramp = t.ramps[0];
    const pit = t.pits[0];
    const fall = t.falls?.[0];
    const door = Z.dungeons?.[0];
    // The generator's own numbers.
    const cliffRise = sourceNumber(generateSource, /c\.h \* smoothstep\(0\.0, ([\d.]+), d\)/, 'how fast a sea cliff rears up');
    const grade = sourceNumber(generateSource, /let grade = ([\d.]+);/, 'how steep a road may climb');
    const shoulder = sourceNumber(generateSource, /let shoulder = ([\d.]+);/, 'how wide a road’s shoulder is');
    const roadLow = sourceNumber(generateSource, /js_max\(([\d.]+), hf\.height\(x, zz\)\)/, 'how low a road may run');
    const padOut = sourceNumber(generateSource, /lx\.abs\(\) - def\.w \/ 2\.0 - ([\d.]+)\)/, 'how far round a building the ground is levelled');
    const padBlend = sourceNumber(
      generateSource,
      /1\.0 - smoothstep\(0\.0, ([\d.]+), \(ox \* ox \+ oz \* oz\)\.sqrt\(\)\)/,
      'how far a building’s pad blends into the land',
    );
    const forestCore = sourceNumber(generateSource, /f\.r \* ([\d.]+) \{\s*s = surface::FOREST/, 'how much of a forest is forest floor');
    const sandInland = sourceNumber(generateSource, /coast\[j \* n \+ i\]\) < ([\d.]+) \{\s*s = surface::SAND/, 'how far inland sand reaches');
    const scatterCell = sourceNumber(generateSource, /let big_g = ([\d.]+);/, 'how big a scatter cell is');
    const scatterLow = sourceNumber(generateSource, /if h < ([\d.]+) \{\s*continue;/, 'how high above the sea trees and rocks start');
    const treeSlope = sourceNumber(generateSource, /slope < ([\d.]+) && roll < density/, 'how steep a slope a tree grows on');
    const [rockOnRock, rockOnSand] = numbers(
      generateSource,
      /if s == surface::ROCK \{\s*([\d.]+)\s*\} else if s == surface::SAND \{\s*([\d.]+)/,
      'how often rocks lie on rock and sand',
    );
    // The roads as a network, and travel along them.
    const offRoad = tsConst(roadsSource, 'OFF_ROAD_WEIGHT');
    const join = tsConst(roadsSource, 'JOIN');
    const joinEnds = tsConst(roadsSource, 'JOIN_ENDS');
    const clearance = tsConst(roadsSource, 'CLEARANCE');
    const walkSteep = sourceNumber(localPathSource, /GROUND\.maxSlope \* ([\d.]+)\) continue;/, 'how steep a walk off the road may go');
    const arrive = tsConst(autoWalkSource, 'ARRIVE');
    const lost = tsConst(autoWalkSource, 'LOST');
    const stuck = tsConst(autoWalkSource, 'STUCK_STEPS');
    // What F reaches.
    const near = (re: RegExp, what: string) => sourceNumber(interactSource, re, what);
    const fTalk = near(
      /recipe\.npcs\) \{\s*const d = Math\.hypot\(n\.x - p\.pos\.x, n\.z - p\.pos\.z\);\s*if \(d > ([\d.]+)\) continue;/,
      'how near a person F reaches',
    );
    const fBench = near(/Use \$\{name\}[\s\S]*?\},\s*d,\s*([\d.]+),\s*\);/, 'how near a workbench F reaches');
    const fRide = near(
      /life\.state\.vehicles\) \{\s*const d = distanceTo\(v, p\.pos\.x, p\.pos\.z\);\s*if \(d > ([\d.]+)\) continue;/,
      'how near a vehicle F reaches',
    );
    const fCell = near(/const tx = p\.pos\.x \+ fx \* ([\d.]+);/, 'how far ahead F looks for a plot cell');
    const fCellScore = near(/Z: Change Seed`,\s*ok: true,\s*\},\s*([\d.]+),/, 'how near a plot cell counts');
    const fNode = near(/structureDef\(nd\.kind\)\.w \/ 2\);\s*if \(d > ([\d.]+)\) return;/, 'how near a gathering spot F reaches');
    const fSlip = near(
      /shipyards \?\? \[\]\) \{\s*const d = Math\.hypot\(sy\.x - p\.pos\.x, sy\.z - p\.pos\.z\);\s*if \(d > ([\d.]+)\) continue;/,
      'how near a slipway F reaches',
    );
    const fPlot = near(/Math\.abs\(lx\) > ([\d.]+) \|\| Math\.abs\(lz\) > [\d.]+\) continue;/, 'how near a house plot F reaches');
    const fBed = near(/label: 'Rest in Bed'[\s\S]*?\},\s*dd,\s*([\d.]+),/, 'how near your bed F reaches');
    const fPortal = near(/door\.portal\.y\) > ([\d.]+)\) continue;/, 'how near a portal’s height F reaches');
    const fScore = near(/const score = dist \+ \(1 - facing\) \* ([\d.]+);/, 'how much facing something counts');
    const fAhead = near(/const facing = l > ([\d.]+) \?/, 'how near something counts as straight ahead');
    const fPlace = tsConst(interactSource, 'ahead');
    const fTurn = near(/Math\.round\(p\.facing \/ \(Math\.PI \/ (\d+)\)\)/, 'the turns a scarecrow is placed at');
    const fShop = near(/function nearNpc\(life: Life, sim: Sim, npc: string, range = ([\d.]+)\)/, 'how near a shopkeeper you must stay');
    const fCraft = near(/Math\.hypot\(bench\.x - p\.pos\.x, bench\.z - p\.pos\.z\) <= ([\d.]+)/, 'how near a workbench you must stay');
    // A road's end: on another road (where it joins it), or at the place it is nearest.
    const end = (id: string, [x, z]: [number, number]) => {
      const on = gen.roads.find((o) => o.id !== id && o.points.some(([ax, az], i) => i > 0 && segmentDistance(x, z, o.points[i - 1], [ax, az]) <= join));
      return on ? phrase`the ${on.id.charAt(0).toUpperCase() + on.id.slice(1)} road` : place(x, z);
    };
    const roadLength = (pts: Array<[number, number]>) => pts.reduce((s, [x, z], i) => (i ? s + Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]) : 0), 0);

    return md`
Every island is grown from a recipe: a list of where its coast runs, its hills and mountains, the places flattened for towns and fields, its roads, buildings and people (${link('zones/emberholm', Z.name)} is the first). The same recipe and the same seed grow the same island every time, to the last tree. Your browser grows it from the recipe; the server plays on an exact copy of what it grew, so a foot planted in one is planted in the other.

## The Ground

The ground is a grid of heights, ${count(t.cells, 'square')} a side, each ${metres(t.cell)} across: ${metres(t.cells * t.cell)} from edge to edge, the sea level at ${metres(t.water)}. Each square is split into two triangles along the same diagonal in the rules and in what you see, so the ground you walk on is exactly the ground drawn. Every square is also one kind of ground:

${table(
  ['Ground', 'Where', 'What It Does'],
  [
    ['Grass', 'Everywhere nothing else is', 'Scarecrow plots and trees take it'],
    ['Forest', phrase`Within ${pct(forestCore)} of a forest's radius of its middle`, 'Scarecrow plots and the thickest trees take it'],
    ['Sand', phrase`Lower than ${metres(t.sandBelow)}, within ${metres(sandInland)} of the shore`, phrase`Wheels drag on it ([[systems/vehicles]])`],
    ['Rock', phrase`Steeper than ${slopeDegrees(t.rockSlope)}`, 'Bare; rocks lie about on it'],
    ['Road', 'The roads, as wide as each is', 'Wheels run at full speed; no trees grow on or beside it'],
    ['Plaza', 'Town squares and quays, where the recipe paves them', 'As a road'],
    ['Soil', 'Tilled fields', 'Scarecrow plots take it'],
  ],
)}

How steep you can climb, how deep you can wade and the rest of getting about on this ground are on [[systems/moving]] and [[systems/swimming-gliding]].

## Growing the Island

The generator works through the recipe in order, each step shaping what the last one left.

1. **The coast.** Every point gets a distance inland from the coast. The coast starts as a circle reaching ${metres(t.island.radius)} from the island's middle, pushed in and out round the compass by waves of its own, wandering by up to ${metres(t.island.warp)} more, pushed out at headlands, bitten into at bays, with islets raised offshore.
2. **The shore.** On land the ground rises over a beach ${metres(t.shore.beach)} wide to ${metres(t.shore.beachHeight)}, then ${metres(t.shore.inlandRise)} more for every metre inland. Out at sea the seabed falls away, to at most ${metres(t.shore.maxDepth)} down. Where the recipe puts a sea cliff, the coast rears up to the cliff's height within ${metres(cliffRise)} instead of shelving.
3. **The hills.** Rolling hills up to ${metres(t.hills.height)} high, about ${metres(t.hills.scale)} from one to the next, rise in from ${metres(t.hills.inlandFrom)} inland and are at full height ${metres(t.hills.inlandTo)} inland, with a smaller ripple over them.
4. **The mountains.** ${
      mountain
        ? phrase`A mountain is a flat top (the ${link('places/windspire', 'Windspire')}'s is at ${metres(mountain.top)}, flat out to ${metres(mountain.plateau)} from its middle), a sheer band of cliff out to ${metres(mountain.cliff)} from its middle, falling to ${metres(mountain.top * (1 - mountain.cliffDrop), 0)}, and a walkable skirt down to the land by ${metres(mountain.skirt)} out. The cliff is craggy and its line wanders.`
        : 'None on this island.'
    }
5. **The ledge path.** ${
      ramp
        ? phrase`A path ${metres(ramp.width)} wide is carved into the cliff along its own contour lines, climbing from ${metres(ramp.from)} to ${metres(ramp.to)} over ${pct(ramp.turns)} of the way round. It is the way up on foot.`
        : 'None on this island.'
    }
6. **Pits.** ${pit ? phrase`The quarry is dug ${metres(pit.depth)} deep, with a flat floor.` : 'None on this island.'}
7. **Flattened ground.** Town squares, the quay, the fields, the house plots and the trading posts are flattened to a height of their own and blend back into the land round their edges; some are paved.
8. **Building pads.** Every building stands on level ground: the ground is levelled ${metres(padOut)} past its footprint and blends into the land over ${metres(padBlend)} more.
9. **Roads.** Each road is smoothed into a curve through the recipe's points and graded: it follows the land but never climbs more than ${pct(grade)} (${slopeDegrees(grade)}), what a cart can pull, and never runs lower than ${metres(roadLow)} above the sea. It is paved its full width and blends into the land over a shoulder of ${metres(shoulder)}.
10. **Kinds of ground** are worked out last (the table above): what the recipe paints, roads, then forest, sand and rock.
11. **Trees and rocks.** The land is cut into squares of ${metres(scatterCell)}, and one tree or rock may stand in each, on the throw of the island's dice. Trees grow on grass and forest flatter than ${slopeDegrees(treeSlope)}, more thickly in the forests; rocks lie anywhere but roads, plazas and soil: one square in ${num(1 / rockOnRock, 0)} on bare rock, one in ${num(1 / rockOnSand, 0)} on sand, more rarely elsewhere. Nothing grows below ${metres(scatterLow)} above the sea, within ${metres(Z.scatter.clearOfRoad ?? 0)} of a road, within ${metres(Z.scatter.clearOfStructure ?? 0)} of a building, on a house plot or where people stand. ${Z.name} grows ${count(trees, 'tree')} and ${count(rocks, 'rock')} this way; each is solid, and you walk round it.
12. **The waterfall.** ${
      fall
        ? phrase`Last, so nothing else moves: a spring pool on the Windspire's top spills over its lip, and the water falls free down a slot ${metres(fall.width)} wide cut into the cliff, to a pool at its foot. Behind the falling water a ledge juts out of the slot's back wall at ${metres(fall.shelf.top)}, under a hood of rock ${metres(fall.roof.above)} over it: only a glider gets there, and ${door ? link(`dungeons/${door.id}`) : 'a dungeon'}'s door stands on it.`
        : 'None on this island.'
    }

Then come the colliders: every building's walls, floors and stairs, the piers and the glider launch as decks, the posts of the props, the trees and the rocks.

## Places

The places on the island are named spots the map, the compass and the quests point to: ${raw(
      Z.places.map((p) => link(`places/${p.id}`, p.name).html).join(', '),
    )}. The ${link('places', 'places')} say what is at each.

## Roads and Travel by Road

${table(
  ['Road', 'Runs From', 'To', 'Length', 'Width'],
  gen.roads.map((r) => [
    r.id.charAt(0).toUpperCase() + r.id.slice(1),
    end(r.id, r.points[0]),
    end(r.id, r.points[r.points.length - 1]),
    metres(roadLength(r.points), 0),
    metres(r.width),
  ]),
  [3, 4],
)}

The roads join into a network: a road that starts or ends within ${metres(join)} of another joins it there; roads that start from the same town square are joined across it, round whatever stands on the paving; and two road ends within ${metres(joinEnds)} of each other anywhere else are joined by a short walk.

**Travel by road.** Pick a place on the map and press ${key('H')} (or ${key('Num Lock')}) on a road, and you are taken there along the roads, by the same controls the keyboard would give, so it plays the same online.

- You are on the road network within ${metres(ON_ROAD)} of a road's middle, or on a square a road starts from.
- The way is the shortest along the roads to the point of road nearest where you are going. Choosing where to leave the road, a metre off it counts as ${num(offRoad)} along it, so a road that runs right up to the place beats one that passes by. Then you walk the last stretch, if it is no more than ${metres(TAIL_MAX)}; further than that, the way stops at the road.
- Walks across squares and off the road go round whatever stands there, keeping ${metres(clearance)} from it, off water deeper than wading and slopes steeper than ${slopeDegrees(GROUND.maxSlope * walkSteep)}.
- It won't set off while you are knocked down, riding along in someone else's vehicle, swimming, gliding, in a boat, or off the roads.
- You arrive within ${metres(arrive)} of the end. It stops if you push the controls yourself, if you end up more than ${metres(lost)} off the way, if you are stuck (${frames(stuck)} without getting a metre further), or if you land in the water or open a glider. Driving a cart, it slows for the bends, the squares and the end in time to take them; a mount walks the last of the way.

**Auto-run.** Press ${key('H')} anywhere else and you run straight on where the camera looks; turning the camera steers you, the strafe keys still strafe, and pushing forward or back yourself stops it.

## What F Does

Every frame the game works out the one thing ${key('F')} would do where you stand, so the prompt on screen is always what the next press will do, and the press acts on what is in front of you at that moment. Of everything in reach it picks the best by this score, the lowest winning:

$$
score = distance + (1 − facing) × ${num(fScore)}
facing = cos(the angle between where you face and the thing), ${num(1)} for anything nearer than ${metres(fAhead)}
$$

${table(
  ['Near You', 'F Does', 'Reach'],
  [
    ['A person', 'Talk: their quests, shop or crafts. To a trading post’s keeper with a trade pack on your back: sell it, or hear why not', metres(fTalk)],
    ['A workbench', 'Open its recipes', metres(fBench)],
    ['A pack on the ground, your back empty', 'Pick it up', metres(CARRY.pickupRange)],
    ['Your vehicle or mount', 'Get in or on; at its cargo bed, load the pack on your back or take one off', metres(fRide)],
    ['Someone else’s vehicle with a seat free', 'Ride along with them (online)', metres(fRide)],
    [phrase`Your plot, the cell ${metres(fCell)} in front of you`, 'Plant or raise; water; harvest; fell a grown tree; feed; collect', 'That cell'],
    ['A gathering spot', 'Gather, if it isn’t picked clean', phrase`${metres(fNode)} from its edge`],
    ['A slipway', 'Lay a keel; deliver its packs; build a stage; launch', metres(fSlip)],
    ['A house plot', 'Claim it with a blueprint; deliver packs and build a stage; pay its tax', phrase`${metres(fPlot)} either way from its middle`],
    ['Your house’s bed or chest', 'Rest, or open the chest', metres(fBed)],
    ['A dungeon’s portal', 'Go in, or come out', phrase`its own reach, within ${metres(fPortal)} of its height`],
    ['Another player, when nothing else is in reach', 'Challenge them to a mini-game (online)', metres(CHALLENGE.range)],
  ],
)}

- Your plot cell in front of you counts as only ${metres(fCellScore)} away, so on your farm the soil comes first.
- Riding, ${key('F')} gets you out; gliding, it is the wing's gust ([[systems/swimming-gliding]]). Placing a scarecrow, it puts it down ${metres(fPlace)} ahead of you, turned to the nearest ${degrees(Math.PI / fTurn)}.
- It works on foot, in the air and swimming (to climb into a boat, say), but not while you swing, cast or dodge.
- Buying, selling and crafting go on in their windows, as long as you stay within ${metres(fShop)} of the shopkeeper, or ${metres(fCraft)} of the workbench.
- With a pack on your back, a dungeon's portal and a challenge wait until you put it down.

The systems behind each: [[systems/farming]], [[systems/trade]], [[systems/vehicles]], [[systems/housing]], [[systems/parties]] and [[systems/minigames]].
`;
  },
});
