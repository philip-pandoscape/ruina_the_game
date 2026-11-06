// The first section: what Ruina is, how to play it, and how to read this book.

import { BAG_SLOTS, ITEMS, RECIPES, VENDORS } from '../content/items';
import { QUESTS } from '../content/quests';
import { CROPS, ANIMALS } from '../content/farming';
import { LABOR } from '../content/trade';
import { GLIDERS, MOUNTS, VEHICLES } from '../content/vehicles';
import { NODES } from '../skills';
import { HOTBAR_SLOTS, MOVEMENT_SLOTS, SIM_HZ, WEAPONS } from '../tuning';
import { EMBERHOLM as Z } from '../sim/zone/world';
import { coins, count, framesAsSeconds, key, num, speed } from './format';
import { about, type AboutDef, table } from './kit';
import { blockHtml, md, raw } from './md';

const cog = VEHICLES.find((v) => v.id === 'cog');
const glider = GLIDERS[0];
/** The dearest thing a vendor sells, for the example of money. */
const dearest = VENDORS.flatMap((v) => v.sells)
  .map((s) => ({ name: ITEMS.find((i) => i.id === s.item)?.name ?? s.item, price: s.price }))
  .reduce((a, b) => (b.price > a.price ? b : a));
const cart = VEHICLES.find((v) => v.id === 'farmCart');

const card = (path: string, title: string, text: string) => `<a class="card" href="#/${path}"><b>${title}</b><span>${text}</span></a>`;

const overview = about({
  id: 'overview',
  title: 'Ruina',
  summary: 'A world you carry on your back: grow it, pack it, and haul it across land, sea and sky to wherever it is worth the most.',
  icon: '🏮',
  keywords: ['about', 'home', 'start', 'pillars'],
  body: () =>
    md`
Ruina is an online world on islands under a vast tree. You arrive on ${Z.name}, ${Z.subtitle.toLowerCase()}, with nothing but your boots. From there you farm, gather, pack goods and run them to the trading posts that pay the most, build a house and a ship stage by stage, fight with a classless build of weapons and skills, and travel on foot, by cart, by boat and by glider, with no loading screen between any of them.

This book says how all of it works, exactly. Every number in it is the game's own: it is drawn from the content and the rules as the page is shown, so when the game changes, the book has already changed with it.

${blockHtml(
  `<div class="cards">${[
    card('systems/moving', 'Systems', 'How each part of the game works: moving, fighting, farming, trading, building and the rest, with the formulas.'),
    card('zones', 'The World', `${Z.name}, its ${Z.places.length} places, its ${Z.npcs.length} people and the creatures that live there.`),
    card(
      'items',
      'Things',
      `Every item, crop, ride, skill and quest: ${ITEMS.length} items, ${CROPS.length} crops, ${VEHICLES.length + MOUNTS.length} rides and ${NODES.length} skills in the tree.`,
    ),
    card('ruina/controls', 'Controls', 'Every key and button, on a keyboard and on a controller.'),
  ].join('')}</div>`,
)}

## What Every System Serves

- **Goods are things, not numbers.** A trade pack sits on your back, slows your stride and keeps your glider shut. A ${cart ? raw(cart.name.toLowerCase()) : 'cart'} holds ${cart?.cargo.length}; the ${cog ? raw(cog.name) : 'cog'} holds ${cog?.cargo.length}. If it can be carried, it can be lost.
- **Land, sea and sky are one map.** Glide off a crag, land by the docks, row to an islet. Every route is a choice.
- **Far and risky pays more.** Prices grow with distance, fall as a market fills, and reward fresh goods. The best money is always one more leg away.
- **A piece of the world is yours.** Farms you planted and a house you raised stage by stage, earned with your hands, never bought in a store.
- **Moving is the fun part.** Sprint, slide and double jump on foot; dive and flare a glider; drift a roadster.
- **Pacing, never paywalls.** Labor paces gathering and crafting, generously: it comes back at ${LABOR.perMinute} a minute while you play, and nothing that paces play is ever for sale.

## Where to Start

The game teaches itself through its ${count(QUESTS.filter((q) => !q.milestone).length, 'quest')}, each opened by the one before: [[quests/landfall]] is the first. If you would rather read first: [[systems/moving]], [[systems/farming]], [[systems/trade]] and [[systems/combat]] cover most of a first day.
`,
});

