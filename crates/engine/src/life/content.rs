//! The open world's content, read from the same shared/*.json the browser reads
//! (src/content/*.ts): items, vendors and recipes; trade packs, routes, labor and money; crops,
//! animals, gathering and weather; vehicles, mounts and gliders; houses, ships, structures; quests;
//! and the numbers for getting around on foot, in water and in the air.
//!
//! Lookups by id never panic: anything a browser names that doesn't exist gets a harmless
//! placeholder.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use crate::jsmath::js_round;
use serde::Deserialize;

fn load<T: for<'de> Deserialize<'de>>(name: &str, text: &str) -> T {
    serde_json::from_str(text).unwrap_or_else(|e| panic!("shared/{name} doesn't match crates/engine/src/life/content.rs: {e}"))
}

// ---------- shared/items.json ----------

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Use {
    pub labor: Option<f64>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ItemDef {
    pub id: String,
    pub name: String,
    pub icon: String,
    /// seed, produce, material, consumable, placeable, glider, deed or mount.
    pub cat: String,
    pub stack: i64,
    /// What the grocer would pay you at full rate.
    pub value: f64,
    pub plants: Option<String>,
    /// Livestock: the animal this young one grows into.
    pub raises: Option<String>,
    /// A placeable: what it places (a house blueprint, a ship design, a scarecrow), where
    /// (`place_on`: "ground", "plot" (a house plot) or "slipway") and what using it tells you (`hint`).
    pub places: Option<String>,
    pub place_on: Option<String>,
    pub hint: Option<String>,
    pub glider: Option<String>,
    pub vehicle: Option<String>,
    pub mount: Option<String>,
    #[serde(rename = "use")]
    pub use_: Option<Use>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Offer {
    pub item: String,
    pub price: f64,
    pub seals: Option<f64>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct VendorDef {
    pub npc: String,
    pub name: String,
    pub sells: Vec<Offer>,
    pub buys: Vec<String>,
    pub buy_rate: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ItemCount {
    pub item: String,
    pub n: i64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Makes {
    pub pack: Option<String>,
    pub item: Option<String>,
    pub n: Option<i64>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct RecipeDef {
    pub id: String,
    /// A workbench id from the zone, or an NPC id for a crafter who builds it for you.
    pub bench: String,
    pub inputs: Option<Vec<ItemCount>>,
    pub coins: Option<f64>,
    pub labor: Option<f64>,
    pub makes: Makes,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemsFile {
    bag_slots: usize,
    items: Vec<ItemDef>,
    vendors: Vec<VendorDef>,
    recipes: Vec<RecipeDef>,
}

fn items_file() -> &'static ItemsFile {
    static F: OnceLock<ItemsFile> = OnceLock::new();
    F.get_or_init(|| load("items.json", crate::bundles::bundle("items.json", include_str!("../../../../shared/items.json"))))
}

pub fn bag_slots() -> usize {
    items_file().bag_slots
}

pub fn items() -> &'static [ItemDef] {
    &items_file().items
}

pub fn has_item_def(id: &str) -> bool {
    items().iter().any(|i| i.id == id)
}

/// Whether an item claims a house plot (a house blueprint).
pub fn claims_plot(id: &str) -> bool {
    item_def(id).place_on.as_deref() == Some("plot")
}

/// The item, or a placeholder for one that doesn't exist.
pub fn item_def(id: &str) -> &'static ItemDef {
    static UNKNOWN: OnceLock<ItemDef> = OnceLock::new();
    items().iter().find(|i| i.id == id).unwrap_or_else(|| {
        UNKNOWN.get_or_init(|| ItemDef { id: "unknown".into(), name: "Unknown".into(), cat: "unknown".into(), stack: 1, ..Default::default() })
    })
}

pub fn vendor_for(npc: &str) -> Option<&'static VendorDef> {
    items_file().vendors.iter().find(|v| v.npc == npc)
}

pub fn recipes() -> &'static [RecipeDef] {
    &items_file().recipes
}

/// The recipes made at a bench (recipesAt in src/content/recipes.ts).
pub fn recipes_at(bench: &str) -> impl Iterator<Item = &'static RecipeDef> {
    recipes().iter().filter(move |r| r.bench == bench)
}

pub fn recipe(id: &str) -> Option<&'static RecipeDef> {
    recipes().iter().find(|r| r.id == id)
}

