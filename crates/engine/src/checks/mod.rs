//! The checks' scenarios, run through the rules: each takes a scenario as the conformance tests write
//! it (JSON) and gives back what happened, frame by frame (JSON). The check programs in crates/tools
//! print it for tests/conformance/ to compare with the TypeScript's; the golden tests below hold it to
//! the answers that comparison proved, so the engine keeps its guard when the TypeScript rules and
//! their comparisons go (the refactor's Phase 8).
//!
//! The golden scenarios are in tests/golden/ (one file per check): each case's scenario, and a hash of
//! what the rules gave back when the TypeScript last agreed with it. They're written by the
//! conformance tier (tests/conformance/golden.ts): `RUINA_GOLDEN=1 npm run test:conformance`, after a
//! change it has just passed on (a rule changed on both sides, the island rebaked).

/// Creatures: one brain on its own, or packs and war-bands fighting (aicheck).
pub mod ai;
/// A player on the old battlefield's flat ground: movement, combos, casts, skills (simcheck).
pub mod player;
/// A player on Emberholm: hills, cliffs, decks, water, gliders, packs (worldcheck).
pub mod world;

#[cfg(test)]
mod tests {
    use serde_json::{Map, Value, json};

    /// FNV-1a, 64 bits, over the text's bytes, as tests/conformance/golden.ts hashes what a check printed.
    fn fnv1a64(text: &str) -> String {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in text.bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        format!("{h:016x}")
    }

    /// A step as the fixtures keep it (a row of numbers, golden.ts STEP), as the scenario's own JSON.
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

    /// Every case of a check: its name, its scenario as the check program reads it, and the hash kept.
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

    /// Runs every case of a check and lists the ones whose answers aren't the ones kept.
    fn differ(check: &str, run: fn(&str) -> serde_json::Result<String>) -> Vec<String> {
        cases(check)
            .into_iter()
            .filter_map(|(name, input, hash)| {
                let got = fnv1a64(&run(&input).expect("the scenario runs"));
                (got != hash).then(|| format!("{name}: {got}, kept {hash}"))
            })
            .collect()
    }

    const WHY: &str = "a rule's answers changed from the ones the TypeScript agreed with; if both sides changed on purpose, \
                       write the new answers with RUINA_GOLDEN=1 npm run test:conformance";

    #[test]
    fn creatures_give_the_answers_the_typescript_agreed_with() {
        assert_eq!(differ("aicheck", super::ai::run), Vec::<String>::new(), "{WHY}");
    }

    #[test]
    fn a_player_gives_the_answers_the_typescript_agreed_with() {
        assert_eq!(differ("simcheck", super::player::run), Vec::<String>::new(), "{WHY}");
    }

    #[test]
    fn a_player_on_the_island_gives_the_answers_the_typescript_agreed_with() {
        assert_eq!(differ("worldcheck", super::world::run), Vec::<String>::new(), "{WHY}");
    }

    #[test]
    fn the_hash_is_the_conformance_tiers() {
        // tests/conformance/golden.ts gives these for the same texts.
        assert_eq!(fnv1a64(""), "cbf29ce484222325");
        assert_eq!(fnv1a64("{\"frames\":[]}"), "d0a940566ed844c1");
    }
}
