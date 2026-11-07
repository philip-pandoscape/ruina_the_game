import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Reader, unzigzag32 } from '../../src/net/wire/bytes';
import { ackAfter, ackBytes, Heard } from '../../src/net/wire/heard';
import { EVENT, KINDS, MAX_FIELDS, MODES, UPDATE, ACK, WINDOW } from '../../src/net/wire/schema';

// The browser's side of the wire for crowds held to the server's (crates/wire): the schema field for
// field, and every update in the golden scenes (crates/wire/tests/golden.rs writes them: a few of
// everything near you, a bad road, out of sight and back, near, middle and far) heard step by step
// to the same states, acknowledgements and drops as the Rust's Heard.

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/wire/${name}`, import.meta.url), 'utf8'));

interface Step {
  bytes: string;
  deliver: boolean;
  heard?: { seq: number; tick: number; removed: number[]; introduced: number[]; fresh: number[]; whole: number[]; events: number[][] } | null;
  ack?: { seq: number; bits: number };
  sight?: Array<{ handle: number; kind: string; intro: Record<string, unknown>; tier: string; seq: number; tick: number; fields: number[] }>;
}

const bytesOf = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));

describe('the wire, against the server', () => {
  it('has the same kinds, fields, tiers and runs', () => {
    const s = fixture('schema.json');
    expect({ update: UPDATE, ack: ACK, window: WINDOW, maxFields: MAX_FIELDS, modes: [...MODES], event: [...EVENT] }).toEqual({
      update: s.update,
      ack: s.ack,
      window: s.window,
      maxFields: s.maxFields,
      modes: s.modes,
      event: s.event,
    });
    for (const k of KINDS) {
      const theirs = s.kinds[k.name];
      expect(theirs, k.name).toBeDefined();
      expect({ byte: k.byte, reference: k.reference, fields: k.fields }).toEqual({ byte: theirs.byte, reference: theirs.reference, fields: theirs.fields });
    }
    expect(Object.keys(s.kinds).length).toBe(KINDS.length);
  });

  const scenes = fixture('updates.json').scenes as Array<{ name: string; steps: Step[] }>;
  for (const scene of scenes) {
    it(`hears "${scene.name}" as the server's own side does`, () => {
      const heard = new Heard();
      let checked = 0;
      scene.steps.forEach((step, k) => {
        if (!step.deliver) return;
        const done = heard.hear(bytesOf(step.bytes));
        expect(done, `step ${k}`).toEqual(step.heard);
        expect(heard.ack(), `step ${k}`).toEqual(step.ack);
        const sight = [...heard.ents.entries()]
          .sort(([a], [b]) => a - b)
          .map(([handle, e]) => {
            const now = e.states[e.states.length - 1];
            const { kind, ...intro } = e.intro;
            return { handle, kind, intro, tier: e.tier, seq: now.seq, tick: now.tick, fields: [...now.fields.subarray(0, e.kind.fields.length)] };
          });
        expect(sight, `step ${k}`).toEqual(step.sight);
        checked++;
      });
      expect(heard.errors).toBe(0);
      expect(checked).toBeGreaterThan(4);
    });
  }

  it('reads its small numbers as the server writes them', () => {
    // 300 as a varint, -1 and 1 zigzagged, a 64-bit-ish id, and a 32-bit difference.
    const r = new Reader(Uint8Array.from([0xac, 0x02, 0x01, 0x02, 0x80, 0x89, 0x7a, 0xfe, 0xff, 0xff, 0xff, 0x0f]));
    expect([r.varint(), r.zigzag(), r.zigzag(), r.zigzag()]).toEqual([300, -1, 1, 1000000]);
    expect(unzigzag32(r.varint32())).toBe(2147483647);
    expect(r.done).toBe(true);
    expect(() => new Reader(Uint8Array.from([0x80])).varint()).toThrow();
  });

  it('acknowledges the newest update and which of the 32 before it arrived', () => {
    let a = { seq: 0, bits: 0 };
    for (const s of [1, 2, 4]) a = ackAfter(a, s);
    expect(a).toEqual({ seq: 4, bits: 0b110 });
    expect(ackAfter(a, 5).bits).toBe(0b1101);
    expect(ackAfter({ seq: 8, bits: 0 }, 40).bits).toBe(0x80000000);
    expect(ackAfter(a, 40).bits).toBe(0);
    expect([...new Uint8Array(ackBytes({ seq: 70000, bits: 11 }))]).toEqual([8, 0x70, 0x11, 0x01, 0, 11, 0, 0, 0]);
  });
});
