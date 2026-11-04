import data from '../../shared/traversal.json' with { type: 'json' };

// Open-world movement numbers: slopes, wading, swimming, gliding, and how the camera follows a
// vehicle. See shared/traversal.json for what each one means.

export const GROUND = data.ground;
export const SWIM = data.swim;
export const GLIDE = data.glide;
export const RIDE_CAMERA = data.camera;
export const STORM = data.storm as { fromDepth: number; fullDepth: number; hullDamage: Array<[number, number]>; buffet: number; repairSeconds: number };
