import { BLUEPRINTS } from '../../content/housing';
import { CATEGORIES, type ItemCat, ITEMS, RECIPES, VENDORS } from '../../content/items';
import { CHALLENGE, MINIGAMES } from '../../content/minigames';
import { QUESTS } from '../../content/quests';
import type { Engine } from '../../engine/engine';
import { DAY, housePose, type IslandView, islandData, type LifeState } from '../../engine/island';
import { minigameDeal } from '../../engine/minigames';
import type { LifeUI } from '../../ui/life/lifeUI';
import type { MinigamesUI } from '../../ui/minigames/minigames';
import type { TableView } from '../../ui/minigames/tables';
import type { PartyUI } from '../../ui/party/partyUI';
import type { SkillsPanel } from '../../ui/skills/panel';
import type { MadeUpParty, MadeUpTables } from './fakes';

// How each entry of the UI gallery (entries.ts) is made up on a real offline island: what is given,
// where you stand, what is said by the made-up world connection, and which window opens. Everything
// is picked from the content by what it is (the first merchant, the first quest a newcomer is
// offered, the first game), never by its id, so the gallery follows the content as it changes.

/** The gallery page as a recipe uses it (src/dev/ui/main.ts). */
export interface Gallery {
  engine: Engine;
  life: IslandView;
  ui: LifeUI;
  skills: SkillsPanel;
  minigames: MinigamesUI;
  tables: MadeUpTables;
  party: PartyUI;
  partyLink: MadeUpParty;
  /** You, as the online windows know you. */
  me: { id: number; name: string };
  /** Runs the island on `n` steps (a command given runs on the next one). */
  step(n?: number): void;
}

/** Makes up an entry's state and opens its window. */
export type MakeUp = (g: Gallery) => void;

/** Other players, made up, for the online windows. */
export const OTHERS = [
  { id: 2, name: 'Wren' },
  { id: 3, name: 'Osric' },
];

/** The first stake that is a stake. */
const STAKE = CHALLENGE.stakes.find((s) => s > 0) ?? 0;

const fail = (what: string): never => {
  throw new Error(`the content has no ${what}`);
};

/** Gives you `n` of `item`, as the Developer Tools do. */
const give = (g: Gallery, item: string, n = 1): void => g.engine.command({ t: 'grant', item, n });

/** The first item of a category. */
const firstOf = (cat: ItemCat) => ITEMS.find((i) => i.cat === cat);

/** Townspeople, by id. */
const townsfolk = (g: Gallery): Set<string> => new Set(g.life.zone.recipe.npcs.map((n) => n.id));

/** Stands you 1.6 m in front of townsperson `id`, facing them, as walking up to them would. */
function faceNpc(g: Gallery, id: string): void {
  const n = g.life.zone.recipe.npcs.find((x) => x.id === id) ?? fail(`townsperson ${id}`);
  g.engine.place(n.x + Math.sin(n.facing) * 1.6, n.z + Math.cos(n.facing) * 1.6, n.facing + Math.PI);
  g.step();
}

/** The island as a save would hold it, changed by `change`, loaded again where you stand. */
function reload(g: Gallery, change: (state: LifeState) => void): void {
  const island = islandData(g.life, g.engine.sim);
  const state = structuredClone(island.state);
  change(state);
  g.engine.loadIsland({ state, player: island.player, savedAt: Date.now() });
  g.step();
}

/** The quests a new island starts you on (milestones start by themselves too, but are kept as they go). */
const opening = (): Set<string> => new Set(QUESTS.filter((q) => q.auto && !q.milestone).map((q) => q.id));

/** The quests a new island starts you on, done and handed in, as a save would hold them. */
function openingDone(g: Gallery): void {
  const done = opening();
  reload(g, (s) => {
    s.quests.active = s.quests.active.filter((p) => !done.has(p.id));
    s.quests.done.push(...[...done].filter((id) => !s.quests.done.includes(id)));
  });
}

/** The first quest someone in town offers once the opening quests are done. */
function firstQuest(g: Gallery) {
  const town = townsfolk(g);
  const done = opening();
  return QUESTS.find((q) => !q.auto && !q.milestone && town.has(q.giver) && q.after.every((a) => done.has(a))) ?? fail('quest for a newcomer');
}

/** The first merchant with someone in town to keep the shop. */
function firstMerchant(g: Gallery) {
  const town = townsfolk(g);
  return VENDORS.find((v) => town.has(v.npc)) ?? fail('merchant');
}

