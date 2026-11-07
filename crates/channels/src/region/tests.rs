use super::*;
use crate::ties::{NoTies, Social};

/// Some moment on the world's clock.
const T0: Millis = 1_793_000_000_000;

/// Channels of 20 (24 at most), quiet under 5 for a minute, merged to at most 15 after 10 s of
/// notice and 10 s of waiting, changed once a minute, a fight over after 10 s, and a minute to come back.
fn t() -> Tuning {
    Tuning::small()
}

fn secs(s: f64) -> Millis {
    (s * 1000.0) as Millis
}

fn free(_: CharacterId) -> Standing {
    Standing::default()
}

/// A region with `counts[k]` players in channel k + 1 (numbered from 1000 × the channel).
fn filled(counts: &[usize]) -> Region {
    let mut r = Region::new("emberholm");
    for (k, c) in counts.iter().enumerate() {
        let n = k as ChannelNo + 1;
        r.open(n, T0);
        for i in 0..*c {
            r.seat(1000 * i64::from(n) + i as i64, n, &NoTies);
        }
    }
    r
}

fn sizes(r: &Region) -> Vec<(ChannelNo, usize)> {
    r.channels().map(|c| (c.n, c.players.len())).collect()
}

#[test]
fn arrivals_fill_a_channel_to_its_soft_cap_and_the_next_opens_another() {
    let mut r = Region::new("emberholm");
    let (first, opened) = r.arrive(1, &NoTies, T0, &t());
    assert_eq!(first, Placed { n: 1, why: Placement::New });
    assert_eq!(opened, vec![Action::Open { n: 1 }]);
    for who in 2..=20 {
        assert_eq!(r.arrive(who, &NoTies, T0, &t()).0, Placed { n: 1, why: Placement::Fill });
    }
    let (next, opened) = r.arrive(21, &NoTies, T0, &t());
    assert_eq!(next, Placed { n: 2, why: Placement::New });
    assert_eq!(opened, vec![Action::Open { n: 2 }]);
    assert_eq!(sizes(&r), vec![(1, 20), (2, 1)]);
    // Someone already here stays where they are.
    assert_eq!(r.arrive(5, &NoTies, T0, &t()), (Placed { n: 1, why: Placement::Back }, vec![]));
}

#[test]
fn the_fullest_channel_with_room_takes_the_next_arrival() {
    let mut r = filled(&[12, 19, 20, 3]);
    assert_eq!(r.arrive(1, &NoTies, T0, &t()).0, Placed { n: 2, why: Placement::Fill });
    // Channel 2 is full now: channel 1 is the fullest with room.
    assert_eq!(r.arrive(2, &NoTies, T0, &t()).0, Placed { n: 1, why: Placement::Fill });
    // As full as each other: the lower number.
    let r = filled(&[7, 7]);
    assert_eq!(r.place(1, &NoTies, T0, &t()).n, 1);
}

#[test]
fn someone_back_within_a_moment_goes_back_to_their_channel_even_past_its_soft_cap() {
    let mut r = filled(&[20, 10]);
    r.leave(1000, T0);
    r.arrive(1, &NoTies, T0, &t());
    assert_eq!(r.population(1), 20, "someone else took the place");
    assert_eq!(r.arrive(1000, &NoTies, T0 + secs(30.0), &t()).0, Placed { n: 1, why: Placement::Back });
    assert_eq!(r.population(1), 21);
    // Back too late, they're placed afresh.
    r.leave(1000, T0 + secs(40.0));
    r.review(T0 + secs(101.0), &NoTies, free, &t());
    assert_eq!(r.place(1000, &NoTies, T0 + secs(101.0), &t()), Placed { n: 2, why: Placement::Fill });
    // Never past the hard cap.
    let mut r = filled(&[24, 3]);
    r.leave(1000, T0);
    // Someone else's party fills the place behind them.
    r.seat(1, 1, &NoTies);
    assert_eq!(r.place(1000, &NoTies, T0 + secs(1.0), &t()), Placed { n: 2, why: Placement::Fill });
}

