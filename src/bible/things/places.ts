// Buildings and street furniture, house blueprints, quests and the mini-games played at a table.

import { buildingPlan, MODULE, STOREY } from '../../content/buildings';
import { BLUEPRINTS, type BlueprintDef } from '../../content/housing';
import { ITEMS, VENDORS } from '../../content/items';
import { CHALLENGE, MINIGAMES, type MiniGameDef, TABLE } from '../../content/minigames';
import { type Objective, objectiveTarget, type QuestDef, QUESTS } from '../../content/quests';
import { type PropDef, propDef, type StructureDef, structureDef, structureIds } from '../../content/structures';
import { GATHERING } from '../../content/farming';
import { coins, count, duration, metres } from '../format';
import { described, join, kind, note, table } from '../kit';
import { type Html, link, md, phrase, raw } from '../md';
import { itemLink, itemsList, nearestPlace, npcLink, packLink, placeLink, priceHtml, ZONE } from './refs';

// ---------- buildings ----------

type Building = { id: string; name: string; prop: boolean; def: StructureDef | PropDef };

const BUILDINGS: Building[] = [
  ...structureIds()
    .filter((id) => !(id in GATHERING))
    .map((id) => ({ id, name: structureDef(id).name, prop: false, def: structureDef(id) })),
  // Street furniture: every prop the island is dressed with.
  ...[...new Set(ZONE.props.map((p) => p.id))].map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1), prop: true, def: propDef(id) })),
];

const COLLIDER: Record<string, string> = {
  building: 'Walls, floors and stairs you can walk into',
  walls: 'Its outer walls, with a door gap in front',
  box: 'Its whole footprint',
  post: 'A round post',
  none: 'Nothing: you walk over or through it',
};

/** Where a structure or prop stands on the island: the places it is nearest to, and how many. */
function standsAt(id: string): Html | null {
  const here = ZONE.structures.filter((s) => s.id === id);
  const props = ZONE.props.filter((p) => p.id === id);
  if (!here.length && !props.length) return null;
  const places = [...new Set(here.map((s) => nearestPlace(s.x, s.z).id))];
  const n = here.length + props.reduce((t, p) => t + (p.ring?.count ?? (p.x !== undefined ? 1 : 0)), 0);
  return places.length ? phrase`${count(n, 'one', 'of them')}, at ${raw(places.map((p) => placeLink(p).html).join(', '))}` : count(n, 'one', 'of them');
}

export const buildings = kind<Building>({
  id: 'buildings',
  section: 'world',
  title: 'Buildings',
  noun: 'Building',
  icon: '🏠',
  summary: 'Every building and piece of street furniture on the island: its size, what blocks you, and the rooms you can walk into.',
  sources: [
    'shared/structures.json#structures',
    'shared/structures.json#props',
    'shared/buildings.json#plans',
    'shared/zones/*.json#structures',
    'shared/zones/*.json#props',
  ],
  systems: ['world', 'housing'],
  all: () => BUILDINGS,
  key: (b) => b.id,
  name: (b) => b.name,
  iconOf: (b) => (b.prop ? '🪑' : '🏠'),
  group: (b) => (b.prop ? 'Street Furniture' : (b.def as StructureDef).collider === 'building' ? 'Buildings You Can Walk Into' : 'Other Buildings and Works'),
  line: (b) => `${b.prop ? 'Street furniture' : 'A building'} ${b.def.w} by ${b.def.d} metres.`,
  explain: (b) => note('buildings', b.id),
  facts: (b) => {
    const s = b.def as StructureDef;
    const plan = buildingPlan(b.id);
    return [
      ['Footprint', phrase`${metres(b.def.w)} × ${metres(b.def.d)}`],
      ['Height', metres(b.def.h)],
      ['Blocks you with', COLLIDER[b.def.collider] ?? b.def.collider],
      ['Walkable top', s.deck ? phrase`${metres(s.deck)} up` : null],
      ['Storeys', plan ? plan.storeys.length : null],
      ['Built in stages', s.stages?.length ? raw(s.stages.join(', ')) : null],
      ['On the island', standsAt(b.id)],
    ];
  },
  body: (b) => {
    const plan = buildingPlan(b.id);
    if (!plan) return null;
    const items = new Map<string, number>();
    for (const it of plan.items ?? []) items.set(it.id, (items.get(it.id) ?? 0) + 1);
    return join(
      md`## Inside`,
      md`It is built on the village kit's grid of ${metres(MODULE)} squares, ${metres(STOREY)} a storey: ${count(plan.storeys.length, 'storey')}${
        plan.stairs?.length ? phrase` joined by ${count(plan.stairs.length, 'stair')}` : ''
      }, with ${count(plan.items?.length ?? 0, 'piece')} of furniture. Doorways are open, floors and stair treads are walkable, and furniture is solid.`,
      items.size ? raw(`<p class="sub">${[...items.entries()].map(([id, n]) => `${n > 1 ? `${n} × ` : ''}${id}`).join(' · ')}</p>`) : null,
    );
  },
  columns: [
    ['Footprint', (b) => phrase`${metres(b.def.w)} × ${metres(b.def.d)}`],
    ['Height', (b) => metres(b.def.h)],
  ],
});

