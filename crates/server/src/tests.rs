//! The tiers together, in one process, as players use them: connections taken up by the directory,
//! lives read by the store, simulations on their threads playing channels and copies, players
//! handed between them mid-connection, parties across them, copies kept and closed, whoever doesn't
//! belong put out. Each test starts a world of its own on tables in memory (the store's rules, as
//! Postgres keeps them); its players are connections made as the gate makes them (`way_in`), without
//! a socket, reading what their browser would be sent.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::mpsc;

use ruina_world_api::gate::{SpaceView, ToConn};
use ruina_world_api::records::{Private, TickOut};
use ruina_world_api::sim::{Ask, ToSim};
use ruina_world_api::social::{PartyView, ToSocial};
use ruina_world_api::{CharacterId, Conn, EntityId, EntityKind, SimId, Transport};

use crate::directory::{COPY_KEPT, EXPEL_AFTER};
use crate::gate::Event;
use crate::gate::socket::{Seat, way_in};
use crate::life::Command;
use crate::open::dungeon::{door_into, dungeon};
use crate::start::{Tiers, start_channels, start_with};
use crate::store::Db;
use crate::store::memory::Tables;

/// How long a test waits for anything to happen.
const WAIT: Duration = Duration::from_secs(10);

static SESSIONS: AtomicI64 = AtomicI64::new(1);

struct World {
    tiers: Tiers,
    tables: Arc<Mutex<Tables>>,
}

impl World {
    fn new() -> World {
        World::with(COPY_KEPT, EXPEL_AFTER)
    }

    fn with(copy_kept: Duration, expel_after: Duration) -> World {
        let (db, tables) = Db::memory();
        World { tiers: start_with(db, copy_kept, expel_after), tables }
    }

    /// A world whose channels go by `channels`: small numbers, so a few players fill one.
    fn channels(channels: ruina_channels::Tuning) -> World {
        let (db, tables) = Db::memory();
        World { tiers: start_channels(db, channels), tables }
    }

    fn post(&self) -> Arc<dyn Transport> {
        self.tiers.post.clone()
    }

    /// Character `id`, an admin (so the developer's teleport stands them anywhere), comes in.
    async fn join(&self, id: CharacterId, name: &str) -> Player {
        self.join_as(id, name, true).await
    }

    async fn join_as(&self, id: CharacterId, name: &str, admin: bool) -> Player {
        {
            let mut t = Db::tables(&self.tables);
            if !t.characters.contains_key(&id) {
                t.add_character(id, name);
            }
        }
        let (tx, mut rx) = mpsc::channel(1024);
        let conn = Conn { gate: self.tiers.gate.id, character: id, session: SESSIONS.fetch_add(1, Ordering::Relaxed) };
        let mut seat = Seat::new(self.tiers.gate.clone(), conn, tx);
        let way = way_in(&mut seat, &mut rx, name, admin).await.unwrap_or_else(|e| panic!("{name} came in: {e}"));
        Player { post: self.post(), seat, rx, held: way.held, space: way.space, seq: 0 }
    }

    /// A character's row as the store keeps it.
    fn row(&self, id: CharacterId) -> crate::store::memory::CharacterRow {
        Db::tables(&self.tables).characters[&id].clone()
    }
}

/// A player connected without a socket: what their browser would hear, kept as it comes.
struct Player {
    post: Arc<dyn Transport>,
    seat: Seat,
    rx: mpsc::Receiver<Event>,
    held: VecDeque<Event>,
    /// Where the welcome said they are.
    space: Value,
    seq: u32,
}

impl Player {
    fn conn(&self) -> Conn {
        self.seat.conn
    }

    fn sim(&self) -> SimId {
        self.seat.sim.expect("playing somewhere")
    }

    fn ask(&self, ask: Ask) {
        self.post.sim(self.sim(), ToSim::Ask { conn: self.conn(), ask });
    }

    fn social(&self, msg: ToSocial) {
        self.post.social(msg);
    }

    /// The developer's teleport: onto whatever is solid at (x, z).
    fn teleport(&mut self, x: f64, z: f64) {
        self.seq += 1;
        self.ask(Ask::Command { seq: self.seq, command: Command::Teleport { x, z, facing: None } });
    }