const controls = about({
  id: 'controls',
  title: 'Controls',
  summary: 'Every key and button, on a keyboard and mouse and on a controller.',
  icon: '🎮',
  keywords: ['keys', 'keyboard', 'controller', 'gamepad', 'bindings', 'buttons'],
  body: () => {
    const k = (...names: string[]) => raw(names.map((n) => key(n).html).join(' '));
    return md`
## On Foot

${table(
  ['Doing', 'Keyboard and Mouse', 'Controller'],
  [
    ['Move; turn the camera', raw(`${k('W', 'A', 'S', 'D').html} · the mouse (click to capture it)`), 'Left stick; right stick'],
    ['Jump, double jump, open the glider', raw(`${k('Space').html} once, twice, three times`), k('A')],
    ['Sprint (hold)', k('Shift'), raw(`Left stick click`)],
    ['Crouch (hold); a press on the run slides', k('C'), 'Right stick click'],
    ['Slide', k('K'), k('B')],
    ['Interact: talk, plant, harvest, load, drive, build', k('F'), k('Y')],
    ['Set a pack down', k('X'), ''],
    ['Call or send away your mount', k('R'), raw(`D-pad down`)],
    ['Open or fold the glider', k('G'), ''],
    ['Change the seed you plant', k('Z'), ''],
    ['Auto-run where the camera looks', raw(`${k('H').html} or ${k('Num Lock').html}`), 'Left stick click, stick at rest'],
  ],
)}

## Fighting

${table(
  ['Doing', 'Keyboard and Mouse', 'Controller'],
  [
    ['Attack: the next hit of the combo', raw(`${k('J').html} or the left mouse button`), k('X')],
    [md`Movement skills (${count(MOVEMENT_SLOTS, 'slot')})`, k('Q', 'E'), raw(`${k('LB').html} ${k('RB').html}`)],
    [
      md`Hotbar abilities (${count(HOTBAR_SLOTS, 'slot')}); hold to aim a spell on the ground, let go to cast`,
      raw(`The number keys, one to ${HOTBAR_SLOTS}`),
      'Hold a trigger and press a face button',
    ],
    ['Skill book; skill tree', raw(`${k('T').html}; ${k('N').html}`), k('View')],
  ],
)}

## Riding, Driving, Sailing and Gliding

${table(
  ['Doing', 'Keyboard and Mouse', 'Controller'],
  [
    ['Throttle and steer', k('W', 'A', 'S', 'D'), 'Left stick'],
    ['Handbrake (drift)', k('Space'), k('A')],
    ['Boost', k('Shift'), 'Left stick click'],
    ['Raise or lower the sail', raw(`${k('W').html} / ${k('S').html}`), 'Left stick'],
    ['Gallop', k('Shift'), 'Left stick click'],
    ['Get out', k('F'), k('Y')],
    ['Glider: dive; flare', raw(`${k('Shift').html}; ${k('C').html}`), 'Left; right stick click'],
    ['Glider: gust of speed and lift', k('F'), k('Y')],
    ['Glider: fold it and drop', k('Space'), k('A')],
  ],
)}

## Windows

${table(
  ['Window', 'Keyboard', 'Controller'],
  [
    ['Bag', raw(`${k('I').html} or ${k('B').html}`), k('Menu')],
    ['Map (pick a place to travel there by road)', k('M'), raw(`D-pad up`)],
    ['Your rides', k('V'), ''],
    ['Quest log', k('L'), ''],
    ['Character', k('P'), ''],
    ['Party', k('O'), ''],
    ['Close a window', k('Esc'), k('B')],
    ['Report a bug while playing', k('\\'), ''],
  ],
)}
`;
  },
});

const reading = about({
  id: 'reading',
  title: 'Reading This Book',
  summary: 'The units, the money and the formulas this book uses, and where its numbers come from.',
  icon: '📖',
  keywords: ['units', 'frames', 'metres', 'formula', 'copper', 'silver', 'gold'],
  body: () => md`
## Where the Numbers Come From

Nothing in this book is copied by hand. Each number is read from the game's content (the files that say what every item, crop and creature is) or its rules as the page is drawn, and the formulas are the ones the rules run. When a number changes in the game, it changes here.

## Units

- **Distance** in metres; **speed** in metres a second, with kilometres an hour beside the faster ones.
- **Time** in seconds, minutes and hours of real time. The rules step ${SIM_HZ} times a second, and some timings are counted in those steps: a *frame* is ${framesAsSeconds(1)}, and the book gives both.
- **Slopes** in degrees from the level.
- **Money** in coins: a hundred copper make a silver and a hundred silver a gold, so the dearest thing a vendor sells, ${dearest.name}, at ${coins(dearest.price)}, is ${dearest.price} copper. Charter Seals are a second currency, earned only from trade.
- **Labor** in points: your capacity for honest work, spent on every harvest, haul and build.

## Formulas

A formula is set apart like this, with the game's values in it:

$$
glide ratio = cruise speed ÷ sink rate
${glider.name}: ${speed(glider.cruiseSpeed)} ÷ ${speed(glider.sink)} = ${num(glider.cruiseSpeed / glider.sink, 1)}
$$

That is, the ${glider.name} flies ${num(glider.cruiseSpeed / glider.sink, 1)} metres forward for every metre it sinks.

Where a page says *rounded*, the rules round to the nearest whole number, halves up. Where something is *drawn* from a range, every value in it is equally likely.

## Your Bag and Your Island

Your bag holds ${count(BAG_SLOTS, 'stack')}. Online, the world's server runs every rule: your island, its plots, packs and vehicles are kept for you, and nothing your browser says about itself is believed. There are ${RECIPES.length} recipes, ${ANIMALS.length} kinds of livestock and ${WEAPONS.length} weapons; every one has its page.
`,
});

export const ABOUT: readonly AboutDef[] = [overview, controls, reading];
