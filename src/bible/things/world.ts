// The world: its zones, the places on them, their people, the creatures, and the dungeons.

import { actorKind, actorKindIds, LADDERS } from '../../content/actors';
import type { AttackDef } from '../../content/attacks';
import { CREATURES } from '../../content/creatures';
import { RECIPES, VENDORS } from '../../content/items';
import { QUESTS } from '../../content/quests';
import { ROUTES } from '../../content/trade';
import type { ActorKind } from '../../sim/actor';
import { DUNGEONS, type DungeonDef } from '../../sim/zone/dungeon';
import type { ZoneNpc, ZonePlace, ZoneRecipe } from '../../sim/zone/types';
import { count, duration, frames, metres, num, speed, times } from '../format';
import { figure, join, kind, note, table } from '../kit';
import { drawIsland, growIsland, type Layers } from '../map';
import { type Html, link, md, phrase, raw } from '../md';
import { rustConst } from '../source';
import { nearestPlace, npcLink, placeLink, ZONE } from './refs';
import spaces from '../../../crates/server/src/play/spaces.rs?raw';
import parties from '../../../crates/server/src/play/parties.rs?raw';

/** How long the server keeps a dungeon's copy after its last player leaves, and the rest of its numbers. */
const COPY_KEPT = (): number => rustConst(spaces, 'COPY_KEPT');
const EXPEL_AFTER = (): number => rustConst(spaces, 'EXPEL_AFTER');
const PARTY_MAX = (): number => rustConst(parties, 'PARTY_MAX');

const ZONES: ZoneRecipe[] = [ZONE];

// ---------- the map ----------

const ZONE_LAYERS: Layers = { places: true, roads: true, routes: true, plots: true, nodes: false, air: true };
const PLACE_LAYERS: Layers = { places: true, roads: true, routes: false, plots: false, nodes: false, air: false };

/** A map of the island, drawn once the page is in place (growing the island takes a moment). */
const MAP = (caption: string): Html => figure('<canvas class="map" role="img" aria-label="A map of the island"></canvas>', caption);

function drawMap(root: HTMLElement, all: boolean, mark?: string): void {
  const canvas = root.querySelector<HTMLCanvasElement>('canvas.map');
  if (!canvas) return;
  // After the page's text is on screen: growing the island the first time takes a few hundred milliseconds.
  requestAnimationFrame(() =>
    setTimeout(() => {
      if (!canvas.isConnected) return;
      drawIsland(canvas, growIsland(), all ? ZONE_LAYERS : PLACE_LAYERS, all, mark);
      canvas.dataset.drawn = 'true';
    }),
  );
}
const placeName = (id: string): string => ZONE.places.find((p) => p.id === id)?.name ?? id;
const linksTo = (paths: string[]): Html | null => (paths.length ? raw(paths.map((p) => link(p).html).join(', ')) : null);

// ---------- zones ----------

