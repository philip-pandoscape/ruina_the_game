//! Links across real sockets on this machine: thousands of messages, each arriving once and in
//! order through cuts, duplicates, lost acknowledgements, a full window and both ends restarting;
//! requests and answers; refusals; and world-api's post carried whole.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ruina_link::post::{self, LinkPost};
use ruina_link::{Config, Event, Inbox, Link, Node, SendError};
use ruina_world_api::post::{Address, Envelope, Message, Transport};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
enum Msg {
    N(u64),
    Ask(String),
    Told(String),
}

const LOCAL: &str = "127.0.0.1:0";
/// Long enough for anything here on a busy machine; the tests wait on what happens, not on time.
const PATIENCE: Duration = Duration::from_secs(20);

fn quick() -> Config {
    Config {
        heartbeat: Duration::from_millis(100),
        dead_after: Duration::from_secs(2),
        backoff: (Duration::from_millis(10), Duration::from_millis(200)),
        ..Config::speaking("test/1")
    }
}

async fn node(id: &str, config: Config) -> (Node<Msg>, Inbox<Msg>) {
    Node::start(id, LOCAL, config).await.expect("a node starts")
}

/// Two nodes, and a's link to b.
async fn pair(config: Config) -> (Node<Msg>, Node<Msg>, Inbox<Msg>, Link<Msg>) {
    let (a, _) = node("a", config.clone()).await;
    let (b, inbox) = node("b", config).await;
    let link = a.link("b", &b.local_addr().to_string());
    (a, b, inbox, link)
}

/// Takes `n` numbered messages off an inbox, in the order they come.
async fn take(inbox: &mut Inbox<Msg>, n: usize) -> Vec<u64> {
    let mut got = Vec::with_capacity(n);
    while got.len() < n {
        match tokio::time::timeout(PATIENCE, inbox.recv()).await.expect("messages keep coming").expect("the node runs") {
            ruina_link::Envelope { msg: Msg::N(k), .. } => got.push(k),
            other => panic!("unexpected {other:?}"),
        }
    }
    got
}