#[test]
fn a_party_is_placed_together_past_the_soft_cap_but_not_past_the_hard_cap() {
    let mut s = Social::default();
    s.form(2000, &[1, 2, 3, 4, 5]);
    let mut r = filled(&[18, 20]);
    for who in 1..=4 {
        assert_eq!(r.arrive(who, &s, T0, &t()).0, Placed { n: 2, why: Placement::Party });
    }
    assert_eq!(r.population(2), 24);
    // Full to the hard cap: the last of them goes where there's room.
    assert_eq!(r.arrive(5, &s, T0, &t()).0, Placed { n: 1, why: Placement::Fill });
}

#[test]
fn a_party_plays_where_its_leader_does_else_where_most_of_it_does() {
    let mut s = Social::default();
    s.form(1000, &[2000, 2001, 7]);
    let r = filled(&[1, 2]);
    assert_eq!(r.party_channel(7, &s), Some(1), "the leader's");
    // The leader themself joins the rest.
    assert_eq!(r.party_channel(1000, &s), Some(2));
    s.leave(1000);
    assert_eq!(s.party(7).map(|p| p.leader), Some(2000));
    s.join(2000, 1001);
    let mut r = filled(&[2, 0]);
    r.unseat(1000);
    // Led by 2000, who isn't here: where most of the others are (channel 1, with 1001).
    assert_eq!(r.party_channel(7, &s), Some(1));
    assert_eq!(r.party_channel(9, &s), None, "no party");
}

#[test]
fn friends_count_first_then_guild_then_language_then_fill() {
    // Channel 1: a friend of player 1's. Channel 2: three of their guild. Channel 3: the fullest,
    // ten speaking their language. Each channel counts the ties of whoever is in it.
    let mut everyone = Social::default();
    for who in [200, 201, 202] {
        everyone.set_guild(who, 9);
    }
    for who in 300..310 {
        everyone.set_language(who, "de");
    }
    let mut r = filled(&[0, 0, 0]);
    r.seat(100, 1, &everyone);
    for who in [200, 201, 202] {
        r.seat(who, 2, &everyone);
    }
    for who in 300..310 {
        r.seat(who, 3, &everyone);
    }
    // Player 1's own ties decide, strongest first.
    let tied = |friend: bool, guild: bool| {
        let mut s = Social::default();
        if friend {
            s.befriend(1, 100);
        }
        if guild {
            s.set_guild(1, 9);
        }
        s.set_language(1, "de");
        s
    };
    assert_eq!(r.place(1, &tied(true, true), T0, &t()), Placed { n: 1, why: Placement::Friends });
    assert_eq!(r.place(1, &tied(false, true), T0, &t()), Placed { n: 2, why: Placement::Guild });
    assert_eq!(r.place(1, &tied(false, false), T0, &t()), Placed { n: 3, why: Placement::Language });
    // Nobody they know, nothing of theirs: the fullest.
    assert_eq!(r.place(1, &NoTies, T0, &t()), Placed { n: 3, why: Placement::Fill });
    // A share, not a count: two of two speaking it beats three of ten.
    let mut fr = Social::default();
    for who in [1, 10, 11, 12, 20, 21] {
        fr.set_language(who, "fr");
    }
    let mut r = filled(&[0, 0]);
    for who in 10..20 {
        r.seat(who, 1, &fr);
    }
    for who in [20, 21] {
        r.seat(who, 2, &fr);
    }
    assert_eq!(r.place(1, &fr, T0, &t()), Placed { n: 2, why: Placement::Language });
}

// A region of two channels and a player, 1, in channel 1, free to go.
fn two_channels() -> Region {
    let mut r = filled(&[6, 6]);
    r.seat(1, 1, &NoTies);
    r
}

