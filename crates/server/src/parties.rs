//! Parties: a few players who go adventuring together, as groups do in World of Warcraft. Anyone not
//! in one may invite someone who isn't either (they become its leader when the answer is yes); in a
//! party only the leader invites, kicks and hands the lead on. Whoever leaves goes; a party of one is
//! no party. Members stay in it while they're offline. A party goes into its own copy of a dungeon
//! together (crate::spaces). Parties live in the server's memory, like mini-games' tables: a restart
//! ends them.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// The most players in a party (and a dungeon's copy holds as many).
pub const PARTY_MAX: usize = 5;
/// How long an invitation waits for its answer.
pub const INVITE_FOR: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq)]
pub struct Member {
    pub id: i64,
    pub name: String,
}

#[derive(Clone, Debug)]
pub struct Party {
    pub id: u64,
    pub leader: i64,
    /// In the order they joined.
    pub members: Vec<Member>,
}

impl Party {
    pub fn has(&self, character: i64) -> bool {
        self.members.iter().any(|m| m.id == character)
    }

    pub fn name_of(&self, character: i64) -> String {
        self.members.iter().find(|m| m.id == character).map(|m| m.name.clone()).unwrap_or_default()
    }
}

#[derive(Clone, Debug)]
pub struct Invite {
    pub from: i64,
    pub from_name: String,
    pub to: i64,
    pub to_name: String,
    pub until: Instant,
}

/// What a change did, for the server to tell everyone it touched.
#[derive(Debug, Default, PartialEq)]
pub struct Changed {
    /// Parties whose members or leader changed (to send each member their party again).
    pub parties: Vec<u64>,
    /// Characters who are no longer in any party (to tell them so).
    pub out: Vec<i64>,
    /// A party that ended, with whoever was left in it, if anyone.
    pub ended: Option<(u64, Option<i64>)>,
    /// Sentences to say to people: (who, what).
    pub say: Vec<(i64, String)>,
}

#[derive(Default)]
pub struct Parties {
    next: u64,
    pub list: HashMap<u64, Party>,
    of: HashMap<i64, u64>,
    pub invites: Vec<Invite>,
}

impl Parties {
    pub fn party_of(&self, character: i64) -> Option<&Party> {
        self.of.get(&character).and_then(|id| self.list.get(id))
    }

    pub fn get(&self, id: u64) -> Option<&Party> {
        self.list.get(&id)
    }

    /// The invitation waiting for someone's answer, if any (the newest).
    pub fn invite_for(&self, to: i64) -> Option<&Invite> {
        self.invites.iter().rev().find(|i| i.to == to)
    }

    /// `from` invites `to`. Fails with a sentence to show the one who asked.
    pub fn invite(&mut self, from: (i64, &str), to: (i64, &str), now: Instant) -> Result<(), String> {
        let (from, from_name) = from;
        let (to, to_name) = to;
        if from == to {
            return Err("You can't invite yourself.".into());
        }
        if let Some(p) = self.party_of(from) {
            if p.leader != from {
                return Err("Only the party leader can invite.".into());
            }
            if p.members.len() + self.invites.iter().filter(|i| i.from == from).count() >= PARTY_MAX {
                return Err("Your party is full.".into());
            }
        }
        if self.of.contains_key(&to) {
            return Err(format!("{to_name} is already in a party."));
        }
        if self.invites.iter().any(|i| i.from == from && i.to == to) {
            return Err(format!("You've already invited {to_name}."));
        }
        if self.invites.iter().any(|i| i.to == to) {
            return Err(format!("{to_name} is answering another invitation."));
        }
        self.invites.push(Invite { from, from_name: from_name.into(), to, to_name: to_name.into(), until: now + INVITE_FOR });
        Ok(())
    }

