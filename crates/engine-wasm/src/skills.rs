//! What a build's skills make of its attacks, spells and movement skills, for the page's skill book,
//! aim circles and spells (src/engine/skills.ts): the engine's own fold (crates/engine/src/skills.rs
//! resolve_skills), so the page keeps no copy of it.

use ruina_engine::skills::{Channel, SKILL_WORDS, SkillSet, resolve_skills};
use serde_json::{Value, json};

use super::{give, text};

/// What the learned set and levels at `p` (`n` bytes of JSON: `skills`, the set's words; `levels`,
/// one per skill-book entry, a missing one level 1) make, at `out_ptr()` in the page's
/// ResolvedSkills shape (src/content/skills.ts): each weapon's, ability's and movement skill's
/// channels, one per stat, and what the set grants. Returns its length, or 0 if it isn't such a set.
///
/// # Safety
/// `p..p + n` lies in room `alloc` gave.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn skills_resolve(p: *const u8, n: usize) -> usize {
    let Ok(v) = serde_json::from_str::<Value>(unsafe { text(p, n) }) else { return 0 };
    let Some(words) = v.get("skills").and_then(Value::as_array) else { return 0 };
    let mut skills: SkillSet = [0; SKILL_WORDS];
    for (k, w) in words.iter().take(SKILL_WORDS).enumerate() {
        let Some(w) = w.as_u64().and_then(|w| u32::try_from(w).ok()) else { return 0 };
        skills[k] = w;
    }
    let levels: Vec<u32> =
        v.get("levels").and_then(Value::as_array).into_iter().flatten().map(|l| l.as_u64().and_then(|l| u32::try_from(l).ok()).unwrap_or(1)).collect();
    let r = resolve_skills(&skills, &levels);
    let channels = |of: &[Vec<Channel>]| -> Value {
        of.iter().map(|stats| stats.iter().map(|c| json!({ "flat": c.flat, "inc": c.inc, "more": c.more })).collect::<Vec<_>>()).collect()
    };
    give(
        json!({
            "weapon": channels(&r.weapon),
            "ability": channels(&r.ability),
            "move": channels(&r.moves),
            "combos": r.combos,
            "weapons": r.weapons,
            "abilities": r.abilities,
            "movement": r.movement,
        })
        .to_string(),
    )
}
