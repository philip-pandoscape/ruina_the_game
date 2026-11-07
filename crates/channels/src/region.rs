//! A region's channels: which are open, who plays in which, and the policy that places players,
//! opens channels, merges quiet ones and lets players change (docs/world.md, Channels).
//!
//! The keeper of who plays where (the server's directory) holds a [`Region`] for each region and
//! tells it what happens: someone arrives ([`Region::arrive`]), leaves ([`Region::leave`]), asks to
//! change channel ([`Region::change`]) or joins a party ([`Region::joined_party`]); and about once a
//! second it asks what's due ([`Region::review`]). What comes back are [`Action`]s to carry out: a
//! channel to open (a simulation to start), people to move between channels, a channel to close.
//! The facts the rules need about a player as they stand (a pack on their back, a fight, a vehicle)
//! come from the simulation they play in, as a [`Standing`].

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::ties::{GuildId, Ties};
use crate::tuning::Tuning;
use crate::{ChannelNo, CharacterId, Millis};

/// One of a region's channels.
#[derive(Clone, Debug)]
pub struct Channel {
    pub n: ChannelNo,
    /// When it opened.
    pub opened: Millis,
    /// Who plays in it.
    pub players: BTreeSet<CharacterId>,
    /// Since when it has had fewer than `quiet` players, if it has.
    pub quiet_since: Option<Millis>,
    /// How many of each guild, and of each language, play in it.
    guilds: BTreeMap<GuildId, usize>,
    languages: BTreeMap<String, usize>,
}

/// Someone playing in one of the region's channels, with the ties placing others counts.
#[derive(Clone, Debug)]
struct Seat {
    n: ChannelNo,
    guild: Option<GuildId>,
    language: Option<String>,
}

/// A merge under way: `from` closes into `into`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Merge {
    pub from: ChannelNo,
    pub into: ChannelNo,
    /// When its players were told.
    pub began: Millis,
    /// From when they're moved, each as soon as they're out of a fight, on the ground and off a table.
    pub moves_at: Millis,
    /// When whoever is still in it is moved anyway.
    pub deadline: Millis,
}

/// What a player is doing, as far as changing channel goes: told by the simulation they play in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Standing {
    /// A trade pack on their back.
    pub pack: bool,
    /// When they last struck a blow or took one (a player's or a creature's).
    pub fought: Option<Millis>,
    /// Knocked down.
    pub down: bool,
    /// In a vehicle, theirs or someone else's.
    pub riding: bool,
    /// Off the ground: gliding or falling.
    pub airborne: bool,
    /// At a mini-game's table.
    pub seated: bool,
}

impl Standing {
    /// In a fight: knocked down, or a blow struck or taken less than `calm_after` ago.
    pub fn fighting(&self, now: Millis, t: &Tuning) -> bool {
        self.down || self.fought.is_some_and(|f| now - f < t.calm_after_ms())
    }

    /// Free to be moved by a merge: out of a fight, not in the air and not at a table. A pack and a
    /// vehicle go with them.
    pub fn movable(&self, now: Millis, t: &Tuning) -> bool {
        !self.fighting(now, t) && !self.airborne && !self.seated
    }
}

/// Where someone asks to go.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    /// A channel of their choosing.
    Channel(ChannelNo),
    /// Wherever their party plays.
    Party,
}

/// Why someone was moved.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Why {
    /// They chose another channel.
    Choice,
    /// To their party's channel.
    Party,
    /// Their channel merged into another.
    Merge,
}

/// Something for the keeper of who plays where to carry out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Action {
    /// Channel `n` opens: start its simulation.
    Open { n: ChannelNo },
    /// Channel `from` merges into `into`: tell everyone in it that they'll be moved from `at` on.
    Merging { from: ChannelNo, into: ChannelNo, at: Millis },
    /// Move someone from one channel into another, standing where they stand (the land is the same
    /// in both) with whatever they carry and ride.
    Move { who: CharacterId, from: ChannelNo, to: ChannelNo, why: Why },
    /// Channel `n` is empty and closes into `into`: stop its simulation (anything of the world still
    /// its own goes to `into`).
    Close { n: ChannelNo, into: ChannelNo },
}

