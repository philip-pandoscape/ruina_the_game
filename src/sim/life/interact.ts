import type { Life, Command } from './life';
import type { Sim } from '../sim';
import { CARRY, formatCoins, packDef, placeName } from '../../content/trade';
import { animalDef, cropDef, GATHERING } from '../../content/farming';
import { collect, feed, grownUp, hungry, produceReady, raise } from './livestock';
import { itemDef, recipe as recipeById } from '../../content/items';
import { blueprintDef } from '../../content/housing';
import { structureDef } from '../../content/structures';
import { rideable, isMount } from '../../content/vehicles';
import { toLocal } from '../zone/generate';
import { closeGlider, gliderBlocked, gust, openGlider } from '../player/traverse';
import { addScarecrow, cellAt, cellCentre, fell, harvest, isRipe, plant, plotProblem, secondsToRipe, stageOf, water, growFor } from './farming';
import { buy, buyBack, carried, dropPack, pickUp, quote, recoverDemand, runRecipe, sell, loadPack, unloadPack, sellPack } from './trade';
import { board, dismount, distanceTo, mountCommand, nearestAnchor, packBlocks, recall, ridden, summon } from './vehicles';
import { buildStage, deliverMaterial, houseOn, housePose, interiorPoint, isComplete, payTax, placeHouse, stageReady, stillNeeds, taxDue, DAY } from './housing';
import { abandon, accept, complete, questsAt } from './quests';
import { acceptContract } from './contracts';
import { buildShipStage, deliverShipMaterial, designItemsInBag, launch, layKeel, shipFinished, shipNeeds, shipOn, shipStageReady } from './shipyard';
import { shipDesign, designForItem } from '../../content/shipyard';
import { questDef } from '../../content/quests';

// What pressing F does right now, and the commands everything else sends. The focus is worked out
// every step from what is near you and in front of you, so the prompt on screen is always exactly
// what the next press will do.

export type FocusAction =
  | 'talk' | 'sell' | 'craft' | 'pickup' | 'board' | 'ride' | 'load' | 'unload' | 'exit'
  | 'plant' | 'water' | 'harvest' | 'fell' | 'gather' | 'claim' | 'deliver' | 'build'
  | 'rest' | 'storage' | 'tax' | 'placeScarecrow' | 'keel' | 'shipDeliver' | 'shipBuild' | 'launch' | 'feed' | 'collect' | 'info';

export interface Focus {
  action: FocusAction;
  key: string;
  label: string;
  detail?: string;
  ok: boolean;
  x: number;
  y: number;
  z: number;
  npc?: string;
  bench?: string;
  pack?: number;
  vehicle?: number;
  /** Riding along: whose vehicle it is (their character). */
  host?: number;
  slot?: number;
  sc?: number;
  cell?: number;
  node?: number;
  plot?: string;
  house?: number;
  slip?: string;
}

export interface Placement {
  item: string;
  x: number;
  z: number;
  rot: number;
  problem: string | null;
}

const NODE_YIELD = GATHERING;

const outpostOf = (life: Life, npc: string) => life.zone.recipe.outposts.find((o) => o.npc === npc);

export function nodeReady(life: Life, i: number): boolean {
  return (life.state.nodes[i] ?? 0) <= life.state.clock;
}

