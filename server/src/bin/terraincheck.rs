//! Prints the server's ground height for each point it's given, so tests/terrain.spec.ts can
//! check it against the browser's: stdin [[x, z], ...] -> stdout [h, ...].

use std::io::Read;

use yggdrasil_server::terrain::Terrain;

fn main() {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).expect("read points from stdin");
    let points: Vec<[f64; 2]> = serde_json::from_str(&raw).expect("stdin is [[x, z], ...]");
    let t = Terrain::emberholm();
    let heights: Vec<f64> = points.iter().map(|[x, z]| t.height(*x, *z)).collect();
    println!("{}", serde_json::to_string(&heights).unwrap());
}
