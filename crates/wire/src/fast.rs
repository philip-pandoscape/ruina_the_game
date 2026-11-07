//! A quick hash for the maps a gate looks into for every entity of every connection every tick (an
//! entity's key to its handle, a cell to its records). The keys are the server's own ids and cells,
//! not anything a browser chooses, so the standard library's flood-proof hash only costs time here.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

/// Multiply and rotate, a word at a time (the rustc compiler's FxHash).
#[derive(Default, Clone, Copy)]
pub struct Fx(u64);

const SEED: u64 = 0x51_7c_c1_b7_27_22_0a_95;

impl Fx {
    fn add(&mut self, word: u64) {
        self.0 = (self.0.rotate_left(5) ^ word).wrapping_mul(SEED);
    }
}

impl Hasher for Fx {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.add(u64::from(*b));
        }
    }

    fn write_u16(&mut self, i: u16) {
        self.add(u64::from(i));
    }

    fn write_u32(&mut self, i: u32) {
        self.add(u64::from(i));
    }

    fn write_i32(&mut self, i: i32) {
        self.add(u64::from(i as u32));
    }

    fn write_u64(&mut self, i: u64) {
        self.add(i);
    }

    fn write_usize(&mut self, i: usize) {
        self.add(i as u64);
    }
}

pub type FxMap<K, V> = HashMap<K, V, BuildHasherDefault<Fx>>;
