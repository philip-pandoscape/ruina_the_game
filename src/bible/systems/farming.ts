// Farming and Gathering: written from its rules (`rules` below); every number from the content and the rules.

import { CLIMATES, CROPS, type CropDef, climateFactor, FARM, GATHERING } from '../../content/farming';
import { BAG_SLOTS, ITEMS, VENDORS } from '../../content/items';
import { QUESTS } from '../../content/quests';
import { CLOCK } from '../../content/trade';
import { EMBERHOLM as Z } from '../../sim/zone/world';
import { coins, count, degrees, duration, key, metres, pct, range, slopeDegrees, times } from '../format';
import { system, table } from '../kit';
import { type Html, link, md, phrase, raw } from '../md';
import { sourceNumber, tsConst } from '../source';
import farmingSource from '../../sim/life/farming.ts?raw';
import interactSource from '../../sim/life/interact.ts?raw';

/** The numbers the farming and interaction rules keep in their source: where a plot may go, and so on. */
function rules() {
  const f = (re: RegExp, what: string) => sourceNumber(farmingSource, re, what);
  const i = (re: RegExp, what: string) => sourceNumber(interactSource, re, what);
  return {
    edge: f(/hf\.inside\(px, pz, ([\d.]+)\)\) return 'Too close to the edge of the world'/, 'how far a plot keeps from the edge of the world'),
    aboveSea: f(/h < hf\.water \+ ([\d.]+)\) return 'Too close to the water'/, 'how far above the sea a plot must be'),
    slope: f(/hf\.slope\(px, pz\) > ([\d.]+)\) return 'The ground is too steep'/, 'the steepest ground a plot takes'),
    uneven: f(/hi - lo > ([\d.]+)\) return 'The ground is too uneven'/, 'how uneven a plot may be'),
    apart: f(/HALF \* 2 \+ ([\d.]+)\) return 'Overlaps another plot'/, 'the gap between plots'),
    housePlot: f(/p\.z - z\) < ([\d.]+)\) return 'That is a house plot'/, 'how far a plot keeps from a house plot'),
    clearance: f(/Math\.abs\(lx\) < HALF \+ o\.r \+ ([\d.]+)/, 'how far a plot keeps from trees and rocks'),
    ahead: tsConst(interactSource, 'ahead'),
    turns: i(/pl\.rot = Math\.round\(p\.facing \/ \(Math\.PI \/ (\d+)\)\)/, 'the turns a plot is placed at'),
    cellAhead: i(/const tx = p\.pos\.x \+ fx \* ([\d.]+);/, 'how far ahead of you F finds a plot cell'),
    nodeReach: i(/structureDef\(nd\.kind\)\.w \/ 2\);\s*if \(d > ([\d.]+)\) return;/, 'how close you must be to a gathering spot'),
  };
}

const climateName = (id: string): string => CLIMATES[id]?.name ?? id;
/** Seconds from seed to ripe on this island, dry or watered all the way. */
const here = (c: CropDef, wet: boolean): number => c.growSeconds / climateFactor(c, Z.climate) / (wet ? FARM.water.boost : 1);
const plotSide = (): number => FARM.scarecrowCells * FARM.cell;
const itemName = (id: string): string => ITEMS.find((i) => i.id === id)?.name ?? id;
const between = (r: readonly number[]): Html => phrase`${duration(r[0])} to ${duration(r[1])}`;

/** Who sells an item and for how much, as a phrase: "the Land Registry sells it for 40c". */
function sellers(item: string): Html | null {
  const offers = VENDORS.flatMap((v) => v.sells.filter((s) => s.item === item).map((s) => ({ v, s })));
  if (!offers.length) return null;
  return raw(offers.map(({ v, s }) => phrase`${link(`vendors/${v.npc}`, v.name)} sells it for ${coins(s.price)}`.html).join('; '));
}

