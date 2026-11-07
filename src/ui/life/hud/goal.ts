import { GATHERING } from '../../../content/farming';
import { claimsPlot, RECIPES, VENDORS } from '../../../content/items';
import { type Objective, objectiveTarget, type QuestMarker, questDef } from '../../../content/quests';
import { structureDef } from '../../../content/structures';
import { packDef, placeName } from '../../../content/trade';
import { housePose, isComplete, stageReady, stillNeeds, nodeReady, type LifeRead, shipFinished, shipNeeds, shipOn, shipStageReady } from '../../../engine/life';
import type { SimRead } from '../../../engine/rules';

// Where the quest you're on leads you: the ring on both maps, the marker on the compass, and what
// `LifeUI.goal` tells the tests. What an objective names leads first (the person to talk to, the
// place to reach, the trading post, the bench that makes the pack, your plot, house, ship or
// vehicle); otherwise its quest's data says where (an objective's `marker`, content/quests/).

/** Somewhere a quest leads you: the ring on the maps and the marker on the compass. */
export type Goal = { x: number; z: number; label: string };

/** Where the first unfinished quest wants you to go. */
export function questGoal(life: LifeRead, sim: SimRead): Goal | null {
  const r = life.zone.recipe;
  for (const qp of life.state.quests.active) {
    const q = questDef(qp.id);
    if (q.milestone) continue; // something to work toward, not somewhere to go
    if (qp.step >= q.steps.length) {
      const n = r.npcs.find((x) => x.id === (q.turnIn ?? q.giver));
      if (n) return { x: n.x, z: n.z, label: n.name };
      continue;
    }
    const step = q.steps[qp.step];
    for (let i = 0; i < step.objectives.length; i++) {
      const o = step.objectives[i];
      if (qp.counts[i] >= objectiveTarget(o)) continue;
      const g = objectiveGoal(life, sim, o);
      if (g) return g;
    }
  }
  return null;
}

/** Where an unfinished objective leads, or null if nowhere in particular. */
function objectiveGoal(life: LifeRead, sim: SimRead, o: Objective): Goal | null {
  const r = life.zone.recipe;
  const s = life.state;
  const n = o.npc ? r.npcs.find((x) => x.id === o.npc) : undefined;
  if (n) return { x: n.x, z: n.z, label: n.name };
  const pl = o.type === 'reach' && o.place ? r.places.find((x) => x.id === o.place) : undefined;
  if (pl) return { x: pl.x, z: pl.z, label: pl.name };
  if (o.type === 'deliver' && o.outpost) {
    const op = r.outposts.find((x) => x.id === o.outpost);
    if (op) return { x: op.x, z: op.z, label: placeName(o.outpost) };
  }
  if (o.type === 'gather') {
    const nd = nodeFor(life, sim, o.kind);
    if (nd) return nd;
  }
  if (o.type === 'craftPack') {
    const b = o.pack ? benchFor(life, o.pack) : null;
    if (b) return b;
  }
  if ((o.type === 'plant' || o.type === 'harvest' || o.type === 'raise') && life.land.scarecrows[0])
    return { x: life.land.scarecrows[0].x, z: life.land.scarecrows[0].z, label: 'Your Plot' };
  if (o.type === 'contract') {
    // The trading post of the contract you took; with none taken, where the quest says.
    const k = s.contracts?.active[0];
    if (k) {
      const op = r.outposts.find((x) => x.id === k.outpost);
      return op ? { x: op.x, z: op.z, label: placeName(op.id) } : null;
    }
  }
  if (o.type === 'layKeel' || o.type === 'shipStage' || o.type === 'launch') {
    // The slipway the quest names, else the region's own.
    const sy = r.shipyards?.find((x) => x.id === o.marker?.shipyard) ?? r.shipyards?.[0];
    if (sy) {
      const slip = { x: sy.x, z: sy.z, label: o.marker?.label ?? sy.name };
      const b = shipOn(life, sy.id);
      return o.type === 'shipStage' && b && !shipFinished(b) ? fetchFor(life, sim, shipNeeds(b), shipStageReady(b), slip) : slip;
    }
  }
  if (o.type === 'load' && life.land.vehicles[0]) return { x: life.land.vehicles[0].x, z: life.land.vehicles[0].z, label: 'Your Vehicle' };
  if (o.type === 'placeHouse' || o.type === 'buildStage') {
    const h = life.land.houses[0];
    if (h) {
      const pose = housePose(life, h);
      const site = { x: pose.x, z: pose.z, label: 'Your House' };
      return isComplete(h) ? site : fetchFor(life, sim, stillNeeds(h), stageReady(h), site);
    }
    // No blueprint to place yet: whoever sells them.
    const vendor = VENDORS.find((v) => v.sells.some((x) => claimsPlot(x.item)));
    const seller = vendor ? r.npcs.find((x) => x.id === vendor.npc) : undefined;
    if (seller && !s.bag.some((x) => claimsPlot(x.item))) return { x: seller.x, z: seller.z, label: seller.name };
  }
  // Where the quest says: a place, a trading post, a workbench or a slipway. A pack with no bench
  // to make it is made at the region's first.
  return marked(life, o.marker) ?? (o.type === 'craftPack' && r.workbenches[0] ? benchGoal(r.workbenches[0]) : null);
}

