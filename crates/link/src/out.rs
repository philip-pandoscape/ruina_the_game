//! A link out: the messages for one peer, numbered and kept until it acknowledges them, and the
//! connection that carries them (dialled, and dialled again, with backoff, for as long as the node
//! runs). Each new connection starts with a handshake that says what the peer has delivered, and
//! sends everything after that again, so nothing is lost across a lost connection and the peer
//! drops anything it already has.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::net::TcpStream;
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::{Notify, oneshot, watch};

use crate::fault::{Fault, FaultState};
use crate::frame::{self, Frame, FrameReader, VERSION};
use crate::node::{Event, Message, MsgId, Shared};

/// Why a message wasn't sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SendError {
    /// The node has stopped.
    Closed,
    /// The link holds as many unacknowledged messages as it may (`try_send`: the window; `push`:
    /// the limit). The peer is slow, or gone.
    Full,
    /// The message is bigger than a frame may be.
    TooBig(usize),
    /// The message couldn't be written.
    Encode(String),
    /// No answer came in time (`request`).
    TimedOut,
    /// An answer to a message that wasn't a request.
    NotAsked,
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SendError::Closed => f.write_str("the node has stopped"),
            SendError::Full => f.write_str("the link is full"),
            SendError::TooBig(n) => write!(f, "a message of {n} bytes is too big for a frame"),
            SendError::Encode(e) => write!(f, "the message couldn't be written: {e}"),
            SendError::TimedOut => f.write_str("no answer in time"),
            SendError::NotAsked => f.write_str("that message wasn't a request"),
        }
    }
}

impl std::error::Error for SendError {}

/// What a link has sent so far.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LinkStats {
    /// Messages queued on it.
    pub sent: u64,
    /// Messages written again on a later connection (or twice, by `Fault::duplicate`).
    pub resent: u64,
    /// Messages the peer has acknowledged.
    pub acked: u64,
    /// Connections made.
    pub connections: u64,
    /// Messages waiting for acknowledgement now.
    pub backlog: usize,
}

struct Queue {
    /// The next message's number (from 1).
    next: u64,
    /// Messages not yet acknowledged, oldest first, as their frames.
    frames: VecDeque<(u64, Bytes)>,
    /// The highest number ever written, to count what's written again.
    written: u64,
}

pub(crate) struct Out {
    pub peer: String,
    addr: Mutex<String>,
    queue: Mutex<Queue>,
    /// A message was queued: the writer has something to write.
    wake: Notify,
    /// Messages were acknowledged: there's room in the window.
    room: Notify,
    /// The address changed: drop the connection and dial the new one.
    redial: Notify,
    pub fault: Arc<watch::Sender<FaultState>>,
    peer_incarnation: Mutex<Option<u64>>,
    connected: AtomicBool,
    sent: AtomicU64,
    resent: AtomicU64,
    acked: AtomicU64,
    connections: AtomicU64,
    /// This node's start, for the ids of what it sends.
    incarnation: u64,
}

impl Out {
    pub fn new(peer: &str, addr: &str, incarnation: u64) -> Out {
        Out {
            peer: peer.to_string(),
            addr: Mutex::new(addr.to_string()),
            queue: Mutex::new(Queue { next: 1, frames: VecDeque::new(), written: 0 }),
            wake: Notify::new(),
            room: Notify::new(),
            redial: Notify::new(),
            fault: Arc::new(watch::channel(FaultState::default()).0),
            peer_incarnation: Mutex::new(None),
            connected: AtomicBool::new(false),
            sent: AtomicU64::new(0),
            resent: AtomicU64::new(0),
            acked: AtomicU64::new(0),
            connections: AtomicU64::new(0),
            incarnation,
        }
    }

    /// Dial `addr` from now on (dropping the connection to the old one).
    pub fn dial(&self, addr: &str) {
        let mut a = self.addr.lock().unwrap();
        if *a != addr {
            *a = addr.to_string();
            self.redial.notify_one();
        }
    }

