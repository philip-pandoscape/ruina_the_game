//! What a sim publishes each tick: every entity's record, packed once, in the 32 m cell it stands
//! in, and what happened there (effects others see). The gate reads the cells around each
//! connection's player and writes that connection's update from them (crate::viewer), so nothing
//! is packed twice however many are looking.
//!
//! A tick's cells are Serialize and Deserialize: they go from a sim to the gates (crates/world-api's
//! tick out), in one process as they are and between processes in whatever form the transport
//! writes. A record's fields are written only as far as its last that isn't zero.

use std::sync::Arc;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::bytes::{Bad, Reader, put_varint, unzigzag32, zigzag, zigzag32};
use crate::fast::FxMap;
use crate::schema::{EVENT, Fields, Kind, MAX_FIELDS};

/// Interest cells are this many metres square (the world's words: a cell is 32 m).
pub const CELL: f64 = 32.0;

/// A 32 m cell: floor(x / 32), floor(z / 32).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Cell {
    pub x: i32,
    pub z: i32,
}

impl Cell {
    /// The cell a point (metres) is in.
    pub fn at(x: f64, z: f64) -> Cell {
        Cell { x: (x / CELL).floor() as i32, z: (z / CELL).floor() as i32 }
    }

    /// The cell a record's first two fields (centimetres) put it in.
    pub fn of(fields: &Fields) -> Cell {
        Cell::at(f64::from(fields[0]) / 100.0, f64::from(fields[1]) / 100.0)
    }
}

/// What a browser is told once, the first time it's sent something, beside its handle: which of the
/// game's things it is, and what never changes about it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Intro {
    /// A player or a bot, by their character's id (a bot's is negative), and their name.
    Player {
        id: i64,
        name: Arc<str>,
        bot: bool,
    },
    /// A creature, by its id among its game's creatures.
    Creature {
        id: i64,
    },
    /// A vehicle: whose it is, its id on their life, and its place in the vehicles' and mounts' list.
    Vehicle {
        owner: i64,
        id: i64,
        def: u32,
    },
    /// A pack on the ground: whose it is, its id on their life, and its place in the packs' list.
    Item {
        owner: i64,
        id: i64,
        def: u32,
    },
    /// An arrow or a meteor, by its id in its game.
    Arrow {
        id: i64,
    },
    Meteor {
        id: i64,
    },
}

impl Intro {
    /// What the kind says of itself, as an introduction carries it after its handle and kind byte
    /// (crate::decode has the whole of an update's layout).
    pub fn write(&self, out: &mut Vec<u8>) {
        match self {
            Intro::Player { id, name, bot } => {
                put_varint(out, zigzag(*id));
                out.push(u8::from(*bot));
                let name = name.as_bytes();
                let name = &name[..name.len().min(255)];
                put_varint(out, name.len() as u64);
                out.extend_from_slice(name);
            }
            Intro::Creature { id } | Intro::Arrow { id } | Intro::Meteor { id } => put_varint(out, zigzag(*id)),
            Intro::Vehicle { owner, id, def } | Intro::Item { owner, id, def } => {
                put_varint(out, zigzag(*owner));
                put_varint(out, zigzag(*id));
                put_varint(out, u64::from(*def));
            }
        }
    }

    /// Reads what [`Intro::write`] wrote for a `kind`.
    pub fn read(r: &mut Reader<'_>, kind: Kind) -> Result<Intro, Bad> {
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

    pub fn kind(&self) -> Kind {
        match self {
            Intro::Player { .. } => Kind::Player,
            Intro::Creature { .. } => Kind::Creature,
            Intro::Vehicle { .. } => Kind::Vehicle,
            Intro::Item { .. } => Kind::Item,
            Intro::Arrow { .. } => Kind::Arrow,
            Intro::Meteor { .. } => Kind::Meteor,
        }
    }
}

/// One entity as its sim packed it this tick.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Record {
    /// Who it is in the whole world (the server's EntityId, its whole word), never sent: each
    /// connection knows it by a handle of its own.
    pub key: u64,
    /// Whose it is (a player's own key; a vehicle's or a pack's owner's; an arrow's shooter's), or 0.
    /// A connection isn't sent its own player, vehicles or packs: those come with its own state.
    pub owner: u64,
    pub intro: Intro,
    /// The kind's fields (crate::schema), the rest zero.
    #[serde(with = "trimmed")]
    pub fields: Fields,
    /// The entity the kind's reference field names (crate::schema::reference), by key, or 0 for none:
    /// each connection is sent it as its own handle for that entity.
    pub refers: u64,
}

