//! A crowd of bots playing a region's channels: the harness the policy's tests play, and, once the
//! server's tiers are in, the server's own through the same [`Arena`] (the server's directory, with
//! bots for players).
//!
//! Each bot stands in for a player. It has friends, perhaps a guild, and a language. It comes online
//! on the crowd's curve, alone or with its party (formed before it came, or by an invitation while
//! it plays), plays a while and goes; now and then its connection drops for a few seconds. While it
//! plays it picks up a trade pack and carries it a few minutes, gets into a fight, sits down at a
//! table, invites a friend into its party, leaves its party, or tries another channel (one on its
//! own picks any; one whose party plays elsewhere asks to join it). The arena places it, moves it,
//! and opens and merges channels. After every second the crowd checks what must always hold
//! ([`Tally::broken`]) and counts what happened.

use std::collections::{BTreeMap, BTreeSet};

use crate::region::{Action, Follow, Merge, Placed, Placement, Refusal, Region, Standing, Target, Why};
use crate::ties::{Social, Ties};
use crate::tuning::Tuning;
use crate::{ChannelNo, CharacterId, Millis};

/// What a crowd plays against.
pub trait Arena {
    /// A bot comes online: where it's placed, and why.
    fn arrive(&mut self, who: CharacterId, ties: &Social, now: Millis) -> Placed;
    /// A bot goes offline.
    fn leave(&mut self, who: CharacterId, now: Millis);
    /// A bot asks to change channel.
    fn change(&mut self, who: CharacterId, to: Target, standing: &Standing, ties: &Social, now: Millis) -> Result<Action, Refusal>;
    /// A bot joined a party.
    fn joined_party(&mut self, who: CharacterId, standing: &Standing, ties: &Social, now: Millis) -> Follow;
    /// A bot left its party, or was left alone in it.
    fn left_party(&mut self, who: CharacterId);
    /// A second has passed: what's due.
    fn review(&mut self, now: Millis, ties: &Social, standing: &dyn Fn(CharacterId) -> Standing) -> Vec<Action>;
    /// Where a bot plays.
    fn channel_of(&self, who: CharacterId) -> Option<ChannelNo>;
    /// The open channels and how many play in each.
    fn channels(&self) -> Vec<(ChannelNo, usize)>;
    /// The merge under way, if any.
    fn merge(&self) -> Option<Merge>;
    /// The numbers it plays by.
    fn tuning(&self) -> &Tuning;
}

/// The policy in memory: a [`Region`] and its numbers.
pub struct Here {
    pub region: Region,
    pub tuning: Tuning,
}

impl Here {
    pub fn new(tuning: Tuning) -> Here {
        Here { region: Region::new("crowd"), tuning }
    }
}

impl Arena for Here {
    fn arrive(&mut self, who: CharacterId, ties: &Social, now: Millis) -> Placed {
        self.region.arrive(who, ties, now, &self.tuning).0
    }

    fn leave(&mut self, who: CharacterId, now: Millis) {
        self.region.leave(who, now);
    }

    fn change(&mut self, who: CharacterId, to: Target, standing: &Standing, ties: &Social, now: Millis) -> Result<Action, Refusal> {
        self.region.change(who, to, standing, ties, now, &self.tuning)
    }

    fn joined_party(&mut self, who: CharacterId, standing: &Standing, ties: &Social, now: Millis) -> Follow {
        self.region.joined_party(who, standing, ties, now, &self.tuning)
    }

    fn left_party(&mut self, who: CharacterId) {
        self.region.left_party(who);
    }

    fn review(&mut self, now: Millis, ties: &Social, standing: &dyn Fn(CharacterId) -> Standing) -> Vec<Action> {
        self.region.review(now, ties, standing, &self.tuning)
    }

    fn channel_of(&self, who: CharacterId) -> Option<ChannelNo> {
        self.region.channel_of(who)
    }

    fn channels(&self) -> Vec<(ChannelNo, usize)> {
        self.region.channels().map(|c| (c.n, c.players.len())).collect()
    }

