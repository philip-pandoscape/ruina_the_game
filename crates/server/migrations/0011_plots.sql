-- House plots: one claim each in the whole world, first come. The primary key is the registry: of
-- two claims on a plot, from any channel or server, the first written is the one kept, and the
-- other finds it taken (crates/server/src/land/plots.rs). A claim is the house on the plot: when
-- that house comes down (its tax unpaid too long, or its owner gone), the plot is free again.
CREATE TABLE plots (
    world      TEXT NOT NULL,
    plot       TEXT NOT NULL,
    holder     BIGINT NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
    house      BIGINT NOT NULL REFERENCES land (id) ON DELETE CASCADE,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The grant it was claimed under.
    epoch      BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (world, plot)
);
CREATE INDEX plots_by_holder ON plots (holder);
CREATE UNIQUE INDEX plots_by_house ON plots (house);