impl Record {
    pub fn kind(&self) -> Kind {
        self.intro.kind()
    }

    /// Where it stands, in metres (x, z).
    pub fn at(&self) -> (f64, f64) {
        (f64::from(self.fields[0]) / 100.0, f64::from(self.fields[1]) / 100.0)
    }
}

/// A record's fields as far as the last that isn't zero, and back.
mod trimmed {
    use super::*;

    pub fn serialize<S: Serializer>(f: &Fields, s: S) -> Result<S::Ok, S::Error> {
        let n = f.iter().rposition(|v| *v != 0).map_or(0, |i| i + 1);
        f[..n].serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Fields, D::Error> {
        let list = Vec::<i32>::deserialize(d)?;
        if list.len() > MAX_FIELDS {
            return Err(serde::de::Error::custom("more fields than any kind has"));
        }
        let mut f = [0; MAX_FIELDS];
        f[..list.len()].copy_from_slice(&list);
        Ok(f)
    }
}

/// Something that happened, for effects (crate::schema::EVENT): where, what (the engine's effect
/// kind, with what caused it above its low four bits), and its size.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    pub fields: [i32; 5],
}

impl Event {
    /// x, y and z in centimetres.
    pub fn new(x: i32, y: i32, z: i32, kind: i32, size: i32) -> Event {
        Event { fields: [x, z, y, kind, size] }
    }

    pub fn at(&self) -> (f64, f64) {
        (f64::from(self.fields[0]) / 100.0, f64::from(self.fields[1]) / 100.0)
    }

    /// As a record's fields, for the codec.
    pub fn as_fields(&self) -> Fields {
        let mut f = [0; MAX_FIELDS];
        f[..EVENT.len()].copy_from_slice(&self.fields);
        f
    }
}

/// One cell's share of a tick: what a sim hands the gates for it. It crosses between processes as
/// one run of bytes ([`CellRecords::pack`]: serialized as bytes, so MessagePack, say, writes it as a
/// single blob), the records as compact as an update writes them whole.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CellRecords {
    pub cell: Cell,
    pub records: Vec<Record>,
    pub events: Vec<Event>,
}

/// Fields as a whole record writes them: the mask of those that aren't zero, then each as a zigzag
/// varint.
fn put_fields(out: &mut Vec<u8>, f: &[i32]) {
    let mask = f.iter().enumerate().fold(0u64, |m, (i, v)| if *v != 0 { m | 1 << i } else { m });
    put_varint(out, mask);
    for v in f.iter().filter(|v| **v != 0) {
        put_varint(out, u64::from(zigzag32(*v)));
    }
}

fn read_fields(r: &mut Reader<'_>, f: &mut [i32]) -> Result<(), Bad> {
    let mask = r.varint()?;
    if f.len() < 64 && mask >> f.len() != 0 {
        return Err(Bad::Shape("a mask past the fields"));
    }
    for (i, v) in f.iter_mut().enumerate() {
        if mask & (1 << i) != 0 {
            *v = unzigzag32(r.varint32()?);
        }
    }
    Ok(())
}

impl CellRecords {
    /// The cell as bytes: where it is (zigzag varints), its records (each its key, owner and what it
    /// names as varints, its kind's byte and introduction, its fields whole) and its effects (fields
    /// whole), each list after its count.
    pub fn pack(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(8 + self.records.len() * 32 + self.events.len() * 12);
        put_varint(&mut out, zigzag(i64::from(self.cell.x)));
        put_varint(&mut out, zigzag(i64::from(self.cell.z)));
        put_varint(&mut out, self.records.len() as u64);
        for r in &self.records {
            put_varint(&mut out, r.key);
            put_varint(&mut out, r.owner);
            put_varint(&mut out, r.refers);
            out.push(r.kind() as u8);
            r.intro.write(&mut out);
            put_fields(&mut out, &r.fields[..r.kind().fields().len()]);
        }
        put_varint(&mut out, self.events.len() as u64);
        for e in &self.events {
            put_fields(&mut out, &e.fields);
        }
        out
    }

