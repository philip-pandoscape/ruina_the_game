-- The ledger: value moving between a character and the world (a purchase, a sale, a payout, a fee,
-- a tax, a quest's reward) or between two characters (a mini-game's pot), each written once. A row
-- is one character's side of it: what they gained (negative for what they gave) and who it was with.
-- Its key says which transfer and whose side it is, so one sent twice (a save written again, a
-- message delivered twice) is applied once: written in the same transaction as the lives it
-- changes, or not at all (crates/server/src/land/ledger.rs).
CREATE TABLE ledger (
    id        BIGSERIAL PRIMARY KEY,
    key       TEXT NOT NULL UNIQUE,
    world     TEXT NOT NULL,
    -- No foreign key: the record outlives a deleted character.
    character BIGINT NOT NULL,
    -- Who it was with: the world's people ('vendor:mara', 'post:westwatch', 'bench:<id>',
    -- 'registry', 'quest:<id>', 'world') or another character ('character:<id>').
    party     TEXT NOT NULL,
    -- purchase, sale, buyback, payout, bonus, fee, craft, tax, reward, grant, pot...
    kind      TEXT NOT NULL,
    coins     DOUBLE PRECISION NOT NULL DEFAULT 0,
    seals     DOUBLE PRECISION NOT NULL DEFAULT 0,
    -- Items gained (a negative count for those given), as [{item, n}].
    items     JSONB NOT NULL DEFAULT '[]',
    detail    JSONB,
    at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_by_character ON ledger (character, at);
