// Trade packs and material packs: what they are made from, where they sell, what they build.

import { BLUEPRINTS } from '../../content/housing';
import { RECIPES } from '../../content/items';
import { SHIP_DESIGNS } from '../../content/shipyard';
import { DEMAND, FRESHNESS, type PackDef, PACKS, PLACES, placeName, ROUTES } from '../../content/trade';
import { freshness } from '../../engine/life';
import { coins, pct, times } from '../format';
import { join, kind, note, table } from '../kit';
import { link, md } from '../md';
import { benchLink, itemsList } from './refs';

const isMaterial = (p: PackDef): boolean => p.kind === 'material';

/** What a trading post pays for a pack (the rules' quote): base × route × demand × freshness, rounded. */
const pays = (p: PackDef, factor: number, demand: number, ageSeconds: number): number => Math.round(p.base * factor * demand * freshness(ageSeconds));

/** The building stages and ship stages that need a material pack. */
function neededBy(id: string): Array<[string, string, number]> {
  const out: Array<[string, string, number]> = [];
  for (const b of BLUEPRINTS) for (const s of b.stages) if (s.needs[id]) out.push([`blueprints/${b.id}`, s.name, s.needs[id]]);
  for (const d of SHIP_DESIGNS) for (const s of d.stages) if (s.needs[id]) out.push([`ships/${d.id}`, s.name, s.needs[id]]);
  return out;
}

export const packs = kind<PackDef>({
  id: 'packs',
  section: 'things',
  title: 'Packs',
  noun: 'Pack',
  icon: '📦',
  summary: 'Trade packs to sell far away and material packs to build with, carried on your back or in a vehicle.',
  sources: ['shared/trade.json#packs', 'shared/trade.json#routes', 'shared/trade.json#places'],
  systems: ['trade', 'contracts', 'housing', 'vehicles'],
  all: () => PACKS,
  key: (p) => p.id,
  name: (p) => p.name,
  iconOf: (p) => p.icon,
  group: (p) => (isMaterial(p) ? 'Material Packs' : 'Trade Packs'),
  line: (p) => (isMaterial(p) ? `A material pack made at ${placeName(p.origin)}.` : `A trade pack from ${placeName(p.origin)}.`),
  explain: (p) => note('packs', p.id),
  facts: (p) => {
    const recipe = RECIPES.find((r) => r.makes.pack === p.id);
    return [
      ['Kind', isMaterial(p) ? 'Material pack' : 'Trade pack'],
      ['Made with', recipe ? benchLink(recipe.bench) : null],
      ['From', itemsList(p.inputs)],
      ['Labor', p.labor],
      ['Fee', coins(p.fee)],
      ['Base price', isMaterial(p) ? null : coins(p.base)],
    ];
  },
  body: (p) => {
    if (isMaterial(p)) {
      const needs = neededBy(p.id);
      return join(
        md`## What It Builds`,
        md`A material pack doesn't sell: it is hauled to a building site and used up there. Carry it like any pack (see [[systems/trade]]).`,
        needs.length
          ? table(
              ['For', 'Stage', 'Packs'],
              needs.map(([path, stage, n]) => [link(path), stage, n]),
              [2],
            )
          : null,
      );
    }
    const routes = ROUTES.filter((r) => r.from === p.origin);
    const stale = FRESHNESS.staleSeconds;
    return join(
      md`## Where It Sells`,
      md`It sells for nothing where it was made. At a trading post it pays its base price times the route's factor, the post's demand for it and its freshness, rounded to the copper, and seals on top ([[systems/trade]] has the rules). Here is what one fetches fresh at the demand a post starts at (${pct(DEMAND.start)}), and stale at the lowest demand (${pct(DEMAND.min)}):`,
      table(
        ['Sold At', 'Route', 'Seals', 'Fresh', 'Stale, Lowest Demand'],
        routes.map((r) => [
          link(`places/${r.to}`, PLACES.find((x) => x.id === r.to)?.name ?? r.to),
          times(r.factor),
          r.seals,
          coins(pays(p, r.factor, DEMAND.start, 0)),
          coins(pays(p, r.factor, DEMAND.min, stale)),
        ]),
        [1, 2, 3, 4],
      ),
      md`A trading post's contracts can ask for it, for more than it fetches alone: see [[systems/contracts]].`,
    );
  },
  columns: [
    ['From', (p) => itemsList(p.inputs)],
    ['Labor', (p) => p.labor],
    ['Base', (p) => (isMaterial(p) ? '' : coins(p.base))],
  ],
});
