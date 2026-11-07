//! The content the rules read: the bundles `npm run content` builds into shared/ from content/,
//! compiled in. Others can be given in their place before anything has been read (`give`): the tests
//! that add content as data alone play it through the engine that way (tests/unit/newContent.test.ts,
//! through the WebAssembly's `content_use`).

use std::collections::BTreeMap;
use std::sync::OnceLock;

static GIVEN: OnceLock<BTreeMap<String, String>> = OnceLock::new();

/// Gives bundles to read in place of the compiled ones, each by its path under shared/
/// ("items.json", "regions/emberholm.json"). Only before the first read: false once anything has been
/// read, or bundles were given already.
pub fn give(bundles: BTreeMap<String, String>) -> bool {
    GIVEN.set(bundles).is_ok()
}

/// The bundle at `path` under shared/: the one given, or else the one compiled in.
pub fn bundle(path: &str, compiled: &'static str) -> &'static str {
    given(path).unwrap_or(compiled)
}

/// The bundle given at `path` under shared/, if one was: in place of a compiled one, or beside them
/// (the regions of a world given whole, as the tests' fixture world is).
pub fn given(path: &str) -> Option<&'static str> {
    GIVEN.get_or_init(BTreeMap::new).get(path).map(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bundle_nobody_gave_is_the_one_compiled_in_and_none_can_be_given_once_one_is_read() {
        assert_eq!(bundle("no/such.json", "compiled"), "compiled");
        assert!(!give(BTreeMap::from([("no/such.json".to_string(), "given".to_string())])));
        assert_eq!(bundle("no/such.json", "compiled"), "compiled");
    }
}
