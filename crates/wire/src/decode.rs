//! Reading an update as it is on the wire, before anything is applied: the shape src/net/wire/
//! decode.ts reads too, and the tests and benches here read with.
//!
//!   update  [1][seq u32][tick u32]
//!           [removals varint] then a u16 handle each
//!           [intros varint]   then each: u16 handle, u8 kind, and the kind's own (crate::viewer write_intro)
//!           [records varint]  then each: u16 handle, u8 base (tier << 6 | updates back, 0 for none),
//!                             varint mask, a zigzag varint per field in the mask
//!           [events varint]   then each: varint mask, a zigzag varint per field in it

use std::sync::Arc;

use crate::bytes::{Bad, Reader, unzigzag32};
use crate::record::Intro;
use crate::schema::{EVENT, Kind, MAX_FIELDS, Tier};
use crate::viewer::UPDATE;

#[derive(Clone, Debug, PartialEq)]
pub struct Update {
    pub seq: u32,
    pub tick: u32,
    pub removals: Vec<u16>,
    pub intros: Vec<(u16, Intro)>,
    pub records: Vec<Entry>,
    pub events: Vec<[i32; 5]>,
}

/// One record as written: what it's measured against, and the changes.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub handle: u16,
    pub tier: Tier,
    /// How many updates back its baseline is; 0: against zeros.
    pub back: u8,
    pub mask: u64,
    /// The change to each field in the mask, the rest 0.
    pub deltas: [i32; MAX_FIELDS],
}

/// Reads an update. `kind_of` says what kind each handle is (those introduced in this update are
/// known from it), so a record's fields can be counted.
pub fn read(bytes: &[u8], kind_of: impl Fn(u16) -> Option<Kind>) -> Result<Update, Bad> {
    let mut r = Reader::new(bytes);
    if r.u8()? != UPDATE {
        return Err(Bad::Shape("not an update"));
    }
    let seq = r.u32()?;
    let tick = r.u32()?;
    let n = count(&mut r)?;
    let mut removals = Vec::with_capacity(n);
    for _ in 0..n {
        removals.push(r.u16()?);
    }
    let n = count(&mut r)?;
    let mut intros = Vec::with_capacity(n);
    for _ in 0..n {
        let h = r.u16()?;
        let kind = Kind::from_byte(r.u8()?).ok_or(Bad::Shape("an unknown kind"))?;
        intros.push((h, read_intro(&mut r, kind)?));
    }
    let n = count(&mut r)?;
    let mut records = Vec::with_capacity(n);
    for _ in 0..n {
        let handle = r.u16()?;
        let base = r.u8()?;
        let tier = Tier::from_bits(base >> 6).ok_or(Bad::Shape("an unknown tier"))?;
        let kind =
            intros.iter().rev().find(|(h, _)| *h == handle).map(|(_, i)| i.kind()).or_else(|| kind_of(handle)).ok_or(Bad::Shape("a record for nobody"))?;
        let (mask, deltas) = read_fields(&mut r, kind.fields().len())?;
        records.push(Entry { handle, tier, back: base & 63, mask, deltas });
    }
    let n = count(&mut r)?;
    let mut events = Vec::with_capacity(n);
    for _ in 0..n {
        let (_, f) = read_fields(&mut r, EVENT.len())?;
        let mut e = [0; 5];
        e.copy_from_slice(&f[..5]);
        events.push(e);
    }
    if !r.done() {
        return Err(Bad::Shape("an update with more after it"));
    }
    Ok(Update { seq, tick, removals, intros, records, events })
}

fn count(r: &mut Reader<'_>) -> Result<usize, Bad> {
    let n = r.varint()?;
    // Nothing holds more than there are handles.
    if n > 1 << 16 {
        return Err(Bad::Shape("a count past the handles"));
    }
    Ok(n as usize)
}

fn read_fields(r: &mut Reader<'_>, n: usize) -> Result<(u64, [i32; MAX_FIELDS]), Bad> {
    let mask = r.varint()?;
    if n < 64 && mask >> n != 0 {
        return Err(Bad::Shape("a mask past the kind's fields"));
    }
    let mut deltas = [0; MAX_FIELDS];
    for (i, d) in deltas.iter_mut().enumerate().take(n) {
        if mask & (1 << i) != 0 {
            *d = unzigzag32(r.varint32()?);
        }
    }
    Ok((mask, deltas))
}

fn read_intro(r: &mut Reader<'_>, kind: Kind) -> Result<Intro, Bad> {
    Ok(match kind {
        Kind::Player => {
            let id = r.zigzag()?;
            let bot = r.u8()? & 1 != 0;
            let len = r.varint()? as usize;
            let name = std::str::from_utf8(r.bytes(len)?).map_err(|_| Bad::Shape("a name that isn't UTF-8"))?;
            Intro::Player { id, name: Arc::from(name), bot }
        }
        Kind::Creature => Intro::Creature { id: r.zigzag()? },
        Kind::Arrow => Intro::Arrow { id: r.zigzag()? },
        Kind::Meteor => Intro::Meteor { id: r.zigzag()? },
        Kind::Vehicle | Kind::Item => {
            let owner = r.zigzag()?;
            let id = r.zigzag()?;
            let def = u32::try_from(r.varint()?).map_err(|_| Bad::Shape("a place past the lists"))?;
            if kind == Kind::Vehicle { Intro::Vehicle { owner, id, def } } else { Intro::Item { owner, id, def } }
        }
    })
}