// ---------- blueprints ----------

export const blueprints = kind<BlueprintDef>({
  id: 'blueprints',
  section: 'things',
  title: 'House Blueprints',
  noun: 'Blueprint',
  icon: '📐',
  summary: 'The houses you can build on a plot: their stages, what they take, and what a home gives you.',
  sources: ['shared/housing.json#blueprints', 'shared/zones/*.json#housePlots'],
  systems: ['housing'],
  all: () => BLUEPRINTS,
  key: (b) => b.id,
  name: (b) => b.name,
  iconOf: () => '📐',
  line: (b) => `A house built in ${b.stages.length} stages.`,
  explain: (b) => note('blueprints', b.id),
  facts: (b) => {
    // The item that claims a plot for this house, and who sells it.
    const deed = ITEMS.find((i) => i.placeOn === 'plot' && i.places === b.id);
    const sale = VENDORS.flatMap((v) => v.sells.map((s) => ({ v, s }))).find(({ s }) => s.item === deed?.id);
    const packs: Record<string, number> = {};
    let labor = 0;
    for (const s of b.stages) {
      labor += s.labor;
      for (const [p, n] of Object.entries(s.needs)) packs[p] = (packs[p] ?? 0) + n;
    }
    return [
      ['Blueprint', sale ? phrase`${itemLink(sale.s.item)}, ${priceHtml(sale.s.price, sale.s.seals)} from ${npcLink(sale.v.npc)}` : null],
      ['Plot', phrase`${metres(b.plot)} square`],
      ['House', link(`buildings/${b.structure}`)],
      [
        'Packs in all',
        raw(
          Object.entries(packs)
            .map(([p, n]) => packLink(p, n).html)
            .join('<br>'),
        ),
      ],
      ['Labor in all', labor],
      ['Storage', count(b.perks.storageSlots, 'slot')],
      ['Rest', phrase`labor comes back ${b.perks.restLaborMultiplier} times as fast in its bed`],
      ['Tax', phrase`${coins(b.taxPerDay)} a day, the first ${count(b.graceDays, 'day')} free`],
    ];
  },
  body: (b) =>
    join(
      md`## Stage by Stage`,
      table(
        ['Stage', 'What It Is', 'Haul to the Site', 'Labor'],
        b.stages.map((s) => [
          s.name,
          s.desc,
          raw(
            Object.entries(s.needs)
              .map(([p, n]) => packLink(p, n).html)
              .join('<br>'),
          ),
          s.labor,
        ]),
        [3],
      ),
      md`[[systems/housing]] tells how a plot is claimed, how stages are finished and how tax is paid.`,
    ),
  columns: [
    ['Stages', (b) => b.stages.length],
    ['Tax a Day', (b) => coins(b.taxPerDay)],
  ],
});

// ---------- quests ----------

/** An objective in words, with links. */
export function objectiveText(o: Objective): Html {
  const n = objectiveTarget(o);
  switch (o.type) {
    case 'talk':
      return phrase`Talk to ${npcLink(o.npc ?? '')}`;
    case 'placeScarecrow':
      return phrase`Set up ${count(n, 'scarecrow')}`;
    case 'plant':
      return phrase`Plant ${count(n, 'seed')}${o.crop ? phrase` of ${link(`crops/${o.crop}`)}` : ''}`;
    case 'harvest':
      return phrase`Harvest ${n}${o.crop ? phrase` ${link(`crops/${o.crop}`)}` : phrase` times`}`;
    case 'reach':
      return phrase`Reach ${placeLink(o.place ?? '')}${o.minY ? phrase`, at least ${metres(o.minY)} up` : ''}`;
    case 'glide':
      return phrase`Spend ${duration(n)} gliding, all your flights added up`;
    case 'gather':
      return phrase`Gather ${n} ${o.kind ?? 'materials'}`;
    case 'craftPack':
      return phrase`Make ${n === 1 ? '' : phrase`${n} `}${packLink(o.pack ?? '')}`;
    case 'deliver':
      return phrase`Sell ${count(n, 'pack')} at ${placeLink(o.outpost ?? '')}`;
    case 'summon':
      return phrase`Summon ${link(`vehicles/${o.vehicle}`)}`;
    case 'load':
      return phrase`Load ${count(n, 'pack')} into a vehicle`;
    case 'placeHouse':
      return phrase`Claim ${count(n, 'house plot')} with a blueprint`;
    case 'buildStage':
      return phrase`Finish ${count(n, 'building stage')}`;
    case 'layKeel':
      return phrase`Lay ${count(n, 'keel')} on a slipway`;
    case 'shipStage':
      return phrase`Finish ${count(n, 'ship stage')}`;
    case 'launch':
      return phrase`Launch ${count(n, 'ship')}`;
    case 'raise':
      return phrase`Raise ${count(n, 'young animal')}`;
    case 'contract':
      return phrase`Fill ${count(n, 'contract')}`;
    case 'defeat':
      return phrase`Defeat ${n} ${o.kind ? link(`creatures/${o.kind}`) : 'creatures'}`;
    case 'skillLevel':
      return phrase`Gain ${count(n, 'skill level')}, in any skills`;
    default:
      return phrase`${o.type} (${n})`;
  }
}