    /// `to` answers `from`'s invitation. Yes: into the party (made now if `from` wasn't in one).
    pub fn answer(&mut self, to: i64, from: i64, accept: bool) -> Result<Changed, String> {
        let Some(k) = self.invites.iter().position(|i| i.to == to && i.from == from) else {
            return Err("That invitation has lapsed.".into());
        };
        let inv = self.invites.remove(k);
        let mut changed = Changed::default();
        if !accept {
            changed.say.push((from, format!("{} declined your invitation.", inv.to_name)));
            return Ok(changed);
        }
        if self.of.contains_key(&to) {
            return Err("You're already in a party.".into());
        }
        let id = match self.of.get(&from).copied() {
            Some(id) => {
                let p = &self.list[&id];
                if p.leader != from {
                    return Err(format!("{} isn't the party's leader any more.", inv.from_name));
                }
                if p.members.len() >= PARTY_MAX {
                    return Err("That party is full.".into());
                }
                id
            }
            None => {
                self.next += 1;
                let id = self.next;
                self.list.insert(id, Party { id, leader: from, members: vec![Member { id: from, name: inv.from_name.clone() }] });
                self.of.insert(from, id);
                id
            }
        };
        let p = self.list.get_mut(&id).unwrap();
        for m in &p.members {
            changed.say.push((m.id, format!("{} joined the party.", inv.to_name)));
        }
        p.members.push(Member { id: to, name: inv.to_name.clone() });
        self.of.insert(to, id);
        changed.say.push((to, format!("You joined {}'s party.", inv.from_name)));
        changed.parties.push(id);
        Ok(changed)
    }

    /// Someone leaves their party (or is kicked out by its leader, `by`).
    pub fn leave(&mut self, character: i64) -> Option<Changed> {
        self.remove(character, None)
    }

    pub fn kick(&mut self, by: i64, who: i64) -> Result<Changed, String> {
        let p = self.party_of(by).ok_or("You aren't in a party.")?;
        if p.leader != by {
            return Err("Only the party leader can remove someone.".into());
        }
        if who == by {
            return Err("Leave the party instead.".into());
        }
        if !p.has(who) {
            return Err("They aren't in your party.".into());
        }
        Ok(self.remove(who, Some(by)).unwrap_or_default())
    }

    /// The leader hands the lead to another member.
    pub fn promote(&mut self, by: i64, who: i64) -> Result<Changed, String> {
        let id = *self.of.get(&by).ok_or("You aren't in a party.")?;
        let p = self.list.get_mut(&id).unwrap();
        if p.leader != by {
            return Err("Only the party leader can hand on the lead.".into());
        }
        if !p.has(who) || who == by {
            return Err("They aren't in your party.".into());
        }
        p.leader = who;
        let name = p.name_of(who);
        let mut changed = Changed { parties: vec![id], ..Changed::default() };
        for m in &p.members {
            changed.say.push((m.id, if m.id == who { "You lead the party now.".to_string() } else { format!("{name} leads the party now.") }));
        }
        Ok(changed)
    }

    fn remove(&mut self, character: i64, kicked_by: Option<i64>) -> Option<Changed> {
        let id = self.of.remove(&character)?;
        // Invitations they sent as its leader lapse with them.
        self.invites.retain(|i| i.from != character);
        let p = self.list.get_mut(&id).unwrap();
        let name = p.name_of(character);
        p.members.retain(|m| m.id != character);
        let mut changed = Changed { out: vec![character], ..Changed::default() };
        changed.say.push((character, if kicked_by.is_some() { "You were removed from the party.".to_string() } else { "You left the party.".to_string() }));
        if p.members.len() <= 1 {
            // A party of one is no party.
            let last = p.members.first().map(|m| m.id);
            if let Some(l) = last {
                self.of.remove(&l);
                self.invites.retain(|i| i.from != l);
                changed.out.push(l);
                changed.say.push((l, "Your party has broken up.".into()));
            }
            self.list.remove(&id);
            changed.ended = Some((id, last));
            return Some(changed);
        }
        if p.leader == character {
            p.leader = p.members[0].id;
            let lead = p.members[0].name.clone();
            for m in &p.members {
                changed.say.push((m.id, if m.id == p.leader { "You lead the party now.".to_string() } else { format!("{lead} leads the party now.") }));
            }
        }
        for m in &p.members {
            changed.say.push((m.id, if kicked_by.is_some() { format!("{name} was removed from the party.") } else { format!("{name} left the party.") }));
        }
        changed.parties.push(id);
        Some(changed)
    }

    /// Invitations nobody answered in time (each to tell both sides about).
    pub fn lapse(&mut self, now: Instant) -> Vec<Invite> {
        let (gone, kept): (Vec<Invite>, Vec<Invite>) = std::mem::take(&mut self.invites).into_iter().partition(|i| i.until <= now);
        self.invites = kept;
        gone
    }

