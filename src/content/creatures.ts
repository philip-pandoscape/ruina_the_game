import goblin from '../../shared/creatures/goblin.json' with { type: 'json' };

// Every creature with a file of its own in shared/creatures/: its kinds, brains and attacks, all
// data for the shared engine parts (design/goblins.md). The server lists the same files in the
// same order (server/src/creatures.rs). A kind travels on the wire as its index, after those in
// shared/actors.json, so a new creature goes on the end.

export interface CreatureFile {
  kinds?: unknown[];
  behaviours?: unknown[];
  attacks?: unknown[];
}

export const CREATURES: readonly CreatureFile[] = [goblin as CreatureFile];
