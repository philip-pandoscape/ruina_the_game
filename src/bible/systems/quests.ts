// Quests and Progress: written from its rules (`rules` below); every number from the content and the rules.

import { ITEMS } from '../../content/items';
import { type QuestDef, QUESTS } from '../../content/quests';
import { LABOR } from '../../content/trade';
import { START_POINTS } from '../../skills';
import { EMBERHOLM } from '../../sim/zone/world';
import { coins, count, duration, metres } from '../format';
import { join, system, table } from '../kit';
import { type Html, link, md, phrase, raw } from '../md';
import { sourceNumber } from '../source';
import questsSource from '../../sim/life/quests.ts?raw';
import interactSource from '../../sim/life/interact.ts?raw';

const RULE = {
  /** How near a place counts as reaching it, when the objective doesn't say. */
  reach: () => sourceNumber(questsSource, /\(o\.r \?\? (\d+(?:\.\d+)?)\)/, 'how near a place counts as reaching it'),
  /** How often getting somewhere is measured. */
  every: () => sourceNumber(questsSource, /life\.state\.clock % (\d+(?:\.\d+)?) < STEP/, 'how often a place reached is measured'),
  /** How near a person you talk to them. */
  talk: () => sourceNumber(interactSource, /n\.z - p\.pos\.z\);\s*if \(d > (\d+(?:\.\d+)?)\) continue;/, 'how near a person you talk to them'),
};

/** What counts toward each kind of objective, as the rules count it. Every kind the quests use must be here. */
const COUNTS: Record<string, [string, () => Html]> = {
  talk: ['Talk to someone', () => phrase`Talking to that person: F beside them.`],
  placeScarecrow: ['Set up a plot', () => phrase`Setting up a scarecrow plot. Plots you already have count.`],
  plant: ['Plant', () => phrase`Each seed you plant (of that crop, if it names one). Plants already growing in your plots count.`],
  raise: ['Raise', () => phrase`Each young animal you put in a plot (of that animal, if it names one). Animals already in your plots count.`],
  harvest: ['Harvest', () => phrase`Each harvest of a ripe crop, and each time you collect from a grown animal (that crop or animal, if it names one).`],
  gather: [
    'Gather',
    () =>
      phrase`Each piece of that material you gather: a swing that gives several counts them all, and timber from felling a tree you grew counts as much as deadfall.`,
  ],
  craftPack: ['Make a pack', () => phrase`Each pack you make (that pack, if it names one). Packs of yours that already exist count.`],
  deliver: ['Deliver', () => phrase`Each pack you sell at a trading post (that post, and that pack, if it names them).`],
  contract: ['Fill a contract', () => phrase`Each contract you fill ([[systems/contracts]]).`],
  summon: ['Summon', () => phrase`Summoning that vehicle. Having it out already counts.`],
  load: ['Load', () => phrase`Each pack you load into a vehicle. Packs already aboard count.`],
  reach: [
    'Reach a place',
    () =>
      phrase`Standing within its reach of the place (${metres(RULE.reach())} unless it says) and, if it says, at least so high. It is measured every ${duration(RULE.every())}.`,
  ],
  glide: ['Glide', () => phrase`Seconds with your glider open, added up over every flight.`],
  placeHouse: ['Claim a plot', () => phrase`Claiming a house plot. Holding one already counts.`],
  buildStage: ['Build', () => phrase`Each stage of your house you build. Stages already built count.`],
  layKeel: ['Lay a keel', () => phrase`Laying a ship's keel on a slipway. A ship already on the slip, or launched, counts.`],
  shipStage: ['Build a ship', () => phrase`Each stage of a ship you build. Stages already built count, and a launched ship counts all of them.`],
  launch: ['Launch', () => phrase`Launching a ship. Holding a launched ship's deed counts.`],
  defeat: ['Defeat', () => phrase`Each creature of exactly that kind you finish off. One that dissolves by itself isn't yours.`],
  skillLevel: ['Gain skill levels', () => phrase`Each level any of your skills gains as you use it ([[systems/skills]]).`],
};

const objectiveKinds = (): string[] => [...new Set(QUESTS.flatMap((q) => q.steps.flatMap((s) => s.objectives.map((o) => o.type))))];

const itemName = (id: string): string => ITEMS.find((i) => i.id === id)?.name ?? id;
const person = (id: string | undefined): Html | string => (id ? link(`npcs/${id}`, EMBERHOLM.npcs.find((n) => n.id === id)?.name ?? id) : '');

/** A quest's rewards, one to a line. */
function rewards(q: QuestDef): Html {
  const r = q.rewards;
  return raw(
    [
      r.skillPoints ? count(r.skillPoints, 'skill point').html : '',
      r.coins ? coins(r.coins).html : '',
      r.seals ? count(r.seals, 'Charter Seal').html : '',
      r.labor ? phrase`${r.labor} labor`.html : '',
      ...(r.items ?? []).map((i) => phrase`${i.n} × ${link(`items/${i.item}`, itemName(i.item))}`.html),
      r.equipGlider ? phrase`${link(`gliders/${r.equipGlider}`)} on your back`.html : '',
    ]
      .filter(Boolean)
      .join('<br>'),
  );
}

