import data from '../../shared/creatures.json' with { type: 'json' };

// Every creature with a folder of its own (content/creatures/, built into shared/creatures.json): its
// kinds, brains and attacks, all data for the shared engine parts (design/goblins.md). The server
// reads the same bundle (crates/engine/src/creatures.rs). A kind travels on the wire as its index,
// after those in shared/actors.json, the same on both sides as they read the same bundles.

export interface CreatureFile {
  id: string;
  kinds?: unknown[];
  behaviours?: unknown[];
  attacks?: unknown[];
}

export const CREATURES: readonly CreatureFile[] = data.creatures as CreatureFile[];
