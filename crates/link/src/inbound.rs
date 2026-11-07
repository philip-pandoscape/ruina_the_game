//! A link in: a connection a peer dialled. After the handshake (the peer says who it is, which start
//! of it, and the oldest message it still holds; this node answers with the last it delivered from
//! it), each message is delivered if it's the next in turn, dropped if it was delivered already,
//! and the connection ended if one is missing (the peer will dial again and send from the gap).
//! Acknowledgements go back once everything that has arrived is taken, or every `ack_every`.
//!
//! What a node has delivered from each peer is kept behind a lock that's held while a message is
//! handed on, so two connections from the same peer (an old one not yet noticed dead, and its
//! replacement) can never deliver out of turn or twice.

use std::io;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::net::TcpStream;

use crate::frame::{Frame, FrameReader, VERSION};
use crate::node::{Message, MsgId, Shared};

pub(crate) async fn serve<M: Message>(node: Arc<Shared<M>>, stream: TcpStream) {
    let mut stop = node.stop.subscribe();
    tokio::select! {
        // A connection that fails just ends: the peer dials again.
        _ = session(&node, stream) => {}
        _ = crate::until(&mut stop, |s| *s) => {}
    }
}

async fn session<M: Message>(node: &Shared<M>, stream: TcpStream) -> io::Result<()> {
    stream.set_nodelay(true)?;
    let (r, w) = stream.into_split();
    let mut reader = FrameReader::new(r, node.config.max_frame);
    let mut w = BufWriter::with_capacity(16 << 10, w);
    let Ok(Ok(Some(hello))) = tokio::time::timeout(node.config.handshake, reader.next()).await else {
        return Ok(());
    };
    let Frame::Hello { version, protocol, node: from, incarnation, listen, first_unacked } = hello else {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "no hello"));
    };
    if version != VERSION || protocol != node.protocol {
        let reason = format!("{} speaks {} on links of version {VERSION}; {from} spoke {protocol} on version {version}", node.id, node.protocol);
        w.write_all(&Frame::Refuse { reason }.encode()).await?;
        w.flush().await?;
        return Ok(());
    }
    node.addresses.lock().unwrap().insert(from.clone(), listen);
    let state = node.peer_state(&from);
    let mut delivered = state.lock().await.meet(incarnation, first_unacked);
    let welcome = Frame::Welcome { version: VERSION, node: node.id.clone(), incarnation: node.incarnation, delivered };
    w.write_all(&welcome.encode()).await?;
    w.flush().await?;
    let mut acked = delivered;
    loop {
        let frame = match tokio::time::timeout(node.config.dead_after, reader.next()).await {
            // Nothing for so long (a link pings when it has nothing to say): the peer is gone.
            Err(_) => return Ok(()),
            Ok(r) => match r? {
                Some(f) => f,
                None => return Ok(()),
            },
        };
        let mut answer = false;
        match frame {
            Frame::Msg { seq, request, reply_to, body } => {
                let mut s = state.lock().await;
                if s.incarnation != incarnation {
                    // A newer start of the peer has called since: this connection is stale.
                    return Ok(());
                }
                if seq <= s.delivered {
                    node.counters.duplicates.fetch_add(1, Ordering::Relaxed);
                } else if seq == s.delivered + 1 {
                    node.deliver(&from, MsgId { incarnation, seq }, request, reply_to, &body).await?;
                    s.delivered = seq;
                } else {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, format!("message {seq} from {from} came after {}", s.delivered)));
                }
                delivered = s.delivered;
            }
            Frame::Ping => answer = true,
            other => return Err(io::Error::new(io::ErrorKind::InvalidData, format!("unexpected {other:?}"))),
        }
        if answer || (delivered > acked && (!reader.buffered() || delivered - acked >= node.config.ack_every)) {
            w.write_all(&Frame::Ack { upto: delivered }.encode()).await?;
            w.flush().await?;
            acked = delivered;
        }
    }
}
