// Readies a made weapon model for the game, before it is compressed (AGENTS.md, Art and assets).
// Meshy's models come with a colour texture only, so this paints their metal-roughness map from the
// colours (steel and gold shine, wood and leather don't) and an emissive map for the staff's orb;
// and it cuts the bowstring off the bow (the game draws its own, to pull back). The colour rules and
// the bow's curve are these models' own: a new model wants its own look first.
//
//   npm i --no-save @gltf-transform/core sharp
//   node tools/models/weaponprep.mjs in.glb out.glb sword|club|staff|bow [debug-prefix]
import { NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';

const [, , inFile, outFile, kind, debug] = process.argv;
const io = new NodeIO();
const doc = await io.read(inFile);
const root = doc.getRoot();
const mat = root.listMaterials()[0];
const base = mat.getBaseColorTexture();
const { data, info } = await sharp(Buffer.from(base.getImage())).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const n = info.width * info.height;
const mr = Buffer.alloc(n * 3);
const em = Buffer.alloc(n * 3);
const counts = {};
for (let i = 0; i < n; i++) {
  const r = data[i * 3] / 255,
    g = data[i * 3 + 1] / 255,
    b = data[i * 3 + 2] / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const v = max,
    s = max > 0 ? (max - min) / max : 0;
  let h = 0;
  if (max > min) {
    if (max === r) h = 60 * (((g - b) / (max - min)) % 6);
    else if (max === g) h = 60 * ((b - r) / (max - min) + 2);
    else h = 60 * ((r - g) / (max - min) + 4);
    if (h < 0) h += 360;
  }
  let cls = 'other',
    metal = 0,
    rough = 0.8,
    glow = false;
  const grey = s < 0.2;
  if (kind === 'sword') {
    if (grey) [cls, metal, rough] = ['steel', 1, 0.3];
    else [cls, rough] = ['leather', 0.7];
  } else if (kind === 'club') {
    if (grey) [cls, metal, rough] = ['iron', 0.9, 0.45];
    else [cls, rough] = ['wood', 0.8];
  } else if (kind === 'staff') {
    if (h >= 18 && h <= 46 && s > 0.72 && v > 0.7) [cls, rough, glow] = ['orb', 0.25, true];
    else if (h >= 30 && h <= 70 && s > 0.22 && v > 0.42) [cls, metal, rough] = ['gold', 1, 0.35];
    else if (grey && v > 0.25) [cls, metal, rough] = ['iron', 0.9, 0.45];
    else [cls, rough] = ['wood', 0.75];
  } else if (kind === 'bow') {
    if (h >= 25 && h <= 55 && s < 0.5 && v > 0.55) [cls, rough] = ['yew', 0.5];
    else [cls, rough] = ['leather', 0.75];
  }
  counts[cls] = (counts[cls] ?? 0) + 1;
  mr[i * 3] = 255;
  mr[i * 3 + 1] = Math.round(rough * 255);
  mr[i * 3 + 2] = Math.round(metal * 255);
  if (glow) for (let c = 0; c < 3; c++) em[i * 3 + c] = data[i * 3 + c];
}
console.log(kind, Object.fromEntries(Object.entries(counts).map(([k, c]) => [k, (c / n).toFixed(3)])));
const raw = { raw: { width: info.width, height: info.height, channels: 3 } };
const mrPng = await sharp(mr, raw).png().toBuffer();
if (debug) {
  await sharp(mr, raw).resize(512, 512).png().toFile(`${debug}-mr.png`);
  if (kind === 'staff') await sharp(em, raw).resize(512, 512).png().toFile(`${debug}-em.png`);
}
const mrTex = doc.createTexture('metalRough').setImage(mrPng).setMimeType('image/png');
mat.setMetallicRoughnessTexture(mrTex).setMetallicFactor(1).setRoughnessFactor(1);
if (kind === 'staff') {
  const emTex = doc
    .createTexture('glow')
    .setImage(await sharp(em, raw).png().toBuffer())
    .setMimeType('image/png');
  mat.setEmissiveTexture(emTex).setEmissiveFactor([1, 1, 1]);
}
mat.setDoubleSided(false);

if (kind === 'bow') {
  // The string: long thin faces running tip to tip (a cylinder has vertices only at its ends),
  // then whatever small pieces are left standing off the limbs on the string's side.
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const idx = prim.getIndices();
      const P = (i) => pos.getElement(i, [0, 0, 0]);
      const keep = [];
      let cut = 0;
      for (let t = 0; t < idx.getCount(); t += 3) {
        const a = P(idx.getScalar(t)),
          b = P(idx.getScalar(t + 1)),
          c = P(idx.getScalar(t + 2));
        const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
        const longest = Math.max(d(a, b), d(b, c), d(c, a));
        // Off the limb on the string's side, away from the tips: the nocking point and serving.
        const mid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
        const limbX = -0.056 + 0.118 * Math.pow(Math.abs(mid[1]) / 0.475, 2.2);
        const stray = mid[0] - limbX > 0.035;
        if (longest > 0.25 || stray) cut++;
        else keep.push(idx.getScalar(t), idx.getScalar(t + 1), idx.getScalar(t + 2));
      }
      console.log('bow: cut', cut, 'of', idx.getCount() / 3, 'triangles');
      idx.setArray(new Uint32Array(keep));
    }
  }
}
await io.write(outFile, doc);
console.log('wrote', outFile);
