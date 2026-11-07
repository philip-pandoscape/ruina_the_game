// Crops and trees, farm animals, and the places in the world where materials are gathered.

import { ANIMALS, type AnimalDef, CLIMATES, CROPS, type CropDef, climateFactor, FARM, GATHERING, type GatherDef } from '../../content/farming';
import { count, duration, pct, range } from '../format';
import { join, kind, note, table } from '../kit';
import { link, md, phrase } from '../md';
import { itemLink, ZONE } from './refs';

const climateName = (id: string): string => CLIMATES[id]?.name ?? id;

/** Seconds a crop takes from seed to ripe in this region, dry or watered all the way. */
const ripens = (c: CropDef, wet: boolean): number => c.growSeconds / climateFactor(c, ZONE.climate) / (wet ? FARM.water.boost : 1);

export const crops = kind<CropDef>({
  id: 'crops',
  section: 'things',
  title: 'Crops',
  noun: 'Crop',
  icon: '🌾',
  summary: 'What grows in a scarecrow plot: field crops and trees, how long they take and what they give.',
  sources: ['shared/farming.json#crops'],
  systems: ['farming', 'weather'],
  all: () => CROPS,
  key: (c) => c.id,
  name: (c) => c.name,
  iconOf: (c) => c.icon,
  group: (c) => (c.kind === 'tree' ? 'Trees' : 'Field Crops'),
  line: (c) => `A ${c.kind === 'tree' ? 'tree' : 'crop'} of ${climateName(c.climate).toLowerCase()} lands.`,
  explain: (c) => note('crops', c.id),
  facts: (c) => [
    [
      'Climate',
      climateName(c.climate) + (c.climate === ZONE.climate ? `, as ${ZONE.name} is` : `; ${ZONE.name} is ${climateName(ZONE.climate).toLowerCase()}`),
    ],
    ['Ripens here', duration(ripens(c, false))],
    ['Watered', duration(ripens(c, true))],
    ['Stages', c.stages],
    ['Planted from', itemLink(c.seed)],
    ['Planting', c.plantLabor ? phrase`${c.plantLabor} labor` : 'No labor'],
    ['Gives', c.produce ? phrase`${range(c.yield)} ${itemLink(c.produce)}` : null],
    ['Harvesting', c.produce ? phrase`${c.harvestLabor} labor` : null],
    ['Seed back', c.seedChance ? phrase`${pct(c.seedChance)} of harvests` : null],
    ['Fruits again', c.regrowSeconds ? duration(c.regrowSeconds / climateFactor(c, ZONE.climate)) : null],
    ['Felled for', c.chop ? phrase`${range(c.chop.yield)} ${itemLink(c.chop.item)}, ${c.chop.labor} labor` : null],
  ],
  body: (c) =>
    join(
      md`## How Long It Takes`,
      md`A plant grows a little every second, whether anyone is watching or not. In its own climate it grows at full speed, elsewhere at ${pct(
        FARM.climateMismatch,
      )} of it; water or rain makes it ${pct(FARM.water.boost - 1)} faster until it reaches its next stage. [[systems/farming]] has the whole rule.`,
      table(
        ['Where', 'Dry', 'Watered'],
        [
          [
            `In its own climate (${climateName(c.climate).toLowerCase()})`,
            duration(c.growSeconds / FARM.climateMatch),
            duration(c.growSeconds / FARM.climateMatch / FARM.water.boost),
          ],
          ['Anywhere else', duration(c.growSeconds / FARM.climateMismatch), duration(c.growSeconds / FARM.climateMismatch / FARM.water.boost)],
        ],
        [1, 2],
      ),
      c.regrowSeconds
        ? md`Once picked, the tree keeps its last stage and fruits again in ${duration(c.regrowSeconds / FARM.climateMatch)} in its own climate (${duration(
            c.regrowSeconds / FARM.climateMismatch,
          )} elsewhere).`
        : null,
    ),
  columns: [
    ['Ripens Here', (c) => duration(ripens(c, false))],
    ['Gives', (c) => (c.produce ? phrase`${range(c.yield)} ${itemLink(c.produce)}` : c.chop ? phrase`${range(c.chop.yield)} ${itemLink(c.chop.item)}` : '')],
  ],
});