/** Seconds left on something, as "1m 20s". */
export function shortTime(s: number): string {
  s = Math.max(0, Math.ceil(s));
  if (s >= DAY) return `${Math.floor(s / DAY)}d ${Math.floor((s % DAY) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

// ---------- Working out the focus ----------

export function findFocus(life: Life, sim: Sim): Focus | null {
  const p = sim.player;
  const hf = sim.world.terrain!;
  const here = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
  if (p.mode === 'ride') {
    const v = ridden(life, sim);
    const def = v ? rideable(v.def) : null;
    return { action: 'exit', key: 'exit', label: def && isMount(def) ? `Dismount` : `Get Out`, ok: true, ...here };
  }
  if (life.placing) {
    const pl = life.placing;
    const ahead = 7;
    pl.x = p.pos.x + Math.sin(p.facing) * ahead;
    pl.z = p.pos.z + Math.cos(p.facing) * ahead;
    pl.rot = Math.round(p.facing / (Math.PI / 12)) * (Math.PI / 12);
    pl.problem = plotProblem(life, sim, pl.x, pl.z, pl.rot);
    return { action: 'placeScarecrow', key: 'place', label: pl.problem ? pl.problem : 'Place Scarecrow Here', detail: 'Esc to Cancel', ok: !pl.problem, x: pl.x, y: hf.height(pl.x, pl.z), z: pl.z };
  }
  if (p.mode !== 'normal' && p.mode !== 'swim') return null;

  let best: Focus | null = null;
  let bestScore = Infinity;
  const fx = Math.sin(p.facing);
  const fz = Math.cos(p.facing);
  const consider = (f: Focus, dist: number, range: number) => {
    if (dist > range) return;
    const dx = f.x - p.pos.x;
    const dz = f.z - p.pos.z;
    const l = Math.hypot(dx, dz);
    const facing = l > 0.3 ? (dx * fx + dz * fz) / l : 1;
    const score = dist + (1 - facing) * 1.2;
    if (score < bestScore) {
      bestScore = score;
      best = f;
    }
  };
  const back = carried(life, sim);

  // People.
  for (const n of life.zone.recipe.npcs) {
    const d = Math.hypot(n.x - p.pos.x, n.z - p.pos.z);
    if (d > 4) continue;
    const y = hf.height(n.x, n.z);
    const outpost = outpostOf(life, n.id);
    if (outpost && back) {
      const q = quote(life, back, outpost.id);
      const def = packDef(back.def);
      consider(
        q
          ? { action: 'sell', key: `npc:${n.id}`, label: `Sell ${def.name}`, detail: `${formatCoins(q.coins)}${q.seals ? ` + ${q.seals} Seal${q.seals > 1 ? 's' : ''}` : ''} · Demand ${Math.round(q.demand * 100)}% · ${q.fresh >= 1 ? 'Fresh' : 'Stale'} ${Math.round((q.fresh - 1) * 100)}%`, ok: true, npc: n.id, x: n.x, y, z: n.z }
          : { action: 'info', key: `npc:${n.id}`, label: `${n.name} won't buy that here`, detail: back.origin === outpost.id ? 'Made here - sell it elsewhere' : (def as { kind?: string }).kind === 'material' ? 'Building materials go to a building site' : '', ok: false, npc: n.id, x: n.x, y, z: n.z },
        d,
        4,
      );
      continue;
    }
    const qa = questsAt(life, n.id);
    const talkGoal = life.state.quests.active.some((qp) => questDef(qp.id).steps[qp.step]?.objectives.some((o) => o.type === 'talk' && o.npc === n.id));
    const tag = qa.turnIn.length ? 'Quest Complete!' : talkGoal ? 'Quest' : qa.offer.length ? 'New Quest' : n.title;
    consider({ action: 'talk', key: `npc:${n.id}`, label: `Talk to ${n.name}`, detail: tag, ok: true, npc: n.id, x: n.x, y, z: n.z }, d, 4);
  }

  // Workbenches.
  for (const b of life.zone.recipe.workbenches) {
    const d = Math.hypot(b.x - p.pos.x, b.z - p.pos.z);
    const name = (b as { name?: string }).name ?? 'Workbench';
    consider({ action: 'craft', key: `bench:${b.id}`, label: `Use ${name}`, detail: back ? 'Your back is full' : `${placeName(b.place)} Packs`, ok: true, bench: b.id, x: b.x, y: hf.height(b.x, b.z), z: b.z }, d, 3.4);
  }

  // Packs lying on the ground.
  if (!back) {
    for (const pk of life.state.packs) {
      if (pk.at !== 'ground') continue;
      const d = Math.hypot(pk.x - p.pos.x, pk.z - p.pos.z);
      consider({ action: 'pickup', key: `pack:${pk.id}`, label: `Pick Up ${packDef(pk.def).name}`, ok: true, pack: pk.id, x: pk.x, y: pk.y, z: pk.z }, d, CARRY.pickupRange);
    }
  }

  // Vehicles: the seat to get in, the cargo bed to load or unload.
  for (const v of life.state.vehicles) {
    const d = distanceTo(v, p.pos.x, p.pos.z);
    if (d > 2.2) continue;
    const def = rideable(v.def);
    const a = nearestAnchor(v, p.pos.x, p.pos.z, !!back);
    const free = v.cargo.indexOf(0);
    const loaded = v.cargo.findIndex((c) => c !== 0);
    const used = v.cargo.filter(Boolean).length;
    const at = { x: v.x, y: v.y, z: v.z };
    if (a.kind === 'cargo' && back && free >= 0 && def.cargo.length) {
      consider({ action: 'load', key: `veh:${v.id}:load`, label: `Load ${packDef(back.def).name}`, detail: `${def.name} ${used}/${def.cargo.length}`, ok: true, vehicle: v.id, slot: free, ...at }, d, 2.2);
    } else if (a.kind === 'cargo' && !back && loaded >= 0) {
      consider({ action: 'unload', key: `veh:${v.id}:unload`, label: `Take a Pack from the ${def.name}`, detail: `${used}/${def.cargo.length} Aboard`, ok: true, vehicle: v.id, slot: loaded, ...at }, d, 2.2);
    } else {
      const mount = isMount(def);
      // With a pack on your back only a pack animal will carry you; a cart takes it in its bed.
      const blocked = !!back && !!packBlocks(def);
      consider({ action: 'board', key: `veh:${v.id}`, label: `${mount ? 'Ride' : 'Drive'} ${def.name}`, detail: blocked ? (mount ? 'Will not carry a pack' : 'Load your pack first') : def.cargo.length ? `Cargo ${used}/${def.cargo.length}` : undefined, ok: !blocked, vehicle: v.id, ...at }, d + 0.3, 2.2);
    }
  }

  // Online, someone else's vehicle with a seat beside its driver's: ride along (the channel seats you).
  for (const o of life.othersVehicles?.() ?? []) {
    const v = o.vehicle;
    const def = rideable(v.def);
    if (def.seats.length < 2) continue;
    const d = distanceTo(v, p.pos.x, p.pos.z);
    if (d > 2.2) continue;
    const room = o.taken.length < def.seats.length - 1;
    const detail = back ? 'Put your pack down first' : room ? def.name : 'No room left';
    consider({ action: 'ride', key: `ride:${o.host}:${v.id}`, label: `Ride with ${o.name}`, detail, ok: !back && room, host: o.host, vehicle: v.id, x: v.x, y: v.y, z: v.z }, d + 0.3, 2.2);
  }

  // Your farm plots: whatever is in the cell in front of you.
  const tx = p.pos.x + fx * 1.3;
  const tz = p.pos.z + fz * 1.3;
  const cell = cellAt(life, tx, tz);
  if (cell) {
    const plantHere = cell.sc.cells[cell.idx];
    const c = cellCentre(cell.sc, cell.idx);
    const y = hf.height(c.x, c.z);
    const base = { key: `cell:${cell.sc.id}:${cell.idx}`, sc: cell.sc.id, cell: cell.idx, x: c.x, y, z: c.z };
    if (!plantHere) {
      const seed = life.state.seed && life.count(life.state.seed) > 0 ? life.state.seed : life.state.bag.find((s) => itemDef(s.item).cat === 'seed')?.item;
      const verb = seed && itemDef(seed).raises ? 'Raise' : 'Plant';
      if (seed) consider({ ...base, action: 'plant', label: `${verb} ${itemDef(seed).name.replace(' Seeds', '')}`, detail: `${life.count(seed)} Left · Z: Change Seed`, ok: true }, 0.5, 9);
      else consider({ ...base, action: 'info', label: 'Empty Soil', detail: 'Buy seeds from Mara, or young animals from Sela', ok: false }, 0.5, 9);
    } else if (plantHere.animal) {
      const def = animalDef(plantHere.crop);
      const name = grownUp(plantHere) ? def.name : def.young;
      if (produceReady(plantHere)) consider({ ...base, action: 'collect', label: def.verb, detail: `${def.collectLabor} Labor`, ok: true }, 0.5, 9);
      else if (hungry(life, plantHere)) consider({ ...base, action: 'feed', label: `Feed the ${name}`, detail: `${def.feedN} ${itemDef(def.feed).name} · Hungry`, ok: life.count(def.feed) >= def.feedN }, 0.5, 9);
      else {
        const left = Math.max(0, Math.ceil((plantHere.fedUntil ?? 0) - life.state.clock));
        const state = grownUp(plantHere) ? `${def.produce} ${Math.round((plantHere.produce ?? 0) * 100)}%` : `Growing ${Math.round(plantHere.growth * 100)}%`;
        consider({ ...base, action: 'feed', label: `Feed the ${name}`, detail: `${state} · Fed for ${shortTime(left)}`, ok: life.count(def.feed) >= def.feedN }, 0.5, 9);
      }
    } else {
      const def = cropDef(plantHere.crop);
      const stage = stageOf(plantHere);
      if (isRipe(plantHere) && def.produce) consider({ ...base, action: 'harvest', label: `Harvest ${def.name}`, detail: `${def.harvestLabor} Labor`, ok: true }, 0.5, 9);
      else if (def.chop && stage >= def.stages - 2) consider({ ...base, action: 'fell', label: `Fell ${def.name}`, detail: `${def.chop.labor} Labor · Timber`, ok: true }, 0.5, 9);
      else if (!plantHere.watered && plantHere.growth < 1) consider({ ...base, action: 'water', label: `Water ${def.name}`, detail: `${Math.round(plantHere.growth * 100)}% · Ripe in ~${shortTime(secondsToRipe(life, plantHere))}`, ok: true }, 0.5, 9);
      else consider({ ...base, action: 'info', label: `${def.name} - ${Math.round(plantHere.growth * 100)}%`, detail: `${plantHere.watered ? 'Watered · ' : ''}Ripe in ~${shortTime(secondsToRipe(life, plantHere))}`, ok: false }, 0.5, 9);
    }
  }

  // Gathering: timber, stone, ore, herbs.
  life.zone.recipe.nodes.forEach((nd, i) => {
    const y = NODE_YIELD[nd.kind];
    if (!y) return;
    const d = Math.max(0, Math.hypot(nd.x - p.pos.x, nd.z - p.pos.z) - structureDef(nd.kind).w / 2);
    if (d > 2) return;
    const ready = nodeReady(life, i);
    consider(
      { action: ready ? 'gather' : 'info', key: `node:${i}`, label: ready ? y.verb : `${structureDef(nd.kind).name} - Picked Clean`, detail: ready ? `${y.labor} Labor` : `Back in ${shortTime(life.state.nodes[i] - life.state.clock)}`, ok: ready, node: i, x: nd.x, y: hf.height(nd.x, nd.z), z: nd.z },
      d,
      2,
    );
  });

  // Slipways: lay a keel, haul materials, build, launch.
  for (const sy of life.zone.recipe.shipyards ?? []) {
    const d = Math.hypot(sy.x - p.pos.x, sy.z - p.pos.z);
    if (d > 12) continue;
    const y = hf.height(sy.x, sy.z);
    const at = { key: `slip:${sy.id}`, slip: sy.id, x: sy.x, y, z: sy.z };
    const b = shipOn(life, sy.id);
    const score = d * 0.3 + 1.2;
    if (!b) {
      const design = designItemsInBag(life)[0];
      consider(design ? { ...at, action: 'keel', label: `Lay the ${designForItem(design)!.name}'s Keel`, detail: sy.name, ok: true } : { ...at, action: 'info', label: sy.name, detail: 'Needs a ship design - Captain Ilsa sells them', ok: false }, score, 12);
      continue;
    }
    const design = shipDesign(b.design);
    if (shipFinished(b)) {
      consider({ ...at, action: 'launch', label: `Launch the ${design.name}`, ok: true }, score, 12);
      continue;
    }
    const stage = design.stages[b.stage];
    const needs = shipNeeds(b);
    const list = needs.map((n) => `${packDef(n.pack).name} ${n.have}/${n.need}`).join(' · ');
    if (shipStageReady(b)) consider({ ...at, action: 'shipBuild', label: `Build the ${stage.name}`, detail: `${stage.labor} Labor`, ok: true }, score, 12);
    else if (back && needs.some((n) => n.pack === back.def && n.have < n.need)) consider({ ...at, action: 'shipDeliver', label: `Deliver ${packDef(back.def).name}`, detail: `${stage.name}: ${list}`, ok: true }, score, 12);
    else consider({ ...at, action: 'info', label: `${design.name}: ${stage.name} Needs`, detail: list, ok: false }, score, 12);
  }

  // House plots and building sites.
  for (const plot of life.zone.recipe.housePlots) {
    const [lx, lz] = toLocal(p.pos.x - plot.x, p.pos.z - plot.z, plot.rot);
    if (Math.abs(lx) > 9 || Math.abs(lz) > 9) continue;
    const h = houseOn(life, plot.id);
    const y = hf.height(plot.x, plot.z);
    const d = Math.hypot(lx, lz) * 0.25 + 1.5;
    const owner = h ? null : (life.plotOwner?.(plot.id) ?? null);
    if (owner) {
      consider({ action: 'info', key: `plot:${plot.id}`, label: `${owner}'s Plot`, detail: 'Already Claimed', ok: false, plot: plot.id, x: plot.x, y, z: plot.z }, d, 9);
      continue;
    }
    if (!h) {
      const bp = life.state.bag.find((s) => s.item.startsWith('blueprint.'));
      consider(
        bp
          ? { action: 'claim', key: `plot:${plot.id}`, label: `Place ${itemDef(bp.item).name}`, detail: 'Claims This Plot', ok: true, plot: plot.id, x: plot.x, y, z: plot.z }
          : { action: 'info', key: `plot:${plot.id}`, label: 'Plot for Claim', detail: 'Needs a Cottage Blueprint - Land Registry', ok: false, plot: plot.id, x: plot.x, y, z: plot.z },
        d,
        9,
      );
      continue;
    }
    const pose = housePose(life, h);
    if (!isComplete(h)) {
      const bp = blueprintDef(h.blueprint);
      const stage = bp.stages[h.stage];
      const needs = stillNeeds(h);
      const list = needs.map((n) => `${packDef(n.pack).name} ${n.have}/${n.need}`).join(' · ');
      const site = { key: `site:${h.id}`, house: h.id, x: pose.x, y, z: pose.z };
      if (stageReady(h)) consider({ ...site, action: 'build', label: `Build the ${stage.name}`, detail: `${stage.labor} Labor`, ok: true }, d, 9);
      else if (back && needs.some((n) => n.pack === back.def && n.have < n.need)) consider({ ...site, action: 'deliver', label: `Deliver ${packDef(back.def).name}`, detail: `${stage.name}: ${list}`, ok: true }, d, 9);
      else consider({ ...site, action: 'info', label: `${stage.name} Needs`, detail: list, ok: false }, d, 9);
      continue;
    }
    for (const what of ['bed', 'chest'] as const) {
      const pt = interiorPoint(life, h, what);
      const dd = Math.hypot(pt.x - p.pos.x, pt.z - p.pos.z);
      if (what === 'bed') consider({ action: 'rest', key: `bed:${h.id}`, label: 'Rest in Bed', detail: 'Labor recovers 3× faster', ok: true, house: h.id, x: pt.x, y: y + 0.3, z: pt.z }, dd, 1.8);
      else consider({ action: 'storage', key: `chest:${h.id}`, label: 'Open Storage Chest', ok: true, house: h.id, x: pt.x, y: y + 0.3, z: pt.z }, dd, 1.8);
    }
    const t = taxDue(life, h);
    if (Math.abs(lz) > 5) consider({ action: 'tax', key: `tax:${h.id}`, label: `Pay Property Tax (${formatCoins(t.owed)})`, detail: t.dueIn > 0 ? `Paid for ${shortTime(t.dueIn)}` : 'Overdue', ok: true, house: h.id, x: plot.x, y, z: plot.z }, d + 1, 9);
  }
  return best;
}

