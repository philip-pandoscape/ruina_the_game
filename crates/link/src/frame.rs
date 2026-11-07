//! The frames on a link's TCP connection.
//!
//! Each frame is its length (u32, little-endian: the bytes after the length), its kind (a byte),
//! then what that kind carries. Fixed-size numbers are little-endian; a message's number and its
//! request ids are LEB128 varints, as they're mostly small; strings are a u16 length and UTF-8.
//!
//! | Kind | Frame | Carries |
//! |---|---|---|
//! | 1 | Hello | the dialler's first: link version, its start (incarnation), the oldest message it still holds unacknowledged, its protocol, its node id and where it takes messages itself |
//! | 2 | Welcome | the answer: link version, the listener's start, the last message it delivered from the dialler, its node id |
//! | 3 | Msg | its number on the link, a request id (flag 0x10) or the id of the request it answers (flag 0x20), then the body |
//! | 4 | Ack | every message up to this number has been delivered |
//! | 5 | Ping | nothing: the dialler is still there, and wants an Ack back |
//! | 6 | Refuse | why the listener won't take the link (another protocol or version) |

use std::io;

use bytes::{Buf, BufMut, Bytes, BytesMut};
use tokio::io::{AsyncRead, AsyncReadExt};

/// The link protocol's version. A dialler speaking another is refused.
pub const VERSION: u16 = 1;

const HELLO: u8 = 1;
const WELCOME: u8 = 2;
const MSG: u8 = 3;
const ACK: u8 = 4;
const PING: u8 = 5;
const REFUSE: u8 = 6;
/// Flags in a message's kind byte: it carries a request id, or the id of the request it answers.
const HAS_REQUEST: u8 = 0x10;
const HAS_REPLY: u8 = 0x20;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Frame {
    Hello {
        version: u16,
        protocol: String,
        node: String,
        incarnation: u64,
        listen: String,
        first_unacked: u64,
    },
    Welcome {
        version: u16,
        node: String,
        incarnation: u64,
        delivered: u64,
    },
    /// `request`: non-zero when the sender waits for an answer; `reply_to`: non-zero when this is
    /// one. `body`: the message, as the node's encoding wrote it.
    Msg {
        seq: u64,
        request: u64,
        reply_to: u64,
        body: Bytes,
    },
    Ack {
        upto: u64,
    },
    Ping,
    Refuse {
        reason: String,
    },
}

impl Frame {
    /// The frame as it goes on the wire, its length first.
    pub fn encode(&self) -> Bytes {
        let mut b = BytesMut::with_capacity(64);
        b.put_u32_le(0);
        match self {
            Frame::Hello { version, protocol, node, incarnation, listen, first_unacked } => {
                b.put_u8(HELLO);
                b.put_u16_le(*version);
                b.put_u64_le(*incarnation);
                b.put_u64_le(*first_unacked);
                put_str(&mut b, protocol);
                put_str(&mut b, node);
                put_str(&mut b, listen);
            }
            Frame::Welcome { version, node, incarnation, delivered } => {
                b.put_u8(WELCOME);
                b.put_u16_le(*version);
                b.put_u64_le(*incarnation);
                b.put_u64_le(*delivered);
                put_str(&mut b, node);
            }
            Frame::Msg { seq, request, reply_to, body } => return msg(*seq, *request, *reply_to, body),
            Frame::Ack { upto } => {
                b.put_u8(ACK);
                b.put_u64_le(*upto);
            }
            Frame::Ping => b.put_u8(PING),
            Frame::Refuse { reason } => {
                b.put_u8(REFUSE);
                b.put_slice(reason.as_bytes());
            }
        }
        finish(b)
    }
}

/// A message's frame, ready to write, and to write again after a lost connection.
pub fn msg(seq: u64, request: u64, reply_to: u64, body: &[u8]) -> Bytes {
    let mut b = BytesMut::with_capacity(4 + 1 + 3 * 10 + body.len());
    b.put_u32_le(0);
    let mut kind = MSG;
    if request != 0 {
        kind |= HAS_REQUEST;
    }
    if reply_to != 0 {
        kind |= HAS_REPLY;
    }
    b.put_u8(kind);
    put_varint(&mut b, seq);
    if request != 0 {
        put_varint(&mut b, request);
    }
    if reply_to != 0 {
        put_varint(&mut b, reply_to);
    }
    b.put_slice(body);
    finish(b)
}