    /// A character is gone for good (deleted): out of their party and any invitation.
    pub fn forget(&mut self, character: i64) -> Option<Changed> {
        self.invites.retain(|i| i.from != character && i.to != character);
        self.leave(character)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADA: (i64, &str) = (1, "Ada");
    const BO: (i64, &str) = (2, "Bo");
    const CY: (i64, &str) = (3, "Cy");

    fn ada_and_bo() -> (Parties, u64) {
        let mut ps = Parties::default();
        let now = Instant::now();
        ps.invite(ADA, BO, now).unwrap();
        let c = ps.answer(BO.0, ADA.0, true).unwrap();
        (ps, c.parties[0])
    }

    #[test]
    fn an_invitation_answered_yes_makes_a_party_led_by_who_asked() {
        let (ps, id) = ada_and_bo();
        let p = ps.get(id).unwrap();
        assert_eq!(p.leader, ADA.0);
        assert_eq!(p.members.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["Ada", "Bo"]);
        assert_eq!(ps.party_of(BO.0).unwrap().id, id);
        assert!(ps.invites.is_empty());
    }

    #[test]
    fn only_the_leader_invites_and_only_the_partyless() {
        let (mut ps, _) = ada_and_bo();
        let now = Instant::now();
        assert_eq!(ps.invite(BO, CY, now), Err("Only the party leader can invite.".into()));
        assert_eq!(ps.invite(CY, BO, now), Err("Bo is already in a party.".into()));
        assert_eq!(ps.invite(ADA, ADA, now), Err("You can't invite yourself.".into()));
        ps.invite(ADA, CY, now).unwrap();
        assert_eq!(ps.invite(ADA, CY, now), Err("You've already invited Cy.".into()));
        // Declined: nothing changes, and Ada hears why.
        let c = ps.answer(CY.0, ADA.0, false).unwrap();
        assert_eq!(c.say, [(ADA.0, "Cy declined your invitation.".to_string())]);
        assert!(ps.party_of(CY.0).is_none());
        assert!(ps.answer(CY.0, ADA.0, true).is_err(), "answered already");
    }

    #[test]
    fn a_party_holds_five_counting_who_is_invited() {
        let (mut ps, id) = ada_and_bo();
        let now = Instant::now();
        for k in 3..=5 {
            ps.invite(ADA, (k, "x"), now).unwrap();
        }
        assert_eq!(ps.invite(ADA, (6, "y"), now), Err("Your party is full.".into()));
        for k in 3..=5 {
            ps.answer(k, ADA.0, true).unwrap();
        }
        assert_eq!(ps.get(id).unwrap().members.len(), PARTY_MAX);
    }

    #[test]
    fn the_lead_passes_on_when_the_leader_leaves_and_a_party_of_one_ends() {
        let (mut ps, id) = ada_and_bo();
        ps.invite(ADA, CY, Instant::now()).unwrap();
        ps.answer(CY.0, ADA.0, true).unwrap();
        let c = ps.leave(ADA.0).unwrap();
        assert_eq!(c.parties, [id]);
        assert_eq!(ps.get(id).unwrap().leader, BO.0, "the next to have joined leads");
        assert!(c.say.contains(&(BO.0, "You lead the party now.".to_string())));
        // Bo removes Cy: just Bo is left, which is no party.
        let c = ps.kick(BO.0, CY.0).unwrap();
        assert_eq!(c.ended, Some((id, Some(BO.0))));
        assert_eq!(c.out, [CY.0, BO.0]);
        assert!(ps.party_of(BO.0).is_none() && ps.get(id).is_none());
    }

    #[test]
    fn only_the_leader_kicks_or_hands_on_the_lead() {
        let (mut ps, id) = ada_and_bo();
        assert!(ps.kick(BO.0, ADA.0).is_err());
        assert!(ps.promote(BO.0, ADA.0).is_err());
        ps.promote(ADA.0, BO.0).unwrap();
        assert_eq!(ps.get(id).unwrap().leader, BO.0);
    }

    #[test]
    fn unanswered_invitations_lapse() {
        let mut ps = Parties::default();
        let now = Instant::now();
        ps.invite(ADA, BO, now).unwrap();
        assert!(ps.lapse(now + INVITE_FOR / 2).is_empty());
        let gone = ps.lapse(now + INVITE_FOR);
        assert_eq!(gone.len(), 1);
        assert!(ps.answer(BO.0, ADA.0, true).is_err());
    }
}
