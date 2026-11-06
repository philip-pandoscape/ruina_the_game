import { expect, test } from 'vitest';
import { CROPS, PACKS, PROPS, STRUCTURES } from '../../src/render/models/data';
import { cropBodies } from '../../src/render/models/crops';
import { packBodies } from '../../src/render/models/packs';
import { propBodies } from '../../src/render/models/props';
import { structureBodies } from '../../src/render/models/structures';

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
