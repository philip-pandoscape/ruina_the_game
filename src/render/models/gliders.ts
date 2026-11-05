import * as THREE from 'three';
import type { GliderDef } from '../../content/vehicles';
import { Cloth, PAL, Parts, beam, clothMaterial, cone, cyl, extrude, mesh, octa, pivot, rod, tor, type Rgb, type V3 } from './kit';
import { grainify } from './detail';

// Gliders. Origin is the pilot's feet: the hero hangs below the wing with hands up on the
// control bar (y ~2.0); the wing sits at y ~2.4-2.7 and spans the data's `span`.
// animate() tilts the wing about the hang point - bank and pitch in radians, + bank rolls into
// a left turn (the left, +X, wing dips), + pitch lifts the nose - so the caller can keep the root
// level (yaw only) and the pilot hanging plumb. The cloth ripples harder the faster you fly.

export interface GliderAnim {
  bank: number;
  pitch: number;
  speed: number;
}

export interface GliderModel {
  root: THREE.Group;
  animate(dt: number, s: GliderAnim): void;
}

// The hang point, and the control bar under it: low and well ahead, in front of the pilot's chin
// rather than through their head (the hero is mostly head, and short in the arm).
const HANG = 2.45;
const BAR = 1.8;
const BAR_Z = 0.45;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/**
 * Where a hand holds the control bar (side +1 left, -1 right), in the glider's frame (the pilot's
 * feet), with the wing tilted as animate() tilts it. The pilot's pose reaches for this.
 */
export function gliderGrip(side: number, bank: number, pitch: number, out: THREE.Vector3): THREE.Vector3 {
  out.set(side * 0.28, BAR - HANG, BAR_Z);
  out.applyEuler(new THREE.Euler(-clamp(pitch, -0.6, 0.6), 0, -clamp(bank, -0.9, 0.9)));
  return out.setY(out.y + HANG);
}
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

interface Look {
  tube: Rgb;
  fitting: Rgb;
  grip: Rgb;
}

/** The A-frame under the keel: two down-tubes to a bar the pilot holds, and the hang strap. */
function controlFrame(p: Parts, trim: Parts, look: Look): void {
  const y = BAR - HANG;
  const z = BAR_Z;
  p.add(rod([-0.5, y, z], [0.5, y, z], 0.026, 6), look.tube);
  for (const sx of [-1, 1]) {
    p.add(rod([0, -0.02, 0.1], [sx * 0.5, y, z], 0.022, 6), look.tube);
    p.add(cyl(0.032, 0.032, 0.2, 6), look.grip, [sx * 0.28, y, z], [0, 0, Math.PI / 2]);
    p.add(octa(0.04), look.fitting, [sx * 0.51, y, z]);
  }
  p.add(octa(0.05), look.fitting, [0, -0.02, 0.1]);
  trim.add(beam([0, -0.03, -0.02], [0, -0.3, -0.06], 0.05, 0.012), PAL.leather);
  trim.add(tor(0.035, 0.009, 4, 8), PAL.steel, [0, -0.33, -0.06], [0, Math.PI / 2, 0]);
}

/** Small ribbons that stream from the wingtips. */
function ribbon(parent: THREE.Object3D, at: V3, colour: Rgb): (time: number, speed: number) => void {
  const c = new Cloth(5, 1, () => colour);
  const m = mesh(parent, c.geometry, { mat: clothMaterial(), shadow: false, receive: false });
  m.position.set(...at);
  return (time, speed) => {
    const wave = 0.3 + clamp(speed / 20, 0, 1) * 0.5;
    c.shape((u, v, out) => out.set(Math.sin(time * (6 + speed * 0.4) - u * 6) * 0.08 * u * wave, (v - 0.5) * 0.06 * (1 - u * 0.6), -u * 0.7));
  };
}