/** The first workbench. */
const firstBench = (g: Gallery) => g.life.zone.recipe.workbenches[0] ?? fail('bench to make things at');

/** The first thing made at the first workbench. */
const firstRecipe = (g: Gallery) => RECIPES.find((r) => r.bench === firstBench(g).id);

/** Stands you beside the first workbench and opens it. */
function atBench(g: Gallery): void {
  const bench = firstBench(g);
  g.engine.place(bench.x, bench.z + 2, Math.PI);
  g.step();
  g.ui.open({ kind: 'craft', id: bench.id });
}

/** In the first merchant's shop, on tab `tab`. */
function shop(g: Gallery, tab: 'buy' | 'sell' | 'buyback'): void {
  const v = firstMerchant(g);
  faceNpc(g, v.npc);
  if (tab !== 'buy') {
    for (const item of v.buys) give(g, item, Math.min(5, ITEMS.find((i) => i.id === item)?.stack ?? 1));
    g.step();
  }
  if (tab === 'buyback') {
    const item = v.buys[0] ?? fail(`thing ${v.name} buys`);
    g.engine.command({ t: 'sell', npc: v.npc, item, n: 1 });
    g.step();
  }
  g.ui.open({ kind: 'shop', id: v.npc, tab });
}

/** A finished house of the first blueprint on the first plot, a few things in its chest: an island as a save would hold it. */
function finishedHouse(g: Gallery): number {
  const bp = BLUEPRINTS[0] ?? fail('house blueprint');
  const plot = g.life.zone.recipe.housePlots[0] ?? fail('house plot');
  let id = 0;
  reload(g, (s) => {
    id = s.nextId++;
    s.houses.push({ id, plot: plot.id, blueprint: bp.id, stage: bp.stages.length, delivered: {}, storage: [], taxPaidUntil: s.clock + bp.graceDays * DAY });
  });
  for (const cat of ['material', 'produce'] as const) {
    const item = firstOf(cat);
    if (!item) continue;
    give(g, item.id, 4);
    g.step();
    g.engine.command({ t: 'store', house: id, item: item.id, n: 4 });
  }
  g.step();
  return id;
}

/** A table of the first game, dealt by its rules and played `turns` turns on, seen from the seat `seat` picks. */
function table(g: Gallery, turns: number, seat: (toMove: number | null, winner: number | null) => number): TableView {
  const game = 0;
  const def = MINIGAMES[game] ?? fail('mini-game');
  const dealt = minigameDeal<Record<string, unknown>>(game, 7, turns);
  const you = seat(dealt.toMove, dealt.result?.winner ?? null);
  const them = OTHERS[0];
  const seats = (you === 0 ? [g.me, them] : [them, g.me]).map((s) => ({ ...s, timeouts: 0, away: false }));
  const p = g.engine.player.pos;
  return {
    id: 1,
    game,
    x: p.x,
    y: p.y,
    z: p.z + 1,
    rot: 0,
    seats,
    stake: STAKE,
    board: dealt.board,
    ...(dealt.result ? { over: { winner: dealt.result.winner, why: 'rules' as const } } : {}),
    you,
    turnSeconds: def.turnSeconds,
    ms: def.turnSeconds * 700,
    toMove: dealt.toMove,
    state: dealt.views[you],
  };
}

/** You in a party with the others: `leads` says who leads it. */
function inParty(g: Gallery, leads: number): void {
  const here = { kind: 'channel' as const, channel: 1 };
  g.partyLink.setParty({
    id: 1,
    leader: leads,
    members: [
      { ...g.me, online: true, place: here },
      { ...OTHERS[0], online: true, place: here },
      { ...OTHERS[1], online: true, place: { kind: 'channel', channel: 2 } },
    ],
    dungeons: [],
  });
  // The one beside you is hurt, so the frame has a bar to show.
  g.partyLink.peers.set(OTHERS[0].id, { p: { hp: 62 } });
}

