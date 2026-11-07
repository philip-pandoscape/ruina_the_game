-- The server in tiers (crates/server/src: gate, sim, store, social, directory). The directory is
-- the source of truth for routing: which simulation plays each space, and where each character is.
-- Every grant it makes carries an epoch, and every write carries the epoch it was granted under:
-- the store refuses one older than the latest (fencing tokens). (The spaces' leases are the
-- multi-server version's table, migration 0030; one process keeps them in memory.)

-- A character's grant: bumped each time the directory grants them to a connection (a new window
-- takes them over) or to another simulation (through a portal, out of a copy). Every write of
-- their life and build carries it (`WHERE epoch = $n`), where `live_session` fenced them before; it
-- is still set to the session holding the character, to say who has them.
ALTER TABLE characters ADD COLUMN epoch BIGINT NOT NULL DEFAULT 0;
-- The space their saved position is in: `channel:<region>:<n>` (a save made in a copy of an
-- instance keeps the spot outside its door, in the world).
ALTER TABLE characters ADD COLUMN space TEXT;

-- Copies of instances are numbered from this, so a copy's space (`copy:<instance>:<n>`) is one
-- whichever process makes it.
CREATE SEQUENCE copy_numbers;
