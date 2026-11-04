import { HERO_CLIPS, HERO_RIG, HERO_SLOTS } from '../../content/creatures/hero';
import { poseHumanoid } from '../../render/detail/humanoid';
import { speciesFromRig } from '../fromRig';
import type { SpeciesDef } from '../types';

// The player character at crowd range. Nothing here describes how a hero moves - it bakes the
// close-up poses, so the two can never drift.

let cached: SpeciesDef | null = null;

export function heroSpecies(): SpeciesDef {
  cached ??= speciesFromRig({
    id: 'hero',
    rig: HERO_RIG,
    pose: poseHumanoid,
    clips: HERO_CLIPS,
    weapon: 'sword',
    slots: HERO_SLOTS,
  });
  return cached;
}