// ---------- shared/trade.json ----------

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Clock {
    pub offline_factor: f64,
    pub max_offline_seconds: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Labor {
    pub max: f64,
    pub start: f64,
    pub per_minute: f64,
    pub offline_per_minute: f64,
    pub rest_multiplier: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Carry {
    pub speed_factor: f64,
    pub jump_factor: f64,
    pub swim_factor: f64,
    pub pickup_range: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Demand {
    pub start: f64,
    pub max: f64,
    pub min: f64,
    pub drop_per_sale: f64,
    pub recover_per_minute: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Freshness {
    pub bonus: f64,
    pub bonus_seconds: f64,
    pub stale_seconds: f64,
    pub penalty: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct PackDef {
    pub id: String,
    pub name: String,
    pub icon: String,
    /// The place whose workbench makes it. It sells for nothing there.
    pub origin: String,
    /// Copper paid at a route factor of 1, full demand and fresh.
    pub base: f64,
    pub labor: f64,
    /// Copper charged by the workbench to make one.
    pub fee: f64,
    pub inputs: Vec<ItemCount>,
    /// "trade" or "material".
    pub kind: Option<String>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct RouteDef {
    pub from: String,
    pub to: String,
    pub factor: f64,
    /// Charter Seals paid on top, per pack.
    pub seals: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct PlaceDef {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Contracts {
    pub per_outpost: usize,
    pub max_active: usize,
    pub refresh_seconds: f64,
    pub duration_seconds: f64,
    pub count: [i64; 2],
    pub seals_per_pack: f64,
    pub coin_bonus: f64,
}

#[derive(Deserialize)]
struct TradeFile {
    clock: Clock,
    labor: Labor,
    carry: Carry,
    demand: Demand,
    freshness: Freshness,
    packs: Vec<PackDef>,
    places: Vec<PlaceDef>,
    routes: Vec<RouteDef>,
    contracts: Contracts,
}

fn trade_file() -> &'static TradeFile {
    static F: OnceLock<TradeFile> = OnceLock::new();
    F.get_or_init(|| load("trade.json", crate::bundles::bundle("trade.json", include_str!("../../../../shared/trade.json"))))
}

pub fn clock() -> &'static Clock {
    &trade_file().clock
}
pub fn labor() -> &'static Labor {
    &trade_file().labor
}
pub fn carry() -> &'static Carry {
    &trade_file().carry
}
pub fn demand() -> &'static Demand {
    &trade_file().demand
}
pub fn freshness() -> &'static Freshness {
    &trade_file().freshness
}
pub fn contracts() -> &'static Contracts {
    &trade_file().contracts
}
pub fn packs() -> &'static [PackDef] {
    &trade_file().packs
}
pub fn places() -> &'static [PlaceDef] {
    &trade_file().places
}
pub fn routes() -> &'static [RouteDef] {
    &trade_file().routes
}

pub fn has_pack_def(id: &str) -> bool {
    packs().iter().any(|p| p.id == id)
}

/// The pack, or a placeholder for one that doesn't exist.
pub fn pack_def(id: &str) -> &'static PackDef {
    static UNKNOWN: OnceLock<PackDef> = OnceLock::new();
    packs()
        .iter()
        .find(|p| p.id == id)
        .unwrap_or_else(|| UNKNOWN.get_or_init(|| PackDef { id: "unknown".into(), name: "Unknown pack".into(), ..Default::default() }))
}

pub fn route(from: &str, to: &str) -> Option<&'static RouteDef> {
    routes().iter().find(|r| r.from == from && r.to == to)
}