export const zones = kind<ZoneRecipe>({
  id: 'zones',
  section: 'world',
  title: 'Zones',
  noun: 'Zone',
  icon: '🗺️',
  summary: 'The open worlds you play in: each an island grown from a recipe of coast, hills, roads and places.',
  sources: [
    'shared/zones/*.json#id',
    'shared/zones/*.json#name',
    'shared/zones/*.json#subtitle',
    'shared/zones/*.json#seed',
    'shared/zones/*.json#climate',
    'shared/zones/*.json#spawn',
    'shared/zones/*.json#forests',
    'shared/zones/*.json#scatter',
    'shared/zones/*.json#farmland',
  ],
  systems: ['world', 'weather'],
  all: () => ZONES,
  key: (z) => z.id,
  name: (z) => z.name,
  iconOf: () => '🏝️',
  line: (z) => z.subtitle,
  explain: (z) => note('zones', z.id),
  facts: (z) => [
    ['Also called', z.subtitle],
    ['Climate', z.climate.charAt(0).toUpperCase() + z.climate.slice(1)],
    ['Size', phrase`${metres(z.terrain.cells * z.terrain.cell)} square, a height every ${metres(z.terrain.cell)}`],
    ['A day lasts', duration(z.sky.dayLengthSeconds)],
    ['Places', z.places.length],
    ['People', z.npcs.length],
    ['House plots', z.housePlots.length],
    ['Gathering spots', z.nodes.length],
    ['Dungeons', z.dungeons?.length ?? 0],
    ['Trees', phrase`about one to every ${num(1 / z.scatter.trees, 0)} m² of open grass, thicker in its ${count(z.forests.length, 'forest')}`],
    ['Rocks', phrase`about one to every ${num(1 / z.scatter.rocks, 0)} m² of grass, more on rock and sand`],
  ],
  body: (z) =>
    join(
      MAP(`The island as the game grows it from its recipe, north up: its roads, plots, trade routes, the ledge path and rising air, and its places.`),
      md`## Places`,
      table(
        ['Place', 'Kind'],
        z.places.map((p) => [raw(`${p.icon} ${link(`places/${p.id}`, p.name).html}`), p.kind.charAt(0).toUpperCase() + p.kind.slice(1)]),
      ),
      md`## People`,
      table(
        ['Who', 'What They Do', 'Where'],
        z.npcs.map((n) => [npcLink(n.id), n.title, placeLink(n.place)]),
      ),
      md`[[systems/world]] tells how the island is grown from its recipe, and [[systems/weather]] how its days and weather go.`,
    ),
  mount: (_z, root) => drawMap(root, true),
});

// ---------- places ----------

export const places = kind<ZonePlace>({
  id: 'places',
  section: 'world',
  title: 'Places',
  noun: 'Place',
  icon: '📍',
  summary: 'The named places of the island: the village, the farmland, the crag, the trading posts and the wilds.',
  sources: ['shared/zones/*.json#places', 'shared/zones/*.json#outposts', 'shared/trade.json#places'],
  systems: ['world', 'trade'],
  all: () => ZONE.places,
  key: (p) => p.id,
  name: (p) => p.name,
  iconOf: (p) => p.icon,
  group: (p) => p.kind.charAt(0).toUpperCase() + p.kind.slice(1),
  line: (p) => `A ${p.kind} on ${ZONE.name}.`,
  explain: (p) => note('places', p.id),
  facts: (p) => {
    const near = (x: number, z: number) => nearestPlace(x, z).id === p.id;
    const people = ZONE.npcs.filter((n) => n.place === p.id);
    const benches = ZONE.workbenches.filter((b) => b.place === p.id);
    const post = ZONE.outposts.find((o) => o.id === p.id);
    const spots = ZONE.nodes.filter((n) => near(n.x, n.z));
    const doors = (ZONE.dungeons ?? []).filter((d) => near(d.portal.x, d.portal.z));
    return [
      ['Kind', p.kind.charAt(0).toUpperCase() + p.kind.slice(1)],
      ['People', people.length ? raw(people.map((n) => npcLink(n.id).html).join(', ')) : null],
      ['Workbenches', linksTo(benches.map((b) => `workbenches/${b.id}`))],
      ['Trading post', post ? phrase`kept by ${npcLink(post.npc)}` : null],
      ['Gathering', spots.length ? raw([...new Set(spots.map((s) => s.kind))].map((k) => link(`gathering/${k}`).html).join(', ')) : null],
      ['Dungeon', linksTo(doors.map((d) => `dungeons/${d.id}`))],
      ['Plots', p.id === nearestPlace(ZONE.housePlots[0]?.x ?? 0, ZONE.housePlots[0]?.z ?? 0).id ? count(ZONE.housePlots.length, 'house plot') : null],
    ];
  },
  body: (p) => {
    const routesIn = ROUTES.filter((r) => r.to === p.id);
    const routesOut = ROUTES.filter((r) => r.from === p.id);
    const map = MAP(`Where ${p.name} is on ${ZONE.name}, north up.`);
    if (!routesIn.length && !routesOut.length) return map;
    return join(
      map,
      md`## Trade Routes`,
      table(
        ['From', 'To', 'Pays', 'Seals a Pack'],
        [...routesOut, ...routesIn].map((r) => [placeName(r.from), placeName(r.to), times(r.factor), r.seals]),
        [2, 3],
      ),
      md`A pack's price there is its base price times the route's factor, the post's demand and the pack's freshness: [[systems/trade]].`,
    );
  },
  columns: [['Kind', (p) => p.kind.charAt(0).toUpperCase() + p.kind.slice(1)]],
  mount: (p, root) => drawMap(root, false, p.id),
});

