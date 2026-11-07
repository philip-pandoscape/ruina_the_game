//! What a sim publishes each tick: every entity's record, packed once, in the 32 m cell it stands
//! in, and what happened there (effects others see). The gate reads the cells around each
//! connection's player and writes that connection's update from them (crate::viewer), so nothing
//! is packed twice however many are looking.
//!
//! A tick's cells are Serialize and Deserialize: they go from a sim to the gates (crates/world-api's
//! tick out), in one process as they are and between processes in whatever form the transport
//! writes. A record's fields are written only as far as its last that isn't zero.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

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

/// One cell's share of a tick: what a sim hands the gates for it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CellRecords {
    pub cell: Cell,
    pub records: Vec<Record>,
    pub events: Vec<Event>,
}

/// Everything a gate knows of one tick, by cell: what one sim published, or several put together
/// (the cells either side of a border). Serialized as its tick and its cells.
#[derive(Clone, Debug, Default)]
pub struct Frame {
    /// The world's tick (crates/server's clock), whose low 32 bits each update carries.
    pub tick: u64,
    cells: Vec<CellRecords>,
    index: HashMap<Cell, usize>,
    count: usize,
}

impl Frame {
    pub fn new(tick: u64) -> Self {
        Frame { tick, cells: Vec::new(), index: HashMap::new(), count: 0 }
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
        frame.push(Record {
            key: 9,
            owner: 9,
            intro: Intro::Player { id: -1_000_003, name: "Skirmisher 3".into(), bot: true },
            fields: [-5; MAX_FIELDS],
            refers: 4,
        });
        frame.event(Event::new(-300, 20, 50, 1, 40));
        let text = serde_json::to_string(&frame).expect("serialized");
        // Trailing zeros aren't written: the creature's fields are just x and z.
        assert!(text.contains("\"fields\":[100,100]"), "{text}");
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
