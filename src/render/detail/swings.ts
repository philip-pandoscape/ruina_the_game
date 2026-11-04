import type { SlashDef } from '../vfx';

// The shape of each weapon's swing: yaw a (0 = straight ahead, + = to the left) and pitch p
// (-pi/2 = arm horizontal, -pi = straight up). The arm follows this path and so does the trail,
// which is why they are described in one place. Swings go diagonally so they read from a camera
// sitting behind the player.

export type { SlashDef };

export const SLASHES: SlashDef[] = [
  { a0: -1.6, a1: 1.2, p0: -2.0, p1: -1.15, color: 0x6fd3ff, core: 0xffffff }, // high right -> low left
  { a0: 1.2, a1: -1.5, p0: -1.2, p1: -2.0, color: 0x6fd3ff, core: 0xffffff }, // rising backhand
  { a0: -0.9, a1: 0.5, p0: -3.2, p1: -0.75, color: 0xffb627, core: 0xfff4d6 }, // overhead finisher
];
export const CLUB_SWINGS: SlashDef[] = [
  { a0: -1.4, a1: 1.1, p0: -1.9, p1: -1.2, color: 0xffa94d, core: 0xfff1d6 }, // wide swing
  { a0: -0.3, a1: 0.2, p0: -3.3, p1: -0.6, color: 0xff8c42, core: 0xfff1d6 }, // overhead smash
];
export const STAFF_SWINGS: SlashDef[] = [{ a0: -0.5, a1: 0.35, p0: -1.75, p1: -1.4, color: 0xb48cff, core: 0xffffff }];
/** Whirlwind: the arm stays out to the side while the whole body turns a full circle. */
export const SPIN: SlashDef = { a0: -1.4, a1: -1.4 - Math.PI * 2, p0: -1.55, p1: -1.55, color: 0xffb627, core: 0xfff4d6 };
