# ArcheAge: Land, Farming, Gathering, Housing and the New-Player Journey

Research notes for designing an original game with similar mechanics. Combat and classes are out of scope.

## 0. Versions and source quality

ArcheAge changed a lot over its life, so many mechanics have different numbers in different eras. The era is noted where it matters.

| Era | What changed for land |
|---|---|
| Korea, 15 Jan 2013; NA/EU (Trion), 16 Sep 2014 | You needed a **Patron** subscription to own land. Free-to-play (F2P) players could use public farms, unprotected wild farms, or land a guild or family member let them use ([Wikipedia](https://en.wikipedia.org/wiki/ArcheAge), [Engadget FAQ](https://www.engadget.com/2014/04/03/archeage-faq-mentions-testing-plans-optional-subscription-and/)) |
| Nov 2014: Auroria | PvP continent with about 30% more housing space across 4 claimable zones. Guilds that hold castles set local taxes ([Engadget](https://www.engadget.com/2014/11/07/lost-continent-its-getting-harder-to-like-archeage/)) |
| Dec 2016: patch 3.0 "Revelation" | Dwarves and Warborn added, plus neighbourhood "Community" daily tasks and up to 1,200 new plots in Ahnimar ([mein-mmo](https://mein-mmo.de/archeage-revelation-update/)) |
| 15 Oct 2019: *Unchained* | Buy-to-play with no Patron gate, so everyone could own land. Another land rush followed ([MassivelyOP](https://massivelyop.com/?p=249491)) |
| 27 Jun 2024 | NA/EU servers shut down ([MMOHuts](https://mmohuts.com/review/archeage)) |

**Source quality.** The ArcheAge Fandom wiki blocks automated fetching, so I only saw its figures as search-engine excerpts, labelled "(Fandom, via search)". The most reliable numbers come from **archeagecodex.com**, which extracts game data for items, quests and recipes. Anything I could not confirm is marked **(unverified)**.

---

## 1. Labor Points: the throttle on every system

Almost every non-combat action costs **Labor Points (LP)**: harvesting, gathering, crafting, building, planting outside your own land, and making tax certificates.

| | Online regen | Offline regen | Cap |
|---|---|---|---|
| Patron (2014) | 10 LP / 5 min | 5 LP / 5 min | 5,000 |
| F2P (2014) | 5 LP / 5 min (one guide says 1) | none | 2,000 |
| Unchained | 10 LP / 5 min | 10 LP / 5 min | 5,000 |

Sources: [Engadget](https://www.engadget.com/tag/archeage-apex), [MMOHuts](https://mmohuts.com/review/archeage), [mein-mmo](https://mein-mmo.de/en/5-tips-about-archeage-unchained-that-i-wish-i-had-known-earlier,386893), [TenTonHammer](https://www.tentonhammer.com/guides/the-basics-to-archeage-s-crafting-system).

- The maximum is about **2,880 LP per day**.
- Sleeping in your own bed adds roughly **50–80 LP a day**. Pajamas bought with vocation badges add up to +200 ([MGW](https://www.magicgameworld.com/?p=123889), via search).
- Labor spent on farming or gathering also gives **XP**, **proficiency** and **vocation badges** at roughly 1:1:1 ([GamersFAQs blog](https://gamersfaqs.blogspot.com/2014/10/gathering.html)). A pure farmer could therefore level up.
- The cash shop sold labor potions, which drew "Facebook energy system" complaints ([MMOBomb](https://mmobomb.com/labor-points-good-idea-implementation)).

---

## 2. Farming

### 2.1 Where you can plant

| Land | Protection | Notes |
|---|---|---|
| **Wild / "illegal" farm** (almost anywhere outdoors) | **None.** Anyone can harvest or uproot it, but doing so counts as a crime and leaves evidence. | One guide says it costs about **10 LP per crop** (GameSkinny, via search). Players hid farms on mountains, on islands and in quest areas ([MGW](https://www.magicgameworld.com/?p=123918), [nullsignifier](https://nullsignifier.blogspot.com/2014/12/adrift-in-archeage-part-ii-squatters.html)). |
| **Public farm** (starter zones, later "community centres") | **3 days** according to the in-game tutorial quest text. Guides also cite 24 h, 48 h and 72 h. | No Patron needed. Per-player caps by plot type (2014): Farm 10, Ranch 5, Nursery 5, Stable 5 ([codex 4417](https://archeagecodex.com/us/quest/4417), [mmo2go](https://mmo2go.blogspot.com/2014/06/archeage-farming.html)). |
| **Scarecrow plot** (housing provinces only) | Full. Crops are only fair game if you set access to "public". | Weekly tax ([TenTonHammer](https://www.tentonhammer.com/guides/archeage-farming-guide-planting-trees-plants-and-raising-animals)). |
| **House yard / farmhouse** | Full | Farmhouses trade the workshop for extra farmland. |
| **Aquafarm** (underwater) | Full | Grows coral and kelp and traps fish. Footprint (unverified): one wiki snapshot says 16×16, another source says it shares 8×8 scarecrow space. |

### 2.2 The scarecrow ladder

| Plot | Size | How obtained | Cost to build | Weekly tax (deposit) |
|---|---|---|---|---|
| **Scarecrow Garden** | 8×8 m. Decor limit 50. Holds about 36 small crops. | Quest reward: level 7 in the original game, level 33 in Unchained (see §5) | 1 Lumber | **5 certs** (10) ([codex 15596](https://archeagecodex.com/us/item/15596/)) |
| **Scarecrow Farm** (also called "Improved", "Pumpkinhead" or "Large") | 16×16 | Level-50 quest chain in Unchained, or crafted at a Carpentry Workbench | Recipe: the 8×8 design (so you must demolish the garden) + 100 lumber + 100 iron ingots + 25 fabric + 25 leather + 50 bricks. About **1,700 LP** if you craft it all yourself ([GameSkinny mirror](https://ajentertainment.pages.dev/posts/archeage-guide-how-to-get-your-first-16x16-farm-improved-scarecrow-farm-archeage)). | 10 certs (20 + 1 Lumber Pack) (Fandom, via search) |
| **Solar / Lunar Farm** | 16×16. The scarecrow sits on the edge, so more room for crops. | Cash-shop chest, once per account | n/a | Does not count toward the multi-property tax rise ([ArcheRage forum](https://na.archerage.to/forums/threads/3-0-updates-land-and-taxation.4962/)) |

The 16×16 farm also works as a **Farmer's Workstation**, where you craft livestock feed and supplements.

### 2.3 Real-time growth times

| Crop or animal | Preferred climate | Growth time | Notes |
|---|---|---|---|
| Potato | All | ~10 min | Watering cuts growth time by 10% (Fandom, via search) |
| Barley | Temperate | 43 min elsewhere, **30 min** in temperate (27 min watered) | Feeds chickens and turkeys ([codex 4416](https://archeagecodex.com/us/quest/4416)) |
| Rice / corn | Temperate | ~2 h 52 m elsewhere, **~2 h** in temperate | ([Fandom](https://archeage.fandom.com/wiki/Corn_Seed), via search) |
| Mint / Aloe | Arid | 4 h 18 m / 14 h 18 m | |
| Banana tree (re-harvest) | Tropical | 14 h 18 m elsewhere, **10 h** in tropical | 15 LP per harvest ([GamersFAQs](https://gamersfaqs.blogspot.com/2014/10/gathering.html)) |
| Fir / Apricot | — / Temperate | ~1 day / 2 d 21 h, then 1 d 10 h per later harvest | Slower trees give more logs. Fruit trees keep producing. |
| Rubber / Baobab | Tropical / Arid | 11 h 26 m / 1 d 2 h | (GameSkinny tree guide, via search) |
| Chick | — | Under 3 h, then lays eggs | Costs 8 silver. Eats barley. |
| Lamb | — | ~14 h, then wool every 8 h | Costs 1 gold. Eats combined feed. |
| Dairy calf | Temperate | 1 d 10 h, then milk every 10 h | Costs 2 gold 50 silver |
| Goat, goose, cashmere yata | — / — / Arid | Goat wool every 10 h; goose down; yata fur | Ducks and geese eat beans |

The livestock rows come from GameSkinny's 2014 husbandry guide (via search), when the merchant sold 11 animals. Timings changed between patches.

### 2.4 Climate, water and the care loop

- **Climate.** The climates are **Temperate, Arid, Tropical**, plus "All" (no bonus). Planting in a crop's preferred climate cut growth time by **about 30%** in every example I found. I found **no Subarctic climate** (unverified), although one quest describes Airain Rock's "snowy farmland" ([codex 5309](https://archeagecodex.com/en/quest/5309)).
- **Growth stages.** A plant is young (you can water it), then growing (you can't), then ripe.
  - Crops left unharvested wither and then die. **Fertilizer** can save them.
  - Sick animals need a supplement.
  - Exact wither timers: (unverified).
- **Water** costs labor and comes from wells, merchants or a farmhouse water barrel. It is worth most when applied early.
- **Feeding** animals speeds their growth. Slaughtering a young animal gives little or no meat ([codex 4421](https://archeagecodex.com/en/quest/4421)). This sets up the main livestock choice: recurring produce (milk, wool, eggs) or one-off meat and leather.
- **Rain** watering crops: no evidence found (unverified).
- **Timers were a burden.** In 2013 XL released an offline web/mobile farm monitor because crops withered and animals starved while players were away ([Engadget](https://www.engadget.com/2013-02-27-xl-releases-offline-farm-monitor-for-archeage.html)).

### 2.5 Yields and labor

- Planting on your own land costs no labor. Harvesting does ([GamersFAQs](https://gamersfaqs.blogspot.com/2014/09/farming_17.html)).
- **Uprooting** a plant has a chance to drop a seed or sapling.
- Grain harvests sometimes drop Hay Bales and Bait Worms.
- **Seed bundles** (10 seeds in one) produce more overall, but cost more labor, grow slower and give fewer rare drops.
- Exact yield tables: (unverified).

### 2.6 Thunderstruck trees

- **The mechanic.** Lightning can strike a tree while it is still *growing*. Cutting a struck tree gives **4 Thunderstruck Logs**. Players treated it as a random roll, not something tied to storms.
- **Value.** The logs go into high-end vehicles: farm carts, tractors and fishing boats. In 2014 the logs sold for **200+ gold each**, and whole trees for about 800 gold ([TenTonHammer](https://www.tentonhammer.com/guides/archeage-thunderstruck-tree-log-guide), [aywren](https://aywren.com/2014/10/20/bragtoberfest-level-50-how-i-accidentally-made-a-lot-of-gold-in-archeage)).

### 2.7 Larceny, crime and the jury (brief)

- **Evidence.** Theft (crops, livestock, trade packs) and killing players of your own faction leave **bloody footprints**.
  - Any player can click them to report the crime, which adds Crime and Infamy points at 1:1.
  - Unreported footprints fade.
  - Uprooting is punished more harshly than harvesting ([nullsignifier](https://nullsignifier.blogspot.com/2014/12/adrift-in-archeage-part-iii-crime-and.html)).
- **Trial.** At **50+ crime points**, your next PvP death sends you to trial.
  - **Five random jurors** vote. They must be level 30+, have no infamy, and have done the jury quest.
  - You can plead guilty for a shorter sentence.
  - Sentences run from minutes to many hours: 13 h in one 2014 case, and a guide says 20 h maximum.
  - Prisoners can escape by digging (Nuia) or with a tower key and glider (Haranya), but they still can't use abilities until the sentence ends.
  - Sources: [PCGamesN](https://www.pcgamesn.com/archeage/i-was-put-on-trial-in-archeage-my-first-punishment-was-to-get-naked), [TenTonHammer tips](https://www.tentonhammer.com/guides/25-tips-to-explain-archeage-mechanics-for-new-players).
- **Piracy.** At **3,000 Infamy** a player becomes a pirate and loses their faction and guild.
- **Complaints:** jurors taking bribes or extorting defendants, and inconsistent verdicts.

---

## 3. Gathering

| Node | Labor cost | What you get |
|---|---|---|
| Iron vein | 10 | Iron ore. Can spawn a **Fortuna vein** next; higher proficiency raises the chance. |
| Fortuna / Star Shard / Anya / Thiorium vein | 20 / 25 / 50 / 100 | Rare ores and gems. Anya needs 50k mining proficiency (Fandom, via search). |
| Stone pile | 10 | 5–6 raw stone ([MGW](https://www.magicgameworld.com/?p=123891)) |
| Wild tree | 10–15 (Unchained); 25 (2014 guide) | About 5–6 logs, up to 16 from a sequoia. Can drop rare **saplings**. |
| Wild flowers / herbs | 1–2 | |

- **Respawn timers:** not found (unverified).
- **Refining ratios:** 3 ore make 1 ingot. 3 raw stone make 1 brick (5 LP). 100 bricks make 1 **Stone Pack** (25 LP). A Stone Pack therefore costs about **1,000 LP** in total, and a Lumber Pack about the same ([codex 4435](https://archeagecodex.com/us/quest/4435)).
- **Vocations:** there are about 21–22. Higher ranks cut labor costs.

---

## 4. Housing

### 4.1 Land and placement

**Where houses go.** Houses are open-world and non-instanced, but only inside marked **Housing Provinces**. Plots "do not scale with a server's population by design" ([Engadget](https://www.engadget.com/2014/04/03/archeage-faq-mentions-testing-plans-optional-subscription-and/)). Provinces differ in climate, PvP status and distance to trade outlets.

**Placement rules:**
- No steep slopes.
- Rotation is permanent once placed.
- Placing a building **destroys** any plants or trade packs inside its footprint ([codex 37144](https://archeagecodex.com/awen/item/37144/?sl=1), [archeagefanbase](https://archeagefanbase.wordpress.com/2014/09/14/how-to-build-house-in-archeage/)).

### 4.2 House types

| Type | Size | Design cost (Gilda Stars) | Packs needed (Stone/Iron/Lumber) | Weekly tax (deposit) | Decor limit and extras |
|---|---|---|---|---|---|
| Cottage (Swept-Roof; Rustic/Stone/Tudor) | 16×16 | 15 | 2 / 0 / 1 | 10 (20) in 2014; a later guide says 15 | 45 ([archeage-store](https://archeage-store.blogspot.com/2014/09/how-to-create-house-in-archeage.html)) |
| Manor | 24×24 | 200 | (unverified) | 15 (30) ([codex 15598](https://archeagecodex.com/us/item/15598/)) | 100 |
| **Thatched Farmhouse** (mostly farmland) | 24×24 | 50 in 2014, 300 in Unchained | 10 / 5 / 5 | 15 (30) | 45 |
| Farmhouse upgrades (Miner's/Harvester's/Rancher's) | 24×24 | upgrade | 30 / 15 / 15 | 25 (50) | 150. Two 50-seed seedbeds, an hourly mining vein, daily quests ([codex 37144](https://archeagecodex.com/awen/item/37144/?sl=1)) |
| Townhouse villa | 28×28 | 400 | (unverified) | (unverified) | 150 |
| Large-house upgrade (Armorer's Villa) | 28×28 | upgrade | 40 / 30 / 30 | 40 (80) | 200. Gear workbench and bulk processing ([codex 37489](https://archeagecodex.com/awen/item/37489/?sl=1)) |
| Marine stilt house (Breezy Bungalow) | 24×24 | 300 | (unverified) | (unverified) | 100. Aquafarm underneath ([Engadget](https://www.engadget.com/2014/11/16/lost-continent-lucking-into-a-breezy-archeage-bungalow/)) |
| Treehouse; two-storey upgrades | ? | ? | ? | ? | Announced for Korea 1.8 (Dec 2014). Unverified. |

Other notes:
- mein-mmo also lists a **44×44** size (unverified) ([mein-mmo](https://mein-mmo.de/en/archeage-how-to-build-a-house,659624/)).
- In Unchained, upgraded 16×16 houses gain **2 seedbeds that ignore climate**, and 24×24 and 28×28 houses become crafting houses ([MGW](https://www.magicgameworld.com/archeage-unchained-housing-changes/)).

### 4.3 Designs and construction

**Getting a design.** Designs cost **15–1,000 Gilda Stars** on **Mirage Isle**. Gilda comes from story quests, daily quests and trade runs.
- A design is reusable: demolishing the house mails it back.
- You can also buy a finished house from another player through its nameplate (1 gold appraisal fee in 2014).

**Building it.**
1. Placing the design creates a foundation.
2. You haul physical **Stone, Lumber and Iron packs** to the site.
3. Each pack, plus some labor, advances construction one stage.

Carrying a pack slows you down, and in PvP areas you can be killed for it. **Anyone can deliver packs**, so guilds built large houses together ([archeagefanbase](https://archeagefanbase.wordpress.com/2014/09/14/how-to-build-house-in-archeage/)).

**How big a job it is.**
- A cottage needs about 3 packs, roughly 3,000 LP.
- One player's Thatched Farmhouse took "two solid weeks" of gathering: about 3K stone, 1.5K iron and 1.5K logs ([aywren](https://aywren.com/2014/10/10/bragtoberfest-archeage-thatched-farmhouse-complete)).

**Build deadline: sources disagree.** One guide says an unfinished site expires after 2–3 days. 2014 critics say an empty, unbuilt foundation could hold land indefinitely as long as taxes were paid ([mein-mmo](https://mein-mmo.de/en/archeage-everywhere-towels-lie-no-land-in-sight,18339), [fanaticalswordsman](https://thefanaticalswordsman.com/2014/11/12/the-pros-and-cons-of-archeage-housing-and-pvp/)). Unverified which applied when.

### 4.4 Taxes and demolition

**Paying tax.**
- Tax is paid **weekly in Tax Certificates**.
- The first bill arrives by mail. You can **prepay up to 5 weeks**.
- The security deposit equals 2 weeks of tax. You get it back if you demolish the building yourself, and lose it if the building is removed for unpaid tax.

**Getting certificates.**
- **Bound** certificate: crafted at **any** building's nameplate for **55 LP plus 1 Paper** ([codex recipe 76](https://archeagecodex.com/us/recipe/76/)).
- **Tradable** certificate: needs Construction skill 230k and costs 300 LP per 5 ([recipe 9267](https://archeagecodex.com/us/recipe/9267/)). Also sold on the auction house and in the cash shop.
- So an 8×8 garden costs roughly **275 LP a week**.

**Heavy tax.** The tooltip says: "Tax rates increase based on the number of buildings you own per server, as well as local tax rates."
- **2014:** owning a 3rd property added **+50% to all** your properties. For example, three 8×8 gardens cost 22 certificates instead of 15. The surcharge kept rising with each extra property up to 10 properties ([fanaticalswordsman](https://thefanaticalswordsman.com/2014/11/12/the-pros-and-cons-of-archeage-housing-and-pvp/)).
- **3.0 era (approximate):** a private-server post mirroring the live rules gives +100% at 3 properties, rising to +500% at 8–10, with Solar/Lunar farms exempt ([ArcheRage](https://na.archerage.to/forums/threads/3-0-updates-land-and-taxation.4962/)).

**Non-payment.**
1. After about **1 week** late, a fee is added.
2. After about **2 weeks**, the building is **demolished** at a fixed time of day.
3. The plot then goes to whoever clicks first ("lowest latency wins").
4. The design comes back by mail after 22 hours ([TenTonHammer](https://www.tentonhammer.com/guides/archeage-housing-guide-construction-and-upkeep), [MGW](https://www.magicgameworld.com/?p=123910)).

### 4.5 Permissions, furniture and what a house gives you

- **Permissions:** private, family, guild or public. "Family" is a special friends list that grants access. Setting a farm to public makes its crops fair game. Exact menu labels: (unverified).
- **Furniture** can be placed freely (no fixed slots) up to the decor limit. Some pieces give crafting bonuses.
- **What a house provides** ([gamepressure](https://www.gamepressure.com/archeage/8-houses-and-fields/z869ed), [TenTonHammer](https://www.tentonhammer.com/guides/archeage-trade-pack-guide)):
  - storage chests and a mailbox
  - **trade-pack storage** (6 days on protected land)
  - a fireplace that acts as a **teleport anchor**
  - a **bed** that restores labor
  - doors and windows that open and close, so the house works as a PvP shelter
  - **regal crafting stations** needed for top-tier crafts

### 4.6 Why land was valuable, and the land rush

**Why land mattered.** Owned land meant:
- protected crops
- safe pack storage
- crafting stations
- a home to teleport back to
- location advantages (trade routes, climate)
- resale value

**The rush.**
- The best land went during the paid **head start** ($50–$150 founder packs).
- Players held plots with cheap scarecrows, likened to "towels on beach chairs".
- Alts and bots claimed more.
- Speculators organised headstart claims to resell later, and "land barons" emerged ([Engadget](https://www.engadget.com/2014/09/19/working-as-intended-lessons-from-the-history-of-mmo-housing/), [mein-mmo](https://mein-mmo.de/en/archeage-everywhere-towels-lie-no-land-in-sight,18339)).

The same rush happened again with Auroria (Nov 2014, plagued by server errors), the 2015 server merges, and Unchained (19 Oct 2019).

**The developer's later answer.** XLGames' successor, *ArcheAge Chronicles*, uses **channel-based** shared, persistent housing zones, specifically to avoid land rushes and sniping ([MassivelyOP 2025](https://massivelyop.com/2025/08/01/interview-archeage-chronicles-xlgames-on-housing-pvp-launch-and-its-mmo-nature/), via search).

---

## 5. Starter zones and the new-player journey

### 5.1 Zones and safety

**Starting zones by race:**

| Race | Starting zone |
|---|---|
| Nuian | Solzreed Peninsula |
| Elf | Gweonid Forest |
| Harani | Arcum Iris |
| Firran | Falcorth Plains |
| Dwarf (3.0) | Aubre Cradle, then Airain Rock |
| Warborn (3.0) | Sunbite Wilds |

Source: [MassivelyOP](https://massivelyop.com/2018/07/05/archeage-is-rolling-out-next-phase-of-fresh-start-servers-with-reign-part-1/); Harani and Firran from wiki excerpts.

**PvP rules by level and zone:**
- **Levels 1–~30** take place in faction-protected zones. Enemies there cannot start a fight, though you may fight back.
- **At level 30** players enter contested zones such as Halcyona. These cycle **conflict → war → peace**, and PvP deaths push a zone into war.
- **Oceans, islands and Auroria** are always open PvP ([MGW](https://www.magicgameworld.com/archeage-unchained-pvp-zones/), [TenTonHammer tips](https://www.tentonhammer.com/guides/25-tips-to-explain-archeage-mechanics-for-new-players)).

**Main story.** Each race has a story quest line, marked in green. It was told with slow pans over concept art. Massively's verdict: "Yawn" ([Engadget](https://www.engadget.com/2014/09/15/massivelys-archeage-launch-diary-day-three-pve-quests-and/)).

### 5.2 Milestones

| Milestone | Original game, before Unchained (Nuian example; exact patch unverified) | Unchained (2019+) |
|---|---|---|
| **First mount** | **Level 6**, Solzreed. Plant a Vita Seed at the stable, harvest the root (1 LP), pick a foal, then "feed it when it's hungry, wash it when it's dirty, and play with it when it's sad" ([codex 4294](https://archeagecodex.com/us/quest/4294/), [4295](https://archeagecodex.com/us/quest/4295/)) | From side quests that tutorial pop-ups point you to |
| **First farm** | **Level 7** Blue Salt Brotherhood tutorial (below) | **Levels 30–33**, Solisa in Halcyona. "Earning Your Garden" gives the 8×8 design, 15 bound certificates, 100 mushrooms and lumber ([codex 8720](https://archeagecodex.com/us/quest/8720)) |
| **Glider** | Levels ~7–10 ("Experimental Glider"), upgraded at levels 10, 15 and 20. Easy to miss. | Similar |
| **Boat** | A rowboat from early quests by about level 10. Can also be crafted from 10 lumber. | Same |
| **Trade run and donkey** | A donkey from a trade-pack quest (level unverified). Early packs use local farm goods, e.g. Solzreed Dried Food = 50 meat + 35 grapes + a certificate (pre-6.0 wiki, via search) | **Level 30** "The Basics of Trade": donkey foal, then a Mahadevi → Austera run ([codex 6769](https://archeagecodex.com/us/quest/6769)) |
| **Vehicle** | Farm cart or tractor crafted from rare materials (e.g. Thunderstruck logs) | **Level 44** farm-cart quest ([codex 8767](https://archeagecodex.com/en/quest/8767)) |
| **16×16 farm** | From trade-run quests or by crafting | **Level 50** Blue Salt quest |
| **House** | Needs Patron status, 15 Gilda and about 3 packs, whenever you can afford them | Anyone, if a free plot exists |

**The level-7 tutorial.** It has two parallel quest branches, and every step teaches a system:
1. Plant and water barley and potatoes on the public farm. The crops are protected for 3 days.
2. Raise and slaughter a chicken, then make leather.
3. Smelt an ingot, cut a brick and saw lumber.
4. Deliver a seed to the Daru auctioneer at the **Mirage Isle** portal and earn a **Gilda Star**.
5. Receive the **Scarecrow Garden Design**, Lumber and **25 bound tax certificates**.
6. Visit housing areas to choose a plot. The starter zones also had temporary garden areas.
7. At level 10, "Choosing a Path" sends you on to Windshade or Solisa.

Codex sources: [4417](https://archeagecodex.com/us/quest/4417), [4421](https://archeagecodex.com/en/quest/4421), [4435](https://archeagecodex.com/us/quest/4435), [4439](https://archeagecodex.com/en/quest/4439), [4438](https://archeagecodex.com/en/quest/4438), [4779](https://archeagecodex.com/en/quest/4779).

### 5.3 What worked and what dragged

**What worked:**
- Every life skill got its own hands-on micro-quest by about level 10.
- Mounts, gliders and boats came early.
- The world felt like "a world as opposed to a series of lobbies".
- Crafting and trading gave XP.

**What dragged:**
- WoW-style "kill-10-rats" quest hubs.
- A weak story presentation.
- A month or more to reach level 30 at a casual pace.
- Labor gating.
- Unchained pushed the first farm back to level 30.
- Latecomers often found **no land left**.

---

## 6. What players loved and hated

**What players loved:**
- A house and farm in a **shared, visible world**, with neighbours, guild villages and player-made scenery such as a cherry-blossom wood.
- Being able to **plant anywhere**, with real risk and occasional "lottery" finds.
- Growing from an 8×8 garden to a farmhouse, and turning the produce into **trade packs**.
- Construction as a hard-earned brag.
- Windfalls from Thunderstruck trees.
- A player real-estate market.
- Courtroom drama.

Sources: [nullsignifier](https://nullsignifier.blogspot.com/2014/12/adrift-in-archeage-part-ii-squatters.html), [MMOHuts](https://mmohuts.com/review/archeage).

**Pain points:**
- **Scarce land and land rushes that favoured paying head-start buyers**, bots and land barons.
- Housing locked behind a subscription.
- Labor potions sold in the cash shop.
- **Griefing by theft and uprooting**, and juries that could be bribed.
- **Timer chores**: wither and death penalties pushed people onto third-party harvest timers.
- Repeated land rushes after server merges.
- Cash-shop farms exempt from the multi-property tax.

Sources: [Engadget](https://www.engadget.com/2014/09/19/working-as-intended-lessons-from-the-history-of-mmo-housing/), [fanaticalswordsman](https://thefanaticalswordsman.com/2014/11/12/the-pros-and-cons-of-archeage-housing-and-pvp/).

---

## 7. Design takeaways for an original game

- **Hand every player a private micro-plot early, around level 5–10.** Teach it with a short quest chain: plant → water → harvest → craft → sell. ArcheAge's best onboarding was the level-7 garden and the foal you raise by growing its food. Unchained lost much of that hook by moving the farm to level 30.
- **Make ownership visible, but don't make land zero-sum.** Plots in the shared world build community. A fixed land supply breeds rushes, squatting and resale. Use per-account caps and channels or instanced copies, or scale land with population. Never let an empty placeholder count as ownership.
- **Make land tiers readable.** For example 8×8 → 16×16 → a specialised homestead (farm, mine or workshop). Each tier should unlock a new action, such as a workstation, seedbeds or pack storage.
- **Make upkeep a gameplay sink that recycles land.**
  - Charge a weekly tax in a labor-earned currency.
  - Raise it progressively for extra plots and take a refundable deposit.
  - Send clear warnings before anything is lost.
  - Reassign reclaimed plots by lottery or queue, never "lowest latency wins".
- **Mix growth timers of different lengths, with forgiving windows.** Pair minutes-long crops with multi-day trees and recurring livestock produce, so there are hooks for both short and long sessions. Add notifications and soft penalties (lower yield) instead of death or withering.
- **Give biomes a climate bonus (about 30% faster growth).** That makes location matter, creates regional specialities and feeds trade.
- **Give the commons real risk and reward.** Offer timed-protection public plots and unprotected wild planting. Make theft leave traceable evidence, and keep punishment proportionate and resistant to bribes.
- **Make construction a social, physical project.** Players haul packs to the site and anyone can contribute. Use visible build stages and clear refining ratios so a house takes days, not minutes.
- **Use one energy budget for pacing, not as a paywall.** Let non-combat play level characters. Don't sell refills or stop offline regeneration for free players.
- **Make homes functional hubs** with storage, a teleport anchor, a rest bonus, exclusive crafting stations and a place to stage trade packs.
- **Hide small jackpots in routine loops.** A Thunderstruck-style rare outcome keeps long-term farming exciting.
- **Connect quiet farming to risky travel.** Turn produce into trade packs worth more the farther and more dangerous the delivery.
