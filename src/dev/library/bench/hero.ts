import * as THREE from 'three';
import { traceSwing } from '../../../render/character';
import { HERO_BOW, HERO_TRAIL_EDGES } from '../../../render/creatures/heroBody';
import { weaponId, weaponIndex } from '../../../content/tuning';
import { gliderGrip } from '../../../render/models/gliders';
import { SCENARIOS, scenario } from '../../../render/detail/scenarios';
import { Film } from '../subjects/film';

// The hero's films (src/render/detail/scenarios.ts) measured rather than eyeballed: each played
// through the real close-up hero (poses, easing between states, feet held where they're planted)
// from its first frame, and where everything went reported, frame by frame. No drawing, so it runs
// anywhere: in Node on the box hero (tests/unit/animation.test.ts), and in the content library on
// whichever body the hero wears there, as window.__library.measure.

/** Every film, with its group and length. */
export const list = () => SCENARIOS.map((s) => ({ id: s.id, group: s.group, label: s.label, frames: s.frames }));

/** Root-space position of every joint of the hero on a frame of a film. */
export function joints(id: string, frame: number, weaponOverride?: number) {
  const t = new Film(scenario(id), weaponOverride);
  t.seek(frame);
  const rig = t.hero.detail;
  t.hero.root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(t.hero.root.matrixWorld).invert();
  const out: Record<string, number[]> = {};
  for (const j of rig.def.joints) {
    const p = new THREE.Vector3().setFromMatrixPosition(rig.joint(j.name).matrixWorld).applyMatrix4(inv);
    out[j.name] = [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)];
  }
  t.dispose();
  return { joints: out, speed: t.last?.speed ?? 0, lift: t.last?.lift ?? 0 };
}

export interface TrackRow {
  frame: number;
  travelled: [number, number];
  facing: number;
  lift: number;
  /** On its feet: on the ground and not rolling or sliding, when planted feet must hold. */
  standing: boolean;
  flip: number;
  action: number;
  stun: number;
  /** The swing's frame (-1 when not swinging), and whether it is a jump attack. */
  attack: number;
  airSwing: boolean;
  joints: Record<string, number[]>;
}

/**
 * Every frame of a film: joints in root space plus how far the floor has moved. A name may be a
 * point in a joint's own space: 'footL@0,-0.08,0.17' is the ball of the left foot.
 */
export function track(id: string, names: string[], weaponOverride?: number): TrackRow[] {
  const t = new Film(scenario(id), weaponOverride);
  const rig = t.hero.detail;
  const out: TrackRow[] = [];
  const inv = new THREE.Matrix4();
  for (let f = 0; f < t.s.frames; f++) {
    t.step();
    t.hero.root.updateMatrixWorld(true);
    inv.copy(t.hero.root.matrixWorld).invert();
    const js: Record<string, number[]> = {};
    for (const n of names) {
      const [joint, at] = n.split('@');
      const local = at ? new THREE.Vector3(...at.split(',').map(Number)) : new THREE.Vector3();
      const p = local.applyMatrix4(rig.joint(joint).matrixWorld).applyMatrix4(inv);
      js[n] = [p.x, p.y, p.z];
    }
    const standing = t.input.grounded && t.input.actionId < 0 && !t.input.travel && !t.input.down;
    out.push({
      frame: f,
      travelled: [t.travelled[0], t.travelled[1]],
      facing: t.facing,
      lift: t.last?.lift ?? 0,
      standing,
      flip: t.input.flipFrame,
      action: t.input.actionId >= 0 ? t.input.actionFrame : -1,
      attack: t.input.attackIndex >= 0 ? t.input.attackFrame : -1,
      airSwing: t.input.airSwing,
      stun: t.input.stunned ? t.input.stunFrame : -1,
      joints: js,
    });
  }
  t.dispose();
  return out;
}

/**
 * Lowest point of the body over a film, and of what it carries, for "never in the floor": metres
 * above the ground, and the frame it happened on.
 */