    /// Reads what [`CellRecords::pack`] wrote.
    pub fn unpack(bytes: &[u8]) -> Result<CellRecords, Bad> {
        let mut r = Reader::new(bytes);
        let coord = |r: &mut Reader<'_>| i32::try_from(r.zigzag()?).map_err(|_| Bad::Shape("a cell past the world"));
        let cell = Cell { x: coord(&mut r)?, z: coord(&mut r)? };
        let n = r.varint()?;
        let mut records = Vec::with_capacity(n.min(1 << 16) as usize);
        for _ in 0..n {
            let key = r.varint()?;
            let owner = r.varint()?;
            let refers = r.varint()?;
            let kind = Kind::from_byte(r.u8()?).ok_or(Bad::Shape("an unknown kind"))?;
            let intro = Intro::read(&mut r, kind)?;
            let mut fields = [0; MAX_FIELDS];
            read_fields(&mut r, &mut fields[..kind.fields().len()])?;
            records.push(Record { key, owner, intro, fields, refers });
        }
        let n = r.varint()?;
        let mut events = Vec::with_capacity(n.min(1 << 16) as usize);
        for _ in 0..n {
            let mut fields = [0; 5];
            read_fields(&mut r, &mut fields)?;
            events.push(Event { fields });
        }
        if !r.done() {
            return Err(Bad::Shape("a cell with more after it"));
        }
        Ok(CellRecords { cell, records, events })
    }
}

impl Serialize for CellRecords {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bytes(&self.pack())
    }
}

impl<'de> Deserialize<'de> for CellRecords {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<CellRecords, D::Error> {
        struct Blob;
        impl<'de> serde::de::Visitor<'de> for Blob {
            type Value = CellRecords;

            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a cell's records, packed")
            }

            fn visit_bytes<E: serde::de::Error>(self, v: &[u8]) -> Result<CellRecords, E> {
                CellRecords::unpack(v).map_err(|e| E::custom(format!("{e:?}")))
            }

            // A format with no bytes of its own (JSON) writes them as a list of numbers.
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<CellRecords, A::Error> {
                let mut v = Vec::with_capacity(seq.size_hint().unwrap_or(0));
                while let Some(b) = seq.next_element::<u8>()? {
                    v.push(b);
                }
                self.visit_bytes(&v)
            }
        }
        d.deserialize_bytes(Blob)
    }
}

/// Everything a gate knows of one tick, by cell: what one sim published, or several put together
/// (the cells either side of a border). Serialized as its tick and its cells.
#[derive(Clone, Debug, Default)]
pub struct Frame {
    /// The world's tick (crates/server's clock), whose low 32 bits each update carries.
    pub tick: u64,
    cells: Vec<CellRecords>,
    index: FxMap<Cell, usize>,
    count: usize,
}

impl Frame {
    pub fn new(tick: u64) -> Self {
        Frame { tick, cells: Vec::new(), index: FxMap::default(), count: 0 }
    }

    /// A tick's cells as a sim published them (crates/world-api's tick out).
    pub fn from_cells(tick: u64, cells: Vec<CellRecords>) -> Self {
        let mut f = Frame::new(tick);
        f.add_cells(cells);
        f
    }

    /// Another sim's cells for the same tick, put with these (a cell both hold is joined).
    pub fn add_cells(&mut self, cells: Vec<CellRecords>) {
        for c in cells {
            self.count += c.records.len();
            match self.index.get(&c.cell) {
                Some(&i) => {
                    let mine = &mut self.cells[i];
                    mine.records.extend(c.records);
                    mine.events.extend(c.events);
                }
                None => {
                    self.index.insert(c.cell, self.cells.len());
                    self.cells.push(c);
                }
            }
        }
    }

    /// The cells, to hand on.
    pub fn into_cells(self) -> Vec<CellRecords> {
        self.cells
    }

    pub fn cells(&self) -> &[CellRecords] {
        &self.cells
    }

    fn cell_mut(&mut self, c: Cell) -> &mut CellRecords {
        let i = *self.index.entry(c).or_insert_with(|| {
            self.cells.push(CellRecords { cell: c, ..CellRecords::default() });
            self.cells.len() - 1
        });
        &mut self.cells[i]
    }

    /// Adds a record to the cell it stands in.
    pub fn push(&mut self, r: Record) {
        self.count += 1;
        self.cell_mut(Cell::of(&r.fields)).records.push(r);
    }

