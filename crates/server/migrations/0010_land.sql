-- Land: what's built and planted in the world, and what's left standing in it (houses on their
-- plots, farms, ships on the slipways, packs, vehicles; crates/engine/src/life/land.rs), a row a
-- piece, keyed by where it stands: the same in every channel of its region. Only its owner changes a
-- piece, while they play (it's lent to their life and written with it, fenced by their grant); while
-- they're away the region's keeper of land may take a neglected house down (fenced by its lease).
-- The store's queries are crates/server/src/store/land/.

-- Ids for pieces, handed out a block at a time (hi/lo): block b holds the ids b * 1024 up to
-- (b + 1) * 1024, so a holding given a block names what it places with no trip to the database, and
-- no two pieces in the world share an id (the engine's EntityKind::Placed numbers).
CREATE SEQUENCE land_blocks;

CREATE TABLE land (
    id         BIGINT PRIMARY KEY,
    -- The world (one per database today) and the space in it ('world', the open world).
    world      TEXT NOT NULL,
    space      TEXT NOT NULL,
    -- The 256 m chunk it stands in (content/world.json); none for a pack on its owner's back.
    cx         INT,
    cz         INT,
    -- house, farm, ship, pack or vehicle.
    kind       TEXT NOT NULL,
    owner      BIGINT NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
    -- The grant it was last written under (its owner's, or the region keeper's lease).
    epoch      BIGINT NOT NULL DEFAULT 0,
    -- The piece as the engine keeps it.
    data       JSONB NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX land_by_chunk ON land (world, space, cx, cz);
CREATE INDEX land_by_owner ON land (owner);