pub fn place_name(id: &str) -> String {
    places().iter().find(|p| p.id == id).map(|p| p.name.clone()).unwrap_or_else(|| id.to_string())
}

/// Copper as "1g 23s 45c", leaving out the empty denominations (src/content/trade.ts).
pub fn format_coins(copper: f64) -> String {
    let c = js_round(copper).max(0.0) as i64;
    let (g, s, k) = (c / 10000, (c % 10000) / 100, c % 100);
    let mut parts = Vec::new();
    if g != 0 {
        parts.push(format!("{g}g"));
    }
    if s != 0 || g != 0 {
        parts.push(format!("{s}s"));
    }
    parts.push(format!("{k}c"));
    parts.join(" ")
}

// ---------- shared/farming.json ----------

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Water {
    pub boost: f64,
    pub labor: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Rain {
    pub boost: f64,
    pub first_after: f64,
    pub gap_seconds: [f64; 2],
    pub lasts_seconds: [f64; 2],
}

/// A tree felled: what it gives, for what labor, what that counts as for a quest (a gathering kind),
/// and what rare thing may be in it.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Chop {
    pub item: String,
    #[serde(rename = "yield")]
    pub yield_: [i64; 2],
    pub labor: f64,
    pub kind: String,
    pub rare: Option<Rare>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CropDef {
    pub id: String,
    pub name: String,
    /// "crop" or "tree".
    pub kind: String,
    pub climate: String,
    pub icon: String,
    pub grow_seconds: f64,
    pub stages: i64,
    /// Trees that fruit again: seconds from picked back to ripe.
    pub regrow_seconds: Option<f64>,
    pub seed: String,
    pub produce: Option<String>,
    #[serde(rename = "yield")]
    pub yield_: [i64; 2],
    pub seed_chance: f64,
    pub harvest_labor: f64,
    pub plant_labor: f64,
    pub chop: Option<Chop>,
}

/// Something rare found now and then (in a felled tree, at a gathering spot): the item, the toast
/// that tells you, and what it looks like where it was found ("thunder": a lightning strike).
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Rare {
    pub item: String,
    pub chance: f64,
    pub toast: String,
    pub effect: Option<String>,
}

/// What a resource node gives when worked.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct GatherDef {
    pub item: String,
    pub n: [i64; 2],
    pub labor: f64,
    pub verb: String,
    pub respawn: f64,
    pub kind: String,
    pub rare: Option<Rare>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AnimalDef {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub young: String,
    pub item: String,
    pub grow_seconds: f64,
    pub feed: String,
    pub feed_n: i64,
    /// How long one feeding lasts.
    pub feed_seconds: f64,
    pub produce: String,
    #[serde(rename = "yield")]
    pub yield_: [i64; 2],
    pub produce_seconds: f64,
    pub collect_labor: f64,
    pub verb: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Farm {
    pub cell: f64,
    pub scarecrow_cells: i64,
    pub max_scarecrows: usize,
    pub climate_match: f64,
    pub climate_mismatch: f64,
    pub water: Water,
    pub rain: Rain,
}

#[derive(Deserialize)]
struct FarmingFile {
    #[serde(flatten)]
    farm: Farm,
    crops: Vec<CropDef>,
    gathering: BTreeMap<String, GatherDef>,
    #[serde(default)]
    animals: Vec<AnimalDef>,
}

fn farming_file() -> &'static FarmingFile {
    static F: OnceLock<FarmingFile> = OnceLock::new();
    F.get_or_init(|| load("farming.json", crate::bundles::bundle("farming.json", include_str!("../../../../shared/farming.json"))))
}

pub fn farm() -> &'static Farm {
    &farming_file().farm
}
pub fn crops() -> &'static [CropDef] {
    &farming_file().crops
}
pub fn gathering() -> &'static BTreeMap<String, GatherDef> {
    &farming_file().gathering
}
pub fn animals() -> &'static [AnimalDef] {
    &farming_file().animals
}

