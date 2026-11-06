import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { RULES, ruleFor, usedIn } from '../../src/assets/catalog';
import { Loader, type Need } from '../../src/assets/loader';
import { assetFiles } from '../../tools/assets/manifest';

// The asset manifest's source (src/assets/catalog.ts) describes every file the game ships, and the
// loader (src/assets/loader.ts) fetches the most needed first: docs/assets.md.

const files = assetFiles(process.cwd());

describe('the catalogue', () => {
  test('says what every file in the asset folders is, and every rule names a file', () => {
    expect(files.length).toBeGreaterThan(150);
    expect(
      files.filter((f) => !ruleFor(f.id)).map((f) => `${f.path}: no rule in src/assets/catalog.ts names ${f.id}`),
      'a new file needs a rule',
    ).toEqual([]);
    const used = new Set(files.map((f) => ruleFor(f.id)));
    expect(RULES.filter((r) => !used.has(r)).map((r) => `${r.match}: names no file`)).toEqual([]);
  });

  test('names each file once', () => {
    const seen = new Map<string, string>();
    const twice: string[] = [];
    for (const f of files) {
      const other = seen.get(f.id);
      if (other) twice.push(`${f.path} and ${other} are both ${f.id}`);
      seen.set(f.id, f.path);
    }
    expect(twice).toEqual([]);
  });

  test('names only zones the game has', () => {
    const zones = readdirSync('shared/zones').map((f) => f.replace(/\.json$/, ''));
    const dungeons = (JSON.parse(readFileSync('shared/dungeons.json', 'utf8')) as { dungeons: Array<{ id: string }> }).dungeons.map((d) => d.id);
    const known = new Set(['front', '*', 'dev', ...zones, ...dungeons]);
    expect(RULES.flatMap((r) => r.zones.filter((z) => !known.has(z)).map((z) => `${r.match}: ${z}`))).toEqual([]);
  });

  test('puts the hero, their weapons and the typefaces in the first download, and the island after it', () => {
    const zonesOf = (id: string) => ruleFor(id)?.zones ?? [];
    for (const id of ['models/hero', 'models/weapon_sword', 'models/hero_walk', 'fonts/pagella-400']) expect(usedIn(zonesOf(id), 'front'), id).toBe(true);
    for (const id of ['village/kit', 'ground/grass', 'models/windmill', 'models/hero_moves_meshy']) expect(usedIn(zonesOf(id), 'front'), id).toBe(false);
    expect(usedIn(zonesOf('models/hero'), 'goblinsDread')).toBe(true);
    expect(usedIn(zonesOf('ground/grass'), 'emberholm')).toBe(true);
  });
});

/** A loader over made-up files, whose loads finish when a test says. */
function rig(atOnce = 2) {
  const sizes: Record<string, number> = { a: 100, b: 200, c: 300, d: 400, e: 500 };
  const loader = new Loader((id) => (id in sizes ? { url: `/${id}`, size: sizes[id] } : undefined), atOnce);
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  const load = (url: string) =>
    new Promise<string>((resolve) => {
      started.push(url.slice(1));
      finish.set(url.slice(1), () => resolve(url));
    });
  const want = (id: string, need: Need, at?: { x: number; z: number }) => loader.want(id, load, { need, at: at ? () => at : undefined });
  /** Lets the loader take its turn. */
  const turn = () => new Promise<void>((r) => setTimeout(r, 0));
  const done = async (id: string) => {
    finish.get(id)?.();
    await turn();
  };
  return { loader, started, want, turn, done };
}

describe('the loader', () => {
  test('fetches the most needed first, a few at a time', async () => {
    const { started, want, turn, done } = rig(2);
    void want('a', 'near');
    void want('b', 'zone');
    void want('c', 'front');
    void want('d', 'zone');
    await turn();
    expect(started).toEqual(['c', 'b']);
    await done('c');
    expect(started).toEqual(['c', 'b', 'd']);
    await done('b');
    await done('d');
    expect(started).toEqual(['c', 'b', 'd', 'a']);
  });

  test('fetches what stands nearest the camera first, and leaves what is past its reach until it comes near', async () => {
    const { loader, started, want, turn, done } = rig(1);
    loader.streamFrom(0, 0, 100);
    void want('a', 'near', { x: 90, z: 0 });
    void want('b', 'near', { x: 10, z: 0 });
    void want('c', 'near', { x: 500, z: 0 });
    await turn();
    expect(started).toEqual(['b']);
    expect(loader.pending()).toBe(2);
    await done('b');
    await done('a');
    expect(started).toEqual(['b', 'a']);
    // What is past the reach isn't counted as on its way, so a test waiting for the files settles.
    expect(loader.pending()).toBe(0);
    loader.streamFrom(450, 0, 100);
    await turn();
    expect(started).toEqual(['b', 'a', 'c']);
    expect(loader.pending()).toBe(1);
    // A file wanted in two places is as near as the nearer.
    await done('c');
    void want('d', 'near', { x: 900, z: 0 });
    await turn();
    expect(loader.pending()).toBe(0);
    void want('d', 'near', { x: 420, z: 0 });
    await turn();
    expect(started).toEqual(['b', 'a', 'c', 'd']);
  });

  test('fetches a file once, however many ask, and moves it up for a more urgent need', async () => {
    const { started, want, turn, done } = rig(1);
    void want('a', 'front');
    const first = want('b', 'near');
    void want('c', 'zone');
    const again = want('b', 'front');
    await turn();
    await done('a');
    expect(started).toEqual(['a', 'b']);
    await done('b');
    expect(await first).toBe('/b');
    expect(await again).toBe('/b');
  });

  test("counts bytes from the manifest's sizes, and refuses a file it doesn't have", async () => {
    const { loader, want, turn, done } = rig(4);
    const seen: Array<{ wanted: number; done: number }> = [];
    loader.onLoaded((p) => seen.push(p));
    void want('a', 'zone');
    void want('e', 'zone');
    await turn();
    await done('e');
    expect(loader.loaded()).toEqual({ wanted: 600, done: 500 });
    await done('a');
    expect(seen.at(-1)).toEqual({ wanted: 600, done: 600 });
    expect(loader.arrived().sort()).toEqual(['a', 'e']);
    await expect(want('nope', 'zone')).rejects.toThrow('no asset nope');
  });
});
