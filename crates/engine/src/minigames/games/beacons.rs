//! Beacons, the first mini-game: two players light beacons on a board of 37 hexes (a hexagon of
//! radius 3) by playing goods cards. Each hex shows one of six goods, six hexes of each,
//! never two alike side by side; the middle one is the Old Beacon. The deck is 48 cards, eight of
//! each good. Each player holds four, and three lie face up as the Harbour.
//!
//! A turn is one of:
//!   - one card: light any unlit hex of that good with one of your beacons;
//!   - two cards of the same good: light any unlit hex at all, the Old Beacon too;
//!   - a swap: discard one card and draw one.
//!
//! Then draw back up to four: for each card played, take a Harbour card (the deck refills its
//! place at once) or the deck's top card. An empty deck is the discards shuffled.
//!
//! Four of your beacons in an unbroken straight row, along any of the board's three directions,
//! wins. Every hex lit with no row is a draw. The challenged player moves first (seat 0).
//!
//! The numbers and the board are content (content/minigames/beacons.json `rules`), which the tables
//! hand this module, named after the game (`RULES`). On the wire hexes are numbered row by row from
//! the top (`layout`), cards by their place in your hand, goods by their place in `goods`.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::minigames::{Asking, GameDef, Rules, RulesModule};
use crate::rng::Rng;

/// The six neighbours of a hex, in axial coordinates.
const DIRS: [(i32, i32); 6] = [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)];
/// The three ways a row can run (each with its opposite).
const AXES: [(i32, i32); 3] = [(1, 0), (0, 1), (1, -1)];
/// Public moves kept for the players to see what just happened.
const LOG: usize = 6;

/// Beacons for the tables: how a game is dealt, its board as the board views draw it, and what a
/// player may do now, as their board view offers it.
pub const RULES: RulesModule = RulesModule { deal, layout, options };

fn deal(game: &'static GameDef, seed: u32) -> Box<dyn Rules> {
    Box::new(Beacons::new(setup(game), seed))
}

/// The board: each hex's axial coordinates and the good it shows (null for the Old Beacon), in the
/// order hexes are numbered, and which one is the Old Beacon.
fn layout(game: &'static GameDef) -> Value {
    let s = setup(game);
    let hexes: Vec<Value> = s.board.cells.iter().enumerate().map(|(i, &(q, r))| json!({ "q": q, "r": r, "good": s.good_at(i) })).collect();
    json!({ "hexes": hexes, "centre": s.board.centre })
}

/// What the player asking may do now (`Seen::options`), from the game as the server shows it to
/// them and the cards they've picked (places in their hand).
fn options(game: &'static GameDef, asking: &Asking) -> Result<Value, String> {
    let s = setup(game);
    let v: PlayerView = serde_json::from_value(asking.view.clone()).map_err(|e| format!("That isn't a view of Beacons: {e}"))?;
    if v.lit.len() != s.board.cells.len() {
        return Err("That isn't a view of Beacons' board.".into());
    }
    let picked: Vec<usize> = if asking.picked.is_null() {
        Vec::new()
    } else {
        serde_json::from_value(asking.picked.clone()).map_err(|_| "Cards are picked by their places in the hand.".to_string())?
    };
    let seen = Seen {
        setup: s,
        lit: &v.lit,
        hand: &v.hand,
        harbour: &v.harbour,
        stock: v.deck + v.discards,
        over: asking.to_move.is_none(),
        turn: asking.to_move == Some(asking.you),
        draws: v.draws,
    };
    Ok(seen.options(&picked))
}

/// A player's view of the game (`Beacons::view` for their seat), as much as `options` reads.
#[derive(Deserialize)]
struct PlayerView {
    lit: Vec<u8>,
    #[serde(default)]
    hand: Vec<u8>,
    harbour: Vec<Option<u8>>,
    deck: usize,
    discards: usize,
    draws: usize,
}

/// Beacons' own part of its content (`rules`).
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Def {
    pub hand: usize,
    pub harbour: usize,
    pub per_good: usize,
    pub row: usize,
    pub goods: Vec<Value>,
    pub layout: Vec<i32>,
}

/// The board's shape: each hex's axial coordinates (q, r), and the hex at each.
pub struct Board {
    pub cells: Vec<(i32, i32)>,
    pub index: BTreeMap<(i32, i32), usize>,
    /// The Old Beacon, in the middle.
    pub centre: usize,
}

impl Board {
    /// A hexagon `radius` hexes from its middle to its edge, numbered row by row from the top (r
    /// rising), q rising along each row.
    fn hexagon(radius: i32) -> Board {
        let mut cells = Vec::new();
        for r in -radius..=radius {
            for q in (-radius).max(-radius - r)..=radius.min(radius - r) {
                cells.push((q, r));
            }
        }
        let index: BTreeMap<(i32, i32), usize> = cells.iter().enumerate().map(|(i, c)| (*c, i)).collect();
        let centre = index[&(0, 0)];
        Board { cells, index, centre }
    }

    pub fn at(&self, q: i32, r: i32) -> Option<usize> {
        self.index.get(&(q, r)).copied()
    }

    pub fn neighbours(&self, i: usize) -> impl Iterator<Item = usize> + '_ {
        let (q, r) = self.cells[i];
        DIRS.iter().filter_map(move |(dq, dr)| self.at(q + dq, r + dr))
    }
}

/// Beacons as its content sets it up: its numbers, and the board its layout covers.
pub struct Setup {
    pub def: Def,
    pub board: Board,
}

impl Setup {
    /// The good shown on hex `i`, None for the Old Beacon.
    pub fn good_at(&self, i: usize) -> Option<u8> {
        u8::try_from(self.def.layout[i]).ok()
    }
}

