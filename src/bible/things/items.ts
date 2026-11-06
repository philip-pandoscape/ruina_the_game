// Items, the recipes that make things, the vendors who sell and buy them, and the workbenches.

import { ANIMALS, CROPS, GATHERING } from '../../content/farming';
import { BAG_SLOTS, CATEGORIES, type ItemCat, type ItemDef, ITEMS, RECIPES, type RecipeDef, VENDORS, type VendorDef } from '../../content/items';
import { QUESTS } from '../../content/quests';
import { PACKS } from '../../content/trade';
import { VEHICLES } from '../../content/vehicles';
import { coins, count, pct, range } from '../format';
import { described, join, kind, note, table } from '../kit';
import { blockHtml, type Html, link, md, phrase, raw } from '../md';
import {
  benchLink,
  buyPrice,
  itemLink,
  itemsList,
  nearestPlace,
  npcLink,
  offersOf,
  packLink,
  placeLink,
  priceHtml,
  recipeMakes,
  recipeNeeds,
  recipesMaking,
  ZONE,
} from './refs';

/** A category's heading (shared/items.json `categories`). */
const CATEGORY = (cat: ItemCat): string => CATEGORIES[cat]?.group ?? cat;

const bullets = (list: Html[]): Html => blockHtml(`<ul>${list.map((f) => `<li>${f.html}</li>`).join('')}</ul>`);

/** Where an item comes from, besides buying it. */
function sources(it: ItemDef): Html[] {
  const out: Html[] = [];
  for (const c of CROPS) {
    if (c.produce === it.id) out.push(phrase`Harvested from ${link(`crops/${c.id}`, c.name)}, ${range(c.yield)} at a time.`);
    if (c.seed === it.id && c.seedChance)
      out.push(phrase`Sometimes left over when you harvest ${link(`crops/${c.id}`, c.name)}: ${pct(c.seedChance)} of harvests.`);
    if (c.chop?.item === it.id) out.push(phrase`Felled from a grown ${link(`crops/${c.id}`, c.name)}, ${range(c.chop.yield)} at a time.`);
  }
  for (const [id, g] of Object.entries(GATHERING)) {
    if (g.item === it.id) out.push(phrase`Gathered at ${link(`gathering/${id}`)}, ${range(g.n)} at a time.`);
    if (g.rare?.item === it.id) out.push(phrase`A rare find at ${link(`gathering/${id}`)}: ${pct(g.rare.chance)} of the time.`);
  }
  for (const a of ANIMALS) if (a.produce === it.id) out.push(phrase`Collected from a grown ${link(`animals/${a.id}`, a.name)}, ${range(a.yield)} at a time.`);
  for (const r of recipesMaking(it.id)) out.push(phrase`Made by ${link(`recipes/${r.id}`, 'a recipe')} with ${benchLink(r.bench)}.`);
  for (const q of QUESTS) {
    if (q.rewards.items?.some((i) => i.item === it.id)) out.push(phrase`A reward for the quest ${link(`quests/${q.id}`)}.`);
    if (q.startItems?.some((i) => i.item === it.id)) out.push(phrase`Handed to you when you take the quest ${link(`quests/${q.id}`)}.`);
  }
  return out;
}

/** What an item is used for. */
function uses(it: ItemDef): Html[] {
  const out: Html[] = [];
  for (const p of PACKS) if (p.inputs.some((i) => i.item === it.id)) out.push(phrase`Packed into ${packLink(p.id)}.`);
  for (const r of RECIPES) if (!r.makes.pack && r.inputs?.some((i) => i.item === it.id)) out.push(phrase`Made into ${recipeMakes(r)}.`);
  for (const a of ANIMALS) if (a.feed === it.id) out.push(phrase`Fed to ${link(`animals/${a.id}`, a.name)}.`);
  return out;
}

