// A fixture world of the tests' played in place of the shipped one (`?fixture=world`, `?fixture=far`:
// tests/fixtures/world/<name>.json and the regions it names in tests/fixtures/world/regions/), for
// the tests and for looking at it on a development server, which serves the project's files. Given
// to the page's engine and to its worker before either reads anything (useContent), so both play the
// same world; a region it names that has no fixture file (Emberholm) is the shipped one.

const ROOT = '/tests/fixtures/world';

/** The bundles to give the engines in place of shared/: the world, and its fixture regions' recipes (null if there's no such fixture). */
export async function fixtureWorld(name: string): Promise<Record<string, unknown> | null> {
  if (!/^[a-z]+$/.test(name)) return null;
  const world = await fetch(`${ROOT}/${name}.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (!world) return null;
  const bundles: Record<string, unknown> = { 'world.json': world };
  for (const r of (world as { regions: Array<{ id: string }> }).regions) {
    const recipe = await fetch(`${ROOT}/regions/${r.id}.json`)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
    if (recipe) bundles[`regions/${r.id}.json`] = recipe;
  }
  return bundles;
}
