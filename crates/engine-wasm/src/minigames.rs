//! The mini-games' rules for the browser's board views (src/engine/minigames.ts): the same rules
//! modules the server plays the games by (crates/engine/src/minigames/games/), asked how a game's
//! board is laid out, so the browser keeps no copy of them. A game is named by its place in
//! shared/minigames.json, as it goes on the wire.

use ruina_engine::minigames;

use super::give;

/// The board of the game at `game` in the bundle, as its rules lay it out (JSON in the game's own
/// terms) at `out_ptr()`. Returns its length, or 0 if there's no such game.
#[unsafe(no_mangle)]
pub extern "C" fn minigame_layout(game: u32) -> usize {
    match minigames::game(game as usize) {
        Some(g) => give(g.layout().to_string()),
        None => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer() -> serde_json::Value {
        crate::OUT.with(|o| serde_json::from_slice(&o.borrow()).unwrap())
    }

    #[test]
    fn every_game_lays_out_its_board_and_no_other_does() {
        let games = minigames::content().games.len();
        for g in 0..games {
            assert!(minigame_layout(g as u32) > 0, "game {g}");
            assert!(answer().is_object(), "game {g}");
        }
        assert_eq!(minigame_layout(games as u32), 0);
    }
}