    /// Queues a message's frame if the link holds fewer than `cap` unacknowledged.
    fn push(&self, body: &[u8], request: u64, reply_to: u64, cap: usize) -> Option<MsgId> {
        let mut q = self.queue.lock().unwrap();
        if q.frames.len() >= cap {
            return None;
        }
        let seq = q.next;
        q.next += 1;
        q.frames.push_back((seq, frame::msg(seq, request, reply_to, body)));
        drop(q);
        self.sent.fetch_add(1, Ordering::Relaxed);
        self.wake.notify_one();
        Some(MsgId { incarnation: self.incarnation, seq })
    }

    /// The peer has delivered everything up to `upto`: those frames go, making room.
    fn acked(&self, upto: u64) {
        let mut q = self.queue.lock().unwrap();
        let mut n = 0;
        while q.frames.front().is_some_and(|(seq, _)| *seq <= upto) {
            q.frames.pop_front();
            n += 1;
        }
        drop(q);
        if n > 0 {
            self.acked.fetch_add(n, Ordering::Relaxed);
            self.room.notify_waiters();
        }
    }

    /// The oldest message still held (or the next to come, when none is).
    fn first_unacked(&self) -> u64 {
        let q = self.queue.lock().unwrap();
        q.frames.front().map_or(q.next, |(seq, _)| *seq)
    }

    /// Frames from number `cursor` on, at most `max`, into `out`; `cursor` moves past them.
    fn take_from(&self, cursor: &mut u64, out: &mut Vec<Bytes>, max: usize) {
        let mut q = self.queue.lock().unwrap();
        let Some(&(front, _)) = q.frames.front() else { return };
        // The numbers held run on without a gap from the front.
        let skip = ((*cursor).max(front) - front) as usize;
        let written = q.written;
        let (mut again, mut last) = (0, None);
        for (seq, f) in q.frames.iter().skip(skip).take(max) {
            out.push(f.clone());
            if *seq <= written {
                again += 1;
            }
            last = Some(*seq);
        }
        if let Some(last) = last {
            *cursor = last + 1;
            q.written = written.max(last);
        }
        if again > 0 {
            self.resent.fetch_add(again, Ordering::Relaxed);
        }
    }

    fn backlog(&self) -> usize {
        self.queue.lock().unwrap().frames.len()
    }
}

/// The way to one peer. Cloned freely; every clone is the same link.
pub struct Link<M> {
    node: Arc<Shared<M>>,
    out: Arc<Out>,
}

impl<M> Clone for Link<M> {
    fn clone(&self) -> Self {
        Link { node: self.node.clone(), out: self.out.clone() }
    }
}

impl<M: Message> Link<M> {
    pub(crate) fn new(node: Arc<Shared<M>>, out: Arc<Out>) -> Link<M> {
        Link { node, out }
    }

    /// The node it goes to.
    pub fn peer(&self) -> &str {
        &self.out.peer
    }

    pub(crate) fn limit(&self) -> usize {
        self.node.config.limit.max(self.node.config.window)
    }

    fn body(&self, msg: &M) -> Result<Vec<u8>, SendError> {
        let body = self.node.config.encoding.encode(msg).map_err(|e| SendError::Encode(e.0))?;
        // The frame round it: length, kind and three numbers at most.
        if body.len() + 40 > self.node.config.max_frame {
            return Err(SendError::TooBig(body.len()));
        }
        Ok(body)
    }

    pub(crate) fn queue(&self, msg: &M, request: u64, reply_to: u64, cap: usize) -> Result<MsgId, SendError> {
        if *self.node.stop.borrow() {
            return Err(SendError::Closed);
        }
        let body = self.body(msg)?;
        self.out.push(&body, request, reply_to, cap).ok_or(SendError::Full)
    }

    /// Sends a message, waiting while the link's window is full (the peer is behind).
    pub async fn send(&self, msg: &M) -> Result<MsgId, SendError> {
        let body = self.body(msg)?;
        self.queue_waiting(&body, 0).await
    }

    async fn queue_waiting(&self, body: &[u8], request: u64) -> Result<MsgId, SendError> {
        let mut stop = self.node.stop.subscribe();
        loop {
            if *stop.borrow() {
                return Err(SendError::Closed);
            }
            let room = self.out.room.notified();
            tokio::pin!(room);
            room.as_mut().enable();
            if let Some(id) = self.out.push(body, request, 0, self.node.config.window) {
                return Ok(id);
            }
            tokio::select! {
                _ = room => {}
                _ = stop.changed() => {}
            }
        }
    }

