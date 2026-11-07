//! The gate: players' connections. It signs them in (`socket.rs`: the WebSocket, `/ws/world`), takes
//! their characters up through the directory, the store and the simulation they play in, and from
//! then on passes what they press and ask on to that simulation (or to the social tier), and what the
//! tiers say back to them, encoded (`encode.rs`). Each simulation sends the gate its tick's records
//! once; each connection builds its own update from them, on the gate's threads.
//!
//! The gate's own task keeps who is connected through it, and in which simulation each plays now
//! (it hears `Moved`), so a tick goes to the connections playing there; and it answers the questions
//! the gate asks the other tiers (whether a character is being played, everyone's lives written).

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use tokio::sync::{Notify, mpsc, oneshot, watch};

use ruina_world_api::directory::ToDirectory;
use ruina_world_api::gate::{ToConn, ToGate};
use ruina_world_api::post::{Answer, Reply};
use ruina_world_api::records::TickOut;
use ruina_world_api::{Address, CharacterId, Conn, GateId, SessionId, SimId, Transport};

/// What a browser's bytes mean, and what it's sent, encoded.
pub mod encode;
/// A player's connection: sign-in, the welcome, inputs and commands in, updates out.
pub mod socket;

/// Where the server is in its life. Railway starts a new server for an update, then stops this one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Running,
    /// Stopping: every browser has been told the server is being updated, and the lives are being
    /// written. Nobody new comes in.
    Updating,
    /// The lives are written: every connection closes as a service restart (1012).
    Closing,
}

/// What reaches a connection: a tick's records to build its update from, or a message.
#[derive(Debug)]
pub enum Event {
    Tick(Arc<TickOut>),
    Msg(ToConn),
}

/// The gate's own bookkeeping, from its connections (in this process only).
enum Control {
    Open { conn: Conn, tx: mpsc::Sender<Event> },
    Close { conn: Conn },
    Ask { id: u64, reply: oneshot::Sender<Answer> },
}

/// A connection held here, and the simulation it plays in now.
struct Held {
    tx: mpsc::Sender<Event>,
    sim: Option<SimId>,
}

pub struct Gate {
    pub id: GateId,
    pub post: Arc<dyn Transport>,
    control: mpsc::UnboundedSender<Control>,
    connected: AtomicUsize,
    next_ask: AtomicU64,
    stage: watch::Sender<Stage>,
    /// Asked to stop the way SIGTERM asks (the developer endpoint, for tests).
    stop: Notify,
}

impl Gate {
    /// A gate, its task taking its mail from `inbox`.
    pub fn start(id: GateId, post: Arc<dyn Transport>, inbox: mpsc::UnboundedReceiver<ToGate>) -> Arc<Gate> {
        let (control, controls) = mpsc::unbounded_channel();
        let gate = Arc::new(Gate {
            id,
            post,
            control,
            connected: AtomicUsize::new(0),
            next_ask: AtomicU64::new(0),
            stage: watch::channel(Stage::Running).0,
            stop: Notify::new(),
        });
        tokio::spawn(run(inbox, controls));
        gate
    }

    /// A connection opens here: what's for it comes to `tx` from now on.
    pub fn open(&self, conn: Conn, tx: mpsc::Sender<Event>) {
        self.connected.fetch_add(1, Ordering::Relaxed);
        let _ = self.control.send(Control::Open { conn, tx });
    }

    /// A connection closed.
    pub fn close(&self, conn: Conn) {
        self.connected.fetch_sub(1, Ordering::Relaxed);
        let _ = self.control.send(Control::Close { conn });
    }

    /// Players connected through this gate right now.
    pub fn count(&self) -> usize {
        self.connected.load(Ordering::Relaxed)
    }

    /// Asks the directory something (`ask` makes the question, given where to answer); its answer,
    /// if one comes within `wait`.
    pub async fn ask(&self, wait: Duration, ask: impl FnOnce(Reply) -> ToDirectory) -> Option<Answer> {
        let id = self.next_ask.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        let _ = self.control.send(Control::Ask { id, reply: tx });
        self.post.directory(ask(Reply { to: Address::Gate(self.id), id }));
        tokio::time::timeout(wait, rx).await.ok().and_then(Result::ok)
    }

