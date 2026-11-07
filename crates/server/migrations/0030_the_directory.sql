-- The world on several processes (crates/server/src/cluster/): the processes, which simulation
-- plays each space under which epoch, simulations' ids, and what a simulation last wrote of its
-- space for whoever takes it over. One process playing everything (the default) uses none of it yet.

-- Every process playing the world (a gate, a sim, the shared services): its role and where its
-- links take messages (crates/link). Each writes its row when it starts and touches it every couple
-- of seconds; a row long untouched is a process gone. Processes find each other here.
CREATE TABLE nodes (
    id          TEXT PRIMARY KEY,
    role        TEXT NOT NULL,
    address     TEXT NOT NULL,
    -- Which start of the process: a random number drawn when it started (its links say the same).
    incarnation BIGINT NOT NULL,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    seen_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Simulations' ids (world-api's SimId), unique across every process on this database and never
-- used twice, so a lease's holder is its simulation alone.
CREATE SEQUENCE sim_ids;

-- Which simulation plays each space (world-api's SpaceId as its key: channel:<region>:<n>,
-- copy:<instance>:<n>), or a part of one (a region split between simulations along its chunks;
-- part 0 is a whole space). A grant bumps the epoch; the holder renews its lease every couple of
-- seconds; one not renewed runs out, and another simulation may take the space under the next
-- epoch. Every write about a space carries the epoch it was granted under and is refused once a
-- newer grant has been made (crates/server/src/cluster/leases.rs). A lease let go keeps its epoch,
-- with nobody holding it.
CREATE TABLE space_leases (
    space      TEXT NOT NULL,
    part       INT NOT NULL DEFAULT 0,
    -- The 256 m chunks the part owns, as [[x, z], ...]; none for a whole space.
    chunks     JSONB NOT NULL DEFAULT '[]',
    sim        BIGINT,
    node       TEXT,
    address    TEXT,
    epoch      BIGINT NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    granted_at TIMESTAMPTZ,
    renewed_at TIMESTAMPTZ,
    PRIMARY KEY (space, part)
);
CREATE INDEX space_leases_by_node ON space_leases (node);

-- What a simulation last wrote of its space's moving state (creatures, what's under way: what
-- isn't land or a life, which the store keeps as they change), every few seconds and under its
-- lease's fence. Whoever takes the space over starts from it, so a crash costs seconds of movement
-- and never anything the store keeps.
CREATE TABLE space_snapshots (
    space    TEXT NOT NULL,
    part     INT NOT NULL DEFAULT 0,
    epoch    BIGINT NOT NULL,
    tick     BIGINT NOT NULL,
    data     BYTEA NOT NULL,
    saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (space, part)
);