    /// Sends a message if the window has room: `Full` if not.
    pub fn try_send(&self, msg: &M) -> Result<MsgId, SendError> {
        self.queue(msg, 0, 0, self.node.config.window)
    }

    /// Sends a message without ever waiting (world-api's `Transport::send`): past the window too,
    /// up to `Config::limit`, beyond which the peer is as good as gone and it's `Full`. A sender
    /// that can shed load (a tick's records for a gate that's behind) watches `backlog`.
    pub fn push(&self, msg: &M) -> Result<MsgId, SendError> {
        self.queue(msg, 0, 0, self.limit())
    }

    /// Sends a message and waits up to `wait` for its answer (`Node::reply`).
    pub async fn request(&self, msg: &M, wait: Duration) -> Result<M, SendError> {
        let body = self.body(msg)?;
        let id = self.node.next_request();
        let (tx, rx) = oneshot::channel();
        self.node.pending.lock().unwrap().insert(id, tx);
        // However this ends (answered, timed out, or the caller gave up), nothing is left waiting.
        let _forget = Forget { node: &self.node, id };
        let deadline = tokio::time::Instant::now() + wait;
        tokio::time::timeout_at(deadline, self.queue_waiting(&body, id)).await.map_err(|_| SendError::TimedOut)??;
        match tokio::time::timeout_at(deadline, rx).await {
            Ok(Ok(answer)) => Ok(answer),
            Ok(Err(_)) => Err(SendError::Closed),
            Err(_) => Err(SendError::TimedOut),
        }
    }

    /// Messages sent and not yet acknowledged.
    pub fn backlog(&self) -> usize {
        self.out.backlog()
    }

    /// Whether a connection is up right now.
    pub fn connected(&self) -> bool {
        self.out.connected.load(Ordering::Relaxed)
    }

    /// The peer's start, as its last handshake said.
    pub fn peer_incarnation(&self) -> Option<u64> {
        *self.out.peer_incarnation.lock().unwrap()
    }

    /// What a test can do to this link.
    pub fn fault(&self) -> Fault {
        Fault(self.out.fault.clone())
    }

    pub fn stats(&self) -> LinkStats {
        let o = &self.out;
        LinkStats {
            sent: o.sent.load(Ordering::Relaxed),
            resent: o.resent.load(Ordering::Relaxed),
            acked: o.acked.load(Ordering::Relaxed),
            connections: o.connections.load(Ordering::Relaxed),
            backlog: o.backlog(),
        }
    }
}

struct Forget<'a, M> {
    node: &'a Shared<M>,
    id: u64,
}

impl<M> Drop for Forget<'_, M> {
    fn drop(&mut self) {
        self.node.pending.lock().unwrap().remove(&self.id);
    }
}

/// How a connection ended.
enum Ended {
    Io(String),
    Refused(String),
    Cut,
    Moved,
}