// ---------- Commands ----------

function nearNpc(life: Life, sim: Sim, npc: string, range = 6): boolean {
  const n = life.zone.recipe.npcs.find((x) => x.id === npc);
  return !!n && Math.hypot(n.x - sim.player.pos.x, n.z - sim.player.pos.z) <= range;
}

export function runCommand(life: Life, sim: Sim, c: Command): void {
  const p = sim.player;
  switch (c.t) {
    case 'interact':
      return interact(life, sim);
    case 'drop':
      if (!dropPack(life, sim) && !p.pack) life.toast('You are not carrying a pack', 'info');
      return;
    case 'mount':
      return mountCommand(life, sim);
    case 'exit':
      dismount(life, sim);
      return;
    case 'gust':
      if (!gust(sim) && p.mode === 'glide') life.toast('The wing is still recovering', 'info');
      return;
    case 'glider': {
      if (p.mode === 'glide') return closeGlider(sim, 'fold');
      const why = gliderBlocked(sim);
      if (why) life.toast(why, 'bad');
      else openGlider(sim);
      return;
    }
    case 'cycleSeed': {
      const seeds = life.state.bag.map((s) => s.item).filter((i, k, all) => itemDef(i).cat === 'seed' && all.indexOf(i) === k);
      if (!seeds.length) return;
      const i = seeds.indexOf(life.state.seed);
      life.state.seed = seeds[(i + 1) % seeds.length];
      life.toast(`Planting ${itemDef(life.state.seed).name}`, 'info');
      return;
    }
    case 'use':
      return useItem(life, sim, c.item);
    case 'buy':
      if (nearNpc(life, sim, c.npc)) buy(life, c.npc, c.item, c.n);
      return;
    case 'sell':
      if (nearNpc(life, sim, c.npc)) sell(life, c.npc, c.item, c.n);
      return;
    case 'buyback':
      if (nearNpc(life, sim, c.npc)) buyBack(life, c.npc, c.item, c.n);
      return;
    case 'craft': {
      // You have to be at the bench, or with the crafter, to use their recipes.
      const r = recipeById(c.recipe);
      if (!r) return;
      const bench = life.zone.recipe.workbenches.find((b) => b.id === r.bench);
      const near = bench ? Math.hypot(bench.x - p.pos.x, bench.z - p.pos.z) <= 6 : nearNpc(life, sim, r.bench);
      if (!near) {
        life.toast('Too far from the workbench', 'bad');
        return;
      }
      runRecipe(life, sim, c.recipe);
      return;
    }
    case 'accept':
      accept(life, c.quest);
      return;
    case 'contract': {
      const k = life.state.contracts?.offered.find((x) => x.id === c.id);
      const post = k ? life.zone.recipe.outposts.find((o) => o.id === k.outpost) : undefined;
      if (post && nearNpc(life, sim, post.npc)) acceptContract(life, c.id);
      return;
    }
    case 'complete':
      complete(life, c.quest);
      return;
    case 'abandon':
      abandon(life, c.quest);
      return;
    case 'summon':
      summon(life, sim, c.item);
      return;
    case 'recall':
      if (recall(life, sim, c.vehicle)) life.toast('Sent home', 'info');
      return;
    case 'cancelPlace':
      life.placing = null;
      return;
    case 'store':
    case 'take': {
      // Only a real count moves anything: a negative one would make items out of nothing.
      if (!(c.n > 0)) return;
      const h = life.state.houses.find((x) => x.id === c.house);
      if (!h || !isComplete(h)) return;
      const bp = blueprintDef(h.blueprint);
      if (c.t === 'store') {
        const n = Math.min(c.n, life.count(c.item));
        const slots = new Set(h.storage.map((s) => s.item));
        if (!n || (!slots.has(c.item) && slots.size >= bp.perks.storageSlots)) return;
        life.take(c.item, n);
        const s = h.storage.find((x) => x.item === c.item);
        if (s) s.n += n;
        else h.storage.push({ item: c.item, n });
      } else {
        const s = h.storage.find((x) => x.item === c.item);
        if (!s) return;
        const n = Math.min(c.n, s.n);
        const left = life.give(c.item, n, true);
        s.n -= n - left;
        if (s.n <= 0) h.storage = h.storage.filter((x) => x !== s);
      }
      life.revision++;
      return;
    }
    case 'payTax': {
      const h = life.state.houses.find((x) => x.id === c.house);
      if (h) payTax(life, h);
      return;
    }
    case 'rest':
      life.resting = true;
      return;
    case 'grant':
      if (c.item) life.give(c.item, c.n ?? 1);
      if (c.coins) life.state.coins += c.coins;
      if (c.seals) life.state.seals += c.seals;
      if (c.labor) life.state.labor = Math.min(1000, life.state.labor + c.labor);
      return;
    case 'warp':
      life.state.clock += c.seconds;
      growFor(life, c.seconds);
      recoverDemand(life, c.seconds);
      life.regenLabor(c.seconds);
      return;
    case 'ride':
      // Someone else's vehicle is never on your island: online the channel seats you
      // (server/src/world_game.rs), and alone there is nobody to ride with.
      return;
  }
}

