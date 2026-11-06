//! The rules' one random stream: mulberry32, exactly as src/rng.ts (and the browser's brain.ts
//! draw and life.ts rand), so a seed gives the same numbers on both sides. Each user keeps its own
//! state where it belongs (an actor's seed, the island's saved `rng`, a battle's, a table's), and
//! steps it here.

/// Steps `state` and returns the next number in [0, 1), at full precision.
pub fn mulberry32(state: &mut u32) -> f64 {
    *state = state.wrapping_add(0x6D2B_79F5);
    let mut t = *state;
    t = (t ^ (t >> 15)).wrapping_mul(t | 1);
    t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
    (t ^ (t >> 14)) as f64 / 4_294_967_296.0
}

/// A stream with its state to itself.
pub struct Rng(pub u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng(seed)
    }

    /// The next number in [0, 1), as rng() in TypeScript.
    pub fn next_f64(&mut self) -> f64 {
        mulberry32(&mut self.0)
    }

    /// The same, as the battlefield's single-precision crowd has it.
    pub fn next_f32(&mut self) -> f32 {
        self.next_f64() as f32
    }

    /// Shuffles `list` in place (Fisher-Yates from the end, as the TypeScript does).
    pub fn shuffle<T>(&mut self, list: &mut [T]) {
        for i in (1..list.len()).rev() {
            let j = (self.next_f64() * (i + 1) as f64) as usize;
            list.swap(i, j.min(i));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_numbers_as_the_browser() {
        // src/rng.ts makeRng(1): the first three.
        let mut r = Rng::new(1);
        let got = [r.next_f64(), r.next_f64(), r.next_f64()];
        assert_eq!(got, [0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
    }
}
