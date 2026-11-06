import { fighterSpecies } from './builtin/fighter';
import { heroSpecies } from './builtin/hero';
import { slimeSpecies } from './builtin/slime';
import { quadrupedSpecies } from './builtin/quadruped';
import { CREATURE_BODIES } from '../creatures';
import { validateSpecies, type SpeciesDef } from './types';

// Everything the world can spawn, by id. Built-ins are authored in code, and so are the bodies of
// creatures with folders of their own (src/creatures/); imported species register themselves once
// their asset has loaded, which keeps the asset pipeline out of the renderer's way.

type Factory = () => SpeciesDef;

const factories = new Map<string, Factory>([
  ['fighter', fighterSpecies],
  ['hero', heroSpecies],
  ['slime', slimeSpecies],
  ['quadruped', quadrupedSpecies],
  ...CREATURE_BODIES,
]);
const cache = new Map<string, SpeciesDef>();

export function getSpecies(id: string): SpeciesDef {
  const hit = cache.get(id);
  if (hit) return hit;
  const make = factories.get(id);
  if (!make) throw new Error(`unknown species "${id}"; known: ${[...factories.keys()].join(', ')}`);
  const species = make();
  const problems = validateSpecies(species);
  if (problems.length) throw new Error(`species "${id}" is malformed: ${problems.join('; ')}`);
  cache.set(id, species);
  return species;
}

export const speciesIds = (): string[] => [...factories.keys()].sort();