    /// The next thing to come: what came during the way in first.
    async fn next(&mut self, deadline: Instant) -> Option<Event> {
        let e = match self.held.pop_front() {
            Some(e) => e,
            None => tokio::time::timeout(deadline.saturating_duration_since(Instant::now()), self.rx.recv()).await.ok().flatten()?,
        };
        // Where its inputs go now, as the gate's connection has it (a move, a crossing).
        if let Event::Msg(m) = &e
            && let Some((sim, inputs)) = self.seat.heard(m)
        {
            self.post.sim(sim, ToSim::Inputs { conn: self.conn(), inputs });
        }
        Some(e)
    }

    /// Waits for a message `pick` takes (passing over everything else).
    async fn heard<T>(&mut self, what: &str, mut pick: impl FnMut(&ToConn) -> Option<T>) -> T {
        let deadline = Instant::now() + WAIT;
        while let Some(e) = self.next(deadline).await {
            if let Event::Msg(m) = &e
                && let Some(t) = pick(m)
            {
                return t;
            }
        }
        panic!("character {} never heard {what}", self.conn().character);
    }

    /// The next tick from where they play, with them in it.
    async fn tick(&mut self) -> Arc<TickOut> {
        let deadline = Instant::now() + WAIT;
        while let Some(e) = self.next(deadline).await {
            if let Event::Tick(out) = e
                && Some(out.sim) == self.seat.sim
                && out.private_of(self.conn().character).is_some()
            {
                return out;
            }
        }
        panic!("character {} heard no tick", self.conn().character);
    }

    /// Their own state, as the next tick has it.
    async fn me(&mut self) -> Private {
        let out = self.tick().await;
        out.private_of(self.conn().character).cloned().expect("theirs")
    }

    /// Ticks until `ok` holds of one (and returns it).
    async fn until(&mut self, what: &str, mut ok: impl FnMut(&TickOut, &Private) -> bool) -> Arc<TickOut> {
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            let out = self.tick().await;
            let me = out.private_of(self.conn().character).expect("theirs").clone();
            if ok(&out, &me) {
                return out;
            }
        }
        panic!("character {} never saw {what}", self.conn().character);
    }

    /// They move somewhere: where they are now.
    async fn moved(&mut self) -> SpaceView {
        self.heard("a move", |m| if let ToConn::Moved { space, .. } = m { Some(space.clone()) } else { None }).await
    }

    /// Their party as the first message after now that `ok` takes has it.
    async fn party(&mut self, what: &str, mut ok: impl FnMut(&Option<PartyView>) -> bool) -> Option<PartyView> {
        self.heard(what, |m| match m {
            ToConn::Party { party } if ok(party) => Some(party.clone()),
            _ => None,
        })
        .await
    }

    /// An error said to them.
    async fn error(&mut self) -> String {
        self.heard("an error", |m| if let ToConn::Error { text } = m { Some(text.clone()) } else { None }).await
    }

    /// Stands them at (x, z) and waits until they're there.
    async fn stand(&mut self, what: &str, x: f64, z: f64) {
        self.teleport(x, z);
        self.until(what, |_, me| (me.you.p.pos.x - x).abs() < 0.5 && (me.you.p.pos.z - z).abs() < 0.5).await;
    }

    /// Through Goblin's Dread's portal (standing at it, on the ledge behind the falls) into their
    /// copy: where they are now.
    async fn through_the_portal(&mut self) -> SpaceView {
        let door = door_into("goblinsDread").expect("its door");
        self.stand("at the portal", door.outside.x, door.outside.z).await;
        self.ask(Ask::Dungeon { id: "goblinsDread".into(), enter: true });
        self.moved().await
    }

    /// Out of the instance they're in, through its way out: where they are now.
    async fn out_of(&mut self, instance: &str) -> SpaceView {
        let def = dungeon(instance).expect("the instance");
        self.stand("at the way out", def.exit.x, def.exit.z).await;
        self.ask(Ask::Dungeon { id: instance.into(), enter: false });
        self.moved().await
    }

    /// The bots in the space they play in.
    async fn bots(&mut self) -> usize {
        let out = self.tick().await;
        out.frame.records().filter(|r| EntityId::from_raw(r.key).and_then(EntityId::kind) == Some(EntityKind::Bot)).count()
    }
}

