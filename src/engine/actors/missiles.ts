// What creatures throw and shoot (a stone, later an arrow or a bolt) is flown by the engine
// (crates/engine/src/missiles.rs): aimed where its foe is going, lobbed to come down on them, hitting
// the first foe whose body it passes through unless they are in a dodge's untouchable frames.

/** How tall a foe's body is, from the feet, for what a missile can hit. */
export const FOE_HEIGHT = 1.8;