export function lowest(id: string, weaponOverride?: number) {
  const t = new Film(scenario(id), weaponOverride);
  const rig = t.hero.detail;
  const out = { body: { low: Infinity, frame: -1 }, weapon: { low: Infinity, frame: -1 } };
  const box = new THREE.Box3();
  const corner = new THREE.Vector3();
  const e = new THREE.Matrix4();
  for (let f = 0; f < t.s.frames; f++) {
    t.step();
    t.hero.root.updateMatrixWorld(true);
    const ground = t.hero.root.position.y - (t.last?.lift ?? 0);
    // The body: each rounded box and ball exactly, from the rig's own part list.
    let low = Infinity;
    for (const part of rig.def.parts) {
      const m = e.copy(rig.joint(part.joint).matrixWorld).elements;
      const [px, py, pz] = part.pos ?? [0, 0, 0];
      const cy = m[1] * px + m[5] * py + m[9] * pz + m[13];
      const sh = part.shape;
      if (sh.kind === 'box') {
        const r = Math.min(sh.r ?? 0.05, sh.w / 2, sh.h / 2, sh.d / 2);
        low = Math.min(low, cy - (Math.abs(m[1]) * (sh.w / 2 - r) + Math.abs(m[5]) * (sh.h / 2 - r) + Math.abs(m[9]) * (sh.d / 2 - r)) - r);
      } else if (sh.kind === 'sphere') low = Math.min(low, cy - sh.r);
    }
    if (low - ground < out.body.low) {
      out.body.low = +(low - ground).toFixed(4);
      out.body.frame = f;
    }
    // What it carries: the corners of each piece's box (a touch generous for round things).
    for (const b of rig.built) {
      if (b.mesh.parent === rig.joint(b.joint)) continue;
      let shown = true;
      for (let n: THREE.Object3D | null = b.mesh; n; n = n.parent) if (!n.visible) shown = false;
      if (!shown) continue;
      b.mesh.geometry.computeBoundingBox();
      box.copy(b.mesh.geometry.boundingBox!);
      for (let c = 0; c < 8; c++) {
        corner.set(c & 1 ? box.max.x : box.min.x, c & 2 ? box.max.y : box.min.y, c & 4 ? box.max.z : box.min.z).applyMatrix4(b.mesh.matrixWorld);
        if (corner.y - ground < out.weapon.low) {
          out.weapon.low = +(corner.y - ground).toFixed(4);
          out.weapon.frame = f;
        }
      }
    }
  }
  t.dispose();
  return out;
}

/** Every frame's knee and elbow hinge angles: knees fold +, elbows fold -. */
export function hinges(id: string) {
  const t = new Film(scenario(id));
  const b = t.hero.detail;
  const out = { knee: [Infinity, -Infinity], elbow: [Infinity, -Infinity] };
  for (let f = 0; f < t.s.frames; f++) {
    t.step();
    for (const n of ['kneeL', 'kneeR']) {
      const x = new THREE.Euler().setFromQuaternion(b.joint(n).quaternion).x;
      out.knee = [Math.min(out.knee[0], x), Math.max(out.knee[1], x)];
    }
    for (const n of ['elbowL', 'elbowR']) {
      const x = new THREE.Euler().setFromQuaternion(b.joint(n).quaternion).x;
      out.elbow = [Math.min(out.elbow[0], x), Math.max(out.elbow[1], x)];
    }
  }
  t.dispose();
  return out;
}

/** How far the trail's leading edge is from the blade's tip, at worst, while a trail shows. */
export function trailGap(id: string) {
  const t = new Film(scenario(id));
  const rig = t.hero.detail;
  let worst = 0;
  let shown = 0;
  const inv = new THREE.Matrix4();
  for (let f = 0; f < t.s.frames; f++) {
    t.step();
    const tr = t.fb?.trail;
    const i = t.input;
    if (!tr || !i.step || tr.head >= 1) continue;
    const edges = traceSwing(i);
    const edge = HERO_TRAIL_EDGES[weaponId(i.weapon)];
    if (!edges || !edge) continue;
    t.hero.root.updateMatrixWorld(true);
    inv.copy(t.hero.root.matrixWorld).invert();
    const tip = new THREE.Vector3(...edge.outer).applyMatrix4(rig.joint('handR').matrixWorld).applyMatrix4(inv);
    const at = tr.head * (edges.length - 1);
    const k = Math.min(edges.length - 2, Math.floor(at));
    const on = new THREE.Vector3().lerpVectors(edges[k][1], edges[k + 1][1], at - k);
    worst = Math.max(worst, tip.distanceTo(on));
    shown++;
  }
  t.dispose();
  return { worst: +worst.toFixed(4), shown };
}