function wayfarer(def: GliderDef, root: THREE.Group): GliderModel['animate'] {
  const half = def.span / 2;
  const wing = pivot(root, 0, HANG, 0, 'wing');
  const wood = 0xd8b07a;
  const frame = new Parts();
  const trim = new Parts();
  const nose: V3 = [0, 0.13, 1.25];
  const tail: V3 = [0, -0.02, -1.45];
  const tip: V3 = [half, 0.24, -0.85];
  frame.add(rod(nose, tail, 0.035, 6), wood);
  frame.add(octa(0.06), PAL.brass, nose);
  for (const sx of [-1, 1]) {
    const t: V3 = [sx * tip[0], tip[1], tip[2]];
    frame.add(rod(nose, t, 0.034, 6, 0.024), wood);
    const mid = lerp3(nose, t, 0.55);
    frame.add(rod([0, 0.02, mid[2]], [mid[0], mid[1] - 0.04, mid[2]], 0.026, 6), wood);
    frame.add(octa(0.045), PAL.brass, [mid[0], mid[1] - 0.04, mid[2]]);
    frame.add(cone(0.035, 0.09, 6), PAL.brass, [t[0] + sx * 0.03, t[1], t[2] - 0.04], [0, 0, (-sx * Math.PI) / 2]);
    // Rigging wires from the bar to the nose, tail and spars.
    const bar: V3 = [sx * 0.5, BAR - HANG, BAR_Z];
    for (const to of [nose, tail, [mid[0], mid[1] - 0.04, mid[2]] as V3]) trim.add(rod(bar, to, 0.006, 3), 0x5a4a3a);
  }
  controlFrame(frame, trim, { tube: wood, fitting: PAL.brass, grip: PAL.leatherDark });
  mesh(wing, frame.build(), { outline: 0.02 });
  mesh(wing, trim.build());

  // Canvas: warm stripes, a couple of patches, stretched between keel and leading edge.
  const stripes = [PAL.orange, PAL.cream, PAL.red, PAL.cream, PAL.mustard, PAL.cream, PAL.orange, PAL.red];
  const patches = new Map([['2:3', 0x6f8fb3], ['5:1', 0xe9dcc0], ['6:4', 0x8fbf6a]]);
  const cloth = new Cloth(8, 6, (i, j) => patches.get(`${i}:${j}`) ?? stripes[i % stripes.length]);
  const sides = [1, -1].map((sx) => {
    const g = pivot(wing, 0, 0, 0);
    g.scale.x = sx;
    const m = mesh(g, cloth.geometry, { mat: clothMaterial(), name: 'sail', receive: false });
    m.castShadow = true;
    return g;
  });
  const tips = [1, -1].map((sx) => ribbon(sides[sx > 0 ? 0 : 1], [tip[0] + 0.02, tip[1], tip[2]], PAL.red));
  const shape = (time: number, ripple: number, flex: number) =>
    cloth.shape((u, v, out) => {
      const le = lerp3(nose, [tip[0], tip[1] + flex, tip[2]], u);
      const te = lerp3(tail, [tip[0], tip[1] + flex, tip[2]], u);
      const p = lerp3(le, te, v);
      const billow = 0.2 * Math.sin(Math.PI * v) * Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.1)), 0.7) * (1 - 0.35 * u);
      const flutter = Math.sin(time * 9 - u * 7 + v * 2) * ripple * v * v;
      out.set(p[0], p[1] + billow + flutter, p[2] - 0.12 * Math.sin(Math.PI * u) * v);
    });
  shape(0, 0.01, 0);
  let time = 0;
  return (dt, s) => {
    time += dt;
    wing.rotation.z = -clamp(s.bank, -0.9, 0.9);
    wing.rotation.x = -clamp(s.pitch, -0.6, 0.6);
    const k = clamp((s.speed - def.stallSpeed) / (def.diveSpeed - def.stallSpeed), 0, 1);
    shape(time, 0.012 + 0.035 * k, 0.04 * k);
    for (const t of tips) t(time, s.speed);
  };
}

