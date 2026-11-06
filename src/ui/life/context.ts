import type * as THREE from 'three';
import type { Vitals } from '../hud';
import type { Command, Life } from '../../engine/island';
import type { Sim, World } from '../../engine/rules';
import type { Goal } from './hud/goal';
import type { TravelUI } from './travelUI';

// What the island's HUD widgets (hud/) and windows (windows/) see of the UI that holds them,
// LifeUI (lifeUI.ts): the life state and the rules to read, what the app set on it, and its
// windows, to open another, draw the open one again or close them.

/** The window the main frame shows, and what in it. */
export type Panel =
  | { kind: 'dialog'; id: string; quest?: string; trade?: boolean }
  | { kind: 'shop'; id: string; tab: ShopTab }
  | { kind: 'craft'; id: string }
  | { kind: 'storage'; id: string }
  | { kind: 'map' | 'garage' | 'dev' | 'admin' | 'log' | 'character' | 'settings' };

export type ShopTab = 'buy' | 'sell' | 'buyback';

/** What the app sets on LifeUI (its public hooks, lifeUI.ts says what each is), read when wanted. */
export interface AppHooks {
  portraitOf: (who: string) => string | null;
  playerName: string;
  skyHour: (() => number) | null;
  others: () => Array<{ name: string; online: boolean; x: number; z: number }>;
  onTeleport: ((x: number, z: number, facing?: number) => void) | null;
  onReset: (() => void) | null;
  onExitToSelect: (() => void) | null;
  onBugReport: (() => void) | null;
  bugKey: () => string;
  onEnterZone: ((id: string) => void) | null;
}

export interface IslandUI {
  readonly life: Life;
  /** Gives the island a command, through the app (never `life.command` directly). */
  command(c: Command): void;
  readonly sim: Sim;
  readonly world: World;
  readonly app: AppHooks;
  camera(): THREE.Camera;
  /** Which way the camera looks. */
  yaw(): number;
  device(): 'keyboard' | 'gamepad';
  /** Travel by road (src/ui/life/travelUI.ts), where there is auto-walking. */
  travel(): TravelUI | null;
  /** The window open in the main frame. */
  panel(): Panel | null;
  /** The open window takes the keyboard and mouse (the map). */
  modal(): boolean;
  /** The NPC whose dialog, shop or workshop is open. */
  talkingTo(): string | null;
  /** Your health, MP and stamina, as the app last said. */
  vitals(): Vitals | null;
  /** Where the quest you're on leads you. */
  goal(): Goal | null;
  /** Opens a window in the main frame (another one, or another page of the open one). */
  open(p: Panel): void;
  /** Draws the open window again, now. */
  redraw(): void;
  /** Closes the window (`all`: every window) once something clicked in it is under way. */
  finish(all?: boolean): void;
  closeAll(): void;
  /** Whoever looks out of a window's medallion ('player' or an NPC). */
  face(id: string): string;
}