export const items = kind<ItemDef>({
  id: 'items',
  section: 'things',
  title: 'Items',
  noun: 'Item',
  icon: '🎒',
  summary: 'Everything that lives in your bag: seeds, produce, materials, deeds, whistles and the rest.',
  sources: ['shared/items.json#items', 'shared/items.json#bagSlots', 'shared/items.json#categories'],
  systems: ['economy', 'farming', 'trade'],
  all: () => ITEMS,
  key: (it) => it.id,
  name: (it) => it.name,
  iconOf: (it) => it.icon,
  itemId: (it) => it.id,
  group: (it) => CATEGORY(it.cat),
  line: (it) => it.desc,
  explain: (it) => described(it.desc),
  facts: (it) => {
    const offers = offersOf(it.id);
    const buyers = VENDORS.filter((v) => v.buys.includes(it.id));
    return [
      ['Kind', CATEGORY(it.cat)],
      ['Stacks to', it.stack],
      ['Worth', coins(it.value)],
      ['Sold by', offers.length ? raw(offers.map((o) => `${npcLink(o.vendor.npc).html}: ${priceHtml(o.price, o.seals).html}`).join('<br>')) : null],
      ['Bought by', buyers.length ? raw(buyers.map((v) => `${npcLink(v.npc).html}: ${coins(buyPrice(it.value, v.buyRate)).html}`).join('<br>')) : null],
      ['Plants', it.plants ? link(`crops/${it.plants}`) : null],
      ['Grows into', it.raises ? link(`animals/${it.raises}`) : null],
      ['Opens', it.glider ? link(`gliders/${it.glider}`) : null],
      ['Summons', it.vehicle ? link(`${VEHICLES.some((v) => v.id === it.vehicle) ? 'vehicles' : 'ships'}/${it.vehicle}`) : null],
      ['Calls', it.mount ? link(`mounts/${it.mount}`) : null],
      ['Restores', it.use?.labor ? phrase`${it.use.labor} labor` : null],
    ];
  },
  body: (it) => {
    const from = sources(it);
    const usedFor = uses(it);
    return join(
      from.length ? md`## Where It Comes From` : null,
      from.length ? bullets(from) : null,
      usedFor.length ? md`## What It Is For` : null,
      usedFor.length ? bullets(usedFor) : null,
      md`Your bag holds ${count(BAG_SLOTS, 'stack')}; a stack of this holds ${it.stack}.`,
    );
  },
  columns: [
    ['Worth', (it) => coins(it.value)],
    ['Stacks', (it) => it.stack],
  ],
});

// ---------- recipes ----------

const recipeName = (r: RecipeDef): string =>
  r.makes.pack ? (PACKS.find((p) => p.id === r.makes.pack)?.name ?? r.id) : (ITEMS.find((i) => i.id === r.makes.item)?.name ?? r.id);

const benchName = (bench: string): string =>
  (ZONE.workbenches.find((b) => b.id === bench) as { name?: string } | undefined)?.name ?? ZONE.npcs.find((n) => n.id === bench)?.name ?? bench;

export const recipes = kind<RecipeDef>({
  id: 'recipes',
  section: 'things',
  title: 'Recipes',
  noun: 'Recipe',
  icon: '📜',
  summary: 'What workbenches and crafters make, from what, for how much labor and money.',
  sources: ['shared/items.json#recipes'],
  systems: ['trade', 'economy'],
  all: () => RECIPES,
  key: (r) => r.id,
  name: recipeName,
  iconOf: (r) => (r.makes.pack ? PACKS.find((p) => p.id === r.makes.pack)?.icon : ITEMS.find((i) => i.id === r.makes.item)?.icon),
  itemId: (r) => r.makes.item,
  group: (r) => benchName(r.bench),
  line: (r) => `Made with ${benchName(r.bench)}.`,
  explain: (r) => {
    const n = recipeNeeds(r);
    const parts = [n.inputs.length ? itemsList(n.inputs) : null, n.labor ? phrase`${n.labor} labor` : null, n.coins ? coins(n.coins) : null].filter(
      (p): p is Html => !!p,
    );
    const takes = parts.length ? parts.map((p) => p.html).join(', ') : 'nothing';
    return md`With ${benchLink(r.bench)}, ${raw(takes)} make ${recipeMakes(r)}.`;
  },
  facts: (r) => {
    const n = recipeNeeds(r);
    return [
      ['With', benchLink(r.bench)],
      ['Makes', recipeMakes(r)],
      ['Takes', n.inputs.length ? itemsList(n.inputs) : null],
      ['Labor', n.labor || null],
      ['Costs', n.coins ? coins(n.coins) : null],
    ];
  },
  columns: [
    ['Takes', (r) => itemsList(recipeNeeds(r).inputs)],
    ['Labor', (r) => recipeNeeds(r).labor],
    ['Costs', (r) => coins(recipeNeeds(r).coins)],
  ],
});

