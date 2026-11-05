//! Mini-games: two players at a table thrown down between them, playing for a pot. One player
//! walks up to another and challenges them (the game and the stake); if they accept, both stakes go
//! into the pot, a table appears between them for everyone in the channel to see, and the two play
//! it out there. The winner takes the pot; a draw, or a game called off, gives each stake back.
//!
//! This is the part every game shares: the content (shared/minigames.json), the challenges, and
//! the tables with their turn clocks, forfeits and the moment each game ends. The rules of each
//! game are a `Rules` (beacons.rs is the first); the money and the players themselves are the
//! channel's (server/src/world_game/tables.rs), which settles the pot when a table says its game
//! is over.

pub mod beacons;

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::{json, Value};

// ---------- Content ----------

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeDef {
    /// How close (m) you have to be to someone to challenge them.
    pub range: f64,
    /// How long a challenge waits for an answer.
    pub invite_seconds: f64,
    /// After a refusal, how long before the same player may ask the same player again.
    pub decline_cooldown: f64,
    /// The stakes that can be offered, in copper (0 is No Stake).
    pub stakes: Vec<f64>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableDef {
    /// How far each player sits from the table's middle.
    pub seat: f64,
    /// A player away (disconnected) this long forfeits.
    pub away_seconds: f64,
    /// A finished game's table stays this long, with the result on it, before it goes.
    pub clear_seconds: f64,
}

/// What every game has, whatever its rules.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GameDef {
    pub id: String,
    pub name: String,
    pub turn_seconds: f64,
    /// Turns in a row whose clock runs out before that player forfeits.
    pub timeouts_to_forfeit: u8,
}

#[derive(Debug)]
pub struct Content {
    pub challenge: ChallengeDef,
    pub table: TableDef,
    pub games: Vec<GameDef>,
    /// Each game's own part of the file, for its rules to read.
    pub raw: Vec<Value>,
}

#[derive(Deserialize)]
struct File {
    challenge: ChallengeDef,
    table: TableDef,
    games: Vec<Value>,
}

pub fn content() -> &'static Content {
    static C: OnceLock<Content> = OnceLock::new();
    C.get_or_init(|| {
        let f: File = serde_json::from_str(include_str!("../../../shared/minigames.json")).expect("shared/minigames.json is valid");
        let games = f.games.iter().map(|g| serde_json::from_value::<GameDef>(g.clone()).expect("a mini-game has an id, a name and a turn clock")).collect();
        Content { challenge: f.challenge, table: f.table, games, raw: f.games }
    })
}

pub fn game_def(id: &str) -> Option<&'static GameDef> {
    content().games.iter().find(|g| g.id == id)
}

/// The game's own part of shared/minigames.json.
pub fn game_raw(id: &str) -> Option<&'static Value> {
    content().raw.iter().find(|g| g.get("id").and_then(Value::as_str) == Some(id))
}

/// A new game of `id`, dealt from `seed`. None for a game this server doesn't know.
pub fn new_game(id: &str, seed: u32) -> Option<Box<dyn Rules>> {
    match id {
        "beacons" => Some(Box::new(beacons::Beacons::new(seed))),
        _ => None,
    }
}

// ---------- Rules ----------

/// A game's rules, for two seats (0 and 1; seat 0 moves first). The table runs the clock and
/// decides forfeits; the rules decide what a move may be and who has won.
pub trait Rules: Send {
    /// The seat to move now, None once the game is over.
    fn to_move(&self) -> Option<usize>;
    /// Turns begun so far: when this goes up, the next player's clock starts.
    fn turns(&self) -> u32;
    /// A move by `seat`, as the browser sent it. Err says why it isn't one, and changes nothing.
    fn play(&mut self, seat: usize, m: &Value) -> Result<(), String>;
    /// The server's move for a player whose clock ran out: the whole rest of their turn.
    fn auto(&mut self, seat: usize);
    /// Some once the rules have ended the game: Some(seat) won, None a draw.
    fn result(&self) -> Option<Option<usize>>;
    /// What `seat` may see (their own hand, and their legal moves when it's their turn), or with
    /// None, what anyone may.
    fn view(&self, seat: Option<usize>) -> Value;
    /// What the table shows everyone in the world (the 3D board).
    fn board(&self) -> Value;
}