export const animals = kind<AnimalDef>({
  id: 'animals',
  section: 'things',
  title: 'Animals',
  noun: 'Animal',
  icon: '🐄',
  summary: 'Livestock raised in a plot cell from a young one: what they eat and what they give.',
  sources: ['shared/farming.json#animals'],
  systems: ['livestock'],
  all: () => ANIMALS,
  key: (a) => a.id,
  name: (a) => a.name,
  iconOf: (a) => a.icon,
  line: (a) => `Raised from a ${a.young.toLowerCase()}; it gives ${a.produce}.`,
  explain: (a) => note('animals', a.id),
  facts: (a) => [
    ['Raised from', itemLink(a.item)],
    ['Grows up in', duration(a.growSeconds)],
    ['Eats', phrase`${a.feedN} ${itemLink(a.feed)}`],
    ['One feeding lasts', duration(a.feedSeconds)],
    ['Gives', phrase`${range(a.yield)} ${itemLink(a.produce)}`],
    ['Every', duration(a.produceSeconds)],
    ['Collecting', phrase`${a.collectLabor} labor`],
  ],
  body: (a) =>
    md`It grows and gives only while it is fed: a ${a.young.toLowerCase()} takes ${duration(a.growSeconds)} of being fed to grow up, then gives ${range(
      a.yield,
    )} ${itemLink(a.produce)} for every ${duration(a.produceSeconds)} it is fed. A hungry animal waits; nothing dies of neglect. [[systems/livestock]] has the whole rule.`,
  columns: [
    ['Eats', (a) => phrase`${a.feedN} ${itemLink(a.feed)}`],
    ['Gives', (a) => phrase`${range(a.yield)} ${itemLink(a.produce)}`],
    ['Every', (a) => duration(a.produceSeconds)],
  ],
});

type Spot = GatherDef & { id: string };
const SPOTS: Spot[] = Object.entries(GATHERING).map(([id, g]) => ({ ...g, id }));
const spotName = (g: Spot): string => g.kind.charAt(0).toUpperCase() + g.kind.slice(1);

export const gathering = kind<Spot>({
  id: 'gathering',
  section: 'world',
  title: 'Gathering',
  noun: 'Resource',
  icon: '⛏️',
  summary: 'Timber, stone, ore and herbs: where they are in the world, what working them gives, and how soon they come back.',
  sources: ['shared/farming.json#gathering', 'shared/regions/*.json#nodes'],
  systems: ['farming'],
  all: () => SPOTS,
  key: (g) => g.id,
  name: spotName,
  iconOf: (g) => ({ timber: '🪵', stone: '🪨', ore: '⛏️', herbs: '🌿' })[g.kind],
  line: (g) => `${g.verb}: ${g.item}.`,
  explain: (g) => note('gathering', g.id),
  facts: (g) => [
    ['Action', g.verb],
    ['Gives', phrase`${range(g.n)} ${itemLink(g.item)}`],
    ['Rare find', g.rare ? phrase`${itemLink(g.rare.item)}, ${pct(g.rare.chance)} of the time` : null],
    ['Labor', g.labor],
    ['Back in', duration(g.respawn)],
    ['On Emberholm', count(ZONE.nodes.filter((n) => n.kind === g.id).length, 'spot')],
  ],
  body: (g) =>
    md`Working a spot takes ${g.labor} labor and gives ${range(g.n)} ${itemLink(g.item)}; then that spot is picked clean, for you alone, for ${duration(
      g.respawn,
    )} before it can be worked again. The ${link('places', 'places')} say where they are.`,
  columns: [
    ['Gives', (g) => phrase`${range(g.n)} ${itemLink(g.item)}`],
    ['Labor', (g) => g.labor],
    ['Back In', (g) => duration(g.respawn)],
  ],
});
