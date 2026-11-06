// The Economy and Labor: written from its rules (`rules` below); every number from the content and the rules.

import { ANIMALS, CROPS, FARM, GATHERING } from '../../content/farming';
import { BLUEPRINTS } from '../../content/housing';
import { ITEMS, RECIPES, VENDORS } from '../../content/items';
import { QUESTS } from '../../content/quests';
import { SHIP_DESIGNS } from '../../content/shipyard';
import { CLOCK, formatCoins, LABOR, PACKS, ROUTES, placeName } from '../../content/trade';
import { BUYBACK_RANGE } from '../../sim/life/trade';
import { EMBERHOLM as Z } from '../../sim/zone/world';
import { coins, count, duration, key, metres, num, pct, range, speed, times } from '../format';
import { system, table } from '../kit';
import { type Html, link, md, phrase, raw } from '../md';
import { sourceNumber, tsConst } from '../source';
import lifeSource from '../../sim/life/life.ts?raw';
import interactSource from '../../sim/life/interact.ts?raw';
import tradeSource from '../../sim/life/trade.ts?raw';
import housingSource from '../../sim/life/housing.ts?raw';

/** The smallest amount of copper the game writes with a coin of this mark (s, g): what one of those coins is worth. */
function worthOf(mark: string): number {
  let n = 1;
  while (n < 1e7 && !formatCoins(n).includes(mark)) n++;
  return n;
}

const itemName = (id: string): string => ITEMS.find((i) => i.id === id)?.name ?? id;
const spread = (values: number[]): Html => (values.length ? range([Math.min(...values), Math.max(...values)]) : raw(''));
/** Amounts of money from the least to the most: 20c to 30c. */
const coinSpread = (values: number[]): Html => {
  if (!values.length) return raw('');
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return lo === hi ? coins(lo) : phrase`${coins(lo)} to ${coins(hi)}`;
};
/** Who makes a recipe: a person, or a workbench. */
const maker = (bench: string): Html => (Z.npcs.some((n) => n.id === bench) ? link(`npcs/${bench}`) : link(`workbenches/${bench}`));