/// A copy's number, from where someone is.
fn copy_of(s: &SpaceView) -> u64 {
    match s {
        SpaceView::Dungeon { copy, .. } => *copy,
        SpaceView::Channel { .. } => panic!("in a channel, not a copy"),
    }
}

/// Whether someone's life has said something (a toast) with `text` in it.
fn toasted(me: &Private, text: &str) -> bool {
    me.life_events.iter().any(|e| matches!(e, crate::life::LifeEvent::Toast { text: t, .. } if t.contains(text)))
}

/// `a` invites `b` by name, and `b` says yes: a party `a` leads, as `b` sees it.
async fn party(a: &mut Player, b: &mut Player, b_name: &str) -> PartyView {
    a.social(ToSocial::Invite { conn: a.conn(), to: None, name: Some(b_name.to_string()) });
    let from = b.heard("an invitation", |m| if let ToConn::PartyInvite { invite: Some(i) } = m { Some(i.from) } else { None }).await;
    assert_eq!(from, a.conn().character);
    b.social(ToSocial::Answer { conn: b.conn(), from, accept: true });
    let me = b.conn().character;
    let has = |p: &Option<PartyView>| p.as_ref().is_some_and(|p| p.members.iter().any(|m| m.id == me));
    a.party("their party", has).await;
    b.party("their party", has).await.expect("a party")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_player_comes_in_to_their_home_channel_and_is_played_there() {
    let w = World::new();
    let mut a = w.join(1, "Ada").await;
    assert_eq!(a.space, serde_json::json!({ "kind": "channel", "channel": 1 }));
    // Their own state, 20 times a second, from the simulation playing their channel.
    let first = a.tick().await;
    let next = a.tick().await;
    assert!(next.tick > first.tick);
    assert_eq!(first.space.as_ref().map(|s| s.to_string()).as_deref(), Some("channel:emberholm:1"));
    // Granted once.
    assert_eq!(w.row(1).epoch, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_window_takes_the_character_over_under_a_newer_grant() {
    let w = World::new();
    let mut first = w.join(1, "Ada").await;
    let mut second = w.join(1, "Ada").await;
    first.heard("that another window took over", |m| matches!(m, ToConn::Kicked).then_some(())).await;
    assert_eq!(w.row(1).epoch, 2, "a newer grant");
    // The newer window plays on.
    second.tick().await;
    // What anything still holding the first grant writes is refused: the store keeps the newer.
    let stale = ruina_world_api::store::LifeWrite {
        character: 1,
        epoch: ruina_world_api::Epoch(1),
        life: serde_json::json!({ "state": {}, "player": {} }),
        space: ruina_world_api::SpaceId::channel("emberholm", 1),
        writer: None,
        tell: None,
    };
    assert_eq!(Db::Memory(w.tables.clone()).write_lives(&[stale]).await, Ok(vec![false]));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_invitation_by_name_reaches_its_player_and_a_yes_makes_the_party() {
    let w = World::new();
    let mut a = w.join(1, "Ada").await;
    let mut b = w.join(2, "Bo").await;
    a.social(ToSocial::Invite { conn: a.conn(), to: None, name: Some("Nobody".into()) });
    assert_eq!(a.error().await, "Nobody called Nobody is playing right now.");
    let p = party(&mut a, &mut b, "BO").await;
    assert_eq!(p.leader, 1);
    assert_eq!(p.members.len(), 2);
    assert!(p.members.iter().all(|m| m.online && m.place == Some(SpaceView::Channel { channel: 1 })));
    b.social(ToSocial::Lead { conn: b.conn(), who: 1 });
    assert_eq!(b.error().await, "Only the party leader can hand on the lead.");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_party_goes_into_one_copy_and_someone_else_into_their_own() {
    let w = World::new();
    let mut a = w.join(1, "Ada").await;
    let mut b = w.join(2, "Bo").await;
    party(&mut a, &mut b, "Bo").await;
    // Too far from the portal: nothing happens.
    a.ask(Ask::Dungeon { id: "goblinsDread".into(), enter: true });
    assert_eq!(a.error().await, "You're too far from the way into Goblin's Dread.");
    // Through it: into a copy, played by a simulation of its own, mid-connection.
    let channel = a.sim();
    let into = a.through_the_portal().await;
    assert_ne!(a.sim(), channel, "played by another simulation now");
    let me = a.me().await;
    let arrive = dungeon("goblinsDread").unwrap().arrival();
    assert!((me.you.p.pos.x - arrive.x).abs() < 1.0 && (me.you.p.pos.z - arrive.z).abs() < 1.0, "where it's entered");
    // Bo follows: the same copy, and the party sees two inside it.
    assert_eq!(b.through_the_portal().await, into);
    b.party("two inside", |p| p.as_ref().is_some_and(|p| p.dungeons.first().is_some_and(|d| d.inside == 2 && d.closes_in.is_none()))).await;
    // Cy, on his own, gets a copy of his own.
    let mut c = w.join(3, "Cy").await;
    let theirs = c.through_the_portal().await;
    assert_ne!(copy_of(&theirs), copy_of(&into));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inputs_sent_to_where_a_player_was_follow_them_into_their_copy() {
    let w = World::new();
    let mut a = w.join(1, "Ada").await;
    let channel = a.sim();
    a.through_the_portal().await;
    let inputs: Vec<ruina_world_api::input::Input> = (1..=6).map(|k| ruina_world_api::input::Input { seq: 1000 + k, view: 0, raw: [0; 10] }).collect();
    // Sent to the channel's simulation, as a browser that hadn't heard yet would: passed on.
    w.post().sim(channel, ToSim::Inputs { conn: a.conn(), inputs });
    a.until("the inputs run", |_, me| me.you.ack >= 1006).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_copy_is_kept_a_while_after_the_last_player_leaves_then_closed() {
    let w = World::with(Duration::from_millis(1500), EXPEL_AFTER);
    let mut a = w.join(1, "Ada").await;
    let copy = copy_of(&a.through_the_portal().await);
    // Not at the way out yet: still inside.
    a.ask(Ask::Dungeon { id: "goblinsDread".into(), enter: false });
    assert_eq!(a.error().await, "You're too far from the way out.");
    assert_eq!(a.out_of("goblinsDread").await, SpaceView::Channel { channel: 1 });
    let notice = a.heard("the notice", |m| if let ToConn::Notice { text } = m { Some(text.clone()) } else { None }).await;
    assert!(notice.contains("is kept as you left it"), "{notice}");
    // Outside its door.
    let door = door_into("goblinsDread").unwrap();
    let me = a.me().await;
    assert!((me.you.p.pos.x - door.outside.x).abs() < 1e-6 && (me.you.p.pos.z - door.outside.z).abs() < 1e-6, "outside the door");
    // Back in while it's kept: the same copy.
    assert_eq!(copy_of(&a.through_the_portal().await), copy);
    a.out_of("goblinsDread").await;
    // Once it's been empty long enough it closes, and the next time in is a fresh copy.
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_ne!(copy_of(&a.through_the_portal().await), copy, "a fresh copy");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn whoever_leaves_the_party_inside_is_put_out_after_a_while() {
    let w = World::with(COPY_KEPT, Duration::from_millis(800));
    let mut a = w.join(1, "Ada").await;
    let mut b = w.join(2, "Bo").await;
    party(&mut a, &mut b, "Bo").await;
    let copy = a.through_the_portal().await;
    assert_eq!(b.through_the_portal().await, copy);
    // Bo leaves the party: it breaks up, and the copy is Ada's alone now. Bo is warned, then put out.
    b.social(ToSocial::Leave { conn: b.conn() });
    b.until("the warning", |_, me| toasted(me, "belongs to another party")).await;
    assert_eq!(b.moved().await, SpaceView::Channel { channel: 1 }, "Bo is back in the channel");
    // Ada stays in what is hers now.
    let out = a.tick().await;
    assert!(matches!(&out.space, Some(s) if s.is_copy()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_party_formed_inside_takes_over_its_leaders_copy() {
    let w = World::with(COPY_KEPT, Duration::from_millis(500));
    let mut a = w.join(1, "Ada").await;
    let mut b = w.join(2, "Bo").await;
    let copy = a.through_the_portal().await;
    party(&mut a, &mut b, "Bo").await;
    // Bo follows Ada in: her copy is the party's now.
    assert_eq!(b.through_the_portal().await, copy);
    // And nobody is put out of it.
    let t = Instant::now();
    while t.elapsed() < Duration::from_millis(1200) {
        assert!(!toasted(&a.me().await, "belongs to another party"));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connection_back_soon_is_back_inside_its_copy() {
    let w = World::new();
    let mut a = w.join(1, "Ada").await;
    let copy = a.through_the_portal().await;
    a.tick().await;
    drop(a);
    // Saved as standing outside the door, in the world, in case the copy is gone when they're back.
    let door = door_into("goblinsDread").unwrap();
    let deadline = Instant::now() + WAIT;
    while w.row(1).life.as_ref().and_then(|l| l["player"]["x"].as_f64()) != Some(door.outside.x) {
        assert!(Instant::now() < deadline, "saved outside the door: {:?}", w.row(1).life.map(|l| l["player"].clone()));
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(w.row(1).space.as_deref(), Some("channel:emberholm:1"), "saved in the world");
    let a = w.join(1, "Ada").await;
    assert_eq!(a.space, serde_json::to_value(&copy).unwrap(), "back inside");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn starting_over_inside_a_dungeon_starts_you_over_outside_it() {
    let w = World::new();
    let mut a = w.join(1, "Ada").await;
    a.through_the_portal().await;
    a.ask(Ask::Reset);
    assert_eq!(a.moved().await, SpaceView::Channel { channel: 1 });
    a.heard("the life started over and written", |m| matches!(m, ToConn::Reset).then_some(())).await;
    let spawn = crate::open::zone::emberholm().recipe.spawn;
    let life = w.row(1).life.expect("written");
    assert_eq!((life["player"]["x"].as_f64(), life["player"]["z"].as_f64()), (Some(spawn.x), Some(spawn.z)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_admins_go_into_a_developer_zone_and_its_bots_are_there_while_anyone_is() {
    let w = World::new();
    let mut p = w.join_as(1, "Ada", false).await;
    p.ask(Ask::Zone { id: "battlefield".into(), team: None });
    assert_eq!(p.error().await, "Only an admin can go there.");
    let mut a = w.join(2, "Bo").await;
    let mut b = w.join(3, "Cy").await;
    a.ask(Ask::Zone { id: "goblinsDread".into(), team: None });
    assert_eq!(a.error().await, "There's no such place.", "a dungeon isn't a developer zone");
    a.ask(Ask::Zone { id: "battlefield".into(), team: Some(1) });
    let field = a.moved().await;
    b.ask(Ask::Zone { id: "battlefield".into(), team: None });
    assert_eq!(b.moved().await, field, "one copy for everyone");
    assert_eq!(a.bots().await, 32, "both sides' bots");
    // They fight on the side they picked; asked again there, onto the other side.
    assert_eq!((a.me().await.you.p.team, b.me().await.you.p.team), (1, 0));
    b.ask(Ask::Zone { id: "battlefield".into(), team: Some(1) });
    b.until("on the other side", |_, me| me.you.p.team == 1).await;
    // Out through its way out, at its door, on the world's one side.
    assert_eq!(a.out_of("battlefield").await, SpaceView::Channel { channel: 1 });
    let me = a.me().await;
    let out = dungeon("battlefield").unwrap().door.as_ref().unwrap().outside;
    assert_eq!(me.you.p.team, 0);
    assert!((me.you.p.pos.x - out.x).abs() < 3.0 && (me.you.p.pos.z - out.z).abs() < 3.0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn any_build_goes_in_a_developer_zone_and_only_an_earned_one_back_in_the_world() {
    let w = World::new();
    let mut a = w.join(1, "Ada").await;
    let all = crate::skills::skills_from(&["sword", "cleave", "whirlwind"]);
    let wanted = crate::sim::build_json(&crate::player::Build { skills: all, ..crate::player::Build::default() });
    // In the world a newcomer hasn't the points for it.
    a.ask(Ask::Build { build: wanted.clone() });
    assert_eq!(a.error().await, "That build isn't allowed.");
    a.ask(Ask::Zone { id: "yard".into(), team: None });
    a.moved().await;
    a.ask(Ask::Build { build: wanted });
    a.until("the build tried", |_, me| me.you.p.skills == all).await;
    // Back out, it's the build the life has earned.
    a.out_of("yard").await;
    assert_eq!(a.me().await.you.p.skills, crate::player::Build::default().skills);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_admin_goes_from_one_zone_straight_into_another_and_each_has_a_yard_of_their_own() {
    let w = World::new();
    let mut a = w.join(1, "Ada").await;
    let mut b = w.join(2, "Bo").await;
    a.ask(Ask::Zone { id: "yard".into(), team: None });
    let yard = a.moved().await;
    assert_eq!(a.bots().await, 3);
    b.ask(Ask::Zone { id: "yard".into(), team: None });
    assert_ne!(b.moved().await, yard, "a yard each");
    // Asking for the zone you're in changes nothing; another takes you straight there.
    a.ask(Ask::Zone { id: "yard".into(), team: None });
    a.ask(Ask::Zone { id: "goblinCamp".into(), team: None });
    let camp = a.moved().await;
    assert!(matches!(&camp, SpaceView::Dungeon { dungeon, .. } if dungeon == "goblinCamp"), "{camp:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_party_of_five_all_get_into_one_copy() {
    let w = World::new();
    let def = dungeon("goblinsDread").unwrap();
    let mut leader = w.join(1, "P1").await;
    let mut rest = Vec::new();
    for id in 2..=5 {
        let mut p = w.join(id, &format!("P{id}")).await;
        party(&mut leader, &mut p, &format!("P{id}")).await;
        rest.push(p);
    }
    // Everyone in the party gets in (a party is never bigger than a copy holds).
    let copy = leader.through_the_portal().await;
    for p in &mut rest {
        assert_eq!(p.through_the_portal().await, copy);
    }
    assert_eq!(1 + rest.len(), def.max_players.min(5));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_party_spans_simulations_each_member_seen_where_they_are() {
    let w = World::new();
    let mut a = w.join(1, "Ada").await;
    let mut b = w.join(2, "Bo").await;
    party(&mut a, &mut b, "Bo").await;
    let copy = a.through_the_portal().await;
    // Bo, in the channel's simulation, sees Ada where she is: in her copy, played by another.
    let p = b.party("Ada in the copy", |p| p.as_ref().is_some_and(|p| p.members.iter().any(|m| m.id == 1 && m.place.as_ref() == Some(&copy)))).await.unwrap();
    assert!(p.members.iter().any(|m| m.id == 2 && m.place == Some(SpaceView::Channel { channel: 1 })));
    // Ada goes: Bo hears she's offline.
    drop(a);
    b.party("Ada offline", |p| p.as_ref().is_some_and(|p| p.members.iter().any(|m| m.id == 1 && !m.online))).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_simulation_plays_its_game_twenty_times_a_second_while_anyone_is_in_it() {
    let w = World::new();
    let mut a = w.join(1, "Ada").await;
    let start = a.tick().await.tick;
    let t = Instant::now();
    let mut last = start;
    while last < start + 20 {
        last = a.tick().await.tick;
    }
    let took = t.elapsed();
    assert!(took > Duration::from_millis(700) && took < Duration::from_millis(2500), "20 ticks in {took:?}");
}

/// Where a move between channels took someone, and why, as their browser hears it.
async fn channel_moved(p: &mut Player) -> (u32, u32, ruina_channels::Why) {
    p.heard("a move between channels", |m| if let ToConn::ChannelMoved { from, to, why } = m { Some((*from, *to, *why)) } else { None }).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_player_changes_channel_and_an_invitation_takes_them_to_their_partys() {
    use ruina_channels::{Target, Tuning, Why};
    // Two to a channel (three with a party), changed as often as you like.
    let t = Tuning { soft_cap: 2, hard_cap: 3, open_ahead: 0, quiet: 1, merge_fill: 1, quiet_for: 600.0, change_every: 0.0, ..Tuning::small() };
    let w = World::channels(t);
    let a = w.join(1, "Ada").await;
    let mut b = w.join(2, "Bo").await;
    let mut c = w.join(3, "Cy").await;
    let channel = |p: &Player| p.space["channel"].as_u64();
    assert_eq!((channel(&a), channel(&b), channel(&c)), (Some(1), Some(1), Some(2)), "two fill channel 1, the third opens channel 2");
    // Channel 1 is full to Cy.
    c.ask(Ask::Channel { to: Target::Channel(1) });
    assert_eq!(c.error().await, "That channel is full.");
    // Bo goes to channel 2, standing where he stood, and hears where and why.
    let before = b.me().await.you.p.pos;
    b.ask(Ask::Channel { to: Target::Channel(2) });
    assert_eq!(channel_moved(&mut b).await, (1, 2, Why::Choice));
    let after = b.me().await.you.p.pos;
    assert!((after.x - before.x).abs() < 0.5 && (after.z - before.z).abs() < 0.5, "{before:?} -> {after:?}");
    // Ada, in channel 1, invites him into her party: once he says yes, he joins her there.
    a.social(ToSocial::Invite { conn: a.conn(), to: Some(2), name: None });
    let from = b.heard("an invitation", |m| if let ToConn::PartyInvite { invite: Some(i) } = m { Some(i.from) } else { None }).await;
    b.social(ToSocial::Answer { conn: b.conn(), from, accept: true });
    assert_eq!(channel_moved(&mut b).await, (2, 1, Why::Party));
    // His region's channels, as he sees them now.
    b.ask(Ask::Channels);
    let view = b.heard("the channels", |m| if let ToConn::Channels(v) = m { Some(v.clone()) } else { None }).await;
    assert_eq!(view.here, 1);
    assert_eq!(view.list.iter().map(|c| c.n).collect::<Vec<_>>(), [1, 2]);
    assert_eq!(view.list[0].party, 1, "Ada is with him");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_quiet_channel_merges_and_its_player_is_moved_across() {
    use ruina_channels::{Tuning, Why};
    // Three to a channel; one with fewer than two is quiet at once, and merges into another that
    // stays at two or fewer.
    let t = Tuning { soft_cap: 3, hard_cap: 4, open_ahead: 0, quiet: 2, merge_fill: 2, quiet_for: 0.0, merge_notice: 0.0, merge_wait: 1.0, ..Tuning::small() };
    let w = World::channels(t);
    let a = w.join(1, "Ada").await;
    let b = w.join(2, "Bo").await;
    let c = w.join(3, "Cy").await;
    let mut d = w.join(4, "Dee").await;
    assert_eq!(d.space["channel"].as_u64(), Some(2));
    // Bo and Cy go: channel 1 can take Dee now. He's told, then moved across.
    drop(b);
    drop(c);
    d.heard("the channel closing", |m| if let ToConn::Notice { text } = m { text.contains("This channel is closing").then_some(()) } else { None }).await;
    assert_eq!(channel_moved(&mut d).await, (2, 1, Why::Merge));
    assert_eq!(d.tick().await.space.as_ref().map(|s| s.to_string()).as_deref(), Some("channel:emberholm:1"));
    drop(a);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn players_coming_in_together_fill_channels_in_turn() {
    use ruina_channels::Tuning;
    let t = Tuning { soft_cap: 3, hard_cap: 4, open_ahead: 0, quiet: 2, merge_fill: 2, quiet_for: 600.0, ..Tuning::small() };
    let w = World::channels(t);
    // Eight at once, as a busy moment's connections come.
    let names: Vec<String> = (1..=8).map(|id| format!("P{id}")).collect();
    let joins: Vec<_> = names.iter().zip(1..).map(|(name, id)| w.join(id, name)).collect();
    let players = futures_util::future::join_all(joins).await;
    let mut per: std::collections::BTreeMap<u64, usize> = std::collections::BTreeMap::new();
    for p in &players {
        *per.entry(p.space["channel"].as_u64().expect("a channel")).or_default() += 1;
    }
    assert_eq!(per.into_iter().collect::<Vec<_>>(), [(1, 3), (2, 3), (3, 2)], "each channel filled to three before the next");
}
