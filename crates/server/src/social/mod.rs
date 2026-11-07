//! The social tier: parties (later friends and guilds). It keeps who is in which party, who leads
//! each, and the invitations waiting; it knows who is online, through which connection and where,
//! and the copies each party has, from the directory; and it tells the directory whenever someone's
//! party changes (whose copies they may be in). A party's members hear it as it is whenever it, or
//! where they are, changes. Parties live in its memory: a restart ends them.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::mpsc;

use ruina_world_api::directory::ToDirectory;
use ruina_world_api::gate::ToConn;
use ruina_world_api::social::{CopyNote, InviteView, PartyCopyView, PartyMemberView, PartyView, Place, ToSocial};
use ruina_world_api::{CharacterId, Conn, Owner, PartyId, SpaceId, Transport};

use crate::directory::COPY_KEPT;
use crate::store::now_ms;

/// Parties: who plays with whom.
pub mod parties;

use parties::{Changed, Parties};

/// Someone online: through which connection, as whom, where.
struct Online {
    conn: Conn,
    name: String,
    place: Option<Place>,
}

pub struct Social {
    post: Arc<dyn Transport>,
    pub parties: Parties,
    online: HashMap<CharacterId, Online>,
    /// Each party's copies, as the directory last told them.
    copies: BTreeMap<(Owner, SpaceId), CopyNote>,
}

impl Social {
    pub fn new(post: Arc<dyn Transport>) -> Social {
        Social { post, parties: Parties::default(), online: HashMap::new(), copies: BTreeMap::new() }
    }

