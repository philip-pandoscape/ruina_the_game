import type { Life } from './life';
import type { Sim } from '../sim';
import { objectiveTarget, QUESTS, questDef, type Objective, type QuestDef } from '../../content/quests';
import type { Plant, QuestProgress } from './state';
import { SHIP_DESIGNS } from '../../content/shipyard';
import { itemDef } from '../../content/items';
import { formatCoins, LABOR } from '../../content/trade';
import { STEP } from '../../tuning';

// The starter questline: offered by NPCs once its prerequisites are done, advanced by events the
// other systems report (planted, harvested, delivered...), handed in for rewards.

export interface QuestEvent {
  type: string;
  npc?: string;
  crop?: string;
  pack?: string;
  outpost?: string;
  vehicle?: string;
  item?: string;
  kind?: string;
  place?: string;
  amount?: number;
}

export const questDone = (life: Life, id: string): boolean => life.state.quests.done.includes(id);
export const questActive = (life: Life, id: string) => life.state.quests.active.find((q) => q.id === id);

/** Offered and not yet taken. */
export function available(life: Life, q: QuestDef): boolean {
  return !questDone(life, q.id) && !questActive(life, q.id) && q.after.every((a) => questDone(life, a));
}

export const isReady = (life: Life, id: string): boolean => {
  const p = questActive(life, id);
  return !!p && p.step >= questDef(id).steps.length;
};

/** Quests this NPC has to give, and quests ready to hand in to them. */
export function questsAt(life: Life, npc: string): { offer: QuestDef[]; turnIn: QuestDef[] } {
  return {
    offer: QUESTS.filter((q) => q.giver === npc && available(life, q) && !q.auto),
    turnIn: QUESTS.filter((q) => !q.milestone && (q.turnIn ?? q.giver) === npc && isReady(life, q.id)),
  };
}

export function startQuests(life: Life): void {
  for (const p of [...life.state.quests.active]) catchUp(life, p);
  for (const q of QUESTS) if (q.auto && available(life, q)) accept(life, q.id);
}

/** Room in the bag for all of these at once (one kind at a time is close enough for a few items). */
function roomFor(life: Life, items: Array<{ item: string; n: number }> | undefined): boolean {
  return (items ?? []).every((i) => life.hasRoom(i.item, i.n));
}

/**
 * How much of an objective the world already shows done: a plot you already claimed, a house you
 * already raised, a ship already launched. Those count the moment the step starts, so doing
 * things in your own order never locks a quest.
 */
function alreadyDone(life: Life, o: Objective): number {
  const s = life.state;
  const launched = SHIP_DESIGNS.some((d) => life.count(d.deed) > 0);
  const plants = s.scarecrows.flatMap((sc) => sc.cells.filter((c): c is Plant => !!c));
  switch (o.type) {
    case 'placeScarecrow':
      return s.scarecrows.length;
    case 'plant':
      return plants.filter((c) => !c.animal && (!o.crop || c.crop === o.crop)).length;
    case 'raise':
      return plants.filter((c) => c.animal && (!o.crop || c.crop === o.crop)).length;
    case 'craftPack':
      return s.packs.filter((pk) => !o.pack || pk.def === o.pack).length;
    case 'load':
      return s.packs.filter((pk) => pk.at === 'cargo').length;
    case 'summon':
      return s.vehicles.some((v) => v.def === o.vehicle) ? 1 : 0;
    case 'placeHouse':
      return s.houses.length;
    case 'buildStage':
      return s.houses.reduce((m, h) => Math.max(m, h.stage), 0);
    case 'layKeel':
      return s.ships.length || launched ? 1 : 0;
    case 'shipStage':
      return launched ? objectiveTarget(o) : s.ships.reduce((m, b) => Math.max(m, b.stage), 0);
    case 'launch':
      return launched ? 1 : 0;
    default:
      return 0;
  }
}

/** Credits whatever the world already shows done for this step, and moves on if that is all of it. */
function catchUp(life: Life, p: QuestProgress): void {
  const step = questDef(p.id).steps[p.step];
  if (!step) return;
  p.counts = step.objectives.map((o, i) => Math.max(p.counts[i] ?? 0, Math.min(objectiveTarget(o), alreadyDone(life, o))));
  if (step.objectives.every((o, i) => p.counts[i] >= objectiveTarget(o))) advance(life, p.id);
}

function startStep(life: Life, p: QuestProgress): void {
  p.counts = [];
  catchUp(life, p);
}

export function accept(life: Life, id: string): boolean {
  const q = questDef(id);
  if (!available(life, q)) return false;
  if (!roomFor(life, q.startItems)) {
    life.toast('Make some room in your bag first', 'bad');
    return false;
  }
  const p: QuestProgress = { id, step: 0, counts: [] };
  life.state.quests.active.push(p);
  for (const s of q.startItems ?? []) life.give(s.item, s.n);
  life.emit({ t: 'quest', id, what: 'accepted' });
  // Milestones are always there to work toward; they only speak up when they're done.
  if (!q.milestone) life.toast(`New quest: ${q.name}`, 'quest');
  startStep(life, p);
  return true;
}