// ---------- people ----------

export const npcs = kind<ZoneNpc>({
  id: 'npcs',
  section: 'world',
  title: 'People',
  noun: 'Person',
  icon: '🧑',
  summary: 'The townsfolk of the island: who they are, where they stand, what they sell, make and ask of you.',
  sources: ['shared/zones/*.json#npcs'],
  systems: ['quests', 'economy'],
  all: () => ZONE.npcs,
  key: (n) => n.id,
  name: (n) => n.name,
  iconOf: () => '🧑',
  group: (n) => placeName(n.place),
  line: (n) => `${n.title}.`,
  explain: (n) => note('npcs', n.id),
  facts: (n) => {
    const vendor = VENDORS.find((v) => v.npc === n.id);
    const gives = QUESTS.filter((q) => q.giver === n.id);
    const takes = QUESTS.filter((q) => q.turnIn === n.id && q.giver !== n.id);
    const makes = RECIPES.filter((r) => r.bench === n.id);
    const post = ZONE.outposts.find((o) => o.npc === n.id);
    return [
      ['Does', n.title],
      ['Where', placeLink(n.place)],
      ['Says', `“${n.greeting}”`],
      ['Shop', vendor ? link(`vendors/${vendor.npc}`, vendor.name) : null],
      ['Workbench', n.bench ? link(`workbenches/${n.bench}`) : null],
      ['Makes', linksTo(makes.map((r) => `recipes/${r.id}`))],
      ['Buys packs', post ? link(`places/${post.id}`) : null],
      ['Gives quests', linksTo(gives.map((q) => `quests/${q.id}`))],
      ['Takes quests in', linksTo(takes.map((q) => `quests/${q.id}`))],
    ];
  },
  columns: [['Does', (n) => n.title]],
});

// ---------- creatures ----------

const TOWNSFOLK = 2;
const CREATURE_KINDS = (): ActorKind[] =>
  actorKindIds()
    .map(actorKind)
    .filter((k) => k.faction !== TOWNSFOLK);
const creatureName = (k: ActorKind): string =>
  k.name ??
  k.id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
const attacksOf = (k: ActorKind): AttackDef[] =>
  (CREATURES.find((c) => (c.kinds as ActorKind[] | undefined)?.some((x) => x.id === k.id))?.attacks ?? []) as AttackDef[];

