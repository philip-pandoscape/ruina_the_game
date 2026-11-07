import data from '../../shared/shipyard.json' with { type: 'json' };

// Ship designs built at slipways (shared/shipyard.json).

export interface ShipStageDef {
  name: string;
  needs: Record<string, number>;
  labor: number;
  desc: string;
  /** How far above the waterline the hull is drawn once this stage is done. */
  reveal: number;
}

export interface ShipDesignDef {
  id: string;
  name: string;
  vehicle: string;
  deed: string;
  design: string;
  stages: ShipStageDef[];
}

export const SHIP_DESIGNS = data.designs as unknown as ShipDesignDef[];

export function shipDesign(id: string): ShipDesignDef {
  const d = SHIP_DESIGNS.find((x) => x.id === id);
  if (!d) throw new Error(`unknown ship design "${id}"`);
  return d;
}
