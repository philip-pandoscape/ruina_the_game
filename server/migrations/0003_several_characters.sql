-- An account holds several characters (server/src/characters.rs), each with its own island, which
-- already lives on the characters row. Registering still makes a first one named after the account.
DROP INDEX characters_one_per_account;
CREATE INDEX characters_by_account ON characters (account_id);

-- Names show over heads, so no two characters share one, whatever the case. (Until now each
-- character was named after its account, and those names were already unique this way.)
CREATE UNIQUE INDEX characters_name_unique ON characters (lower(name));

-- When the character last went into the world: the character select screen picks it by default,
-- and the world plays it when the browser doesn't say which.
ALTER TABLE characters ADD COLUMN last_played_at TIMESTAMPTZ;
UPDATE characters SET last_played_at = saved_at;
