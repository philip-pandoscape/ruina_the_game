import { expect, test } from 'vitest';
import emberholm from '../../shared/regions/emberholm.json' with { type: 'json' };
import { actorKind, actorKindIds } from '../../src/content/actors';
import { BEARDS, HAIRS, type VillagerLook } from '../../src/content/looks';
import { INSIDES } from '../../src/render/creatures/jelly';
import { GLIDERS, MOUNTS, VEHICLES } from '../../src/content/vehicles';
import { animalBodies } from '../../src/render/models/animals';
import { ANIMALS, CROPS, PACKS, PROPS, STRUCTURES } from '../../src/render/models/data';
import { cropBodies } from '../../src/render/models/crops';
import { gliderBodies } from '../../src/render/models/gliders';
import { mountBodies } from '../../src/render/models/mounts';
import { packBodies } from '../../src/render/models/packs';
import { propBodies } from '../../src/render/models/props';
import { structureBodies } from '../../src/render/models/structures';
import { vehicleBodies } from '../../src/render/models/vehicles';
import { outfits } from '../../src/render/models/villagers';

// A thing's look names a body built into the game and a made model fitted over it
// (src/content/looks.ts). contentc checks a look's fields and that its made model's files are there;
// this, that the bodies it names are ones the game has (a name it hasn't would draw the plain body),
// and that every body is one something wears (one nothing wears is code nothing draws).

interface Kind {
  kind: string;
  things: ReadonlyArray<{ id: string; look?: { body?: string } }>;
  bodies: string[];
}

const KINDS: Kind[] = [
  { kind: 'structures', things: STRUCTURES, bodies: structureBodies() },
  { kind: 'props', things: PROPS, bodies: propBodies() },
  { kind: 'crops', things: CROPS, bodies: cropBodies() },
  { kind: 'packs', things: PACKS, bodies: packBodies() },
  { kind: 'animals', things: ANIMALS, bodies: animalBodies() },
  { kind: 'vehicles', things: VEHICLES, bodies: vehicleBodies() },
  { kind: 'mounts', things: MOUNTS, bodies: mountBodies() },
  { kind: 'gliders', things: GLIDERS, bodies: gliderBodies() },
];

test('every look names a body its kind has', () => {
  const wrong: string[] = [];
  for (const k of KINDS)
    for (const t of k.things) {
      const body = t.look?.body;
      if (body !== undefined && !k.bodies.includes(body)) wrong.push(`content/${k.kind}/${t.id}.json: no body "${body}" (there are ${k.bodies.join(', ')})`);
    }
  expect(wrong).toEqual([]);
});

test('every body is one something wears', () => {
  const unworn = KINDS.flatMap((k) => k.bodies.filter((b) => !k.things.some((t) => t.look?.body === b)).map((b) => `${k.kind}: ${b}`));
  expect(unworn, 'bodies no content names: a look should, or the code goes').toEqual([]);
});

const NPCS = (emberholm as unknown as { npcs: Array<{ id: string; look?: VillagerLook }> }).npcs;
const COLOURS = ['skin', 'shirt', 'sleeve', 'gloves', 'pants', 'boots', 'skirt', 'trim', 'tails', 'belt', 'hair'] as const;

test("every townsperson's look is one the townsfolk's body can be dressed in", () => {
  const wrong: string[] = [];
  for (const n of NPCS) {
    const l = n.look;
    if (!l) continue;
    const at = `content/npcs/${n.id}.json`;
    if (l.outfit !== undefined && !outfits().includes(l.outfit)) wrong.push(`${at}: no outfit "${l.outfit}" (there are ${outfits().join(', ')})`);
    if (!HAIRS.includes(l.style)) wrong.push(`${at}: no hair "${l.style}"`);
    if (l.beard !== undefined && !BEARDS.includes(l.beard)) wrong.push(`${at}: no beard "${l.beard}"`);
    for (const k of COLOURS) {
      const c = l[k];
      if (c !== undefined && c !== null && !/^#[0-9a-f]{6}$/i.test(c)) wrong.push(`${at}: its ${k} is "${c}", not a colour as #rrggbb`);
    }
  }
  expect(wrong).toEqual([]);
  const unworn = outfits().filter((o) => !NPCS.some((n) => n.look?.outfit === o));
  expect(unworn, 'outfits no one wears').toEqual([]);
});

test("every creature's look is one it can be drawn with", () => {
  const wrong: string[] = [];
  const worn = new Set<string>();
  for (const id of actorKindIds()) {
    const k = actorKind(id);
    const l = k.look;
    if (!l) continue;
    if (l.body !== undefined && l.body !== 'jelly') wrong.push(`${id}: no body "${l.body}" (jelly, or none for its species' own)`);
    if (l.body === 'jelly' && !k.species) wrong.push(`${id}: jelly is drawn over a species' skeleton, and it has none`);
    for (const x of l.inside ?? []) {
      worn.add(x);
      if (!(INSIDES as readonly string[]).includes(x)) wrong.push(`${id}: nothing called "${x}" floats in jelly (${INSIDES.join(', ')} do)`);
    }
    if (l.dies !== undefined && l.dies !== 'straw') wrong.push(`${id}: dies as "${l.dies}", where only straw is drawn`);
  }
  expect(wrong).toEqual([]);
  expect(
    INSIDES.filter((x) => !worn.has(x)),
    'what floats in no slime',
  ).toEqual([]);
});