/// Beacons' setup, read from its content the first time it's needed. This module is the one game's
/// alone (the tables find it by the game's id), so it's read once.
pub fn setup(game: &GameDef) -> &'static Setup {
    static S: OnceLock<Setup> = OnceLock::new();
    S.get_or_init(|| {
        let def: Def = serde_json::from_value(game.rules.clone()).unwrap_or_else(|e| panic!("content/minigames/{}.json `rules`: {e}", game.id));
        // A hexagon r hexes from its middle to its edge has 3r(r + 1) + 1 of them.
        let hexes = |r: i32| (3 * r * (r + 1) + 1) as usize;
        let radius = (0..).find(|&r| hexes(r) >= def.layout.len()).expect("a hexagon");
        assert_eq!(hexes(radius), def.layout.len(), "content/minigames/{}.json: the layout covers a hexagon, row by row", game.id);
        Setup { def, board: Board::hexagon(radius) }
    })
}

#[derive(Deserialize)]
#[serde(tag = "k", rename_all = "camelCase")]
enum Move {
    /// Light `hex` with the cards at these places in your hand (one, or a pair).
    Light { cards: Vec<usize>, hex: usize },
    /// Discard the card at this place in your hand, and draw one.
    Swap { card: usize },
    /// Draw: the Harbour's card `i`, or the deck's top card.
    Draw {
        from: String,
        #[serde(default)]
        i: usize,
    },
}

/// What a player at the table sees that decides what they may do: the board, their own hand, the
/// Harbour, how many cards are left to draw, whose turn it is and how many cards they still draw.
/// The server checks every move against it (`Beacons::play`), and the browser's board view asks it
/// what to offer (`options`, through the engine's WebAssembly), so the board offers just what the
/// server would take.
struct Seen<'a> {
    setup: &'static Setup,
    lit: &'a [u8],
    hand: &'a [u8],
    harbour: &'a [Option<u8>],
    /// The cards left to draw: the deck, and the discards shuffled into a new one when it runs out.
    stock: usize,
    over: bool,
    /// It's this player's turn.
    turn: bool,
    /// Cards still to draw this turn; 0 before playing.
    draws: usize,
}

impl Seen<'_> {
    fn may_move(&self) -> Result<(), String> {
        if self.over {
            return Err("This game is over.".into());
        }
        if !self.turn {
            return Err("It isn't your turn.".into());
        }
        Ok(())
    }

    /// Hexes the cards at `cards` in the hand could light: one card, the unlit hexes of its good; a
    /// pair of one good, every unlit hex. Empty for anything else.
    fn hexes_for(&self, cards: &[usize]) -> Vec<usize> {
        let hand = self.hand;
        let unlit = (0..self.lit.len()).filter(|&i| self.lit[i] == 0);
        match cards {
            [a] if *a < hand.len() => unlit.filter(|&i| self.setup.good_at(i) == Some(hand[*a])).collect(),
            [a, b] if a != b && *a < hand.len() && *b < hand.len() && hand[*a] == hand[*b] => unlit.collect(),
            _ => Vec::new(),
        }
    }

    /// Every way the hand could light a hex now: (cards, hexes), singles first, then pairs.
    fn lights(&self) -> Vec<(Vec<usize>, Vec<usize>)> {
        let n = self.hand.len();
        let mut out = Vec::new();
        for a in 0..n {
            let h = self.hexes_for(&[a]);
            if !h.is_empty() {
                out.push((vec![a], h));
            }
        }
        for a in 0..n {
            for b in a + 1..n {
                let h = self.hexes_for(&[a, b]);
                if !h.is_empty() {
                    out.push((vec![a, b], h));
                }
            }
        }
        out
    }

    fn may_light(&self, cards: &[usize], hex: usize) -> Result<(), String> {
        self.may_move()?;
        if self.draws > 0 {
            return Err("Draw your cards first.".into());
        }
        if cards.is_empty() || cards.len() > 2 {
            return Err("Play one card, or two of a kind.".into());
        }
        if hex >= self.lit.len() || self.lit[hex] != 0 {
            return Err("That hex is already lit.".into());
        }
        if !self.hexes_for(cards).contains(&hex) {
            return Err(if cards.len() == 1 {
                "One card lights a hex of its own good. Two of a kind light any hex."
            } else {
                "Two cards have to be of the same good."
            }
            .into());
        }
        Ok(())
    }

    fn may_swap(&self, card: usize) -> Result<(), String> {
        self.may_move()?;
        if self.draws > 0 {
            return Err("Draw your cards first.".into());
        }
        if card >= self.hand.len() {
            return Err("There's no such card in your hand.".into());
        }
        Ok(())
    }

    /// Drawing the Harbour's card `i` (Some), or the deck's top card (None).
    fn may_draw(&self, from_harbour: Option<usize>) -> Result<(), String> {
        self.may_move()?;
        if self.draws == 0 {
            return Err("Play a card or swap one first.".into());
        }
        match from_harbour {
            Some(i) if !matches!(self.harbour.get(i), Some(Some(_))) => Err("There's no card there.".into()),
            None if self.stock == 0 => Err("The deck is empty.".into()),
            _ => Ok(()),
        }
    }

    /// What the board view may offer: whether it's time to play or to draw; what each card in the
    /// hand can do (light a hex alone, make a pair with another card, be swapped); which hexes the
    /// picked cards (places in the hand) light, and whether they're a swap; and which Harbour cards,
    /// and whether the deck, may be drawn. Each answer is one of the checks above, asked of every
    /// hex, card and slot, so the board offers just what the server would take.
    fn options(&self, picked: &[usize]) -> Value {
        // The hexes `cards` light: those of `hexes_for` (which every hex `may_light` takes is
        // among) that the check takes.
        let lights = |cards: &[usize]| -> Vec<usize> { self.hexes_for(cards).into_iter().filter(|&h| self.may_light(cards, h).is_ok()).collect() };
        let n = self.hand.len();
        let cards: Vec<Value> = (0..n)
            .map(|c| {
                json!({
                    "light": !lights(&[c]).is_empty(),
                    "pair": (0..n).find(|&d| d != c && !lights(&[c, d]).is_empty()),
                    "swap": self.may_swap(c).is_ok(),
                })
            })
            .collect();
        let moving = self.may_move().is_ok();
        json!({
            "play": moving && self.draws == 0,
            "draw": moving && self.draws > 0,
            "cards": cards,
            "hexes": lights(picked),
            "swap": matches!(picked, [c] if self.may_swap(*c).is_ok()),
            "harbour": (0..self.harbour.len()).map(|i| self.may_draw(Some(i)).is_ok()).collect::<Vec<_>>(),
            "deck": self.may_draw(None).is_ok(),
        })
    }
}