/// A ping, the same bytes every time.
pub fn ping() -> Bytes {
    Frame::Ping.encode()
}

fn finish(mut b: BytesMut) -> Bytes {
    let len = (b.len() - 4) as u32;
    b[..4].copy_from_slice(&len.to_le_bytes());
    b.freeze()
}

fn put_str(b: &mut BytesMut, s: &str) {
    // Node ids, addresses and protocol names: short. Anything longer is cut at a character's edge.
    let mut end = s.len().min(u16::MAX as usize);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    b.put_u16_le(end as u16);
    b.put_slice(&s.as_bytes()[..end]);
}

fn put_varint(b: &mut BytesMut, mut v: u64) {
    loop {
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            b.put_u8(byte);
            return;
        }
        b.put_u8(byte | 0x80);
    }
}

fn bad(what: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("a bad frame: {}", what.into()))
}

fn need(f: &Bytes, n: usize) -> io::Result<()> {
    if f.remaining() < n { Err(bad("too short")) } else { Ok(()) }
}

fn get_str(f: &mut Bytes) -> io::Result<String> {
    need(f, 2)?;
    let len = f.get_u16_le() as usize;
    need(f, len)?;
    String::from_utf8(f.split_to(len).to_vec()).map_err(|_| bad("not UTF-8"))
}

fn get_varint(f: &mut Bytes) -> io::Result<u64> {
    let mut v = 0u64;
    for shift in (0..64).step_by(7) {
        need(f, 1)?;
        let byte = f.get_u8();
        v |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(v);
        }
    }
    Err(bad("a number too long"))
}

/// A frame from its kind and what it carries (the length already taken off).
pub fn decode(mut f: Bytes) -> io::Result<Frame> {
    need(&f, 1)?;
    let kind = f.get_u8();
    if kind & 0x0f == MSG && kind & !(0x0f | HAS_REQUEST | HAS_REPLY) == 0 {
        let seq = get_varint(&mut f)?;
        let request = if kind & HAS_REQUEST != 0 { get_varint(&mut f)? } else { 0 };
        let reply_to = if kind & HAS_REPLY != 0 { get_varint(&mut f)? } else { 0 };
        return Ok(Frame::Msg { seq, request, reply_to, body: f });
    }
    match kind {
        HELLO => {
            need(&f, 18)?;
            let version = f.get_u16_le();
            let incarnation = f.get_u64_le();
            let first_unacked = f.get_u64_le();
            let protocol = get_str(&mut f)?;
            let node = get_str(&mut f)?;
            let listen = get_str(&mut f)?;
            Ok(Frame::Hello { version, protocol, node, incarnation, listen, first_unacked })
        }
        WELCOME => {
            need(&f, 18)?;
            let version = f.get_u16_le();
            let incarnation = f.get_u64_le();
            let delivered = f.get_u64_le();
            let node = get_str(&mut f)?;
            Ok(Frame::Welcome { version, node, incarnation, delivered })
        }
        ACK => {
            need(&f, 8)?;
            Ok(Frame::Ack { upto: f.get_u64_le() })
        }
        PING => Ok(Frame::Ping),
        REFUSE => Ok(Frame::Refuse { reason: String::from_utf8_lossy(&f).into_owned() }),
        k => Err(bad(format!("kind {k}"))),
    }
}

/// Reads frames off a connection into one buffer, handing each on as a slice of it.
pub struct FrameReader<R> {
    r: R,
    buf: BytesMut,
    max: usize,
}

impl<R: AsyncRead + Unpin> FrameReader<R> {
    pub fn new(r: R, max: usize) -> Self {
        FrameReader { r, buf: BytesMut::with_capacity(64 << 10), max }
    }

    /// The next frame; None when the other end closed the connection between frames. Safe to
    /// cancel (in a `select!`): what was read waits in the buffer for the next call.
    pub async fn next(&mut self) -> io::Result<Option<Frame>> {
        loop {
            if let Some(frame) = self.parse()? {
                return Ok(Some(frame));
            }
            if self.buf.capacity() - self.buf.len() < 8 << 10 {
                self.buf.reserve(64 << 10);
            }
            if self.r.read_buf(&mut self.buf).await? == 0 {
                return if self.buf.is_empty() { Ok(None) } else { Err(io::ErrorKind::UnexpectedEof.into()) };
            }
        }
    }