/// Waits until `f` holds, checking every few milliseconds.
async fn until(what: &str, mut f: impl FnMut() -> bool) {
    tokio::time::timeout(PATIENCE, async {
        while !f() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{what}"));
}

fn one_to(n: u64) -> Vec<u64> {
    (1..=n).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn messages_arrive_once_and_in_order() {
    let (_a, b, mut inbox, link) = pair(quick()).await;
    for k in 1..=5000 {
        link.send(&Msg::N(k)).await.unwrap();
    }
    assert_eq!(take(&mut inbox, 5000).await, one_to(5000));
    until("everything acknowledged", || link.backlog() == 0).await;
    let s = link.stats();
    assert_eq!((s.sent, s.acked, s.resent, s.connections), (5000, 5000, 0, 1));
    assert_eq!(b.stats().duplicates, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn answers_come_back_to_whoever_asked() {
    let (a, a_inbox) = node("a", quick()).await;
    let (b, b_inbox) = node("b", quick()).await;
    // Each answers what it's asked, in capitals.
    for (n, mut inbox) in [(a.clone(), a_inbox), (b.clone(), b_inbox)] {
        tokio::spawn(async move {
            while let Some(e) = inbox.recv().await {
                if let Msg::Ask(q) = &e.msg {
                    assert!(e.wants_reply());
                    n.reply(&e, &Msg::Told(q.to_uppercase())).unwrap();
                }
            }
        });
    }
    let ab = a.link("b", &b.local_addr().to_string());
    let asks: Vec<_> = (0..200)
        .map(|k| {
            let ab = ab.clone();
            tokio::spawn(async move { ab.request(&Msg::Ask(format!("q{k}")), PATIENCE).await })
        })
        .collect();
    for (k, ask) in asks.into_iter().enumerate() {
        assert_eq!(ask.await.unwrap().unwrap(), Msg::Told(format!("Q{k}")));
    }
    // And the other way, on b's own link to a (b dials the address a's hello gave).
    let ba = b.link_back("a").expect("a called b");
    assert_eq!(ba.request(&Msg::Ask("back".into()), PATIENCE).await.unwrap(), Msg::Told("BACK".into()));
    // A message that wasn't a request can't be answered.
    let (c, mut c_inbox) = node("c", quick()).await;
    let ac = a.link("c", &c.local_addr().to_string());
    ac.send(&Msg::N(1)).await.unwrap();
    let e = c_inbox.recv().await.unwrap();
    assert_eq!(c.reply(&e, &Msg::N(2)), Err(SendError::NotAsked));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cut_link_loses_nothing_and_repeats_nothing() {
    let (_a, b, mut inbox, link) = pair(quick()).await;
    const N: u64 = 20_000;
    let received = Arc::new(AtomicU64::new(0));
    let taker = {
        let received = received.clone();
        tokio::spawn(async move {
            let mut got = Vec::with_capacity(N as usize);
            while got.len() < N as usize {
                match tokio::time::timeout(PATIENCE, inbox.recv()).await.expect("messages keep coming").unwrap().msg {
                    Msg::N(k) => got.push(k),
                    other => panic!("unexpected {other:?}"),
                }
                received.store(got.len() as u64, Ordering::Relaxed);
            }
            got
        })
    };
    let sender = {
        let link = link.clone();
        tokio::spawn(async move {
            for k in 1..=N {
                link.send(&Msg::N(k)).await.unwrap();
            }
        })
    };
    // Cut ten times as the messages flow, each time once more have arrived, and restore once the
    // sender has queued more behind the cut (or filled its window: nothing is acknowledged while
    // the link is cut).
    let fault = link.fault();
    for round in 1..=10u64 {
        until("messages arriving", || received.load(Ordering::Relaxed) >= round * N / 12).await;
        let sent = link.stats().sent;
        fault.cut();
        until("the sender queueing behind the cut", || link.stats().sent >= (sent + 200).min(N) || link.backlog() >= 4096).await;
        fault.restore();
        until("dialled again", || link.stats().connections > round).await;
    }
    sender.await.unwrap();
    assert_eq!(taker.await.unwrap(), one_to(N), "every message once, in order");
    until("everything acknowledged", || link.backlog() == 0).await;
    let s = link.stats();
    assert!(s.connections >= 11, "dialled again after every cut: {s:?}");
    println!("across 10 cuts: {s:?}, {} duplicates dropped", b.stats().duplicates);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn messages_written_twice_are_taken_once() {
    let (_a, b, mut inbox, link) = pair(quick()).await;
    link.fault().duplicate(true);
    for k in 1..=3000 {
        link.send(&Msg::N(k)).await.unwrap();
    }
    assert_eq!(take(&mut inbox, 3000).await, one_to(3000));
    until("every second copy dropped", || b.stats().duplicates == 3000).await;
    assert_eq!(b.stats().delivered, 3000);
    assert!(inbox.try_recv().is_none(), "nothing more");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lost_acknowledgements_are_sent_again_and_dropped() {
    let (_a, b, mut inbox, link) = pair(quick()).await;
    let fault = link.fault();
    fault.lose_acks(true);
    for k in 1..=1000 {
        link.send(&Msg::N(k)).await.unwrap();
    }
    assert_eq!(take(&mut inbox, 1000).await, one_to(1000));
    assert_eq!(link.backlog(), 1000, "nothing acknowledged");
    // A new connection, with the acknowledgements still lost: all of it again, all of it dropped.
    fault.cut();
    fault.restore();
    until("the thousand sent again and dropped", || b.stats().duplicates == 1000).await;
    // Heard again: everything goes, and the link carries on where it was.
    fault.lose_acks(false);
    fault.cut();
    fault.restore();
    until("everything acknowledged", || link.backlog() == 0).await;
    for k in 1001..=1010 {
        link.send(&Msg::N(k)).await.unwrap();
    }
    assert_eq!(take(&mut inbox, 10).await, (1001..=1010).collect::<Vec<_>>());
    assert_eq!(b.stats().delivered, 1010);
    assert!(link.stats().resent >= 1000);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_full_window_holds_the_sender_back() {
    let config = Config { window: 64, limit: 100, inbox: 8, ack_every: 4, ..quick() };
    let (_a, _b, mut inbox, link) = pair(config).await;
    // Nobody reads b's inbox: it fills, b stops reading the link, and the window fills behind it.
    let mut queued = 0u64;
    loop {
        match link.try_send(&Msg::N(queued + 1)) {
            Ok(_) => queued += 1,
            Err(SendError::Full) => {
                // Acknowledgements for what b took in may still be coming: wait for them to stop.
                let before = link.backlog();
                tokio::time::sleep(Duration::from_millis(200)).await;
                if link.backlog() == before {
                    break;
                }
            }
            Err(e) => panic!("{e}"),
        }
    }
    assert!((64..=64 + 9).contains(&queued), "the window, and the few b took in: {queued}");
    assert_eq!(link.backlog(), 64);
    // A send waits...
    let waiting = {
        let link = link.clone();
        tokio::spawn(async move { link.send(&Msg::N(queued + 1)).await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!waiting.is_finished(), "a send waits while the window is full");
    // ...and push queues past the window, up to the limit.
    let mut pushed = 0;
    while link.push(&Msg::N(queued + 2 + pushed)).is_ok() {
        pushed += 1;
    }
    assert_eq!(link.backlog(), 100, "push stops at the limit");
    assert_eq!(link.push(&Msg::N(0)), Err(SendError::Full));
    // Reading again, everything comes through, the waiting send among it.
    let total = queued + 1 + pushed;
    let got = take(&mut inbox, total as usize).await;
    assert_eq!(got.len() as u64, total);
    assert!(waiting.await.unwrap().is_ok());
    let mut sorted = got.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), got.len(), "nothing twice");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restarted_peer_is_sent_what_it_never_acknowledged() {
    let (a, b, mut inbox, link) = pair(quick()).await;
    let mut events = a.events();
    let first = b.incarnation();
    link.fault().lose_acks(true);
    for k in 1..=500 {
        link.send(&Msg::N(k)).await.unwrap();
    }
    assert_eq!(take(&mut inbox, 500).await, one_to(500));
    // b goes, and a new start of it comes up elsewhere (the directory would say where).
    b.stop();
    let (b2, mut inbox2) = node("b", quick()).await;
    link.fault().lose_acks(false);
    a.link("b", &b2.local_addr().to_string());
    assert_eq!(take(&mut inbox2, 500).await, one_to(500), "everything b never acknowledged, again");
    until("acknowledged by the new start", || link.backlog() == 0).await;
    link.send(&Msg::N(501)).await.unwrap();
    assert_eq!(take(&mut inbox2, 1).await, vec![501]);
    let restarted = tokio::time::timeout(PATIENCE, async {
        loop {
            if let Ok(Event::Restarted { peer, was, now }) = events.recv().await {
                return (peer, was, now);
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(restarted, ("b".to_string(), first, b2.incarnation()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restarted_sender_numbers_its_messages_afresh() {
    let (a, b, mut inbox, link) = pair(quick()).await;
    for k in 1..=100 {
        link.send(&Msg::N(k)).await.unwrap();
    }
    assert_eq!(take(&mut inbox, 100).await, one_to(100));
    a.stop();
    let (a2, _) = node("a", quick()).await;
    let link2 = a2.link("b", &b.local_addr().to_string());
    for k in 1..=50 {
        link2.send(&Msg::N(k)).await.unwrap();
    }
    assert_eq!(take(&mut inbox, 50).await, one_to(50), "a new start's messages aren't taken for old ones");
    assert_eq!(b.stats().duplicates, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_peer_speaking_another_protocol_is_refused() {
    let (a, _) = node("a", Config::speaking("x/1")).await;
    let (b, mut inbox) = node("b", Config { protocol: "x/2".into(), ..quick() }).await;
    let mut events = a.events();
    let link = a.link("b", &b.local_addr().to_string());
    link.send(&Msg::N(1)).await.unwrap();
    let why = tokio::time::timeout(PATIENCE, async {
        loop {
            if let Ok(Event::Refused { why, .. }) = events.recv().await {
                return why;
            }
        }
    })
    .await
    .unwrap();
    assert!(why.contains("x/2+msgpack") && why.contains("x/1+msgpack"), "{why}");
    assert!(inbox.try_recv().is_none());
    // Nor is a node that isn't the one dialled (the address taken by another, say).
    let (a2, _) = node("a2", Config { protocol: "x/2".into(), ..quick() }).await;
    let mut events = a2.events();
    let wrong = a2.link("c", &b.local_addr().to_string());
    wrong.send(&Msg::N(1)).await.unwrap();
    let why = tokio::time::timeout(PATIENCE, async {
        loop {
            if let Ok(Event::Refused { peer, why }) = events.recv().await
                && peer == "c"
            {
                return why;
            }
        }
    })
    .await
    .unwrap();
    assert!(why.contains("answers as b"), "{why}");
}

/// A process's own post, standing in for the tiers in it: whatever is handed to it is kept.
#[derive(Default)]
struct Kept(Mutex<Vec<(Address, Message)>>);

impl Transport for Kept {
    fn send(&self, to: Address, msg: Message) -> bool {
        self.0.lock().unwrap().push((to, msg));
        true
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_tiers_messages_cross_between_processes_whole() {
    use ruina_world_api::gate::{ToConn, ToGate};
    use ruina_world_api::ids::{Conn, GateId, SimId};
    use ruina_world_api::input::Input;
    use ruina_world_api::sim::ToSim;

    let (gate, _) = Node::<Envelope>::start("gate-1", LOCAL, post::config()).await.unwrap();
    let (sim, inbox) = Node::<Envelope>::start("sim-1", LOCAL, post::config()).await.unwrap();
    let kept = Arc::new(Kept::default());
    tokio::spawn({
        let kept = kept.clone();
        async move { post::deliver(inbox, kept.as_ref()).await }
    });
    let post = LinkPost::new(gate.clone());
    // The directory's word: simulation 7 plays in sim-1.
    post.place(Address::Sim(SimId(7)), "sim-1", &sim.local_addr().to_string());
    let input = Input { seq: 99, view: 1234 * 16, raw: [127, 0, 1, 0, 0, 0, 0, 0, 0, 127] };
    assert!(post.sim(SimId(7), ToSim::Inputs { character: 42, inputs: vec![input; 3] }));
    let conn = Conn { gate: GateId(1), character: 42, session: 5 };
    // Somewhere nobody is known to be, or a message that doesn't fit its address: false.
    assert!(!post.sim(SimId(8), ToSim::Stop));
    assert!(!post.send(Address::Sim(SimId(7)), Message::Gate(ToGate::Conn { conn, msg: ToConn::Kicked })));
    assert!(post.sim(SimId(7), ToSim::Estates { conn }));
    until("both arrived", || kept.0.lock().unwrap().len() == 2).await;
    let kept = kept.0.lock().unwrap();
    assert!(matches!(&kept[0], (Address::Sim(SimId(7)), Message::Sim(ToSim::Inputs { character: 42, inputs })) if inputs == &vec![input; 3]));
    assert!(matches!(&kept[1], (Address::Sim(SimId(7)), Message::Sim(ToSim::Estates { conn: c })) if *c == conn));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn json_links_carry_the_same() {
    let config = Config { encoding: ruina_link::Encoding::Json, ..quick() };
    let (_a, _b, mut inbox, link) = pair(config).await;
    for k in 1..=100 {
        link.send(&Msg::N(k)).await.unwrap();
    }
    assert_eq!(take(&mut inbox, 100).await, one_to(100));
}