#[test]
fn changing_channel_is_refused_with_a_pack_in_a_fight_riding_in_the_air_or_at_a_table() {
    let r = two_channels();
    let to = Target::Channel(2);
    let now = T0 + secs(100.0);
    let refused = |st: Standing| r.may_change(1, to, &st, &NoTies, now, &t());
    assert_eq!(refused(Standing::default()), Ok(2));
    assert_eq!(refused(Standing { pack: true, ..Standing::default() }), Err(Refusal::Pack));
    assert_eq!(refused(Standing { fought: Some(now - secs(9.0)), ..Standing::default() }), Err(Refusal::Combat));
    assert_eq!(refused(Standing { fought: Some(now - secs(10.0)), ..Standing::default() }), Ok(2), "the fight is over");
    assert_eq!(refused(Standing { down: true, ..Standing::default() }), Err(Refusal::Combat));
    assert_eq!(refused(Standing { riding: true, ..Standing::default() }), Err(Refusal::Riding));
    assert_eq!(refused(Standing { airborne: true, ..Standing::default() }), Err(Refusal::Airborne));
    assert_eq!(refused(Standing { seated: true, ..Standing::default() }), Err(Refusal::AtTable));
    // Where to: not where they are, not a channel that isn't open, nor one full to its soft cap.
    assert_eq!(r.may_change(1, Target::Channel(1), &Standing::default(), &NoTies, now, &t()), Err(Refusal::Here));
    assert_eq!(r.may_change(1, Target::Channel(7), &Standing::default(), &NoTies, now, &t()), Err(Refusal::NoChannel));
    assert_eq!(r.may_change(99, to, &Standing::default(), &NoTies, now, &t()), Err(Refusal::NotHere));
    let full = filled(&[1, 20]);
    assert_eq!(full.may_change(1000, to, &Standing::default(), &NoTies, now, &t()), Err(Refusal::Full));
}

#[test]
fn a_change_of_channel_waits_a_while_before_the_next() {
    let mut r = two_channels();
    let st = Standing::default();
    assert_eq!(r.change(1, Target::Channel(2), &st, &NoTies, T0, &t()), Ok(Action::Move { who: 1, from: 1, to: 2, why: Why::Choice }));
    assert_eq!(r.channel_of(1), Some(2));
    assert_eq!(r.change(1, Target::Channel(1), &st, &NoTies, T0 + secs(20.0), &t()), Err(Refusal::Wait { ms: secs(40.0) }));
    assert_eq!(Refusal::Wait { ms: secs(40.0) }.sentence(), "You can change channel again in 40s.");
    // Signing out and back in doesn't start it over: they come back where they were.
    r.leave(1, T0 + secs(21.0));
    assert_eq!(r.arrive(1, &NoTies, T0 + secs(22.0), &t()).0, Placed { n: 2, why: Placement::Back });
    assert!(r.change(1, Target::Channel(1), &st, &NoTies, T0 + secs(59.0), &t()).is_err());
    assert!(r.change(1, Target::Channel(1), &st, &NoTies, T0 + secs(60.0), &t()).is_ok());
}

#[test]
fn an_invitation_takes_you_to_your_partys_channel_now_or_as_soon_as_you_may_go() {
    let mut s = Social::default();
    let mut r = two_channels();
    // Ada (2000) leads, in channel 2; player 1 accepts in channel 1, free: moved now.
    s.join(2000, 1);
    let st = Standing::default();
    assert_eq!(r.joined_party(1, &st, &s, T0, &t()), Follow::Now(Action::Move { who: 1, from: 1, to: 2, why: Why::Party }));
    // Player 1001 accepts with a pack on their back: later, once it's down.
    s.join(2000, 1001);
    let pack = Standing { pack: true, ..Standing::default() };
    assert_eq!(r.joined_party(1001, &pack, &s, T0, &t()), Follow::Later(Refusal::Pack));
    assert!(r.following(1001));
    assert!(r.review(T0 + secs(1.0), &s, |_| pack, &t()).is_empty());
    let moved = r.review(T0 + secs(2.0), &s, free, &t());
    assert_eq!(moved, vec![Action::Move { who: 1001, from: 1, to: 2, why: Why::Party }]);
    assert!(!r.following(1001));
    // With the party already: nothing to do.
    assert_eq!(r.joined_party(1001, &st, &s, T0 + secs(3.0), &t()), Follow::Stay);
    // A choice meanwhile ends the wait; so does leaving the party.
    s.join(2000, 1002);
    assert_eq!(r.joined_party(1002, &pack, &s, T0, &t()), Follow::Later(Refusal::Pack));
    r.left_party(1002);
    assert!(r.review(T0 + secs(4.0), &s, free, &t()).is_empty(), "they left the party before they could go");
}