    fn parse(&mut self) -> io::Result<Option<Frame>> {
        if self.buf.len() < 4 {
            return Ok(None);
        }
        let len = u32::from_le_bytes(self.buf[..4].try_into().expect("four bytes")) as usize;
        if len == 0 || len > self.max {
            return Err(bad(format!("{len} bytes long (at most {})", self.max)));
        }
        if self.buf.len() < 4 + len {
            self.buf.reserve(4 + len - self.buf.len());
            return Ok(None);
        }
        self.buf.advance(4);
        decode(self.buf.split_to(len).freeze()).map(Some)
    }

    /// Whether more has arrived than has been taken: a receiver acknowledges once it has taken
    /// everything there was, so a busy link acknowledges in batches and a quiet one at once.
    pub fn buffered(&self) -> bool {
        !self.buf.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round(f: Frame) {
        let bytes = f.encode();
        let len = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
        assert_eq!(len, bytes.len() - 4);
        assert_eq!(decode(bytes.slice(4..)).unwrap(), f);
    }

    #[test]
    fn every_frame_reads_back_as_it_was_written() {
        round(Frame::Hello {
            version: VERSION,
            protocol: "world/1+msgpack".into(),
            node: "sim-1".into(),
            incarnation: u64::MAX,
            listen: "[::1]:9101".into(),
            first_unacked: 1,
        });
        round(Frame::Welcome { version: VERSION, node: "gate-α".into(), incarnation: 7, delivered: 0 });
        for (seq, request, reply_to) in [(1, 0, 0), (127, 0, 0), (128, 5, 0), (u64::MAX, 0, u64::MAX), (300, 1 << 40, 3)] {
            round(Frame::Msg { seq, request, reply_to, body: Bytes::from_static(b"\x01\x02body") });
        }
        round(Frame::Msg { seq: 9, request: 0, reply_to: 0, body: Bytes::new() });
        round(Frame::Ack { upto: 1 << 50 });
        round(Frame::Ping);
        round(Frame::Refuse { reason: "another protocol".into() });
    }

    #[test]
    fn a_small_message_costs_a_few_bytes_round_its_body() {
        // Length, kind and a one-byte number: 6 bytes round a body.
        assert_eq!(msg(5, 0, 0, b"abc").len(), 4 + 1 + 1 + 3);
        assert_eq!(msg(300, 0, 0, b"").len(), 4 + 1 + 2);
    }

    #[test]
    fn nonsense_is_refused() {
        assert!(decode(Bytes::from_static(&[9])).is_err());
        assert!(decode(Bytes::from_static(&[HELLO, 1])).is_err());
        assert!(decode(Bytes::from_static(&[MSG, 0x80])).is_err(), "a number cut short");
        assert!(decode(Bytes::from_static(&[MSG | 0x40, 1])).is_err(), "an unknown flag");
        assert!(decode(Bytes::from_static(&[MSG, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01])).is_err(), "a number too long");
    }

    #[tokio::test]
    async fn frames_are_read_off_a_stream_whatever_its_pieces() {
        let frames: Vec<Frame> =
            (1..=50u64).map(|n| Frame::Msg { seq: n, request: 0, reply_to: 0, body: Bytes::from(vec![n as u8; n as usize * 7]) }).collect();
        let mut all = Vec::new();
        for f in &frames {
            all.extend_from_slice(&f.encode());
        }
        // Delivered a few bytes at a time.
        let (mut a, b) = tokio::io::duplex(13);
        let writer = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            for chunk in all.chunks(5) {
                a.write_all(chunk).await.unwrap();
            }
        });
        let mut r = FrameReader::new(b, 1 << 20);
        for f in &frames {
            assert_eq!(r.next().await.unwrap().as_ref(), Some(f));
        }
        writer.await.unwrap();
        assert_eq!(r.next().await.unwrap(), None, "closed between frames");
    }

    #[tokio::test]
    async fn a_frame_past_the_limit_is_refused() {
        let (mut a, b) = tokio::io::duplex(1024);
        use tokio::io::AsyncWriteExt;
        a.write_all(&msg(1, 0, 0, &[0; 100])).await.unwrap();
        let mut r = FrameReader::new(b, 50);
        assert!(r.next().await.is_err());
    }
}