pub struct Beacons {
    setup: &'static Setup,
    rng: Rng,
    /// The top is the end.
    deck: Vec<u8>,
    discards: Vec<u8>,
    hands: [Vec<u8>; 2],
    /// Face up; None only if the deck and the discards ran dry (they can't with two players).
    harbour: Vec<Option<u8>>,
    /// Per hex: 0 unlit, 1 seat 0's beacon, 2 seat 1's.
    lit: Vec<u8>,
    turn: usize,
    turns: u32,
    /// Cards the player to move still draws this turn (after lighting or swapping); 0 before.
    draws: usize,
    over: Option<Option<usize>>,
    /// The winning row.
    row: Vec<usize>,
    /// What just happened, as both players may see it.
    log: Vec<Value>,
}

impl Beacons {
    pub fn new(setup: &'static Setup, seed: u32) -> Beacons {
        let d = &setup.def;
        let mut rng = Rng(if seed == 0 { 1 } else { seed });
        let mut deck: Vec<u8> = (0..d.goods.len() as u8).flat_map(|g| std::iter::repeat_n(g, d.per_good)).collect();
        rng.shuffle(&mut deck);
        let mut g = Beacons {
            setup,
            rng,
            deck,
            discards: Vec::new(),
            hands: [Vec::new(), Vec::new()],
            harbour: Vec::new(),
            lit: vec![0; setup.board.cells.len()],
            turn: 0,
            turns: 1,
            draws: 0,
            over: None,
            row: Vec::new(),
            log: Vec::new(),
        };
        for _ in 0..d.hand {
            for s in 0..2 {
                let c = g.top();
                g.hands[s].extend(c);
            }
        }
        for _ in 0..d.harbour {
            let c = g.top();
            g.harbour.push(c);
        }
        g
    }

    /// The deck's top card, the discards shuffled into a new deck first if it's empty.
    fn top(&mut self) -> Option<u8> {
        if self.deck.is_empty() {
            self.deck = std::mem::take(&mut self.discards);
            self.rng.shuffle(&mut self.deck);
        }
        self.deck.pop()
    }

    fn note(&mut self, v: Value) {
        self.log.push(v);
        if self.log.len() > LOG {
            self.log.remove(0);
        }
    }

    /// What `seat` sees of the game, which their moves are checked against.
    fn seen(&self, seat: usize) -> Seen<'_> {
        Seen {
            setup: self.setup,
            lit: &self.lit,
            hand: self.hands.get(seat).map_or(&[], Vec::as_slice),
            harbour: &self.harbour,
            stock: self.deck.len() + self.discards.len(),
            over: self.over.is_some(),
            turn: seat == self.turn,
            draws: self.draws,
        }
    }

    fn light(&mut self, seat: usize, cards: &[usize], hex: usize) -> Result<(), String> {
        self.seen(seat).may_light(cards, hex)?;
        let mut order = cards.to_vec();
        order.sort_unstable_by(|a, b| b.cmp(a));
        let mut goods = Vec::new();
        for i in order {
            let g = self.hands[seat].remove(i);
            goods.push(g);
            self.discards.push(g);
        }
        self.lit[hex] = seat as u8 + 1;
        self.note(json!({ "seat": seat, "k": "light", "goods": goods, "hex": hex }));
        if let Some(row) = self.row_through(hex) {
            self.row = row;
            self.over = Some(Some(seat));
        } else if self.lit.iter().all(|&l| l != 0) {
            self.over = Some(None);
        } else {
            self.draws = cards.len();
        }
        Ok(())
    }

    fn swap(&mut self, seat: usize, card: usize) -> Result<(), String> {
        self.seen(seat).may_swap(card)?;
        let g = self.hands[seat].remove(card);
        self.discards.push(g);
        self.draws = 1;
        self.note(json!({ "seat": seat, "k": "swap" }));
        Ok(())
    }

    fn draw(&mut self, seat: usize, from_harbour: Option<usize>) -> Result<(), String> {
        self.seen(seat).may_draw(from_harbour)?;
        let card = match from_harbour {
            Some(i) => {
                let g = self.harbour[i].take().expect("may_draw found a card there");
                self.harbour[i] = self.top();
                self.note(json!({ "seat": seat, "k": "harbour", "good": g }));
                g
            }
            None => {
                let g = self.top().expect("may_draw found cards to draw");
                self.note(json!({ "seat": seat, "k": "deck" }));
                g
            }
        };
        self.hands[seat].push(card);
        self.draws -= 1;
        if self.draws == 0 {
            self.turn = 1 - self.turn;
            self.turns += 1;
        }
        Ok(())
    }

    /// The row of four or more of one player's beacons through `hex`, if lighting it made one.
    fn row_through(&self, hex: usize) -> Option<Vec<usize>> {
        let b = &self.setup.board;
        let mark = self.lit[hex];
        let (q, r) = b.cells[hex];
        for (dq, dr) in AXES {
            let mut run = vec![hex];
            for sign in [1, -1] {
                let mut k = 1;
                while let Some(i) = b.at(q + dq * sign * k, r + dr * sign * k) {
                    if self.lit[i] != mark {
                        break;
                    }
                    run.push(i);
                    k += 1;
                }
            }
            if run.len() >= self.setup.def.row {
                run.sort_unstable();
                return Some(run);
            }
        }
        None
    }

    /// How good a hex is for `seat` to light, for the server's own moves: beside more of their
    /// beacons is better, and the Old Beacon is worth having.
    fn worth(&self, seat: usize, hex: usize) -> usize {
        let mark = seat as u8 + 1;
        let b = &self.setup.board;
        b.neighbours(hex).filter(|&n| self.lit[n] == mark).count() * 2 + usize::from(hex == b.centre)
    }
}

