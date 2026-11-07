-- Channels are placed by the channels' policy (crates/channels, played by the directory): someone
-- coming in goes back to the channel they left a moment ago, else to their party's, else by their
-- ties to the fullest channel with room; another opens past the soft cap and a quiet one merges. A
-- character no longer keeps a channel of their own, so the column that held it goes (with its index).
-- Where their saved position is stays `characters.space` (`channel:<region>:<n>`, migration 0004).
DROP INDEX IF EXISTS characters_by_channel;
ALTER TABLE characters DROP COLUMN IF EXISTS home_channel;