/** On a frame of a bow shot: how far the string's nock is from the drawing hand, and the draw. */
export function nockGap(id: string, frame: number) {
  const t = new Film(scenario(id), weaponIndex('bow'));
  t.seek(frame);
  const rig = t.hero.detail;
  t.hero.root.updateMatrixWorld(true);
  const bow = rig.joint('handL');
  const hand = new THREE.Vector3().setFromMatrixPosition(rig.joint('handR').matrixWorld);
  const nock = rig.built.find((b) => b.mat === 'string')!.mesh.getWorldPosition(new THREE.Vector3());
  const grip = new THREE.Vector3().setFromMatrixPosition(bow.matrixWorld);
  const out = { gap: +hand.distanceTo(nock).toFixed(4), drawn: +nock.distanceTo(grip).toFixed(4), rest: HERO_BOW.nock[1], draw: t.fb?.draw ?? 0 };
  t.dispose();
  return out;
}

/** The biggest jump any of these joints makes between two frames, metres, and where. */
export function jumps(id: string, names: string[]) {
  const rows = track(id, names);
  let worst = 0;
  let at = -1;
  let joint = '';
  for (let f = 1; f < rows.length; f++) {
    for (const n of names) {
      const a = rows[f - 1].joints[n];
      const b = rows[f].joints[n];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (d > worst) {
        worst = d;
        at = f;
        joint = n;
      }
    }
  }
  return { worst: +worst.toFixed(4), frame: at, joint };
}

