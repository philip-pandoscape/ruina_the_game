//! Prints the server's ground for each point it's given, so tests/terrain.spec.ts can check it
//! against the browser's: stdin [[x, z], ...] -> stdout [[height, slope, surface], ...].

use std::io::Read;

use yggdrasil_server::open::zone::emberholm;

fn main() {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).expect("read points from stdin");
    let points: Vec<[f64; 2]> = serde_json::from_str(&raw).expect("stdin is [[x, z], ...]");
    let t = &emberholm().terrain;
    let out: Vec<(f64, f64, u8)> = points.iter().map(|[x, z]| (t.height(*x, *z), t.slope(*x, *z), t.surface_at(*x, *z))).collect();
    println!("{}", serde_json::to_string(&out).unwrap());
}