/// Keeps a link's connection up for as long as the node runs: dials, shakes hands, writes and
/// reads acknowledgements until the connection fails, then waits (doubling from the first backoff
/// to the longest, with a little jitter) and dials again.
pub(crate) async fn run<M: Message>(node: Arc<Shared<M>>, out: Arc<Out>) {
    let mut stop = node.stop.subscribe();
    let mut fault = out.fault.subscribe();
    let mut failures: u32 = 0;
    loop {
        if *stop.borrow() {
            return;
        }
        let (held, cuts) = {
            let f = fault.borrow();
            (f.held, f.cuts)
        };
        if held {
            tokio::select! {
                _ = crate::until(&mut fault, |f| !f.held) => {}
                _ = crate::until(&mut stop, |s| *s) => return,
            }
            continue;
        }
        let addr = out.addr.lock().unwrap().clone();
        let began = Instant::now();
        let ended = tokio::select! {
            e = connection(&node, &out, &addr) => e,
            // Cut since this connection began, even if restored already.
            _ = crate::until(&mut fault, |f| f.cuts != cuts) => Ended::Cut,
            _ = out.redial.notified() => Ended::Moved,
            _ = crate::until(&mut stop, |s| *s) => return,
        };
        let was_up = out.connected.swap(false, Ordering::Relaxed);
        let why = match &ended {
            Ended::Io(e) => e.clone(),
            Ended::Refused(e) => e.clone(),
            Ended::Cut => "cut".to_string(),
            Ended::Moved => "moved".to_string(),
        };
        if let Ended::Refused(why) = &ended {
            node.event(Event::Refused { peer: out.peer.clone(), why: why.clone() });
        } else if was_up {
            node.event(Event::Down { peer: out.peer.clone(), why });
        }
        match ended {
            Ended::Cut | Ended::Moved => {
                failures = 0;
                continue;
            }
            // A connection that stayed up a while starts the backoff over.
            _ if was_up && began.elapsed() > Duration::from_secs(2) => failures = 0,
            _ => failures = failures.saturating_add(1),
        }
        let wait = backoff(failures, node.config.backoff, node.incarnation ^ (out.peer.len() as u64));
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = out.redial.notified() => failures = 0,
            _ = crate::until(&mut stop, |s| *s) => return,
        }
    }
}

/// The wait before the n-th dial in a row (from 1): the first backoff doubling to the longest, less
/// up to a quarter at random, so links that failed together don't all dial again together.
fn backoff(n: u32, (first, most): (Duration, Duration), salt: u64) -> Duration {
    if n == 0 {
        return Duration::ZERO;
    }
    let base = first.saturating_mul(1 << (n - 1).min(16)).min(most);
    let mut x = salt ^ u64::from(n).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    x ^= x >> 33;
    x = x.wrapping_mul(0xff51_afd7_ed55_8ccd);
    x ^= x >> 33;
    base - base.mul_f64((x % 1000) as f64 / 4000.0)
}

async fn connection<M: Message>(node: &Shared<M>, out: &Out, addr: &str) -> Ended {
    let handshake = node.config.handshake;
    let stream = match tokio::time::timeout(handshake, TcpStream::connect(addr)).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Ended::Io(format!("couldn't reach {addr}: {e}")),
        Err(_) => return Ended::Io(format!("{addr} didn't answer")),
    };
    let _ = stream.set_nodelay(true);
    let (r, w) = stream.into_split();
    let mut reader = FrameReader::new(r, node.config.max_frame);
    let mut w = BufWriter::with_capacity(64 << 10, w);
    let hello = Frame::Hello {
        version: VERSION,
        protocol: node.protocol.clone(),
        node: node.id.clone(),
        incarnation: node.incarnation,
        listen: node.advertise.clone(),
        first_unacked: out.first_unacked(),
    };
    if let Err(e) = write_now(&mut w, &hello.encode()).await {
        return Ended::Io(e.to_string());
    }
    let (incarnation, delivered) = match tokio::time::timeout(handshake, reader.next()).await {
        Ok(Ok(Some(Frame::Welcome { version: VERSION, node: name, incarnation, delivered }))) => {
            if name != out.peer {
                return Ended::Refused(format!("{addr} answers as {name}, not {}", out.peer));
            }
            (incarnation, delivered)
        }
        Ok(Ok(Some(Frame::Refuse { reason }))) => return Ended::Refused(reason),
        Ok(Ok(Some(other))) => return Ended::Io(format!("an unexpected answer: {other:?}")),
        Ok(Ok(None)) => return Ended::Io("hung up on".into()),
        Ok(Err(e)) => return Ended::Io(e.to_string()),
        Err(_) => return Ended::Io("no answer to hello".into()),
    };
    let was = out.peer_incarnation.lock().unwrap().replace(incarnation);
    if let Some(was) = was.filter(|w| *w != incarnation) {
        node.event(Event::Restarted { peer: out.peer.clone(), was, now: incarnation });
    }
    out.connections.fetch_add(1, Ordering::Relaxed);
    out.connected.store(true, Ordering::Relaxed);
    node.event(Event::Up { peer: out.peer.clone(), incarnation });
    // Everything it has delivered goes, and the rest is written again.
    let lose_acks = out.fault.borrow().lose_acks;
    let mut cursor = if lose_acks {
        0
    } else {
        out.acked(delivered);
        delivered + 1
    };
    tokio::select! {
        e = read_acks(node, out, &mut reader) => e,
        e = write_frames(node, out, &mut w, &mut cursor) => e,
    }
}