/** How each entry is made up, by `<window>/<state>` (entries.ts). */
export const MADE_UP: Record<string, MakeUp> = {
  'bag/start': (g) => g.ui.openBag(),
  'bag/full': (g) => {
    for (const cat of Object.keys(CATEGORIES) as ItemCat[]) {
      const item = firstOf(cat);
      if (item) give(g, item.id, Math.min(item.stack, 5));
    }
    g.engine.command({ t: 'grant', coins: 12345, seals: 3 });
    g.step();
    g.ui.openBag();
  },
  'character/start': (g) => g.ui.open({ kind: 'character' }),
  'quests/start': (g) => g.ui.open({ kind: 'log' }),
  'quests/between': (g) => {
    openingDone(g);
    g.ui.open({ kind: 'log' });
  },
  'quests/under-way': (g) => {
    openingDone(g);
    const q = firstQuest(g);
    faceNpc(g, q.giver);
    g.engine.command({ t: 'accept', quest: q.id });
    g.step();
    g.ui.open({ kind: 'log' });
  },
  'map/island': (g) => g.ui.open({ kind: 'map' }),
  'rides/none': (g) => g.ui.open({ kind: 'garage' }),
  'rides/every-ride': (g) => {
    for (const item of ITEMS.filter((i) => i.cat === 'deed' || i.cat === 'mount')) give(g, item.id);
    g.step();
    g.ui.open({ kind: 'garage' });
  },
  'settings/default': (g) => g.ui.open({ kind: 'settings' }),
  'developer/tools': (g) => g.ui.open({ kind: 'dev' }),
  'admin/menu': (g) => g.ui.open({ kind: 'admin' }),
  'talk/quest-giver': (g) => {
    openingDone(g);
    const q = firstQuest(g);
    faceNpc(g, q.giver);
    g.ui.open({ kind: 'dialog', id: q.giver });
  },
  'talk/merchant': (g) => {
    const v = firstMerchant(g);
    faceNpc(g, v.npc);
    g.ui.open({ kind: 'dialog', id: v.npc });
  },
  'talk/crafter': (g) => {
    const n = g.life.zone.recipe.npcs.find((x) => RECIPES.some((r) => r.bench === x.id)) ?? fail('crafter');
    faceNpc(g, n.id);
    g.ui.open({ kind: 'dialog', id: n.id });
  },
  'shop/buy': (g) => shop(g, 'buy'),
  'shop/sell': (g) => shop(g, 'sell'),
  'shop/buyback': (g) => shop(g, 'buyback'),
  'crafting/materials': (g) => {
    const recipe = firstRecipe(g);
    for (const x of recipe?.inputs ?? []) give(g, x.item, x.n);
    g.engine.command({ t: 'grant', coins: recipe?.coins ?? 0, labor: recipe?.labor ?? 0 });
    g.step();
    atBench(g);
  },
  'crafting/short': (g) => atBench(g),
  'storage/chest': (g) => {
    const id = finishedHouse(g);
    const h = g.life.state.houses.find((x) => x.id === id) ?? fail('house that stays built');
    const at = housePose(g.life, h);
    g.engine.place(at.x, at.z, at.rot);
    g.step();
    g.ui.open({ kind: 'storage', id: String(id) });
  },
  'skills/book': (g) => g.skills.open('book'),
  'skills/tree': (g) => g.skills.open('tree'),
  'challenge/choosing': (g) => {
    g.engine.command({ t: 'grant', coins: Math.max(...CHALLENGE.stakes) });
    g.step();
    g.minigames.open(OTHERS[0].id, OTHERS[0].name);
  },
  'challenge/waiting': (g) => {
    g.engine.command({ t: 'grant', coins: STAKE });
    g.step();
    g.minigames.open(OTHERS[0].id, OTHERS[0].name);
    const them = OTHERS[0];
    g.tables.setChallenges({
      sent: { from: g.me.id, fromName: g.me.name, to: them.id, toName: them.name, game: 0, stake: STAKE, ms: CHALLENGE.inviteSeconds * 600 },
      waiting: null,
    });
  },
  'challenged/asked': (g) => {
    g.engine.command({ t: 'grant', coins: STAKE });
    g.step();
    const them = OTHERS[0];
    g.tables.setChallenges({
      sent: null,
      waiting: { from: them.id, fromName: them.name, to: g.me.id, toName: g.me.name, game: 0, stake: STAKE, ms: CHALLENGE.inviteSeconds * 600 },
    });
  },
  'table/your-turn': (g) => g.tables.setTable(table(g, 6, (toMove) => toMove ?? 0)),
  'table/their-turn': (g) => g.tables.setTable(table(g, 6, (toMove) => 1 - (toMove ?? 0))),
  'table/over': (g) => g.tables.setTable(table(g, 1000, (_, winner) => winner ?? 0)),
  'party/frame': (g) => inParty(g, OTHERS[0].id),
  'party/window': (g) => {
    inParty(g, g.me.id);
    g.party.open();
  },
  'party/invited': (g) => {
    const them = OTHERS[0];
    g.partyLink.setInvite({ from: them.id, name: them.name, ms: 20_000 });
  },
};
