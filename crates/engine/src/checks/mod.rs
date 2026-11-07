//! Scenarios run through the rules: each takes a scenario (JSON) and gives back what happened, frame
//! by frame (JSON). The golden tests below hold each answer to a hash, so a rule can't change
//! unnoticed. The hashes were first proved against the TypeScript copy of the rules, which the
//! conformance tier compared with these bit for bit until the browser played on the engine itself
//! (the refactor's Phase 8).
//!
//! The golden scenarios are in tests/golden/ (one file per check): each case's scenario, and a hash of
//! what the rules give back. After a change made on purpose (a rule changed, the island grown
//! differently), `RUINA_GOLDEN=1 cargo test --release -p ruina-engine golden` keeps the new answers.

/// Creatures: one brain on its own, or packs and war-bands fighting.
pub mod ai;
/// A crowd played as one simulation and as a world split between several, the same to the bit.
pub mod border;
/// A channel's tick: players and bots fighting, creatures among them, a passenger riding along.
pub mod crowd;
/// A player on the old battlefield's flat ground: movement, combos, casts, skills.
pub mod player;
/// A player on Emberholm: hills, cliffs, decks, water, gliders, packs.
pub mod world;

/// Named so `cargo test golden` picks out these and nothing else.
#[cfg(test)]
mod golden {
    use serde_json::{Map, Value, json};

    /// FNV-1a, 64 bits, over the text's bytes: the hash a golden case keeps of what its check gave back.
    fn fnv1a64(text: &str) -> String {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in text.bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        format!("{h:016x}")
    }

    /// A step as the golden files keep it, as the scenario's own JSON. The row: moveX, moveZ, the
    /// buttons (a bit each: jump pressed, jump held, attack, slide, sprint, crouch), ability slot,
    /// movement slot, movement held, aimX, aimZ, faceX, faceZ, stickX, stickY.
    fn step(row: &[Value]) -> Value {
        let n = |i: usize| row[i].clone();
        let buttons = row[2].as_u64().expect("the buttons");
        let mut s = Map::new();
        for (k, name) in ["jumpPressed", "jumpHeld", "attackPressed", "slidePressed", "sprintHeld", "crouchHeld"].iter().enumerate() {
            s.insert((*name).into(), json!(buttons & (1 << k) != 0));
        }
        for (i, name) in [(0, "moveX"), (1, "moveZ"), (3, "abilitySlot"), (4, "movementSlot"), (5, "movementHeld"), (6, "aimX"), (7, "aimZ")] {
            s.insert(name.into(), n(i));
        }
        for (i, name) in [(8, "faceX"), (9, "faceZ"), (10, "stickX"), (11, "stickY")] {
            s.insert(name.into(), n(i));
        }
        Value::Object(s)
    }

