// Every kind of thing the bible has an entry for, in the order the contents list them: the world's
// kinds (the island, its places, people, creatures...) and then the things in it.

import type { KindDef } from '../kit';
import { abilities, movement, skills, weapons } from './combat';
import { animals, crops, gathering } from './farm';
import { items, recipes, vendors, workbenches } from './items';
import { blueprints, buildings, minigames, quests } from './places';
import { gliders, mounts, ships, vehicles } from './rides';
import { packs } from './trade';
import { creatures, dungeons, npcs, places, regions } from './world';

export const KINDS: ReadonlyArray<KindDef<any>> = [
  regions,
  places,
  npcs,
  creatures,
  buildings,
  workbenches,
  gathering,
  dungeons,
  items,
  recipes,
  vendors,
  packs,
  crops,
  animals,
  weapons,
  abilities,
  movement,
  skills,
  vehicles,
  mounts,
  gliders,
  ships,
  blueprints,
  quests,
  minigames,
];
