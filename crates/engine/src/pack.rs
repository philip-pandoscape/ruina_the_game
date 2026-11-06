//! The pack. Before the brains take their turn, every creature
//! whose brain has a `pack` is told what its band has worked out together this frame: whether its
//! nerve holds, where to run if it doesn't, whether it may strike its foe now (a token), and if not
//! where on the ring around the foe to wait. Nothing here changes position.

use crate::actor::Actor;
use crate::ai::{ACT_CAST, ACT_RECOVER, ACT_STUNNED, Foe, PackDef, angle_diff, brain_of, holds_token, off_facing};
use crate::jsmath::JsMath;
use crate::jsmath::len;

/// How close the rest of its band has to be for a goblin to count as part of a group to run to.
const GROUP: f64 = 5.0;
const DEG: f64 = std::f64::consts::PI / 180.0;

fn pack_of(a: &Actor) -> Option<&'static PackDef> {
    brain_of(a).and_then(|b| b.pack.as_ref())
}

fn same_band(list: &[Actor], a: usize, o: usize) -> bool {
    o != a && list[a].band != 0 && list[o].band == list[a].band
}

pub fn step_packs(list: &mut [Actor], foes: &[Foe]) {
    let members: Vec<usize> = (0..list.len()).filter(|&i| list[i].is_alive() && !list[i].gone && pack_of(&list[i]).is_some()).collect();
    if members.is_empty() {
        return;
    }

    // Courage first: it decides who is still fighting.
    let mut afraid = Vec::with_capacity(members.len());
    for &a in &members {
        let p = pack_of(&list[a]).unwrap();
        let me = &list[a];
        let friends = members.iter().filter(|&&o| same_band(list, a, o) && len(list[o].x - me.x, list[o].z - me.z) <= p.friend_radius).count();
        let threats = foes.iter().filter(|f| len(f.x - me.x, f.z - me.z) <= p.friend_radius).count();
        let courage = me.hp / me.max_hp + p.friend_worth * friends as f64 - p.foe_worth * threats as f64;
        afraid.push(if me.afraid { courage < p.calm_at } else { courage < p.brave_at });
    }
    for (n, &a) in members.iter().enumerate() {
        list[a].afraid = afraid[n];
        list[a].token = false;
        list[a].opening = false;
    }

    // Where the frightened run: to whichever of the band (not running itself) has the most of the
    // band around it. With nobody to run to, home.
    for &a in &members {
        if !list[a].afraid {
            continue;
        }
        let mut best: Option<usize> = None;
        let mut best_count: i64 = -1;
        for &o in &members {
            if !same_band(list, a, o) || list[o].afraid {
                continue;
            }
            let n = members.iter().filter(|&&q| q != o && list[q].band == list[o].band && len(list[q].x - list[o].x, list[q].z - list[o].z) <= GROUP).count()
                as i64;
            if n > best_count {
                best = Some(o);
                best_count = n;
            }
        }
        let (rx, rz) = match best {
            Some(o) => (list[o].x, list[o].z),
            None => (list[a].home_x, list[a].home_z),
        };
        list[a].rally_x = rx;
        list[a].rally_z = rz;
    }

    // Each foe in turn: who may strike, and where the rest wait.
    for f in foes {
        let fighting: Vec<usize> = members.iter().copied().filter(|&a| list[a].target == f.id && list[a].angry > 0 && !list[a].afraid).collect();
        if fighting.is_empty() {
            continue;
        }
        let p = pack_of(&list[fighting[0]]).unwrap();
        let dist = |a: &Actor| len(a.x - f.x, a.z - f.z);

        // Whoever is already in the middle of a strike keeps its token until it's done.
        let mut held = 0;
        for &a in &fighting {
            if holds_token(&list[a]) {
                list[a].token = true;
                held += 1;
            }
        }
        let mut waiting: Vec<usize> = fighting.iter().copied().filter(|&a| !list[a].token).collect();
        waiting.sort_by(|&u, &v| dist(&list[u]).total_cmp(&dist(&list[v])));

        // An opening makes room for one more, and the nearest that has it goes first. One more in
        // all: a foe stunned for a while doesn't let a new one in every frame.
        let exposed = f.act == ACT_RECOVER || f.act == ACT_CAST || f.act == ACT_STUNNED;
        let opener = waiting
            .iter()
            .copied()
            .find(|&a| dist(&list[a]) <= p.opening_range && (exposed || off_facing(f.facing, f.x, f.z, list[a].x, list[a].z) > p.back_arc * DEG));
        let mut left = p.tokens[fighting.len().min(p.tokens.len()) - 1] + i32::from(opener.is_some()) - held;
        if let Some(a) = opener
            && left > 0
        {
            list[a].token = true;
            list[a].opening = true;
            left -= 1;
        }
        for &a in &waiting {
            if left <= 0 {
                break;
            }
            if list[a].token {
                continue;
            }
            list[a].token = true;
            left -= 1;
        }

        // The rest wait on a ring just outside the foe's reach, bunched up behind it, in the order
        // they already stand around it.
        let mut ringers: Vec<usize> = waiting.iter().copied().filter(|&a| !list[a].token).collect();
        if ringers.is_empty() {
            continue;
        }
        let radius = f.reach + p.ring;
        let back = f.facing + std::f64::consts::PI;
        let around = |a: &Actor| angle_diff(back, (a.x - f.x).js_atan2(a.z - f.z));
        ringers.sort_by(|&u, &v| around(&list[u]).total_cmp(&around(&list[v])));
        let n = ringers.len();
        let step = (std::f64::consts::PI * 2.0 / n as f64).min(p.spread * DEG);
        for (i, &a) in ringers.iter().enumerate() {
            let angle = back + (i as f64 - (n as f64 - 1.0) / 2.0) * step;
            list[a].slot_x = f.x + angle.js_sin() * radius;
            list[a].slot_z = f.z + angle.js_cos() * radius;
        }
    }
}
