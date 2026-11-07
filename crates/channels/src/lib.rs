//! Channels: a region is played as channels, copies of it for crowds, each a simulation of its own
//! with the same land in every one (docs/world.md, Channels; D17 in .plans/refactor/README.md).
//! This crate is the policy that runs them, asked by whoever keeps who plays where (the server's
//! directory) and by the tests:
//!
//! - **Placing.** Someone arriving goes back to the channel they left if they left it a moment ago,
//!   else to their party's, else to the channel with the most of their friends, then guild, then
//!   speakers of their language, then the fullest with room: channels fill to a soft cap, and past
//!   it the next arrival opens another (`Region::place`, `Region::arrive`).
//! - **Opening and merging.** Another channel opens when every one is full, or nearly; a channel
//!   quiet for a while merges into the fullest other that can take its players comfortably: they're
//!   told, then moved across with their packs and vehicles as each is out of a fight, and it closes
//!   (`Region::review`).
//! - **Changing channel.** A player's choice, and an invitation into a party member's channel: not
//!   carrying a pack, not in a fight, not more than once in a few minutes (`Region::change`,
//!   `Region::joined_party`).
//!
//! Its numbers are content (`shared/channels.json`, built from `content/channels.json`: [`tuning`]).
//! Who belongs with whom is the social tier's ([`ties`]: parties today; friends, guilds and
//! languages as it learns them). [`crowd`] plays a crowd of bots against a region for the tests.
//!
//! Pure: no clocks, threads, sockets or databases, and no maps that iterate in an order of their
//! own, so the same question gets the same answer wherever it's asked. It speaks the server tiers'
//! words (`crates/world-api`): a channel is a region's number `n` (`SpaceId::Channel { region, n }`),
//! a time is [`Millis`], a player a [`CharacterId`].

pub mod crowd;
pub mod region;
pub mod ties;
pub mod tuning;

pub use region::{Action, Channel, ChannelRow, ChannelsView, Closing, Follow, Load, Merge, Placed, Placement, Refusal, Region, Standing, Target, Why};
pub use ties::{GuildId, NoTies, PartyTies, Social, Ties};
pub use tuning::{Tuning, tuning};

/// A character, by its database id (the server tiers' `CharacterId`); in the crowd, a bot standing
/// in for one.
pub type CharacterId = i64;
/// A time on the world's clock: milliseconds since 1970 (the server tiers' `Millis`).
pub type Millis = i64;
/// A channel's number in its region, from 1 (the `n` of the server tiers' `SpaceId::Channel`).
pub type ChannelNo = u32;