/// The crop, or a placeholder for one that doesn't exist.
pub fn crop_def(id: &str) -> &'static CropDef {
    static UNKNOWN: OnceLock<CropDef> = OnceLock::new();
    crops()
        .iter()
        .find(|c| c.id == id)
        .unwrap_or_else(|| UNKNOWN.get_or_init(|| CropDef { id: "unknown".into(), name: "Unknown".into(), grow_seconds: 1e9, stages: 2, ..Default::default() }))
}

/// The animal, or a placeholder for one that doesn't exist.
pub fn animal_def(id: &str) -> &'static AnimalDef {
    static UNKNOWN: OnceLock<AnimalDef> = OnceLock::new();
    animals().iter().find(|a| a.id == id).unwrap_or_else(|| {
        UNKNOWN.get_or_init(|| AnimalDef {
            id: "unknown".into(),
            name: "Unknown".into(),
            grow_seconds: 1e9,
            produce_seconds: 1e9,
            feed_seconds: 1.0,
            ..Default::default()
        })
    })
}

/// Growth-rate multiplier for a crop in a zone's climate.
pub fn climate_factor(crop: &CropDef, climate: &str) -> f64 {
    if crop.climate == climate { farm().climate_match } else { farm().climate_mismatch }
}

// ---------- shared/traversal.json ----------

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Ground {
    pub max_slope: f64,
    pub step_up: f64,
    /// How high a deck (a pier, the glider launch) you walk straight up onto: they are built for it.
    pub deck_step: f64,
    /// A deck at least this far above your feet has room to walk or swim under; lower ones you
    /// can't step onto are solid from the side.
    pub deck_headroom: f64,
    pub snap_down: f64,
    pub wade_depth: f64,
    pub wade_speed: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Swim {
    pub depth: f64,
    pub float: f64,
    pub speed: f64,
    pub sprint_speed: f64,
    pub accel: f64,
    pub turn_speed: f64,
    pub climb_out: f64,
    pub splash_speed: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Glide {
    pub vertical_ease: f64,
    pub turn_ease: f64,
    pub max_bank: f64,
    pub crash_speed: f64,
    pub land_keep: f64,
    pub open_frames: i32,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Storm {
    pub from_depth: f64,
    pub full_depth: f64,
    /// [boat length up to, hit points a second at full storm].
    pub hull_damage: Vec<[f64; 2]>,
    pub buffet: f64,
    pub repair_seconds: f64,
}

#[derive(Deserialize)]
struct TraversalFile {
    ground: Ground,
    swim: Swim,
    glide: Glide,
    storm: Storm,
}

fn traversal_file() -> &'static TraversalFile {
    static F: OnceLock<TraversalFile> = OnceLock::new();
    F.get_or_init(|| load("traversal.json", crate::bundles::bundle("traversal.json", include_str!("../../../../shared/traversal.json"))))
}

pub fn ground() -> &'static Ground {
    &traversal_file().ground
}
pub fn swim() -> &'static Swim {
    &traversal_file().swim
}
pub fn glide() -> &'static Glide {
    &traversal_file().glide
}
pub fn storm() -> &'static Storm {
    &traversal_file().storm
}

// ---------- shared/vehicles.json ----------

