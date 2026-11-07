-- The world's words (R10.14, docs/world.md): what a character keeps of their own (their bag, coins,
-- seals, quests, skills, labor, contracts) is their life, so the column that holds it is named for
-- it. Renamed, not rewritten: every save in it reads as it did (the store's queries name `life`).
-- The migrations before this one still say `island`, as they ran.
ALTER TABLE characters RENAME COLUMN island TO life;
