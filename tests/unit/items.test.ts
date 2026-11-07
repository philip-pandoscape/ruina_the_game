import { expect, test } from 'vitest';
import { CATEGORIES, ITEMS } from '../../src/content/items';

// What items do comes from their data, not from their ids in the rules: where a placeable goes and
// what using it tells you, the rare finds in a felled tree or at a gathering spot, where a crafter's
// pack comes from, how much labor a tonic can top you up to. The rules are the engine's, and their
// tests are beside them (crates/engine/src/life: interact.rs, farming.rs, trade.rs). Here, what the
// content alone says: what each category of item is called.

test("every item's category is named, as a heading too, and those used say how", () => {
  for (const it of ITEMS) {
    const c = CATEGORIES[it.cat];
    expect(c?.name, `${it.id}: ${it.cat}`).toBeTruthy();
    expect(c.group).toBeTruthy();
  }
  for (const cat of ['seed', 'placeable', 'glider', 'deed', 'mount', 'consumable'] as const) expect(CATEGORIES[cat].verb, cat).toBeTruthy();
});