// ---------- Tables ----------

pub struct Seat {
    pub id: i64,
    pub name: String,
    /// Turns in a row whose clock ran out.
    pub timeouts: u8,
    /// Since when they've been gone (disconnected), None while they're here.
    pub away: Option<f64>,
}

impl Seat {
    pub fn new(id: i64, name: &str) -> Seat {
        Seat { id, name: name.to_string(), timeouts: 0, away: None }
    }
}

/// Where a table stands: its middle on the ground, and `rot`, the way from seat 0 to seat 1
/// (a heading: x = sin, z = cos).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Spot {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub rot: f64,
}

impl Spot {
    /// Where seat `k` is (x, z) and the way it faces (toward the table).
    pub fn seat(&self, k: usize) -> (f64, f64, f64) {
        let d = content().table.seat * if k == 0 { -1.0 } else { 1.0 };
        let (x, z) = (self.x + self.rot.sin() * d, self.z + self.rot.cos() * d);
        let facing = if k == 0 { self.rot } else { self.rot + std::f64::consts::PI };
        (x, z, facing)
    }
}

/// Why a game ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
    /// The rules ended it: a row, or a draw.
    Rules,
    Conceded,
    /// Too many turns in a row ran out of time.
    Timeouts,
    /// A player was gone too long.
    Away,
    /// Called off with nobody winning (the server stopping): each stake goes back.
    Aborted,
}