    /// Every case of a check: its name, its scenario as the check reads it, and the hash kept.
    fn cases(check: &str) -> Vec<(String, String, String)> {
        let path = format!("{}/tests/golden/{check}.json", env!("CARGO_MANIFEST_DIR"));
        let file: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("the golden file")).expect("golden JSON");
        assert_eq!(file["check"], check);
        let scripts: Vec<Value> = file["scripts"]
            .as_array()
            .map(|list| {
                list.iter()
                    .map(|runs| {
                        let mut steps = Vec::new();
                        for run in runs.as_array().expect("runs") {
                            let s = step(run[1].as_array().expect("a step"));
                            steps.extend(std::iter::repeat_n(s, run[0].as_u64().expect("a count") as usize));
                        }
                        Value::Array(steps)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let list = file["cases"].as_array().expect("cases");
        assert!(!list.is_empty(), "{check}: no cases");
        list.iter()
            .map(|c| {
                let mut input = c["input"].clone();
                if let Some(k) = input.get("steps").and_then(Value::as_u64) {
                    input["steps"] = scripts[k as usize].clone();
                }
                (c["name"].as_str().expect("a name").to_string(), input.to_string(), c["hash"].as_str().expect("a hash").to_string())
            })
            .collect()
    }

    /// Runs every case of a check and lists the ones whose answers aren't the ones kept. With
    /// RUINA_GOLDEN set, the answers given are kept instead (a rule changed on purpose).
    fn differ(check: &str, run: fn(&str) -> serde_json::Result<String>) -> Vec<String> {
        let found: Vec<(String, String, String)> = cases(check)
            .into_iter()
            .map(|(name, input, kept)| {
                let got = fnv1a64(&run(&input).expect("the scenario runs"));
                (name, kept, got)
            })
            .collect();
        if std::env::var_os("RUINA_GOLDEN").is_some() {
            keep(check, &found);
            return Vec::new();
        }
        found.into_iter().filter(|(_, kept, got)| got != kept).map(|(name, kept, got)| format!("{name}: {got}, kept {kept}")).collect()
    }

    /// Writes the answers given in place of the ones kept, case by case: each case is a line of its
    /// own in the golden file, so only the hashes that changed change.
    fn keep(check: &str, found: &[(String, String, String)]) {
        let path = format!("{}/tests/golden/{check}.json", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).expect("the golden file");
        let lines: Vec<String> = text
            .lines()
            .map(|line| {
                let Ok(case) = serde_json::from_str::<Value>(line.trim_end_matches(',')) else { return line.to_string() };
                let Some((_, kept, got)) = found.iter().find(|(name, _, _)| case["name"] == name.as_str()) else { return line.to_string() };
                line.replacen(&format!("\"hash\":\"{kept}\""), &format!("\"hash\":\"{got}\""), 1)
            })
            .collect();
        std::fs::write(&path, lines.join("\n") + "\n").expect("the golden file written");
    }

    const WHY: &str = "a rule's answers changed from the ones kept; if it changed on purpose, \
                       keep the new answers with RUINA_GOLDEN=1 cargo test --release -p ruina-engine golden";

    #[test]
    fn creatures_give_the_answers_kept() {
        assert_eq!(differ("aicheck", super::ai::run), Vec::<String>::new(), "{WHY}");
    }

    #[test]
    fn creatures_give_the_same_answers_in_any_order() {
        // Every pack, its list shuffled before each frame with seeds of its own: what the order the
        // creatures are stepped in changes is nothing at all (crate::actors).
        let mut differ = Vec::new();
        for (name, input, kept) in cases("aicheck") {
            let mut scenario: Value = serde_json::from_str(&input).expect("a scenario");
            if scenario.get("pack").is_none() {
                continue;
            }
            for seed in 1..=8u32 {
                scenario["order"] = json!(seed.wrapping_mul(0x9e37_79b1));
                let got = fnv1a64(&super::ai::run(&scenario.to_string()).expect("the scenario runs"));
                if got != kept {
                    differ.push(format!("{name}, shuffled with seed {seed}: {got}, kept {kept}"));
                }
            }
        }
        assert_eq!(differ, Vec::<String>::new(), "the order creatures are stepped in changed what happened");
    }

    #[test]
    fn a_crowd_gives_the_answers_kept() {
        assert_eq!(differ("crowdcheck", super::crowd::run), Vec::<String>::new(), "{WHY}");
    }

    #[test]
    fn a_crowd_gives_the_same_answers_in_any_order() {
        // Every crowd, stepped in orders of its own (the players, the bots' brains and the
        // creatures shuffled afresh each tick) with sixteen seeds: what the order everything is
        // stepped in changes is nothing at all (crate::combat).
        let mut differ = Vec::new();
        for (name, input, kept) in cases("crowdcheck") {
            let mut scenario: Value = serde_json::from_str(&input).expect("a scenario");
            for seed in 1..=16u32 {
                scenario["order"] = json!(seed.wrapping_mul(0x9e37_79b1));
                let got = fnv1a64(&super::crowd::run(&scenario.to_string()).expect("the scenario runs"));
                if got != kept {
                    differ.push(format!("{name}, shuffled with seed {seed}: {got}, kept {kept}"));
                }
            }
        }
        assert_eq!(differ, Vec::<String>::new(), "the order the crowd is stepped in changed what happened");
    }

    #[test]
    fn a_crowd_at_a_border_gives_the_answers_kept() {
        assert_eq!(differ("bordercheck", super::border::run), Vec::<String>::new(), "{WHY}");
    }

    #[test]
    fn a_world_split_between_simulations_plays_as_one() {
        // Every border case, played split each way it lists (crate::border): the same answer to
        // the bit as one simulation's, kept above. Half of them with every post between the
        // simulations written out and read back, as between processes.
        let mut differ = Vec::new();
        for (name, input, kept) in cases("bordercheck") {
            for (k, rule) in super::border::splits(&input).expect("its splits").into_iter().enumerate() {
                let got = fnv1a64(&super::border::run_split(&input, rule, k % 2 == 1).expect("the scenario runs"));
                if got != kept {
                    differ.push(format!("{name}, split {rule:?}: {got}, kept {kept}"));
                }
            }
        }
        assert_eq!(differ, Vec::<String>::new(), "a world split between simulations played otherwise than one");
    }

    #[test]
    fn a_player_gives_the_answers_kept() {
        assert_eq!(differ("simcheck", super::player::run), Vec::<String>::new(), "{WHY}");
    }

    #[test]
    fn a_player_on_emberholm_gives_the_answers_kept() {
        assert_eq!(differ("worldcheck", super::world::run), Vec::<String>::new(), "{WHY}");
    }

    #[test]
    fn the_hash_is_fnv1a_64() {
        // The hashes kept were made by the TypeScript's FNV-1a over the same texts; these are its.
        assert_eq!(fnv1a64(""), "cbf29ce484222325");
        assert_eq!(fnv1a64("{\"frames\":[]}"), "d0a940566ed844c1");
    }
}