#[derive(Deserialize, Clone, Copy, Debug, Default)]
#[serde(default)]
pub struct Anchor {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// Anything you can ride: a cart or car ("wheeled"), a boat, or a mount. One shape for all three,
/// with the fields the others don't use left at zero (src/content/vehicles.ts reads the same file).
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RideableDef {
    pub id: String,
    pub name: String,
    pub icon: String,
    /// "wheeled", "boat" or "mount".
    pub class: String,
    pub length: f64,
    pub width: f64,
    pub height: f64,
    /// Collision radius used against obstacles and other vehicles.
    pub radius: f64,
    pub hp: f64,
    pub seats: Vec<Anchor>,
    /// Trade-pack slots.
    pub cargo: Vec<Anchor>,
    // Wheeled and boats.
    pub max_speed: f64,
    pub reverse_speed: f64,
    pub accel: f64,
    pub brake: f64,
    pub drag: f64,
    pub rolling: f64,
    pub turn_rate: f64,
    pub grip: f64,
    // Wheeled.
    pub offroad: f64,
    pub drift_grip: f64,
    pub climb: f64,
    pub boost_speed: f64,
    // Boats.
    pub draft: f64,
    pub turn_at_rest: f64,
    pub sail: f64,
    // Mounts.
    pub walk_speed: f64,
    pub run_speed: f64,
    pub gallop_speed: f64,
    pub pack_speed: f64,
    pub jump: f64,
    pub can_carry_pack: bool,
}

impl RideableDef {
    pub fn is_boat(&self) -> bool {
        self.class == "boat"
    }
    pub fn is_wheeled(&self) -> bool {
        self.class == "wheeled"
    }
    pub fn is_mount(&self) -> bool {
        self.class == "mount"
    }
}

#[derive(Deserialize, Clone, Copy, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Gust {
    pub speed: f64,
    pub lift: f64,
    pub cooldown_seconds: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct GliderDef {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub span: f64,
    /// Airspeed with the stick neutral, pushed forward (dive) and pulled back (flare).
    pub cruise_speed: f64,
    pub dive_speed: f64,
    pub flare_speed: f64,
    /// Sink rates (m/s, positive is down) at those three attitudes.
    pub sink: f64,
    pub dive_sink: f64,
    pub flare_sink: f64,
    /// Below this airspeed it stalls and drops.
    pub stall_speed: f64,
    pub turn_rate: f64,
    pub speed_ease: f64,
    pub zoom_lift: f64,
    /// You cannot open it lower than this above the ground.
    pub min_height: f64,
    pub gust: Option<Gust>,
}

#[derive(Deserialize)]
struct VehiclesFile {
    vehicles: Vec<RideableDef>,
    mounts: Vec<RideableDef>,
    gliders: Vec<GliderDef>,
}

fn vehicles_file() -> &'static VehiclesFile {
    static F: OnceLock<VehiclesFile> = OnceLock::new();
    F.get_or_init(|| load("vehicles.json", crate::bundles::bundle("vehicles.json", include_str!("../../../../shared/vehicles.json"))))
}

/// A vehicle's or mount's place in the vehicles then the mounts (src/content/vehicles.ts lists them
/// the same way), as the wire carries it (crates/wire).
pub fn rideable_index(id: &str) -> Option<usize> {
    let f = vehicles_file();
    f.vehicles.iter().chain(f.mounts.iter()).position(|d| d.id == id)
}

/// A glider's place in the gliders' list, as the wire carries it.
pub fn glider_index(id: &str) -> Option<usize> {
    vehicles_file().gliders.iter().position(|g| g.id == id)
}

/// The vehicle or mount, or a placeholder (a small cart) for one that doesn't exist.
pub fn rideable(id: &str) -> &'static RideableDef {
    static UNKNOWN: OnceLock<RideableDef> = OnceLock::new();
    let f = vehicles_file();
    f.vehicles.iter().chain(f.mounts.iter()).find(|d| d.id == id).unwrap_or_else(|| {
        UNKNOWN.get_or_init(|| RideableDef {
            id: "unknown".into(),
            name: "Unknown".into(),
            class: "wheeled".into(),
            length: 2.0,
            width: 1.5,
            height: 1.5,
            radius: 1.0,
            hp: 1.0,
            seats: vec![Anchor::default()],
            ..Default::default()
        })
    })
}