impl Rules for Beacons {
    fn to_move(&self) -> Option<usize> {
        self.over.is_none().then_some(self.turn)
    }

    fn turns(&self) -> u32 {
        self.turns
    }

    fn play(&mut self, seat: usize, m: &Value) -> Result<(), String> {
        let m: Move = serde_json::from_value(m.clone()).map_err(|_| "That isn't a move in Beacons.".to_string())?;
        match m {
            Move::Light { cards, hex } => self.light(seat, &cards, hex),
            Move::Swap { card } => self.swap(seat, card),
            Move::Draw { from, i } => match from.as_str() {
                "harbour" => self.draw(seat, Some(i)),
                "deck" => self.draw(seat, None),
                _ => Err("Draw from the Harbour or the deck.".into()),
            },
        }
    }

    /// Out of time: the best-placed single card (else the best-placed pair, else a swap of the
    /// first card), then cards from the deck.
    fn auto(&mut self, seat: usize) {
        if self.seen(seat).may_move().is_err() {
            return;
        }
        if self.draws == 0 {
            let mut best: Option<(usize, Vec<usize>, usize)> = None;
            for (cards, hexes) in self.seen(seat).lights() {
                for h in hexes {
                    // Singles before pairs: a pair spends two cards.
                    let score = self.worth(seat, h) * 2 + usize::from(cards.len() == 1);
                    if best.as_ref().is_none_or(|b| score > b.0) {
                        best = Some((score, cards.clone(), h));
                    }
                }
            }
            let done = match best {
                Some((_, cards, hex)) => self.light(seat, &cards, hex),
                None => self.swap(seat, 0),
            };
            if done.is_err() || self.over.is_some() {
                return;
            }
        }
        while self.draws > 0 && self.over.is_none() {
            let from = if self.deck.is_empty() && self.discards.is_empty() { self.harbour.iter().position(Option::is_some) } else { None };
            if self.draw(seat, from).is_err() {
                return;
            }
        }
    }

    fn result(&self) -> Option<Option<usize>> {
        self.over
    }

    fn view(&self, seat: Option<usize>) -> Value {
        let mut v = json!({
            "lit": self.lit,
            "cards": [self.hands[0].len(), self.hands[1].len()],
            "harbour": self.harbour,
            "deck": self.deck.len(),
            "discards": self.discards.len(),
            "turn": self.turn,
            "draws": self.draws,
            "row": self.row,
            "log": self.log,
        });
        if let Some(s) = seat {
            v["hand"] = json!(self.hands[s]);
        }
        v
    }

    fn board(&self) -> Value {
        json!({ "lit": self.lit, "row": self.row })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::minigames::game_called;

    /// Beacons as its content sets it up.
    fn beacons() -> &'static Setup {
        setup(game_called("beacons").unwrap())
    }

    /// A game with hands and a deck chosen by the test (the rest of the state as dealt).
    fn rigged(hands: [Vec<u8>; 2], deck: Vec<u8>, harbour: Vec<u8>) -> Beacons {
        let mut g = Beacons::new(beacons(), 7);
        g.hands = hands;
        g.deck = deck;
        g.harbour = harbour.into_iter().map(Some).collect();
        g.discards.clear();
        g
    }

    /// The hexes showing good `g`.
    fn of_good(g: u8) -> Vec<usize> {
        (0..beacons().board.cells.len()).filter(|&i| beacons().good_at(i) == Some(g)).collect()
    }

    fn centre() -> usize {
        beacons().board.centre
    }

    /// What the board view of the player in `seat` is offered with the cards `picked` picked, from
    /// what they see (as the browser asks it).
    fn ask(g: &Beacons, seat: usize, picked: Value) -> Value {
        let asking = Asking { you: seat, to_move: g.to_move(), view: g.view(Some(seat)), picked };
        options(game_called("beacons").unwrap(), &asking).unwrap()
    }

    /// A copy of the game, to try a move on.
    fn copy(g: &Beacons) -> Beacons {
        Beacons {
            setup: g.setup,
            rng: Rng(g.rng.0),
            deck: g.deck.clone(),
            discards: g.discards.clone(),
            hands: g.hands.clone(),
            harbour: g.harbour.clone(),
            lit: g.lit.clone(),
            turn: g.turn,
            turns: g.turns,
            draws: g.draws,
            over: g.over,
            row: g.row.clone(),
            log: g.log.clone(),
        }
    }

    #[test]
    fn the_board_has_six_of_each_good_never_side_by_side_and_the_old_beacon_in_the_middle() {
        let b = &beacons().board;
        assert_eq!(b.cells.len(), 37);
        assert_eq!(b.cells[b.centre], (0, 0));
        assert_eq!(beacons().def.layout.len(), 37);
        assert_eq!(beacons().good_at(b.centre), None);
        for g in 0..6u8 {
            assert_eq!(of_good(g).len(), 6, "good {g}");
        }
        for i in 0..37 {
            let Some(g) = beacons().good_at(i) else { continue };
            for n in b.neighbours(i) {
                assert_ne!(beacons().good_at(n), Some(g), "hexes {i} and {n} show the same good side by side");
            }
        }
        // Six neighbours inside, fewer on the rim.
        assert_eq!(b.neighbours(b.centre).count(), 6);
        assert_eq!(b.neighbours(0).count(), 3);
    }

