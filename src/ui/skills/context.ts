import type { Build } from '../../content/tuning';
import type { Levels } from '../../content/skills';
import { esc } from '../../util/html';

/** What the skill book and tree need from the game around them. */
export interface SkillsContext {
  build(): Build;
  /** A new build: learned, unlearned, slotted or equipped. `note` says what happened. */
  change(b: Build, note: string): void;
  /** How many points you may have in the tree here. */
  budget(): number;
  /** Where those points come from, for the tree's header. */
  budgetNote(): string;
  /** Experience of each skill in the book, by its id. */
  xp(): Readonly<Record<string, number>>;
  levels(): Levels;
  /** Your face, for the middle of the tree (null until a portrait has been taken). */
  portrait(): string | null;
  /** The device you're playing with, for the key hints. */
  device(): 'keyboard' | 'gamepad';
}

export { esc };
