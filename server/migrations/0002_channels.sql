-- Emberholm runs as channels: copies of the island, each home to a limited number of characters
-- (server/src/channels.rs). A character keeps the channel they were first given.
ALTER TABLE characters ADD COLUMN home_channel INT;
CREATE INDEX characters_by_channel ON characters (home_channel);
