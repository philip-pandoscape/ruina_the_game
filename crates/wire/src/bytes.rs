//! The wire's small numbers: little-endian fixed widths, and varints (LEB128: seven bits a byte, the
//! high bit set while more follow), signed ones zigzagged first so a small negative is small too.
//! src/net/wire/bytes.ts reads them the same way.

/// A signed 64-bit number folded so small magnitudes are small: 0, -1, 1, -2, 2 ... become 0, 1, 2, 3, 4.
pub fn zigzag(v: i64) -> u64 {
    ((v << 1) ^ (v >> 63)) as u64
}

pub fn unzigzag(u: u64) -> i64 {
    ((u >> 1) as i64) ^ -((u & 1) as i64)
}

/// The same for a 32-bit difference between two field values.
pub fn zigzag32(v: i32) -> u32 {
    ((v << 1) ^ (v >> 31)) as u32
}

pub fn unzigzag32(u: u32) -> i32 {
    ((u >> 1) as i32) ^ -((u & 1) as i32)
}

pub fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

/// How many bytes `put_varint` writes for `v`.
pub fn varint_len(v: u64) -> usize {
    let bits = 64 - v.leading_zeros() as usize;
    bits.div_ceil(7).max(1)
}

pub fn put_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

/// What went wrong reading a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Bad {
    /// It ended in the middle of something.
    Short,
    /// A varint ran past ten bytes, or a 32-bit one past five.
    Varint,
    /// It isn't the message it was read as, or holds something no message holds.
    Shape(&'static str),
}

/// Reads a message front to back.
pub struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Reader { bytes, at: 0 }
    }

    pub fn done(&self) -> bool {
        self.at >= self.bytes.len()
    }

    pub fn u8(&mut self) -> Result<u8, Bad> {
        let b = *self.bytes.get(self.at).ok_or(Bad::Short)?;
        self.at += 1;
        Ok(b)
    }

    pub fn u16(&mut self) -> Result<u16, Bad> {
        let b = self.bytes.get(self.at..self.at + 2).ok_or(Bad::Short)?;
        self.at += 2;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    pub fn u32(&mut self) -> Result<u32, Bad> {
        let b = self.bytes.get(self.at..self.at + 4).ok_or(Bad::Short)?;
        self.at += 4;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn varint(&mut self) -> Result<u64, Bad> {
        let mut v = 0u64;
        for k in 0..10 {
            let b = self.u8()?;
            v |= u64::from(b & 0x7f) << (7 * k);
            if b < 0x80 {
                return Ok(v);
            }
        }
        Err(Bad::Varint)
    }

    /// A varint that must fit in 32 bits (a field's difference).
    pub fn varint32(&mut self) -> Result<u32, Bad> {
        let v = self.varint()?;
        u32::try_from(v).map_err(|_| Bad::Varint)
    }

    pub fn zigzag(&mut self) -> Result<i64, Bad> {
        Ok(unzigzag(self.varint()?))
    }

    pub fn bytes(&mut self, n: usize) -> Result<&'a [u8], Bad> {
        let b = self.bytes.get(self.at..self.at + n).ok_or(Bad::Short)?;
        self.at += n;
        Ok(b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varints_and_zigzags_come_back_as_they_went() {
        for v in [0u64, 1, 127, 128, 300, 16_383, 16_384, u64::from(u32::MAX), u64::MAX] {
            let mut out = Vec::new();
            put_varint(&mut out, v);
            assert_eq!(out.len(), varint_len(v), "{v}");
            assert_eq!(Reader::new(&out).varint(), Ok(v));
        }
        for v in [0i64, -1, 1, -64, 64, i64::from(i32::MIN), i64::MAX, i64::MIN] {
            assert_eq!(unzigzag(zigzag(v)), v);
        }
        for v in [0i32, -1, 1, 1000, -1000, i32::MAX, i32::MIN] {
            assert_eq!(unzigzag32(zigzag32(v)), v);
        }
        // Small either way round is small on the wire.
        assert_eq!((zigzag(-1), zigzag(1), zigzag32(-2)), (1, 2, 3));
        // Cut short, or a varint that never ends.
        assert_eq!(Reader::new(&[0x80]).varint(), Err(Bad::Short));
        assert_eq!(Reader::new(&[0xff; 11]).varint(), Err(Bad::Varint));
        assert_eq!(Reader::new(&[0xff, 0xff, 0xff, 0xff, 0x7f]).varint32(), Err(Bad::Varint));
    }
}