    /// Adds something that happened, in the cell it happened in.
    pub fn event(&mut self, e: Event) {
        let (x, z) = e.at();
        self.cell_mut(Cell::at(x, z)).events.push(e);
    }

    pub fn cell(&self, c: Cell) -> Option<&CellRecords> {
        self.index.get(&c).map(|&i| &self.cells[i])
    }

    /// Where a cell is in [`Frame::cells`], if it holds anything.
    pub fn cell_index(&self, c: Cell) -> Option<usize> {
        self.index.get(&c).copied()
    }

    /// How many records it holds.
    pub fn len(&self) -> usize {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// Every record, cell by cell.
    pub fn records(&self) -> impl Iterator<Item = &Record> {
        self.cells.iter().flat_map(|c| c.records.iter())
    }
}

#[derive(Serialize, Deserialize)]
struct FrameOnTheWay {
    tick: u64,
    cells: Vec<CellRecords>,
}

impl Serialize for Frame {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Borrowed<'a> {
            tick: u64,
            cells: &'a [CellRecords],
        }
        Borrowed { tick: self.tick, cells: &self.cells }.serialize(s)
    }
}

impl<'de> Deserialize<'de> for Frame {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Frame, D::Error> {
        let f = FrameOnTheWay::deserialize(d)?;
        Ok(Frame::from_cells(f.tick, f.cells))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creature(id: i64, x: i32, z: i32) -> Record {
        let mut fields = [0; MAX_FIELDS];
        fields[0] = x;
        fields[1] = z;
        Record { key: 1 + id as u64, owner: 0, intro: Intro::Creature { id }, fields, refers: 0 }
    }

    #[test]
    fn records_go_in_the_cell_they_stand_in() {
        assert_eq!(Cell::at(0.0, 31.9), Cell { x: 0, z: 0 });
        assert_eq!(Cell::at(-0.1, 32.0), Cell { x: -1, z: 1 });
        let mut frame = Frame::new(9);
        frame.push(creature(4, -6400, 3300));
        frame.event(Event::new(100, 0, 100, 2, 30));
        assert_eq!(frame.cell(Cell { x: -2, z: 1 }).map(|c| c.records.len()), Some(1));
        assert_eq!(frame.cell(Cell { x: 0, z: 0 }).map(|c| c.events.len()), Some(1));
        assert_eq!(frame.len(), 1);
    }

    #[test]
    fn a_tick_s_cells_cross_as_they_are_and_join_another_sim_s() {
        let mut frame = Frame::new(77);
        frame.push(creature(1, 100, 100));
        // A player's fields, the rest zero.
        let mut fields = [0; MAX_FIELDS];
        fields[..crate::schema::PLAYER.len()].fill(-5);
        frame.push(Record { key: 9, owner: 9, intro: Intro::Player { id: -1_000_003, name: "Skirmisher 3".into(), bot: true }, fields, refers: 4 });
        frame.event(Event::new(-300, 20, 50, 1, 40));
        let text = serde_json::to_string(&frame).expect("serialized");
        // Each cell is one run of bytes (a list of numbers in JSON, a blob where there are blobs): a
        // creature at (1 m, 1 m) in 14 of them (where the cell is, how many records, the key, owner
        // and what it names, its kind and id, a mask, two fields of two bytes, no effects).
        let creature_cell = &frame.cells()[0];
        assert_eq!(creature_cell.pack().len(), 14);
        assert_eq!(CellRecords::unpack(&creature_cell.pack()).as_ref(), Ok(creature_cell));
        let back: Frame = serde_json::from_str(&text).expect("read back");
        assert_eq!(back.tick, 77);
        assert_eq!(back.cells(), frame.cells());
        assert_eq!(back.cell(Cell { x: 0, z: 0 }).map(|c| c.records.len()), Some(1));
        // Another sim's cells for the same tick join these, a cell both hold put together.
        let mut more = Frame::new(77);
        more.push(creature(2, 150, 150));
        let mut joined = Frame::from_cells(77, back.into_cells());
        joined.add_cells(more.into_cells());
        assert_eq!(joined.len(), 3);
        assert_eq!(joined.cell(Cell { x: 0, z: 0 }).map(|c| c.records.len()), Some(2));
    }
}