async fn write_now(w: &mut BufWriter<OwnedWriteHalf>, bytes: &[u8]) -> std::io::Result<()> {
    w.write_all(bytes).await?;
    w.flush().await
}

/// Writes whatever is queued from `cursor` on, in batches, flushing when the queue is empty; pings
/// when there has been nothing to write for a heartbeat.
async fn write_frames<M>(node: &Shared<M>, out: &Out, w: &mut BufWriter<OwnedWriteHalf>, cursor: &mut u64) -> Ended {
    let ping = frame::ping();
    let mut batch = Vec::with_capacity(256);
    loop {
        out.take_from(cursor, &mut batch, 256);
        if !batch.is_empty() {
            let twice = out.fault.borrow().duplicate;
            for f in batch.drain(..) {
                if let Err(e) = w.write_all(&f).await {
                    return Ended::Io(e.to_string());
                }
                if twice {
                    out.resent.fetch_add(1, Ordering::Relaxed);
                    if let Err(e) = w.write_all(&f).await {
                        return Ended::Io(e.to_string());
                    }
                }
            }
            if let Err(e) = w.flush().await {
                return Ended::Io(e.to_string());
            }
            continue;
        }
        tokio::select! {
            _ = out.wake.notified() => {}
            _ = tokio::time::sleep(node.config.heartbeat) => {
                if let Err(e) = write_now(w, &ping).await {
                    return Ended::Io(e.to_string());
                }
            }
        }
    }
}

/// Takes the peer's acknowledgements as they come. A connection that hears nothing for
/// `dead_after` (it pings when it has nothing to say, and is answered) is given up on.
async fn read_acks<M>(node: &Shared<M>, out: &Out, reader: &mut FrameReader<OwnedReadHalf>) -> Ended {
    loop {
        match tokio::time::timeout(node.config.dead_after, reader.next()).await {
            Err(_) => return Ended::Io(format!("heard nothing for {:?}", node.config.dead_after)),
            Ok(Err(e)) => return Ended::Io(e.to_string()),
            Ok(Ok(None)) => return Ended::Io("hung up".into()),
            Ok(Ok(Some(Frame::Ack { upto }))) => {
                if !out.fault.borrow().lose_acks {
                    out.acked(upto);
                }
            }
            Ok(Ok(Some(other))) => return Ended::Io(format!("unexpected {other:?}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_to_its_longest_with_a_little_jitter() {
        let b = (Duration::from_millis(50), Duration::from_secs(2));
        assert_eq!(backoff(0, b, 1), Duration::ZERO);
        for n in 1..20 {
            let full = Duration::from_millis(50).saturating_mul(1 << (n - 1).min(16)).min(Duration::from_secs(2));
            let w = backoff(n, b, 7);
            assert!(w <= full && w >= full.mul_f64(0.75), "{n}: {w:?} of {full:?}");
        }
    }

    #[test]
    fn frames_are_kept_until_acknowledged_and_counted_when_written_again() {
        let out = Out::new("peer", "127.0.0.1:1", 5);
        for _ in 0..10 {
            out.push(b"x", 0, 0, 100).unwrap();
        }
        assert!(out.push(b"x", 0, 0, 10).is_none(), "full at its cap");
        let mut cursor = 1;
        let mut batch = Vec::new();
        out.take_from(&mut cursor, &mut batch, 4);
        assert_eq!((batch.len(), cursor), (4, 5));
        out.acked(3);
        assert_eq!(out.first_unacked(), 4);
        // A new connection: the peer had delivered 3, so 4 on goes again (4 was written before).
        let mut cursor = 4;
        batch.clear();
        out.take_from(&mut cursor, &mut batch, 100);
        assert_eq!((batch.len(), cursor), (7, 11));
        assert_eq!(out.resent.load(Ordering::Relaxed), 1);
        assert_eq!(out.backlog(), 7);
    }
}
