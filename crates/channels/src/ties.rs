//! Who belongs with whom, as placing a player asks it: their party (kept together), then their
//! friends, their guild and their language. The social tier answers (the server's `social/`):
//! parties are all it keeps today, so friends, guilds and languages answer nothing until it learns
//! them, and the policy places by what's left. [`Social`] keeps them all in memory, for the tests
//! and the crowd.

use std::collections::{BTreeMap, BTreeSet};

use crate::CharacterId;

/// A guild, by the social tier's number for it.
pub type GuildId = u64;

/// A party as placing asks of it: who leads it, and everyone in it (the leader too).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PartyTies {
    pub leader: CharacterId,
    pub members: Vec<CharacterId>,
}

/// What the social tier knows of whom a player belongs with.
pub trait Ties {
    /// Their party, if they're in one.
    fn party(&self, who: CharacterId) -> Option<PartyTies>;
    /// Their friends (the hook for friends lists: none until the social tier keeps them).
    fn friends(&self, _who: CharacterId) -> Vec<CharacterId> {
        Vec::new()
    }
    /// Their guild (the hook for guilds: none until the social tier keeps them).
    fn guild(&self, _who: CharacterId) -> Option<GuildId> {
        None
    }
    /// The language they play in, as a tag ("en", "de"), if it's known (the hook for it: none until
    /// the social tier learns it, from their browser or their settings).
    fn language(&self, _who: CharacterId) -> Option<String> {
        None
    }
}

/// Nobody belongs with anybody.
pub struct NoTies;

impl Ties for NoTies {
    fn party(&self, _who: CharacterId) -> Option<PartyTies> {
        None
    }
}

/// Parties, friends, guilds and languages kept in memory.
#[derive(Clone, Debug, Default)]
pub struct Social {
    parties: BTreeMap<u64, PartyTies>,
    party_of: BTreeMap<CharacterId, u64>,
    next_party: u64,
    friends: BTreeMap<CharacterId, BTreeSet<CharacterId>>,
    guilds: BTreeMap<CharacterId, GuildId>,
    languages: BTreeMap<CharacterId, String>,
}

impl Social {
    /// A party led by `leader`, with `members` (the leader among them or not). Anyone in it who was
    /// in another party leaves that one first. Its number.
    pub fn form(&mut self, leader: CharacterId, members: &[CharacterId]) -> u64 {
        let mut all = vec![leader];
        all.extend(members.iter().copied().filter(|m| *m != leader));
        for m in &all {
            self.leave(*m);
        }
        self.next_party += 1;
        let id = self.next_party;
        for m in &all {
            self.party_of.insert(*m, id);
        }
        self.parties.insert(id, PartyTies { leader, members: all });
        id
    }

    /// `who` joins the party `leader` leads (forming it if `leader` has none). False if `leader` is
    /// in a party they don't lead.
    pub fn join(&mut self, leader: CharacterId, who: CharacterId) -> bool {
        let Some(id) = self.party_of.get(&leader).copied() else {
            self.form(leader, &[who]);
            return true;
        };
        if self.parties[&id].leader != leader {
            return false;
        }
        self.leave(who);
        self.parties.get_mut(&id).expect("the leader's party").members.push(who);
        self.party_of.insert(who, id);
        true
    }

    /// `who` leaves their party: the next to have joined leads it if they led, and a party of one is
    /// no party. Who was left alone by it, if anyone.
    pub fn leave(&mut self, who: CharacterId) -> Option<CharacterId> {
        let id = self.party_of.remove(&who)?;
        let p = self.parties.get_mut(&id).expect("their party");
        p.members.retain(|m| *m != who);
        if p.members.len() <= 1 {
            let last = p.members.first().copied();
            if let Some(l) = last {
                self.party_of.remove(&l);
            }
            self.parties.remove(&id);
            return last;
        }
        if p.leader == who {
            p.leader = p.members[0];
        }
        None
    }

    pub fn party_id(&self, who: CharacterId) -> Option<u64> {
        self.party_of.get(&who).copied()
    }

    pub fn parties(&self) -> impl Iterator<Item = &PartyTies> {
        self.parties.values()
    }

    /// `a` and `b` are friends (both ways).
    pub fn befriend(&mut self, a: CharacterId, b: CharacterId) {
        if a != b {
            self.friends.entry(a).or_default().insert(b);
            self.friends.entry(b).or_default().insert(a);
        }
    }

    pub fn set_guild(&mut self, who: CharacterId, guild: GuildId) {
        self.guilds.insert(who, guild);
    }

    pub fn set_language(&mut self, who: CharacterId, language: &str) {
        self.languages.insert(who, language.to_string());
    }
}

impl Ties for Social {
    fn party(&self, who: CharacterId) -> Option<PartyTies> {
        self.party_of.get(&who).and_then(|id| self.parties.get(id)).cloned()
    }

    fn friends(&self, who: CharacterId) -> Vec<CharacterId> {
        self.friends.get(&who).map(|f| f.iter().copied().collect()).unwrap_or_default()
    }

    fn guild(&self, who: CharacterId) -> Option<GuildId> {
        self.guilds.get(&who).copied()
    }

    fn language(&self, who: CharacterId) -> Option<String> {
        self.languages.get(&who).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_party_forms_takes_members_and_ends_at_one() {
        let mut s = Social::default();
        s.join(1, 2);
        assert_eq!(s.party(2), Some(PartyTies { leader: 1, members: vec![1, 2] }));
        assert!(s.join(1, 3));
        assert!(!s.join(2, 4), "only the leader brings someone in");
        // The leader goes: the next to have joined leads.
        assert_eq!(s.leave(1), None);
        assert_eq!(s.party(3).map(|p| p.leader), Some(2));
        // Down to one: no party.
        assert_eq!(s.leave(2), Some(3));
        assert_eq!(s.party(3), None);
        assert_eq!(s.parties().count(), 0);
    }

    #[test]
    fn friends_are_both_ways_and_nobody_is_their_own() {
        let mut s = Social::default();
        s.befriend(1, 2);
        s.befriend(3, 3);
        assert_eq!(s.friends(2), vec![1]);
        assert!(s.friends(3).is_empty());
        assert!(NoTies.party(1).is_none() && NoTies.friends(1).is_empty() && NoTies.guild(1).is_none() && NoTies.language(1).is_none());
    }
}
