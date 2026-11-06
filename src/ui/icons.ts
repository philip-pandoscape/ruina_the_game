// Icons and names for weapons and abilities, from their data (shared/tuning.json).
import { ABILITIES, WEAPONS } from '../content/tuning';

export const WEAPON_ICONS = WEAPONS.map((w) => w.icon);
export const WEAPON_NAMES = WEAPONS.map((w) => w.title);
export const ABILITY_ICONS = ABILITIES.map((a) => a.icon);