function swiftwing(def: GliderDef, root: THREE.Group): GliderModel['animate'] {
  const half = def.span / 2;
  const wing = pivot(root, 0, HANG, 0, 'wing');
  const lacquer = 0x9a2f24;
  const teal = 0x2aa59c;
  const tealDark = 0x1f8a83;
  const white = 0xf6f7f1;
  const frame = new Parts();
  const trim = new Parts();
  const cols = 12;
  const rows = 6;
  const rootChord = 1.45;
  const le = (u: number, flex: number): V3 => [u * half, 0.1 + (0.22 + flex) * u * u, 0.55 + 0.3 * Math.sin(Math.PI * u * 0.9) - 1.3 * u * u];
  const te = (u: number, flex: number): V3 => {
    const l = le(u, flex);
    const chord = rootChord * (1 - Math.pow(u, 2.2));
    const col = Math.round(u * cols);
    const feather = col % 2 === 1 ? 0.16 * (1 - u * 0.5) : 0;
    return [l[0] * 0.995, l[1] - 0.02, l[2] - chord - feather];
  };
  const camber = (u: number, v: number) => 0.13 * Math.sin(Math.PI * Math.pow(v, 0.8)) * (1 - 0.6 * u);
  const point = (u: number, v: number, flex: number): V3 => {
    const a = le(u, flex);
    const b = te(u, flex);
    const p = lerp3(a, b, v);
    return [p[0], p[1] + camber(u, v), p[2]];
  };
  // Spine with a gold nose, and a forked swallow tail.
  const nose: V3 = [0, 0.13, 0.98];
  const tailEnd: V3 = [0, 0.03, -0.95];
  frame.add(rod(nose, tailEnd, 0.038, 6), lacquer);
  frame.add(cone(0.05, 0.16, 6), PAL.gold, [0, 0.13, 1.05], [Math.PI / 2, 0, 0]);
  for (const sx of [-1, 1]) {
    frame.add(extrude([[0, 0], [sx * 0.34, -0.62], [sx * 0.18, -0.6], [sx * 0.04, -0.2]], 0.025), teal, [0, 0.035, -0.85], [Math.PI / 2, 0, 0]);
    frame.add(extrude([[sx * 0.3, -0.56], [sx * 0.34, -0.62], [sx * 0.2, -0.6]], 0.03), white, [0, 0.035, -0.85], [Math.PI / 2, 0, 0]);
  }
  // Leading-edge spar and lacquered ribs out to the feather tips (right half; mirrored below).
  const half1 = new Parts();
  for (let k = 0; k < 8; k++) half1.add(rod(le(k / 8, 0), le((k + 1) / 8, 0), 0.03 - k * 0.002, 6), lacquer);
  for (let c = 1; c < cols; c += 2) {
    const u = c / cols;
    const pts = [0, 0.35, 0.7, 1].map((v) => {
      const p = point(u, v, 0);
      return [p[0], p[1] + 0.018, p[2]] as V3;
    });
    for (let k = 0; k < 3; k++) half1.add(rod(pts[k], pts[k + 1], 0.013, 4), lacquer);
    half1.add(octa(0.022), PAL.gold, pts[3]);
  }
  half1.add(cone(0.03, 0.1, 6), PAL.gold, le(1, 0), [0, 0, -Math.PI / 2]);
  controlFrame(frame, trim, { tube: lacquer, fitting: PAL.gold, grip: 0x3a2a22 });
  for (const sx of [-1, 1]) {
    const bar: V3 = [sx * 0.5, BAR - HANG, BAR_Z];
    for (const to of [nose, tailEnd, le(0.45, 0)]) trim.add(rod(bar, [sx * Math.abs(to[0]), to[1], to[2]], 0.005, 3), 0x3a3a3a);
  }
  mesh(wing, frame.build(), { outline: 0.018 });
  mesh(wing, trim.build());
  const halfGeo = half1.build();
  // Silk: teal with white feather tips and a pale band near the leading edge.
  const cloth = new Cloth(cols, rows, (i, j) => (j >= rows - 2 ? (i % 2 ? white : 0xe8f2ef) : j === 0 ? 0x7fd3c8 : i % 4 < 2 ? teal : tealDark));
  const tips: Array<(t: number, s: number) => void> = [];
  for (const sx of [1, -1]) {
    const g = pivot(wing, 0, 0, 0);
    g.scale.x = sx;
    const m = mesh(g, cloth.geometry, { mat: clothMaterial(), name: 'sail', receive: false });
    m.castShadow = true;
    mesh(g, halfGeo, { outline: 0.016 });
    tips.push(ribbon(g, le(1, 0), PAL.gold));
  }
  const shape = (time: number, ripple: number, flex: number) =>
    cloth.shape((u, v, out) => {
      const p = point(u, v, flex);
      const flutter = Math.sin(time * 11 - u * 9 + v * 3) * ripple * v * v * v;
      out.set(p[0], p[1] + flutter, p[2]);
    });
  shape(0, 0.01, 0);
  let time = 0;
  return (dt, s) => {
    time += dt;
    wing.rotation.z = -clamp(s.bank, -0.9, 0.9);
    wing.rotation.x = -clamp(s.pitch, -0.6, 0.6);
    const k = clamp((s.speed - def.stallSpeed) / (def.diveSpeed - def.stallSpeed), 0, 1);
    shape(time, 0.015 + 0.04 * k, 0.05 * k);
    for (const t of tips) t(time, s.speed);
  };
}

/** Builds a glider; unknown ids get the canvas wayfarer at the data's span. */
function buildGliderModel(def: GliderDef): GliderModel {
  const root = new THREE.Group();
  root.name = `glider:${def.id}`;
  const animate = def.id === 'swiftwing' ? swiftwing(def, root) : wayfarer(def, root);
  return { root, animate };
}


export function buildGlider(def: GliderDef): GliderModel {
  const model = buildGliderModel(def);
  grainify(model.root);
  return model;
}