const after = (q: QuestDef): Html | string => (q.after.length ? raw(q.after.map((a) => link(`quests/${a}`).html).join(', ')) : 'The start');

export const quests = system({
  id: 'quests',
  title: 'Quests and Progress',
  summary: 'How quests open, start, count what you do and pay out; milestones; and the skill points they earn.',
  icon: '📜',
  keywords: ['quest', 'questline', 'milestone', 'objective', 'reward', 'skill points', 'abandon', 'hand in'],
  rules: ['src/sim/life/quests.ts', 'crates/engine/src/life/quests.rs'],
  content: ['shared/quests.json#quests'],
  body: () => {
    const kinds = objectiveKinds();
    const missing = kinds.filter((k) => !COUNTS[k]);
    if (missing.length) throw new Error(`the quests page says nothing of what counts toward ${missing.join(', ')} (src/bible/systems/quests.ts COUNTS)`);
    const line = QUESTS.filter((q) => !q.milestone);
    const milestones = QUESTS.filter((q) => q.milestone);
    const points = (list: QuestDef[]) => list.reduce((t, q) => t + (q.rewards.skillPoints ?? 0), 0);
    const starting = QUESTS.filter((q) => q.startItems?.length);
    return join(
      md`
The island teaches itself through quests: ${count(line.length, 'quest')} in a line, each opened by finishing the ones before it, and ${count(
        milestones.length,
        'milestone',
      )} that count what you do along the way. Objectives count what you actually do (planting, gliding, gathering, delivering, building), so the tutorial is the game, and your skill points come from them.

## How a Quest Opens

Every quest names the quests to finish first; it opens once all of them are done. A person with a quest for you says so when you come near, and F beside them (within ${metres(
        RULE.talk(),
      )}) lets you hear them out and take it. A few quests start by themselves the moment they open, without anyone to talk to: the first, [[quests/landfall]], is waiting the moment you arrive. Milestones start by themselves too.

## Taking a Quest

Some quests hand you something to start with, and taking one needs room in your bag for it: ${raw(
        starting
          .map(
            (q) =>
              phrase`${link(`quests/${q.id}`)} gives you ${raw(
                (q.startItems ?? []).map((i) => phrase`${i.n} × ${link(`items/${i.item}`, itemName(i.item))}`.html).join(', '),
              )}`.html,
          )
          .join('; '),
      )}. Its first step begins at once.

## Steps and What Counts

A quest is a list of steps, and a step is a list of objectives. Each objective counts up to its target and no further; when every objective of the step is met, the quest moves on to the next step and tells you what it is. Anything you do counts toward the current step of every quest you have taken that it matches.

When a step begins, whatever the world already shows done counts at once: the plot you already set up, the house you already raised, the ship already launched. Doing things in your own order never locks a quest.
`,
      table(
        ['Objective', 'What Counts'],
        kinds.map((k) => [COUNTS[k][0], COUNTS[k][1]()]),
      ),
      md`
## Handing It In

When the last step is done, the quest is ready, and a note says whom to return to: the person who gave it, or the one it names. F beside them hands it in, if your bag has room for the reward. A reward can be coins, Charter Seals, labor (never past your most, ${LABOR.max}), items, a glider put on your back, and skill points. Then any quest that has just opened and starts by itself begins.

## Giving One Up

In the quest log you can give up a quest you took: its progress goes, and its giver offers it again. Milestones and the quests that started by themselves can't be given up. A quest that handed you something to start with takes it back; once you have used it, the quest can't be given up.

## Milestones

A milestone starts by itself as soon as it opens and is done the moment its steps are, with nobody to hand it to.
`,
      table(
        ['Milestone', 'What It Asks', 'Opens After', 'Gives'],
        milestones.map((q) => [link(`quests/${q.id}`), q.steps.map((s) => s.text).join('; '), after(q), rewards(q)]),
      ),
      md`
## Skill Points

Skill points aren't kept: they are counted from the quests and milestones you have finished, so they can never drift from them. Everyone starts with ${count(
        START_POINTS,
        'point',
      )}; the questline gives ${count(points(line), 'point')} more and the milestones ${count(points(milestones), 'point')}, ${count(
        START_POINTS + points(line) + points(milestones),
        'point',
      )} in all. What they buy is in [[systems/skills]].

## The Questline

In the order the island tells it:
`,
      table(
        ['Quest', 'Given By', 'Opens After', 'Hand In To', 'Steps', 'Rewards'],
        line.map((q) => [link(`quests/${q.id}`), person(q.giver), after(q), person(q.turnIn ?? q.giver), q.steps.length, rewards(q)]),
        [4],
      ),
      md`Each quest's own page has its steps, every objective's target, and what its people say.`,
    );
  },
});