    fn merge(&self) -> Option<Merge> {
        self.region.merge()
    }

    fn tuning(&self) -> &Tuning {
        &self.tuning
    }
}

/// How a crowd behaves. Chances are per bot per second online.
#[derive(Clone, Debug)]
pub struct Plan {
    pub seed: u64,
    /// How many bots there are; each comes online once (and again after a dropped connection).
    pub bots: usize,
    /// Over how long (seconds) they come, evenly.
    pub ramp: f64,
    /// How long one plays (seconds), from half this to half again.
    pub session: f64,
    /// The share that comes with a party formed before (in parties of two to five, together).
    pub parties: f64,
    /// How many guilds there are, and the share in one.
    pub guilds: u64,
    pub in_guild: f64,
    /// How many others each befriends (friends are both ways, so each has about twice as many).
    pub friends: usize,
    /// The languages they play in, each with its share.
    pub languages: Vec<(String, f64)>,
    /// Picking up a pack (carried 1 to 5 minutes), a fight (10 to 60 s), a seat at a table (30 s to
    /// 2 minutes).
    pub pack: f64,
    pub fight: f64,
    pub table: f64,
    /// One on its own trying another channel; one whose party plays elsewhere asking to join it.
    pub hop: f64,
    pub join: f64,
    /// Inviting a friend online into its party (or a new one), and leaving its party.
    pub invite: f64,
    pub quit: f64,
    /// Its connection dropping, for 5 to 40 s.
    pub blip: f64,
}

impl Plan {
    /// A crowd of 150 coming over a quarter of an hour, playing about ten minutes each, for small
    /// channels ([`Tuning::small`]): channels open as it fills, and merge as it thins.
    pub fn small(seed: u64) -> Plan {
        Plan {
            seed,
            bots: 150,
            ramp: 900.0,
            session: 600.0,
            parties: 0.3,
            guilds: 5,
            in_guild: 0.5,
            friends: 2,
            languages: vec![("en".into(), 0.6), ("de".into(), 0.2), ("fr".into(), 0.2)],
            pack: 0.003,
            fight: 0.004,
            table: 0.0005,
            hop: 0.002,
            join: 0.02,
            invite: 0.001,
            quit: 0.0005,
            blip: 0.0005,
        }
    }

    /// A crowd for the game's own numbers: 6,000 coming over half an hour and playing about half an
    /// hour each, so some 5,000 at once at the peak, in five or six channels.
    pub fn large(seed: u64) -> Plan {
        Plan { bots: 6000, ramp: 1800.0, session: 1800.0, ..Plan::small(seed) }
    }

    /// How long (seconds) until the last of them has gone, and every channel but one has had the
    /// time to fall quiet and merge.
    pub fn length(&self, t: &Tuning) -> u64 {
        (self.ramp + self.session * 1.5 + 60.0 + 2.0 * (t.quiet_for + t.merge_notice + t.merge_wait)).ceil() as u64
    }
}

/// What happened, and anything that shouldn't have.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tally {
    pub seconds: u64,
    pub arrivals: u64,
    /// Leaving for good, and dropped connections (each back a few seconds later, unless its time was up).
    pub departures: u64,
    pub blips: u64,
    pub peak_online: usize,
    pub peak_channels: usize,
    /// The most ever in one channel.
    pub fullest: usize,
    pub opened: u64,
    pub merges: u64,
    pub closed: u64,
    /// Placements by why; moves by why; refusals by what; invitations by what followed.
    pub placed: BTreeMap<String, u64>,
    pub moved: BTreeMap<String, u64>,
    pub refused: BTreeMap<String, u64>,
    pub followed: BTreeMap<String, u64>,
    /// Placements past the soft cap (each with a party or back where it was).
    pub past_soft: u64,
    /// Merge moves made at a merge's deadline, its player not yet free.
    pub forced: u64,
    /// Seconds a party had members online in two channels or more, summed over parties, and the
    /// longest any one did at a stretch (ms).
    pub split_seconds: u64,
    pub longest_split: Millis,
    /// Channels open when the crowd had gone.
    pub left_open: usize,
    /// What must never happen: each the first few times.
    pub broken: Vec<String>,
}