    #[test]
    fn the_layout_the_board_views_draw_is_the_board_the_rules_play_on() {
        let game = game_called("beacons").unwrap();
        let l = (RULES.layout)(game);
        let b = &beacons().board;
        assert_eq!(l["centre"], b.centre);
        let hexes = l["hexes"].as_array().unwrap();
        assert_eq!(hexes.len(), b.cells.len());
        for (i, h) in hexes.iter().enumerate() {
            assert_eq!((h["q"].as_i64().unwrap() as i32, h["r"].as_i64().unwrap() as i32), b.cells[i], "hex {i}");
            assert_eq!(h["good"].as_u64().map(|g| g as u8), beacons().good_at(i), "hex {i}");
        }
        // Row by row from the top, q rising along each.
        assert_eq!((b.cells[0], b.cells[36]), ((0, -3), (0, 3)));
        assert!(hexes[b.centre]["good"].is_null(), "the Old Beacon shows no good");
    }

    #[test]
    fn the_deal_is_four_each_three_in_the_harbour_and_the_rest_in_the_deck() {
        let g = Beacons::new(beacons(), 42);
        assert_eq!(g.hands[0].len(), 4);
        assert_eq!(g.hands[1].len(), 4);
        assert_eq!(g.harbour.iter().flatten().count(), 3);
        assert_eq!(g.deck.len(), 48 - 11);
        let mut all: Vec<u8> = g.deck.clone();
        all.extend(&g.hands[0]);
        all.extend(&g.hands[1]);
        all.extend(g.harbour.iter().flatten());
        for good in 0..6u8 {
            assert_eq!(all.iter().filter(|&&c| c == good).count(), 8);
        }
        // The same seed deals the same game; another deals another.
        assert_eq!(Beacons::new(beacons(), 42).deck, g.deck);
        assert_ne!(Beacons::new(beacons(), 43).deck, g.deck);
        assert_eq!(g.to_move(), Some(0), "the challenged player moves first");
    }

    #[test]
    fn one_card_lights_a_hex_of_its_good_and_a_pair_lights_any_even_the_old_beacon() {
        let stone = 3u8;
        let mut g = rigged([vec![stone, 0, stone, 1], vec![2, 2, 4, 5]], vec![0; 20], vec![4, 4, 4]);
        let other = of_good(5)[0];
        let mine = of_good(stone)[0];
        // A single stone card: only stone hexes.
        assert!(g.play(0, &json!({ "k": "light", "cards": [1], "hex": mine })).is_err(), "grain on a stone hex");
        assert!(g.play(0, &json!({ "k": "light", "cards": [0], "hex": other })).is_err(), "stone on an ore hex");
        assert!(g.play(0, &json!({ "k": "light", "cards": [0], "hex": centre() })).is_err(), "one card can't light the Old Beacon");
        assert!(g.play(0, &json!({ "k": "light", "cards": [0, 1], "hex": other })).is_err(), "two different goods aren't a pair");
        assert!(g.play(0, &json!({ "k": "light", "cards": [0, 0], "hex": other })).is_err(), "the same card twice isn't a pair");
        assert!(g.play(0, &json!({ "k": "light", "cards": [9], "hex": mine })).is_err(), "no such card");
        assert!(g.play(1, &json!({ "k": "light", "cards": [0, 1], "hex": other })).is_err(), "not Bea's turn");
        // Ann's board view is offered the same, from what she sees.
        let single = ask(&g, 0, json!([0]));
        assert_eq!(single["hexes"], json!(of_good(stone)));
        assert_eq!(single["cards"][0], json!({ "light": true, "pair": 2, "swap": true }));
        assert_eq!(single["cards"][1]["pair"], Value::Null, "one grain card: no pair");
        assert_eq!((single["play"].clone(), single["draw"].clone()), (json!(true), json!(false)));
        assert_eq!(ask(&g, 0, json!([0, 2]))["hexes"].as_array().unwrap().len(), 37);
        assert_eq!(ask(&g, 0, json!([0, 1]))["hexes"], json!([]), "two different goods aren't a pair");
        let bea = ask(&g, 1, json!([0]));
        assert_eq!(
            (bea["play"].clone(), bea["hexes"].clone(), bea["cards"][0]["swap"].clone()),
            (json!(false), json!([]), json!(false)),
            "only the player to move"
        );
        assert!(g.view(None).get("hand").is_none(), "onlookers don't see a hand");
        // The pair lights the Old Beacon.
        g.play(0, &json!({ "k": "light", "cards": [0, 2], "hex": centre() })).unwrap();
        assert_eq!(g.lit[centre()], 1);
        assert_eq!(g.hands[0], vec![0, 1]);
        assert_eq!(g.discards, vec![stone, stone]);
        assert_eq!(g.draws, 2, "two played, two to draw");
        assert!(g.play(0, &json!({ "k": "light", "cards": [0], "hex": of_good(0)[0] })).is_err(), "draw first");
        // A lit hex can't be lit again.
        g.draw(0, None).unwrap();
        g.draw(0, None).unwrap();
        g.play(1, &json!({ "k": "swap", "card": 0 })).unwrap();
        g.draw(1, None).unwrap();
        assert!(g.play(0, &json!({ "k": "light", "cards": [2, 3], "hex": centre() })).is_err());
    }