export function complete(life: Life, id: string): boolean {
  if (!isReady(life, id)) return false;
  const q = questDef(id);
  const r = q.rewards;
  if (!roomFor(life, r.items)) {
    life.toast('Make some room in your bag for the reward first', 'bad');
    return false;
  }
  const s = life.state;
  s.quests.active = s.quests.active.filter((p) => p.id !== id);
  s.quests.done.push(id);
  if (r.coins) s.coins += r.coins;
  if (r.seals) s.seals += r.seals;
  if (r.labor) s.labor = Math.min(LABOR.max, s.labor + r.labor);
  for (const it of r.items ?? []) life.give(it.item, it.n);
  if (r.equipGlider) s.glider = r.equipGlider;
  // Skill points aren't kept: they're counted from the quests you've done (progress.ts).
  const bits = [
    r.skillPoints ? `${r.skillPoints} skill point${r.skillPoints > 1 ? 's' : ''}` : '',
    r.coins ? formatCoins(r.coins) : '',
    r.seals ? `${r.seals} seal${r.seals > 1 ? 's' : ''}` : '',
    ...(r.items ?? []).map((i) => `${i.n > 1 ? `${i.n} ` : ''}${itemDef(i.item).name}`),
  ].filter(Boolean);
  life.toast(`✔ ${q.milestone ? `Milestone: ${q.name}` : `${q.name} complete`}${bits.length ? ` - ${bits.join(', ')}` : ''}`, 'quest');
  life.emit({ t: 'quest', id, what: 'done' });
  // Anything that just became available and starts by itself.
  startQuests(life);
  return true;
}

/**
 * Gives up a quest you took: it leaves your list with its progress, and its giver offers it again.
 * Milestones and the quests that start by themselves can't be given up. One that handed you
 * something to start with takes it back, so taking it again can't hand out another; once you've
 * used that, it can't be given up.
 */
export function abandon(life: Life, id: string): boolean {
  const q = QUESTS.find((x) => x.id === id);
  if (!q || q.milestone || q.auto || !questActive(life, id)) return false;
  const start = q.startItems ?? [];
  const used = start.find((s) => life.count(s.item) < s.n);
  if (used) {
    life.toast(`You've used the ${itemDef(used.item).name} it gave you, so it can't be given up`, 'bad');
    return false;
  }
  for (const s of start) life.take(s.item, s.n);
  life.state.quests.active = life.state.quests.active.filter((p) => p.id !== id);
  life.emit({ t: 'quest', id, what: 'abandoned' });
  life.toast(`Quest abandoned: ${q.name}`, 'info');
  return true;
}

function matches(o: { type: string; npc?: string; crop?: string; pack?: string; outpost?: string; vehicle?: string; place?: string; kind?: string }, e: QuestEvent): boolean {
  if (o.type !== e.type) return false;
  if (o.kind && o.kind !== e.kind) return false;
  if (o.place && o.place !== e.place) return false;
  if (o.npc && o.npc !== e.npc) return false;
  if (o.crop && o.crop !== e.crop) return false;
  if (o.pack && o.pack !== e.pack) return false;
  if (o.outpost && o.outpost !== e.outpost) return false;
  if (o.vehicle && o.vehicle !== e.vehicle) return false;
  return true;
}

/** Counts toward each objective of the quest's step that `pick` names and isn't done yet, and moves on once they all are. */
function countToward(life: Life, p: QuestProgress, pick: (o: Objective) => boolean, amount: number): void {
  const step = questDef(p.id).steps[p.step];
  if (!step) return;
  let changed = false;
  step.objectives.forEach((o, i) => {
    const target = objectiveTarget(o);
    if (p.counts[i] >= target || !pick(o)) return;
    p.counts[i] = Math.min(target, p.counts[i] + amount);
    changed = true;
  });
  if (changed && step.objectives.every((o, i) => p.counts[i] >= objectiveTarget(o))) advance(life, p.id);
}

export function notifyQuests(life: Life, e: QuestEvent): void {
  for (const p of life.state.quests.active) countToward(life, p, (o) => matches(o, e), e.amount ?? 1);
}

function advance(life: Life, id: string): void {
  const p = questActive(life, id)!;
  const q = questDef(id);
  p.step++;
  if (p.step >= q.steps.length) {
    p.counts = [];
    // A milestone has nobody to hand it to: it's done the moment its steps are.
    if (q.milestone && complete(life, id)) return;
    life.emit({ t: 'quest', id, what: 'ready' });
    life.toast(`${q.name}: return to ${q.turnIn ?? q.giver}`, 'quest');
    return;
  }
  life.emit({ t: 'quest', id, what: 'step' });
  life.toast(`${q.name}: ${q.steps[p.step].text}`, 'quest');
  startStep(life, p);
}

/** Objectives measured rather than reported: getting somewhere, time in the air. */
export function stepQuests(life: Life, sim: Sim): void {
  const p = sim.player;
  if (p.mode === 'glide') notifyQuests(life, { type: 'glide', amount: STEP });
  if (life.state.clock % 0.25 < STEP) {
    // Each quest measures its own places, with its own reach and height: the foot of the Windspire
    // is the spire for one quest and not yet its top for another.
    const at = (o: Objective): boolean => {
      const place = o.type === 'reach' && o.place ? life.zone.recipe.places.find((pl) => pl.id === o.place) : undefined;
      return !!place && Math.hypot(p.pos.x - place.x, p.pos.z - place.z) <= (o.r ?? 20) && p.pos.y >= (o.minY ?? -Infinity);
    };
    for (const qp of life.state.quests.active) countToward(life, qp, at, 1);
  }
}
