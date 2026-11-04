# ArcheAge: Movement and Transport Systems

*Research brief for an original game with comparable mechanics. It covers gliders, mounts, land vehicles and ships, and how each interacts with trade packs. Combat and classes are out of scope.*

## 0. Sources and caveats

- **Versions:** ArcheAge launched in Korea in 2013 and in NA/EU in September 2014 (Trion Worlds, then gamigo, plus the buy-to-play "Unchained" in 2019). Western service reportedly closed on 27 June 2024. Numbers drifted across patches, so I note the version wherever a source states it.
- **Fandom wiki:** archeage.fandom.com blocks automated fetching. Figures from it were read via search-engine excerpts and are tagged *(fandom, via search excerpt)*.
- **ArcheRage wiki:** exact tooltip text comes from `wiki.archerage.to`, a private-server database that mirrors the official client's item, skill and buff text. It is good for mechanics but reflects a late client.
- **Speed tables:**
  - The community "ArcheAge Datasheet by TmzOS" ([Google Sheet](https://docs.google.com/spreadsheets/d/1p15wZaJe7HTUbu_WGuIoEg8O2IW4BGVyMBZ3Ervh0ac), tabs *Land Vehicles Info* and *Mounts Info*, cited below as TmzOS).
  - A Russian 5.5-era guide ([notesread.com](https://notesread.com/archeage-5-5-guide-land-transport/), cited as the RU guide).
- **Units and verification:** units are m/s. Anything I could not confirm is marked **(unverified)**.

## 1. Speed ladder at a glance

| Mode | Example | m/s | Source |
|---|---|---|---|
| On foot | running character | no source found **(unverified)** | — |
| Small boat | Rowboat | 4 | fandom, via search excerpt |
| Cargo vehicle, tier 1 | Farm Cart / Farm Wagon | 4 base, 6 with fuel, 7.8 max | TmzOS; RU guide |
| Cargo vehicle, tier 2 | Farm Hauler / Farm Freighter | 5 base, 7.5 with fuel, 9.7 max | TmzOS |
| Pack mule | Gray Donkey / Mirage Donkey | 7.2 / 8 | [archerage 17644](https://wiki.archerage.to/na-en/db/items/17644), [39016](https://wiki.archerage.to/na-en/db/items/39016) |
| Race mount | Lilyut Horse, Elk, Leomorph, Snowlion | 9 | [archerage 4177](https://wiki.archerage.to/na-en/db/items/4177) |
| Premium mounts | Mirage mounts / Gallant, honor and cash mounts | 10.5 / 11.5 | TmzOS |
| Galleon | Enoan Galleon | 6.5 | fandom, via search excerpt |
| Small warship | Eznan Cutter / Lutesong Junk | 7.4 (8.4) | fandom, via search excerpt |
| Fishing boat | Fish-Find Longliner | 8.3 (11.1) | fandom, via search excerpt |
| Trade ship | Merchant Schooner | 10 | fandom; [AA Classic](https://wiki.aa-classic.com/Ships) |
| Fast ship | Harpoon / Adventure Clipper | 11.1 | fandom, via search excerpt |
| Car | Coupe / Speedster | about 14 uphill, 16 on flat road, 27 downhill (player-measured); top speed 30 per TmzOS | [Steam](https://steamcommunity.com/app/304030/discussions/0/3145094199306584725); TmzOS |
| Bike / board | Steambike / Cogwheel Longboard | top speed 26 / 33 | TmzOS |

Notes:
- The fandom ship table gives a second speed in brackets but doesn't explain it. It is probably boosted or maximum speed **(unverified)**.
- Fandom says its ship speeds assume basic sails, and sails can be "regraded" up to Grand-Mythic.

## 2. Gliders

### 2.1 First glider
- **Nuia:** the quest *Red's Riders* (quest level 12, available from level 8, Lilyut Hills).
  - You collect 5 Dwarven Machine Parts from a bandit camp and bring them to Engineer Red. The reward is the **Experimental Glider** ([quest 4122](https://wiki.archerage.to/na-en/db/quests/4122)).
  - In the follow-up, *Take to the Sky*, Red stands on the mountain and tells you to "try out that new glider" by flying down to the mayor in Riverspan ([4123](https://wiki.archerage.to/na-en/db/quests/4123)).
  - The tutorial is literally a glide from a peak to the quest hub.
- **Haranya:** the equivalent quest starts in Anvilton and ends with Amatur at Ironclaw Mine *(fandom, via search excerpt)*.
- **Warborn:** *Free Flying* (level 15): "Anyone can have and use a glider. No permit required." ([8182](https://wiki.archerage.to/na-en/db/quests/8182)).
- **Other quests:** several level 10–11 quests also award the Experimental Glider ([item 14677](https://wiki.archerage.to/na-en/db/items/14677)).
- **Early builds:** the first glider was temporary, and a permanent one came at about level 10–15 ([orcz FAQ](https://orcz.com/ArcheAge:_FAQ), via search excerpt; dated).

### 2.2 Deploying and flight rules
- **Deploy:** equip the glider in the back slot. In the air, double-tap jump or use a bound "use glider" key. Launching higher means flying farther *(fandom, via search excerpt)*.
- **Duration:** a flight is a **180-second buff**: "Soar on a glider. Flight ends automatically when you land." ([buff 3530](https://wiki.archerage.to/na-en/db/buffs/3530), [2099](https://wiki.archerage.to/na-en/db/buffs/2099)). Fandom adds that most gliders are capped at 3 minutes, but some rare ones last up to 10.
- **Interruption:** "You can only use glider skills while airborne and will be knocked off your glider if you are attacked". Gliders also can't be used underwater ([skill 17408](https://wiki.archerage.to/na-en/db/skills/17408)).
- **Turbulence:** open-sea turbulence throws gliders around. Griffins are immune ([Steam ship guide](https://steamcommunity.com/sharedfiles/filedetails/?id=416801428)), and so are some wings ([Sky Emperor](https://wiki.archerage.to/na-en/db/items/45811)).
- **Trade packs:** the glider takes the same back slot as a pack. Every glider tooltip reads "You can't carry another trade pack."
- **Physics:**
  - Gliders only show qualitative stats: Flight Speed, Gliding Ability ("how slowly it loses altitude"), Turning Speed, and Launch Height. Fandom calls the last one "Initial Speed".
  - I found **no published m/s, sink rate or glide ratio**, and **no updraft or thermal mechanic** (both unverified). Altitude comes only from launch point and skills.
  - The *Revelation* (3.0) patch normalized most base stats. After that, gliders differ mainly by skills and looks *(fandom, via search excerpt)*.

### 2.3 Upgrade ladder and signature skills

| Glider | Req. lvl | Speed / Glide / Turn / Launch | Signature skill |
|---|---|---|---|
| Experimental | 1 | Low / Low / Low / Low | none |
| Ultimate (Experimental, then Improved, Enhanced, Ultimate at levels 10/15/20) | 20 | High / Very High / High / High | Somersault |
| Red Dragon | 40 | Very High / High / Moderate / Very High | Divebomb |
| Moonshadow | 40 | Moderate / High / Very High / Very High | Shadow Flight |
| Thunderbolt | 40 | Low / Very High / High / Very High | Bombard |
| Ezi's | 40 | High / Very High / High / High | Invincible Flight |

- Sources: [23381](https://wiki.archerage.to/na-en/db/items/23381), [18175](https://wiki.archerage.to/na-en/db/items/18175), [23612](https://wiki.archerage.to/na-en/db/items/23612), [23613](https://wiki.archerage.to/na-en/db/items/23613), [18174](https://wiki.archerage.to/na-en/db/items/18174).
- ArcheRage lists the Ultimate Glider as an ingredient for all four level-40 gliders. Progression is one linear upgrade path followed by a specialization.
- A 2013 Korean guide shows the same structure. Its early "Takeoff" skill "lifts you several meters" ([playground.ru](https://www.playground.ru/archeage/guide/archeage_gajd_po_poletam_ili_glajdery-1206239)).

**Glider skills (ArcheRage skill and buff text):**

| Skill | Effect | Cooldown | Source |
|---|---|---|---|
| Glider Nitro | instant forward burst | 30 s | [13435](https://wiki.archerage.to/na-en/db/skills/13435) |
| Somersault | one roll | 6 s | [19331](https://wiki.archerage.to/na-en/db/skills/19331) |
| Glider Barrage | 298–356 damage per hit, 20 m | 3 s | [13440](https://wiki.archerage.to/na-en/db/skills/13440) |
| Air Raid | fire at ground targets, 442–788 damage | 12 s | [14236](https://wiki.archerage.to/na-en/db/skills/14236) |
| Divebomb | ram a *flying* enemy: 2,500–3,500 damage plus Trip within 3 m; you take 5,000–8,000 fixed damage; range 0–40 m | 60 s | [17666](https://wiki.archerage.to/na-en/db/skills/17666) |
| Invincible Flight | immune to damage and restraints for 3 s | — | [buff 20111](https://wiki.archerage.to/na-en/db/buffs/20111) |
| Shadow Flight / Bombard | stealth / dropped barrel bomb; a gold-seller site claims 30 s and 1,500–2,000 damage **(unverified)** | — | — |

### 2.4 Powered and true flight
- **Magithopters** (from *Revelation*):
  - They "hover in place, whilst descending very slowly" and have "much closer turning radii" *(fandom, via search excerpt)*.
  - Their stats are Air Speed, Cruising Ability, Sheering (turning) Speed and Ascension.
  - Astra Wings has Teleport Left/Right and "descend straight downward" on S ([41335](https://wiki.archerage.to/na-en/db/items/41335)).
  - Sky Emperor makes you untargetable for 5 s after Ascend.
  - Magithopters still block packs.
- **Dragons** (patch 4.5, April 2018) ([mein-mmo](https://mein-mmo.de/en/archeage-drachen-reiten,218907/)):
  - You hatch one from a Dragon Heart crafted after the Red Dragon raid, raise it with Magic Enhancers, and renew its loyalty every 30 days with a scroll.
  - Flight is limited to **5 minutes of continuous flight**.
  - *Stormwings* gives a 10 s speed burst. *Dragon's Roar* forces nearby fliers to land.
- **Gliding mounts:** late Pegasi, Griffins and Drakes can glide (TmzOS "Glide? Yes").

## 3. Mounts

### 3.1 Getting one
- **Race mounts:** each race gets a **"raise your foal" quest at about level 5–8**.
  - *How to Raise Your Leomorph* (level 5) hands you a young mount. You "feed it when it's hungry" and "socialize it through play" until it is grown ([1182](https://wiki.archerage.to/na-en/db/quests/1182)).
  - Elk is level 6 and Snowlion level 8. Massively says "around level 7".
  - Other races' mounts can be bought cheaply at stables ([Massively diary, day 5](https://www.engadget.com/2014-09-17-massivelys-archeage-launch-diary-day-5-random-archeage-knowl.html)).
- **Donkey:** a **Donkey Foal comes from the trade-tutorial quests** (TmzOS *Bluesalt Quests* tab: "The Basics of Trade"). It can also be bought at stables or on Mirage Isle ([Tenton Hammer](https://www.tentonhammer.com/guides/archeage-trade-pack-guide)).

### 3.2 Speeds

| Mount | Base m/s | Source |
|---|---|---|
| Heifer / Cow (Mirage Isle) | 7.0–7.35 | fandom excerpt; [closed-beta (CBT) forum](https://forums.craftingworlds.com/threads/archeage-mounts.2280) |
| Gray Donkey / Mirage Donkey | 7.2 / 8 (CBT: 7.56) | archerage; CBT |
| Race mounts | 9 | archerage |
| Yata (jump mount) | 10.4 (CBT) | CBT forum |
| Mirage race mounts | 10.5 | TmzOS |
| Gallant, honor-shop and top cash mounts | 11.5 | TmzOS |

### 3.3 Skills, progression, passengers, death
- **Skill unlocks:** skills unlock at mount levels **5, 10, 15, 20 and 25**.
  - Horse: Run!, Mounted Attack, Back Kick, Mounted Defense, Breakthrough.
  - Elk: mounted archery and Elegant Leap.
  - Leomorph: Owner's Escape and Stealth Move ([19361](https://wiki.archerage.to/na-en/db/items/19361)).
  - Snowlion: Overrun and Dash ([15560](https://wiki.archerage.to/na-en/db/items/15560)).
- **Run!:** "+50% for 10 sec" on a 30 s cooldown. "Can't be used while carrying a trade pack" ([17092](https://wiki.archerage.to/na-en/db/skills/17092)).
- **Donkey skills:**
  - *Dreaming Donkey*: "+30% for 1 min. Can only be used while wearing a trade pack and consumes 1 Carrot". 60 s cooldown, and combat cancels it ([15267](https://wiki.archerage.to/na-en/db/skills/15267)).
  - *La Mancha's Call*: a 7 s lance charge with no turning. It can't be used with a pack ([19087](https://wiki.archerage.to/na-en/db/skills/19087)).
- **Progression:** mounts earn XP from travel and from fights while summoned. Grouping reduces that XP. Gear is a mask, saddle and leg armor bought from stablehands ([mmogah blog](https://mmogaharcheagegold.blogspot.com/2014/10/how-to-upgrade-your-mount-in-archeage.html)).
- **Passengers:** horses, elks and snowlions carry 2 riders. Press **H** to hop on; the owner presses **R** to eject you (Massively, day 5).
- **Death:** a mount has its own HP. If it is incapacitated, you revive it at a stablehand.
  - In the closed beta, an emergency revive gave "1 HP" and "30% slower" movement. Permanent revival cost a fee that scaled with level (CBT forum).
  - Whether hits dismount the rider: **(unverified)**.
- **Mounts with packs:** you can ride while carrying a pack, but mount skills are disabled.
  - With a pack you can't run or glide, and even mounted "you… move… very… slowly" ([Massively diary, day 4](https://www.engadget.com/2014-09-16-massivelys-archeage-launch-diary-day-four-trade-runs-sea-be.html)).
  - The donkey is the dedicated pack animal; an Unchained guide gives about 5 m/s with a pack ([MGW](https://www.magicgameworld.com/?p=42608)).
  - Fandom lists a "Speed w/ Pack" of 1.4–1.9 m/s (Heifer drops from 7.0 to 1.4). TmzOS lists similar values as *water* speed, so this is ambiguous **(unverified)**.

## 4. Land vehicles

### 4.1 Farm-vehicle line (the trade backbone)

| Vehicle | Packs | Seats | Base / fuel / max m/s | Durability (RU) | Restore if destroyed |
|---|---|---|---|---|---|
| Farm Cart | 2 | 1 | 4 / 6 / 7.8 | 8,000 | 10 handfuls of Shatigon's Sand |
| Farm Wagon | 4 | 1 | 4 / 6 / 7.8 | 8,000 | 10 |
| Farm Hauler | 6 | 1 (Red variant: 2) | 5 / 7.5 / 9.7 | 9,000 | 10 |
| Farm Freighter | 8 | 1–2 | 5 / 7.5 / 9.7 | 10,000 | 15 |

- **Sources:** pack counts and restore costs come from item text ([36293](https://wiki.archerage.to/na-en/db/items/36293), [18660](https://wiki.archerage.to/na-en/db/items/18660), [29900](https://wiki.archerage.to/na-en/db/items/29900), [41163](https://wiki.archerage.to/na-en/db/items/41163)). Every vehicle has a 5-minute cooldown after restoration. Speeds and seats come from TmzOS.
- **Durability and turning:** durability and a 9°/s turn rate come from the RU guide. Its "Small, regular, agile and cargo tractor" are matched to these vehicles by pack capacity.
- **Controls:**
  - *Eco-Friendly Fuel*: +50% for 8 min (10 min on Red variants).
  - *Axle Grease*: +25% for 4 min.
  - A horn.
  - **Owner's Mark**, which stops others from driving off with your cart ([MGW](https://www.magicgameworld.com/archeage-unchained-how-to-use-farm-cart-and-a-farm-wagon/)).
- **Crop watering:** the Wagon and larger vehicles double as crop sprayers.
- **Handling:** TmzOS tags farm vehicles "land glued" (stable, can't flip) and cars "float" (physics-driven, can flip and jump).

**How they are built**
- **Farm Cart parts:** a design plus:
  - 4 cart wheels, each 10 lumber and 10 iron ingots (120 logs and 120 ore in total).
  - A cart shaft: a rare *Thunderstruck Log* plus a Sturdy Ingot.
  - A cart engine: 10 silver ingots, 1 archeum ingot and 2 fine lumber ([wheel](https://www.magicgameworld.com/?p=42602), [shaft](https://www.magicgameworld.com/archeage-unchained-how-to-make-a-cart-shaft/), [engine](https://www.magicgameworld.com/?p=42599)).
  - The exact final assembly recipe is **(unverified)**.
- **Thunderstruck logs:** these come from randomly lightning-struck trees. They cost about 200 g in 2015 ([Steam](https://steamcommunity.com/app/304030/discussions/0/618459405724402140)).
- **Blue Salt questline (level 33+):** it walks you through the build. You get a Farm Cart Design and 5 Eco Fuel, complete "Try Out Your New Ride", then buy a Farm Wagon Design and upgrade (TmzOS).
- **Farm Wagon materials:** the Wagon also needs Auroria Firelogs ([Tenton Hammer](https://www.tentonhammer.com/guides/archeage-pre-1-7-kr-conquest-of-auroria-update-overview)).
- **Further upgrades:**
  - Wagon to Hauler to Freighter uses a "Total Upgrade Ticket". Whether that ticket was cash-shop only is **(unverified)**.
  - The RU version uses Vehicle Patents instead: 7 for the Hauler tier. Patents can be bought with premium crystals, earned with 300,000 craft reputation, or bought on the auction house.

### 4.2 Cars, bikes, boards, tanks
- **Cars** (Timber Coupe, "4-wheel Drive; 60 Horsepower"; RWD Speedsters):
  - **2 packs, 2 seats.** Brakes on Space; "Anti-Lock Brakes" on Space+W.
  - Restore costs 40 handfuls of sand ([28204](https://wiki.archerage.to/na-en/db/items/28204), [26874](https://wiki.archerage.to/na-en/db/items/26874)).
- **Steambike:** "Three-wheel Drive; 72 Horsepower", 2 packs ([43395](https://wiki.archerage.to/na-en/db/items/43395)).
- **Rampage:** 4 seats, 3 packs.
- **Longboards:** no cargo, top speed 33, with tricks (TmzOS).
- **RU-version extras:**
  - Convertibles carry 3 cargo and 3 passengers.
  - Cars have **engine temperature**; "Antifreeze" keeps it stable for 10 min.
  - Tanks need a driver and a gunner. A 3 s switch into siege mode stops movement and multiplies damage. They move at 3–5 m/s with 31,000–35,000 durability.
- **Racing:** I found no organized vehicle-racing events **(unverified)**.
- **Theft and griefing:** without Owner's Mark, thieves drive your cart into monsters so you drop packs (MGW).

## 5. Boats and ships

### 5.1 Fleet

| Ship | Design / source | m/s | HP | Pack slots | Kit | Restore (handfuls) |
|---|---|---|---|---|---|---|
| Rowboat | early quest (before about level 20) or 10 lumber | 4 | ? | 0 | 1–2 seats, lantern | 1 |
| Harpoon / Adventure Clipper | 50 Gilda Stars | 11.1 | 9,000 | 0 | front harpoon / 1 side cannon; 1 sail | 10 |
| Seawhip / Seaskimmer Speedboat | 1,200 Gilda or 6 login badges; upgrade 400 Gilda | about clipper speed (player reports) | ? | 4 | 4 seats, no guns, 2 boosts, a "hop" | 10 |
| Fish-Find Longliner | 250 Gilda | 8.3 (11.1) | 32,000 | about 6 (2 reserved for big fish) | harpoon, fish finder, crane | 10 |
| **Merchant Schooner** | 400 Gilda | 10 | 42,000 | **20** (22 per AA Classic) | 2 cannons, telescope | 15 |
| Eznan Cutter / Lutesong Junk | 250 Gilda (500 later) | 7.4 (8.4) | 52,000 | 4 | 8 cannons, 6 scuba tanks, radar, crow's nest or drum | 30 |
| Growling Yawl ("Black Pearl") | 55 fragments from ghost ships | faster than small warships | higher | ? | 8 cannons, bigger crew | ? |
| Enoan Galleon | 5,000 scraps from Lusca, or a Leviathan drop | 6.5 | **(unverified)** | many **(unverified)** | 10 cannons, 3 sails | 50 |
| Turtle ship (patch 4.0) | ? | ? | ? | ? | 7 cannons per side | ? |
| Luxury Liner | 2,800 Gilda | slow | ? | ? | party boat | ? |

- **Sources:** [AA Classic](https://wiki.aa-classic.com/Ships), [Steam ship guide](https://steamcommunity.com/sharedfiles/filedetails/?id=416801428), [mmohuts](https://mmohuts.com/news/archeage-naval-overview-feature), fandom via search excerpt, and archerage items [23398](https://wiki.archerage.to/na-en/db/items/23398), [15816](https://wiki.archerage.to/na-en/db/items/15816), [5223](https://wiki.archerage.to/na-en/db/items/5223), [27135](https://wiki.archerage.to/na-en/db/items/27135), [35018](https://wiki.archerage.to/na-en/db/items/35018). Turtle ship: [mein-mmo](https://mein-mmo.de/en/archeage-heil-meer-40,172657).
- **Buoyancy:** the Cutter tooltip says it "Can carry up to 20 passengers before losing buoyancy". Overloaded ships sink.

### 5.2 Shipyard (drydock) construction
1. **Buy the design.** Most are on Mirage Isle for Gilda Stars. A design can be traded until it is placed.
2. **Place the drydock.** It needs deep enough water with open space, and you must stand about 20 m away.
   - You also pay a retainer. For a 2014 Clipper this was 10 gold, 10 iron and 10 lumber ([mmo2go](https://mmo2go.blogspot.com/2014/09/archeage-building-clipper.html)).
   - For an Unchained warship it was 75 gold plus "Small Warship Materials": 3 Dragon Essence Stabilizers, 183 Onyx Archeum Essence and 300 Lumber ([MGW](https://www.magicgameworld.com/archeage-unchained-building-the-ship/)).
3. **Finish within the 3-day window.** The site is protected, but it disappears if unfinished ([Tenton Hammer](https://www.tentonhammer.com/guides/archeage-ship-building-and-repair-guide)).
4. **Deliver hand-carried material packs in a fixed order**, for example lumber, then iron, then fabric.
   - One pack holds 100 units. A lumber pack is about 300 logs and 25 labor.
   - "Don't make these ahead, you have to add them one at a time in a specific order."
   - Each pack visibly adds hull, and anyone carrying the right pack can contribute.
   - Pack counts per material: Clipper 1 each; Fishing boat 2 each plus a license, finder, crane and shaft; small warship 5 each; Schooner **(unverified)**.
5. **Launch** (with fireworks). You receive a summon scroll.

### 5.3 Sailing, crew, combat
- **Controls:** steering reuses the rowboat and glider keys (turn, forward, back).
- **Speed:** speed depends on sail grade.
  - Clippers can take a Caernord Sea Serpent Propellant boost.
  - The Galleon reportedly has a man-powered propeller **(unverified)**.
- **Patch 1.7a:**
  - Added nearly **100 components**: lighting, boarding gear, armaments, masts and figureheads.
  - Added **per-ship damage zones**.
  - Ships slow down once crew and weight pass a limit ([mein-mmo](https://mein-mmo.de/en/archeage-patch-morgen-ueberarbeitet-schiffskampf-284,37100)).
- **Wind:** fandom says actual speed "varies with… wind, location, time of day". The mechanism is **(unverified)**. One player measured 11 sailing north–south against 10 east–west.
- **Equipment:**
  - Crewed cannons (cannonballs required, per mmohuts).
  - Harpoons that latch onto ships *or terrain*.
  - Radar that shows ships beyond render distance.
  - Scuba tanks, which count as a pack: they charge for 5 min and then last 10 min. They are used to escape or loot underwater.
- **Combat:** "boarding usually ends naval combat quickly" (Steam guide).

### 5.4 Summoning, sinking, repair
- **Summoning:** ships live in an inventory scroll.
  - You can't dismiss a ship **while in combat, while harpooned, or while carrying packs**.
  - Each ship has one owner, and ownership can't be traded (Steam guide).
  - Other players can take a ship under some conditions; the specifics are **(unverified)**.
- **Repair:** a sunk ship is restored with alchemist-made **Shatigon's Sand**.
  - A "Pinch" restores the rowboat. A "Spoonful" needs 10k alchemy proficiency to craft, and a "Handful" needs 20k (Tenton Hammer).
  - Per-ship costs are in the fleet table, followed by a 5-minute cooldown.

### 5.5 The sea as a PvP zone, and bosses
- **Oceans "never go into peace"** ([MGW](https://www.magicgameworld.com/archeage-unchained-pvp-zones/)). Pirates, players with high infamy, are hostile to everyone.
- **Freedich Island:** this free port became an ambush nest. A spotter would signal, and raiders "emerge from the houses" to rob trade groups. Patch 1.7 removed the houses ([mein-mmo](https://mein-mmo.de/en/archeage-freedich-the-island-of-provocation,19131)).
- **Harbors:** destination harbors get camped ([gamepressure](https://www.gamepressure.com/archeage/6-trade/z669eb)).
- **Kraken:** a "level 55 Eternal Grade world boss with over 8 million hit points" ([mmos.com](https://mmos.com/news/archeage-abyssal-kraken-world-boss)).
  - At 70% HP it can summon the Abyssal Kraken.
  - It pays 5 Gilda, 3,000 honor and a Kraken Eye.
- **Leviathan and ghost ships:** these arrived in Korean patch 1.7 ([mein-mmo](https://mein-mmo.de/en/archeage-something-big-and-wet-is-coming-our-way-sea-monsters,18383)). The Leviathan and the lesser Lusca drop the galleon design.
- **Submarine:** the Steamfish is a two-seater with an air cannon, and "you can carry a trade pack while riding it" (Tenton Hammer). It is used to salvage wrecks, which sonar reveals within 40 m. A gold-seller site claims each wreck costs 400 labor and yields about 270–400 gold **(unverified)**.

## 6. Trade packs and transport

- **Packs are physical back items.** They "slow you down and force you to forego the use of World Gates or gliders" ([Engadget](https://www.engadget.com/2014-08-11-archeage-highlights-its-trade-mission-mechanics.html)).
  - If you die, the pack drops and anyone can take it.
  - A pack dropped on your own land persists for 6 days ([Tenton Hammer](https://www.tentonhammer.com/guides/archeage-trade-pack-guide)).
- **Delivery split:** if someone else delivers your pack, they get **80%** and the crafter gets **20%**, so piracy pays (gamepressure).
- **Value:** value rises with distance and danger, scaled 70–130% by demand ([Steam](https://steamcommunity.com/app/304030/discussions/0/616188677733801958/?l=english)).
  - Overseas runs can pay in Gilda Stars or rare materials.
  - Gold arrives about a day later, with 5% interest.
- **Freshness:** later patches added pack freshness. "Luxury" packs must be delivered right away, while "Preserved" packs hold value for about 24 h ([MGW](https://www.magicgameworld.com/?p=123895)).
- **Cost:** a pack costs about 60 labor to make.

**Capacity ladder:**

| Carrier | Packs |
|---|---|
| Your back or donkey | 1 |
| Car or steambike | 2 |
| Farm Cart | 2 (plus 1 worn, so 3 per trip) |
| Speedboat | 4 |
| Small warship | 4 |
| Farm Wagon | 4 (plus 1 worn) |
| Farm Hauler | 6 |
| Longliner | about 6 |
| Farm Freighter | 8 |
| **Merchant Schooner** | **20** |
| Clipper | 0 (only what the crew wears) |

- **Loading:** packs are moved by hand, one at a time, between your back and a slot. The exact key is **(unverified)**.
- **2015 economics:** a pack was worth about 8.2 gold.
  - On foot, a player managed 4–5 packs per hour, about 33–41 gold per hour.
  - With a cart, that rose to about 98–123 gold per hour (Steam).
  - A schooner "can pay for itself in less than a week" (Steam guide).

## 7. What players loved, and the pain points

**What players loved**
- One seamless world crossed on foot, mount, ship and glider. The sea was "a major gameplay space" ([mmohuts review](https://mmohuts.com/review/archeage)).
- Emergent stories. A Massively writer was harpooned mid-crossing while pirates glided aboard, and still called it "fun" PvP with "a real purpose". Group runs were "infinitely more fun (and profitable)".
- Gliding PvP was "chaotic and beautiful", and "pirate battles were amazing". Players named gliders, trade runs and fishing runs as reasons to play ([Steam](https://steamcommunity.com/app/3218230/discussions/0/595139910033277567)).
- Building a ship pack by pack with friends, then launching it.

**Pain points**
- Slow hauling and missed public carriages or airships ("cross your fingers you didn't just miss one", [mmo2go](https://mmo2go.blogspot.com/2014/09/archeage-trade-pack-running.html)). The game had little appeal for solo traders.
- Ambushes with no counterplay (the Freedich houses), harbor camping and cart theft.
- A pay-to-win reputation. Players complained about cash-shop vehicles and boosts, labor potions, and paid chances at Thunderstruck trees ([aywren](https://aywren.com/2014/11/10/archeage-not-pay-to-win-enough)). Two cash-shop mounts were slowed *after* sale, which players called a "bait-and-switch" ([mein-mmo](https://mein-mmo.de/en/archeage-sells-particularly-fast-mount-nerfs-speed-afterwards,308736)).
- Grind gates: Gilda Stars, labor points and rare logs.
- Niche vehicles felt pointless. The speedboat was called "quite useless" because a 2-person clipper catches it. Players reasoned that the developers won't make vehicles faster "unless they can rework pirating" ([Steam](https://steamcommunity.com/app/304030/discussions/0/3145094199306584725)).

## 8. Design takeaways for an original game

1. **Make cargo physical, singular and visible.** One crate on your back that blocks your glider slot forces a clean choice between profit and mobility. Let the crate drop on death and be stolen, and give the thief a delivery cut (ArcheAge used 80/20). Interception then becomes a real gameplay loop rather than griefing.
2. **Use capacity, not speed, as the progression spine.** A ladder of 1, 2, 4, 6, 8 and 20 crates gives each step a new capability and a bigger target. Keep cargo carriers slow (about half a horse) and fast vehicles small (at most 2 crates), so convoys can be caught and escorts matter.
3. **Boost with consumables, not baselines.** Fuel at +50% for 8 min or a carrot at +30% for 1 min creates decisions and an economic sink without inflating travel speed.
4. **Hand out the glider early with a "jump off the peak and glide to town" tutorial.** Cap flights at about 3 minutes, knock riders off when hit, and let upgrades add skills rather than raw stats. I found no updrafts in ArcheAge, so thermals and ridge lift are an open differentiator that rewards map knowledge.
5. **Make shipbuilding a public construction project.** The ship is placed in the world and fed hand-hauled material crates in a fixed order. Anyone can contribute, progress shows on the hull, and a deadline (ArcheAge used 3 days) forces coordination. It ends as a summonable asset that people feel they built together.
6. **Make loss recoverable but costly.** Restore destroyed vehicles with a crafted consumable plus a cooldown. Block dismissing a vehicle while it is in combat, grappled or loaded, so nobody can despawn to save cargo. Offer an owner lock against theft.
7. **Make the sea permanently contested, with counterplay.** Give players information tools (radar, crow's nest), catch tools (harpoons), boarding, and escape tools (scuba gear). Add buoyancy and weight limits. Never let ambushers spawn from invulnerable spots next to a trade route.
8. **Raise the mount through a nurture quest at levels 5–8.** Unlock a sprint at mount level 5 and a new skill every 5 levels. Disable combat and sprint skills while hauling, and offer a slower, dedicated pack animal with its own boost.
9. **Separate handling models.** Cargo vehicles get stable, ground-glued physics. Small fast vehicles get playful physics: flips, jumps and drifts. Fun physics should never accidentally lose valuable cargo.
10. **Make routes a decision, not a solved loop.** Use freshness decay by cargo class, distance-and-danger pricing, and demand saturation of about ±30%.
11. **Run free scheduled public transport (carriages, airships) and show live timers.** Missing the bus was a recurring frustration.
12. **Keep speed, capacity and flight power out of the cash shop.** Never change the stats of something players already bought.
