-- Whose life a character's land is lent to (R10.21): the grant (`characters.epoch`) it was lent
-- under, from the moment the store reads their life for a connection taking them up (their land goes
-- with it) until the simulation playing them gives it back after their life's last write; NULL while
-- the store keeps it for them. One authority at a time: while it's lent, only the life it's lent to
-- changes it (its writes fenced by the character's epoch); while it isn't, whoever acts on a piece
-- of it (a pack left on the ground, a vehicle left out) takes it from the store, from any channel,
-- the first to ask only (crates/server/src/store/land/pieces.rs). A server started alone gives
-- everyone's back: nobody plays yet.
ALTER TABLE characters ADD COLUMN land_lent BIGINT;
