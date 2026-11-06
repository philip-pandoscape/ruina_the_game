// Housing: written from its rules (`rules` below); every number from the content and the rules.

import { BLUEPRINTS, type BlueprintDef } from '../../content/housing';
import { ITEMS, RECIPES, VENDORS } from '../../content/items';
import { CLOCK, LABOR, packDef } from '../../content/trade';
import { DAY, HOUSE_SETBACK } from '../../sim/life/housing';
import { EMBERHOLM } from '../../sim/zone/world';
import { coins, count, duration, metres, speed } from '../format';
import { join, system, table } from '../kit';
import { type Html, link, md, phrase, raw } from '../md';
import { sourceNumber } from '../source';
import housingSource from '../../sim/life/housing.ts?raw';
import interactSource from '../../sim/life/interact.ts?raw';

/** The numbers the housing rules keep in their source. */
const RULE = {
  /** How many days of tax one payment covers. */
  week: () => sourceNumber(housingSource, /taxPerDay \* (\d+)/, 'how many days a tax payment covers'),
  /** How many houses one settler may have. */
  houses: () => sourceNumber(housingSource, /houses\.length >= (\d+)/, 'how many houses a settler may have'),
  /** The stage from which the floor is solid, and the walls. */
  floorFrom: () => sourceNumber(housingSource, /h\.stage >= (\d+) && !done\.has\(`\$\{h\.id\}:floor`\)/, 'the stage the floor is laid at'),
  wallsFrom: () => sourceNumber(housingSource, /h\.stage >= (\d+) && !done\.has\(`\$\{h\.id\}:walls`\)/, 'the stage the walls go up at'),
  /** How near a plot's middle (along either side) its prompts reach. */
  plotReach: () => sourceNumber(interactSource, /Math\.abs\(lx\) > (\d+(?:\.\d+)?) \|\| Math\.abs\(lz\) > \d/, 'how near a plot its prompts reach'),
  /** How near the bed, or the chest, you stand to use it. */
  bedReach: () => sourceNumber(interactSource, /action: 'rest'[\s\S]*?dd,\s*(\d+(?:\.\d+)?),\s*\)/, 'how near the bed you rest'),
  chestReach: () => sourceNumber(interactSource, /action: 'storage'[\s\S]*?dd,\s*(\d+(?:\.\d+)?)\)/, 'how near the chest you open it'),
  /** How far in front of or behind the plot's middle the tax prompt shows. */
  taxFrom: () => sourceNumber(interactSource, /if \(Math\.abs\(lz\) > (\d+(?:\.\d+)?)\)\s*consider\(\s*\{\s*action: 'tax'/, 'where the tax prompt shows'),
  /** Moving faster than this gets you out of bed. */
  restBreak: () =>
    sourceNumber(
      interactSource,
      /Math\.hypot\(p\.vel\.x, p\.vel\.z\) > (\d+(?:\.\d+)?) \|\| p\.mode !== 'normal'\) life\.resting = false/,
      'how fast a move ends a rest',
    ),
};

const packsOf = (bp: BlueprintDef): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const s of bp.stages) for (const [p, n] of Object.entries(s.needs)) out[p] = (out[p] ?? 0) + n;
  return out;
};

const packList = (needs: Record<string, number>): Html =>
  raw(
    Object.entries(needs)
      .map(([p, n]) => phrase`${n} × ${link(`packs/${p}`, packDef(p).name)}`.html)
      .join('<br>'),
  );

/** Where a material pack is made: the workbench whose recipe makes it. */
const benchOf = (pack: string): Html | string => {
  const r = RECIPES.find((x) => x.makes.pack === pack);
  return r ? link(`workbenches/${r.bench}`) : '';
};

/** Everything one house takes: the packs hauled, the labor to build, and what the packs are made from. */
function allIn(bp: BlueprintDef): Html {
  const packs = packsOf(bp);
  const buildLabor = bp.stages.reduce((t, s) => t + s.labor, 0);
  let packLabor = 0;
  let fees = 0;
  const materials: Record<string, number> = {};
  for (const [p, n] of Object.entries(packs)) {
    const def = packDef(p);
    packLabor += def.labor * n;
    fees += def.fee * n;
    for (const i of def.inputs) materials[i.item] = (materials[i.item] ?? 0) + i.n * n;
  }
  const hauls = Object.values(packs).reduce((a, b) => a + b, 0);
  const items = Object.entries(materials).map(([id, n]) => phrase`${n} ${link(`items/${id}`, ITEMS.find((i) => i.id === id)?.name ?? id)}`.html);
  const fee = fees ? phrase`, ${coins(fees)} in workbench fees,` : '';
  return md`All in, the ${bp.name.toLowerCase()} takes ${count(hauls, 'pack')} hauled to the site and ${buildLabor} labor to build; making those packs takes ${packLabor} labor more${fee} and ${raw(
    items.join(', '),
  )} gathered or bought.`;
}