// ---------- vendors ----------

export const vendors = kind<VendorDef>({
  id: 'vendors',
  section: 'things',
  title: 'Vendors',
  noun: 'Vendor',
  icon: '🪙',
  summary: 'Who sells what on the island, for how much, and what they will buy from you.',
  sources: ['shared/items.json#vendors'],
  systems: ['economy'],
  all: () => VENDORS,
  key: (v) => v.npc,
  name: (v) => v.name,
  iconOf: () => '🪙',
  line: (v) => `The shop kept by ${ZONE.npcs.find((n) => n.id === v.npc)?.name ?? v.npc}.`,
  explain: (v) =>
    v.buys.length
      ? md`${npcLink(v.npc)} sells ${count(v.sells.length, 'thing')} and buys ${count(v.buys.length, 'kind')} of goods from you, paying ${pct(v.buyRate)} of what each is worth, rounded, and never less than a copper.`
      : md`${npcLink(v.npc)} sells ${count(v.sells.length, 'thing')} and buys nothing.`,
  facts: (v) => {
    const npc = ZONE.npcs.find((n) => n.id === v.npc);
    return [
      ['Keeper', npcLink(v.npc)],
      ['Where', npc ? placeLink(nearestPlace(npc.x, npc.z).id) : null],
      ['Pays', v.buys.length ? phrase`${pct(v.buyRate)} of worth` : null],
    ];
  },
  body: (v) =>
    join(
      md`## Sells`,
      table(
        ['Item', 'Price'],
        v.sells.map((s) => [itemLink(s.item), priceHtml(s.price, s.seals)]),
        [1],
      ),
      v.buys.length ? md`## Buys` : null,
      v.buys.length
        ? table(
            ['Item', 'Pays'],
            v.buys.map((id) => [itemLink(id), coins(buyPrice(ITEMS.find((i) => i.id === id)?.value ?? 0, v.buyRate))]),
            [1],
          )
        : null,
    ),
  columns: [
    ['Keeper', (v) => npcLink(v.npc)],
    ['Sells', (v) => v.sells.length],
    ['Buys', (v) => v.buys.length],
  ],
});

// ---------- workbenches ----------

type Bench = { id: string; name?: string; place: string; x: number; z: number };

export const workbenches = kind<Bench>({
  id: 'workbenches',
  section: 'world',
  title: 'Workbenches',
  noun: 'Workbench',
  icon: '🧰',
  summary: 'Where local goods are packed into trade packs and building materials.',
  sources: ['shared/regions/*.json#workbenches'],
  systems: ['trade'],
  all: () => ZONE.workbenches as Bench[],
  key: (b) => b.id,
  name: (b) => b.name ?? b.id,
  iconOf: () => '🧰',
  line: (b) => `A workbench at ${ZONE.places.find((p) => p.id === b.place)?.name ?? b.place}.`,
  explain: (b) => note('workbenches', b.id),
  facts: (b) => [
    ['Where', placeLink(b.place)],
    ['Makes', count(RECIPES.filter((r) => r.bench === b.id).length, 'recipe')],
  ],
  body: (b) =>
    join(
      md`## What It Makes`,
      table(
        ['Makes', 'From', 'Labor', 'Fee'],
        RECIPES.filter((r) => r.bench === b.id).map((r) => {
          const n = recipeNeeds(r);
          return [recipeMakes(r), itemsList(n.inputs), n.labor, coins(n.coins)];
        }),
        [2, 3],
      ),
    ),
  columns: [
    ['Where', (b) => placeLink(b.place)],
    ['Recipes', (b) => RECIPES.filter((r) => r.bench === b.id).length],
  ],
});