/// The glider, or a placeholder (one that cannot open: it needs to be higher than anything).
pub fn glider_def(id: &str) -> &'static GliderDef {
    static UNKNOWN: OnceLock<GliderDef> = OnceLock::new();
    vehicles_file().gliders.iter().find(|g| g.id == id).unwrap_or_else(|| {
        UNKNOWN.get_or_init(|| GliderDef {
            id: "unknown".into(),
            name: "Unknown".into(),
            min_height: 1e9,
            cruise_speed: 1.0,
            flare_speed: 1.0,
            ..Default::default()
        })
    })
}

// ---------- shared/housing.json ----------

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct StageDef {
    pub name: String,
    /// Material packs (by pack id) the stage consumes. In file order.
    pub needs: indexmap_like::Ordered,
    pub labor: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Perks {
    pub storage_slots: usize,
    pub rest_labor_multiplier: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct BlueprintDef {
    pub id: String,
    pub name: String,
    pub structure: String,
    pub plot: f64,
    pub tax_per_day: f64,
    pub grace_days: f64,
    pub stages: Vec<StageDef>,
    pub perks: Perks,
}

/// What becomes of a house whose tax goes unpaid (housing.json's `neglect`).
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Neglect {
    /// Days after what's paid runs out that the house comes down and its plot is free.
    pub demolish_after_days: f64,
}

#[derive(Deserialize)]
struct HousingFile {
    blueprints: Vec<BlueprintDef>,
    neglect: Neglect,
}

fn housing_file() -> &'static HousingFile {
    static F: OnceLock<HousingFile> = OnceLock::new();
    F.get_or_init(|| load("housing.json", crate::bundles::bundle("housing.json", include_str!("../../../../shared/housing.json"))))
}

pub fn blueprints() -> &'static [BlueprintDef] {
    &housing_file().blueprints
}

pub fn neglect() -> &'static Neglect {
    &housing_file().neglect
}

pub fn has_blueprint(id: &str) -> bool {
    blueprints().iter().any(|b| b.id == id)
}

/// The blueprint, or the first one for an id that doesn't exist.
pub fn blueprint_def(id: &str) -> &'static BlueprintDef {
    blueprints().iter().find(|b| b.id == id).unwrap_or(&blueprints()[0])
}

// ---------- shared/shipyard.json ----------

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ShipStageDef {
    pub name: String,
    pub needs: indexmap_like::Ordered,
    pub labor: f64,
    pub reveal: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ShipDesignDef {
    pub id: String,
    pub name: String,
    pub vehicle: String,
    pub deed: String,
    pub design: String,
    pub stages: Vec<ShipStageDef>,
}

#[derive(Deserialize)]
struct ShipyardFile {
    designs: Vec<ShipDesignDef>,
}

fn shipyard_file() -> &'static ShipyardFile {
    static F: OnceLock<ShipyardFile> = OnceLock::new();
    F.get_or_init(|| load("shipyard.json", crate::bundles::bundle("shipyard.json", include_str!("../../../../shared/shipyard.json"))))
}

pub fn ship_designs() -> &'static [ShipDesignDef] {
    &shipyard_file().designs
}

/// The design, or the first one for an id that doesn't exist.
pub fn ship_design(id: &str) -> &'static ShipDesignDef {
    ship_designs().iter().find(|d| d.id == id).unwrap_or(&ship_designs()[0])
}

pub fn design_for_item(item: &str) -> Option<&'static ShipDesignDef> {
    ship_designs().iter().find(|d| d.design == item)
}

// ---------- shared/structures.json ----------

