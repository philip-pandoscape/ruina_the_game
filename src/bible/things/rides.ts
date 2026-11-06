// What you ride: carts and boats, mounts, gliders, and the ships built at a slipway.

import { ITEMS, RECIPES, VENDORS } from '../../content/items';
import { type ShipDesignDef, SHIP_DESIGNS } from '../../content/shipyard';
import { type BoatDef, GLIDERS, type GliderDef, isBoat, MOUNTS, type MountDef, VEHICLES, type VehicleDef, type WheeledDef } from '../../content/vehicles';
import { coins, duration, metres, pct, slopeDegrees, speed, speedKmh, times, turnRate } from '../format';
import { described, join, kind, note, table } from '../kit';
import { type Html, link, md, phrase, raw } from '../md';
import { itemLink, npcLink, packLink, priceHtml, recipeNeeds, itemsList } from './refs';

/** How to get the item that summons or calls a ride: a vendor's price or a crafter's recipe. */
function howToGet(itemId: string | undefined): Html | null {
  if (!itemId) return null;
  const parts: string[] = [];
  for (const v of VENDORS)
    for (const s of v.sells) if (s.item === itemId) parts.push(phrase`${npcLink(v.npc)} sells it for ${priceHtml(s.price, s.seals)}`.html);
  for (const r of RECIPES)
    if (r.makes.item === itemId) {
      const n = recipeNeeds(r);
      const takes = [n.inputs.length ? itemsList(n.inputs).html : '', n.coins ? coins(n.coins).html : ''].filter(Boolean).join(' and ');
      parts.push(phrase`${link(`recipes/${r.id}`, 'made')} by ${npcLink(r.bench)} from ${raw(takes)}`.html);
    }
  for (const d of SHIP_DESIGNS) if (d.deed === itemId) parts.push(phrase`launched from ${link(`ships/${d.id}`)} at the slipway`.html);
  return parts.length ? raw(parts.join('; ')) : null;
}

const itemFor = (f: (i: (typeof ITEMS)[number]) => boolean) => ITEMS.find(f)?.id;

// ---------- vehicles ----------

const wheeled = (v: WheeledDef): Array<[string, Html | string | number | null]> => [
  ['Top speed', speedKmh(v.maxSpeed)],
  ['Boost', v.boostSpeed ? speedKmh(v.boostSpeed) : null],
  ['Reverse', speed(v.reverseSpeed)],
  ['Off the road', phrase`${pct(v.offroad)} of top speed`],
  ['Climbs', slopeDegrees(v.climb)],
  ['Turns', turnRate(v.turnRate)],
];

const boat = (v: BoatDef): Array<[string, Html | string | number | null]> => [
  ['Top speed', speedKmh(v.maxSpeed)],
  ['Driven by', v.sail ? 'The wind, in her sail' : 'Oars'],
  ['Draft', metres(v.draft)],
  ['Reverse', speed(v.reverseSpeed)],
  ['Turns', turnRate(v.turnRate)],
  ['Turns at rest', v.turnAtRest ? turnRate(v.turnAtRest) : 'No'],
];

export const vehicles = kind<VehicleDef>({
  id: 'vehicles',
  section: 'things',
  title: 'Vehicles',
  noun: 'Vehicle',
  icon: '🛒',
  summary: 'Carts, cars and boats: how fast they go, what they carry and how they handle.',
  sources: ['shared/vehicles.json#vehicles'],
  systems: ['vehicles'],
  all: () => VEHICLES,
  key: (v) => v.id,
  name: (v) => v.name,
  iconOf: (v) => v.icon,
  group: (v) => (isBoat(v) ? 'Boats and Ships' : 'On Wheels'),
  line: (v) => v.desc,
  explain: (v) => described(v.desc),
  facts: (v) => [
    ...(isBoat(v) ? boat(v) : wheeled(v as WheeledDef)),
    ['Packs aboard', v.cargo.length],
    ['Seats', v.seats.length],
    ['Hull', phrase`${v.hp} hit points`],
    ['Get one', howToGet(itemFor((i) => i.vehicle === v.id))],
  ],
  body: (v) =>
    join(
      md`## Handling`,
      table(
        ['Speeds Up', 'Brakes', 'Drag', 'Rolling', 'Grip', isBoat(v) ? 'Sail' : 'Drift Grip'],
        [
          [
            phrase`${v.accel} m/s²`,
            phrase`${v.brake} m/s²`,
            v.drag,
            phrase`${v.rolling} m/s²`,
            v.grip,
            isBoat(v) ? (v.sail ? 'Yes' : 'No') : (v as WheeledDef).driftGrip,
          ],
        ],
        [0, 1, 2, 3, 4],
      ),
      md`[[systems/vehicles]] says what these numbers do: how a wheeled vehicle grips and slides, how a sail takes the wind, and what a storm does to a hull.`,
    ),
  columns: [
    ['Top Speed', (v) => speed(v.maxSpeed)],
    ['Packs', (v) => v.cargo.length],
    ['Seats', (v) => v.seats.length],
  ],
});

// ---------- mounts ----------

