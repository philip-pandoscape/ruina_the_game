// Livestock: written from its rules (`rules` below); every number from the content and the rules.

import { ANIMALS, type AnimalDef, FARM } from '../../content/farming';
import { ITEMS, VENDORS } from '../../content/items';
import { QUESTS } from '../../content/quests';
import { CLOCK, PACKS } from '../../content/trade';
import { coins, count, duration, key, listOf, num, range } from '../format';
import { system, table } from '../kit';
import { type Html, link, md, phrase, raw } from '../md';

const itemName = (id: string): string => ITEMS.find((i) => i.id === id)?.name ?? id;
const item = (id: string): Html => link(`items/${id}`, itemName(id));
const links = (list: Html[]): Html => raw(list.map((l) => l.html).join(', '));

/** What a vendor pays for an item: its worth times their rate, rounded, never under a copper (crates/engine/src/life/trade.rs, sell). */
const paid = (id: string): number | null => {
  const worth = ITEMS.find((i) => i.id === id)?.value ?? 0;
  const rates = VENDORS.filter((v) => v.buys.includes(id)).map((v) => Math.max(1, Math.round(worth * v.buyRate)));
  return rates.length ? Math.max(...rates) : null;
};

/** The price of a young animal at the vendors that sell it. */
const youngPrice = (a: AnimalDef): Html =>
  raw(
    VENDORS.flatMap((v) => v.sells.filter((s) => s.item === a.item))
      .map((s) => coins(s.price).html)
      .join(', ') || '',
  );

export const livestock = system({
  id: 'livestock',
  title: 'Livestock',
  summary: 'Raising chicks, lambs and calves in a plot: feeding, growing up, and collecting eggs, wool and milk.',
  icon: '🐔',
  keywords: ['animal', 'animals', 'chicken', 'chick', 'sheep', 'lamb', 'cow', 'calf', 'feed', 'egg', 'wool', 'milk', 'raise'],
  rules: ['crates/engine/src/life/livestock.rs', 'crates/engine/src/life/interact.rs'],
  content: ['shared/farming.json#animals'],
  body: () => {
    const sellers = VENDORS.filter((v) => v.sells.some((s) => ANIMALS.some((a) => a.item === s.item)));
    const givers = QUESTS.filter((q) => q.rewards.items?.some((i) => ANIMALS.some((a) => a.item === i.item)));
    const feeds = [...new Set(ANIMALS.map((a) => a.feed))];
    const first = ANIMALS[0];
    const packsOfProduce = PACKS.filter((p) => p.inputs.some((i) => ANIMALS.some((a) => a.produce === i.item)));
    return md`
Farm animals are raised in the cells of a scarecrow plot, like crops ([[systems/farming]]). A young one grows up only while it is fed, and a grown one gives its produce again and again, also only while it is fed. A hungry animal simply waits for you: nothing in the world dies of neglect.

## Getting a Young One

${links(sellers.map((v) => link(`vendors/${v.npc}`, v.name)))} ${sellers.length === 1 ? 'sells' : 'sell'} the young: ${links(
      ANIMALS.map((a) => phrase`${item(a.item)} for ${youngPrice(a)}`),
    )}${givers.length ? phrase`. The quest ${links(givers.map((q) => link(`quests/${q.id}`)))} gives you one as well` : ''}.

## Raising One

A young animal goes in a cell the way a seed does: make it your chosen seed (${key(
      'Z',
    )} goes through the seeds and young animals in your bag, or use it from your bag), then ${key(
      'F',
    )} on an empty cell raises it there. It costs only the young animal, and it arrives fed: for as long as a single feeding lasts, it is growing from the moment it is in the cell.

## Feeding

${key('F')} on an animal feeds it, with its feed from your bag and no labor. Each feeding keeps it fed for a while longer, counted from now or from when it is already fed until, whichever is later:

$$
fed until = the later of (now, fed until) + how long a feeding lasts
$$

So you can feed ahead as far as you like. The prompt over the animal says *Hungry* once it has run out, or how long it is fed for; without enough feed in your bag it can't be fed.

## Growing Up and Giving

Only the time an animal is fed counts. Every second it is fed:

$$
a young one: growth += 1 ÷ its time to grow up
a grown one: produce += 1 ÷ its time to give
$$

When its produce is full, ${key('F')} collects it: you need its labor and room in your bag for the most it could give, and you get a number drawn from its yield, every number in the range as likely. Its produce starts again from empty. A full animal holds a single load: fed time while you leave it full gives nothing more, so collect it before feeding it on.

While you are away (up to ${duration(CLOCK.maxOfflineSeconds)}), the part of the time it was still fed counts, and the rest doesn't:

$$
fed time = the shorter of (the time away, fed until − when you left)
$$

## The Animals

${table(
  ['Animal', 'Young', 'Price', 'Grows Up In', 'Eats', 'A Feeding Lasts'],
  ANIMALS.map((a) => [
    link(`animals/${a.id}`, a.name),
    item(a.item),
    youngPrice(a),
    duration(a.growSeconds),
    phrase`${a.feedN} ${item(a.feed)}`,
    duration(a.feedSeconds),
  ]),
  [2, 3, 5],
)}

${table(
  ['Animal', 'Gives', 'Every', 'Labor', 'Feed a Load', 'Pays'],
  ANIMALS.map((a) => {
    const p = paid(a.produce);
    return [
      link(`animals/${a.id}`, a.name),
      phrase`${range(a.yield)} ${item(a.produce)}`,
      duration(a.produceSeconds),
      a.collectLabor,
      phrase`${num((a.feedN * a.produceSeconds) / a.feedSeconds)} ${item(a.feed)}`,
      p === null ? 'Nobody buys it' : phrase`${coins(p)} each`,
    ];
  }),
  [2, 3, 4],
)}

The times are fed time: an animal that isn't fed doesn't count down. *Feed a load* is what it eats while it fills up a load (its feed times the time to give, over how long a feeding lasts), and *pays* is the most a vendor gives for each of its produce ([[systems/economy]] has how vendors pay). A ${first.young.toLowerCase()} fed from the start, for one, grows up in ${duration(
      first.growSeconds,
    )} and then gives ${range(first.yield)} ${item(first.produce)} for every ${duration(first.produceSeconds)} it is fed.

## What the Produce Is For

${listOf(packsOfProduce.map((p) => link(`packs/${p.id}`, p.name)))} ${packsOfProduce.length === 1 ? 'is' : 'are'} packed from it at the workbench, to sell far away ([[systems/trade]]); ${
      feeds.length === 1 ? 'every animal eats' : 'the animals eat'
    } ${listOf(feeds.map(item))}, which you grow. A plot's cell holds a crop or an animal, never both, and a plot's ${count(
      FARM.scarecrowCells * FARM.scarecrowCells,
      'cell',
    )} can be any mix of them.
`;
  },
});
