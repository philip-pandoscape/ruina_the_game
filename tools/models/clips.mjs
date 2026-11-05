// Cuts the animation clips the game uses out of an animation library (a GLB of a skeleton with many
// clips, such as Quaternius' Universal Animation Library), dropping the mesh and every other clip,
// so only the skeleton and those clips ship. Compress the result as AGENTS.md says, with
// --flatten false so the skeleton keeps its tree.
//
//   npm i --no-save @gltf-transform/core @gltf-transform/functions
//   node tools/models/clips.mjs library.glb out.glb Clip_A Clip_B ...
import { NodeIO } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';

const [, , inFile, outFile, ...keep] = process.argv;
const io = new NodeIO();
const doc = await io.read(inFile);
const root = doc.getRoot();
const wanted = new Set(keep);
for (const a of root.listAnimations()) if (!wanted.has(a.getName())) a.dispose();
const kept = root.listAnimations().map((a) => a.getName());
const missing = keep.filter((k) => !kept.includes(k));
if (missing.length) throw new Error(`not in the library: ${missing.join(', ')}`);
for (const node of root.listNodes()) {
  node.setMesh(null);
  node.setSkin(null);
}
await doc.transform(prune({ keepLeaves: true }));
await io.write(outFile, doc);
console.log('kept', kept.join(', '));
