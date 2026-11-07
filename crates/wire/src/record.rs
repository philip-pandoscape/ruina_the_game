//! What a sim publishes each tick: every entity's record, packed once, in the 32 m cell it stands
//! in, and what happened there (effects others see). The gate reads the cells around each
//! connection's player and writes that connection's update from them (crate::viewer), so nothing
//! is packed twice however many are looking.

use std::collections::HashMap;
use std::sync::Arc;

use crate::schema::{EVENT, Fields, Kind, MAX_FIELDS};

/// Interest cells are this many metres square (the world's words: a cell is 32 m).
pub const CELL: f64 = 32.0;

/// A 32 m cell: floor(x / 32), floor(z / 32).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
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
#[derive(Clone, Debug, PartialEq)]
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
#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    /// Who it is in the whole world (the server's EntityId), never sent: each connection knows it by
    /// a handle of its own.
    pub key: u64,
    /// Whose it is (a player's own key; a vehicle's or a pack's owner's; an arrow's shooter's), or 0.
    /// A connection isn't sent its own player, vehicles or packs: those come with its own state.
    pub owner: u64,
    pub intro: Intro,
    /// The kind's fields (crate::schema), the rest zero.
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

/// Something that happened, for effects (crate::schema::EVENT): where, what (the engine's effect
/// kind, with what caused it above its low four bits), and its size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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

/// One cell's share of a tick.
#[derive(Clone, Debug, Default)]
pub struct CellRecords {
    pub records: Vec<Record>,
    pub events: Vec<Event>,
}

/// Everything a sim publishes for one tick, by cell.
#[derive(Clone, Debug, Default)]
pub struct Frame {
    /// The world's tick (crates/server's clock), whose low 32 bits each update carries.
    pub tick: u64,
    cells: HashMap<Cell, CellRecords>,
    count: usize,
}

impl Frame {
    pub fn new(tick: u64) -> Self {
        Frame { tick, cells: HashMap::new(), count: 0 }
    }

    /// Adds a record to the cell it stands in.
    pub fn push(&mut self, r: Record) {
        self.count += 1;
        self.cells.entry(Cell::of(&r.fields)).or_default().records.push(r);
    }

    /// Adds something that happened, in the cell it happened in.
    pub fn event(&mut self, e: Event) {
        let (x, z) = e.at();
        self.cells.entry(Cell::at(x, z)).or_default().events.push(e);
    }

    pub fn cell(&self, c: Cell) -> Option<&CellRecords> {
        self.cells.get(&c)
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
        self.cells.values().flat_map(|c| c.records.iter())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_go_in_the_cell_they_stand_in() {
        assert_eq!(Cell::at(0.0, 31.9), Cell { x: 0, z: 0 });
        assert_eq!(Cell::at(-0.1, 32.0), Cell { x: -1, z: 1 });
        let mut fields = [0; MAX_FIELDS];
        fields[0] = -6400;
        fields[1] = 3300;
        let mut frame = Frame::new(9);
        frame.push(Record { key: 1, owner: 0, intro: Intro::Creature { id: 4 }, fields, refers: 0 });
        frame.event(Event::new(100, 0, 100, 2, 30));
        assert_eq!(frame.cell(Cell { x: -2, z: 1 }).map(|c| c.records.len()), Some(1));
        assert_eq!(frame.cell(Cell { x: 0, z: 0 }).map(|c| c.events.len()), Some(1));
        assert_eq!(frame.len(), 1);
    }
}