const rewardsOf = (q: QuestDef): Html | null => {
  const r = q.rewards;
  const parts = [
    r.coins ? coins(r.coins).html : '',
    r.seals ? phrase`${count(r.seals, 'Charter Seal')}`.html : '',
    r.labor ? phrase`${r.labor} labor`.html : '',
    r.skillPoints ? phrase`${count(r.skillPoints, 'skill point')}`.html : '',
    r.items?.length ? itemsList(r.items).html : '',
    r.equipGlider ? phrase`${link(`gliders/${r.equipGlider}`)}, opened for you`.html : '',
  ].filter(Boolean);
  return parts.length ? raw(parts.join('<br>')) : null;
};

export const quests = kind<QuestDef>({
  id: 'quests',
  section: 'things',
  title: 'Quests',
  noun: 'Quest',
  icon: '📜',
  summary: 'The starter questline and the milestones: who gives each, what it asks, and what it pays.',
  sources: ['shared/quests.json#quests'],
  systems: ['quests'],
  all: () => QUESTS,
  key: (q) => q.id,
  name: (q) => q.name,
  iconOf: (q) => (q.milestone ? '🏅' : '📜'),
  group: (q) => (q.milestone ? 'Milestones' : 'The Questline'),
  line: (q) => q.steps[0]?.text ?? q.name,
  explain: (q) => described(q.intro),
  facts: (q) => [
    ['Given by', q.giver ? npcLink(q.giver) : q.milestone ? 'Nobody: a milestone' : null],
    ['Hand in to', q.turnIn ? npcLink(q.turnIn) : null],
    ['Starts', q.auto || q.milestone ? 'By itself, once it is open' : 'When you accept it'],
    ['Opens after', q.after.length ? raw(q.after.map((a) => link(`quests/${a}`).html).join(', ')) : 'From the start'],
    [
      'Opens',
      QUESTS.filter((x) => x.after.includes(q.id)).length
        ? raw(
            QUESTS.filter((x) => x.after.includes(q.id))
              .map((x) => link(`quests/${x.id}`).html)
              .join(', '),
          )
        : null,
    ],
    ['You get at the start', q.startItems?.length ? itemsList(q.startItems) : null],
    ['Rewards', rewardsOf(q)],
  ],
  body: (q) =>
    join(
      md`## Steps`,
      raw(
        `<ol>${q.steps
          .map((s) => `<li><b>${s.text.replace(/[&<>]/g, '')}</b><ul>${s.objectives.map((o) => `<li>${objectiveText(o).html}</li>`).join('')}</ul></li>`)
          .join('')}</ol>`,
      ),
      q.outro ? md`## When It Is Done` : null,
      described(q.outro),
    ),
  columns: [
    ['Given By', (q) => (q.giver ? npcLink(q.giver) : '')],
    ['Steps', (q) => q.steps.length],
  ],
});

// ---------- mini-games ----------

export const minigames = kind<MiniGameDef>({
  id: 'minigames',
  section: 'things',
  title: 'Mini-Games',
  noun: 'Mini-Game',
  icon: '🎲',
  summary: 'Games two players play at a table thrown down between them, for a pot.',
  sources: ['shared/minigames.json#games'],
  systems: ['minigames'],
  all: () => MINIGAMES,
  key: (g) => g.id,
  name: (g) => g.name,
  iconOf: (g) => g.icon,
  line: (g) => g.blurb,
  explain: (g) => described(g.blurb),
  facts: (g) => [
    ['Players', g.players],
    ['A turn', duration(g.turnSeconds)],
    ['Forfeit after', count(g.timeoutsToForfeit, 'missed turn')],
    ['Stakes', phrase`${coins(CHALLENGE.stakes.filter((s) => s > 0)[0] ?? 0)} to ${coins(CHALLENGE.stakes[CHALLENGE.stakes.length - 1])}, or none`],
  ],
  body: (g) =>
    md`Challenge someone within ${metres(CHALLENGE.range)} of you; they have ${duration(CHALLENGE.inviteSeconds)} to answer. A player away from the table for ${duration(
      TABLE.awaySeconds,
    )} forfeits. [[systems/minigames]] has the rules of the table and of ${g.name}.`,
  columns: [
    ['Players', (g) => g.players],
    ['A Turn', (g) => duration(g.turnSeconds)],
  ],
});
