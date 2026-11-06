//! Finds the mini-games' rules: a module each in src/minigames/games/, named after its game
//! (content/minigames/<id>.json), so a new game is its files and no list of games is kept anywhere.
//! Writes $OUT_DIR/minigames.rs, which src/minigames/mod.rs brings in as `games`: a `mod` for each
//! and `MODULES`, each one's `RULES` by its game's id.
//!
//! `cargo fmt` reaches a crate's files through their `mod` lines and so can't see these;
//! tools/cargo.mjs hands it the folder's files by name.

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR")).join("src/minigames/games");
    println!("cargo::rerun-if-changed={}", dir.display());
    let mut games: Vec<String> = fs::read_dir(&dir)
        .expect("src/minigames/games: the mini-games' rules")
        .map(|e| e.expect("a file in src/minigames/games").path())
        .filter(|p| p.extension().is_some_and(|x| x == "rs"))
        .map(|p| p.file_stem().expect("a file name").to_string_lossy().into_owned())
        .collect();
    games.sort();
    let mut out = String::new();
    for g in &games {
        assert!(
            g.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
            "src/minigames/games/{g}.rs: a rules module is named after its game's id, which must be a Rust name"
        );
        out += &format!("#[path = {:?}]\npub mod {g};\n", dir.join(format!("{g}.rs")).display().to_string());
    }
    out += "/// Every game's rules module, by its game's id.\npub static MODULES: &[(&str, &super::RulesModule)] = &[\n";
    for g in &games {
        out += &format!("    ({g:?}, &{g}::RULES),\n");
    }
    out += "];\n";
    fs::write(PathBuf::from(env::var("OUT_DIR").expect("cargo sets OUT_DIR")).join("minigames.rs"), out).expect("$OUT_DIR/minigames.rs written");
}
