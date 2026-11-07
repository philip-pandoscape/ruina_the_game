//! How a message's body is written on a link.
//!
//! World-api's messages are made for JSON as much as for a link: they hold `serde_json::Value`s,
//! internally tagged enums and fields left out when empty, which a format without field names
//! (postcard, bincode) would misread or refuse. So a body is written in a format that names what
//! it holds: MessagePack with field names (the default), or JSON. Measured on world-api's own
//! messages (`tests/numbers.rs`, the numbers in `.plans/refactor/reports/multiserver.md`),
//! MessagePack is the smaller of the two and the quicker to read, and it keeps what JSON can't
//! (infinities, NaN, bytes).

use serde::Serialize;
use serde::de::DeserializeOwned;

/// How bodies are written. Both ends of a link must use the same: it's part of the protocol their
/// handshake checks.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Encoding {
    /// MessagePack, structs as maps with their field names (rmp-serde's `to_vec_named`).
    #[default]
    MessagePack,
    /// JSON (serde_json): bigger and slower, but readable where a link is being watched.
    Json,
}

/// A message that couldn't be written or read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodecError(pub String);

impl std::fmt::Display for CodecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CodecError {}

impl Encoding {
    /// Its name in a handshake.
    pub fn name(self) -> &'static str {
        match self {
            Encoding::MessagePack => "msgpack",
            Encoding::Json => "json",
        }
    }

    pub fn encode<M: Serialize>(self, m: &M) -> Result<Vec<u8>, CodecError> {
        match self {
            Encoding::MessagePack => rmp_serde::to_vec_named(m).map_err(|e| CodecError(e.to_string())),
            Encoding::Json => serde_json::to_vec(m).map_err(|e| CodecError(e.to_string())),
        }
    }

    pub fn decode<M: DeserializeOwned>(self, b: &[u8]) -> Result<M, CodecError> {
        match self {
            Encoding::MessagePack => rmp_serde::from_slice(b).map_err(|e| CodecError(e.to_string())),
            Encoding::Json => serde_json::from_slice(b).map_err(|e| CodecError(e.to_string())),
        }
    }

    /// A message written and read back, as a link carries it: for tests that hold a message type
    /// to crossing whole.
    pub fn round_trip<M: Serialize + DeserializeOwned>(self, m: &M) -> Result<M, CodecError> {
        self.decode(&self.encode(m)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::{Value, json};

    /// What world-api's messages hold that a format without field names gets wrong.
    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Awkward {
        life: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        first: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        second: Option<u32>,
        tagged: Tagged,
        far: f64,
        raw: [u8; 10],
    }

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    #[serde(tag = "kind", rename_all = "camelCase")]
    enum Tagged {
        Channel { region: String, n: u32 },
        Copy { instance: String },
    }

    fn awkward(far: f64) -> Awkward {
        Awkward {
            life: json!({ "state": { "coins": 12, "bag": [1, 2, { "x": 1.5 }] }, "player": null }),
            first: None,
            second: Some(9),
            tagged: Tagged::Channel { region: "emberholm".into(), n: 2 },
            far,
            raw: [1, 2, 3, 4, 5, 6, 7, 8, 9, 255],
        }
    }

    #[test]
    fn values_tags_and_skipped_fields_cross_whole() {
        for e in [Encoding::MessagePack, Encoding::Json] {
            let m = awkward(2.5);
            assert_eq!(e.round_trip(&m).unwrap(), m, "{e:?}");
        }
    }

    #[test]
    fn only_messagepack_keeps_an_infinity() {
        let m = awkward(f64::INFINITY);
        assert_eq!(Encoding::MessagePack.round_trip(&m).unwrap(), m);
        // JSON writes it as null, which doesn't read back as a number.
        assert!(Encoding::Json.round_trip(&m).is_err());
    }
}