impl Why {
    pub fn name(self) -> &'static str {
        match self {
            Why::Rules => "rules",
            Why::Conceded => "conceded",
            Why::Timeouts => "timeouts",
            Why::Away => "away",
            Why::Aborted => "aborted",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Over {
    /// The seat that won; None for a draw or a game called off.
    pub winner: Option<usize>,
    pub why: Why,
    /// When (the channel's clock), for the table to go a little after.
    pub at: f64,
}

pub struct Table {
    pub id: u64,
    pub game: &'static GameDef,
    /// Each player's stake, in copper (the pot is twice this).
    pub stake: f64,
    pub seats: [Seat; 2],
    pub at: Spot,
    pub rules: Box<dyn Rules>,
    /// When the player to move began their turn (the channel's clock, seconds).
    pub turn_began: f64,
    /// How long a turn lasts: the game's, or on a development server what the challenge asked for.
    pub turn_seconds: f64,
    turns_seen: u32,
    pub over: Option<Over>,
    /// Goes up with every change, so each player's view goes out again.
    pub version: u64,
}

impl Table {
    pub fn new(id: u64, game: &'static GameDef, stake: f64, seats: [Seat; 2], at: Spot, rules: Box<dyn Rules>, now: f64) -> Table {
        let turns_seen = rules.turns();
        Table { id, game, stake, seats, at, rules, turn_began: now, turn_seconds: game.turn_seconds, turns_seen, over: None, version: 1 }
    }

    pub fn seat_of(&self, id: i64) -> Option<usize> {
        self.seats.iter().position(|s| s.id == id)
    }

    /// Seconds left on the clock of the player to move.
    pub fn time_left(&self, now: f64) -> f64 {
        (self.turn_seconds - (now - self.turn_began)).max(0.0)
    }

    /// A move by the player in `seat`.
    pub fn play(&mut self, seat: usize, m: &Value, now: f64) -> Result<(), String> {
        if self.over.is_some() {
            return Err("This game is over.".into());
        }
        if self.rules.to_move() != Some(seat) {
            return Err("It isn't your turn.".into());
        }
        self.rules.play(seat, m)?;
        // Playing for yourself breaks a run of turns that timed out.
        self.seats[seat].timeouts = 0;
        self.version += 1;
        self.after_move(now);
        Ok(())
    }

    /// Whoever is in `seat` gives the game up: the other player wins.
    pub fn concede(&mut self, seat: usize, now: f64) {
        if self.over.is_none() {
            self.end(Some(1 - seat), Why::Conceded, now);
        }
    }

    /// Ends the game with nobody winning (the server is stopping).
    pub fn abort(&mut self, now: f64) {
        if self.over.is_none() {
            self.end(None, Why::Aborted, now);
        }
    }

    fn end(&mut self, winner: Option<usize>, why: Why, now: f64) {
        self.over = Some(Over { winner, why, at: now });
        self.version += 1;
    }

    /// After anything that may have moved the game on: a new turn starts its clock, and the rules
    /// may have ended it.
    fn after_move(&mut self, now: f64) {
        if self.rules.turns() != self.turns_seen {
            self.turns_seen = self.rules.turns();
            self.turn_began = now;
        }
        if let Some(winner) = self.rules.result() {
            self.end(winner, Why::Rules, now);
        }
    }

    /// The table's clocks, once a tick: a player gone too long forfeits, and a turn whose time has
    /// run out is played by the server (too many of those in a row forfeit too). `here` says
    /// whether a player is connected. True if anything changed.
    pub fn tick(&mut self, now: f64, here: impl Fn(i64) -> bool) -> bool {
        if self.over.is_some() {
            return false;
        }
        let mut changed = false;
        let def = &content().table;
        for k in 0..2 {
            let present = here(self.seats[k].id);
            match (present, self.seats[k].away) {
                (true, Some(_)) => {
                    self.seats[k].away = None;
                    changed = true;
                }
                (false, None) => {
                    self.seats[k].away = Some(now);
                    changed = true;
                }
                (false, Some(since)) if now - since >= def.away_seconds => {
                    self.end(Some(1 - k), Why::Away, now);
                    return true;
                }
                _ => {}
            }
        }
        if let Some(s) = self.rules.to_move() {
            if now - self.turn_began >= self.turn_seconds {
                self.seats[s].timeouts += 1;
                if self.seats[s].timeouts >= self.game.timeouts_to_forfeit {
                    self.end(Some(1 - s), Why::Timeouts, now);
                    return true;
                }
                self.rules.auto(s);
                changed = true;
                self.after_move(now);
            }
        }
        if changed {
            self.version += 1;
        }
        changed
    }

    /// What everyone in the world sees of the table (src/net/worldLink.ts TableShown).
    pub fn shown(&self) -> Value {
        let mut v = json!({
            "id": self.id,
            "game": self.game.id,
            "x": self.at.x,
            "y": self.at.y,
            "z": self.at.z,
            "rot": self.at.rot,
            "seats": self.seats.iter().map(|s| json!({ "id": s.id, "name": s.name })).collect::<Vec<_>>(),
            "stake": self.stake,
            "board": self.rules.board(),
        });
        if let Some(o) = &self.over {
            v["over"] = json!({ "winner": o.winner, "why": o.why.name() });
        }
        v
    }

    /// What the player in `seat` sees (src/net/worldLink.ts TableView): the table, the clock, and the
    /// game as the rules show it to them.
    pub fn view(&self, seat: usize, now: f64) -> Value {
        let mut v = self.shown();
        v["you"] = json!(seat);
        v["seats"] = Value::Array(
            self.seats
                .iter()
                .map(|s| json!({ "id": s.id, "name": s.name, "timeouts": s.timeouts, "away": s.away.is_some() }))
                .collect(),
        );
        v["game"] = json!(self.game.id);
        v["turnSeconds"] = json!(self.turn_seconds);
        v["ms"] = json!((self.time_left(now) * 1000.0).round());
        v["toMove"] = json!(if self.over.is_some() { None } else { self.rules.to_move() });
        v["state"] = self.rules.view(Some(seat));
        v
    }
}

// ---------- Challenges ----------

pub struct Challenge {
    pub from: i64,
    pub from_name: String,
    pub to: i64,
    pub to_name: String,
    pub game: &'static GameDef,
    pub stake: f64,
    /// When it lapses (the channel's clock).
    pub expires: f64,
    /// Development servers: the deal, so tests know it.
    pub seed: Option<u32>,
    /// Development servers: how long each turn lasts, for tests in a browser too slow for the game's.
    pub turn: Option<f64>,
}

impl Challenge {
    /// As the browser shows it (src/net/worldLink.ts ChallengeView).
    pub fn json(&self, now: f64) -> Value {
        json!({
            "from": self.from,
            "fromName": self.from_name,
            "to": self.to,
            "toName": self.to_name,
            "game": self.game.id,
            "stake": self.stake,
            "ms": ((self.expires - now).max(0.0) * 1000.0).round(),
        })
    }
}

/// A channel's challenges and tables.
#[derive(Default)]
pub struct Minigames {
    pub tables: Vec<Table>,
    pub challenges: Vec<Challenge>,
    next_id: u64,
    /// The view of their table each seated player was last sent: (table, version).
    pub sent: HashMap<i64, (u64, u64)>,
    /// (who asked, who said no) -> until when the one who asked waits before asking again.
    pub declined: HashMap<(i64, i64), f64>,
}

impl Minigames {
    pub fn next_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    /// The table `id` sits at (a game going on, or just over and not yet cleared away).
    pub fn table_of(&self, id: i64) -> Option<usize> {
        self.tables.iter().position(|t| t.seat_of(id).is_some())
    }

    /// Whether `id` is at a table: they can't walk off, ride or do anything else there.
    pub fn seated(&self, id: i64) -> bool {
        self.table_of(id).is_some()
    }

    /// The challenge `id` has sent, if any.
    pub fn sent_by(&self, id: i64) -> Option<&Challenge> {
        self.challenges.iter().find(|c| c.from == id)
    }

    /// The challenge waiting for `id` to answer, if any.
    pub fn waiting_for(&self, id: i64) -> Option<&Challenge> {
        self.challenges.iter().find(|c| c.to == id)
    }

    /// Nothing going on: no table, no challenge.
    pub fn idle(&self) -> bool {
        self.tables.is_empty() && self.challenges.is_empty()
    }

    /// What `id` has going on with challenges (src/net/worldLink.ts Challenges).
    pub fn challenges_json(&self, id: i64, now: f64) -> Value {
        json!({
            "t": "challenges",
            "sent": self.sent_by(id).map(|c| c.json(now)),
            "waiting": self.waiting_for(id).map(|c| c.json(now)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A game whose moves are just "pass" and whose winner the test decides.
    struct Coin {
        turn: usize,
        turns: u32,
        won: Option<Option<usize>>,
    }

    impl Rules for Coin {
        fn to_move(&self) -> Option<usize> {
            self.won.is_none().then_some(self.turn)
        }
        fn turns(&self) -> u32 {
            self.turns
        }
        fn play(&mut self, _seat: usize, m: &Value) -> Result<(), String> {
            if m == "win" {
                self.won = Some(Some(self.turn));
                return Ok(());
            }
            if m != "pass" {
                return Err("no".into());
            }
            self.turn = 1 - self.turn;
            self.turns += 1;
            Ok(())
        }
        fn auto(&mut self, seat: usize) {
            self.play(seat, &json!("pass")).unwrap();
        }
        fn result(&self) -> Option<Option<usize>> {
            self.won
        }
        fn view(&self, _seat: Option<usize>) -> Value {
            json!({})
        }
        fn board(&self) -> Value {
            json!({})
        }
    }

    fn table() -> Table {
        let game = game_def("beacons").unwrap();
        Table::new(1, game, 50.0, [Seat::new(7, "Ann"), Seat::new(8, "Bea")], Spot::default(), Box::new(Coin { turn: 0, turns: 1, won: None }), 0.0)
    }

    #[test]
    fn the_content_reads() {
        let c = content();
        assert_eq!(c.challenge.range, 4.0);
        assert_eq!(c.challenge.stakes[0], 0.0, "No Stake comes first");
        let b = game_def("beacons").unwrap();
        assert_eq!((b.turn_seconds, b.timeouts_to_forfeit), (40.0, 3));
        assert!(new_game("beacons", 1).is_some());
        assert!(new_game("chess", 1).is_none());
    }

    #[test]
    fn a_turn_whose_clock_runs_out_is_played_for_you_and_three_in_a_row_forfeit() {
        let mut t = table();
        let turn = t.game.turn_seconds;
        let here = |_: i64| true;
        assert!(!t.tick(turn - 1.0, here), "time left");
        // Ann's clock runs out: the server passes for her, and Bea's clock starts.
        assert!(t.tick(turn, here));
        assert_eq!((t.rules.to_move(), t.seats[0].timeouts, t.turn_began), (Some(1), 1, turn));
        // Bea plays for herself; Ann times out twice more, and that's three in a row.
        t.play(1, &json!("pass"), turn + 5.0).unwrap();
        assert!(t.tick(turn + 5.0 + turn, here));
        assert_eq!(t.seats[0].timeouts, 2);
        assert_eq!(t.over, None);
        t.play(1, &json!("pass"), turn * 2.0 + 6.0).unwrap();
        assert!(t.tick(turn * 3.0 + 6.0, here));
        assert_eq!(t.over.map(|o| (o.winner, o.why)), Some((Some(1), Why::Timeouts)));
    }

    #[test]
    fn playing_for_yourself_resets_the_run_of_timeouts() {
        let mut t = table();
        let turn = t.game.turn_seconds;
        let here = |_: i64| true;
        t.tick(turn, here);
        t.play(1, &json!("pass"), turn).unwrap();
        t.tick(turn * 2.0, here);
        assert_eq!(t.seats[0].timeouts, 2);
        t.play(1, &json!("pass"), turn * 2.0).unwrap();
        t.play(0, &json!("pass"), turn * 2.0 + 1.0).unwrap();
        assert_eq!(t.seats[0].timeouts, 0);
    }

    #[test]
    fn moves_out_of_turn_or_after_the_end_are_refused() {
        let mut t = table();
        assert!(t.play(1, &json!("pass"), 1.0).is_err(), "Bea moves second");
        assert!(t.play(0, &json!("nonsense"), 1.0).is_err());
        assert_eq!(t.rules.to_move(), Some(0), "a refused move changes nothing");
        t.play(0, &json!("win"), 2.0).unwrap();
        assert_eq!(t.over.map(|o| (o.winner, o.why)), Some((Some(0), Why::Rules)));
        assert!(t.play(1, &json!("pass"), 3.0).is_err());
    }

    #[test]
    fn a_player_gone_too_long_forfeits_and_one_back_in_time_does_not() {
        let away = content().table.away_seconds;
        let mut t = table();
        let bea_gone = |id: i64| id != 8;
        t.tick(1.0, bea_gone);
        assert_eq!(t.seats[1].away, Some(1.0));
        t.tick(away, bea_gone);
        assert_eq!(t.over, None, "not long enough");
        // She's back: the clock on her absence stops.
        t.tick(away + 0.5, |_| true);
        assert_eq!(t.seats[1].away, None);
        t.tick(away + 1.0, bea_gone);
        t.tick(away * 2.0 + 0.5, bea_gone);
        assert_eq!(t.over, None, "away again only since the last time she left");
        t.tick(away * 2.0 + 1.0, bea_gone);
        assert_eq!(t.over.map(|o| (o.winner, o.why)), Some((Some(0), Why::Away)));
    }

    #[test]
    fn conceding_ends_it_at_once_for_the_other_player() {
        let mut t = table();
        t.concede(0, 3.0);
        assert_eq!(t.over.map(|o| (o.winner, o.why)), Some((Some(1), Why::Conceded)));
        // Only once.
        t.concede(1, 4.0);
        assert_eq!(t.over.map(|o| o.winner), Some(Some(1)));
    }

    #[test]
    fn seats_face_each_other_across_the_table() {
        let at = Spot { x: 10.0, y: 0.0, z: -4.0, rot: 0.3 };
        let (ax, az, af) = at.seat(0);
        let (bx, bz, bf) = at.seat(1);
        let d = content().table.seat;
        assert!(((ax - at.x).hypot(az - at.z) - d).abs() < 1e-9);
        assert!(((ax + bx) / 2.0 - at.x).abs() < 1e-9 && ((az + bz) / 2.0 - at.z).abs() < 1e-9);
        // Each looks at the table's middle.
        assert!(((at.x - ax) / d - af.sin()).abs() < 1e-9 && ((at.z - az) / d - af.cos()).abs() < 1e-9);
        assert!(((at.x - bx) / d - bf.sin()).abs() < 1e-9 && ((at.z - bz) / d - bf.cos()).abs() < 1e-9);
    }
}