function useItem(life: Life, sim: Sim, item: string): void {
  if (life.count(item) < 1) return;
  const def = itemDef(item);
  switch (def.cat) {
    case 'seed':
      life.state.seed = item;
      life.toast(`F plants ${def.name} now`, 'info');
      return;
    case 'placeable':
      if (def.places === 'scarecrow') {
        life.placing = { item, x: 0, z: 0, rot: 0, problem: null };
        life.toast('Walk to open, level ground and press F to place. Esc cancels.', 'info');
      } else if (def.places === 'cog') life.toast('Take it to the Lanternwick slipway beside the shipwright and press F there', 'info');
      else life.toast('Take it to an empty plot at Hearthside Rise and press F there', 'info');
      return;
    case 'glider':
      life.state.glider = def.glider!;
      sim.player.glider = def.glider!;
      life.toast(`${def.name} equipped`, 'good');
      return;
    case 'deed':
    case 'mount':
      if (def.cat === 'mount') return mountCommand(life, sim);
      summon(life, sim, item);
      return;
    case 'consumable':
      if (def.use?.labor) {
        life.take(item, 1);
        life.state.labor = Math.min(1000, life.state.labor + def.use.labor);
        life.toast(`+${def.use.labor} labor`, 'good');
      }
      return;
    default:
      return;
  }
}

