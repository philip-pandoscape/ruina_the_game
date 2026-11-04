-- Accounts, sign-in sessions and characters. The server applies this on start (server/src/db.rs).

CREATE TABLE accounts (
    id            BIGSERIAL PRIMARY KEY,
    -- As typed when the account was made; username_key is the same name lower-cased, so names are
    -- unique regardless of case.
    username      TEXT NOT NULL,
    username_key  TEXT NOT NULL UNIQUE,
    -- Argon2id, in PHC string form.
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);

-- A signed-in browser. The cookie holds a random token; only its SHA-256 is kept here, so a copy
-- of this table can't be used to sign in.
CREATE TABLE sessions (
    token_hash BYTEA PRIMARY KEY,
    account_id BIGINT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_by_account ON sessions (account_id);
CREATE INDEX sessions_by_expiry ON sessions (expires_at);

-- Who you play. One per account for now; a separate table so an account can hold more later.
CREATE TABLE characters (
    id           BIGSERIAL PRIMARY KEY,
    account_id   BIGINT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    -- Phase 1 of the move online: the browser still runs Emberholm's rules and reports the whole
    -- island here ({state, player}, as src/app/save.ts writes it). Later phases move this into
    -- tables the server owns: the character's own things, and the shared world's.
    island       JSONB,
    -- Skills, weapon and hotbar (src/build.ts).
    build        JSONB,
    saved_at     TIMESTAMPTZ,
    -- The connection playing this character right now. Saves carry it, so a window that has been
    -- replaced by a newer one can never write over the newer one's progress.
    live_session BIGINT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX characters_one_per_account ON characters (account_id);