/// Why someone was placed where they were.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Placement {
    /// Back in the channel they left a moment ago.
    Back,
    /// With their party.
    Party,
    /// Where the most of their friends play.
    Friends,
    /// Where the most of their guild plays.
    Guild,
    /// Where the most speak their language.
    Language,
    /// The fullest channel with room.
    Fill,
    /// A new channel: every other was full.
    New,
}

/// Where someone arriving goes, and why.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Placed {
    pub n: ChannelNo,
    pub why: Placement,
}

/// Someone joined a party: whether they go to its channel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Follow {
    /// Moved there now.
    Now(Action),
    /// Not yet, for this reason: moved as soon as the rules allow (`Region::review`).
    Later(Refusal),
    /// Nowhere to go: they're with their party already, or nobody else of it is here.
    Stay,
}

/// Why someone can't change channel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Refusal {
    /// They aren't in one of the region's channels (in a copy of a dungeon, or not playing).
    NotHere,
    /// They're in that channel already.
    Here,
    /// They're in their party's channel already.
    WithParty,
    /// They aren't in a party.
    NoParty,
    /// Nobody else of their party plays in the region.
    PartyAway,
    /// No such channel is open.
    NoChannel,
    /// That channel is merging into another.
    Closing,
    /// That channel is full: at its soft cap for a choice, at its hard cap to join a party.
    Full,
    /// A trade pack on their back.
    Pack,
    /// In a fight.
    Combat,
    /// In a vehicle.
    Riding,
    /// In the air.
    Airborne,
    /// At a mini-game's table.
    AtTable,
    /// They changed channel lately: this long (ms) until they may again.
    Wait { ms: Millis },
}

impl Refusal {
    /// What the player is told.
    pub fn sentence(&self) -> String {
        match self {
            Refusal::NotHere => "You can only change channel in the open world.".into(),
            Refusal::Here => "You're in that channel already.".into(),
            Refusal::WithParty => "You're in your party's channel already.".into(),
            Refusal::NoParty => "You aren't in a party.".into(),
            Refusal::PartyAway => "Nobody else in your party is playing here.".into(),
            Refusal::NoChannel => "There's no such channel.".into(),
            Refusal::Closing => "That channel is closing.".into(),
            Refusal::Full => "That channel is full.".into(),
            Refusal::Pack => "You can't change channel while carrying a pack.".into(),
            Refusal::Combat => "You can't change channel in combat.".into(),
            Refusal::Riding => "Get off what you're riding first.".into(),
            Refusal::Airborne => "Land first.".into(),
            Refusal::AtTable => "Finish your game first.".into(),
            Refusal::Wait { ms } => format!("You can change channel again in {}.", short_time(*ms)),
        }
    }
}

/// A wait as "3m 20s", "4m" or "45s" (rounded up to the second).
pub fn short_time(ms: Millis) -> String {
    let s = (ms.max(0) + 999) / 1000;
    match (s / 60, s % 60) {
        (0, s) => format!("{s}s"),
        (m, 0) => format!("{m}m"),
        (m, s) => format!("{m}m {s}s"),
    }
}

/// How busy a channel is, as the Channels window says.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Load {
    /// Fewer than `quiet`.
    Quiet,
    Lively,
    /// Past a comfortable merge's fill.
    Busy,
    /// At its soft cap: only a party member joins it.
    Full,
}

impl Load {
    pub fn of(players: usize, t: &Tuning) -> Load {
        if players >= t.soft_cap {
            Load::Full
        } else if players >= t.merge_fill {
            Load::Busy
        } else if players < t.quiet {
            Load::Quiet
        } else {
            Load::Lively
        }
    }
}

/// A channel as someone choosing one sees it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelRow {
    pub n: ChannelNo,
    pub load: Load,
    /// Merging into another: nobody new goes in.
    pub closing: bool,
    /// How many of their party, and of their friends, play in it.
    pub party: usize,
    pub friends: usize,
}

/// A merge someone's channel is in: where they go, and how long (ms) until they're moved.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Closing {
    pub into: ChannelNo,
    pub ms: Millis,
}

