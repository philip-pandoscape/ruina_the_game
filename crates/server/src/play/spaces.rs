//! Where everyone plays: the channels of Emberholm, the copies of its dungeons, the parties, and
//! who is in which. A dungeon is played as World of Warcraft plays one: through its portal a party
//! goes into its own copy (someone on their own, into theirs), which nobody else sees; a copy is kept
//! for COPY_KEPT after the last player leaves it, so whoever comes back within that finds it as they
//! left it; and whoever is in a copy but no longer in the party it belongs to is put out after a
//! minute. A party that forms takes over its leader's copy; one that breaks up leaves its copy to
//! whoever was left in it.
//!
//! A copy is a game like a channel (crate::play::ChannelGame, its `space` a Copy): ticked by
//! the same world thread, saving islands the same way (as standing outside its door). Moving between
//! games takes the player out of one whole, with their connection and island, and into the other;
//! their browser hears `space` and starts afresh with what it sees.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::open::dungeon::{Spot, dungeon};
use crate::open::zone::emberholm;
use crate::play::parties::{Changed, Parties};
use crate::play::{Arrival, ChannelGame, Owner, Save, client};

/// How long a copy of a dungeon is kept once the last player has left it.
pub const COPY_KEPT: Duration = Duration::from_secs(30 * 60);
/// How long someone has to leave a copy once they're no longer in the party it belongs to.
pub const EXPEL_AFTER: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct Spaces {
    /// Channels (ids from 1 up) and copies of dungeons (ids from -1 down).
    pub games: HashMap<i32, ChannelGame>,
    pub parties: Parties,
    /// The game each character is in, or was in last (a copy they may come back to).
    at: HashMap<i64, i32>,
    /// Each character's home channel, as they last arrived.
    home: HashMap<i64, i32>,
    /// The copy each party (or player on their own) has of each dungeon.
    copies: HashMap<(Owner, &'static str), i32>,
    last_copy: i32,
    /// The server's queue of islands to write, which every game made is given.
    pub saver: Option<mpsc::UnboundedSender<Vec<Save>>>,
}

impl Spaces {
    /// A channel, made the first time anyone needs it.
    pub fn channel(&mut self, id: i32) -> &mut ChannelGame {
        let saver = self.saver.clone();
        self.games.entry(id).or_insert_with(|| {
            let mut ch = ChannelGame::new(id);
            ch.saver = saver;
            ch
        })
    }

    /// The game someone is playing in right now.
    pub fn game_of(&mut self, character: i64) -> Option<&mut ChannelGame> {
        let id = *self.at.get(&character)?;
        self.games.get_mut(&id).filter(|g| g.members.contains_key(&character))
    }

    fn game_ref(&self, character: i64) -> Option<&ChannelGame> {
        let id = self.at.get(&character)?;
        self.games.get(id).filter(|g| g.members.contains_key(&character))
    }

    /// Someone's name, if they're playing.
    pub fn name_of(&self, character: i64) -> Option<String> {
        self.game_ref(character).and_then(|g| g.members.get(&character)).map(|m| m.name.clone())
    }

    /// Whoever is playing under this name (any channel or dungeon), whatever its capitals.
    fn find_by_name(&self, name: &str) -> Option<(i64, String)> {
        let name = name.trim();
        self.games.values().flat_map(|g| g.members.iter()).find(|(_, m)| m.name.eq_ignore_ascii_case(name)).map(|(id, m)| (*id, m.name.clone()))
    }

    /// A connection arrives: into the copy they were last in, if it's still there and still theirs,
    /// else their home channel. Returns the welcome's parts: everyone's estates and the claims (of
    /// their home channel), the build they play with, and where they are.
    pub fn arrive(&mut self, home: i32, a: Arrival) -> (Value, Value, Value, Value) {
        let character = a.character;
        self.home.insert(character, home);
        let mut into = home;
        if let Some(&was) = self.at.get(&character)
            && was < 0
            && self.games.contains_key(&was)
            && self.may_be_in(character, was)
        {
            into = was;
        }
        self.channel(home);
        // Anything of theirs left behind in another game (they left a copy a moment ago, and it isn't theirs now).
        for (id, g) in self.games.iter_mut() {
            if *id != into {
                g.forget_lingering(character);
            }
        }
        self.at.insert(character, into);
        let (estates, claims, build, space) = {
            let g = self.games.get_mut(&into).expect("the game they come into");
            let (estates, claims, build) = g.join(a);
            (estates, claims, build, space_json(g))
        };
        // Into a copy, the estates are their channel's all the same: they come back to it.
        let (estates, claims) = if into == home {
            (estates, claims)
        } else {
            let ch = self.channel(home);
            (ch.estates.estates_json(character), ch.estates.claims_json())
        };
        self.after_arriving(character);
        (estates, claims, build, space)
    }

    /// Their party and any invitation waiting for them, and their party told they're here.
    fn after_arriving(&mut self, character: i64) {
        if let Some(inv) = self.parties.invite_for(character) {
            let msg = invite_json(Some((inv.from, &inv.from_name, inv.until)));
            self.tell(character, &msg);
        }
        match self.parties.party_of(character).map(|p| p.id) {
            Some(pid) => self.send_party(pid),
            None => self.tell(character, &json!({ "t": "party", "party": null }).to_string()),
        }
    }

    /// A connection ended: out of the game they're in; their island comes back to be saved. They
    /// stay where they were, to come back to (a copy, while it lasts).
    pub fn depart(&mut self, character: i64, session: i64) -> Option<Value> {
        let id = *self.at.get(&character)?;
        let island = self.games.get_mut(&id)?.leave(character, session);
        if let Some(pid) = self.parties.party_of(character).map(|p| p.id) {
            self.send_party(pid);
        }
        island
    }

    fn owner_of(&self, character: i64) -> Owner {
        match self.parties.party_of(character) {
            Some(p) => Owner::Party(p.id),
            None => Owner::Solo(character),
        }
    }

    /// Whether someone belongs in a copy: it's their party's, theirs on their own, or everyone's.
    fn may_be_in(&self, character: i64, copy: i32) -> bool {
        self.games.get(&copy).and_then(|g| g.copy_of()).is_some_and(|c| c.owner == Owner::Everyone || c.owner == self.owner_of(character))
    }

    /// Through a dungeon's portal into the copy that's theirs (made now if there isn't one).
    pub fn enter_dungeon(&mut self, character: i64, id: &str) -> Result<(), String> {
        let def = dungeon(id).ok_or("There's no such place.")?;
        let door = emberholm().recipe.dungeons.iter().find(|d| d.id == def.id).ok_or("There's no way into that from here.")?;
        let g = self.game_ref(character).ok_or("You aren't playing.")?;
        if g.copy_of().is_some() {
            return Err("You're in a dungeon already.".into());
        }
        let (x, y, z, free) = g.whereabouts(character).ok_or("You aren't playing.")?;
        if !door.portal.reaches(x, y, z) {
            return Err(format!("You're too far from the way into {}.", def.name));
        }
        if !free {
            return Err("Put down what you're carrying and get your feet on the ground first.".into());
        }
        let owner = self.owner_of(character);
        let key = (owner, def.id.as_str());
        let copy = match self.copies.get(&key) {
            Some(&c) if self.games.contains_key(&c) => c,
            _ => {
                self.last_copy -= 1;
                let c = self.last_copy;
                let mut g = ChannelGame::copy(c, def, door, owner);
                g.saver = self.saver.clone();
                self.games.insert(c, g);
                self.copies.insert(key, c);
                c
            }
        };
        if self.games[&copy].headcount() >= def.max_players {
            return Err(format!("{} is full.", def.name));
        }
        let at = self.games[&copy].arrival().unwrap_or_else(|| def.arrival());
        self.move_to(character, copy, at)?;
        if let Some(pid) = self.parties.party_of(character).map(|p| p.id) {
            self.send_party(pid);
        }
        Ok(())
    }

    /// Into a developer zone, from the Admin menu: admins only (`admin`, as the server decides it).
    /// A zone everyone shares (the battlefield) has one copy for all of them; any other, one for each
    /// party, as a dungeon has. Out again through its way out, as from a dungeon, at its own door.
    pub fn enter_zone(&mut self, character: i64, id: &str, admin: bool, team: Option<u8>) -> Result<(), String> {
        if !admin {
            return Err("Only an admin can go there.".into());
        }
        let def = dungeon(id).filter(|d| d.developer).ok_or("There's no such place.")?;
        let door = def.door.as_ref().ok_or("That place has no way out.")?;
        // Somewhere beside the island already (a dungeon, another zone): out of it first, as through
        // its door; there already, nothing to do.
        let here: Option<&'static str> = self.game_ref(character).ok_or("You aren't playing.")?.copy_of().map(|c| c.def).map(|d| d.id.as_str());
        if here == Some(def.id.as_str()) {
            self.take_side(character, team);
            return Ok(());
        }
        if here.is_some() {
            self.out_of_copy(character)?;
        }
        let owner = if def.shared { Owner::Everyone } else { self.owner_of(character) };
        let key = (owner, def.id.as_str());
        let copy = match self.copies.get(&key) {
            Some(&c) if self.games.contains_key(&c) => c,
            _ => {
                self.last_copy -= 1;
                let c = self.last_copy;
                let mut g = ChannelGame::copy(c, def, door, owner);
                g.saver = self.saver.clone();
                self.games.insert(c, g);
                self.copies.insert(key, c);
                c
            }
        };
        if self.games[&copy].headcount() >= def.max_players {
            return Err(format!("{} is full.", def.name));
        }
        let at = def.arrival();
        self.move_to(character, copy, at)?;
        self.take_side(character, team);
        Ok(())
    }

    /// In a developer zone, onto a side (0 or 1; the first if none is asked for). Everyone on the
    /// island is on its one side, so this only matters where bots or other admins fight across sides.
    fn take_side(&mut self, character: i64, team: Option<u8>) {
        if let Some((p, _)) = self.game_of(character).and_then(|g| g.players.open_mut(client(character))) {
            p.team = team.unwrap_or(0).min(1);
        }
    }

    /// Out through a copy's portal, back to their home channel outside its door.
    pub fn leave_dungeon(&mut self, character: i64) -> Result<(), String> {
        let g = self.game_ref(character).ok_or("You aren't playing.")?;
        let c = g.copy_of().ok_or("You aren't in a dungeon.")?;
        let (x, y, z, _) = g.whereabouts(character).ok_or("You aren't playing.")?;
        if !c.def.at_exit(x, y, z) {
            return Err("You're too far from the way out.".into());
        }
        let name = c.def.name.clone();
        self.out_of_copy(character)?;
        let kept = COPY_KEPT.as_secs() / 60;
        self.notice(character, &format!("{name} is kept as you left it for {kept} minutes after everyone has gone."));
        Ok(())
    }

    /// Starts someone's island over: out of any dungeon first (a fresh island starts at the island's
    /// spawn, which isn't in a dungeon). Returns the fresh island, to save.
    pub fn reset(&mut self, character: i64) -> Option<Value> {
        if self.game_ref(character).is_some_and(|g| g.copy_of().is_some()) {
            self.out_of_copy(character).ok()?;
        }
        self.game_of(character)?.reset(character)
    }

    /// Back out of the copy someone is in, to their home channel, outside its door.
    fn out_of_copy(&mut self, character: i64) -> Result<(), String> {
        let door = self.game_ref(character).and_then(|g| g.copy_of()).map(|c| c.door).ok_or("You aren't in a dungeon.")?;
        let home = self.home.get(&character).copied().unwrap_or(1);
        self.channel(home);
        let o = door.outside;
        self.move_to(character, home, Spot { x: o.x, y: door.portal.y, z: o.z, facing: o.facing })?;
        if let Some(pid) = self.parties.party_of(character).map(|p| p.id) {
            self.send_party(pid);
        }
        Ok(())
    }

    /// Takes someone out of the game they're in and puts them into another, standing at `at`, and
    /// tells their browser where it is now.
    fn move_to(&mut self, character: i64, to: i32, at: Spot) -> Result<(), String> {
        let from = *self.at.get(&character).ok_or("You aren't playing.")?;
        if !self.games.contains_key(&to) {
            return Err("That place is gone.".into());
        }
        let m = self.games.get_mut(&from).and_then(|g| g.take(character)).ok_or("You aren't playing.")?;
        let g = self.games.get_mut(&to).unwrap();
        g.put(character, m, at);
        self.at.insert(character, to);
        let msg = json!({ "t": "space", "space": space_json(g) }).to_string();
        g.send_to(character, &msg);
        Ok(())
    }

    /// Every tick: invitations nobody answered lapse; whoever is in a copy that isn't theirs any
    /// more is warned, then put out; copies empty for COPY_KEPT close.
    pub fn sweep(&mut self, now: Instant) {
        for inv in self.parties.lapse(now) {
            self.tell(inv.to, &invite_json(None));
            self.notice(inv.from, &format!("{} didn't answer your invitation.", inv.to_name));
        }
        let mut warn = Vec::new();
        let mut expel = Vec::new();
        let mut closing = Vec::new();
        for (id, g) in &self.games {
            let Some(c) = g.copy_of() else { continue };
            for who in g.members.keys() {
                if self.may_be_in(*who, *id) {
                    continue;
                }
                match c.expel.get(who) {
                    Some(t) if now >= *t => expel.push(*who),
                    Some(_) => {}
                    None => warn.push((*id, *who)),
                }
            }
            if g.members.is_empty() && c.empty_since.is_some_and(|t| now.duration_since(t) >= COPY_KEPT) {
                closing.push(*id);
            }
        }
        for (id, who) in warn {
            let g = self.games.get_mut(&id).unwrap();
            let name = g.copy_of().map(|c| c.def.name.clone()).unwrap_or_default();
            if let Some(c) = g.copy_mut() {
                c.expel.insert(who, now + EXPEL_AFTER);
            }
            let secs = EXPEL_AFTER.as_secs();
            g.toast(who, format!("This copy of {name} belongs to another party: you'll be taken out in {secs} seconds."), "info");
        }
        for who in expel {
            let _ = self.out_of_copy(who);
        }
        for id in closing {
            self.games.remove(&id);
            let owners: Vec<Owner> = self.copies.iter().filter(|(_, c)| **c == id).map(|((o, _), _)| *o).collect();
            self.copies.retain(|_, c| *c != id);
            for o in owners {
                if let Owner::Party(pid) = o {
                    self.send_party(pid);
                }
            }
        }
    }

    // ---------- Parties (crate::play::parties) ----------

    /// `from` invites someone playing: by id, or by name (in any channel or dungeon).
    pub fn party_invite(&mut self, from: i64, to: Option<i64>, name: Option<&str>) -> Result<(), String> {
        let from_name = self.name_of(from).ok_or("You aren't playing.")?;
        let (to, to_name) = match (to, name) {
            (Some(id), _) => (id, self.name_of(id).ok_or("They aren't playing right now.")?),
            (None, Some(n)) if !n.trim().is_empty() => self.find_by_name(n).ok_or_else(|| format!("Nobody called {} is playing right now.", n.trim()))?,
            _ => return Err("Who do you want to invite?".into()),
        };
        self.parties.invite((from, &from_name), (to, &to_name), Instant::now())?;
        let until = self.parties.invite_for(to).map(|i| i.until).unwrap_or_else(Instant::now);
        self.tell(to, &invite_json(Some((from, &from_name, until))));
        self.notice(from, &format!("You invited {to_name} to your party."));
        Ok(())
    }

    /// `to` answers the invitation from `from`.
    pub fn party_answer(&mut self, to: i64, from: i64, accept: bool) -> Result<(), String> {
        let new_party = self.parties.party_of(from).is_none();
        let changed = self.parties.answer(to, from, accept);
        self.tell(to, &invite_json(None));
        let changed = changed?;
        // A party just formed takes over its leader's copies of dungeons, as in World of Warcraft.
        if accept
            && new_party
            && let Some(&pid) = changed.parties.first()
        {
            self.hand_copies(Owner::Solo(from), Owner::Party(pid));
        }
        self.apply(changed);
        Ok(())
    }

    pub fn party_leave(&mut self, character: i64) -> Result<(), String> {
        let changed = self.parties.leave(character).ok_or("You aren't in a party.")?;
        self.apply(changed);
        Ok(())
    }

    pub fn party_kick(&mut self, by: i64, who: i64) -> Result<(), String> {
        let changed = self.parties.kick(by, who)?;
        self.apply(changed);
        Ok(())
    }

    pub fn party_lead(&mut self, by: i64, who: i64) -> Result<(), String> {
        let changed = self.parties.promote(by, who)?;
        self.apply(changed);
        Ok(())
    }

    /// A character is gone for good (deleted).
    pub fn forget(&mut self, character: i64) {
        if let Some(changed) = self.parties.forget(character) {
            self.apply(changed);
        }
        self.at.remove(&character);
        self.home.remove(&character);
    }

    /// Copies that were `from`'s become `to`'s (where `to` hasn't one of that dungeon already).
    fn hand_copies(&mut self, from: Owner, to: Owner) {
        let keys: Vec<(Owner, &'static str)> = self.copies.keys().filter(|(o, _)| *o == from).copied().collect();
        for k in keys {
            if self.copies.contains_key(&(to, k.1)) {
                continue;
            }
            let id = self.copies.remove(&k).unwrap();
            if let Some(c) = self.games.get_mut(&id).and_then(|g| g.copy_mut()) {
                c.owner = to;
            }
            self.copies.insert((to, k.1), id);
        }
    }

    /// Tells everyone a party change touched: what happened, their party as it is now (or that they
    /// have none). A party that broke up leaves its copies to whoever was left in it.
    fn apply(&mut self, c: Changed) {
        if let Some((pid, Some(last))) = c.ended {
            self.hand_copies(Owner::Party(pid), Owner::Solo(last));
        }
        for (who, text) in &c.say {
            self.notice(*who, text);
        }
        for pid in &c.parties {
            self.send_party(*pid);
        }
        for who in &c.out {
            self.tell(*who, &json!({ "t": "party", "party": null }).to_string());
        }
    }

    /// Every member of a party hears it as it is now.
    fn send_party(&mut self, pid: u64) {
        let Some(view) = self.party_json(pid) else { return };
        let msg = json!({ "t": "party", "party": view }).to_string();
        let ids: Vec<i64> = self.parties.get(pid).map(|p| p.members.iter().map(|m| m.id).collect()).unwrap_or_default();
        for id in ids {
            self.tell(id, &msg);
        }
    }

    /// A party as its members see it: who's in it, who's playing and where, and its copies of
    /// dungeons (how many are inside, and when one closes, if nobody is).
    pub fn party_json(&self, pid: u64) -> Option<Value> {
        let p = self.parties.get(pid)?;
        let members: Vec<Value> = p
            .members
            .iter()
            .map(|m| {
                let g = self.game_ref(m.id);
                json!({ "id": m.id, "name": m.name, "online": g.is_some(), "place": g.map(space_json) })
            })
            .collect();
        let now = Instant::now();
        let dungeons: Vec<Value> = self
            .copies
            .iter()
            .filter(|((o, _), _)| *o == Owner::Party(pid))
            .filter_map(|(_, id)| self.games.get(id))
            .filter_map(|g| {
                let c = g.copy_of()?;
                let closes = c.empty_since.map(|t| COPY_KEPT.saturating_sub(now.duration_since(t)).as_secs());
                Some(json!({ "id": c.def.id, "name": c.def.name, "inside": g.members.len(), "closesIn": closes }))
            })
            .collect();
        Some(json!({ "id": pid, "leader": p.leader, "members": members, "dungeons": dungeons }))
    }

    /// A message for someone's browser, wherever they are.
    pub fn tell(&self, character: i64, text: &str) {
        if let Some(g) = self.game_ref(character) {
            g.send_to(character, text);
        }
    }

    /// A sentence for someone to read (a toast).
    pub fn notice(&self, character: i64, text: &str) {
        self.tell(character, &json!({ "t": "notice", "text": text }).to_string());
    }
}

/// Where a game is, as a browser is told: a channel of Emberholm, or a copy of a dungeon.
pub fn space_json(g: &ChannelGame) -> Value {
    match g.copy_of() {
        Some(c) => json!({ "kind": "dungeon", "dungeon": c.def.id, "name": c.def.name, "copy": g.id }),
        None => json!({ "kind": "channel", "channel": g.id }),
    }
}

/// An invitation waiting for an answer (from whom, and how long it has left), or none.
fn invite_json(inv: Option<(i64, &str, Instant)>) -> String {
    let invite = inv.map(|(from, name, until)| json!({ "from": from, "name": name, "ms": until.saturating_duration_since(Instant::now()).as_millis() as u64 }));
    json!({ "t": "partyInvite", "invite": invite }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::play::Arrival;

    /// Ada (1) and Bo (2) playing in channel 1, each with what their browser hears.
    fn two_in_channel_one() -> (Spaces, mpsc::Receiver<String>, mpsc::Receiver<String>) {
        let mut sp = Spaces::default();
        let mut rx = Vec::new();
        for (id, name) in [(1, "Ada"), (2, "Bo")] {
            let (out, r) = mpsc::channel(256);
            sp.arrive(1, Arrival { character: id, session: id, name: name.into(), out, dev: false, island: None, saved_at: None, now: 0, build: None });
            rx.push(r);
        }
        let b = rx.pop().unwrap();
        let a = rx.pop().unwrap();
        (sp, a, b)
    }

    fn heard(rx: &mut mpsc::Receiver<String>) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(m) = rx.try_recv() {
            out.push(serde_json::from_str(&m).unwrap());
        }
        out
    }

    fn said(msgs: &[Value], t: &str) -> Vec<Value> {
        msgs.iter().filter(|m| m["t"] == t).cloned().collect()
    }

    /// Stands someone at Goblin's Dread's portal.
    fn at_the_portal(sp: &mut Spaces, who: i64) {
        let door = emberholm().recipe.dungeons.iter().find(|d| d.id == "goblinsDread").unwrap();
        let p = door.portal;
        sp.game_of(who).unwrap().place(who, p.x, p.y, p.z);
    }

    fn party(sp: &mut Spaces) -> u64 {
        sp.party_invite(1, None, Some("bo")).unwrap();
        sp.party_answer(2, 1, true).unwrap();
        sp.parties.party_of(1).unwrap().id
    }

    #[test]
    fn an_invitation_by_name_reaches_its_player_and_a_yes_makes_the_party() {
        let (mut sp, mut a, mut b) = two_in_channel_one();
        heard(&mut a);
        heard(&mut b);
        assert_eq!(sp.party_invite(1, None, Some("Nobody")), Err("Nobody called Nobody is playing right now.".into()));
        sp.party_invite(1, None, Some("BO")).unwrap();
        let invite = &said(&heard(&mut b), "partyInvite")[0]["invite"];
        assert_eq!((invite["from"].as_i64(), invite["name"].as_str()), (Some(1), Some("Ada")));
        sp.party_answer(2, 1, true).unwrap();
        for rx in [&mut a, &mut b] {
            let p = said(&heard(rx), "party");
            let p = &p.last().unwrap()["party"];
            assert_eq!(p["leader"], 1);
            assert_eq!(p["members"].as_array().unwrap().len(), 2);
            assert_eq!(p["members"][1]["online"], true);
            assert_eq!(p["members"][1]["place"]["kind"], "channel");
        }
    }

    #[test]
    fn only_admins_go_into_a_developer_zone_and_its_bots_are_there_while_anyone_is() {
        let (mut sp, _a, _b) = two_in_channel_one();
        assert_eq!(sp.enter_zone(1, "battlefield", false, None), Err("Only an admin can go there.".into()));
        assert!(sp.enter_zone(1, "goblinsDread", true, None).is_err(), "a dungeon isn't a developer zone");
        sp.enter_zone(1, "battlefield", true, None).unwrap();
        sp.enter_zone(2, "battlefield", true, None).unwrap();
        // One copy for everyone, with both sides' bots in it.
        let copy = sp.at[&1];
        assert!(copy < 0 && sp.at[&2] == copy);
        assert_eq!(sp.games[&copy].bots.len(), 32);
        // They stay while anyone is in, and go with the last one out.
        sp.out_of_copy(1).unwrap();
        assert_eq!(sp.games[&copy].bots.len(), 32);
        sp.out_of_copy(2).unwrap();
        assert!(sp.games[&copy].bots.is_empty());
        // Out at the zone's door on the island.
        let door = dungeon("battlefield").unwrap().door.as_ref().unwrap();
        let (x, _, z, _) = sp.game_ref(1).unwrap().whereabouts(1).unwrap();
        assert!((x - door.outside.x).abs() < 3.0 && (z - door.outside.z).abs() < 3.0, "{x} {z}");
        // Sent away by an admin, they stay away while anyone is in: someone else coming in doesn't
        // bring them back. The first one into it empty does.
        sp.enter_zone(1, "battlefield", true, None).unwrap();
        assert_eq!(sp.games[&copy].bots.len(), 32);
        sp.games.get_mut(&copy).unwrap().remove_bots();
        sp.enter_zone(2, "battlefield", true, None).unwrap();
        assert!(sp.games[&copy].bots.is_empty());
        sp.out_of_copy(1).unwrap();
        sp.out_of_copy(2).unwrap();
        sp.enter_zone(1, "battlefield", true, None).unwrap();
        assert_eq!(sp.games[&copy].bots.len(), 32);
    }

    #[test]
    fn admins_fight_on_the_side_they_pick_and_are_on_the_islands_one_side_back_out() {
        let (mut sp, _a, _b) = two_in_channel_one();
        let team = |sp: &Spaces, c: i64| sp.games[&sp.at[&c]].players.open_view(client(c)).map(|(p, _, _)| p.team);
        sp.enter_zone(1, "battlefield", true, Some(1)).unwrap();
        sp.enter_zone(2, "battlefield", true, None).unwrap();
        assert_eq!((team(&sp, 1), team(&sp, 2)), (Some(1), Some(0)));
        // Onto the other side, there.
        sp.enter_zone(2, "battlefield", true, Some(1)).unwrap();
        assert_eq!(team(&sp, 2), Some(1));
        // Back on the island, everyone is on its one side.
        sp.out_of_copy(1).unwrap();
        assert_eq!(team(&sp, 1), Some(0));
    }

    #[test]
    fn any_build_goes_in_a_developer_zone_and_only_an_earned_one_back_on_the_island() {
        let (mut sp, _a, _b) = two_in_channel_one();
        let all = crate::skills::skills_from(&["sword", "cleave", "whirlwind"]);
        let wanted = crate::play::build_json(&crate::player::Build { skills: all, ..crate::player::Build::default() });
        // On the island a newcomer hasn't the points for it.
        assert!(!sp.game_of(1).unwrap().set_build(1, &wanted));
        sp.enter_zone(1, "yard", true, None).unwrap();
        assert!(sp.game_of(1).unwrap().set_build(1, &wanted));
        let skills = |sp: &mut Spaces| sp.game_of(1).unwrap().players.open_view(client(1)).unwrap().0.skills;
        assert_eq!(skills(&mut sp), all);
        // Back out, it's the build the island has earned.
        sp.out_of_copy(1).unwrap();
        assert_eq!(skills(&mut sp), crate::player::Build::default().skills);
    }

    #[test]
    fn an_admin_goes_from_one_zone_straight_into_another() {
        let (mut sp, _a, _b) = two_in_channel_one();
        sp.enter_zone(1, "yard", true, None).unwrap();
        let yard = sp.at[&1];
        // Asking for the place you're in changes nothing.
        sp.enter_zone(1, "yard", true, None).unwrap();
        assert_eq!(sp.at[&1], yard);
        sp.enter_zone(1, "goblinCamp", true, None).unwrap();
        let camp = sp.at[&1];
        assert!(camp < 0 && camp != yard);
        assert_eq!(sp.games[&camp].copy_of().map(|c| c.def.id.as_str()), Some("goblinCamp"));
        // Out of the yard as through its door: its bots go with its last player.
        assert!(sp.games[&yard].bots.is_empty());
    }

    #[test]
    fn each_player_has_a_yard_of_their_own() {
        let (mut sp, _a, _b) = two_in_channel_one();
        sp.enter_zone(1, "yard", true, None).unwrap();
        sp.enter_zone(2, "yard", true, None).unwrap();
        assert_ne!(sp.at[&1], sp.at[&2]);
        assert_eq!(sp.games[&sp.at[&1]].bots.len(), 3);
    }

    #[test]
    fn the_goblin_camp_brings_a_war_band() {
        let (mut sp, _a, _b) = two_in_channel_one();
        sp.enter_zone(1, "goblinCamp", true, None).unwrap();
        let copy = sp.at[&1];
        let goblins: Vec<_> = sp.games[&copy].actors.list.iter().filter(|a| a.kind == "goblin").collect();
        assert_eq!(goblins.len(), 6);
        assert!(goblins.iter().all(|a| a.band != 0 && a.band == goblins[0].band), "one band");
    }

    #[test]
    fn an_angry_slime_in_the_yard_slams_the_player_beside_it() {
        let (mut sp, _a, _b) = two_in_channel_one();
        sp.enter_zone(1, "yard", true, None).unwrap();
        let copy = sp.at[&1];
        let g = sp.games.get_mut(&copy).unwrap();
        let (sx, sz) = {
            let a = g.actors.list.iter_mut().find(|a| a.kind == "slime").unwrap();
            a.angry = 600;
            (a.x, a.z)
        };
        {
            let p = g.players.open_mut(client(1)).unwrap().0;
            (p.pos.x, p.pos.z) = (sx + 1.5, sz);
        }
        let full = g.players.open_view(client(1)).unwrap().0.hp;
        let mut saves = Vec::new();
        for _ in 0..200 {
            g.step(&mut saves);
            // Stood still in a nearby spot, as a player waiting for it.
            if g.players.open_view(client(1)).unwrap().0.hp < full {
                return;
            }
        }
        let a = g.actors.list.iter().find(|a| a.kind == "slime").unwrap();
        let p = g.players.open_view(client(1)).unwrap().0;
        panic!(
            "no slam landed: slime at {:.1},{:.1} y {:.2} angry {} state {}, player at {:.1},{:.2},{:.1}",
            a.x, a.z, a.y, a.angry, a.state, p.pos.x, p.pos.y, p.pos.z
        );
    }

    #[test]
    fn the_yard_brings_its_dummy_and_slimes_and_they_stand_on_its_floor() {
        let (mut sp, _a, _b) = two_in_channel_one();
        sp.enter_zone(1, "yard", true, None).unwrap();
        let copy = sp.at[&1];
        let kinds: Vec<String> = sp.games[&copy].actors.list.iter().map(|a| a.kind.clone()).collect();
        assert_eq!(kinds.iter().filter(|k| *k == "dummy").count(), 1);
        assert_eq!(kinds.iter().filter(|k| *k == "slime").count(), 3);
        let mut saves = Vec::new();
        for _ in 0..40 {
            sp.games.get_mut(&copy).unwrap().step(&mut saves);
        }
        // A creature's height is above the ground under it, which in the copy is the yard's floor.
        let yard = dungeon("yard").unwrap();
        for a in &sp.games[&copy].actors.list {
            assert_eq!(yard.floor_at(a.x, a.z), Some(yard.origin.y), "{} is over the yard's floor", a.kind);
            assert!(a.y.abs() < 1.0, "{} stands on it ({} above it)", a.kind, a.y);
        }
    }

    #[test]
    fn a_party_goes_into_one_copy_and_someone_else_into_their_own() {
        let (mut sp, mut a, mut b) = two_in_channel_one();
        let pid = party(&mut sp);
        // Too far from the portal: nothing happens.
        assert!(sp.enter_dungeon(1, "goblinsDread").is_err());
        at_the_portal(&mut sp, 1);
        sp.enter_dungeon(1, "goblinsDread").unwrap();
        let copy = *sp.at.get(&1).unwrap();
        assert!(copy < 0, "in a copy");
        let space = said(&heard(&mut a), "space");
        assert_eq!(space[0]["space"]["kind"], "dungeon");
        assert_eq!(space[0]["space"]["copy"], copy);
        // Bo follows: the same copy.
        at_the_portal(&mut sp, 2);
        sp.enter_dungeon(2, "goblinsDread").unwrap();
        assert_eq!(sp.at[&2], copy);
        let party = said(&heard(&mut b), "party");
        let view = &party.last().unwrap()["party"];
        assert_eq!(view["dungeons"][0]["inside"], 2);
        assert_eq!(view["dungeons"][0]["closesIn"], Value::Null);
        // Cy, on his own, gets a copy of his own.
        let (out, _cy) = mpsc::channel(256);
        sp.arrive(1, Arrival { character: 3, session: 3, name: "Cy".into(), out, dev: false, island: None, saved_at: None, now: 0, build: None });
        at_the_portal(&mut sp, 3);
        sp.enter_dungeon(3, "goblinsDread").unwrap();
        assert!(sp.at[&3] < 0 && sp.at[&3] != copy);
        assert_eq!(sp.games[&copy].members.len(), 2);
        assert_eq!(sp.parties.get(pid).unwrap().members.len(), 2);
    }

    /// Stands someone at the way out of the copy they're in.
    fn at_the_exit(sp: &mut Spaces, who: i64) {
        let def = dungeon("goblinsDread").unwrap();
        let a = def.arrival();
        sp.game_of(who).unwrap().place(who, def.origin.x + def.exit.x, a.y, def.origin.z + def.exit.z);
    }

    #[test]
    fn a_copy_waits_thirty_minutes_after_the_last_player_leaves() {
        let (mut sp, _a, _b) = two_in_channel_one();
        at_the_portal(&mut sp, 1);
        sp.enter_dungeon(1, "goblinsDread").unwrap();
        let copy = sp.at[&1];
        // Not at the way out yet: still inside.
        assert!(sp.leave_dungeon(1).is_err());
        at_the_exit(&mut sp, 1);
        sp.leave_dungeon(1).unwrap();
        assert_eq!(sp.at[&1], 1, "back in channel 1");
        let door = emberholm().recipe.dungeons.iter().find(|d| d.id == "goblinsDread").unwrap();
        let (x, _, z, _) = sp.game_of(1).unwrap().whereabouts(1).unwrap();
        assert!((x - door.outside.x).abs() < 1e-9 && (z - door.outside.z).abs() < 1e-9, "outside the door");
        // Kept for half an hour; back in before then, it's the same copy.
        let left = sp.games[&copy].copy_of().unwrap().empty_since.unwrap();
        sp.sweep(left + COPY_KEPT - Duration::from_secs(1));
        assert!(sp.games.contains_key(&copy));
        at_the_portal(&mut sp, 1);
        sp.enter_dungeon(1, "goblinsDread").unwrap();
        assert_eq!(sp.at[&1], copy, "the same copy, back within the half hour");
        at_the_exit(&mut sp, 1);
        sp.leave_dungeon(1).unwrap();
        let left = sp.games[&copy].copy_of().unwrap().empty_since.unwrap();
        sp.sweep(left + COPY_KEPT);
        assert!(!sp.games.contains_key(&copy), "closed after half an hour empty");
        at_the_portal(&mut sp, 1);
        sp.enter_dungeon(1, "goblinsDread").unwrap();
        assert!(sp.at[&1] < copy, "a fresh copy");
    }

    #[test]
    fn whoever_leaves_the_party_inside_is_put_out_after_a_minute() {
        let (mut sp, _a, _b) = two_in_channel_one();
        party(&mut sp);
        for who in [1, 2] {
            at_the_portal(&mut sp, who);
            sp.enter_dungeon(who, "goblinsDread").unwrap();
        }
        let copy = sp.at[&1];
        // Bo leaves the party: it breaks up, and the copy is Ada's alone now.
        sp.party_leave(2).unwrap();
        let now = Instant::now();
        sp.sweep(now);
        assert_eq!(sp.at[&2], copy, "warned, not out yet");
        assert_eq!(sp.games[&copy].copy_of().unwrap().owner, Owner::Solo(1));
        sp.sweep(now + EXPEL_AFTER);
        assert_eq!(sp.at[&2], 1, "Bo is back in channel 1");
        assert_eq!(sp.at[&1], copy, "Ada stays in what is hers now");
    }

    #[test]
    fn a_party_formed_inside_takes_over_its_leaders_copy() {
        let (mut sp, _a, _b) = two_in_channel_one();
        at_the_portal(&mut sp, 1);
        sp.enter_dungeon(1, "goblinsDread").unwrap();
        let copy = sp.at[&1];
        let pid = party(&mut sp);
        assert_eq!(sp.games[&copy].copy_of().unwrap().owner, Owner::Party(pid));
        sp.sweep(Instant::now());
        assert!(sp.games[&copy].copy_of().unwrap().expel.is_empty(), "Ada is where she belongs");
        at_the_portal(&mut sp, 2);
        sp.enter_dungeon(2, "goblinsDread").unwrap();
        assert_eq!(sp.at[&2], copy);
    }

    #[test]
    fn a_connection_back_within_the_half_hour_is_back_inside() {
        let (mut sp, _a, _b) = two_in_channel_one();
        at_the_portal(&mut sp, 1);
        sp.enter_dungeon(1, "goblinsDread").unwrap();
        let copy = sp.at[&1];
        let island = sp.depart(1, 1).expect("an island to save");
        // Saved as standing outside the door, in case the copy is gone by the time they're back.
        let door = emberholm().recipe.dungeons.iter().find(|d| d.id == "goblinsDread").unwrap();
        assert_eq!(island["player"]["x"].as_f64(), Some(door.outside.x));
        let (out, mut rx) = mpsc::channel(256);
        let (_, _, _, space) = sp
            .arrive(1, Arrival { character: 1, session: 5, name: "Ada".into(), out, dev: false, island: Some(island), saved_at: Some(0), now: 0, build: None });
        assert_eq!(space["kind"], "dungeon");
        assert_eq!(sp.at[&1], copy);
        assert!(said(&heard(&mut rx), "party").len() == 1);
    }

    #[test]
    fn starting_over_inside_a_dungeon_starts_you_over_outside_it() {
        let (mut sp, _a, _b) = two_in_channel_one();
        at_the_portal(&mut sp, 1);
        sp.enter_dungeon(1, "goblinsDread").unwrap();
        let fresh = sp.reset(1).expect("a fresh island");
        assert_eq!(sp.at[&1], 1, "back in channel 1");
        let spawn = emberholm().recipe.spawn;
        assert_eq!((fresh["player"]["x"].as_f64(), fresh["player"]["z"].as_f64()), (Some(spawn.x), Some(spawn.z)));
    }

    #[test]
    fn a_copy_holds_as_many_as_its_dungeon_allows() {
        let mut sp = Spaces::default();
        let def = dungeon("goblinsDread").unwrap();
        let mut rxs = Vec::new();
        for id in 1..=(def.max_players as i64 + 1) {
            let (out, rx) = mpsc::channel(256);
            rxs.push(rx);
            sp.arrive(1, Arrival { character: id, session: id, name: format!("P{id}"), out, dev: false, island: None, saved_at: None, now: 0, build: None });
        }
        for id in 2..=(def.max_players as i64 + 1).min(5) {
            sp.party_invite(1, Some(id), None).unwrap();
            sp.party_answer(id, 1, true).unwrap();
        }
        // Everyone in the party gets in (a party is never bigger than a copy holds).
        for id in 1..=def.max_players.min(5) as i64 {
            at_the_portal(&mut sp, id);
            sp.enter_dungeon(id, "goblinsDread").unwrap();
        }
        let copy = sp.at[&1];
        assert_eq!(sp.games[&copy].members.len(), def.max_players.min(5));
    }
}
