// Trade contracts, as the page reads them: each trading post posts a couple of requests for specific
// packs ("three Flax Bales within 25 minutes"). Take one on, fill it before it runs out, and the post
// pays bonus Charter Seals and coin on top of each pack's normal price. The engine offers, fills and
// pays them (crates/engine/src/life/contracts.rs).

export interface Contract {
  id: number;
  outpost: string;
  pack: string;
  count: number;
  delivered: number;
  bonusCoins: number;
  bonusSeals: number;
  /** World clock when it lapses (offered ones lapse too, and are replaced). */
  expires: number;
}

export interface ContractState {
  offered: Contract[];
  active: Contract[];
  nextRefresh: number;
}
