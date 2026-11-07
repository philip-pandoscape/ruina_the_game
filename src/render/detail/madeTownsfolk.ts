import * as THREE from 'three';
import { pose } from '../../content/pose';
import { clamp } from '../../util/math';
import { Body } from './body';
import { gripHands, wear, type Grip } from './fit';
import { poseHumanoid } from './humanoid';
import type { WornBody } from './madeBody';
import { DetailRig } from './rig';

// A townsperson in a made body (madeBody.ts): the hero's rig, measured to their body, standing as
// the hero stands at rest with nothing in hand (the hero's own poses, humanoid.ts), and on top of
// that the townsfolk's own life, as the box townsfolk have it (src/render/models/villagers.ts): a
// sway, looking about, now and then a gesture, and talking with their hands while you talk to them.

/** What of a townsperson's look moves their made body. */
export interface TownsfolkStance {
  /** A forward stoop of the upper body (radians). */
  hunch?: number;
  /** The arms free to gesture (both, if it doesn't say). */
  free?: Array<'l' | 'r'>;
  /**
   * How an arm that isn't free rests, turned from hanging (radians about x, y and z in the arm's own
   * frame, as the built townsfolk's arms take them: -x forward, z out to the left), to hold a prop.
   */
  rest?: { l?: [number, number, number]; r?: [number, number, number] };
  /** The hands holding something, closed round it. */
  holds?: Array<'l' | 'r'>;
}

export interface MadeTownsperson {
  root: THREE.Group;
  /** The rig they wear, for what measures them. */
  rig: DetailRig;
  /** How high their face is above their feet, metres (where a portrait looks). */
  face: number;
  /** Poses them at `time` seconds (theirs: offset as they like), easing into talking and out of it. */
  animate(dt: number, s: { time: number; talking: boolean }): void;
}

const ease = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** 1 between a and b, easing in and out over e either side. */
const inside = (v: number, a: number, b: number, e: number) => ease(a - e, a, v) * (1 - ease(b, b + e, v));

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
/** Turns a posed joint a little further, in its own frame (x pitches forward, y turns left, z rolls out to the left). */
function turn(rig: DetailRig, joint: string, x: number, y: number, z: number): void {
  if (rig.has(joint)) rig.joint(joint).quaternion.multiply(_q.setFromEuler(_e.set(x, y, z)));
}

const _tq = new THREE.Quaternion();
const _hand = new THREE.Vector3();
const _at = new THREE.Vector3();
const _pole = new THREE.Vector3();
/** The body's pose buffers these use (the hero's poses use the low ones). */
const HANG = 20;
const REACH = 21;

/** Hands loosely curled, as the hero's are standing, or closed round what they hold. */
const RELAXED = 0.18;
const HOLDING = 0.85;

/** Dresses the hero's rig in a made body and brings it to life as a townsperson. */
export function wearTownsperson(body: WornBody, stance: TownsfolkStance = {}): MadeTownsperson {
  const rig = new DetailRig(body.def);
  const mesh = wear(rig, body.fitted);
  rig.root.name = 'madeTownsperson';
  // Standing where they are, never far from the pose they were made in: culled by its bounds, a
  // little grown for the hands they talk with (the hero, who leaps and swings, is never culled).
  const bounds = body.fitted.geometry.boundingSphere;
  if (bounds) {
    mesh.boundingSphere = bounds.clone();
    mesh.boundingSphere.radius *= 1.15;
    mesh.frustumCulled = true;
  }
  const top = body.fitted.geometry.boundingBox?.max.y ?? 1.78;
  // How big they are beside the hero, for where their hands go.
  const size = top / 1.78;
  const b = Body.of(rig);
  // At rest, with whatever the hero carries put away (it never shows: the rig's weapons stay hidden).
  const input = pose({ stow: 1 });
  const free = new Set(stance.free ?? ['l', 'r']);
  const hunch = stance.hunch ?? 0;
  const holds = new Set(stance.holds ?? []);
  const grips: Record<'L' | 'R', Grip> = {
    L: { amount: holds.has('l') ? HOLDING : RELAXED },
    R: { amount: holds.has('r') ? HOLDING : RELAXED },
  };
  let talk = 0;
  return {
    root: rig.root,
    rig,
    face: top - 0.13,
    animate(dt, s) {
      const t = s.time;
      talk += ((s.talking ? 1 : 0) - talk) * Math.min(1, dt * 3);
      input.time = t;
      poseHumanoid(rig, input);
      // The upper body: a stoop if they have one, a slow sway, and leaning into what they say.
      turn(rig, 'torso', hunch + talk * 0.03 * Math.sin(t * 1.3), 0, Math.sin(t * 0.45) * 0.012 + talk * Math.sin(t * 1.9) * 0.025);
      // Looking about, less while talking (at you), nodding along as they talk; the neck takes a
      // part of each turn and the head the rest.
      const look = (Math.sin(t * 0.31) * 0.42 + Math.sin(t * 0.73) * 0.14) * (1 - talk * 0.75);
      const nod = -hunch * 0.6 + Math.sin(t * 0.9) * 0.025 + talk * (0.07 * Math.sin(t * 6.3) - 0.04);
      const tilt = Math.sin(t * 0.53) * 0.04 * (1 - talk) + talk * 0.05 * Math.sin(t * 1.1);
      turn(rig, 'neck', nod * 0.4, look * 0.4, tilt * 0.4);
      turn(rig, 'head', nod * 0.6, look * 0.6, tilt * 0.6);
      // Now and then a hand comes up as if to make a point; talking, both do, forearms raised: each
      // hand reaches for a point before the belly (the torso's own frame, so a stoop takes it with
      // it), elbows down and out, and the arm goes there from hanging as far as the gesture is on.
      const idle = inside(t % 9, 6.2, 7.4, 0.5);
      for (const [side, phase] of [
        ['L', 0],
        ['R', 2.1],
      ] as const) {
        const k = side === 'L' ? 1 : -1;
        if (!free.has(side === 'L' ? 'l' : 'r')) {
          const r = stance.rest?.[side === 'L' ? 'l' : 'r'];
          turn(rig, `arm${side}`, (r?.[0] ?? 0) + Math.sin(t * 1.7) * 0.015, r?.[1] ?? 0, r?.[2] ?? 0);
          continue;
        }
        const on = Math.max(idle * (side === 'L' ? 0.3 : 0.4), talk * (0.75 + 0.25 * Math.sin(t * 2.3 + phase)));
        if (on < 0.01) continue;
        const hang = b.save(b.buf(HANG));
        b.quaternionOf(b.torso, _tq);
        b.toModel(
          b.torso,
          _hand.set(
            k * (0.17 + 0.04 * Math.sin(t * 1.7 + phase)),
            (0.1 + 0.07 * Math.sin(t * 2.3 + phase)) * size,
            (0.3 + 0.04 * Math.sin(t * 1.1 + phase)) * size,
          ),
          _at,
        );
        b.handTo(
          side,
          _at,
          _pole
            .set(k * 0.55, -0.6, -0.5)
            .normalize()
            .applyQuaternion(_tq),
        );
        b.mix(hang, b.save(b.buf(REACH)), on);
      }
      gripHands(rig, body.fitted.fist, grips);
    },
  };
}