impl Tally {
    fn count(map: &mut BTreeMap<String, u64>, key: &str) {
        *map.entry(key.to_string()).or_default() += 1;
    }

    fn breaks(&mut self, what: String) {
        if self.broken.len() < 20 {
            self.broken.push(what);
        }
    }
}

/// A bot.
#[derive(Clone, Debug)]
struct Bot {
    id: CharacterId,
    comes: Millis,
    goes: Millis,
    pack_until: Millis,
    /// Blows struck and taken until then, the last of its fights.
    fight_until: Millis,
    table_until: Millis,
}

impl Bot {
    fn standing(&self, now: Millis) -> Standing {
        Standing {
            pack: now < self.pack_until,
            fought: (self.fight_until > 0).then(|| now.min(self.fight_until)),
            seated: now < self.table_until,
            ..Standing::default()
        }
    }
}

// How often (seconds) each bot decides what to do: a fifth of them each second, in turn.
const ACT: usize = 5;

/// A crowd of bots, made from a plan.
pub struct Crowd {
    pub plan: Plan,
    pub social: Social,
    bots: Vec<Bot>,
    /// Who is online, by place in `bots`, sorted by which second of `ACT` each acts on.
    online: Vec<BTreeSet<usize>>,
    /// Who comes next, in the order they come; who comes back when, after a dropped connection;
    /// and who goes when.
    coming: Vec<usize>,
    next: usize,
    returning: BTreeMap<Millis, Vec<usize>>,
    leaving: BTreeSet<(Millis, usize)>,
    rng: Rng,
    start: Millis,
    /// Since when each party (by its leader) has been split.
    split_since: BTreeMap<CharacterId, Millis>,
    pub tally: Tally,
}

impl Crowd {
    /// The crowd `plan` makes, starting at `start` on the world's clock.
    pub fn new(plan: Plan, start: Millis) -> Crowd {
        let mut rng = Rng(plan.seed ^ 0x6368_616e_6e65_6c73);
        let mut social = Social::default();
        let n = plan.bots as CharacterId;
        let total: f64 = plan.languages.iter().map(|l| l.1).sum();
        let mut bots = Vec::with_capacity(plan.bots);
        for id in 1..=n {
            let comes = start + secs(rng.unit() * plan.ramp);
            let goes = comes + secs(plan.session * rng.between(0.5, 1.5));
            bots.push(Bot { id, comes, goes, pack_until: 0, fight_until: 0, table_until: 0 });
            if rng.chance(plan.in_guild) {
                social.set_guild(id, 1 + rng.below(plan.guilds.max(1)));
            }
            let mut pick = rng.unit() * total;
            for (lang, share) in &plan.languages {
                pick -= share;
                if pick < 0.0 {
                    social.set_language(id, lang);
                    break;
                }
            }
            for _ in 0..plan.friends {
                social.befriend(id, 1 + rng.below(n as u64) as CharacterId);
            }
        }
        // Parties formed before they come: neighbours by number, coming and going together.
        let mut k = 0;
        while k < bots.len() {
            if !rng.chance(plan.parties) {
                k += 1;
                continue;
            }
            let size = (2 + rng.below(4) as usize).min(bots.len() - k);
            if size < 2 {
                break;
            }
            let ids: Vec<CharacterId> = bots[k..k + size].iter().map(|b| b.id).collect();
            social.form(ids[0], &ids[1..]);
            let (comes, goes) = (bots[k].comes, bots[k].goes);
            for (j, b) in bots[k..k + size].iter_mut().enumerate() {
                b.comes = comes + secs(j as f64 * rng.between(1.0, 10.0));
                b.goes = goes;
            }
            k += size;
        }
        let mut coming: Vec<usize> = (0..bots.len()).collect();
        coming.sort_by_key(|i| (bots[*i].comes, *i));
        Crowd {
            plan,
            social,
            bots,
            online: vec![BTreeSet::new(); ACT],
            coming,
            next: 0,
            returning: BTreeMap::new(),
            leaving: BTreeSet::new(),
            rng,
            start,
            split_since: BTreeMap::new(),
            tally: Tally::default(),
        }
    }

