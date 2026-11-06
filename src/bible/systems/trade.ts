// Trade and Pack Running: written from its rules (`rules` below); every number from the content and the rules.

import { ITEMS, RECIPES, VENDORS } from '../../content/items';
import { CARRY, CLOCK, DEMAND, FRESHNESS, type PackDef, PACKS, placeName, ROUTES } from '../../content/trade';
import { MOUNTS } from '../../content/vehicles';
import { freshness } from '../../engine/island';
import { EMBERHOLM as Z } from '../../engine/zone';
import { change, coins, count, duration, key, metres, num, pct, speed, times } from '../format';
import { system, table } from '../kit';
import { type Html, link, md, phrase, raw } from '../md';
import { sourceNumber } from '../source';
import interactSource from '../../sim/life/interact.ts?raw';

const isTrade = (p: PackDef): boolean => p.kind !== 'material';
const itemName = (id: string): string => ITEMS.find((i) => i.id === id)?.name ?? id;
const goods = (p: PackDef): Html => raw(p.inputs.map((i) => phrase`${i.n} ${link(`items/${i.item}`, itemName(i.item))}`.html).join(', '));
const benchOf = (p: PackDef): Html => {
  const r = RECIPES.find((x) => x.makes.pack === p.id);
  const b = r ? (Z.workbenches.find((w) => w.id === r.bench) as { id: string; name?: string } | undefined) : undefined;
  return b ? link(`workbenches/${b.id}`, b.name ?? b.id) : raw('');
};

/** What a trading post pays (the rules' quote): base × route × demand × freshness, rounded to the copper. */
const pays = (p: PackDef, factor: number, demand: number, age: number): number => Math.round(p.base * factor * demand * freshness(age));

/** What a vendor pays for an item: its worth times their rate, rounded, never under a copper (src/sim/life/trade.ts, sell). */
const vendorPays = (id: string): number => {
  const worth = ITEMS.find((i) => i.id === id)?.value ?? 0;
  return Math.max(0, ...VENDORS.filter((v) => v.buys.includes(id)).map((v) => Math.max(1, Math.round(worth * v.buyRate))));
};