export const housing = system({
  id: 'housing',
  title: 'Housing',
  summary: 'Claiming a plot with a blueprint, building a house stage by stage, storage, rest and tax.',
  icon: '🏡',
  keywords: ['house', 'home', 'cottage', 'plot', 'blueprint', 'tax', 'bed', 'chest', 'storage', 'build'],
  rules: ['src/sim/life/housing.ts', 'crates/engine/src/life/housing.rs'],
  content: ['shared/housing.json#blueprints', 'shared/zones/*.json#housePlots'],
  body: () => {
    const bp = BLUEPRINTS[0];
    const sale = VENDORS.flatMap((v) => v.sells.map((s) => ({ v, s }))).filter(({ s }) => s.item.startsWith('blueprint.'));
    const week = RULE.week();
    return join(
      md`
A house is earned with your hands, never bought outright. A blueprint claims an empty plot; then the house goes up a stage at a time, each stage finished by hauling its material packs to the site and putting in the labor. Finished, it is yours: a chest to keep things in, a bed that brings your labor back faster, and a tax bill to keep paid. There ${BLUEPRINTS.length === 1 ? 'is' : 'are'} ${count(
        BLUEPRINTS.length,
        'blueprint',
      )} so far: ${raw(BLUEPRINTS.map((b) => link(`blueprints/${b.id}`).html).join(', '))}.

## The Blueprint

A blueprint is an item in your bag. ${raw(
        sale
          .map(
            ({ v, s }) =>
              phrase`${link(`npcs/${v.npc}`)} sells the ${link(`items/${s.item}`)} for ${coins(s.price)}${
                s.seals ? phrase` and ${count(s.seals, 'Charter Seal')}` : ''
              } (${link(`vendors/${v.npc}`, v.name)}).`.html,
          )
          .join(' '),
      )} Charter Seals come only from trade ([[systems/trade]]), so a house is something you work toward.

## Claiming a Plot

${EMBERHOLM.name} has ${count(EMBERHOLM.housePlots.length, 'house plot')} at [[places/hearthside]], each ${metres(bp.plot)} square. Walk onto one with a blueprint in your bag: within ${metres(
        RULE.plotReach(),
      )} of its middle along either side, F offers to place it. Pressing it checks, in this order:

1. If a house already stands on the plot, nothing happens.
2. Online, if someone else holds the plot, it says whose it is. Everyone in your channel shares the plots, so a plot another settler has claimed is theirs.
3. If you already have ${count(RULE.houses(), 'house')}, you can't have another: one house per settler, for now.
4. Otherwise the blueprint leaves your bag and the plot is yours. The house will stand ${metres(
        -HOUSE_SETBACK,
      )} back from the plot's middle, leaving a front yard, and its tax is paid for the first ${count(bp.graceDays, 'day')}.

## Building It, Stage by Stage

Each stage wants its own material packs. Carry a pack to the site on your back (a cart's bed can bring several: unload one onto your back there) and F delivers it. Only a pack the current stage still wants is taken, and each delivery uses the pack up. When every pack of the stage is in, F builds it, which costs the stage's labor; then the next stage begins.

${table(
  ['Stage', 'What It Is', 'Haul to the Site', 'Labor'],
  bp.stages.map((s) => [s.name, s.desc, packList(s.needs), s.labor]),
  [3],
)}

The material packs are made at the workbenches where their materials are: ${raw(
        Object.keys(packsOf(bp))
          .map((p) => phrase`${link(`packs/${p}`, packDef(p).name)} with ${benchOf(p)}`.html)
          .join(', '),
      )}.

As it goes up, the house becomes solid: from the end of stage ${RULE.floorFrom()} its floor is something to stand on, and from the end of stage ${RULE.wallsFrom()} its walls are, with a doorway left open in front.
`,
      allIn(bp),
      md`
## A Finished House

- **The chest.** F beside it (within ${metres(RULE.chestReach())}) opens your storage. It holds ${count(
        bp.perks.storageSlots,
        'kind',
      )} of thing and as many of each kind as you like; once it holds that many kinds, only more of a kind already in it can go in.
- **The bed.** F beside it (within ${metres(RULE.bedReach())}) lies you down to rest. While you rest your labor comes back ${LABOR.restMultiplier} times as fast, ${
        LABOR.perMinute * LABOR.restMultiplier
      } a minute instead of ${LABOR.perMinute}. Moving faster than ${speed(
        RULE.restBreak(),
      )}, or doing anything but standing there, gets you up. The bed you rest in is remembered as your home.
- **The house.** Walk in through its doorway; it is yours to stand in.

## Property Tax

The tax is ${coins(bp.taxPerDay)} a day, paid a week at a time: ${coins(bp.taxPerDay * week)} for ${count(
        week,
        'day',
      )}. Pay it at the plot: stand in the front yard or behind the house, more than ${metres(
        RULE.taxFrom(),
      )} in front of or behind the plot's middle, and F pays. A payment adds ${count(
        week,
        'day',
      )} to whichever is later, the day your tax is paid until or today, so you can pay ahead. The first ${count(
        bp.graceDays,
        'day',
      )} after you claim the plot are paid for you.

A day is ${duration(DAY)} on your island's clock, which runs while you play and, when you come back, catches up the time you were away, up to ${duration(
        CLOCK.maxOfflineSeconds,
      )} of it ([[systems/weather]]).

> Tax that isn't paid only shows as overdue. Taking a neglected house down is designed, but the rules deliberately don't do it yet.
`,
    );
  },
});
