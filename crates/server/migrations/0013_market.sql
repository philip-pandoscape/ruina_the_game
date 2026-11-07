-- What the world shares, kept in one place: each trading post's demand for each pack, as it stood
-- at a moment on the world's clock (crates/engine/src/life/market.rs), from which it recovers by
-- the clock. A sale lowers it in one statement (crates/server/src/land/market.rs), so sales from
-- every channel and server all count. (The time of day and each region's weather need nothing kept:
-- they're worked out from the world's clock.)
CREATE TABLE market (
    world   TEXT NOT NULL,
    outpost TEXT NOT NULL,
    pack    TEXT NOT NULL,
    demand  DOUBLE PRECISION NOT NULL,
    -- Seconds since 1970 on the world's clock.
    at      DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (world, outpost, pack)
);