/** The spot a quest's marker names, called by its own name there unless the marker gives another. */
function marked(life: LifeRead, m: QuestMarker | undefined): Goal | null {
  if (!m) return null;
  const r = life.zone.recipe;
  const at = (spot: { x: number; z: number } | undefined, name: string): Goal | null => (spot ? { x: spot.x, z: spot.z, label: m.label ?? name } : null);
  if (m.place) {
    const pl = r.places.find((x) => x.id === m.place);
    return at(pl, pl?.name ?? '');
  }
  if (m.outpost) {
    const op = r.outposts.find((x) => x.id === m.outpost);
    return at(op, placeName(m.outpost));
  }
  if (m.workbench) {
    const b = r.workbenches.find((x) => x.id === m.workbench);
    return at(b, b ? benchGoal(b).label : '');
  }
  if (m.shipyard) {
    const sy = r.shipyards?.find((x) => x.id === m.shipyard);
    return at(sy, sy?.name ?? '');
  }
  return null;
}

/** A workbench, by its name. */
const benchGoal = (b: { x: number; z: number; name?: string }): Goal => ({ x: b.x, z: b.z, label: b.name ?? 'Workbench' });

/** The nearest resource node that gives `kind` (timber, stone...), one ready to work before one picked clean. */
function nodeFor(life: LifeRead, sim: SimRead, kind?: string): Goal | null {
  const p = sim.player.pos;
  let best: Goal | null = null;
  let bestScore = Infinity;
  for (const nd of life.zone.recipe.nodes) {
    const g = GATHERING[nd.kind];
    if (!g || (kind && g.kind !== kind)) continue;
    const score = Math.hypot(nd.x - p.x, nd.z - p.z) + (nodeReady(life, nd.id) ? 0 : 1e5);
    if (score < bestScore) {
      bestScore = score;
      best = { x: nd.x, z: nd.z, label: structureDef(nd.kind).name };
    }
  }
  return best;
}

/** The workbench that makes a pack. */
function benchFor(life: LifeRead, pack: string): Goal | null {
  const rc = RECIPES.find((x) => x.makes.pack === pack);
  const b = rc ? life.zone.recipe.workbenches.find((w) => w.id === rc.bench) : undefined;
  return b ? benchGoal(b) : null;
}

/**
 * Where to go next for a stage of your house or ship: the site, once it has all it needs or you
 * have a pack it wants on your back or aboard a vehicle; a pack it wants that you left lying
 * somewhere; otherwise the bench that makes the first pack it still wants.
 */
function fetchFor(life: LifeRead, sim: SimRead, needs: Array<{ pack: string; have: number; need: number }>, ready: boolean, site: Goal): Goal {
  const want = needs.filter((n) => n.have < n.need).map((n) => n.pack);
  if (ready || !want.length) return site;
  const mine = life.land.packs.filter((pk) => want.includes(pk.def));
  if (mine.some((pk) => pk.at !== 'ground')) return site;
  const p = sim.player.pos;
  const lying = mine.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
  if (lying) return { x: lying.x, z: lying.z, label: packDef(lying.def).name };
  return benchFor(life, want[0]) ?? site;
}