/// A region's channels as one player sees them (the browser's Channels window,
/// src/ui/channels/channelsUI.ts ChannelsView).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelsView {
    pub region: String,
    /// Their channel (0: not one of this region's).
    pub here: ChannelNo,
    pub list: Vec<ChannelRow>,
    /// Their channel is merging: into which, and when they're moved.
    pub closing: Option<Closing>,
    /// How long (ms) until they may change channel again, if they changed lately.
    pub wait: Option<Millis>,
    /// Why they can't change channel now, if they can't (a sentence to show).
    pub blocked: Option<String>,
    /// Their party's channel, if it isn't theirs.
    pub party: Option<ChannelNo>,
    /// Whether they're waiting to join their party there.
    pub following: bool,
}

/// A region's channels and who plays in each.
#[derive(Clone, Debug, Default)]
pub struct Region {
    pub id: String,
    channels: BTreeMap<ChannelNo, Channel>,
    seats: BTreeMap<CharacterId, Seat>,
    /// Where each player who left went from, and when (kept `rejoin_within`).
    left: BTreeMap<CharacterId, (ChannelNo, Millis)>,
    /// When each last changed channel, by choice or to join their party (kept `change_every`).
    changed: BTreeMap<CharacterId, Millis>,
    merge: Option<Merge>,
    /// Who joined a party in another channel and goes there as soon as the rules allow.
    following: BTreeSet<CharacterId>,
}

impl Region {
    /// A region with nobody in it: its first channel opens with its first arrival.
    pub fn new(id: &str) -> Region {
        Region { id: id.to_string(), ..Region::default() }
    }

    // ---------- What it holds ----------

    pub fn channels(&self) -> impl Iterator<Item = &Channel> {
        self.channels.values()
    }

    pub fn channel(&self, n: ChannelNo) -> Option<&Channel> {
        self.channels.get(&n)
    }

    /// The channel someone plays in, if one of this region's.
    pub fn channel_of(&self, who: CharacterId) -> Option<ChannelNo> {
        self.seats.get(&who).map(|s| s.n)
    }

    /// How many play in the region.
    pub fn headcount(&self) -> usize {
        self.seats.len()
    }

    /// How many play in channel `n`.
    pub fn population(&self, n: ChannelNo) -> usize {
        self.channels.get(&n).map_or(0, |c| c.players.len())
    }

    /// The merge under way, if any.
    pub fn merge(&self) -> Option<Merge> {
        self.merge
    }

    /// Whether someone is waiting to join their party's channel.
    pub fn following(&self, who: CharacterId) -> bool {
        self.following.contains(&who)
    }

    /// Whether channel `n` is merging into another.
    pub fn closing(&self, n: ChannelNo) -> bool {
        self.merge.is_some_and(|m| m.from == n)
    }

    /// How full channel `n` counts as for placing someone: its players, and if a merge is bringing
    /// another's into it, theirs too.
    pub fn load(&self, n: ChannelNo) -> usize {
        let own = self.channels.get(&n).map_or(0, |c| c.players.len());
        match self.merge {
            Some(m) if m.into == n => own + self.channels.get(&m.from).map_or(0, |c| c.players.len()),
            _ => own,
        }
    }

    /// Where someone bound for channel `n` goes: there if it's open, where it's merging if it is,
    /// nowhere if it has closed.
    fn open_for(&self, n: ChannelNo) -> Option<ChannelNo> {
        match self.merge {
            Some(m) if m.from == n => Some(m.into),
            _ => self.channels.contains_key(&n).then_some(n),
        }
    }

    /// The lowest number no open channel has.
    fn next_free(&self) -> ChannelNo {
        (1..).find(|n| !self.channels.contains_key(n)).expect("a free number")
    }