    /// Whether a connection is playing this character right now (anywhere).
    pub async fn is_playing(&self, character: CharacterId) -> bool {
        matches!(self.ask(Duration::from_secs(5), |reply| ToDirectory::IsPlaying { character, reply }).await, Some(Answer::Playing(true)))
    }

    /// A character is gone for good (deleted): the directory forgets them, their party lets them
    /// go, and what they built in their home channel comes down.
    pub fn forget(&self, character: CharacterId, channel: Option<u32>) {
        self.post.directory(ToDirectory::Forget { character, channel });
    }

    pub fn stage(&self) -> Stage {
        *self.stage.borrow()
    }

    pub fn subscribe(&self) -> watch::Receiver<Stage> {
        self.stage.subscribe()
    }

    /// Stops the server the way SIGTERM does (the developer endpoint).
    pub fn ask_to_stop(&self) {
        self.stop.notify_one();
    }

    /// Resolves once ask_to_stop is called.
    pub async fn stop_asked(&self) {
        self.stop.notified().await
    }

    /// The server is stopping (Railway stops the old server once the new one is up, and DEV_LOGIN's
    /// /api/dev/stop does the same). Everyone hears that the game is being updated, so their browser
    /// freezes the world; a moment later, once inputs already on their way have landed, every
    /// simulation writes everyone's life; then their connections close as a service restart (1012),
    /// and their browsers come back, on the new server, to where they were.
    pub async fn stop_world(&self) {
        self.stage.send_replace(Stage::Updating);
        tokio::time::sleep(Duration::from_millis(200)).await;
        match self.ask(Duration::from_secs(10), |reply| ToDirectory::SaveAll { reply }).await {
            Some(Answer::Written { lives }) => println!("saved {lives} islands"),
            _ => eprintln!("the lives weren't all written in time"),
        }
        self.stage.send_replace(Stage::Closing);
        // A moment for the connections to close properly.
        let deadline = Instant::now() + Duration::from_secs(3);
        while self.count() > 0 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

/// The gate's task: its connections, the ticks to them, the answers to its questions.
async fn run(mut inbox: mpsc::UnboundedReceiver<ToGate>, mut controls: mpsc::UnboundedReceiver<Control>) {
    let mut held: HashMap<(CharacterId, SessionId), Held> = HashMap::new();
    let mut asks: HashMap<u64, oneshot::Sender<Answer>> = HashMap::new();
    loop {
        tokio::select! {
            // A connection opens before it asks anything, so what it's told back finds it.
            biased;
            c = controls.recv() => match c {
                Some(Control::Open { conn, tx }) => {
                    held.insert((conn.character, conn.session), Held { tx, sim: None });
                }
                Some(Control::Close { conn }) => {
                    held.remove(&(conn.character, conn.session));
                }
                Some(Control::Ask { id, reply }) => {
                    asks.insert(id, reply);
                }
                None => return,
            },
            m = inbox.recv() => match m {
                Some(ToGate::Conn { conn, msg }) => {
                    let Some(h) = held.get_mut(&(conn.character, conn.session)) else { continue };
                    match &msg {
                        ToConn::Claimed(c) => h.sim = Some(c.sim),
                        ToConn::Moved { sim, .. } => h.sim = Some(*sim),
                        _ => {}
                    }
                    // A browser that can't keep up misses what it can't take.
                    let _ = h.tx.try_send(Event::Msg(msg));
                }
                Some(ToGate::Tick(out)) => {
                    for ((character, _), h) in &held {
                        if h.sim == Some(out.sim) && out.private_of(*character).is_some() {
                            let _ = h.tx.try_send(Event::Tick(out.clone()));
                        }
                    }
                }
                Some(ToGate::Answer { id, answer }) => {
                    if let Some(tx) = asks.remove(&id) {
                        let _ = tx.send(answer);
                    }
                }
                None => return,
            },
        }
    }
}