    /// Runs the social tier: its messages as they come, and unanswered invitations lapsing.
    pub fn spawn(mut self, mut inbox: mpsc::UnboundedReceiver<ToSocial>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut lapse = tokio::time::interval(Duration::from_millis(250));
            loop {
                tokio::select! {
                    msg = inbox.recv() => match msg {
                        Some(m) => self.handle(m),
                        None => return,
                    },
                    _ = lapse.tick() => self.lapse(Instant::now()),
                }
            }
        })
    }

    pub fn handle(&mut self, msg: ToSocial) {
        match msg {
            ToSocial::Invite { conn, to, name } => {
                if let Err(text) = self.invite(conn.character, to, name.as_deref()) {
                    self.post.conn(conn, ToConn::Error { text });
                }
            }
            ToSocial::Answer { conn, from, accept } => {
                if let Err(text) = self.answer(conn.character, from, accept) {
                    self.post.conn(conn, ToConn::Error { text });
                }
            }
            ToSocial::Leave { conn } => {
                let done = self.parties.leave(conn.character).ok_or_else(|| "You aren't in a party.".to_string());
                self.after(conn, done);
            }
            ToSocial::Kick { conn, who } => {
                let done = self.parties.kick(conn.character, who);
                self.after(conn, done);
            }
            ToSocial::Lead { conn, who } => {
                let done = self.parties.promote(conn.character, who);
                self.after(conn, done);
            }
            ToSocial::Online { conn, name, place } => {
                self.online.insert(conn.character, Online { conn, name, place: Some(place) });
                // Their party and any invitation waiting for them, and their party told they're here.
                if let Some(inv) = self.parties.invite_for(conn.character) {
                    let view =
                        InviteView { from: inv.from, name: inv.from_name.clone(), ms: inv.until.saturating_duration_since(Instant::now()).as_millis() as u64 };
                    self.post.conn(conn, ToConn::PartyInvite { invite: Some(view) });
                }
                match self.parties.party_of(conn.character).map(|p| p.id) {
                    Some(pid) => self.send_party(pid),
                    None => {
                        self.post.conn(conn, ToConn::Party { party: None });
                    }
                }
            }
            ToSocial::Offline { character, session } => {
                if self.online.get(&character).is_some_and(|o| o.conn.session == session) {
                    self.online.remove(&character);
                    if let Some(pid) = self.parties.party_of(character).map(|p| p.id) {
                        self.send_party(pid);
                    }
                }
            }
            ToSocial::Placed { character, place } => {
                if let Some(o) = self.online.get_mut(&character) {
                    o.place = Some(place);
                }
                if let Some(pid) = self.parties.party_of(character).map(|p| p.id) {
                    self.send_party(pid);
                }
            }
            ToSocial::Copy { owner, copy } => {
                self.copies.insert((owner, copy.space.clone()), copy);
                if let Owner::Party(pid) = owner {
                    self.send_party(pid.0);
                }
            }
            ToSocial::CopyClosed { owner, space } => {
                self.copies.remove(&(owner, space));
                if let Owner::Party(pid) = owner {
                    self.send_party(pid.0);
                }
            }
            ToSocial::Forget { character } => {
                self.online.remove(&character);
                if let Some(changed) = self.parties.forget(character) {
                    self.apply(changed);
                }
            }
        }
    }

    /// `from` invites someone playing: by id, or by name (wherever they are).
    fn invite(&mut self, from: CharacterId, to: Option<CharacterId>, name: Option<&str>) -> Result<(), String> {
        let from_name = self.online.get(&from).map(|o| o.name.clone()).ok_or("You aren't playing.")?;
        let (to, to_name) = match (to, name) {
            (Some(id), _) => (id, self.online.get(&id).map(|o| o.name.clone()).ok_or("They aren't playing right now.")?),
            (None, Some(n)) if !n.trim().is_empty() => {
                let n = n.trim();
                self.online
                    .iter()
                    .find(|(_, o)| o.name.eq_ignore_ascii_case(n))
                    .map(|(id, o)| (*id, o.name.clone()))
                    .ok_or_else(|| format!("Nobody called {n} is playing right now."))?
            }
            _ => return Err("Who do you want to invite?".into()),
        };
        self.parties.invite((from, &from_name), (to, &to_name), Instant::now())?;
        let until = self.parties.invite_for(to).map(|i| i.until).unwrap_or_else(Instant::now);
        let ms = until.saturating_duration_since(Instant::now()).as_millis() as u64;
        self.tell(to, ToConn::PartyInvite { invite: Some(InviteView { from, name: from_name, ms }) });
        self.notice(from, &format!("You invited {to_name} to your party."));
        Ok(())
    }

    /// `to` answers the invitation from `from`.
    fn answer(&mut self, to: CharacterId, from: CharacterId, accept: bool) -> Result<(), String> {
        let new_party = self.parties.party_of(from).is_none();
        let changed = self.parties.answer(to, from, accept);
        self.tell(to, ToConn::PartyInvite { invite: None });
        let changed = changed?;
        // A party just formed takes over its leader's copies of dungeons, as in World of Warcraft.
        let mut hand = Vec::new();
        if accept
            && new_party
            && let Some(&pid) = changed.parties.first()
        {
            hand.push((Owner::Solo(from), Owner::Party(PartyId(pid))));
        }
        self.apply_with(changed, hand);
        Ok(())
    }

    /// What a leave, kick or lead did, or why it couldn't (said to whoever asked).
    fn after(&mut self, conn: Conn, done: Result<Changed, String>) {
        match done {
            Ok(changed) => self.apply(changed),
            Err(text) => {
                self.post.conn(conn, ToConn::Error { text });
            }
        }
    }

    fn apply(&mut self, c: Changed) {
        self.apply_with(c, Vec::new());
    }

    /// Tells everyone a party change touched what happened, and their party as it is now (or that
    /// they have none); and the directory who is in which party now, and whose copies are whose (a
    /// party that broke up leaves its copies to whoever was left in it).
    fn apply_with(&mut self, c: Changed, mut hand: Vec<(Owner, Owner)>) {
        if let Some((pid, Some(last))) = c.ended {
            hand.push((Owner::Party(PartyId(pid)), Owner::Solo(last)));
        }
        let mut members: Vec<(CharacterId, Option<PartyId>)> = Vec::new();
        for pid in &c.parties {
            if let Some(p) = self.parties.get(*pid) {
                members.extend(p.members.iter().map(|m| (m.id, Some(PartyId(*pid)))));
            }
        }
        members.extend(c.out.iter().map(|who| (*who, None)));
        if !members.is_empty() || !hand.is_empty() {
            self.post.directory(ToDirectory::Parties { changed: members, hand });
        }
        for (who, text) in &c.say {
            self.notice(*who, text);
        }
        for pid in &c.parties {
            self.send_party(*pid);
        }
        for who in &c.out {
            self.tell(*who, ToConn::Party { party: None });
        }
    }

    /// Invitations nobody answered in time.
    pub fn lapse(&mut self, now: Instant) {
        for inv in self.parties.lapse(now) {
            self.tell(inv.to, ToConn::PartyInvite { invite: None });
            self.notice(inv.from, &format!("{} didn't answer your invitation.", inv.to_name));
        }
    }

    /// Every member of a party hears it as it is now.
    fn send_party(&self, pid: u64) {
        let Some(view) = self.party_view(pid) else { return };
        for m in &view.members {
            self.tell(m.id, ToConn::Party { party: Some(view.clone()) });
        }
    }

    /// A party as its members see it: who's in it, who's playing and where, and its copies of
    /// dungeons (how many are inside, and when one closes, if nobody is).
    pub fn party_view(&self, pid: u64) -> Option<PartyView> {
        let p = self.parties.get(pid)?;
        let members = p
            .members
            .iter()
            .map(|m| {
                let o = self.online.get(&m.id);
                PartyMemberView { id: m.id, name: m.name.clone(), online: o.is_some(), place: o.and_then(|o| o.place.as_ref()).map(|p| p.view.clone()) }
            })
            .collect();
        let now = now_ms();
        let kept = COPY_KEPT.as_millis() as i64;
        let dungeons = self
            .copies
            .iter()
            .filter(|((o, _), _)| *o == Owner::Party(PartyId(pid)))
            .map(|(_, c)| PartyCopyView {
                id: c.instance.clone(),
                name: c.name.clone(),
                inside: c.inside,
                closes_in: c.empty_since.map(|t| ((kept - (now - t)).max(0) / 1000) as u64),
            })
            .collect();
        Some(PartyView { id: pid, leader: p.leader, members, dungeons })
    }

    /// A message for someone's browser, wherever they are.
    fn tell(&self, character: CharacterId, msg: ToConn) {
        if let Some(o) = self.online.get(&character) {
            self.post.conn(o.conn, msg);
        }
    }

    /// A sentence for someone to read (a toast).
    fn notice(&self, character: CharacterId, text: &str) {
        self.tell(character, ToConn::Notice { text: text.to_string() });
    }
}