export const mounts = kind<MountDef>({
  id: 'mounts',
  section: 'things',
  title: 'Mounts',
  noun: 'Mount',
  icon: '🐴',
  summary: 'Animals you ride: their gaits, their jump and whether they will carry a pack.',
  sources: ['shared/vehicles.json#mounts'],
  systems: ['vehicles'],
  all: () => MOUNTS,
  key: (m) => m.id,
  name: (m) => m.name,
  iconOf: (m) => m.icon,
  line: (m) => m.desc,
  explain: (m) => described(m.desc),
  facts: (m) => [
    ['Walk', speed(m.walkSpeed)],
    ['Run', speed(m.runSpeed)],
    ['Gallop', speedKmh(m.gallopSpeed)],
    ['With a pack', m.canCarryPack ? speed(m.packSpeed) : 'Won’t carry one'],
    ['Jump', phrase`${speed(m.jump)} upward`],
    ['Turns', turnRate(m.turnRate)],
    ['Get one', howToGet(itemFor((i) => i.mount === m.id))],
  ],
  columns: [
    ['Gallop', (m) => speed(m.gallopSpeed)],
    ['With a Pack', (m) => (m.canCarryPack ? speed(m.packSpeed) : 'No')],
  ],
});

// ---------- gliders ----------

export const gliders = kind<GliderDef>({
  id: 'gliders',
  section: 'things',
  title: 'Gliders',
  noun: 'Glider',
  icon: '🪁',
  summary: 'The wings you open in the air: how fast they fly, how fast they sink and how far they reach.',
  sources: ['shared/vehicles.json#gliders'],
  systems: ['swimming-gliding'],
  all: () => GLIDERS,
  key: (g) => g.id,
  name: (g) => g.name,
  iconOf: (g) => g.icon,
  line: (g) => g.desc,
  explain: (g) => described(g.desc),
  facts: (g) => [
    ['Glide ratio', raw(`<span class="v">1 : ${(g.cruiseSpeed / g.sink).toFixed(1)}</span>`)],
    ['Span', metres(g.span)],
    ['Stalls below', speed(g.stallSpeed)],
    ['Opens above', phrase`${metres(g.minHeight)} off the ground`],
    ['Turns', turnRate(g.turnRate)],
    ['Gust', g.gust ? phrase`${speed(g.gust.speed)} faster, ${speed(g.gust.lift)} up, every ${duration(g.gust.cooldownSeconds)}` : null],
    ['Get one', howToGet(itemFor((i) => i.glider === g.id))],
  ],
  body: (g) =>
    join(
      md`## In the Air`,
      table(
        ['Attitude', 'Airspeed', 'Sinks', 'Distance per Metre Lost'],
        [
          ['Cruise', speed(g.cruiseSpeed), speed(g.sink), metres(g.cruiseSpeed / g.sink, 1)],
          ['Dive (sprint)', speed(g.diveSpeed), speed(g.diveSink), metres(g.diveSpeed / g.diveSink, 1)],
          ['Flare (crouch)', speed(g.flareSpeed), speed(g.flareSink), metres(g.flareSpeed / g.flareSink, 1)],
        ],
        [1, 2, 3],
      ),
      md`Airspeed eases toward the attitude's own at ${times(g.speedEase)} of the gap a second, and flaring out of a dive turns ${pct(g.zoomLift)} of the speed you shed back into climb. [[systems/swimming-gliding]] has the whole flight model.`,
    ),
  columns: [
    ['Cruise', (g) => speed(g.cruiseSpeed)],
    ['Sinks', (g) => speed(g.sink)],
    ['Glide Ratio', (g) => raw(`<span class="v">1 : ${(g.cruiseSpeed / g.sink).toFixed(1)}</span>`)],
  ],
});

// ---------- ships built at a slipway ----------

export const ships = kind<ShipDesignDef>({
  id: 'ships',
  section: 'things',
  title: 'Ship Designs',
  noun: 'Ship Design',
  icon: '⛵',
  summary: 'Ships too big to buy: built stage by stage on a slipway from hauled material packs.',
  sources: ['shared/shipyard.json#designs', 'shared/zones/*.json#shipyards'],
  systems: ['vehicles'],
  all: () => SHIP_DESIGNS,
  key: (d) => d.id,
  name: (d) => d.name,
  iconOf: (d) => VEHICLES.find((v) => v.id === d.vehicle)?.icon,
  line: (d) => `Built on a slipway in ${d.stages.length} stages.`,
  explain: (d) => note('ships', d.id),
  facts: (d) => {
    const packs: Record<string, number> = {};
    let labor = 0;
    for (const s of d.stages) {
      labor += s.labor;
      for (const [p, n] of Object.entries(s.needs)) packs[p] = (packs[p] ?? 0) + n;
    }
    return [
      ['Builds', link(`vehicles/${d.vehicle}`)],
      ['Design', itemLink(d.design)],
      ['Get the design', howToGet(d.design)],
      ['Stages', d.stages.length],
      [
        'Packs in all',
        raw(
          Object.entries(packs)
            .map(([p, n]) => packLink(p, n).html)
            .join('<br>'),
        ),
      ],
      ['Labor in all', labor],
      ['Hands you', itemLink(d.deed)],
    ];
  },
  body: (d) =>
    join(
      md`## Stage by Stage`,
      table(
        ['Stage', 'What It Is', 'Haul to the Slip', 'Labor'],
        d.stages.map((s) => [
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
      md`[[systems/vehicles]] tells how a slipway is claimed and a ship launched.`,
    ),
  columns: [
    ['Stages', (d) => d.stages.length],
    ['Builds', (d) => link(`vehicles/${d.vehicle}`)],
  ],
});