export const creatures = kind<ActorKind>({
  id: 'creatures',
  section: 'world',
  title: 'Creatures',
  noun: 'Creature',
  icon: '🟢',
  summary: 'What you fight: how tough each creature is, how it hits you and what it turns into.',
  sources: ['shared/actors.json#kinds', 'shared/actors.json#ladders', 'shared/creatures/*.json#kinds', 'shared/creatures/*.json#attacks'],
  systems: ['creatures', 'combat'],
  all: CREATURE_KINDS,
  key: (k) => k.id,
  name: creatureName,
  iconOf: (k) => (k.id.includes('slime') ? '🟢' : k.id === 'goblin' ? '👺' : '🎯'),
  group: (k) => {
    const l = LADDERS.find((x) => x.kinds.includes(k.id));
    return l ? `${l.id.charAt(0).toUpperCase() + l.id.slice(1)}s` : k.brain ? 'Goblins' : 'Practice';
  },
  line: (k) => `${creatureName(k)}: ${k.maxHp} health.`,
  explain: (k) => note('creatures', k.id),
  facts: (k) => {
    const ladder = LADDERS.find((x) => x.kinds.includes(k.id));
    return [
      ['Health', k.maxHp],
      ['Size', phrase`${metres(k.radius)} across the middle`],
      ['Blocks you', k.solid ? 'Yes' : 'No'],
      ['Comes back', k.respawnFrames < 0 ? 'Never by itself' : frames(k.respawnFrames)],
      ['Brain', k.brain ? link(`systems/creatures`, k.brain) : 'None: it stands still'],
      ['Mass', ladder && k.mass ? k.mass : null],
      ['Bursts into', k.burst ? phrase`${k.burst.count} ${link(`creatures/${k.burst.into}`)}` : null],
      ['Slam', k.slam ? phrase`${k.slam.damage} damage in ${metres(k.slam.radius)}, from ${metres(k.slam.range)} away` : null],
      ['Calls its pack', k.gathers ? 'Yes, and gathers them in' : null],
      ['Poise', k.poise ? phrase`a blow of ${k.poise} or more stops it` : null],
    ];
  },
  body: (k) => {
    const attacks = attacksOf(k);
    const ladder = LADDERS.find((x) => x.kinds.includes(k.id));
    return join(
      attacks.length ? md`## Its Attacks` : null,
      attacks.length
        ? table(
            ['Attack', 'Kind', 'Wind-Up', 'Damage', 'Reach', 'Again After'],
            attacks.map((a) => [
              a.id,
              a.kind === 'strike' ? 'A blow in front of it' : 'A lobbed missile',
              frames(a.windup),
              a.damage,
              a.kind === 'strike' ? metres(a.reach ?? 0) : phrase`${metres(a.range ?? 0)} at ${speed(a.speed ?? 0)}`,
              phrase`${frames(a.cooldown[0])} to ${frames(a.cooldown[1])}`,
            ]),
            [3],
          )
        : null,
      ladder ? md`## Its Sizes` : null,
      ladder
        ? table(
            ['Size', 'Mass', 'Health', 'Slam'],
            ladder.kinds.map((id) => {
              const x = actorKind(id);
              return [link(`creatures/${id}`), x.mass ?? 0, x.maxHp, x.slam ? phrase`${x.slam.damage} in ${metres(x.slam.radius)}` : ''];
            }),
            [1, 2],
          )
        : null,
      ladder
        ? md`No more than ${ladder.cap} of them are alive at once. A burst's pieces have ${frames(ladder.fuse)} to be killed before the survivors reform one size up; a lone piece dissolves after ${frames(ladder.alone)}. [[systems/creatures]] tells how they think.`
        : null,
    );
  },
  columns: [
    ['Health', (k) => k.maxHp],
    ['Comes Back', (k) => (k.respawnFrames < 0 ? 'No' : frames(k.respawnFrames))],
  ],
});

// ---------- dungeons ----------

export const dungeons = kind<DungeonDef>({
  id: 'dungeons',
  section: 'world',
  title: 'Dungeons',
  noun: 'Dungeon',
  icon: '🕳️',
  summary: 'Places a party enters together, each party in a copy of its own.',
  sources: ['shared/dungeons.json#dungeons', 'shared/zones/*.json#dungeons'],
  systems: ['parties'],
  // The developer zones (the yard, the battlefield) are dungeons too, entered from the Admin menu: not for players' eyes.
  all: () => Object.values(DUNGEONS).filter((d) => !d.developer),
  key: (d) => d.id,
  name: (d) => d.name,
  iconOf: () => '🕳️',
  line: (d) => `A dungeon for up to ${d.maxPlayers} players.`,
  explain: (d) => note('dungeons', d.id),
  facts: (d) => {
    const door = ZONE.dungeons?.find((x) => x.id === d.id);
    return [
      ['A copy holds', count(d.maxPlayers, 'player')],
      ['Its door', door ? phrase`${metres(door.portal.y)} up, near ${placeLink(nearestPlace(door.portal.x, door.portal.z).id)}` : null],
      ['Kept after the last leaves', duration(COPY_KEPT())],
      ['Out of the party, out after', duration(EXPEL_AFTER())],
      ['Fall below', phrase`${metres(-d.fall)} under its floor and you are back at the way in`],
      ['Solid pieces', d.boxes.length + d.decks.length],
    ];
  },
  body: () =>
    md`Each party plays its own copy. [[systems/parties]] tells how copies are made, kept and emptied, and how a party is formed (at most ${PARTY_MAX()} to a party).`,
  columns: [['Players', (d) => d.maxPlayers]],
});