#[test]
fn following_your_party_counts_as_a_change_of_channel() {
    let mut s = Social::default();
    let mut r = two_channels();
    let st = Standing::default();
    r.change(1, Target::Channel(2), &st, &NoTies, T0, &t()).unwrap();
    // Invited into channel 1 half a minute later: they go once the minute is up.
    s.join(1000, 1);
    assert_eq!(r.joined_party(1, &st, &s, T0 + secs(30.0), &t()), Follow::Later(Refusal::Wait { ms: secs(30.0) }));
    assert!(r.review(T0 + secs(59.0), &s, free, &t()).is_empty());
    assert_eq!(r.review(T0 + secs(60.0), &s, free, &t()), vec![Action::Move { who: 1, from: 2, to: 1, why: Why::Party }]);
    // A party past the hard cap waits too.
    let mut r = filled(&[24, 1]);
    let mut s = Social::default();
    s.join(1000, 2000);
    assert_eq!(r.joined_party(2000, &st, &s, T0, &t()), Follow::Later(Refusal::Full));
}

#[test]
fn a_quiet_channel_merges_into_the_fullest_that_can_take_it_once_its_players_are_free() {
    // Channel 3 is quiet (3 players) and the newest; channel 2 (11) can take them and stay at 15 or
    // under, channel 1 (14) can't.
    let mut r = filled(&[14, 11, 3]);
    let now = T0;
    assert!(r.review(now, &NoTies, free, &t()).is_empty(), "quiet for no time yet");
    assert!(r.review(now + secs(59.0), &NoTies, free, &t()).is_empty());
    let begun = r.review(now + secs(60.0), &NoTies, free, &t());
    assert_eq!(begun, vec![Action::Merging { from: 3, into: 2, at: now + secs(70.0) }]);
    assert!(r.closing(3));
    assert_eq!(r.load(2), 14, "channel 2 counts what's coming");
    // Arrivals go elsewhere: not into the closing channel.
    assert_ne!(r.place(1, &NoTies, now + secs(61.0), &t()).n, 3);
    // At the notice's end: whoever is free goes; one in a fight waits for it to end.
    let fighting = 3001;
    let st = move |who: CharacterId| Standing { fought: (who == fighting).then_some(now + secs(65.0)), ..Standing::default() };
    let moved = r.review(now + secs(70.0), &NoTies, st, &t());
    assert_eq!(moved, vec![Action::Move { who: 3000, from: 3, to: 2, why: Why::Merge }, Action::Move { who: 3002, from: 3, to: 2, why: Why::Merge }]);
    assert_eq!(r.channel_of(fighting), Some(3));
    // Their fight is over: they go, and the channel closes.
    let rest = r.review(now + secs(76.0), &NoTies, st, &t());
    assert_eq!(rest, vec![Action::Move { who: fighting, from: 3, to: 2, why: Why::Merge }, Action::Close { n: 3, into: 2 }]);
    assert_eq!(sizes(&r), vec![(1, 14), (2, 14)]);
    assert_eq!(r.merge(), None);
}

#[test]
fn a_merge_moves_everyone_left_at_its_deadline() {
    let mut r = filled(&[10, 2]);
    r.review(T0, &NoTies, free, &t());
    r.review(T0 + secs(60.0), &NoTies, free, &t());
    let stuck = |_| Standing { seated: true, ..Standing::default() };
    assert!(r.review(T0 + secs(70.0), &NoTies, stuck, &t()).is_empty(), "everyone is at a table");
    let out = r.review(T0 + secs(80.0), &NoTies, stuck, &t());
    assert_eq!(out.len(), 3, "two moved and the channel closed: {out:?}");
    assert_eq!(out.last(), Some(&Action::Close { n: 2, into: 1 }));
}

#[test]
fn nothing_merges_where_it_would_crowd_another_and_an_empty_channel_closes_at_once() {
    // Channel 2 is quiet, but channel 1 couldn't take its 4 and stay at 15.
    let mut r = filled(&[12, 4]);
    r.review(T0, &NoTies, free, &t());
    assert!(r.review(T0 + secs(600.0), &NoTies, free, &t()).is_empty());
    // An empty one: no notice, closed.
    let mut r = filled(&[12, 0]);
    r.review(T0, &NoTies, free, &t());
    assert_eq!(r.review(T0 + secs(60.0), &NoTies, free, &t()), vec![Action::Close { n: 2, into: 1 }]);
    assert_eq!(sizes(&r), vec![(1, 12)]);
}

