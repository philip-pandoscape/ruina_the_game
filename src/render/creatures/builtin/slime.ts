import { RigBuilder } from '../authoring';
import { bakeAuthored } from '../clips';
import { MAT, type SpeciesDef } from '../species';

// A slime: five joints, no limbs, and all of its movement in scale rather than rotation. It
// exists to keep the format honest - nothing in the renderer or the pose baker may assume a
// skeleton has anything in common with a person.

const GREEN = 0x5f9e5f;
const DARK = 0x3d6b43;

function skeleton() {
  const r = new RigBuilder();
  const root = r.joint('root', -1, [0, 0, 0]);
  const core = r.joint('core', root, [0, 0.26, 0]);
  const top = r.joint('top', core, [0, 0.26, 0]);
  const budL = r.joint('budL', root, [0.26, 0.09, 0]);
  const budR = r.joint('budR', root, [-0.26, 0.09, 0]);
  r.box(core, [0, 0, 0], [0.64, 0.5, 0.64], { mat: MAT.team, color: GREEN });
  r.box(top, [0, 0.02, 0], [0.42, 0.26, 0.42], { mat: MAT.team, color: GREEN });
  r.box(core, [0.1, 0.06, 0.3], [0.1, 0.1, 0.06], { color: 0x101418 }); // eyes
  r.box(core, [-0.1, 0.06, 0.3], [0.1, 0.1, 0.06], { color: 0x101418 });
  r.box(budL, [0.02, 0, 0], [0.2, 0.18, 0.24], { mat: MAT.team, color: DARK });
  r.box(budR, [-0.02, 0, 0], [0.2, 0.18, 0.24], { mat: MAT.team, color: DARK });
  return { ...r.build(), core, top, root, budL, budR };
}

