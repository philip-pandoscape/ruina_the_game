import data from '../../shared/trade.json' with { type: 'json' };

// Pack running, labor and money, as content (shared/trade.json).

export interface PackDef {
  id: string;
  name: string;
  icon: string;
  /** The place whose workbench makes it. It sells for nothing there. */
  origin: string;
  /** Copper paid at a route factor of 1, full demand and fresh. */
  base: number;
  labor: number;
  /** Copper charged by the workbench to make one. */
  fee: number;
  inputs: Array<{ item: string; n: number }>;
  look: string;
  /** 'trade' packs sell at another town's trader; 'material' ones are hauled to a building site. */
  kind?: string;
}

export interface RouteDef {
  from: string;
  to: string;
  factor: number;
  /** Charter Seals paid on top, per pack. */
  seals: number;
}

export const CLOCK = data.clock;
export const LABOR = data.labor;
export const CARRY = data.carry;
export const DEMAND = data.demand;
export const FRESHNESS = data.freshness;
export const PACKS = data.packs as unknown as PackDef[];
export const CONTRACTS = data.contracts as { perOutpost: number; maxActive: number; refreshSeconds: number; durationSeconds: number; count: [number, number]; sealsPerPack: number; coinBonus: number };
export const PLACES = data.places;
export const ROUTES = data.routes as unknown as RouteDef[];

const PACK = new Map(PACKS.map((p) => [p.id, p]));

export function packDef(id: string): PackDef {
  const p = PACK.get(id);
  if (!p) throw new Error(`unknown trade pack "${id}"`);
  return p;
}

export const route = (from: string, to: string): RouteDef | undefined => ROUTES.find((r) => r.from === from && r.to === to);
export const placeName = (id: string): string => PLACES.find((p) => p.id === id)?.name ?? id;

/** Copper as "1g 23s 45c", leaving out the empty denominations. */
export function formatCoins(copper: number): string {
  const c = Math.max(0, Math.round(copper));
  const g = Math.floor(c / 10000);
  const s = Math.floor((c % 10000) / 100);
  const k = c % 100;
  const parts: string[] = [];
  if (g) parts.push(`${g}g`);
  if (s || g) parts.push(`${s}s`);
  parts.push(`${k}c`);
  return parts.join(' ');
}