    /// The channel `who`'s party plays in, if anyone else of it plays in the region: their leader's,
    /// else the one most of them are in (the lowest of those).
    pub fn party_channel(&self, who: CharacterId, ties: &impl Ties) -> Option<ChannelNo> {
        let p = ties.party(who)?;
        if p.leader != who
            && let Some(s) = self.seats.get(&p.leader)
        {
            return Some(s.n);
        }
        let mut count: BTreeMap<ChannelNo, usize> = BTreeMap::new();
        for m in p.members.iter().filter(|m| **m != who) {
            if let Some(s) = self.seats.get(m) {
                *count.entry(s.n).or_default() += 1;
            }
        }
        count.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0))).map(|(n, _)| n)
    }

    // ---------- Placing ----------

    /// Where someone arriving would go (nothing changes): where they are if they're here already;
    /// back to the channel they left if they left it less than `rejoin_within` ago (and it isn't
    /// past the hard cap; one merging, where it's merging); else to their party's channel, unless
    /// it's past the hard cap; else to the channel with the most of their friends, then of their
    /// guild, then the biggest share speaking their language, then the fullest, then the lowest
    /// number, of those below the soft cap and not closing; else a new channel.
    pub fn place(&self, who: CharacterId, ties: &impl Ties, now: Millis, t: &Tuning) -> Placed {
        if let Some(s) = self.seats.get(&who) {
            return Placed { n: s.n, why: Placement::Back };
        }
        if let Some(&(was, at)) = self.left.get(&who)
            && now - at < t.rejoin_within_ms()
            && let Some(n) = self.open_for(was)
            && self.load(n) < t.hard_cap
        {
            return Placed { n, why: Placement::Back };
        }
        if let Some(n) = self.party_channel(who, ties).and_then(|n| self.open_for(n))
            && self.load(n) < t.hard_cap
        {
            return Placed { n, why: Placement::Party };
        }
        self.by_ties(who, ties, t).unwrap_or(Placed { n: self.next_free(), why: Placement::New })
    }

    /// The best channel with room below the soft cap by `who`'s friends, guild and language, then
    /// by how full it is.
    fn by_ties(&self, who: CharacterId, ties: &impl Ties, t: &Tuning) -> Option<Placed> {
        let mut friends: BTreeMap<ChannelNo, usize> = BTreeMap::new();
        for f in ties.friends(who) {
            if let Some(n) = self.seats.get(&f).and_then(|s| self.open_for(s.n)) {
                *friends.entry(n).or_default() += 1;
            }
        }
        let guild = ties.guild(who);
        let language = ties.language(who);
        let mut best: Option<Score> = None;
        for ch in self.channels.values().filter(|c| !self.closing(c.n)) {
            let load = self.load(ch.n);
            if load >= t.soft_cap {
                continue;
            }
            let score = Score {
                friends: friends.get(&ch.n).copied().unwrap_or(0),
                guild: guild.and_then(|g| ch.guilds.get(&g)).copied().unwrap_or(0),
                speakers: language.as_ref().and_then(|l| ch.languages.get(l)).copied().unwrap_or(0),
                players: ch.players.len(),
                load,
                n: ch.n,
            };
            if best.as_ref().is_none_or(|b| score.against(b) == Ordering::Greater) {
                best = Some(score);
            }
        }
        let b = best?;
        let why = if b.friends > 0 {
            Placement::Friends
        } else if b.guild > 0 {
            Placement::Guild
        } else if b.speakers > 0 {
            Placement::Language
        } else {
            Placement::Fill
        };
        Some(Placed { n: b.n, why })
    }

    /// Someone arrives in the region (they signed in, or came out of a copy): placed by
    /// [`Region::place`], with the channel opened if it's a new one.
    pub fn arrive(&mut self, who: CharacterId, ties: &impl Ties, now: Millis, t: &Tuning) -> (Placed, Vec<Action>) {
        let placed = self.place(who, ties, now, t);
        let mut out = Vec::new();
        if self.seats.contains_key(&who) {
            return (placed, out);
        }
        if placed.why == Placement::New {
            self.open(placed.n, now);
            out.push(Action::Open { n: placed.n });
        }
        self.seat(who, placed.n, ties);
        self.left.remove(&who);
        (placed, out)
    }

    /// Someone leaves the region (signed out, or into a copy): their channel is kept for them for
    /// `rejoin_within`.
    pub fn leave(&mut self, who: CharacterId, now: Millis) {
        if let Some(s) = self.unseat(who) {
            self.left.insert(who, (s.n, now));
        }
        self.following.remove(&who);
    }

    /// A character is gone for good (deleted).
    pub fn forget(&mut self, who: CharacterId) {
        self.unseat(who);
        self.left.remove(&who);
        self.changed.remove(&who);
        self.following.remove(&who);
    }

    // ---------- Changing channel ----------

    /// How long (ms) until `who` may change channel again, if they changed lately.
    pub fn wait(&self, who: CharacterId, now: Millis, t: &Tuning) -> Option<Millis> {
        let left = self.changed.get(&who)? + t.change_every_ms() - now;
        (left > 0).then_some(left)
    }

    /// Why `who` can't change channel at all right now, whatever to: a pack on their back, a fight,
    /// a vehicle, the air, a table, or a change too lately.
    pub fn blocked(&self, who: CharacterId, standing: &Standing, now: Millis, t: &Tuning) -> Option<Refusal> {
        if standing.pack {
            Some(Refusal::Pack)
        } else if standing.fighting(now, t) {
            Some(Refusal::Combat)
        } else if standing.riding {
            Some(Refusal::Riding)
        } else if standing.airborne {
            Some(Refusal::Airborne)
        } else if standing.seated {
            Some(Refusal::AtTable)
        } else {
            self.wait(who, now, t).map(|ms| Refusal::Wait { ms })
        }
    }

    /// Whether `who` may go to `to` now, and the channel that is. A channel of their choosing must
    /// be open, not closing and below the soft cap; their party's (where it's merging, if it is)
    /// below the hard cap. Either way, not with a pack, in a fight, riding, in the air or at a
    /// table, nor sooner than `change_every` after their last change.
    pub fn may_change(&self, who: CharacterId, to: Target, standing: &Standing, ties: &impl Ties, now: Millis, t: &Tuning) -> Result<ChannelNo, Refusal> {
        let here = self.seats.get(&who).ok_or(Refusal::NotHere)?.n;
        let (n, limit) = match to {
            Target::Channel(n) => {
                if n == here {
                    return Err(Refusal::Here);
                }
                if !self.channels.contains_key(&n) {
                    return Err(Refusal::NoChannel);
                }
                if self.closing(n) {
                    return Err(Refusal::Closing);
                }
                (n, t.soft_cap)
            }
            Target::Party => {
                if ties.party(who).is_none() {
                    return Err(Refusal::NoParty);
                }
                let at = self.party_channel(who, ties).ok_or(Refusal::PartyAway)?;
                if at == here {
                    return Err(Refusal::WithParty);
                }
                (self.open_for(at).ok_or(Refusal::NoChannel)?, t.hard_cap)
            }
        };
        if n == here {
            // Their party's channel is merging into theirs: they'll be together in a moment.
            return Err(Refusal::WithParty);
        }
        if self.load(n) >= limit {
            return Err(Refusal::Full);
        }
        match self.blocked(who, standing, now, t) {
            Some(r) => Err(r),
            None => Ok(n),
        }
    }

    /// `who` changes channel, if [`Region::may_change`] allows: the move to make. It counts toward
    /// `change_every`, and a choice ends any wait to join their party.
    pub fn change(&mut self, who: CharacterId, to: Target, standing: &Standing, ties: &impl Ties, now: Millis, t: &Tuning) -> Result<Action, Refusal> {
        let n = self.may_change(who, to, standing, ties, now, t)?;
        let from = self.move_seat(who, n).ok_or(Refusal::NotHere)?;
        self.changed.insert(who, now);
        self.following.remove(&who);
        let why = match to {
            Target::Channel(_) => Why::Choice,
            Target::Party => Why::Party,
        };
        Ok(Action::Move { who, from, to: n, why })
    }

    /// `who` joined a party (they accepted an invitation): to its channel now if the rules allow,
    /// else as soon as they do (each [`Region::review`] tries again), unless they change channel
    /// of their own accord meanwhile, leave the party or leave the region.
    pub fn joined_party(&mut self, who: CharacterId, standing: &Standing, ties: &impl Ties, now: Millis, t: &Tuning) -> Follow {
        match self.change(who, Target::Party, standing, ties, now, t) {
            Ok(a) => Follow::Now(a),
            Err(Refusal::WithParty | Refusal::NoParty | Refusal::PartyAway | Refusal::NotHere) => {
                self.following.remove(&who);
                Follow::Stay
            }
            Err(r) => {
                self.following.insert(who);
                Follow::Later(r)
            }
        }
    }

    /// `who` left their party (or it broke up): no longer waiting to join it.
    pub fn left_party(&mut self, who: CharacterId) {
        self.following.remove(&who);
    }

    // ---------- Every second or so ----------

    /// What's due at `now`: a merge under way moves whoever is free (everyone, once its deadline
    /// passes) and closes its channel once it's empty; whoever waits to join their party goes if
    /// the rules allow now; a channel quiet for `quiet_for` begins merging into the fullest other
    /// that can take its players and stay at most `merge_fill` (the newest such channel first, one
    /// merge at a time); and another channel opens if the room left below the soft cap is less than
    /// `open_ahead`. `standing` says what each player is doing.
    pub fn review(&mut self, now: Millis, ties: &impl Ties, standing: impl Fn(CharacterId) -> Standing, t: &Tuning) -> Vec<Action> {
        let mut out = Vec::new();
        let (rejoin, every) = (t.rejoin_within_ms(), t.change_every_ms());
        self.left.retain(|_, (_, at)| now - *at < rejoin);
        self.changed.retain(|_, at| now - *at < every);
        for ch in self.channels.values_mut() {
            if ch.players.len() < t.quiet {
                ch.quiet_since.get_or_insert(now);
            } else {
                ch.quiet_since = None;
            }
        }
        if let Some(m) = self.merge {
            self.carry_out(m, now, &standing, t, &mut out);
        }
        let waiting: Vec<CharacterId> = self.following.iter().copied().collect();
        for who in waiting {
            match self.change(who, Target::Party, &standing(who), ties, now, t) {
                Ok(a) => out.push(a),
                Err(Refusal::WithParty | Refusal::NoParty | Refusal::PartyAway | Refusal::NotHere) => {
                    self.following.remove(&who);
                }
                Err(_) => {}
            }
        }
        if self.merge.is_none()
            && let Some((from, into)) = self.merge_due(now, t)
        {
            let moves_at = now + t.merge_notice_ms();
            let m = Merge { from, into, began: now, moves_at, deadline: moves_at + t.merge_wait_ms() };
            self.merge = Some(m);
            if self.channels[&from].players.is_empty() {
                // Nobody to tell or move: it closes now.
                self.close(m, &mut out);
            } else {
                out.push(Action::Merging { from, into, at: moves_at });
            }
        }
        if !self.seats.is_empty() {
            let room: usize = self.channels.keys().filter(|n| !self.closing(**n)).map(|n| t.soft_cap.saturating_sub(self.load(*n))).sum();
            if room < t.open_ahead {
                let n = self.next_free();
                self.open(n, now);
                out.push(Action::Open { n });
            }
        }
        out
    }

    /// A merge under way, at `now`: from `moves_at`, each of its players free to go (everyone,
    /// past its deadline) moves into its target; once nobody is left, it closes.
    fn carry_out(&mut self, m: Merge, now: Millis, standing: &impl Fn(CharacterId) -> Standing, t: &Tuning, out: &mut Vec<Action>) {
        if now < m.moves_at {
            return;
        }
        let forced = now >= m.deadline;
        let inside: Vec<CharacterId> = self.channels.get(&m.from).map(|c| c.players.iter().copied().collect()).unwrap_or_default();
        for who in inside {
            if forced || standing(who).movable(now, t) {
                self.move_seat(who, m.into);
                out.push(Action::Move { who, from: m.from, to: m.into, why: Why::Merge });
            }
        }
        if self.channels.get(&m.from).is_none_or(|c| c.players.is_empty()) {
            self.close(m, out);
        }
    }

    /// Channel `m.from` closes into `m.into`: whoever comes back to it later comes back there.
    fn close(&mut self, m: Merge, out: &mut Vec<Action>) {
        self.channels.remove(&m.from);
        for (n, _) in self.left.values_mut() {
            if *n == m.from {
                *n = m.into;
            }
        }
        self.merge = None;
        out.push(Action::Close { n: m.from, into: m.into });
    }

    /// The channel due to merge, and where: the newest quiet for `quiet_for`, into the fullest other
    /// (not closing) that can take its players and stay at most `merge_fill` (the lowest number of
    /// those as full).
    fn merge_due(&self, now: Millis, t: &Tuning) -> Option<(ChannelNo, ChannelNo)> {
        for x in self.channels.values().rev() {
            if !x.quiet_since.is_some_and(|q| now - q >= t.quiet_for_ms()) {
                continue;
            }
            let take = x.players.len();
            let into = self
                .channels
                .keys()
                .filter(|n| **n != x.n && !self.closing(**n))
                .map(|n| (*n, self.load(*n)))
                .filter(|(_, load)| load + take <= t.merge_fill)
                .max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0)));
            if let Some((into, _)) = into {
                return Some((x.n, into));
            }
        }
        None
    }

    // ---------- What a player sees ----------

    /// The region's channels as `who` sees them, at `now`.
    pub fn view(&self, who: CharacterId, standing: &Standing, ties: &impl Ties, now: Millis, t: &Tuning) -> ChannelsView {
        let here = self.channel_of(who).unwrap_or(0);
        let party: Vec<CharacterId> = ties.party(who).map(|p| p.members.into_iter().filter(|m| *m != who).collect()).unwrap_or_default();
        let friends = ties.friends(who);
        let count = |list: &[CharacterId], n: ChannelNo| list.iter().filter(|w| self.channel_of(**w) == Some(n)).count();
        let list = self
            .channels
            .values()
            .map(|c| ChannelRow {
                n: c.n,
                load: Load::of(self.load(c.n), t),
                closing: self.closing(c.n),
                party: count(&party, c.n),
                friends: count(&friends, c.n),
            })
            .collect();
        ChannelsView {
            region: self.id.clone(),
            here,
            list,
            closing: self.merge.filter(|m| m.from == here && here != 0).map(|m| Closing { into: m.into, ms: (m.moves_at - now).max(0) }),
            wait: self.wait(who, now, t),
            blocked: self.blocked(who, standing, now, t).map(|r| r.sentence()),
            party: self.party_channel(who, ties).and_then(|n| self.open_for(n)).filter(|n| *n != here),
            following: self.following(who),
        }
    }

    // ---------- Seats ----------

    fn open(&mut self, n: ChannelNo, now: Millis) {
        self.channels
            .insert(n, Channel { n, opened: now, players: BTreeSet::new(), quiet_since: Some(now), guilds: BTreeMap::new(), languages: BTreeMap::new() });
    }

    fn seat(&mut self, who: CharacterId, n: ChannelNo, ties: &impl Ties) {
        self.put(who, Seat { n, guild: ties.guild(who), language: ties.language(who) });
    }

    fn put(&mut self, who: CharacterId, s: Seat) {
        let ch = self.channels.get_mut(&s.n).expect("an open channel");
        ch.players.insert(who);
        if let Some(g) = s.guild {
            *ch.guilds.entry(g).or_default() += 1;
        }
        if let Some(l) = &s.language {
            *ch.languages.entry(l.clone()).or_default() += 1;
        }
        self.seats.insert(who, s);
    }

    fn unseat(&mut self, who: CharacterId) -> Option<Seat> {
        let s = self.seats.remove(&who)?;
        if let Some(ch) = self.channels.get_mut(&s.n) {
            ch.players.remove(&who);
            if let Some(g) = s.guild {
                less(&mut ch.guilds, &g);
            }
            if let Some(l) = &s.language {
                less(&mut ch.languages, l);
            }
        }
        Some(s)
    }

    /// Moves `who` into channel `n` with the ties they came with; the channel they left.
    fn move_seat(&mut self, who: CharacterId, n: ChannelNo) -> Option<ChannelNo> {
        let s = self.unseat(who)?;
        let from = s.n;
        self.put(who, Seat { n, ..s });
        Some(from)
    }
}

/// One fewer of `k`, forgotten at none.
fn less<K: Ord + Clone>(m: &mut BTreeMap<K, usize>, k: &K) {
    if let Some(c) = m.get_mut(k) {
        *c -= 1;
        if *c == 0 {
            m.remove(k);
        }
    }
}

/// A channel as placing by ties weighs it: more friends first, then more of the guild, then a
/// bigger share speaking the language, then fuller, then the lower number.
struct Score {
    friends: usize,
    guild: usize,
    /// Of `players`, how many speak the arrival's language.
    speakers: usize,
    players: usize,
    load: usize,
    n: ChannelNo,
}

impl Score {
    fn against(&self, o: &Score) -> Ordering {
        // speakers / players against theirs, without fractions: an empty channel counts as none of 1.
        let share = (self.speakers as u128 * o.players.max(1) as u128).cmp(&(o.speakers as u128 * self.players.max(1) as u128));
        self.friends.cmp(&o.friends).then(self.guild.cmp(&o.guild)).then(share).then(self.load.cmp(&o.load)).then(o.n.cmp(&self.n))
    }
}

#[cfg(test)]
mod tests;
