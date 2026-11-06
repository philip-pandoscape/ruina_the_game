//! Maths the way the browser does it, for the rules the browser also runs (it predicts your moves
//! with the TypeScript and corrects to the server, so the closer the two agree the less it ever
//! corrects). V8's exp and atan2 are fdlibm's, as are the `libm` crate's, so those match bit for
//! bit; Rust's own (the C library's) differ in the last bit on a tenth to a fifth of inputs. V8's
//! sin and cos come from elsewhere, and `libm`'s are the nearer of the two (about 1% of inputs a
//! bit off, against 3%). Math.pow is `libm`'s pow here (the same natively
//! and in WebAssembly; whether it matches V8's to the bit is untested). Math.hypot is js_hypot below.

pub trait JsMath {
    fn js_sin(self) -> f64;
    fn js_cos(self) -> f64;
    /// `y.js_atan2(x)`, like f64::atan2: Math.atan2(y, x).
    fn js_atan2(self, x: f64) -> f64;
    fn js_exp(self) -> f64;
    /// `x.js_pow(y)`: Math.pow(x, y), `libm`'s, the same natively and in WebAssembly.
    fn js_pow(self, y: f64) -> f64;
}

impl JsMath for f64 {
    #[inline]
    fn js_sin(self) -> f64 {
        libm::sin(self)
    }
    #[inline]
    fn js_cos(self) -> f64 {
        libm::cos(self)
    }
    #[inline]
    fn js_atan2(self, x: f64) -> f64 {
        libm::atan2(self, x)
    }
    #[inline]
    fn js_exp(self) -> f64 {
        // V8 answers exp(1) with e itself, where fdlibm's arithmetic is a bit off.
        if self == 1.0 {
            return std::f64::consts::E;
        }
        libm::exp(self)
    }

    fn js_pow(self, y: f64) -> f64 {
        libm::pow(self, y)
    }
}

// ---------- JavaScript arithmetic the rules rely on ----------

/// The length of a flat vector, as the TypeScript rules take it (src/sim/math.ts len): a plain
/// square root of the sum, not Math.hypot, so both sides get the same bits.
pub fn len(x: f64, z: f64) -> f64 {
    (x * x + z * z).sqrt()
}

/// Math.round: halves go up (toward +infinity), unlike f64::round.
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// Math.hypot of two numbers, exactly as V8 works it out (scaled by the larger, with compensated
/// summation). f64::hypot rounds differently in about a third of cases, and the rules compare
/// these distances against thresholds, so a different last bit can be a different decision.
pub fn js_hypot(a: f64, b: f64) -> f64 {
    if a.is_infinite() || b.is_infinite() {
        return f64::INFINITY;
    }
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    let (a, b) = (a.abs(), b.abs());
    let max = if b > a { b } else { a };
    if max == 0.0 {
        return 0.0;
    }
    let (mut sum, mut compensation) = (0.0f64, 0.0f64);
    for v in [a, b] {
        let n = v / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// Math.sign: 0 for 0 (f64::signum gives 1 for +0).
pub fn js_sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

/// Math.min / Math.max over two numbers, with JavaScript's NaN handling (NaN wins).
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn javascript_rounding() {
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_sign(0.0), 0.0);
    }

    #[test]
    // V8's Math.exp(1) to the bit: the value itself, not an approximation of e.
    #[allow(clippy::approx_constant)]
    fn the_same_values_v8_gives() {
        // Math.exp(1), Math.atan2(1, 2), Math.sin(1), Math.cos(1) in Node 24.
        assert_eq!(1.0f64.js_exp(), 2.718281828459045);
        assert_eq!(1.0f64.js_atan2(2.0), 0.4636476090008061);
        assert_eq!(1.0f64.js_sin(), 0.8414709848078965);
        assert_eq!(1.0f64.js_cos(), 0.5403023058681398);
    }
}