/** The quests that hand out an item. */
const questsGiving = (item: string): Html[] =>
  QUESTS.filter((q) => q.rewards.items?.some((i) => i.item === item) || q.startItems?.some((i) => i.item === item)).map((q) => link(`quests/${q.id}`));

export const farming = system({
  id: 'farming',
  title: 'Farming and Gathering',
  summary: 'Scarecrow plots, planting, growth, climates, watering and rain, harvests, trees, and gathering timber, stone, ore and herbs.',
  icon: '🌾',
  keywords: [
    'farm',
    'plot',
    'scarecrow',
    'seed',
    'plant',
    'crop',
    'harvest',
    'water',
    'rain',
    'climate',
    'tree',
    'fell',
    'gather',
    'timber',
    'stone',
    'ore',
    'herbs',
    'thunderstruck',
  ],
  rules: ['src/sim/life/farming.ts', 'crates/engine/src/life/farming.rs', 'src/sim/life/interact.ts', 'crates/engine/src/life/interact.rs', 'src/app/save.ts'],
  content: [
    'shared/farming.json#cell',
    'shared/farming.json#scarecrowCells',
    'shared/farming.json#maxScarecrows',
    'shared/farming.json#climates',
    'shared/farming.json#climateMatch',
    'shared/farming.json#climateMismatch',
    'shared/farming.json#water',
    'shared/farming.json#witherAfterRipe',
    'shared/farming.json#crops',
    'shared/farming.json#gathering',
    'shared/zones/*.json#nodes',
  ],
  body: () => {
    const r = rules();
    const sc = ITEMS.find((i) => i.placeOn === 'ground');
    const scSold = sc ? sellers(sc.id) : null;
    const scGivers = sc ? questsGiving(sc.id) : [];
    const fieldCrops = CROPS.filter((c) => c.kind !== 'tree');
    const trees = CROPS.filter((c) => c.kind === 'tree');
    // What a felled tree may have in it: each tree's own (content/crops/), the same for every tree today.
    const felledRare = trees.map((c) => c.chop?.rare).find((x) => x);
    const seeds = ITEMS.filter((i) => i.plants);
    const example = fieldCrops.find((c) => c.climate === Z.climate) ?? CROPS[0];
    const spots = Object.entries(GATHERING);
    const rare = spots.find(([, g]) => g.rare);
    const climate = climateName(Z.climate).toLowerCase();
    return md`
Farming on ${Z.name} happens in plots you claim with a scarecrow. A plot is ${count(FARM.scarecrowCells, 'cell')} by ${count(
      FARM.scarecrowCells,
      'cell',
    )}, each cell ${metres(FARM.cell)} square, so ${metres(plotSide())} on a side, and you can hold ${count(
      FARM.maxScarecrows,
      'plot',
    )} at once. Every cell holds a single plant, or a young animal ([[systems/livestock]]). Plants grow on the island's own clock, every second, whether you are there to watch or not. Out in the wilds there is timber, stone, ore and herbs to gather, for labor, from spots that come back after a while.

## Claiming a Plot

A plot starts with a ${sc ? link(`items/${sc.id}`, sc.name) : 'scarecrow'}${scSold ? phrase`: ${scSold}` : ''}${
      scGivers.length ? phrase`, and the quest ${raw(scGivers.map((g) => g.html).join(', '))} gives you your first` : ''
    }. Use it from your bag and the plot it would claim appears ${metres(r.ahead)} in front of you, turned to the nearest ${degrees(
      Math.PI / r.turns,
    )} of the way you face. Walk about until the prompt says it can go, then press ${key('F')}; ${key('Esc')} puts the scarecrow away again. Placing it uses it up.

The rules look at the ground at the plot's corners, its middle and points between them, and refuse with the first of these that fails:

1. You already hold ${count(FARM.maxScarecrows, 'plot')}.
1. A point is within ${metres(r.edge)} of the edge of the world: *Too close to the edge of the world*.
1. A point is less than ${metres(r.aboveSea)} above the sea: *Too close to the water*.
1. A point is steeper than ${slopeDegrees(r.slope)}: *The ground is too steep*.
1. A point is not grass, forest floor or tilled soil: on a road or the plaza it says *Not on a road*, on sand or rock *The soil here is no good*.
1. A point is on ground kept clear round a road or a building: *Too close to a road or building*.
1. The highest point is more than ${metres(r.uneven)} above the lowest: *The ground is too uneven*.
1. Its middle is closer than ${metres(plotSide() + r.apart)} to the middle of another of your plots: *Overlaps another plot*.
1. Its middle is closer than ${metres(r.housePlot)} to a house plot's: *That is a house plot*.
1. A tree, rock or post stands within ${metres(r.clearance)} of the plot's square, counting its own width: *Trees or rocks in the way*.

Once it is down, the scarecrow stands just outside a corner of the plot and blocks you like a post, and the plot's ground is tilled: no grass grows on it and no tree will stand on it.

## Planting

On a plot, ${key('F')} works the cell ${metres(r.cellAhead)} in front of you. On an empty cell it plants your chosen seed: the first seed you are given is chosen for you, ${key(
      'Z',
    )} goes through the seeds in your bag, and using a seed from your bag chooses it. When your chosen seed runs out, ${key(
      'F',
    )} plants the first seed in your bag instead. Planting takes the seed and nothing else: no labor, no coin.

${table(
  ['Seed', 'Grows Into', 'Price', 'Sold By'],
  seeds.map((s) => [
    link(`items/${s.id}`, s.name),
    link(`crops/${s.plants}`),
    raw(
      VENDORS.flatMap((v) => v.sells.filter((o) => o.item === s.id))
        .map((o) => coins(o.price).html)
        .join(', '),
    ),
    raw(
      VENDORS.filter((v) => v.sells.some((o) => o.item === s.id))
        .map((v) => link(`vendors/${v.npc}`, v.name).html)
        .join(', '),
    ),
  ]),
  [2],
)}

## How a Plant Grows

A plant's growth runs from nothing to ripe. Every second it grows by:

$$
growth a second = climate × wet ÷ the crop's grow time
climate = ${times(FARM.climateMatch)} in the crop's own climate, ${times(FARM.climateMismatch)} anywhere else
wet = ${times(FARM.water.boost)} while it is watered or while it rains, ×1 otherwise
$$

${Z.name} is ${climate}, so a ${climate} crop grows at full speed here and the others at ${pct(FARM.climateMismatch)} of it. ${link(
      `crops/${example.id}`,
      example.name,
    )}, for one, is ripe in ${duration(here(example, false))} dry, or ${duration(here(example, true))} watered all the way.

${table(
  ['Crop', 'Climate', 'Grow Time', 'Here, Dry', 'Here, Watered'],
  CROPS.map((c) => [link(`crops/${c.id}`, c.name), climateName(c.climate), duration(c.growSeconds), duration(here(c, false)), duration(here(c, true))]),
  [2, 3, 4],
)}

A plant shows its stages one after another, each an equal share of its growth, and shows the last only once it is ripe. A ripe plant waits for you: nothing on the island withers.

### Watering

${key('F')} on a growing plant that isn't watered waters it, for ${count(FARM.water.labor, 'labor', 'labor')}. It stays watered until it reaches its next stage, then wants water again, so keeping a crop of ${count(
      example.stages,
      'stage',
    )} watered from seed to ripe takes ${count(example.stages - 1, 'watering')}. A ripe plant can't be watered.

### Rain

While it rains, every plant on the island grows as if it were watered, whether you watered it or not. Each shower lasts ${between(
      FARM.rain.lastsSeconds,
    )}; [[systems/weather]] says when they come.

### While You Are Away

The island's clock runs on while you are away, for up to ${duration(CLOCK.maxOfflineSeconds)}${
      CLOCK.offlineFactor !== 1 ? phrase`, counted at ${times(CLOCK.offlineFactor)}` : ''
    }. When you come back, each plant grows through all of that time at once, at the speed it had when you left: at watered speed if you had watered it, though rain doesn't count. Then every plant wants watering again.

## Harvesting

${key('F')} on a ripe crop harvests it. You need room in your bag for the most it could give, and its harvest labor; then you get a number drawn from its yield, every number in the range as likely, and a chance of a seed back. The cell is left empty, except under a fruit tree.

${table(
  ['Crop', 'Gives', 'Labor', 'Seed Back'],
  CROPS.filter((c) => c.produce).map((c) => [
    link(`crops/${c.id}`, c.name),
    phrase`${range(c.yield)} ${link(`items/${c.produce}`, itemName(c.produce ?? ''))}`,
    c.harvestLabor,
    c.seedChance ? pct(c.seedChance) : 'Never',
  ]),
  [2, 3],
)}

## Trees

Saplings are planted like seeds and grow like crops, only slower. A fruit tree is harvested like a crop but stays in its cell: it drops back to the start of its last stage and fruits again after its own regrowing time, sped up by its climate and by water like everything else.

A tree that gives timber can be felled once it reaches its last-but-one stage. From then on, ${key(
      'F',
    )} on it fells it whenever it isn't ripe, so a fruit tree that has been picked is felled, not watered, if you press ${key(
      'F',
    )} on it: leave it be and it fruits again. Felling takes its labor and room in your bag for the most it could give, gives its timber, and empties the cell${
      felledRare ? phrase`; ${pct(felledRare.chance)} of felled trees give a ${link(`items/${felledRare.item}`)} as well` : ''
    }. Felled timber counts for a quest's gathering step, as deadfall does.

${table(
  ['Tree', 'Climate', 'Grows Here', 'Fruits Again', 'Felled For'],
  trees.map((c) => [
    link(`crops/${c.id}`, c.name),
    climateName(c.climate),
    duration(here(c, false)),
    c.regrowSeconds ? duration(c.regrowSeconds / climateFactor(c, Z.climate)) : 'Never',
    c.chop ? phrase`${range(c.chop.yield)} ${link(`items/${c.chop.item}`, itemName(c.chop.item))}, ${c.chop.labor} labor` : '',
  ]),
  [2, 3],
)}

## Gathering

Deadfall timber, stone and ore outcrops and wild herbs lie about the island. Stand within ${metres(r.nodeReach)} of a spot's edge and ${key(
      'F',
    )} works it: you need room in your bag for the most it could give and its labor, and you get a number drawn from its range${
      rare
        ? phrase`, with a chance of something rare (a ${link(`items/${rare[1].rare?.item}`, itemName(rare[1].rare?.item ?? ''))} at ${link(`gathering/${rare[0]}`)})`
        : ''
    }. Then that spot is picked clean on your island until it comes back; its prompt says how long. A quest that asks you to gather counts what you gathered, not the times you worked a spot.

${table(
  ['Spot', 'Gives', 'Labor', 'Rare Find', 'Back In', 'On the Island'],
  spots.map(([id, g]) => [
    link(`gathering/${id}`),
    phrase`${range(g.n)} ${link(`items/${g.item}`, itemName(g.item))}`,
    g.labor,
    g.rare ? phrase`${pct(g.rare.chance)}: ${link(`items/${g.rare.item}`, itemName(g.rare.item))}` : 'None',
    duration(g.respawn),
    Z.nodes.filter((n) => n.kind === id).length,
  ]),
  [2, 4, 5],
)}

## Room in Your Bag

Your bag holds ${count(BAG_SLOTS, 'stack')}. Harvesting, felling and gathering each ask for room for the most they could give, counting the stacks it would fill; if there isn't room, the prompt says *Your bag is full* and nothing is spent. Labor is spent all or nothing too: with too little, *Too tired* is all that happens ([[systems/economy]]).
`;
  },
});
