// Cuts the animation clips the game uses out of an animation library (a GLB of a skeleton with many
// clips, such as Quaternius' Universal Animation Library), dropping the mesh and every other clip,
// so only the skeleton and those clips ship. Compress the result as AGENTS.md says, with
// --flatten false so the skeleton keeps its tree.
//
//   npm i --no-save @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions meshoptimizer
//   node tools/models/clips.mjs library.glb                 lists its clips and their seconds
//   node tools/models/clips.mjs library.glb out.glb Clip_A Clip_B ... ("Long|name=Short" renames one)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';

const [, , inFile, outFile, ...args] = process.argv;
const keep = args.map((a) => a.split('=')[0]);
const renames = new Map(args.filter((a) => a.includes('=')).map((a) => a.split('=')));
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(inFile);
const root = doc.getRoot();
if (!outFile) {
  for (const a of root.listAnimations()) {
    const seconds = Math.max(0, ...a.listSamplers().map((s) => s.getInput()?.getMax([])[0] ?? 0));
    console.log(`${a.getName()}  ${seconds.toFixed(2)} s`);
  }
  process.exit(0);
}
const wanted = new Set(keep);
for (const a of root.listAnimations()) if (!wanted.has(a.getName())) a.dispose();
const kept = root.listAnimations().map((a) => a.getName());
const missing = keep.filter((k) => !kept.includes(k));
for (const a of root.listAnimations()) if (renames.has(a.getName())) a.setName(renames.get(a.getName()));
if (missing.length) throw new Error(`not in the library: ${missing.join(', ')}`);
for (const node of root.listNodes()) {
  node.setMesh(null);
  node.setSkin(null);
}
await doc.transform(prune({ keepLeaves: true }));
await io.write(outFile, doc);
console.log(
  'kept',
  root
    .listAnimations()
    .map((a) => a.getName())
    .join(', '),
);