    #[test]
    fn drawing_takes_from_the_harbour_which_refills_from_the_deck_or_from_the_deck_and_ends_the_turn() {
        let grain = 0u8;
        let mut g = rigged([vec![grain, 1, 1, 2], vec![3, 3, 4, 5]], vec![5, 4, 3], vec![1, 2, 3]);
        g.play(0, &json!({ "k": "light", "cards": [1, 2], "hex": of_good(4)[0] })).unwrap();
        assert_eq!(g.to_move(), Some(0), "still drawing");
        assert!(g.play(0, &json!({ "k": "draw", "from": "harbour", "i": 5 })).is_err());
        // The Harbour's middle card, Timber; the deck's top (Stone, 3) takes its place.
        g.play(0, &json!({ "k": "draw", "from": "harbour", "i": 1 })).unwrap();
        assert_eq!(g.hands[0], vec![grain, 2, 2]);
        assert_eq!(g.harbour, vec![Some(1), Some(3), Some(3)]);
        assert_eq!(g.deck, vec![5, 4]);
        assert_eq!(g.turns(), 1);
        // Then the deck's top card, Wool; that's four, and Bea's turn.
        g.play(0, &json!({ "k": "draw", "from": "deck" })).unwrap();
        assert_eq!(g.hands[0], vec![grain, 2, 2, 4]);
        assert_eq!((g.to_move(), g.turns()), (Some(1), 2));
        assert!(g.play(0, &json!({ "k": "draw", "from": "deck" })).is_err(), "not her turn any more");
        // Onlookers see what came from the Harbour, but not what came off the deck.
        let log = g.view(None)["log"].clone();
        assert_eq!(log[1], json!({ "seat": 0, "k": "harbour", "good": 2 }));
        assert_eq!(log[2], json!({ "seat": 0, "k": "deck" }));
    }

    #[test]
    fn an_empty_deck_is_the_discards_shuffled() {
        let mut g = rigged([vec![0, 1, 2, 3], vec![3, 3, 4, 5]], vec![], vec![1, 2, 3]);
        g.discards = vec![5, 5, 5];
        g.play(0, &json!({ "k": "swap", "card": 0 })).unwrap();
        assert_eq!(g.discards, vec![5, 5, 5, 0]);
        g.play(0, &json!({ "k": "draw", "from": "deck" })).unwrap();
        // The four discards became the deck, and one of them is in the hand now.
        assert_eq!(g.deck.len() + g.discards.len(), 3);
        assert!(g.discards.is_empty());
        assert_eq!(g.hands[0].len(), 4);
        let mut all = g.deck.clone();
        all.push(*g.hands[0].last().unwrap());
        all.sort_unstable();
        assert_eq!(all, vec![0, 5, 5, 5]);
    }

    #[test]
    fn drawing_is_offered_from_the_harbour_cards_there_and_from_the_deck_while_any_card_is_left() {
        let mut g = rigged([vec![0, 1, 2, 3], vec![3, 3, 4, 5]], vec![], vec![1, 2, 3]);
        g.play(0, &json!({ "k": "swap", "card": 0 })).unwrap();
        // The deck is empty, but the discards make a new one.
        let o = ask(&g, 0, Value::Null);
        assert_eq!((o["play"].clone(), o["draw"].clone(), o["deck"].clone()), (json!(false), json!(true), json!(true)));
        assert_eq!(o["harbour"], json!([true, true, true]));
        assert_eq!(o["cards"][0], json!({ "light": false, "pair": null, "swap": false }), "draw first");
        // Nothing left to draw from, and a gap in the Harbour.
        g.discards.clear();
        g.harbour[1] = None;
        let o = ask(&g, 0, Value::Null);
        assert_eq!((o["deck"].clone(), o["harbour"].clone()), (json!(false), json!([true, false, true])));
        assert!(g.play(0, &json!({ "k": "draw", "from": "deck" })).is_err());
        assert!(g.play(0, &json!({ "k": "draw", "from": "harbour", "i": 1 })).is_err());
        // Nor is anything offered to Bea, or once the game is over.
        assert_eq!(ask(&g, 1, Value::Null)["harbour"], json!([false, false, false]));
        let over = Asking { you: 0, to_move: None, view: g.view(Some(0)), picked: Value::Null };
        assert_eq!(options(game_called("beacons").unwrap(), &over).unwrap()["draw"], json!(false));
    }