export const trade = system({
  id: 'trade',
  title: 'Trade and Pack Running',
  summary: 'Making packs at a workbench, carrying them, and selling them far away: routes, demand, freshness and seals.',
  icon: '📦',
  keywords: ['pack', 'packs', 'trade pack', 'workbench', 'trading post', 'route', 'demand', 'freshness', 'fresh', 'stale', 'sell', 'seal', 'carry', 'haul'],
  rules: ['src/sim/life/trade.ts', 'crates/engine/src/life/trade.rs', 'src/sim/life/interact.ts'],
  content: [
    'shared/trade.json#carry',
    'shared/trade.json#demand',
    'shared/trade.json#freshness',
    'shared/trade.json#packs',
    'shared/trade.json#routes',
    'shared/zones/*.json#outposts',
  ],
  body: () => {
    const benchReach = sourceNumber(
      interactSource,
      /Math\.hypot\(bench\.x - p\.pos\.x, bench\.z - p\.pos\.z\) <= ([\d.]+)/,
      'how close to a workbench you must be to use it',
    );
    const talkReach = sourceNumber(
      interactSource,
      /Math\.hypot\(n\.x - p\.pos\.x, n\.z - p\.pos\.z\);\s*if \(d > ([\d.]+)\) continue;/,
      'how close to a trader you must be',
    );
    const tradePacks = PACKS.filter(isTrade);
    const materials = PACKS.filter((p) => !isTrade(p));
    const ex = tradePacks[0];
    const exRoute = ROUTES.find((r) => r.from === ex?.origin);
    const exPrice = ex && exRoute ? pays(ex, exRoute.factor, DEMAND.start, 0) : 0;
    const packMounts = MOUNTS.filter((m) => m.canCarryPack);
    const posts = Z.outposts;
    const midAge = (FRESHNESS.bonusSeconds + FRESHNESS.staleSeconds) / 2;
    const origins = [...new Set(tradePacks.map((p) => p.origin))];
    return md`
A trade pack is local produce packed at a workbench. You carry it on your back, slowly, or in a vehicle, and sell it at a trading post somewhere else for far more than the goods would fetch on their own. Farther routes pay more; each sale lowers that post's appetite for that pack until it recovers; and a fresh pack earns a bonus that sours as it sits. Material packs are made the same way and carried the same way, but go to building sites instead ([[systems/housing]], [[systems/vehicles]]).

## Making a Pack

${key('F')} at a workbench opens it, and choosing a pack makes it, if you are within ${metres(benchReach)} of the bench. The bench refuses, in this order:

1. When there is already a pack on your back: *set that pack down first*.
1. When you aren't standing on the ground on foot: *Stand still at the bench to work*.
1. When you haven't all the goods it takes.
1. When you can't pay its fee, or haven't the labor for it.

Then the goods leave your bag, the fee and the labor are spent, and the pack is on your back. It remembers where it was made (the bench's place) and when.

${table(
  ['Pack', 'Made With', 'From', 'Labor', 'Fee', 'Base Price'],
  tradePacks.map((p) => [link(`packs/${p.id}`, p.name), benchOf(p), goods(p), p.labor, coins(p.fee), coins(p.base)]),
  [3, 4, 5],
)}

The material packs, ${materials.length ? raw(materials.map((p) => link(`packs/${p.id}`, p.name).html).join(', ')) : 'none'}, are made the same way and never sell.

## Carrying a Pack

You carry a single pack, on your back, and it weighs on everything you do:

- On the ground you move at ${pct(CARRY.speedFactor)} of your speed, and can't sprint.
- Your jump leaves the ground at ${pct(CARRY.jumpFactor)} of its speed, so it rises ${pct(CARRY.jumpFactor * CARRY.jumpFactor)} as high, and there is no second jump.
- You swim at ${pct(CARRY.swimFactor)} of your speed.
- Your glider won't open: *Too heavy to glide with a trade pack*.
- Only a pack animal carries you with one: ${
      packMounts.length
        ? raw(packMounts.map((m) => phrase`the ${link(`mounts/${m.id}`, m.name.toLowerCase())}, at up to ${speed(m.packSpeed)}`.html).join(', '))
        : 'none'
    }. A cart or a boat wants the pack loaded into it first ([[systems/vehicles]]).

${key('X')} sets your pack down on the ground in front of you, except while you ride or swim. ${key('F')} within ${metres(
      CARRY.pickupRange,
    )} of a pack on the ground picks it up again, if your back is free. Packs you set down stay where they are, on your island.

${key('F')} at a vehicle's cargo bed loads your pack into its first free place, and with your back free, ${key(
      'F',
    )} there takes the first pack aboard back out. A vehicle with packs aboard can't be sent home; a boat that breaks up in a storm leaves its packs floating where it went down ([[systems/vehicles]]).

## Where a Pack Sells

${raw(posts.map((o) => link(`places/${o.id}`, placeName(o.id)).html).join(' and '))} are the trading posts: ${raw(
      posts.map((o) => phrase`${link(`npcs/${o.npc}`, Z.npcs.find((n) => n.id === o.npc)?.name ?? o.npc)} at ${placeName(o.id)}`.html).join(', '),
    )}. Come within ${metres(talkReach)} of the trader with a pack on your back and ${key(
      'F',
    )} sells it, or the prompt says why not: a material pack goes to a building site, a pack never sells where it was made, and a post buys only packs with a route to it from where they were made.

${table(
  ['From', 'To', 'Route', 'Seals a Pack'],
  ROUTES.map((r) => [link(`places/${r.from}`, placeName(r.from)), link(`places/${r.to}`, placeName(r.to)), times(r.factor), r.seals]),
  [2, 3],
)}

## The Price

$$
price = base price × route × demand × freshness, to the nearest copper
${ex && exRoute ? phrase`${ex.name} at ${placeName(exRoute.to)}, fresh, at the demand a post starts at:` : ''}
${ex && exRoute ? phrase`${coins(ex.base)} × ${num(exRoute.factor)} × ${num(DEMAND.start)} × ${num(freshness(0))} = ${coins(exPrice)}` : ''}
$$

A sale pays the route's Charter Seals on top ([[systems/economy]]), and counts for a contract you hold there ([[systems/contracts]]). What every trade pack fetches on every route:

${table(
  ['Pack', 'At', 'Fresh, Starting Demand', 'Fresh, Highest Demand', 'Stale, Lowest Demand', 'Seals'],
  tradePacks.flatMap((p) =>
    ROUTES.filter((r) => r.from === p.origin).map((r) => [
      link(`packs/${p.id}`, p.name),
      placeName(r.to),
      coins(pays(p, r.factor, DEMAND.start, 0)),
      coins(pays(p, r.factor, DEMAND.max, 0)),
      coins(pays(p, r.factor, DEMAND.min, FRESHNESS.staleSeconds)),
      r.seals,
    ]),
  ),
  [2, 3, 4, 5],
)}

## Demand

Every trading post keeps a demand for every pack, on your island. It starts at ${pct(DEMAND.start)}. Each sale is paid at the demand there was, then lowers it by ${pct(
      DEMAND.dropPerSale,
    )}, never below ${pct(DEMAND.min)}. A demand you have lowered climbs back steadily, ${pct(DEMAND.recoverPerMinute)} a minute, all the way to ${pct(
      DEMAND.max,
    )}: past where it started, so a post you sold to once and then left alone pays more than one you never sold to.

$$
after a sale: demand = the larger of (${pct(DEMAND.min)}, demand − ${pct(DEMAND.dropPerSale)})
every second after: demand = the smaller of (${pct(DEMAND.max)}, demand + ${pct(DEMAND.recoverPerMinute)} ÷ 60)
$$

A single sale takes ${duration((DEMAND.dropPerSale / DEMAND.recoverPerMinute) * 60)} to win back; a post sold down to the bottom takes ${duration(
      ((DEMAND.max - DEMAND.min) / DEMAND.recoverPerMinute) * 60,
    )} to climb all the way to the top. Demand recovers while you are away too.

## Freshness

A pack's age is how long the island's clock has run since it was made, and that clock runs while you are away (up to ${duration(
      CLOCK.maxOfflineSeconds,
    )} at a time), so packs age while you are gone. Until it is ${duration(FRESHNESS.bonusSeconds)} old a pack is fresh and pays ${change(
      FRESHNESS.bonus,
    )}; from then until ${duration(FRESHNESS.staleSeconds)} its bonus falls in a straight line to ${change(FRESHNESS.penalty)}, and it stays there.

$$
freshness = 1 + ${num(FRESHNESS.bonus)} up to ${duration(FRESHNESS.bonusSeconds)} old
then 1 + ${num(FRESHNESS.bonus)} + (${num(FRESHNESS.penalty)} − ${num(FRESHNESS.bonus)}) × (age − ${duration(FRESHNESS.bonusSeconds)}) ÷ (${duration(
      FRESHNESS.staleSeconds,
    )} − ${duration(FRESHNESS.bonusSeconds)})
and 1 + ${num(FRESHNESS.penalty)} from ${duration(FRESHNESS.staleSeconds)} old on
$$

${table(
  ['Age', 'Freshness', 'Changes the Price By'],
  [0, FRESHNESS.bonusSeconds, midAge, FRESHNESS.staleSeconds].map((a) => [duration(a), num(freshness(a), 3), change(freshness(a) - 1)]),
  [1, 2],
)}

## Is It Worth Packing?

What a pack's goods would fetch sold to a vendor one by one, against what the pack itself fetches fresh at the demand a post starts at, less its fee:

${table(
  ['Pack', 'Its Goods at a Vendor', 'Fee', 'Labor', 'Packed and Sold'],
  tradePacks.map((p) => {
    const loose = p.inputs.reduce((t, i) => t + i.n * vendorPays(i.item), 0);
    const best = Math.max(0, ...ROUTES.filter((r) => r.from === p.origin).map((r) => pays(p, r.factor, DEMAND.start, 0)));
    return [link(`packs/${p.id}`, p.name), coins(loose), coins(p.fee), p.labor, phrase`up to ${coins(best - p.fee)}`];
  }),
  [1, 2, 3, 4],
)}

On top of that come the route's seals. The cost is the labor and the haul: ${count(tradePacks.length, 'trade pack')} to choose from, made at ${raw(
      origins.map((o) => link(`places/${o}`, placeName(o)).html).join(' and '),
    )}.
`;
  },
});
