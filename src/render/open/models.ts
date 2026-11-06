// The procedural model library (src/render/models), the island's buildings, props, crops, packs,
// animals, townsfolk and everything you ride: loaded on its own from the start (main.ts), while
// you sign in and choose a character, and handed to what draws the island once it has come.

export type ModelKit = typeof import('../models');

export const loadModels = (): Promise<ModelKit> => import('../models');
