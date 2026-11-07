//! What the browser sends back after each update it applies: the newest update's number, and which
//! of the 32 before it it applied too. The server's baselines move only on these (crate::viewer).
//!
//!   ack  [8][seq u32][bits u32]   bit i: update seq - 1 - i was applied as well
//!
//! Over a WebSocket every update arrives, in order, unless the server dropped it before it went (a
//! connection that can't keep up); over a datagram transport later, some won't. Either way the
//! browser applies updates only in order, never one older than the newest it has, and says so here.

use crate::bytes::{Bad, Reader, put_u32};

/// The first byte of an acknowledgement (inputs are 7).
pub const ACK: u8 = 8;
/// Its length.
pub const ACK_LEN: usize = 9;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Ack {
    pub seq: u32,
    pub bits: u32,
}

impl Ack {
    pub fn write(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(ACK_LEN);
        out.push(ACK);
        put_u32(&mut out, self.seq);
        put_u32(&mut out, self.bits);
        out
    }

    pub fn read(bytes: &[u8]) -> Result<Ack, Bad> {
        let mut r = Reader::new(bytes);
        if r.u8()? != ACK {
            return Err(Bad::Shape("not an acknowledgement"));
        }
        let ack = Ack { seq: r.u32()?, bits: r.u32()? };
        if !r.done() {
            return Err(Bad::Shape("an acknowledgement with more after it"));
        }
        Ok(ack)
    }

    /// After applying update `seq`, given the acknowledgement before it.
    pub fn after(self, seq: u32) -> Ack {
        if self.seq == 0 {
            return Ack { seq, bits: 0 };
        }
        let gap = seq.wrapping_sub(self.seq);
        // The one before becomes bit gap - 1, and everything it said moves up as far.
        let bits = if gap >= 33 {
            0
        } else if gap == 32 {
            1 << 31
        } else {
            (self.bits << gap) | (1 << (gap - 1))
        };
        Ack { seq, bits }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_acknowledgement_goes_and_comes_back() {
        let a = Ack { seq: 70_000, bits: 0b1011 };
        assert_eq!(Ack::read(&a.write()), Ok(a));
        assert!(Ack::read(&[ACK, 1, 2]).is_err());
        assert!(Ack::read(&[7, 0, 0, 0, 0, 0, 0, 0, 0]).is_err());
    }

    #[test]
    fn it_remembers_which_updates_before_the_newest_were_applied() {
        let a = Ack::default().after(1).after(2).after(4);
        // 4 applied; 3 not (bit 0); 2 (bit 1) and 1 (bit 2) applied.
        assert_eq!(a, Ack { seq: 4, bits: 0b110 });
        assert_eq!(a.after(5).bits, 0b1101);
        assert_eq!(a.after(40).bits, 0, "too long ago to say");
        assert_eq!(Ack { seq: 8, bits: 0 }.after(40).bits, 1 << 31);
    }
}
