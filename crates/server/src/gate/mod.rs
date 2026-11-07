//! The gate: players' connections (sign-in, the welcome, inputs and commands in, updates out) and
//! what a browser's bytes mean and what it is sent.

/// Combat on the wire: what input bytes mean, and the arrows, meteors and effects a browser is sent.
pub mod encode;
/// A player's connection: sign-in, the welcome, inputs and commands in, ticks out.
pub mod socket;
