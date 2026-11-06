// The training yard's arrows and meteors in flight, as the page draws them: the engine flies them
// (crates/engine/src/training.rs, the yard standing in for the server) and hands them over each step.

export interface ArrowFlight {
  x: number;
  y: number;
  z: number;
  dirX: number;
  dirZ: number;
  speed: number;
  left: number; // metres of range left
  damage: number;
  weapon: number; // which weapon loosed it (what it hits trains that one)
  spent: boolean; // it hit something and is done
}

export interface MeteorFall {
  x: number;
  z: number;
  frame: number; // frames since the cast finished
  fallFrames: number;
  radius: number;
  damage: number;
}
