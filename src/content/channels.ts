import data from '../../shared/channels.json' with { type: 'json' };

// The channels' numbers, as content (shared/channels.json, built from content/channels.json): how full
// a channel fills, when a quiet one merges, how often a player may change. The policy is the
// server's (crates/channels, which reads the same bundle); the browser shows them (src/ui/channels,
// the bible's Channels page). Counts are players; times are seconds.

export interface ChannelTuning {
  softCap: number;
  hardCap: number;
  openAhead: number;
  quiet: number;
  quietFor: number;
  mergeFill: number;
  mergeNotice: number;
  mergeWait: number;
  changeEvery: number;
  calmAfter: number;
  rejoinWithin: number;
}

export const CHANNELS: ChannelTuning = data;