#[derive(Deserialize, Clone, Copy, Debug, Default)]
#[serde(default)]
pub struct Spot {
    pub x: f64,
    pub z: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct StructureDef {
    pub id: String,
    pub name: String,
    pub w: f64,
    pub d: f64,
    pub h: f64,
    /// "box", "walls", "none" or "post".
    pub collider: String,
    pub collider_d: Option<f64>,
    pub collider_z: Option<f64>,
    pub r: Option<f64>,
    pub wall: Option<f64>,
    pub door: Option<f64>,
    pub floor: Option<f64>,
    pub deck: Option<f64>,
    pub interior: Option<BTreeMap<String, Spot>>,
    /// How the island sits it (open/generate.rs): `pad` false sets it on the ground as it lies;
    /// `sea_level` stands it at sea level; `clear_margin` is how far round it trees and rocks are
    /// kept off; `surface` is what the ground under it is made of.
    pub pad: Option<bool>,
    pub sea_level: Option<bool>,
    pub clear_margin: Option<f64>,
    pub surface: Option<String>,
}

/// A prop the island is dressed with (a lamp, a barrel, a fence): its footprint and how it blocks
/// you ("box", "post" of radius `r`, or "none").
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct PropDef {
    pub id: String,
    pub w: f64,
    pub d: f64,
    pub h: f64,
    pub collider: String,
    pub r: Option<f64>,
}

#[derive(Deserialize)]
struct StructuresFile {
    structures: Vec<StructureDef>,
    #[serde(default)]
    props: Vec<PropDef>,
}

fn structures_file() -> &'static StructuresFile {
    static F: OnceLock<StructuresFile> = OnceLock::new();
    F.get_or_init(|| load("structures.json", crate::bundles::bundle("structures.json", include_str!("../../../../shared/structures.json"))))
}

/// The structure, or a placeholder (1 m, no collider) for one that doesn't exist.
pub fn structure_def(id: &str) -> &'static StructureDef {
    static UNKNOWN: OnceLock<StructureDef> = OnceLock::new();
    structures_file().structures.iter().find(|s| s.id == id).unwrap_or_else(|| {
        UNKNOWN.get_or_init(|| StructureDef {
            id: "unknown".into(),
            name: "Unknown".into(),
            w: 1.0,
            d: 1.0,
            h: 1.0,
            collider: "none".into(),
            ..Default::default()
        })
    })
}

/// The prop, or a placeholder (1 m, no collider) for one that doesn't exist.
pub fn prop_def(id: &str) -> &'static PropDef {
    static UNKNOWN: OnceLock<PropDef> = OnceLock::new();
    structures_file()
        .props
        .iter()
        .find(|p| p.id == id)
        .unwrap_or_else(|| UNKNOWN.get_or_init(|| PropDef { id: "unknown".into(), w: 1.0, d: 1.0, h: 1.0, collider: "none".into(), r: None }))
}

// ---------- shared/quests.json ----------

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Objective {
    #[serde(rename = "type")]
    pub type_: String,
    pub n: Option<f64>,
    pub npc: Option<String>,
    pub place: Option<String>,
    pub r: Option<f64>,
    pub min_y: Option<f64>,
    pub crop: Option<String>,
    pub pack: Option<String>,
    pub outpost: Option<String>,
    pub vehicle: Option<String>,
    pub seconds: Option<f64>,
    /// defeat: what kind of creature.
    pub kind: Option<String>,
}

