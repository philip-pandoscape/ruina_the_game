//! The mini-games' rules for the browser's board views (src/engine/minigames.ts): the same rules
//! modules the server plays the games by (crates/engine/src/minigames/games/), asked how a game's
//! board is laid out and what a player may do now, so the browser keeps no copy of them and its
//! board offers just what the server would take. A game is named by its place in
//! shared/minigames.json, as it goes on the wire.

use ruina_engine::minigames::{self, Asking};

use super::{give, text};

/// The board of the game at `game` in the bundle, as its rules lay it out (JSON in the game's own
/// terms) at `out_ptr()`. Returns its length, or 0 if there's no such game.
#[unsafe(no_mangle)]
pub extern "C" fn minigame_layout(game: u32) -> usize {
    match minigames::game(game as usize) {
        Some(g) => give(g.layout().to_string()),
        None => 0,
    }
}

/// What a player may do now in the game at `game` in the bundle: `n` bytes of JSON at `p`, what
/// they ask (`Asking`: their seat, whose move it is, the game as the server shows it to them and
/// what they've picked), answered in the game's own terms at `out_ptr()`. Returns its length, or 0
/// if there's no such game or what they ask isn't about it.
///
/// # Safety
/// `p..p + n` lies in room `alloc` gave.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn minigame_options(game: u32, p: *const u8, n: usize) -> usize {
    let Some(g) = minigames::game(game as usize) else { return 0 };
    let Ok(asking) = serde_json::from_str::<Asking>(unsafe { text(p, n) }) else {
        return 0;
    };
    match g.options(&asking) {
        Ok(o) => give(o.to_string()),
        Err(_) => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn answer() -> Value {
        crate::OUT.with(|o| serde_json::from_slice(&o.borrow()).unwrap())
    }

    fn options(game: u32, asking: &Value) -> usize {
        let s = asking.to_string();
        unsafe { minigame_options(game, s.as_ptr(), s.len()) }
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

    #[test]
    fn a_player_is_told_what_they_may_do_as_the_engine_tells_the_server() {
        for (i, g) in minigames::content().games.iter().enumerate() {
            let rules = g.deal(9);
            let view = rules.view(Some(0));
            let asking = json!({ "you": 0, "toMove": 0, "view": view, "picked": null });
            assert!(options(i as u32, &asking) > 0, "{}", g.id);
            let native = g.options(&serde_json::from_value(asking.clone()).unwrap()).unwrap();
            assert_eq!(answer(), native, "{}: the same answer through the text", g.id);
            // Not a view of the game, nor a game at all: no answer.
            assert_eq!(options(i as u32, &json!({ "you": 0, "toMove": 0, "view": {} })), 0, "{}", g.id);
            assert_eq!(options(minigames::content().games.len() as u32, &asking), 0);
        }
        let s = "not JSON";
        assert_eq!(unsafe { minigame_options(0, s.as_ptr(), s.len()) }, 0);
    }
}