    /// Plays the crowd against `arena` for `seconds` more, a second at a step.
    pub fn run(&mut self, arena: &mut impl Arena, seconds: u64) -> &Tally {
        for _ in 0..seconds {
            let now = self.start + secs(self.tally.seconds as f64);
            self.step(arena, now);
        }
        self.tally.left_open = arena.channels().len();
        &self.tally
    }

    /// Who is online, by id.
    pub fn online(&self) -> impl Iterator<Item = CharacterId> + '_ {
        let mut all: Vec<usize> = self.online.iter().flatten().copied().collect();
        all.sort_unstable();
        all.into_iter().map(|i| self.bots[i].id)
    }

    fn is_online(&self, i: usize) -> bool {
        self.online[i % ACT].contains(&i)
    }

    fn standing(&self, id: CharacterId, now: Millis) -> Standing {
        self.bots[(id - 1) as usize].standing(now)
    }

    /// Bot `i` goes offline.
    fn gone(&mut self, arena: &mut impl Arena, i: usize, now: Millis) {
        arena.leave(self.bots[i].id, now);
        self.online[i % ACT].remove(&i);
        self.leaving.remove(&(self.bots[i].goes, i));
    }

    /// One second of the crowd, at `now`.
    pub fn step(&mut self, arena: &mut impl Arena, now: Millis) {
        let t = arena.tuning().clone();
        let second = self.tally.seconds as usize;
        self.tally.seconds += 1;
        // Who goes for good.
        while let Some(&(at, i)) = self.leaving.first() {
            if at > now {
                break;
            }
            self.gone(arena, i, now);
            self.tally.departures += 1;
        }
        // Who comes: for the first time, or back (unless their time is up meanwhile).
        let mut due = Vec::new();
        while self.next < self.coming.len() && self.bots[self.coming[self.next]].comes <= now {
            due.push(self.coming[self.next]);
            self.next += 1;
        }
        while let Some(entry) = self.returning.first_entry() {
            if *entry.key() > now {
                break;
            }
            due.extend(entry.remove());
        }
        for i in due {
            if now < self.bots[i].goes {
                self.arrive(arena, i, now, &t);
            }
        }
        // What those whose turn it is do: a dropped connection, or what they do while they play.
        let acting: Vec<usize> = self.online[second % ACT].iter().copied().collect();
        for i in acting {
            if self.rng.chance(self.plan.blip * ACT as f64) {
                self.gone(arena, i, now);
                let back = now + secs(self.rng.between(5.0, 40.0));
                self.returning.entry(back).or_default().push(i);
                self.tally.blips += 1;
            } else {
                self.behave(arena, self.bots[i].id, now, &t);
            }
        }
        // What's due.
        let merge = arena.merge();
        let actions = {
            let bots = &self.bots;
            arena.review(now, &self.social, &|who| bots.get((who - 1) as usize).map_or_else(Standing::default, |b| b.standing(now)))
        };
        for a in &actions {
            self.tally_action(a, merge, now, &t);
        }
        self.check(arena, now, &t);
    }

    /// Bot `i` comes online: placed, and held to the soft cap but by its party or coming back.
    fn arrive(&mut self, arena: &mut impl Arena, i: usize, now: Millis, t: &Tuning) {
        let id = self.bots[i].id;
        let placed = arena.arrive(id, &self.social, now);
        self.online[i % ACT].insert(i);
        self.leaving.insert((self.bots[i].goes, i));
        self.tally.arrivals += 1;
        Tally::count(&mut self.tally.placed, &format!("{:?}", placed.why));
        if placed.why == Placement::New {
            self.tally.opened += 1;
        }
        if arena.channel_of(id) != Some(placed.n) {
            self.tally.breaks(format!("{id} was placed in {} but isn't there", placed.n));
        }
        let size = arena.channels().into_iter().find(|c| c.0 == placed.n).map_or(0, |c| c.1);
        if size > t.soft_cap {
            self.tally.past_soft += 1;
            if !matches!(placed.why, Placement::Back | Placement::Party) {
                self.tally.breaks(format!("{id} was placed in channel {} past the soft cap ({size}) by {:?}", placed.n, placed.why));
            }
        }
    }

    /// What a bot online does when its turn comes (every `ACT` seconds): the plan's chances are a
    /// second's, so each is `ACT` times as likely.
    fn behave(&mut self, arena: &mut impl Arena, id: CharacterId, now: Millis, t: &Tuning) {
        let i = (id - 1) as usize;
        let k = ACT as f64;
        if now >= self.bots[i].fight_until && self.rng.chance(self.plan.fight * k) {
            self.bots[i].fight_until = now + secs(self.rng.between(10.0, 60.0));
        }
        if now >= self.bots[i].pack_until && self.rng.chance(self.plan.pack * k) {
            self.bots[i].pack_until = now + secs(self.rng.between(60.0, 300.0));
        }
        if now >= self.bots[i].table_until && self.rng.chance(self.plan.table * k) {
            self.bots[i].table_until = now + secs(self.rng.between(30.0, 120.0));
        }
        let in_party = self.social.party_id(id).is_some();
        if !in_party && self.rng.chance(self.plan.invite * k) {
            // A friend online on their own joins its party (it leads a new one).
            let friend = self.social.friends(id).into_iter().find(|f| self.is_online((*f - 1) as usize) && self.social.party_id(*f).is_none());
            if let Some(f) = friend {
                self.social.join(id, f);
                let st = self.standing(f, now);
                let outcome = match arena.joined_party(f, &st, &self.social, now) {
                    Follow::Now(a) => {
                        self.tally_action(&a, None, now, t);
                        "Now".to_string()
                    }
                    Follow::Later(r) => format!("Later: {}", kind(&r)),
                    Follow::Stay => "Stay".to_string(),
                };
                Tally::count(&mut self.tally.followed, &outcome);
            }
            return;
        }
        if in_party && self.rng.chance(self.plan.quit * k) {
            let alone = self.social.leave(id);
            arena.left_party(id);
            if let Some(l) = alone {
                arena.left_party(l);
            }
            return;
        }
        let here = arena.channel_of(id);
        let to = if in_party {
            // Asks to join its party, if it plays elsewhere.
            let asks = self.rng.chance(self.plan.join * k);
            let elsewhere =
                || self.social.party(id).is_some_and(|p| p.members.iter().any(|m| *m != id && arena.channel_of(*m).is_some_and(|c| Some(c) != here)));
            (asks && elsewhere()).then_some(Target::Party)
        } else if self.rng.chance(self.plan.hop * k) {
            let others: Vec<ChannelNo> = arena.channels().into_iter().map(|c| c.0).filter(|n| Some(*n) != here).collect();
            (!others.is_empty()).then(|| Target::Channel(others[self.rng.below(others.len() as u64) as usize]))
        } else {
            None
        };
        if let Some(to) = to {
            let st = self.standing(id, now);
            match arena.change(id, to, &st, &self.social, now) {
                Ok(a) => self.tally_action(&a, None, now, t),
                Err(r) => {
                    Tally::count(&mut self.tally.refused, kind(&r));
                    self.check_refusal(id, to, r, &st, now, t);
                }
            }
        }
    }

    /// A refusal has a reason: a pack, a fight or a table is there to see, and so on.
    fn check_refusal(&mut self, id: CharacterId, to: Target, r: Refusal, st: &Standing, now: Millis, t: &Tuning) {
        let wrong = match r {
            Refusal::Pack => !st.pack,
            Refusal::Combat => !st.fighting(now, t),
            Refusal::AtTable => !st.seated,
            Refusal::Riding | Refusal::Airborne => true,
            _ => false,
        };
        if wrong {
            self.tally.breaks(format!("{id} was refused {to:?} for {r:?} standing {st:?}"));
        }
    }

    fn tally_action(&mut self, a: &Action, merge: Option<Merge>, now: Millis, t: &Tuning) {
        match a {
            Action::Open { .. } => self.tally.opened += 1,
            Action::Merging { .. } => self.tally.merges += 1,
            Action::Close { .. } => self.tally.closed += 1,
            Action::Move { who, from, why, .. } => {
                Tally::count(&mut self.tally.moved, &format!("{why:?}"));
                if *why == Why::Merge {
                    let m = merge.filter(|m| m.from == *from);
                    match m {
                        Some(m) if now >= m.deadline => {
                            if self.standing(*who, now).movable(now, t) {
                                // Free all along: it would have gone before the deadline.
                            } else {
                                self.tally.forced += 1;
                            }
                        }
                        Some(m) if now < m.moves_at => self.tally.breaks(format!("{who} was moved by the merge before its notice was up")),
                        Some(_) => {
                            if !self.standing(*who, now).movable(now, t) {
                                self.tally.breaks(format!("{who} was moved by the merge in a fight or at a table before its deadline"));
                            }
                        }
                        None => self.tally.breaks(format!("{who} was moved by a merge of channel {from} that isn't under way")),
                    }
                }
            }
        }
    }

    /// What must hold after every second, and what's counted of it.
    fn check(&mut self, arena: &impl Arena, now: Millis, t: &Tuning) {
        let channels = arena.channels();
        let online: usize = self.online.iter().map(BTreeSet::len).sum();
        self.tally.peak_online = self.tally.peak_online.max(online);
        self.tally.peak_channels = self.tally.peak_channels.max(channels.len());
        for (n, size) in &channels {
            self.tally.fullest = self.tally.fullest.max(*size);
            if *size > t.hard_cap {
                self.tally.breaks(format!("channel {n} has {size}, past the hard cap"));
            }
        }
        let seated: usize = channels.iter().map(|c| c.1).sum();
        if seated != online {
            self.tally.breaks(format!("{online} bots online but {seated} in the channels"));
        }
        if let Some(m) = arena.merge()
            && now > m.deadline
        {
            self.tally.breaks(format!("the merge of channel {} into {} is still under way past its deadline", m.from, m.into));
        }
        // Parties split between channels: for how long.
        let mut split_now = Vec::new();
        for p in self.social.parties() {
            let mut at = p.members.iter().filter_map(|m| arena.channel_of(*m));
            if let Some(first) = at.next()
                && at.any(|n| n != first)
            {
                split_now.push(p.leader);
            }
        }
        self.tally.split_seconds += split_now.len() as u64;
        let mut kept = BTreeMap::new();
        for leader in split_now {
            let since = self.split_since.get(&leader).copied().unwrap_or(now);
            self.tally.longest_split = self.tally.longest_split.max(now - since);
            kept.insert(leader, since);
        }
        self.split_since = kept;
    }
}

fn secs(s: f64) -> Millis {
    (s * 1000.0) as Millis
}

/// A refusal's kind, without its numbers ("Wait" for every wait).
fn kind(r: &Refusal) -> &'static str {
    match r {
        Refusal::NotHere => "NotHere",
        Refusal::Here => "Here",
        Refusal::WithParty => "WithParty",
        Refusal::NoParty => "NoParty",
        Refusal::PartyAway => "PartyAway",
        Refusal::NoChannel => "NoChannel",
        Refusal::Closing => "Closing",
        Refusal::Full => "Full",
        Refusal::Pack => "Pack",
        Refusal::Combat => "Combat",
        Refusal::Riding => "Riding",
        Refusal::Airborne => "Airborne",
        Refusal::AtTable => "AtTable",
        Refusal::Wait { .. } => "Wait",
    }
}

/// splitmix64: a small seeded generator, the same numbers on every machine.
#[derive(Clone, Debug)]
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// From 0 up to 1.
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }

    fn chance(&mut self, p: f64) -> bool {
        self.unit() < p
    }

    fn between(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.unit()
    }
}

#[cfg(test)]
mod tests;