    #[test]
    fn the_board_view_is_offered_just_the_moves_the_server_takes() {
        // Whole games, moved on a card at a time: at every step, for both players, whatever the
        // options offer is a move `play` takes, and whatever they don't, one it refuses.
        for seed in [1, 2] {
            let mut g = Beacons::new(beacons(), seed);
            let mut steps = 0;
            while g.result().is_none() {
                steps += 1;
                assert!(steps < 500, "the game never ended");
                for seat in 0..2 {
                    let takes = |m: Value| copy(&g).play(seat, &m).is_ok();
                    let o = ask(&g, seat, Value::Null);
                    let n = g.hands[seat].len();
                    let at = format!("seed {seed}, step {steps}, seat {seat}");
                    for i in 0..g.harbour.len() {
                        assert_eq!(o["harbour"][i], json!(takes(json!({ "k": "draw", "from": "harbour", "i": i }))), "{at}, Harbour {i}");
                    }
                    assert_eq!(o["deck"], json!(takes(json!({ "k": "draw", "from": "deck" }))), "{at}");
                    assert_eq!(o["play"], json!(takes(json!({ "k": "swap", "card": 0 }))), "{at}");
                    if g.to_move() != Some(seat) {
                        // Not their turn: no card can do anything.
                        let none = json!({ "light": false, "pair": null, "swap": false });
                        assert!(o["cards"].as_array().unwrap().iter().all(|c| *c == none), "{at}");
                        continue;
                    }
                    // Every hex each card, and each pair of cards (either way round), would light.
                    let lights = |cards: &[usize]| (0..g.lit.len()).filter(|&h| takes(json!({ "k": "light", "cards": cards, "hex": h }))).collect::<Vec<_>>();
                    for a in 0..n {
                        let alone = lights(&[a]);
                        let single = ask(&g, seat, json!([a]));
                        assert_eq!(single["hexes"], json!(alone), "{at}, card {a}");
                        assert_eq!(single["swap"], json!(takes(json!({ "k": "swap", "card": a }))), "{at}, card {a}");
                        let mut pair = None;
                        for b in (0..n).filter(|&b| b != a) {
                            let both = lights(&[a, b]);
                            assert_eq!(ask(&g, seat, json!([a, b]))["hexes"], json!(both), "{at}, cards {a} and {b}");
                            if pair.is_none() && !both.is_empty() {
                                pair = Some(b);
                            }
                        }
                        let c = &o["cards"][a];
                        assert_eq!(
                            (c["light"].clone(), c["pair"].clone(), c["swap"].clone()),
                            (json!(!alone.is_empty()), json!(pair), single["swap"].clone()),
                            "{at}, card {a}"
                        );
                    }
                }
                // On a step: a card lit (each way in turn) or swapped, or a card drawn (the Harbour's
                // slots and the deck in turn).
                let seat = g.to_move().unwrap();
                let m = if g.draws > 0 {
                    let i = steps % 4;
                    if i < 3 && g.harbour[i].is_some() { json!({ "k": "draw", "from": "harbour", "i": i }) } else { json!({ "k": "draw", "from": "deck" }) }
                } else {
                    let ways = g.seen(seat).lights();
                    match ways.get(steps % (ways.len() + 1)) {
                        Some((cards, hexes)) => json!({ "k": "light", "cards": cards, "hex": hexes[steps % hexes.len()] }),
                        None => json!({ "k": "swap", "card": steps % g.hands[seat].len() }),
                    }
                };
                g.play(seat, &m).unwrap();
            }
            assert!(steps > 20, "seed {seed}: a whole game, not a few moves");
            // Over: nothing is offered.
            for seat in 0..2 {
                let o = ask(&g, seat, json!([0]));
                assert_eq!(
                    (o["play"].clone(), o["draw"].clone(), o["hexes"].clone(), o["deck"].clone()),
                    (json!(false), json!(false), json!([]), json!(false))
                );
            }
        }
    }

    #[test]
    fn what_a_player_sees_has_to_be_a_view_of_beacons() {
        let game = game_called("beacons").unwrap();
        let g = Beacons::new(beacons(), 5);
        let with = |view: Value, picked: Value| options(game, &Asking { you: 0, to_move: Some(0), view, picked });
        assert!(with(g.view(Some(0)), json!([1, 2])).is_ok());
        assert!(with(json!({ "lit": [0, 0] }), Value::Null).is_err(), "not a view");
        let mut short = g.view(Some(0));
        short["lit"] = json!([0, 0, 0]);
        assert!(with(short, Value::Null).is_err(), "not this board");
        assert!(with(g.view(Some(0)), json!("the first")).is_err(), "cards are picked by their places");
        // Cards that aren't in the hand light nothing.
        assert_eq!(with(g.view(Some(0)), json!([7])).unwrap()["hexes"], json!([]));
    }

    #[test]
    fn a_swap_is_a_whole_turn_discard_one_and_draw_one() {
        let mut g = rigged([vec![0, 1, 2, 3], vec![3, 3, 4, 5]], vec![4, 4], vec![1, 2, 3]);
        assert!(g.play(0, &json!({ "k": "swap", "card": 4 })).is_err());
        g.play(0, &json!({ "k": "swap", "card": 2 })).unwrap();
        assert_eq!(g.hands[0], vec![0, 1, 3]);
        assert!(g.play(0, &json!({ "k": "swap", "card": 0 })).is_err(), "one swap a turn");
        g.play(0, &json!({ "k": "draw", "from": "harbour", "i": 0 })).unwrap();
        assert_eq!(g.hands[0], vec![0, 1, 3, 1]);
        assert_eq!(g.to_move(), Some(1));
        assert!(g.lit.iter().all(|&l| l == 0), "nothing lit");
    }

    /// Lights hexes for a seat directly (the test sets the board up).
    fn light_all(g: &mut Beacons, seat: usize, hexes: &[usize]) {
        for &h in hexes {
            g.lit[h] = seat as u8 + 1;
        }
    }

    /// Plays a pair of good 0 on `hex` for whoever's turn it is (cards placed in their hand first).
    fn pair_on(g: &mut Beacons, hex: usize) {
        let s = g.turn;
        g.hands[s] = vec![0, 0, 1, 2];
        g.play(s, &json!({ "k": "light", "cards": [0, 1], "hex": hex })).unwrap();
    }

    #[test]
    fn four_in_a_row_wins_along_each_of_the_three_directions() {
        let b = &beacons().board;
        for (dq, dr) in AXES {
            // A row of four through the middle, the last one lit by the move.
            let row: Vec<usize> = (-1..=2).map(|k| b.at(dq * k, dr * k).unwrap()).collect();
            let mut g = Beacons::new(beacons(), 3);
            light_all(&mut g, 0, &row[..3]);
            pair_on(&mut g, row[3]);
            assert_eq!(g.result(), Some(Some(0)), "along ({dq}, {dr})");
            let mut want = row.clone();
            want.sort_unstable();
            assert_eq!(g.row, want);
            assert_eq!(g.to_move(), None);
            assert_eq!(g.draws, 0, "nothing to draw once the game is won");
            // Filling the gap in the middle of a row counts too.
            let mut g = Beacons::new(beacons(), 3);
            light_all(&mut g, 0, &[row[0], row[2], row[3]]);
            pair_on(&mut g, row[1]);
            assert_eq!(g.result(), Some(Some(0)));
        }
    }