export const economy = system({
  id: 'economy',
  title: 'The Economy and Labor',
  summary: 'Coins, Charter Seals and labor: where they come from, where they go, and how labor comes back.',
  icon: '🪙',
  keywords: [
    'money',
    'coins',
    'copper',
    'silver',
    'gold',
    'charter seals',
    'seals',
    'labor',
    'rest',
    'bed',
    'tonic',
    'vendor',
    'shop',
    'buy',
    'sell',
    'buyback',
    'price',
  ],
  rules: [
    'src/sim/life/life.ts',
    'src/sim/life/state.ts',
    'crates/engine/src/life/mod.rs',
    'crates/engine/src/life/state.rs',
    'src/sim/life/trade.ts',
    'src/sim/life/interact.ts',
  ],
  content: ['shared/trade.json#labor', 'shared/items.json#vendors'],
  body: () => {
    const silver = worthOf('s');
    const gold = worthOf('g');
    const startCoins = sourceNumber(lifeSource, /coins: opts\.coins \?\? (\d+)/, 'the coins a new character starts with');
    const restSpeed = sourceNumber(
      interactSource,
      /Math\.hypot\(p\.vel\.x, p\.vel\.z\) > ([\d.]+) \|\| p\.mode !== 'normal'\) life\.resting = false/,
      'how fast you may move and still rest',
    );
    const shopReach = sourceNumber(interactSource, /function nearNpc\([^)]*range = ([\d.]+)\)/, 'how close to a vendor you must be');
    const buybackMax = tsConst(tradeSource, 'BUYBACK_MAX');
    const taxDays = sourceNumber(housingSource, /const week = bp\.taxPerDay \* (\d+);/, 'how many days of tax are paid at once');
    const tonic = ITEMS.find((i) => i.use?.labor);
    const tonicRecipe = tonic ? RECIPES.find((r) => r.makes.item === tonic.id) : undefined;
    const questCoins = QUESTS.reduce((t, q) => t + (q.rewards.coins ?? 0), 0);
    const questSeals = QUESTS.reduce((t, q) => t + (q.rewards.seals ?? 0), 0);
    const questLabor = QUESTS.reduce((t, q) => t + (q.rewards.labor ?? 0), 0);
    const sealOffers = VENDORS.flatMap((v) => v.sells.filter((s) => s.seals).map((s) => ({ v, s })));
    const rest = LABOR.perMinute * LABOR.restMultiplier;
    const tradePacks = PACKS.filter((p) => p.kind !== 'material');
    const itemRecipes = RECIPES.filter((r) => r.makes.item);
    const houseStages = BLUEPRINTS.flatMap((b) => b.stages.map((s) => s.labor));
    const shipStages = SHIP_DESIGNS.flatMap((d) => d.stages.map((s) => s.labor));
    return md`
Ruina has two currencies and a resource. Coins buy almost everything. Charter Seals come from trade and quests and buy the best of what the island sells. Labor is your capacity for honest work: it is spent on every harvest, haul and build, and comes back with time and rest. All three are your own, kept with your island; online the game's server keeps them and decides every change.

## Coins

Money is counted in copper: ${num(silver)} copper make a silver and ${num(gold / silver)} silver a gold, so ${coins(gold + silver + 1)} is ${num(
      gold + silver + 1,
    )} copper. A new character starts with ${coins(startCoins)}.

Whatever costs coin, seals or labor is paid all at once or not at all: the coin is checked first, then the seals, then the labor, and if any of them is short the prompt says which and nothing is spent.

## Charter Seals

Seals come from trade, contracts and quests, and nowhere else:

- every trade pack sold on a route pays its seals: ${raw(
      ROUTES.map((r) => phrase`${count(r.seals, 'seal')} a pack from ${placeName(r.from)} to ${link(`places/${r.to}`, placeName(r.to))}`.html).join('; '),
    )};
- a filled contract pays a bonus of seals ([[systems/contracts]]);
- the quests pay ${count(questSeals, 'seal')} in all.

They buy:

${table(
  ['Thing', 'From', 'Price'],
  sealOffers.map(({ v, s }) => [
    link(`items/${s.item}`, itemName(s.item)),
    link(`vendors/${v.npc}`, v.name),
    phrase`${coins(s.price)} + ${count(s.seals ?? 0, 'Charter Seal')}`,
  ]),
  [2],
)}

## Labor

You hold at most ${num(LABOR.max)} labor, and a new character starts with ${num(LABOR.start)}. It comes back by itself:

${table(
  ['When', 'Labor a Minute', 'Empty to Full'],
  [
    ['While you play', num(LABOR.perMinute), duration((LABOR.max / LABOR.perMinute) * 60)],
    [phrase`Resting in your own bed (${times(LABOR.restMultiplier)})`, num(rest), duration((LABOR.max / rest) * 60)],
    ['While you are away', num(LABOR.offlinePerMinute), duration((LABOR.max / LABOR.offlinePerMinute) * 60)],
  ],
  [1, 2],
)}

Time away counts up to ${duration(CLOCK.maxOfflineSeconds)} at a time. To rest, press ${key('F')} at the bed in a house you have finished ([[systems/housing]]): you rest until you move faster than ${speed(
      restSpeed,
    )} or do anything but stand, and the bed becomes your home. ${
      tonic
        ? phrase`A ${link(`items/${tonic.id}`, tonic.name)} gives ${num(tonic.use?.labor ?? 0)} labor at once, though never past ${num(LABOR.max)}${
            tonicRecipe
              ? phrase`; ${maker(tonicRecipe.bench)} makes them, from ${raw(
                  (tonicRecipe.inputs ?? []).map((i) => phrase`${i.n} ${link(`items/${i.item}`, itemName(i.item))}`.html).join(', '),
                )} and ${coins(tonicRecipe.coins ?? 0)}`
              : ''
          }.`
        : ''
    } No one sells labor.

What labor is spent on:

${table(
  ['Work', 'Labor'],
  [
    [phrase`Watering a plant ([[systems/farming]])`, FARM.water.labor],
    ['Harvesting a crop', spread(CROPS.filter((c) => c.produce).map((c) => c.harvestLabor))],
    ['Felling a tree', spread(CROPS.flatMap((c) => (c.chop ? [c.chop.labor] : [])))],
    ['Gathering timber, stone, ore or herbs', spread(Object.values(GATHERING).map((g) => g.labor))],
    [phrase`Collecting from an animal ([[systems/livestock]])`, spread(ANIMALS.map((a) => a.collectLabor))],
    [phrase`Making a pack ([[systems/trade]])`, spread(PACKS.map((p) => p.labor))],
    ['Having a crafter make something', spread(itemRecipes.map((r) => r.labor ?? 0))],
    [phrase`A stage of a house ([[systems/housing]])`, spread(houseStages)],
    [phrase`A stage of a ship ([[systems/vehicles]])`, spread(shipStages)],
  ],
  [1],
)}

The quests give back ${num(questLabor)} labor in all.

## Buying and Selling

Shops are kept by the island's people ([[vendors]]). You buy and sell within ${metres(shopReach)} of the keeper.

- **Buying** needs room in your bag for all of what you buy, and its whole price in coin and seals.
- **Selling** works only for what that vendor buys. You sell as many as you ask for, or all you have if that is fewer, and each fetches what the vendor pays:

$$
a vendor pays = the larger of (1 copper, the thing's worth × their rate, to the nearest copper)
$$

- **Buying back:** a vendor holds what you sold them, at what they paid you, so a stack sold by mistake can be bought back for the same money. They hold your last ${count(
      buybackMax,
      'sale',
    )} across every vendor (the oldest go first), and let go of it as soon as you walk more than ${metres(BUYBACK_RANGE)} from them.

${table(
  ['Vendor', 'Keeper', 'Sells', 'Buys', 'Pays'],
  VENDORS.map((v) => [
    link(`vendors/${v.npc}`, v.name),
    link(`npcs/${v.npc}`, Z.npcs.find((n) => n.id === v.npc)?.name ?? v.npc),
    count(v.sells.length, 'thing'),
    v.buys.length ? count(v.buys.length, 'thing') : 'Nothing',
    v.buys.length ? phrase`${pct(v.buyRate)} of worth` : '',
  ]),
  [2, 3],
)}

## Where Coins Come From

- Selling trade packs at the trading posts: by far the best money, and the farther the better ([[systems/trade]]).
- The bonus of a filled contract ([[systems/contracts]]).
- Quest rewards: ${coins(questCoins)} in all, besides the things they give ([[quests]]).
- Selling produce, materials and finds to the vendors who buy them.
- The pot of a mini-game you win against another player ([[systems/minigames]]).

## Where Coins Go

- The vendors: seeds and saplings, young animals, scarecrows, blueprints, whistles, gliders and ship designs.
- A workbench's fee for every trade pack: ${coinSpread(tradePacks.map((p) => p.fee))} a pack.
- The crafters' fees for what they make: ${raw(
      itemRecipes
        .filter((r) => r.coins)
        .map((r) => phrase`${link(`items/${r.makes.item}`, itemName(r.makes.item ?? ''))} ${coins(r.coins ?? 0)}`.html)
        .join(', '),
    )}.
- Property tax on a house, ${raw(
      BLUEPRINTS.map((b) => phrase`${coins(b.taxPerDay)} a day for a ${b.name.toLowerCase()}, paid ${count(taxDays, 'day')} at a time`.html).join('; '),
    )} ([[systems/housing]]).
- The stake you put down at a mini-game you lose.
`;
  },
});
