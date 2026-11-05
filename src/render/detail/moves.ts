import type { ClipPart } from './retarget';

// What the made hero's moves play, move by move: its own keyframed swing (swings.ts, code), or a
// clip from an animation library retargeted onto it (retarget.ts) - Meshy's (made on the hero's own
// skeleton: src/render/assets/models/hero_moves_meshy.glb) or Quaternius' (hero_swings.glb). Each
// weapon plays one set; ?swordMoves=keyed|meshy|quaternius (and clubMoves=...) tries another.
// AGENTS.md says how to bring in a new clip (the retarget-animation skill).

/** A combo hit from a clip: the clip (or clips, end to end) in a file, and which of its strikes. */
export interface MoveClip {
  file: string;
  parts: ClipPart[];
  /** How many strikes the clip holds (a combo in one clip), and which one this hit plays. */
  strikes?: number;
  strike?: number;
}

/** Per weapon, its sets of combo hits: each hit a clip, or null to keep its keyframed swing. */
export const HERO_MOVES: Record<string, Record<string, Array<MoveClip | null>>> = {
  sword: {
    meshy: [0, 1, 2].map((strike) => ({ file: 'hero_moves_meshy', parts: [{ clip: 'Triple_Combo_Attack' }], strikes: 3, strike })),
    quaternius: [
      { file: 'hero_swings', parts: [{ clip: 'Sword_Regular_A' }, { clip: 'Sword_Regular_A_Rec' }] },
      { file: 'hero_swings', parts: [{ clip: 'Sword_Regular_B' }, { clip: 'Sword_Regular_B_Rec' }] },
      { file: 'hero_swings', parts: [{ clip: 'Sword_Regular_C' }] },
    ],
  },
  club: {
    quaternius: [
      { file: 'hero_swings', parts: [{ clip: 'Sword_Heavy_Combo', to: 0.92 }] },
      { file: 'hero_swings', parts: [{ clip: 'Sword_Heavy_Combo', from: 2.25 }] },
    ],
  },
};

/** The set each weapon plays (absent: keyframed). Weapons as the rules number them. */
export const HERO_MOVE_SETS: Record<string, string> = { sword: 'quaternius', club: 'quaternius' };
export const WEAPON_KEYS = ['sword', 'club', 'staff', 'bow'] as const;
