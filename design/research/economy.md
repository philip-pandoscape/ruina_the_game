# ArcheAge — Trade Packs, Commerce, Labor & the Player Economy

*Research brief for an original game with similar mechanics. Compiled 2026-11-03. Combat and classes are out of scope.*

**Version caveat.** The Western rules changed a lot between versions:

- Trion 1.x launch (Sept 2014)
- 2.x (2015–16)
- 3.5 "Erenor" trade overhaul (June 2017)
- *Unchained* buy-to-play servers (Oct 2019)
- Kakao Games (Dec 2021)
- Western shutdown on 27 June 2024 ([mein-mmo](https://mein-mmo.de/en/archeage-schliesst-server-free2play-mmorpg,1118902))

Numbers are tagged with their era. **(unverified)** means I could not confirm it from a reasonably primary source.

**Main sources:**

- The community wiki ([archeage.fandom.com](https://archeage.fandom.com/wiki/Trade_Packages)) and its mirror of the official patch notes ([/wiki/Updates](https://archeage.fandom.com/wiki/Updates)).
- Datamined in-game tooltips on [archeagecodex.com](https://archeagecodex.com/us/item/31857/).
- Press from the time (Massively/Engadget, mein-mmo) and Steam threads.
- The AAClassic private-server wiki, which runs a 3.5-era client ([wiki.aa-classic.com](https://wiki.aa-classic.com/Commerce)).

---

## 1. The loop

1. Grow or raise raw goods.
2. Process them into generic intermediates.
3. Craft a **zone-specific trade pack** at that zone's workbench (costs labor).
4. The pack goes on your **back**, slows you to a crawl and blocks gliding and teleporting.
5. Haul it by foot, donkey, cart or ship to a **Specialty Buyer** in another zone or continent.
6. Get paid roughly **distance-based value × demand % × freshness**, in gold or special currencies.

If you are killed, anyone can take the pack and cash it in; the crafter still gets a cut. XLGames' stated aim was trade "driven by teamwork and player interaction" in which "piracy should also be a constant threat and viable strategy" ([wiki: Trade Routes](https://archeage.fandom.com/wiki/Trade_Routes)).

---

## 2. Crafting trade packs

| Pack family | Crafted at | Example recipe | Labor | Notes |
|---|---|---|---|---|
| Regular specialty | Public **Specialty Workbench** in each zone | Solzreed Luxury Specialty: 180 Trimmed Meat + 5 Grape | 80 ([codex](https://archeagecodex.com/us/recipe/6228/)) | Can't be sold in the zone where it was made ([tooltip](https://archeagecodex.com/us/item/31857/)) |
| Gilda specialty | Same bench | 300 Ground Grain + 10 Wool + **2 Gilda Stars** | 180 ([codex](https://archeagecodex.com/us/recipe/6204/)) | Consumes premium currency. Has its own demand % ([AAClassic](https://wiki.aa-classic.com/Commerce)) |
| Local / Fellowship ("Merchant") | Community Center or player-built Fellowship Plaza bench (residents or local taxpayers only) | 150 Ground Spices + 5 Strawberry | 80 | Requires a house in the province ([wiki](https://archeage.fandom.com/wiki/Fellowship_Plaza)) |
| Fertilizer | Remodeled player house ("Tradesman's House", 2.0) | 50 each of 4 processed goods | 80 ([codex](https://archeagecodex.com/us/recipe/7774/)) | Same recipe in every zone |
| Aged | **Aging Larder** placed on your land, aged 3 days (cheese, honey or salve) | e.g. milk + lemon | 50–65 to build, 60 to harvest | More valuable than regular packs ([wiki](https://archeage.fandom.com/wiki/Trade_Packages), [AAClassic](https://wiki.aa-classic.com/Commerce)) |
| Community-center pack | Center workbench | Blue Salt Bond + pigment + oil + polish | 600 ([codex](https://archeagecodex.com/us/recipe/11038/)) | Late-game |
| Cargo | **Bought** at outlets (§4) | – | 75 | Timed, cross-continent |
| Found packs | Sunken ships, ghost-ship boss | – | Labor to unseal | "10–30g at 130%" ([2.5 notes](https://archeage.fandom.com/wiki/Updates)) |
| Construction packs | Sawmill and other benches | 100 Lumber → Lumber Pack | 25 ([wiki](https://archeage.fandom.com/wiki/Lumber_Pack)) | Same carry rules. Used to build houses and ships |

**Input structure.** Each zone pack combines a large quantity of one of **seven generic processed goods** with a small amount of one local crop or animal product. The seven are Dried Flowers, Ground Spices, Medicinal Powder, Trimmed Meat, Chopped Produce, Orchard Puree and Ground Grain. Each can be made at a Multipurpose Trimmer from many raw goods.

- **Bulk recipe:** 100 raw goods become 100 processed goods (100 pork becomes 300 Trimmed Meat) for 50 labor. It needs 20,000 proficiency ([codex](https://archeagecodex.com/us/recipe/7650/)).
- **Per-zone recipes:** older versions are listed on [the wiki](https://archeage.fandom.com/wiki/Trade_Packages), e.g. Lilyut Cooking Oil = 50 Dried Flowers + 20 Olive.
- **Climate:** crops grow faster in their ideal climate (barley takes 30 min in temperate zones and 43 min elsewhere), which gives regions a natural advantage ([wiki](https://archeage.fandom.com/wiki/List_of_Plants)).

**Labor per pack over time:**

| Era | Labor | Source |
|---|---|---|
| Closed beta | 60 to make + 60 to deliver, falling to 36 each at 40–50k Commerce | [wiki](https://archeage.fandom.com/wiki/Trade_Routes) |
| 2014 launch | "60 labor points or thereabouts" | [TenTonHammer](https://www.tentonhammer.com/guides/archeage-trade-pack-guide) |
| Update 2.0 (2015) | "Crafting or selling a Specialty pack now costs 70 Labor" | [patch notes](https://archeage.fandom.com/wiki/Updates) |
| Later clients | 80 | codex |

Counting farming and processing too, one Unchained player tallied **270 labor** for a Lilyut pack built from scratch ([Steam, 2019](https://steamcommunity.com/app/1147660/discussions/0/1643178512751211650/)). Players must be level 30+ to craft or sell packs.

---

## 3. Carrying a pack

| Rule | Detail (source) |
|---|---|
| Slot | Worn on the back in the **glider slot**, not in the inventory. One per character ([wiki](https://archeage.fandom.com/wiki/Trade_Packages); [totalarcheage](https://totalarcheage.blogspot.com/2014/09)) |
| Movement | "Carrying heavy objects reduces movement speed and prevents teleporting or gliding" ([tooltip](https://archeagecodex.com/us/item/31857/)). Walking only ("unable to run or use a glider", [Massively](https://www.engadget.com/2014-09-16-massivelys-archeage-launch-diary-day-four-trade-runs-sea-be.html)). World Gates are blocked ([Engadget](https://www.engadget.com/2014/08/11/archeage-highlights-its-trade-mission-mechanics/)) |
| Speeds | Normal run is 5.4 m/s and Sprint is 8 m/s ([wiki](https://archeage.fandom.com/wiki/Transportation)). Walking speed with a pack is **(unverified)**. Normal mounts drop from **9.0 to 1.8 m/s (−80%)**, but the **donkey only from 7.2 to 4.0 m/s (−44%)** ([wiki: Mount](https://archeage.fandom.com/wiki/Mount)). Some mount jump and charge skills are disabled |
| Water | Allowed. Mounted speed in water follows your swim speed (wiki). Other details are **(unverified)** |
| Death or drop | The pack falls to the ground and anyone can loot it ("Free loot") unless it lies on protected land. Packs on your own land are safe, which is how players stage runs. Dropped packs **despawn after 6 days**, and picking one up resets the timer. Players also used packs as roadblocks; patch 1.7 let raid bosses clear packs "dropped to block pathing" ([wiki](https://archeage.fandom.com/wiki/Trade_Packages), [notes](https://archeage.fandom.com/wiki/Updates)) |
| Vehicles | Packs in a cart can only be taken by the owner's party, or after the cart is destroyed. Packs on a sunk ship can be looted from the wreck ([Farm Cart](https://archeage.fandom.com/wiki/Farm_Cart), [Merchant Schooner](https://archeage.fandom.com/wiki/Merchant_Schooner)) |
| Theft payout | There is no fence: the thief sells at any buyer. The crafter's share was **40%, cut to 20%** in 1.2 (2014). In later clients it depends on freshness, e.g. a Luxury pack pays the crafter 50% at "High Profit" and 0% at "Low Profit" ([codex](https://archeagecodex.com/us/item/31857/)) |
| Crime | Attacking your own faction or stealing crops adds crime points and leaves bloodstains or footprints that others can report. At 50+ points, your next PvP death puts you on trial before a **5-player jury**. 3,000 infamy turned a player into a Pirate; this was later replaced by an exile system ([wiki](https://archeage.fandom.com/wiki/Justice_System)) |

---

## 4. Delivery and pricing

**Buyers.** Trade Outlets exist in Solzreed, Two Crowns and Cinderstone on Nuia, and in Solis, Villanelle and Ynystere on Haranya ([wiki](https://archeage.fandom.com/wiki/Trade_Outlet)). Selling on your own continent pays gold. Gilda Star traders and Resource traders on the other continent paid in those currencies; the Gilda traders were removed by 6.0. From 3.5 onward, outlets are no-PvP zones.

**Price model** (as players reverse-engineered it): `base(origin, destination, type) × demand% × freshness`, then split between seller and crafter. The exact way these combine is **(unverified)**.

- **Distance:** "the farther it is between two zones, the higher the base turn in value" ([AAClassic](https://wiki.aa-classic.com/Commerce)).
- **Supply and demand:** the multiplier "ranges from 70% to 130%. As players turn in packs, the percent… slowly decreases… As time passes the percent will slowly creep back up until it is capped at 130%" ([AAClassic](https://wiki.aa-classic.com/Commerce)).
  - Each **(origin, pack type, destination)** combination has its own multiplier. "The only way to increase the turn in percent is to wait."
  - Kakao's support FAQ said the same (FAQ now offline; [quoted via the search index](https://kakaogames.helpshift.com/hc/en/3-archeage/faq/198-trade-pack-issues/)).
  - The 70–130% band already existed in 2014 ([Steam](https://steamcommunity.com/app/304030/discussions/0/616188677733801958/)).
  - Patch 2.9 (2016) changed how often the price drop is recalculated, from every minute to every second ([notes](https://archeage.fandom.com/wiki/Updates)). Groups had been dumping whole loads within a single pricing tick.
  - **The drop per pack and the recovery per hour were never published (unverified).**
- **Outlet stock (3.5+):** delivered packs become stock at the outlet, and more stock of a type means a lower price. A full outlet refuses new packs. Capacity is 200 cargo, and overstocked outlets "may sometimes hold sales" ([3.5 notes as reproduced by ArcheRage](https://na.archerage.to/forums/threads/archerage-3-5-global-update-custom-version-patch-notes.8257/)).
- **Freshness** ([MagicGameWorld, Unchained-era table](https://www.magicgameworld.com/?p=123895)):

| Tier | Best | 2nd | 3rd | Worst |
|---|---|---|---|---|
| **Luxury** | <15 min **+30%** | <30 min +15% | <60 min −10% | >60 min −15% |
| **Fine** | <15 min +15% | <60 min +5% | <3 h −7% | >3 h −12% |
| **Commercial** | <15 min +5% | <3 h +2% | <12 h −5% | >12 h −10% |
| **Preserved** | <6 h +3% | <12 h +1% | <24 h −4% | >24 h −8% |

Each zone's packs belong to one tier ([codex](https://archeagecodex.com/us/recipes/commerce/nuian/)). Solzreed, Two Crowns and Cinderstone make Luxury packs, while Hellswamp, Halcyona and Sanddeep make Preserved ones. **A pack's origin therefore decides whether it is a sprint or a slow haul.**

**Payment types:**

| Currency | Details |
|---|---|
| Gold | Paid with a delay: about 22 h, plus **5% interest** (2014; [TTH](https://www.tentonhammer.com/guides/archeage-trade-pack-guide)). Interest fell to 2% in 3.5. Later tooltips say "mailed 8 hours from the time of sale" |
| Gilda Stars | Only for cross-continent runs (2014), paid instantly. Roughly 1 g of pack value = 1 star, 5 g = 4, 11 g = 7 ([wiki](https://archeage.fandom.com/wiki/Trading)). 2014 stars per pack: Solis 1, Villanelle 1, Ynystere 2, **Freedich 4** ([totalarcheage](https://totalarcheage.blogspot.com/2014/09)) |
| Stabilizers (crafting materials for ships and high-end items) | 2014 amounts per pack: Charcoal ~11 at Solis, Rock Salt ~8 at Villanelle, Crystal ~3. **Dragon Essence** only at Freedich. Later only Charcoal and Dragon Essence remained |

**Cross-continent cargo chain (3.5, June 2017).** Sources: [wiki: Cargo Pack](https://archeage.fandom.com/wiki/Cargo_Pack), [ArcheRage guide](https://na.archerage.to/forums/threads/3-5-trade-system-guide.8369/).

1. **Cargo is produced.** An outlet that receives **14 general + 8 merchant/fertilizer + 4 aged** packs turns them into **2 Cargo**.
2. **Cargo is bought.** The player who completes the set may buy the Cargo. It costs demand-priced gold plus 75 labor, and requires level 30 and a **Cargo Certificate** (300 Vocation Badges).
3. **Cargo is delivered.** It goes to the *other* continent's buyer, which pays gold, or to Freedich, which pays Dragon Essence. Its value decays over time.
4. **Certified Cargo follows.** That sale lets you buy **Certified Cargo**, which must reach an exchanger on the same continent within **30 minutes** for Charcoal Stabilizers. Labor costs conflict: 300 labor + 35 g per the wiki, or 75 labor to buy and 175 to sell per the 3.5 notes.

**Safe option:** NPC ferries run Two Crowns↔Solis and Solzreed↔Ynystere. A **Captain's Protection** pass (5 g or 1,000 Vocation Badges) makes you unattackable for 35 minutes, but you may carry only one pack ([wiki](https://archeage.fandom.com/wiki/Transportation)).

**Freedich Island** sits in open, always-PvP sea between the continents ([wiki: World PvP](https://archeage.fandom.com/wiki/World_PvP)).

- **Gold Trader event:** it appears **twice a day for 2 hours** (NA: 8:30 AM and 4:30 PM PDT; [wiki](https://archeage.fandom.com/wiki/Event_Schedule)). It accepts packs from any continent and is "the highest reward per pack of any trader in the game" ([AAClassic](https://wiki.aa-classic.com/Commerce)).
- **House camping:** in 2014, guilds with island houses ambushed traders straight from their homes. Patch 1.7 removed Freedich housing ([mein-mmo](https://mein-mmo.de/en/archeage-freedich-the-island-of-provocation,19131)).

**Pirate outposts.** I found **no dedicated "fence"** for stolen packs. Thieves use the normal buyers. Whether the pirates' home, Growlgate Isle, had its own pack buyer is **(unverified)**.

**Price anchors:**

- **2014 typical value:** about 8–9 g per pack ([Steam](https://steamcommunity.com/app/304030/discussions/0/616188677733801958/)).
- **Unchained 2019:** a Lilyut pack sold at Solzreed for 8 g at 98% demand. With 2.30 g of materials and 270 labor, that is **~1.17 silver per labor** ([Steam](https://steamcommunity.com/app/1147660/discussions/0/1643178512751211650/)).
- **Market price of labor:** in Oct 2014 a 1,000-labor potion sold for about 8 g on the auction house, so labor traded at roughly 0.8 silver each ([mein-mmo](https://mein-mmo.de/en/archeage-arbeiterlohn-traenke-zu-dumpingpreise-goldwaesche910,19823)). 100 silver = 1 gold.

---

## 5. Transport capacity (brief)

| Method | Packs | Notes |
|---|---|---|
| On foot / Donkey | 1 | Donkey moves 4.0 m/s loaded. From the level 30 trade quest or 5 Gilda ([wiki](https://archeage.fandom.com/wiki/Donkey)) |
| Farm Cart | 2 + 1 on the driver | Donkey speed. Passengers can ride with their own packs, for "up to 5–6" per run ([wiki](https://archeage.fandom.com/wiki/Farm_Cart)) |
| Farm Wagon / Hauler / Freighter | 4+1 / 6+1 / 8 | Hauler figure from older guides **(unverified)**. Freighter came via a 2016 cash-shop upgrade |
| Submarine | 2 riders, each with a pack | |
| Longliner / small warships | 3 / 4 | [wiki: Ships](https://archeage.fandom.com/wiki/Ships) |
| **Merchant Schooner** | **20** | 10 m/s and 42k HP. Design costs 400–500 Gilda, plus construction packs. "Common prey… travel in convoys" ([wiki](https://archeage.fandom.com/wiki/Merchant_Schooner)) |
| Storage Silo on land | 10 | For staging |

---

## 6. Labor and vocations

| Era / tier | Cap | Online regen | Offline regen |
|---|---|---|---|
| Trion free-to-play (2014–) | **2,000** | 5 per 5 min | **0** |
| Trion Patron, 2014 | **5,000** | 10 per 5 min | 5 per 5 min |
| Trion Patron, from ~Apr 2015 | 5,000 | 10 per 5 min | 10 per 5 min |
| Unchained (2019) | 5,000 | 10 per 5 min | 10 per 5 min |

Sources: [wiki: Labor](https://archeage.fandom.com/wiki/Labor), [Labor Points](https://archeage.fandom.com/wiki/Labor_Points), mein-mmo [2014](https://mein-mmo.de/en/archeage-why-archeages-main-problem-remains-unresolved-for-now,18892) / [2015](https://mein-mmo.de/en/archeage-patron-status-wird-noch-attraktiver-pegasus-mount-143,33004) / [2019](https://mein-mmo.de/en/5-tips-about-archeage-unchained-that-i-wish-i-had-known-earlier,386893).

- **Pool and rates.** Labor is **shared by the whole account**. At 10 per 5 min you gain 2,880 a day, and a full 5,000 bar takes about 42 hours.
- **Patron.** The subscription ($14.99 a month) also granted land ownership and auction house listing ([wiki](https://archeage.fandom.com/wiki/Patron)).
- **Labor potions.** **Worker's Compensation** restores 1,000 labor on a 12 h cooldown *per character*, so six characters could add 6,000 to the shared pool. It cost 300 credits (about $2.40; my calculation) or loyalty tokens, and was tradeable ([wiki](https://archeage.fandom.com/wiki/Worker%27s_Compensation)).
  - In 2014 the cooldown was cut from 12 h to 4 h, then reverted after a pay-to-win backlash ([mein-mmo](https://mein-mmo.de/en/archeage-takes-a-sip-from-the-pay2win-bottle,17616)).
  - Trion said it sold potions without quantity limits until 2016 ([MMOBomb](https://www.mmobomb.com/news/trion-responds-player-pay-win-concerns-regarding-archeage-progression-servers)).
  - Unchained's shop sold no labor items ([mein-mmo](https://mein-mmo.de/en/archeage-unchained-promises-no-pay2win-but-what-is-in-the-shop,422094)).
- **Other refills.** Sleeping in a bed gives up to +100 labor every 22 h. Reporting a bot costs 25 labor, refunded with +25 extra if the report is correct.

**What costs labor:**

| Action | Labor |
|---|---|
| Harvest a crop | 1–5 |
| Chop a tree | 5–25 |
| Mine a vein | 10–100 ([wiki](https://archeage.fandom.com/wiki/Mining)) |
| Fishing cast (2014) | 5 |
| Bulk-process 100 raw goods | 50 |
| Craft a pack | 60–80 (Gilda pack 180) |
| Sell a pack (Trion era) | 60–70 |
| Buy cargo / sell certified cargo | 75 / 175 |
| Open a coin purse | 1–35 ([wiki](https://archeage.fandom.com/wiki/Larceny)) |
| Craft Illustrious gear (3.5) | 1,400 → 600 |

**Vocations.** There are 22 proficiencies ([wiki](https://archeage.fandom.com/wiki/Crafting)):

- Crafting: Alchemy, Cooking, Weaponry, Carpentry, Metalwork, Leatherwork, Tailoring, Handicrafts, Machining, Masonry, Printing
- Gathering: Farming, Husbandry, Gathering, Logging, Mining, Fishing
- Special: Commerce, Construction, Larceny, Artistry, Exploration

Proficiency rises with labor spent; maxing one took about **180,000 labor** in Unchained. Rank benefits in a 3.5-era client ([AAClassic table](https://wiki.aa-classic.com/Proficiency)):

| Rank | Labor cost | Craft time | XP from labor |
|---|---|---|---|
| Novice (10–20k) | 0% | −3% | +20% |
| Veteran / Expert / Master | −5 / −10 / −15% | −6% | +40–80% |
| Authority → Herald | −20% | −12 to −16% | +100–160% |
| Virtuoso / Celebrity | −25 / −30% | −16 / −20% | +180–200% |
| **Famed (180–230k)** | **−40%** | −26% | +230% |

- **Specialization is capped.** In 2014, 7 proficiencies could advance past Amateur, then 6, 5, 4 and 3, and only 2 could reach Champion ([wiki](https://archeage.fandom.com/wiki/Crafting)). This forces players to specialize and depend on each other.
- **Thresholds unlock content.** Bulk processing opens at 20k proficiency, Anya ore veins at 50k Mining, and the title "Barter $auce" at 230k Commerce. Commerce itself reduces the labor cost of packs.

---

## 7. Other economy pillars

- **Gilda Stars.** A non-tradeable currency from quests and, before 6.0, cross-continent packs. Spent on Mirage Isle on designs ([wiki](https://archeage.fandom.com/wiki/Gilda_Star)):
  - Houses: Farmhouse 300, mansions 1,000, Spired Chateau 3,000, Fellowship Plaza 500.
  - Ships and vehicles: Merchant Schooner 400–500, Farm Wagon 50, cars 800–2,000.
  - Mounts: donkey 5.

  Packs therefore feed housing and fleet progression.
- **Auction house.** Scoped to your faction. Listing requires Patron or a 150-credit license, and the house cut is 10% (5% for Patrons) ([wiki](https://archeage.fandom.com/wiki/Auction_House)). **APEX** (1,250 credits for $9.99, tradeable for gold) acted as an official bridge between real money and gold.
- **Regional and civic markets.**
  - Prices differ by route, and pack tiers and crop climates differ by region.
  - **Community Centers** pool **5% of zone merchant gold** and pay it to resident contributors.
  - **Crafting Request Stations** let a player post materials plus a fee for any qualified crafter to fill.
  - Blue Salt dailies pay 2.5, 7.5 or 12.5 g for turning in 20, 60 or 100 items ([wiki](https://archeage.fandom.com/wiki/Community_Center)).
- **Crafting chains.** Examples: pig → pork → Trimmed Meat → pack → gold; and logs → lumber → Lumber Pack → house or ship. Archeum gear materials upgrade in steps (motes, dust, shards, crystals, essence) costing 1, 5, 10 and 20 labor (2.9).
- **Other currencies:**
  - **Honor:** PvP currency from arenas and war-zone kills. Buys gear, and 5,000 Honor buys a potion that removes 100 crime points.
  - **Vocation Badges:** originally earned by gathering and crafting, later only from quests. They buy rare seeds, the Cargo Certificate (300) and Captain's Protection (1,000) ([wiki](https://archeage.fandom.com/wiki/Vocation_Badge)).
- **Land.** In the Trion era only Patrons could own land. Weekly taxes, paid in Tax Certificates, rise with the number of properties owned. Building requires construction packs that are physically carried like trade packs.

---

## 8. What players loved vs. criticized

**Loved**

- **Unscripted danger.** "I got ganked in ArcheAge last night, and believe it or not, it was one of the most enjoyable experiences…" The attackers were pirates "who attempted to board us using gliders." The game is "infinitely more fun (and profitable) if you play it with friends" ([Massively 2014](https://www.engadget.com/2014-09-16-massivelys-archeage-launch-diary-day-four-trade-runs-sea-be.html)).
- **Group roles.** Guides told traders to send a scout ahead to spot pirate ships and to hire mercenary guilds ([wiki](https://archeage.fandom.com/wiki/Trade_Routes)).
- **Convoys.** A Merchant Schooner carried 20 packs, and they could be salvaged from its wreck.
- **Events that invited raids.** The 2016 "From Distant Shores" event credited whoever *arrived* with the packs ([mein-mmo](https://mein-mmo.de/en/archeage-piraten-belohnungen-handelspakete,79147)).
- **Timing play.** Players staged packs on their land to time runs around zone war and peace cycles, as in the "Double Peace" route ([AAClassic](https://wiki.aa-classic.com/Double_Peace_(Trade_Run))).

**Criticized**

- **Labor as an energy paywall.** For a free player, "the trade pack alone is 2 hours worth of being logged in" ([Aywren 2014](https://aywren.com/2014/09/21/archeage-f2p-is-not-for-the-casuals)).
- **AFK queues.** Players idled online just to regenerate labor, which clogged server queues. XLGames refused to make online and offline regeneration equal ([mein-mmo](https://mein-mmo.de/en/archeage-why-archeages-main-problem-remains-unresolved-for-now,18892)).
- **Selling labor read as pay-to-win.** Potions were later dumped at half price on the auction house, which mein-mmo suspected was gold laundering.
- **Hacks hit the trade loop directly.**
  - A teleport exploit let players appear "inside of a specialty workbench" ([Engadget](https://www.engadget.com/2014-10-05-heres-some-of-the-exploiting-currently-happening-in-archeage.html)).
  - Lists of teleport, speed and bot hacks circulated. mein-mmo argued that teleport trade runs devalued everyone else's "honestly earned" gold ([mein-mmo](https://mein-mmo.de/en/archeage-cheats-now-top-10-lists-with-hacks-are-circulating,20290/)).
  - 16,000 alpha accounts were banned ([mein-mmo](https://mein-mmo.de/en/archeage-wildstar-teso-mmos-and-their-bot-problems,12720)).
- **Weak return on labor.** In Unchained, "The base Products sell for more per labor than crafting everything in one pack." Everyone running the same routes also collapsed the demand %.
- **Land and opacity.** Land was scarce and merges cost players their plots. Guilds camped Freedich from island houses. The rules for demand % were never documented ([Aywren 2024](https://aywren.com/2024/05/07/archeage-is-sunsetting); [mein-mmo 2024](https://mein-mmo.de/en/archeage-schliesst-server-free2play-mmorpg,1118902) cites "hackers, bugs, exploits and microtransactions").

---

## 9. Design takeaways for an original game

- **Make cargo a physical, exclusive burden.** One pack per character, carried in the glide/fast-travel slot, at walking speed. Normal mounts lose most of their speed, while a pack animal keeps about half. Each delivery becomes a journey and a visible target. Vehicle capacity (1 → 3 → 5 → 9 → 20) becomes a progression ladder.
- **Ownership by possession, softened by royalties.** Packs dropped or carried by the dead are lootable, but the crafter keeps a cut (ArcheAge used 20%). Theft hurts without zeroing the victim. Cargo locked in vehicles or on owned land gives clear safe states.
- **Pay for distance and danger.** Safe local runs pay plain currency, and cross-region runs pay scarce currencies. Put the best buyer in a free-for-all hub on a **public schedule** (like Freedich's twice daily for 2 h) to create predictable flashpoints.
- **Give every route its own demand bucket.** Use one multiplier per origin × product × destination (e.g. 70–130%) that drops with each sale and recovers slowly. This spreads traffic and rewards scouting. Recalculate it per transaction and **show it in the UI**, since ArcheAge's opacity frustrated players.
- **Use perishability tiers as the speed-versus-safety dial.** Luxury goods (+30% under 15 min) suit fast, risky runs; Preserved goods (+3% over 6 h) suit staged convoys. Tie the tier to the region so each origin has its own logistics personality.
- **Close the loop with inventory.** Delivered goods become outlet stock, which turns into higher-tier cargo for the next leg (14+8+4 → 2 cargo → certified cargo). This creates work for haulers, escorts and pirates, and clears saturated markets.
- **Keep a labor budget, but avoid ArcheAge's mistakes.** An account-wide action pool curbs bots and inflation and makes choices matter. But regenerate it **identically online and offline**, cap it at about 1.5–2 days of regeneration, and **never sell refills**.
- **Force specialization.** Vocation ranks cut labor and craft time (up to −40%), but only a few vocations can reach the top. This creates dependence on other players and markets for intermediate goods.
- **Use wide, shallow recipes built on regional inputs.** A few generic intermediates plus one local ingredient per pack make land and climate matter. Make sure packing pays clearly more per labor than selling raw goods, or the loop dies (Unchained: ~1.17 silver per labor).
- **Sell risk reduction at a price, with a cap.** Paid ferries limited to one pack, peaceful outlets, staging on owned land and party-locked vehicles let cautious players join in. The richest routes should never be fully safe.
- **Give non-traders real roles with consequences.** Escorts, scouts and pirates need a working crime system: evidence trails, player juries and an outlaw faction.
- **Validate deliveries on the server from day one.** Check movement and enforce a minimum plausible travel time. Teleport and speed hacks targeted exactly this loop.
