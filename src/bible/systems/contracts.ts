// Contracts: written from its rules (`rules` below); every number from the content and the rules.

import { QUESTS } from '../../content/quests';
import { CONTRACTS, PACKS, placeName, route } from '../../content/trade';
import { EMBERHOLM as Z } from '../../engine/zone';
import { coins, count, duration, key, listOf, metres, num, pct, range } from '../format';
import { system, table } from '../kit';
import { link, md, phrase } from '../md';
import { sourceNumber } from '../source';
import interactSource from '../../../crates/engine/src/life/interact.rs?raw';

/** The trade packs a post buys: any with a route to it from where it is made (the rules' `wanted`). */
const wanted = (post: string) => PACKS.filter((p) => p.kind !== 'material' && route(p.origin, post));

/** A contract's bonus coins and seals for so many packs (the rules' stepContracts). */
const bonus = (base: number, factor: number, n: number) => ({
  coins: Math.round(base * factor * CONTRACTS.coinBonus * n),
  seals: Math.max(1, Math.round(CONTRACTS.sealsPerPack * n * factor)),
});

export const contracts = system({
  id: 'contracts',
  title: 'Contracts',
  summary: 'The orders on the trading posts’ boards: so many packs of a kind, in time, for a bonus.',
  icon: '📋',
  keywords: ['contract', 'contracts', 'board', 'order', 'bonus', 'trading post', 'seals'],
  rules: ['crates/engine/src/life/contracts.rs'],
  content: ['shared/trade.json#contracts'],
  body: () => {
    const reach = sourceNumber(
      interactSource,
      /post\.is_some_and\(\|post\| near_npc\(sim, &post\.npc, ([\d.]+)\)\)/,
      'how close to a trader you must be to take a contract',
    );
    const [lo, hi] = CONTRACTS.count;
    const quests = QUESTS.filter((q) => q.steps.some((s) => s.objectives.some((o) => o.type === 'contract')));
    return md`
Every trading post keeps a board of contracts: orders for so many packs of a kind, to be sold there within a time. Fill one and the post pays a bonus in coin and Charter Seals on top of what each pack fetched anyway. It is pack running with a goal ([[systems/trade]]).

## The Boards

Your board at each post holds ${count(CONTRACTS.perOutpost, 'contract')}. Every ${duration(
      CONTRACTS.refreshSeconds,
    )} the boards are topped up, starting from your life's first moment. A new contract is for:

- a pack drawn from the trade packs that post buys, each as likely as the others: those with a route to it from where they are made;
- a number of them drawn from ${range(CONTRACTS.count)}, each as likely;
- a bonus worked out from the pack, the route and the number (below).

A contract nobody takes comes down after ${duration(CONTRACTS.durationSeconds + CONTRACTS.refreshSeconds)}, and the next top-up puts another in its place.

## Taking One

Talk to the post's trader and take a contract from their board, while you are within ${metres(reach)} of them. You can hold ${count(
      CONTRACTS.maxActive,
      'contract',
    )} at a time, from any posts. From the moment you take it, you have ${duration(CONTRACTS.durationSeconds)} to fill it.

## Filling It

Sell packs of its kind at its post, the usual way (${key('F')} on the trader with the pack on your back). Every sale counts toward the first contract you hold there for that pack, and is paid as it would be anyway. When the last one is sold, the contract is done and pays its bonus:

$$
bonus coins = (base price × route × ${num(CONTRACTS.coinBonus)} × the number of packs), to the nearest copper
bonus seals = the larger of (1, ${num(CONTRACTS.sealsPerPack)} × the number of packs × route, to the nearest seal)
$$

That is ${pct(CONTRACTS.coinBonus)} of what the packs would fetch on that route at their base price, before demand and freshness, and at least a seal; the packs' own prices and seals are paid as well, sale by sale.

## Running Out

When its time runs out, a contract you hold lapses: it comes off your list and its bonus is lost. Nothing else is taken from you; the packs you sold for it were paid when you sold them. Your life's clock runs while you are away, so a contract can run out while you are gone.

## What They Pay

${table(
  ['Post', 'Pack', `Bonus for ${lo} ${lo === 1 ? 'Pack' : 'Packs'}`, `Bonus for ${hi} ${hi === 1 ? 'Pack' : 'Packs'}`],
  Z.outposts.flatMap((o) =>
    wanted(o.id).map((p) => {
      const r = route(p.origin, o.id)!;
      const a = bonus(p.base, r.factor, lo);
      const b = bonus(p.base, r.factor, hi);
      return [
        link(`places/${o.id}`, placeName(o.id)),
        link(`packs/${p.id}`, p.name),
        phrase`${coins(a.coins)} + ${count(a.seals, 'seal')}`,
        phrase`${coins(b.coins)} + ${count(b.seals, 'seal')}`,
      ];
    }),
  ),
  [2, 3],
)}

${quests.length ? phrase`The contracts you fill count for ${listOf(quests.map((q) => phrase`the ${q.milestone ? 'milestone' : 'quest'} ${link(`quests/${q.id}`)}`))}.` : ''}
`;
  },
});