function interact(life: Life, sim: Sim): void {
  // Worked out afresh: the press acts on what is in front of you now, not a frame ago.
  const f = findFocus(life, sim);
  life.focus = f;
  if (!f) return;
  if (!f.ok && f.action !== 'info') return;
  const p = sim.player;
  switch (f.action) {
    case 'talk':
      life.notify({ type: 'talk', npc: f.npc });
      life.emit({ t: 'open', ui: 'dialog', id: f.npc! });
      return;
    case 'sell':
      sellPack(life, sim, outpostOf(life, f.npc!)!.id);
      return;
    case 'craft':
      life.emit({ t: 'open', ui: 'craft', id: f.bench! });
      return;
    case 'pickup': {
      const pk = life.state.packs.find((x) => x.id === f.pack);
      if (pk) pickUp(life, sim, pk);
      return;
    }
    case 'board': {
      const v = life.state.vehicles.find((x) => x.id === f.vehicle);
      if (v) board(life, sim, v);
      return;
    }
    case 'load': {
      const v = life.state.vehicles.find((x) => x.id === f.vehicle);
      if (v) loadPack(life, sim, v, f.slot!);
      return;
    }
    case 'unload': {
      const v = life.state.vehicles.find((x) => x.id === f.vehicle);
      if (v) unloadPack(life, sim, v, f.slot!);
      return;
    }
    case 'exit':
      dismount(life, sim);
      return;
    case 'plant': {
      const sc = life.state.scarecrows.find((s) => s.id === f.sc);
      const seed = life.state.seed && life.count(life.state.seed) > 0 ? life.state.seed : life.state.bag.find((s) => itemDef(s.item).cat === 'seed')?.item;
      if (sc && seed) {
        life.state.seed = seed;
        if (itemDef(seed).raises) raise(life, sc, f.cell!, seed);
        else plant(life, sc, f.cell!, seed);
      }
      return;
    }
    case 'feed': {
      const pl = life.state.scarecrows.find((s) => s.id === f.sc)?.cells[f.cell!];
      if (pl?.animal) feed(life, pl);
      return;
    }
    case 'collect': {
      const sc = life.state.scarecrows.find((s) => s.id === f.sc);
      if (sc) collect(life, sc, f.cell!, f.x, f.y, f.z);
      return;
    }
    case 'water': {
      const pl = life.state.scarecrows.find((s) => s.id === f.sc)?.cells[f.cell!];
      if (pl) water(life, pl);
      return;
    }
    case 'harvest': {
      const sc = life.state.scarecrows.find((s) => s.id === f.sc);
      if (sc) harvest(life, sc, f.cell!, f.y);
      return;
    }
    case 'fell': {
      const sc = life.state.scarecrows.find((s) => s.id === f.sc);
      if (sc) fell(life, sc, f.cell!, f.y);
      return;
    }
    case 'gather': {
      const nd = life.zone.recipe.nodes[f.node!];
      const y = NODE_YIELD[nd.kind];
      if (!y || !nodeReady(life, f.node!)) return;
      if (!life.hasRoom(y.item, y.n[1])) {
        life.toast('Your bag is full', 'bad');
        return;
      }
      if (!life.afford({ labor: y.labor }, y.verb.toLowerCase())) return;
      const n = life.randInt(y.n[0], y.n[1]);
      life.give(y.item, n);
      if (y.rare && life.rand() < y.rare.chance) {
        life.give(y.rare.item, 1);
        life.toast('⚡ A thunderstruck log!', 'coin');
        life.emit({ t: 'thunder', x: nd.x, y: f.y, z: nd.z });
      }
      life.state.nodes[f.node!] = life.state.clock + y.respawn;
      life.revision++;
      life.emit({ t: 'gather', x: nd.x, y: f.y, z: nd.z, kind: y.kind });
      // A step like "quarry 10 stone" counts the stone, not the swings.
      life.notify({ type: 'gather', kind: y.kind, amount: n });
      return;
    }
    case 'claim': {
      const bp = life.state.bag.find((s) => s.item.startsWith('blueprint.'));
      if (bp) placeHouse(life, sim, f.plot!, bp.item);
      return;
    }
    case 'deliver': {
      const h = life.state.houses.find((x) => x.id === f.house);
      if (h) deliverMaterial(life, sim, h);
      return;
    }
    case 'build': {
      const h = life.state.houses.find((x) => x.id === f.house);
      if (h) buildStage(life, sim, h);
      return;
    }
    case 'rest': {
      const h = life.state.houses.find((x) => x.id === f.house);
      if (!h) return;
      const bed = interiorPoint(life, h, 'bed');
      life.resting = true;
      life.state.home = { x: bed.x, z: bed.z };
      p.vel.x = p.vel.z = 0;
      life.toast('You settle in. Labor recovers 3× faster while you rest - move to get up.', 'info');
      return;
    }
    case 'storage':
      life.emit({ t: 'open', ui: 'storage', id: String(f.house) });
      return;
    case 'tax': {
      const h = life.state.houses.find((x) => x.id === f.house);
      if (h) payTax(life, h);
      return;
    }
    case 'placeScarecrow': {
      const pl = life.placing;
      if (!pl || pl.problem) return;
      if (!life.take(pl.item, 1)) {
        life.placing = null;
        return;
      }
      addScarecrow(life, sim, pl.x, pl.z, pl.rot);
      life.placing = null;
      life.toast('🧑‍🌾 Plot claimed. Walk onto the soil and press F to plant.', 'good');
      life.notify({ type: 'placeScarecrow' });
      return;
    }
    case 'keel': {
      const design = designItemsInBag(life)[0];
      if (design) layKeel(life, f.slip!, design);
      return;
    }
    case 'shipDeliver': {
      const b = shipOn(life, f.slip!);
      if (b) deliverShipMaterial(life, sim, b);
      return;
    }
    case 'shipBuild': {
      const b = shipOn(life, f.slip!);
      if (b) buildShipStage(life, b);
      return;
    }
    case 'launch': {
      const b = shipOn(life, f.slip!);
      if (b) launch(life, b);
      return;
    }
    case 'info':
      return;
  }
}

/** Every step: resting ends as soon as you move. */
export function keepResting(life: Life, sim: Sim): void {
  if (!life.resting) return;
  const p = sim.player;
  if (Math.hypot(p.vel.x, p.vel.z) > 0.6 || p.mode !== 'normal') life.resting = false;
}