#[test]
fn whoever_comes_back_to_a_merged_channel_comes_back_where_it_went() {
    let mut r = filled(&[10, 2]);
    r.review(T0, &NoTies, free, &t());
    // Player 2000 leaves channel 2 just before it begins to merge into channel 1.
    r.leave(2000, T0 + secs(50.0));
    r.review(T0 + secs(60.0), &NoTies, free, &t());
    // Back during the merge: into where it's going.
    assert_eq!(r.place(2000, &NoTies, T0 + secs(61.0), &t()), Placed { n: 1, why: Placement::Back });
    r.review(T0 + secs(70.0), &NoTies, free, &t());
    assert!(r.channel(2).is_none(), "closed");
    // ...and after it.
    r.review(T0 + secs(71.0), &NoTies, free, &t());
    assert_eq!(r.place(2000, &NoTies, T0 + secs(72.0), &t()), Placed { n: 1, why: Placement::Back });
}

#[test]
fn the_party_of_a_closing_channel_is_joined_where_it_is_going() {
    let mut s = Social::default();
    s.join(2000, 1);
    let mut r = filled(&[10, 2]);
    r.review(T0, &NoTies, free, &t());
    r.review(T0 + secs(60.0), &NoTies, free, &t());
    assert!(r.closing(2));
    assert_eq!(r.place(1, &s, T0 + secs(61.0), &t()), Placed { n: 1, why: Placement::Party });
    // Someone in channel 1 whose party is merging into it is with it already.
    r.seat(1, 1, &s);
    assert_eq!(r.may_change(1, Target::Party, &Standing::default(), &s, T0 + secs(61.0), &t()), Err(Refusal::WithParty));
}

#[test]
fn another_channel_opens_ahead_of_a_crowd() {
    // 19 and 20 of 20: one place left, fewer than open_ahead (2).
    let mut r = filled(&[19, 20]);
    assert_eq!(r.review(T0, &NoTies, free, &t()), vec![Action::Open { n: 3 }]);
    assert!(r.review(T0 + secs(1.0), &NoTies, free, &t()).is_empty(), "room enough now");
    // It stays while the others are too busy to take its players.
    assert!(r.review(T0 + secs(600.0), &NoTies, free, &t()).is_empty());
    // An empty region opens nothing ahead.
    let mut empty = Region::new("emberholm");
    assert!(empty.review(T0, &NoTies, free, &t()).is_empty());
}

#[test]
fn a_crowd_thinning_merges_its_channels_one_at_a_time_newest_first() {
    let mut r = filled(&[4, 4, 4]);
    r.review(T0, &NoTies, free, &t());
    let first = r.review(T0 + secs(60.0), &NoTies, free, &t());
    assert_eq!(first, vec![Action::Merging { from: 3, into: 1, at: T0 + secs(70.0) }]);
    assert!(r.review(T0 + secs(61.0), &NoTies, free, &t()).is_empty(), "one merge at a time");
    let done = r.review(T0 + secs(70.0), &NoTies, free, &t());
    // Its four moved and it closed; channel 2, quiet all along, begins to merge next, into channel 1
    // (8 + 4 = 12).
    assert_eq!(done.len(), 6, "{done:?}");
    assert_eq!(done[4..], [Action::Close { n: 3, into: 1 }, Action::Merging { from: 2, into: 1, at: T0 + secs(80.0) }]);
    r.review(T0 + secs(80.0), &NoTies, free, &t());
    assert_eq!(sizes(&r), vec![(1, 12)]);
}

#[test]
fn what_a_player_sees_of_the_channels() {
    let mut s = Social::default();
    s.join(2000, 1);
    s.befriend(1, 1000);
    s.befriend(1, 1001);
    let mut r = filled(&[16, 2, 20]);
    r.seat(1, 1, &s);
    let v = r.view(1, &Standing { pack: true, ..Standing::default() }, &s, T0, &t());
    assert_eq!(v.region, "emberholm");
    assert_eq!(v.here, 1);
    assert_eq!(
        v.list,
        vec![
            ChannelRow { n: 1, load: Load::Busy, closing: false, party: 0, friends: 2 },
            ChannelRow { n: 2, load: Load::Quiet, closing: false, party: 1, friends: 0 },
            ChannelRow { n: 3, load: Load::Full, closing: false, party: 0, friends: 0 },
        ]
    );
    assert_eq!(v.party, Some(2));
    assert_eq!(v.blocked.as_deref(), Some("You can't change channel while carrying a pack."));
    assert_eq!((v.closing, v.wait, v.following), (None, None, false));
    // Lively between quiet and busy.
    assert_eq!(Load::of(10, &t()), Load::Lively);
    // Its JSON, as the browser reads it.
    let json = serde_json::to_value(&v).unwrap();
    assert_eq!(json["list"][0], serde_json::json!({ "n": 1, "load": "busy", "closing": false, "party": 0, "friends": 2 }));
    assert_eq!(json["closing"], serde_json::Value::Null);
}

