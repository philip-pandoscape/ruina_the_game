import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PACKS } from '../../src/content/trade';
import { MOUNTS, VEHICLES } from '../../src/content/vehicles';
import type { FeedTick } from '../../src/net/feedTick';
import { WireFeed } from '../../src/net/wire/feed';

// The wire for crowds into the feed (src/net/wire/feed.ts): the golden scenes' updates
// (tests/fixtures/wire, written by crates/wire/tests/golden.rs) turned into what the feed draws, in
// metres, radians and the content's ids, in the same shapes today's JSON ticks become
// (src/net/feedTick.ts), so the feed can't tell which way the world came.

const scenes = JSON.parse(readFileSync(new URL('../fixtures/wire/updates.json', import.meta.url), 'utf8')).scenes as Array<{
  name: string;
  steps: Array<{ bytes: string; deliver: boolean }>;
}>;
const bytesOf = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
const ME = 1;

/** Every step of a scene heard, and what each delivered one gave the feed (null: dropped). */
function play(name: string): Array<FeedTick | null> {
  const scene = scenes.find((s) => s.name === name)!;
  const feed = new WireFeed();
  return scene.steps.filter((s) => s.deliver).map((s) => feed.hear(bytesOf(s.bytes), ME));
}

describe('the wire into the feed', () => {
  it('turns a few of everything near you into what the feed draws', () => {
    const ticks = play('a few of everything near you');
    const first = ticks[0]!;
    expect(first.tick).toBe(529000000);
    // Ada, 5 m east and 2 m south, 2.5 m up, facing 12000/65536 of a turn, her cart and her crate with her.
    const ada = first.peers.find((p) => p.id === 7)!;
    expect(ada).toMatchObject({ name: 'Ada', bot: false, every: 1 });
    expect(ada.p.pos).toEqual({ x: 5, y: 2.5, z: -2 });
    expect(ada.p.facing).toBeCloseTo((12000 / 65536) * Math.PI * 2, 6);
    expect(ada.p).toMatchObject({ mode: 'normal', grounded: true, hp: 100, attackFrame: -1, landFrame: 999, glider: '', pack: 0, host: 0 });
    const vehicles = ada.p.vehicles as Array<{ id: number; def: string; x: number; heading: number; cargo: number[] }>;
    expect(vehicles).toHaveLength(1);
    expect(vehicles[0]).toMatchObject({ id: 3, def: [...VEHICLES, ...MOUNTS][0].id, x: 8, z: -2 });
    expect(vehicles[0].heading).toBeCloseTo(Math.PI / 2, 6);
    const packs = ada.p.packs as Array<{ id: number; def: string; at: string; vehicle: number; slot: number }>;
    expect(packs.find((p) => p.at === 'ground')).toMatchObject({ id: 9, def: PACKS[5].id, x: -4, z: -4 });
    expect(packs.find((p) => p.at === 'cargo')).toMatchObject({ def: PACKS[3].id, vehicle: 3, slot: 0 });
    // The bot, and the slime with its progress through its state.
    expect(first.peers.find((p) => p.id === -1000002)).toMatchObject({ name: 'Skirmisher 2', bot: true });
    expect(first.actors).toEqual([expect.objectContaining({ id: 12, kind: 2, x: 3, z: 9, hp: 1, deadFrame: -1, progress: 0, every: 1 })]);
    expect(first.kept).toEqual([]);
    // Ada swinging, her frame counting on.
    expect(ticks[4]!.peers.find((p) => p.id === 7)!.p).toMatchObject({ mode: 'attack', attackFrame: 6 });
    // Your arrow is yours, Ada's hers; each as of its tick.
    const arrows = ticks[3]!.arrows;
    expect(arrows.map((a) => [a.id, a.mine, a.owner])).toEqual([
      [40, true, ME],
      [41, false, 7],
    ]);
    expect(arrows[0]).toMatchObject({ x: 1, y: 1.3, vx: 30, tick: 529000003 });
    // A meteor, and an arrow striking: effects in metres.
    expect(ticks[4]!.meteors).toEqual([{ id: 3, x: -6, z: 6, ticksLeft: 20, fallTicks: 20, team: 1, radius: 4, tick: 529000004 }]);
    expect(ticks[4]!.events).toEqual([{ kind: 3, x: 7, y: 1.3, z: 0, size: 12 }]);
    // The bot riding along with you: you are its host, and it was hurt.
    expect(ticks[5]!.peers.find((p) => p.id === -1000002)!.p).toMatchObject({ mode: 'ride', seat: 1, host: ME, hp: 92.5 });
    // A hit told to you, about yourself.
    expect(ticks[6]!.events).toEqual([{ kind: 4 | (1 << 4) | (2 << 6), x: 5, y: 1.4, z: -2, size: 15 }]);
    // The slime's behaviour clock runs on between updates, so it comes every tick with its progress.
    expect(ticks.map((t) => t!.actors[0].progress)).toEqual([0, 3, 6, 9, 12, 15, 18, 21].map((f) => f / 60));
  });

  it('sends those further off at their own rate, and keeps them in sight between', () => {
    const ticks = play('near, middle and far');
    const last = ticks[ticks.length - 1]!;
    const every = new Map<number, number>();
    for (const t of ticks) for (const p of t!.peers) every.set(p.id, p.every);
    expect([...new Set(every.values())].sort((a, b) => a - b)).toEqual([1, 4, 20]);
    // On a tick a middle or far one isn't refreshed, it's kept: still in sight.
    const kept = new Set(ticks.flatMap((t) => t!.kept ?? []));
    for (const [id, e] of every) if (e > 1) expect(kept.has(id), `${id}`).toBe(true);
    expect(last.kept!.length + last.peers.length).toBe(every.size);
  });

  it('gives a cart whose owner is out of sight to an owner with nobody to draw', () => {
    const ticks = play('a cart whose owner is away');
    const owner = ticks[0]!.peers.find((p) => p.id === 9)!;
    expect(owner).toMatchObject({ hidden: true, name: '' });
    expect(owner.p.vehicles).toEqual([expect.objectContaining({ id: 2, def: [...VEHICLES, ...MOUNTS][1].id, x: 6, z: 3, speed: 1 })]);
    expect(owner.p.pos).toMatchObject({ x: 6, z: 3 });
    // Moving on: the cart refreshed, its owner still nobody to draw.
    expect((ticks[3]!.peers[0].p.vehicles as Array<{ x: number }>)[0].x).toBe(7.5);
  });

  it('drops what the server will count as lost, and goes on', () => {
    const ticks = play('a bad road');
    expect(ticks.filter((t) => t === null).length).toBeGreaterThan(0);
    expect(ticks.filter((t) => t !== null).length).toBeGreaterThan(10);
  });
});
