import type { SpeciesDef } from '../species/types';
import { goblinSpecies } from './goblin/body';

// The browser's side of every creature with a folder of its own (src/creatures/<name>/): its body,
// by species id. Its rules are data in shared/creatures/<name>.json, run by the shared engine
// parts (design/goblins.md); src/species/registry.ts adds these bodies to its own, so a creature's
// kinds can name them.

export const CREATURE_BODIES: ReadonlyArray<readonly [string, () => SpeciesDef]> = [['goblin', goblinSpecies]];