#[test]
fn a_player_in_a_merging_channel_sees_where_and_when() {
    let mut r = filled(&[10, 2]);
    r.review(T0, &NoTies, free, &t());
    r.review(T0 + secs(60.0), &NoTies, free, &t());
    let v = r.view(2000, &Standing::default(), &NoTies, T0 + secs(64.0), &t());
    assert_eq!(v.closing, Some(Closing { into: 1, ms: secs(6.0) }));
    assert!(v.list.iter().any(|c| c.n == 2 && c.closing));
    assert_eq!(serde_json::to_value(&v).unwrap()["closing"], serde_json::json!({ "into": 1, "ms": 6000 }));
}

#[test]
fn refusals_read_as_sentences_and_waits_as_minutes_and_seconds() {
    assert_eq!(short_time(200_000), "3m 20s");
    assert_eq!(short_time(240_000), "4m");
    assert_eq!(short_time(44_001), "45s");
    assert_eq!(short_time(-5), "0s");
    for r in [
        Refusal::NotHere,
        Refusal::Here,
        Refusal::WithParty,
        Refusal::NoParty,
        Refusal::PartyAway,
        Refusal::NoChannel,
        Refusal::Closing,
        Refusal::Full,
        Refusal::Pack,
        Refusal::Combat,
        Refusal::Riding,
        Refusal::Airborne,
        Refusal::AtTable,
        Refusal::Wait { ms: 1000 },
    ] {
        let s = r.sentence();
        assert!(s.ends_with('.') && s.starts_with(|c: char| c.is_uppercase()), "{s}");
    }
}

#[test]
fn a_character_deleted_is_forgotten() {
    let mut r = two_channels();
    r.change(1, Target::Channel(2), &Standing::default(), &NoTies, T0, &t()).unwrap();
    r.forget(1);
    assert_eq!(r.channel_of(1), None);
    assert_eq!(r.wait(1, T0, &t()), None);
    assert_eq!(r.place(1, &NoTies, T0, &t()).why, Placement::Fill);
}

#[test]
fn a_player_who_changed_lately_sees_the_wait_apart_from_what_else_stops_them() {
    let mut r = two_channels();
    r.change(1, Target::Channel(2), &Standing::default(), &NoTies, T0, &t()).unwrap();
    let v = r.view(1, &Standing::default(), &NoTies, T0 + secs(15.0), &t());
    assert_eq!((v.wait, v.blocked), (Some(secs(45.0)), None));
    let v = r.view(1, &Standing { pack: true, ..Standing::default() }, &NoTies, T0 + secs(15.0), &t());
    assert_eq!((v.wait, v.blocked.as_deref()), (Some(secs(45.0)), Some("You can't change channel while carrying a pack.")));
    assert_eq!(r.blocked(1, &Standing::default(), T0 + secs(15.0), &t()), Some(Refusal::Wait { ms: secs(45.0) }));
}

#[test]
fn a_channel_a_merge_has_just_filled_is_not_quiet_any_more() {
    // Channel 3 (4) merges into channel 2 (4): channel 1 (12) can't take them, and channel 4, opened
    // half a minute in, is emptier.
    let mut r = filled(&[12, 4, 4]);
    r.review(T0, &NoTies, free, &t());
    r.open(4, T0 + secs(30.0));
    assert_eq!(r.review(T0 + secs(60.0), &NoTies, free, &t()), vec![Action::Merging { from: 3, into: 2, at: T0 + secs(70.0) }]);
    // Once it closes, channel 2 has 8: not quiet, though it was a minute ago, so it doesn't merge on.
    let done = r.review(T0 + secs(70.0), &NoTies, free, &t());
    assert_eq!(done.last(), Some(&Action::Close { n: 3, into: 2 }), "{done:?}");
    assert_eq!(r.merge(), None);
    assert_eq!(sizes(&r), vec![(1, 12), (2, 8), (4, 0)]);
}
