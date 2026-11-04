//! Maths the way the browser does it, for the rules the browser also runs (it predicts your moves
//! with the TypeScript and corrects to the server, so the closer the two agree the less it ever
//! corrects). V8's exp and atan2 are fdlibm's, as are the `libm` crate's, so those match bit for
//! bit; Rust's own (the C library's) differ in the last bit on a tenth to a fifth of inputs. V8's
//! sin and cos come from elsewhere, and `libm`'s are the nearer of the two (about 1% of inputs a
//! bit off, against 3%). Math.pow is the C library's in both. Math.hypot is life::content::js_hypot.

pub trait JsMath {
    fn js_sin(self) -> f64;
    fn js_cos(self) -> f64;
    /// `y.js_atan2(x)`, like f64::atan2: Math.atan2(y, x).
    fn js_atan2(self, x: f64) -> f64;
    fn js_exp(self) -> f64;
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_values_v8_gives() {
        // Math.exp(1), Math.atan2(1, 2), Math.sin(1), Math.cos(1) in Node 24.
        assert_eq!(1.0f64.js_exp(), 2.718281828459045);
        assert_eq!(1.0f64.js_atan2(2.0), 0.4636476090008061);
        assert_eq!(1.0f64.js_sin(), 0.8414709848078965);
        assert_eq!(1.0f64.js_cos(), 0.5403023058681398);
    }
}