    #[test]
    fn three_in_a_row_a_broken_row_or_a_bent_one_does_not_win() {
        let b = &beacons().board;
        let at = |q, r| b.at(q, r).unwrap();
        // Three.
        let mut g = Beacons::new(beacons(), 3);
        light_all(&mut g, 0, &[at(-1, 0), at(0, 0)]);
        pair_on(&mut g, at(1, 0));
        assert_eq!(g.result(), None);
        // Four in a line with the other player's beacon in it.
        let mut g = Beacons::new(beacons(), 3);
        light_all(&mut g, 0, &[at(-2, 0), at(-1, 0), at(1, 0)]);
        light_all(&mut g, 1, &[at(0, 0)]);
        pair_on(&mut g, at(2, 0));
        assert_eq!(g.result(), None);
        // Four with a gap.
        let mut g = Beacons::new(beacons(), 3);
        light_all(&mut g, 0, &[at(-3, 0), at(-2, 0), at(-1, 0)]);
        pair_on(&mut g, at(1, 0));
        assert_eq!(g.result(), None);
        // Four touching, but bent.
        let mut g = Beacons::new(beacons(), 3);
        light_all(&mut g, 0, &[at(-1, 0), at(0, 0), at(1, 0)]);
        pair_on(&mut g, at(1, 1));
        assert_eq!(g.result(), None);
        // Four of the other player's don't win for you either.
        let mut g = Beacons::new(beacons(), 3);
        light_all(&mut g, 1, &[at(-1, 0), at(0, 0), at(1, 0)]);
        pair_on(&mut g, at(2, 0));
        assert_eq!(g.result(), None);
    }

    #[test]
    fn every_hex_lit_without_a_row_is_a_draw() {
        // Along every direction (q - r) mod 3 runs 0, 1, 2, 0, ...: give seat 0 the hexes where
        // it's 0 and seat 1 the rest, and nobody ever has more than two in a row.
        let b = &beacons().board;
        let owner = |i: usize| if (b.cells[i].0 - b.cells[i].1).rem_euclid(3) == 0 { 0 } else { 1 };
        let mut g = Beacons::new(beacons(), 3);
        let last = 20;
        for i in 0..37 {
            if i != last {
                g.lit[i] = owner(i) as u8 + 1;
            }
        }
        for i in (0..37).filter(|&i| i != last) {
            assert!(g.row_through(i).is_none(), "no row at {i} yet");
        }
        g.turn = owner(last);
        pair_on(&mut g, last);
        assert_eq!(g.result(), Some(None), "a full board and no row");
        assert_eq!(g.to_move(), None);
    }

    #[test]
    fn out_of_time_the_server_plays_a_card_and_draws_from_the_deck() {
        let grain = 0u8;
        let mut g = rigged([vec![grain, 1, 2, 3], vec![3, 3, 4, 5]], vec![5, 4, 3, 2, 1], vec![1, 2, 3]);
        g.auto(0);
        assert_eq!(g.lit.iter().filter(|&&l| l == 1).count(), 1, "one hex lit");
        assert_eq!(g.hands[0].len(), 4, "drawn back up");
        assert_eq!(g.harbour, vec![Some(1), Some(2), Some(3)], "from the deck, not the Harbour");
        assert_eq!(g.to_move(), Some(1));
        // Not Bea's to play for Ann, nor Ann's to play twice.
        g.auto(0);
        assert_eq!(g.to_move(), Some(1));
        // Part way through drawing, it finishes the drawing.
        g.play(1, &json!({ "k": "light", "cards": [0, 1], "hex": centre() })).unwrap();
        g.play(1, &json!({ "k": "draw", "from": "deck" })).unwrap();
        g.auto(1);
        assert_eq!(g.hands[1].len(), 4);
        assert_eq!(g.to_move(), Some(0));
    }

    #[test]
    fn with_nothing_to_light_the_server_swaps() {
        let mut g = rigged([vec![0, 1, 2, 3], vec![3, 3, 4, 5]], vec![5, 4], vec![1, 2, 3]);
        // Every hex lit but the Old Beacon: only a pair could light it, and there's no pair.
        for i in 0..37 {
            if i != centre() {
                g.lit[i] = 2;
            }
        }
        g.auto(0);
        assert_eq!(g.lit[centre()], 0);
        assert_eq!(g.hands[0], vec![1, 2, 3, 4], "the first card swapped for the deck's top");
        assert_eq!(g.to_move(), Some(1));
    }

    #[test]
    fn a_whole_game_of_server_moves_ends_with_a_winner_or_a_draw() {
        for seed in 1..40 {
            let mut g = Beacons::new(beacons(), seed);
            let mut moves = 0;
            while let Some(s) = g.to_move() {
                g.auto(s);
                moves += 1;
                assert!(moves < 500, "seed {seed} never ends");
                // Cards never appear or vanish (played ones go on the discards).
                let n = g.deck.len() + g.discards.len() + g.hands[0].len() + g.hands[1].len() + g.harbour.iter().flatten().count();
                assert_eq!(n, 48, "seed {seed}");
            }
            assert!(g.result().is_some());
        }
    }

    #[test]
    fn nonsense_from_a_browser_is_refused() {
        let mut g = Beacons::new(beacons(), 1);
        for m in [
            json!("light"),
            json!({ "k": "light" }),
            json!({ "k": "light", "cards": [0], "hex": 99 }),
            json!({ "k": "draw", "from": "sky" }),
            json!({ "k": "fly" }),
            json!({ "k": "light", "cards": [0, 1, 2], "hex": 0 }),
        ] {
            assert!(g.play(0, &m).is_err(), "{m}");
        }
        assert_eq!(g.to_move(), Some(0));
        assert!(g.lit.iter().all(|&l| l == 0));
    }
}