export function slimeSpecies(): SpeciesDef {
  const rig = skeleton();
  const { joints } = rig;

  // Squash and stretch, conserving rough volume so it reads as something with insides.
  const blob = (amount: number) => {
    const wide = 1 + amount;
    const tall = 1 / (wide * wide);
    return [wide, tall, wide] as const;
  };

  const idle = bakeAuthored(joints, { name: 'idle', frames: 48, fps: 30 }, (j, f) => {
    const t = (f / 48) * Math.PI * 2;
    const a = Math.sin(t) * 0.07;
    if (j === rig.core) return { scale: [...blob(a)] as [number, number, number] };
    if (j === rig.top) return { pos: [0, 0.26 - a * 0.1, 0] };
    return undefined;
  });

  const hop = bakeAuthored(joints, { name: 'hop', frames: 36, fps: 30 }, (j, f) => {
    const t = f / 36;
    // Crouch, launch, float, land flat.
    const crouch = Math.max(0, 1 - Math.abs(t - 0.12) / 0.12);
    const land = Math.max(0, 1 - Math.abs(t - 0.78) / 0.1);
    const air = Math.max(0, Math.sin(((t - 0.18) / 0.6) * Math.PI));
    const squash = crouch * 0.3 + land * 0.38 - air * 0.22;
    if (j === rig.root) return { pos: [0, air * 0.55, 0] };
    if (j === rig.core) return { scale: [...blob(squash)] as [number, number, number] };
    if (j === rig.budL) return { pos: [0.26 + squash * 0.1, 0.09, 0] };
    if (j === rig.budR) return { pos: [-0.26 - squash * 0.1, 0.09, 0] };
    return undefined;
  });

  const die = bakeAuthored(joints, { name: 'die', frames: 30, fps: 30, loop: false }, (j, f) => {
    const t = f / 29;
    // Squashing the core alone leaves a pancake hovering at the joint it scaled about, so the
    // whole thing has to sink as it spreads.
    if (j === rig.core) return { pos: [0, 0.26 - t * 0.21, 0], scale: [1 + t * 1.1, Math.max(0.06, 1 - t), 1 + t * 1.1] };
    if (j === rig.top) return { pos: [0, 0.26 * (1 - t) * 0.25, 0], scale: [1 - t * 0.7, 1 - t * 0.92, 1 - t * 0.7] };
    if (j === rig.budL) return { pos: [0.26 + t * 0.16, 0.09 - t * 0.062, 0], scale: [1 + t * 0.5, 1 - t * 0.7, 1 + t * 0.5] };
    if (j === rig.budR) return { pos: [-0.26 - t * 0.16, 0.09 - t * 0.062, 0], scale: [1 + t * 0.5, 1 - t * 0.7, 1 + t * 0.5] };
    return undefined;
  });

  // Gathering itself to jump: it sinks and spreads, and shivers harder the closer it gets.
  // Stretched over the whole windup, so the shiver is the warning you have to step away.
  const windup = bakeAuthored(joints, { name: 'windup', frames: 18, fps: 30, loop: false }, (j, f) => {
    const t = f / 17;
    const sink = Math.min(1, t * 1.4);
    const shiver = Math.sin(f * 2.6) * 0.05 * t;
    const squash = sink * 0.45 + shiver;
    if (j === rig.root) return { pos: [shiver * 0.3, 0, 0] };
    if (j === rig.core) return { scale: [...blob(squash)] as [number, number, number] };
    if (j === rig.top) return { pos: [0, 0.26 - sink * 0.08, 0] };
    if (j === rig.budL) return { pos: [0.26 + squash * 0.14, 0.09 - sink * 0.04, 0] };
    if (j === rig.budR) return { pos: [-0.26 - squash * 0.14, 0.09 - sink * 0.04, 0] };
    return undefined;
  });

  // The slam: a high arc, long and thin on the way up, and a hard splat where it lands. Its rise
  // matches the leap's gait in shared/behaviours.json (apex 0.9 m, off the ground 5%..95%).
  const leap = bakeAuthored(joints, { name: 'leap', frames: 30, fps: 30, loop: false }, (j, f) => {
    const t = f / 29;
    const air = Math.max(0, Math.min(1, (t - 0.05) / 0.9));
    const rise = Math.sin(air * Math.PI);
    const splat = Math.max(0, 1 - Math.abs(t - 0.97) / 0.06);
    const squash = splat * 0.55 - (air > 0 && air < 0.5 ? 0.28 * Math.sin(air * 2 * Math.PI) : 0);
    if (j === rig.root) return { pos: [0, rise * 0.9, 0] };
    if (j === rig.core) return { scale: [...blob(squash)] as [number, number, number] };
    if (j === rig.budL) return { pos: [0.26 + squash * 0.16, 0.09, 0] };
    if (j === rig.budR) return { pos: [-0.26 - squash * 0.16, 0.09, 0] };
    return undefined;
  });

  // Gathering the pack in: it swells, its top lifting like a held breath, and throbs faster as the
  // cast goes on. Stretched over the whole cast, so how swollen it is tells you how long is left.
  const gather = bakeAuthored(joints, { name: 'gather', frames: 45, fps: 30, loop: false }, (j, f) => {
    const t = f / 44;
    const throb = Math.sin(f * (0.35 + t * 0.6)) * 0.06;
    const swell = t * 0.22 + throb;
    if (j === rig.core) return { scale: [1 + swell, 1 + swell * 0.7, 1 + swell] };
    if (j === rig.top) return { pos: [0, 0.26 + t * 0.1 + throb * 0.5, 0], scale: [1 + swell * 0.6, 1 + swell * 0.8, 1 + swell * 0.6] };
    if (j === rig.budL) return { pos: [0.26 + swell * 0.18, 0.09 + t * 0.05, 0] };
    if (j === rig.budR) return { pos: [-0.26 - swell * 0.18, 0.09 + t * 0.05, 0] };
    return undefined;
  });

  // Dazed after its cast was broken: slumped and wobbling off-balance.
  const dazed = bakeAuthored(joints, { name: 'dazed', frames: 40, fps: 30 }, (j, f) => {
    const t = (f / 40) * Math.PI * 2;
    const tip = Math.sin(t) * 0.18;
    const sag = 0.18 + Math.sin(t * 2) * 0.04;
    if (j === rig.core) return { scale: [...blob(sag)] as [number, number, number], rot: [0, 0, Math.sin(tip / 2), Math.cos(tip / 2)] };
    if (j === rig.top) return { pos: [Math.sin(t) * 0.05, 0.22, 0] };
    return undefined;
  });

  return { id: 'slime', height: rig.height, joints, proxy: rig.proxy, clips: [idle, hop, die, windup, leap, gather, dazed] };
}
