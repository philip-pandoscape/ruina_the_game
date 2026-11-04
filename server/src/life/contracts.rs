//! Trade contracts posted at the trading posts (src/sim/life/contracts.ts).
//! STUB: the signatures are fixed (other modules call them); the bodies are being ported.
#![allow(unused_variables)]

use super::Life;

pub fn step_contracts(life: &mut Life) {}

pub fn accept_contract(life: &mut Life, id: i64) -> bool {
    unimplemented!()
}

pub fn contract_delivered(life: &mut Life, outpost: &str, pack: &str) {
    unimplemented!()
}