/// How many of an objective are needed (1 for one-off objectives like talking to someone).
pub fn objective_target(o: &Objective) -> f64 {
    if o.type_ == "glide" { o.seconds.unwrap_or(10.0) } else { o.n.unwrap_or(1.0) }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct QuestStep {
    pub text: String,
    pub objectives: Vec<Objective>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct QuestRewards {
    pub coins: Option<f64>,
    pub seals: Option<f64>,
    pub labor: Option<f64>,
    pub items: Option<Vec<ItemCount>>,
    pub equip_glider: Option<String>,
    /// Points to spend in the skill tree. Never kept: crate::life::progress counts them from the
    /// quests you've finished.
    pub skill_points: Option<u32>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct QuestDef {
    pub id: String,
    pub name: String,
    pub giver: String,
    pub after: Vec<String>,
    /// Starts by itself as soon as it is available, without talking to anyone.
    pub auto: Option<bool>,
    /// A milestone: starts by itself, quietly, and is done the moment its steps are, with nobody to
    /// hand it to. Kept with the quests so it can count anything a quest can.
    pub milestone: Option<bool>,
    pub steps: Vec<QuestStep>,
    pub turn_in: Option<String>,
    pub rewards: QuestRewards,
    /// Handed to you when you accept it.
    pub start_items: Option<Vec<ItemCount>>,
}

#[derive(Deserialize)]
struct QuestsFile {
    quests: Vec<QuestDef>,
}

fn quests_file() -> &'static QuestsFile {
    static F: OnceLock<QuestsFile> = OnceLock::new();
    F.get_or_init(|| load("quests.json", crate::bundles::bundle("quests.json", include_str!("../../../../shared/quests.json"))))
}

pub fn quests() -> &'static [QuestDef] {
    &quests_file().quests
}

pub fn has_quest(id: &str) -> bool {
    quests().iter().any(|q| q.id == id)
}

/// The quest, or a placeholder with no steps for one that doesn't exist.
pub fn quest_def(id: &str) -> &'static QuestDef {
    static UNKNOWN: OnceLock<QuestDef> = OnceLock::new();
    quests()
        .iter()
        .find(|q| q.id == id)
        .unwrap_or_else(|| UNKNOWN.get_or_init(|| QuestDef { id: "unknown".into(), name: "Unknown".into(), ..Default::default() }))
}

/// Maps whose order is the order they were written in the file (JavaScript's Object.entries).
pub mod indexmap_like {
    use serde::Deserialize;
    use serde::de::{Deserializer, MapAccess, Visitor};

    #[derive(Clone, Debug, Default)]
    pub struct Ordered(pub Vec<(String, i64)>);

    impl Ordered {
        pub fn iter(&self) -> impl Iterator<Item = (&str, i64)> {
            self.0.iter().map(|(k, v)| (k.as_str(), *v))
        }
        pub fn get(&self, key: &str) -> Option<i64> {
            self.0.iter().find(|(k, _)| k == key).map(|(_, v)| *v)
        }
    }

    impl<'de> Deserialize<'de> for Ordered {
        fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            struct V;
            impl<'de> Visitor<'de> for V {
                type Value = Ordered;
                fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                    f.write_str("a map of pack ids to counts")
                }
                fn visit_map<M: MapAccess<'de>>(self, mut m: M) -> Result<Ordered, M::Error> {
                    let mut out = Vec::new();
                    while let Some((k, v)) = m.next_entry::<String, i64>()? {
                        out.push((k, v));
                    }
                    Ok(Ordered(out))
                }
            }
            d.deserialize_map(V)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_the_content_loads() {
        assert!(bag_slots() > 0);
        assert!(!items().is_empty() && !recipes().is_empty() && vendor_for("mara").is_some());
        assert!(!packs().is_empty() && !routes().is_empty() && labor().max > 0.0);
        assert!(!crops().is_empty() && !gathering().is_empty() && farm().cell > 0.0);
        assert!(ground().max_slope > 0.0 && swim().depth > 0.0 && storm().hull_damage.len() == 3);
        assert!(rideable("farmCart").is_wheeled() && rideable("sloop").is_boat() && rideable("donkey").is_mount());
        assert!(glider_def("wayfarer").gust.is_some());
        assert!(!blueprints()[0].stages.is_empty() && !ship_designs().is_empty());
        assert_eq!(structure_def("cottage").collider, "walls");
        assert!(!quests().is_empty());
    }

    #[test]
    fn coins_read_like_the_browser_writes_them() {
        assert_eq!(format_coins(0.0), "0c");
        assert_eq!(format_coins(12345.0), "1g 23s 45c");
        assert_eq!(format_coins(150.0), "1s 50c");
        assert_eq!(format_coins(10000.0), "1g 0s 0c");
    }

    #[test]
    fn unknown_ids_are_harmless() {
        assert_eq!(item_def("no-such-thing").stack, 1);
        assert_eq!(rideable("no-such-thing").seats.len(), 1);
    }
}
