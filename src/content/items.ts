import data from '../../shared/items.json' with { type: 'json' };

// Bag items, vendors and workbench recipes (shared/items.json).

/** What using an item does is the rules' for its category (src/sim/life/interact.ts useItem): a new one is new code. */
export type ItemCat = 'seed' | 'produce' | 'material' | 'consumable' | 'placeable' | 'glider' | 'deed' | 'mount';

/** What a category of item is called: in a tooltip, as a heading, and using one in the bag (none: it isn't used). */
export interface ItemCategory {
  name: string;
  group: string;
  verb?: string;
}

/**
 * Where a placeable is placed: anywhere on open, level ground (a farm plot's scarecrow), on an empty
 * house plot (a house blueprint), or at a slipway (a ship design).
 */
export type PlaceOn = 'ground' | 'housePlot' | 'slipway';

export interface ItemDef {
  id: string;
  name: string;
  icon: string;
  cat: ItemCat;
  stack: number;
  /** What the grocer would pay you at full rate; vendors apply their own buy rate. */
  value: number;
  desc: string;
  plants?: string;
  /** Livestock: the animal this young one grows into. */
  raises?: string;
  /** A placeable: what it places (a house blueprint, a ship design, a scarecrow), where (`placeOn`), and what using it tells you (`hint`). */
  places?: string;
  placeOn?: PlaceOn;
  hint?: string;
  glider?: string;
  vehicle?: string;
  mount?: string;
  use?: { labor?: number };
}

export interface VendorDef {
  npc: string;
  name: string;
  sells: Array<{ item: string; price: number; seals?: number }>;
  buys: string[];
  buyRate: number;
}

export interface RecipeDef {
  id: string;
  /** A workbench id from the zone, or an NPC id for a crafter who builds it for you. */
  bench: string;
  inputs?: Array<{ item: string; n: number }>;
  coins?: number;
  labor?: number;
  makes: { pack?: string; item?: string; n?: number };
}

export const BAG_SLOTS = data.bagSlots;
export const CATEGORIES = data.categories as Record<ItemCat, ItemCategory>;
export const ITEMS = data.items as unknown as ItemDef[];
export const VENDORS = data.vendors as unknown as VendorDef[];
export const RECIPES = data.recipes as unknown as RecipeDef[];

const BY_ID = new Map(ITEMS.map((i) => [i.id, i]));

export function itemDef(id: string): ItemDef {
  const d = BY_ID.get(id);
  if (!d) throw new Error(`unknown item "${id}"`);
  return d;
}

/** Whether an item claims a house plot (a house blueprint); false for one that isn't there. */
export const claimsPlot = (id: string): boolean => BY_ID.get(id)?.placeOn === 'housePlot';

export const vendorFor = (npc: string): VendorDef | undefined => VENDORS.find((v) => v.npc === npc);
export const recipesAt = (bench: string): RecipeDef[] => RECIPES.filter((r) => r.bench === bench);
export const recipe = (id: string): RecipeDef | undefined => RECIPES.find((r) => r.id === id);
