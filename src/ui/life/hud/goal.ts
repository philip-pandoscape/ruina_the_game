import { GATHERING } from '../../../content/farming';
import { RECIPES, VENDORS } from '../../../content/items';
import { objectiveTarget, questDef } from '../../../content/quests';
import { structureDef } from '../../../content/structures';
import { packDef, placeName } from '../../../content/trade';
import { isBoat, rideable } from '../../../content/vehicles';
import { housePose, isComplete, stageReady, stillNeeds } from '../../../sim/life/housing';
import { nodeReady } from '../../../sim/life/interact';
import type { Life } from '../../../sim/life/life';
import { shipFinished, shipNeeds, shipOn, shipStageReady } from '../../../sim/life/shipyard';
import type { Sim } from '../../../sim/sim';

// Where the quest you're on leads you: the ring on both maps, the marker on the compass, and what
// `LifeUI.goal` tells the tests.

/** Somewhere a quest leads you: the ring on the maps and the marker on the compass. */
export type Goal = { x: number; z: number; label: string };

/** Where the first unfinished quest wants you to go. */
export function questGoal(life: Life, sim: Sim): Goal | null {
  const r = life.zone.recipe;
  const npc = (id: string) => r.npcs.find((n) => n.id === id);
  const place = (id: string) => r.places.find((pl) => pl.id === id);
  for (const qp of life.state.quests.active) {
    const q = questDef(qp.id);
    if (q.milestone) continue; // something to work toward, not somewhere to go
    if (qp.step >= q.steps.length) {
      const n = npc(q.turnIn ?? q.giver);
      if (n) return { x: n.x, z: n.z, label: n.name };
      continue;
    }
    const step = q.steps[qp.step];
    for (let i = 0; i < step.objectives.length; i++) {
      const o = step.objectives[i];
      if (qp.counts[i] >= objectiveTarget(o)) continue;
      if (o.npc && npc(o.npc)) return { x: npc(o.npc)!.x, z: npc(o.npc)!.z, label: npc(o.npc)!.name };
      if (o.type === 'reach' && o.place && place(o.place)) return { x: place(o.place)!.x, z: place(o.place)!.z, label: place(o.place)!.name };
      if (o.type === 'deliver' && o.outpost) {
        const op = r.outposts.find((x) => x.id === o.outpost);
        if (op) return { x: op.x, z: op.z, label: placeName(o.outpost) };
      }
      if (o.type === 'gather') {
        const nd = nodeFor(life, sim, o.kind);
        if (nd) return nd;
      }
      if (o.type === 'craftPack')
        return (o.pack ? benchFor(life, o.pack) : null) ?? { x: r.workbenches[0].x, z: r.workbenches[0].z, label: 'Specialty Workbench' };
      if (o.type === 'placeScarecrow') return { x: r.farmland.x, z: r.farmland.z, label: 'Barleybrook Fields' };
      if ((o.type === 'plant' || o.type === 'harvest' || o.type === 'raise') && life.state.scarecrows[0])
        return { x: life.state.scarecrows[0].x, z: life.state.scarecrows[0].z, label: 'Your Plot' };
      if (o.type === 'contract') {
        const k = life.state.contracts?.active[0];
        const op = r.outposts.find((x) => x.id === (k?.outpost ?? 'westwatch'));
        if (op) return { x: op.x, z: op.z, label: placeName(op.id) };
      }
      if ((o.type === 'layKeel' || o.type === 'shipStage' || o.type === 'launch') && r.shipyards?.[0]) {
        const sy = r.shipyards[0];
        const slip = { x: sy.x, z: sy.z, label: sy.name };
        const b = shipOn(life, sy.id);
        return o.type === 'shipStage' && b && !shipFinished(b) ? fetchFor(life, sim, shipNeeds(b), shipStageReady(b), slip) : slip;
      }
      if (o.type === 'summon' && o.vehicle && isBoat(rideable(o.vehicle))) return { x: place('docks')!.x, z: place('docks')!.z, label: 'The Docks' };
      if (o.type === 'load' && life.state.vehicles[0]) return { x: life.state.vehicles[0].x, z: life.state.vehicles[0].z, label: 'Your Vehicle' };
      if (o.type === 'placeHouse' || o.type === 'buildStage') {
        const h = life.state.houses[0];
        if (h) {
          const pose = housePose(life, h);
          const site = { x: pose.x, z: pose.z, label: 'Your House' };
          return isComplete(h) ? site : fetchFor(life, sim, stillNeeds(h), stageReady(h), site);
        }
        // No blueprint to place yet: whoever sells them.
        const vendor = VENDORS.find((v) => v.sells.some((s) => s.item.startsWith('blueprint.')));
        const seller = vendor ? npc(vendor.npc) : undefined;
        if (seller && !life.state.bag.some((s) => s.item.startsWith('blueprint.'))) return { x: seller.x, z: seller.z, label: seller.name };
        return { x: place('hearthside')!.x, z: place('hearthside')!.z, label: 'Hearthside Rise' };
      }
      if (o.type === 'glide')
        return { x: r.places.find((pl) => pl.id === 'lanternwick')!.x, z: r.places.find((pl) => pl.id === 'lanternwick')!.z, label: 'Lanternwick' };
    }
  }
  return null;
}

/** The nearest resource node that gives `kind` (timber, stone...), one ready to work before one picked clean. */
function nodeFor(life: Life, sim: Sim, kind?: string): Goal | null {
  const p = sim.player.pos;
  const nodes = life.zone.recipe.nodes;
  let best: Goal | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    const g = GATHERING[nd.kind];
    if (!g || (kind && g.kind !== kind)) continue;
    const score = Math.hypot(nd.x - p.x, nd.z - p.z) + (nodeReady(life, i) ? 0 : 1e5);
    if (score < bestScore) {
      bestScore = score;
      best = { x: nd.x, z: nd.z, label: structureDef(nd.kind).name };
    }
  }
  return best;
}

/** The workbench that makes a pack. */
function benchFor(life: Life, pack: string): Goal | null {
  const rc = RECIPES.find((x) => x.makes.pack === pack);
  const b = rc ? life.zone.recipe.workbenches.find((w) => w.id === rc.bench) : undefined;
  return b ? { x: b.x, z: b.z, label: (b as { name?: string }).name ?? 'Workbench' } : null;
}

/**
 * Where to go next for a stage of your house or ship: the site, once it has all it needs or you
 * have a pack it wants on your back or aboard a vehicle; a pack it wants that you left lying
 * somewhere; otherwise the bench that makes the first pack it still wants.
 */
function fetchFor(life: Life, sim: Sim, needs: Array<{ pack: string; have: number; need: number }>, ready: boolean, site: Goal): Goal {
  const want = needs.filter((n) => n.have < n.need).map((n) => n.pack);
  if (ready || !want.length) return site;
  const mine = life.state.packs.filter((pk) => want.includes(pk.def));
  if (mine.some((pk) => pk.at !== 'ground')) return site;
  const p = sim.player.pos;
  const lying = mine.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
  if (lying) return { x: lying.x, z: lying.z, label: packDef(lying.def).name };
  return benchFor(life, want[0]) ?? site;
}