/** Debugging the foot hold: per frame, each foot's plant weight, held offset and ball on the floor. */
export function feet(id: string, from: number, to: number): string {
  const t = new Film(scenario(id));
  const rig = t.hero.detail;
  const rows: string[] = [];
  const v = new THREE.Vector3();
  for (let f = 0; f <= to; f++) {
    t.step();
    if (f < from) continue;
    t.hero.root.updateMatrixWorld(true);
    const holds = t.hero.footHolds;
    const cell = (n: 'L' | 'R', i: number) => {
      v.set(0, -0.08, 0.17).applyMatrix4(rig.joint(`foot${n}`).matrixWorld);
      const h = holds[n];
      return `${n} plant ${(t.fb?.plant[i] ?? 0).toFixed(2)} fix ${h.fix.x.toFixed(3)},${h.fix.z.toFixed(3)}${h.stepping ? ` step ${h.stepping.toFixed(2)}` : ''} ball ${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    };
    rows.push(`${f} run ${t.input.run.toFixed(2)} stride ${t.input.stride.toFixed(2)} | ${cell('L', 0)} | ${cell('R', 1)}`);
  }
  t.dispose();
  return rows.join('\n');
}

/** Gliding: how far each hand is from its grip on the control bar, at worst, over the film. */
export function glideGap(id = 'glide'): number {
  const t = new Film(scenario(id));
  const rig = t.hero.detail;
  let worst = 0;
  const inv = new THREE.Matrix4();
  const grip = new THREE.Vector3();
  for (let f = 0; f < t.s.frames; f++) {
    t.step();
    t.hero.root.updateMatrixWorld(true);
    inv.copy(t.hero.root.matrixWorld).invert();
    const bank = Math.max(-0.9, Math.min(0.9, t.input.bank * 0.6));
    const pitch = Math.max(-0.35, Math.min(0.3, (t.input.rise * 9.2) / 12));
    for (const [n, side] of [
      ['handL', 1],
      ['handR', -1],
    ] as const) {
      const hand = new THREE.Vector3().setFromMatrixPosition(rig.joint(n).matrixWorld).applyMatrix4(inv);
      worst = Math.max(worst, hand.distanceTo(gliderGrip(side, bank, pitch, grip)));
    }
  }
  t.dispose();
  return +worst.toFixed(4);
}

/**
 * Seated in a vehicle's first seat: how far each hand gets, at worst, from what the vehicle gives
 * it to hold (its wheel's rim, its oars' handles) over the film, and where the feet are against
 * the footrest (null when the vehicle has none).
 */
export function holdGap(id: string) {
  const t = new Film(scenario(id));
  const rig = t.hero.detail;
  let hands = 0;
  let feetGap: number | null = null;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (let f = 0; f < t.s.frames; f++) {
    t.step();
    const h = t.prop?.holds;
    if (!h || (!h.hands && !h.feet) || t.input.travel !== t.prop?.driver) continue;
    t.hero.root.updateMatrixWorld(true);
    h.hands?.forEach((o, i) => {
      rig.joint(i === 0 ? 'handL' : 'handR').getWorldPosition(a);
      hands = Math.max(hands, a.distanceTo(o.getWorldPosition(b)));
    });
    if (h.feet) {
      // How far the soles are above the footrest (each foot's own, a pair like stirrups): 0
      // resting on it, more hanging over it.
      for (const [i, n] of ['footL', 'footR'].entries()) {
        const rest = Array.isArray(h.feet) ? h.feet[i] : h.feet;
        rest.getWorldPosition(b);
        rig.joint(n).getWorldPosition(a);
        feetGap = Math.max(feetGap ?? 0, a.y - 0.08 - b.y);
      }
    }
  }
  t.dispose();
  return { hands: +hands.toFixed(4), feet: feetGap === null ? null : +feetGap.toFixed(3) };
}

/**
 * Seated in a vehicle's first seat, frame by frame: where what each hand holds is (left, right) in
 * the vehicle's own frame, and how far each hand is from it.
 */
export function holdTrack(id: string) {
  const t = new Film(scenario(id));
  const rig = t.hero.detail;
  const out: Array<{ frame: number; holds: number[][]; gaps: number[] }> = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const toProp = new THREE.Matrix4();
  for (let f = 0; f < t.s.frames; f++) {
    t.step();
    const hands = t.prop?.holds?.hands;
    if (!hands || t.input.travel !== t.prop?.driver) continue;
    t.hero.root.updateMatrixWorld(true);
    toProp.copy(t.prop.root.matrixWorld).invert();
    const holds: number[][] = [];
    const gaps: number[] = [];
    hands.forEach((o, i) => {
      o.getWorldPosition(b);
      gaps.push(
        rig
          .joint(i === 0 ? 'handL' : 'handR')
          .getWorldPosition(a)
          .distanceTo(b),
      );
      holds.push(b.applyMatrix4(toProp).toArray());
    });
    out.push({ frame: f, holds, gaps });
  }
  t.dispose();
  return out;
}

/**
 * How squarely a vehicle's steering wheel faces the driver over a film, at worst: the cosine
 * between the way its face looks (back up its column) and the way from it to the driver's neck.
 * 1 is straight at them; null when the vehicle has no wheel.
 */
export function wheelFacing(id: string): number | null {
  const t = new Film(scenario(id));
  let worst: number | null = null;
  const at = new THREE.Vector3();
  const to = new THREE.Vector3();
  const face = new THREE.Vector3();
  for (let f = 0; f < t.s.frames; f++) {
    t.step();
    const wheel = t.prop?.root.getObjectByName('steeringWheel');
    if (!wheel) break;
    t.hero.root.updateMatrixWorld(true);
    wheel.getWorldPosition(at);
    t.hero.detail.joint('neck').getWorldPosition(to);
    // The wheel's +Z runs down its column, away from the driver (vehicles.ts steeringWheel()).
    face.set(0, 0, -1).transformDirection(wheel.matrixWorld);
    worst = Math.min(worst ?? 1, face.dot(to.sub(at).normalize()));
  }
  t.dispose();
  return worst === null ? null : +worst.toFixed(3);
}

/**
 * The weapon's far end (a blade's tip, the staff's orb, the bow's top) frame by frame, in the
 * world, the stow on that frame, whether the weapon hangs from a hand and whether it's drawn at
 * all: for drawing and sheathing, which must never make it jump, and for when it's out of sight.
 */
export function weaponTrack(id: string, weapon?: number) {
  const t = new Film(scenario(id), weapon);
  const rig = t.hero.detail;
  const name = weaponId(t.s.weapon ?? t.weapon);
  const far: Record<string, [number, number, number]> = { sword: [0, -1.1, 0], club: [0, -0.6, 0], staff: [0, -1.2, 0], bow: [0, 0.275, 0.476] };
  const g = rig.attachment(name);
  const out: Array<{ frame: number; stow: number; inHand: boolean; shown: boolean; attack: number; tip: number[] }> = [];
  for (let f = 0; f < t.s.frames; f++) {
    t.step();
    t.hero.root.updateMatrixWorld(true);
    const p = new THREE.Vector3(...far[name]).applyMatrix4(g.matrixWorld);
    out.push({
      frame: f,
      stow: t.input.stow,
      inHand: g.parent === rig.joint('handR') || g.parent === rig.joint('handL'),
      shown: g.visible,
      attack: t.input.attackIndex >= 0 ? t.input.attackFrame : -1,
      tip: [p.x, p.y, p.z],
    });
  }
  t.dispose();
  return out;
}

/** What posing one hero costs, microseconds a frame, once it's built and warmed up. */
export function cost(id: string, frames = 600): number {
  const t = new Film(scenario(id));
  for (let i = 0; i < 60; i++) t.step();
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) t.step();
  const us = ((performance.now() - t0) / frames) * 1000;
  t.dispose();
  return +us.toFixed(1);
}
