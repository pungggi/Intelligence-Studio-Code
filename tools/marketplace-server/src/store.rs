//! Filesystem-backed package store for the CoreCode marketplace.
//!
//! Layout under the data directory:
//!
//! ```text
//! <data>/
//! ├── index.json                  # metadata for every extension version
//! └── packages/<id>/<version>.ccext
//! ```
//!
//! The store is deliberately simple: an in-memory index (built at startup,
//! mutated behind a `Mutex`) persisted atomically to `index.json`
//! (write-to-temp + rename). Package bytes are immutable once written.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Hard cap on accepted package size (matches the host's VSIX limit).
pub const MAX_PACKAGE_SIZE: usize = 50 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionEntry {
    pub version: String,
    pub sha256: String,
    pub size: u64,
    pub published_at: String,
    /// base64 ed25519 signature over the package bytes, when signed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// base64 ed25519 public key that produced `signature`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signed_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionEntry {
    pub id: String,
    pub versions: Vec<VersionEntry>,
    /// Publisher identity key (base64) — pinned by the first signed publish;
    /// subsequent publishes must be signed with the same key (TOFU).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_key: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct IndexFile {
    #[serde(default)]
    extensions: BTreeMap<String, ExtensionEntry>,
}

#[derive(Debug)]
pub enum PublishError {
    /// Extension id / version failed validation.
    Invalid(String),
    /// Signature missing, invalid, or signed by the wrong key.
    Forbidden(String),
    /// This exact id+version is already published.
    Conflict,
    /// Filesystem failure.
    Io(String),
}

pub struct Store {
    data_dir: PathBuf,
    index: Mutex<BTreeMap<String, ExtensionEntry>>,
}

impl Store {
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir.join("packages"))
            .map_err(|e| format!("cannot create packages dir: {e}"))?;
        let index = if data_dir.join("index.json").exists() {
            let raw = std::fs::read_to_string(data_dir.join("index.json"))
                .map_err(|e| format!("cannot read index.json: {e}"))?;
            serde_json::from_str::<IndexFile>(&raw)
                .map_err(|e| format!("corrupt index.json: {e}"))?
                .extensions
        } else {
            BTreeMap::new()
        };
        Ok(Self {
            data_dir: data_dir.to_path_buf(),
            index: Mutex::new(index),
        })
    }

    /// Validate an extension id segment — same rules as the publish CLI.
    fn valid_segment(part: &str) -> bool {
        !part.is_empty()
            && !part.starts_with('-')
            && !part.ends_with('-')
            && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    }

    pub fn valid_id(id: &str) -> bool {
        match id.split_once('.') {
            Some((publisher, name)) => Self::valid_segment(publisher) && Self::valid_segment(name),
            None => false,
        }
    }

    /// Numeric core component: digits only, no leading zeros (`01` invalid,
    /// `0` valid) per semver §2.
    fn valid_core_part(p: &str) -> bool {
        !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) && (p.len() == 1 || !p.starts_with('0'))
    }

    /// Semantic version `x.y.z` with optional pre-release suffix.
    /// (Build metadata `+meta` is intentionally not accepted — versions are
    /// used as package filenames and offer no precedence.)
    pub fn valid_version(v: &str) -> bool {
        let Some((core, pre)) = v.split_once('-') else {
            return v.split('.').count() == 3 && v.split('.').all(Self::valid_core_part);
        };
        if core.split('.').count() != 3 || !core.split('.').all(Self::valid_core_part) {
            return false;
        }
        !pre.is_empty() && pre.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    }

    /// Store a package. `sig` is `(pubkey_b64, signature_b64)` for signed
    /// publishes, `None` for unsigned ones (rejected once a key is pinned).
    /// Returns the recorded version entry.
    pub fn publish(
        &self,
        id: &str,
        version: &str,
        bytes: &[u8],
        sig: Option<(&str, &str)>,
    ) -> Result<VersionEntry, PublishError> {
        if !Self::valid_id(id) {
            return Err(PublishError::Invalid(format!("invalid extension id '{id}'")));
        }
        if !Self::valid_version(version) {
            return Err(PublishError::Invalid(format!("invalid version '{version}'")));
        }
        if bytes.is_empty() {
            return Err(PublishError::Invalid("empty package body".into()));
        }
        if bytes.len() > MAX_PACKAGE_SIZE {
            return Err(PublishError::Invalid(format!(
                "package is {} bytes — limit is {}",
                bytes.len(),
                MAX_PACKAGE_SIZE
            )));
        }

        // Verify the signature over the package bytes before anything else.
        if let Some((pubkey, signature)) = sig {
            if let Err(e) = verify_signature(pubkey, signature, bytes) {
                return Err(PublishError::Forbidden(format!("bad signature: {e}")));
            }
        }

        let mut index = self.index.lock().unwrap();

        // Key pinning: the first signed publish fixes the publisher identity;
        // later publishes must be signed with the same key (and cannot be
        // unsigned once pinned).
        let pinned = index.get(id).and_then(|e| e.pinned_key.clone());
        let signed_by = match (sig, &pinned) {
            (Some((pubkey, _)), Some(existing)) if pubkey != existing => {
                return Err(PublishError::Forbidden(format!(
                    "extension '{id}' is pinned to a different signing key"
                )));
            }
            (None, Some(_)) => {
                return Err(PublishError::Forbidden(format!(
                    "extension '{id}' is pinned to a signing key — signature required"
                )));
            }
            (Some((pubkey, _)), _) => Some(pubkey.to_string()),
            (None, None) => None,
        };

        // Reject duplicate id+version (immutable versions).
        if let Some(existing) = index.get(id) {
            if existing.versions.iter().any(|v| v.version == version) {
                return Err(PublishError::Conflict);
            }
        }

        // Write package bytes first; only then mutate the index.
        let pkg_dir = self.data_dir.join("packages").join(id);
        std::fs::create_dir_all(&pkg_dir).map_err(|e| PublishError::Io(format!("{e}")))?;
        let pkg_path = pkg_dir.join(format!("{version}.ccext"));
        let tmp_path = pkg_dir.join(format!(".{version}.ccext.tmp"));
        std::fs::write(&tmp_path, bytes)
            .map_err(|e| PublishError::Io(format!("write package: {e}")))?;
        std::fs::rename(&tmp_path, &pkg_path)
            .map_err(|e| PublishError::Io(format!("persist package: {e}")))?;

        let entry = VersionEntry {
            version: version.to_string(),
            sha256: hex::encode(Sha256::digest(bytes)),
            size: bytes.len() as u64,
            published_at: Utc::now().to_rfc3339(),
            signature: sig.map(|(_, s)| s.to_string()),
            signed_by: signed_by.clone(),
        };

        let ext = index.entry(id.to_string()).or_insert(ExtensionEntry {
            id: id.to_string(),
            versions: Vec::new(),
            pinned_key: None,
        });
        ext.versions.push(entry.clone());
        ext.versions.sort_by(|a, b| version_cmp(&b.version, &a.version)); // newest first
        if ext.pinned_key.is_none() {
            ext.pinned_key = signed_by;
        }

        self.persist(&index)?;
        Ok(entry)
    }

    fn persist(&self, index: &BTreeMap<String, ExtensionEntry>) -> Result<(), PublishError> {
        let file = IndexFile {
            extensions: index.clone(),
        };
        let raw = serde_json::to_vec_pretty(&file)
            .map_err(|e| PublishError::Io(format!("serialize index: {e}")))?;
        let path = self.data_dir.join("index.json");
        let tmp = self.data_dir.join(".index.json.tmp");
        std::fs::write(&tmp, &raw).map_err(|e| PublishError::Io(format!("write index: {e}")))?;
        std::fs::rename(&tmp, &path)
            .map_err(|e| PublishError::Io(format!("persist index: {e}")))?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<ExtensionEntry> {
        self.index.lock().unwrap().get(id).cloned()
    }

    /// Latest version entry (highest semver, pre-releases rank below release).
    pub fn latest(&self, id: &str) -> Option<VersionEntry> {
        self.get(id).and_then(|e| e.versions.first().cloned())
    }

    pub fn search(&self, query: &str, offset: usize, limit: usize) -> Vec<ExtensionEntry> {
        let q = query.to_lowercase();
        self.index
            .lock()
            .unwrap()
            .values()
            .filter(|e| q.is_empty() || e.id.to_lowercase().contains(&q))
            .skip(offset)
            .take(limit)
            .cloned()
            .collect()
    }

    /// Package bytes for id+version, with the recorded sha256.
    pub fn package(&self, id: &str, version: &str) -> Option<(Vec<u8>, String)> {
        // Look up in the index first — never serve unindexed paths.
        let sha = self
            .get(id)?
            .versions
            .into_iter()
            .find(|v| v.version == version)?
            .sha256;
        let bytes = std::fs::read(self.data_dir.join("packages").join(id).join(format!("{version}.ccext"))).ok()?;
        Some((bytes, sha))
    }
}

/// Verify an ed25519 signature (base64) over `bytes` with a base64 public key.
fn verify_signature(pubkey_b64: &str, signature_b64: &str, bytes: &[u8]) -> Result<(), String> {
    use base64::Engine;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    let engine = base64::engine::general_purpose::STANDARD;
    let decode = |s: &str| engine.decode(s.trim()).map_err(|e| format!("invalid base64: {e}"));

    let key_bytes: [u8; 32] = decode(pubkey_b64)?
        .try_into()
        .map_err(|v: Vec<u8>| format!("public key must be 32 bytes, got {}", v.len()))?;
    let key = VerifyingKey::from_bytes(&key_bytes).map_err(|e| format!("invalid public key: {e}"))?;
    let sig_bytes: [u8; 64] = decode(signature_b64)?
        .try_into()
        .map_err(|v: Vec<u8>| format!("signature must be 64 bytes, got {}", v.len()))?;
    let signature = Signature::from_bytes(&sig_bytes);
    key.verify(bytes, &signature).map_err(|e| format!("verification failed: {e}"))
}

/// Full semver precedence comparison (semver §11): core numeric fields first;
/// a release outranks any pre-release; pre-release identifiers compare
/// numerically when both numeric (so `beta.11` > `beta.2`), numeric ranks
/// below alphanumeric, and more identifiers rank higher on equal prefixes.
fn split_version(v: &str) -> (&str, Option<&str>) {
    match v.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (v, None),
    }
}

fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (a_core, a_pre) = split_version(a);
    let (b_core, b_pre) = split_version(b);

    let nums = |core: &str| {
        let mut it = core.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
        [it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0)]
    };
    let core_ord = nums(a_core).cmp(&nums(b_core));
    if core_ord != Ordering::Equal {
        return core_ord;
    }

    match (a_pre, b_pre) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater, // release > pre-release
        (Some(_), None) => Ordering::Less,
        (Some(a), Some(b)) => cmp_pre_release(a, b),
    }
}

fn cmp_pre_release(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let a_ids: Vec<&str> = a.split('.').collect();
    let b_ids: Vec<&str> = b.split('.').collect();
    for (x, y) in a_ids.iter().zip(b_ids.iter()) {
        let ord = match (x.parse::<u64>().ok(), y.parse::<u64>().ok()) {
            (Some(xn), Some(yn)) => xn.cmp(&yn),       // numeric < numeric
            (Some(_), None) => Ordering::Less,        // numeric < alphanumeric
            (None, Some(_)) => Ordering::Greater,
            (None, None) => x.cmp(y),                 // ASCII lexical
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    a_ids.len().cmp(&b_ids.len()) // more identifiers > fewer
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use rand::rngs::OsRng;

    fn b64(bytes: &[u8]) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn sign_with(key: &SigningKey, bytes: &[u8]) -> (String, String) {
        (
            b64(key.verifying_key().as_bytes()),
            b64(&key.sign(bytes).to_bytes()),
        )
    }

    fn tmp_store(label: &str) -> (Store, PathBuf) {
        let dir = std::env::temp_dir().join(format!("ccmp-test-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::open(&dir).unwrap();
        (store, dir)
    }

    #[test]
    fn publish_and_fetch_roundtrip() {
        let (store, dir) = tmp_store("roundtrip");
        let entry = store.publish("corecode.hello-wasm", "0.1.0", b"package-bytes", None).unwrap();
        assert_eq!(entry.size, 13);
        assert_eq!(entry.sha256.len(), 64);

        let (bytes, sha) = store.package("corecode.hello-wasm", "0.1.0").unwrap();
        assert_eq!(bytes, b"package-bytes");
        assert_eq!(sha, entry.sha256);

        let meta = store.get("corecode.hello-wasm").unwrap();
        assert_eq!(meta.versions.len(), 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn duplicate_version_conflicts() {
        let (store, dir) = tmp_store("dup");
        store.publish("pub.a", "1.0.0", b"x", None).unwrap();
        assert!(matches!(
            store.publish("pub.a", "1.0.0", b"y", None),
            Err(PublishError::Conflict)
        ));
        // New version is fine
        assert!(store.publish("pub.a", "1.0.1", b"y", None).is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_bad_ids_and_versions() {
        let (store, dir) = tmp_store("badids");
        for id in ["no-dot", "../evil", "a.b.c", "-bad.x"] {
            assert!(matches!(
                store.publish(id, "1.0.0", b"x", None),
                Err(PublishError::Invalid(_))
            ));
        }
        for v in ["1.2", "latest", "1.2.x", "1.2.3-", "1.2.3.4"] {
            assert!(matches!(
                store.publish("pub.a", v, b"x", None),
                Err(PublishError::Invalid(_))
            ));
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn latest_orders_by_semver() {
        let (store, dir) = tmp_store("semver");
        // Ordered per semver §11 — including the cases a naive sort gets wrong
        for v in [
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11", // numeric: 11 > 2
            "1.0.0-rc.1",
            "1.0.0",
            "1.1.0",
            "0.9.0",
        ] {
            store.publish("pub.a", v, b"x", None).unwrap();
        }
        assert_eq!(store.latest("pub.a").unwrap().version, "1.1.0");
        let versions: Vec<String> = store.get("pub.a").unwrap().versions.iter().map(|v| v.version.clone()).collect();
        assert_eq!(
            versions,
            ["1.1.0", "1.0.0", "1.0.0-rc.1", "1.0.0-beta.11", "1.0.0-beta.2", "1.0.0-beta", "1.0.0-alpha.beta", "1.0.0-alpha.1", "1.0.0-alpha", "0.9.0"]
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_leading_zero_versions() {
        let (store, dir) = tmp_store("leadingzero");
        for v in ["01.0.0", "1.00.0", "1.0.000", "1.0.0-0"] {
            // `1.0.0-0` is VALID per semver (single zero pre-release identifier)
            let expect_err = v != "1.0.0-0";
            let result = store.publish("pub.a", v, b"x", None);
            assert_eq!(result.is_err(), expect_err, "version {v}: err={result:?}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn index_survives_reopen() {
        let (store, dir) = tmp_store("reopen");
        store.publish("pub.a", "1.0.0", b"persisted", None).unwrap();
        drop(store);
        let reopened = Store::open(&dir).unwrap();
        assert!(reopened.get("pub.a").is_some());
        let (bytes, _) = reopened.package("pub.a", "1.0.0").unwrap();
        assert_eq!(bytes, b"persisted");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn signed_publish_records_signature_and_pins_key() {
        let (store, dir) = tmp_store("sig-pin");
        let key = SigningKey::generate(&mut OsRng);
        let (pubkey, sig) = sign_with(&key, b"pkg");

        let entry = store.publish("pub.a", "1.0.0", b"pkg", Some((&pubkey, &sig))).unwrap();
        assert_eq!(entry.signed_by.as_deref(), Some(pubkey.as_str()));
        assert!(entry.signature.is_some());
        assert_eq!(store.get("pub.a").unwrap().pinned_key.as_deref(), Some(pubkey.as_str()));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tampered_signature_rejected() {
        let (store, dir) = tmp_store("sig-tamper");
        let key = SigningKey::generate(&mut OsRng);
        let (pubkey, sig) = sign_with(&key, b"pkg");
        // signature over different bytes
        let result = store.publish("pub.a", "1.0.0", b"other", Some((&pubkey, &sig)));
        assert!(matches!(result, Err(PublishError::Forbidden(_))));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn key_pinning_enforced() {
        let (store, dir) = tmp_store("sig-enforce");
        let key1 = SigningKey::generate(&mut OsRng);
        let (pk1, sig1) = sign_with(&key1, b"pkg");
        store.publish("pub.a", "1.0.0", b"pkg", Some((&pk1, &sig1))).unwrap();

        // different key → rejected
        let key2 = SigningKey::generate(&mut OsRng);
        let (pk2, sig2) = sign_with(&key2, b"pkg2");
        assert!(matches!(
            store.publish("pub.a", "1.0.1", b"pkg2", Some((&pk2, &sig2))),
            Err(PublishError::Forbidden(_))
        ));
        // unsigned once pinned → rejected
        assert!(matches!(
            store.publish("pub.a", "1.0.1", b"pkg2", None),
            Err(PublishError::Forbidden(_))
        ));
        // same key, new version → accepted
        let (_, sig1b) = sign_with(&key1, b"pkg2");
        assert!(store.publish("pub.a", "1.0.1", b"pkg2", Some((&pk1, &sig1b))).is_ok());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unsigned_publish_still_allowed_for_unpinned_extensions() {
        let (store, dir) = tmp_store("sig-optional");
        assert!(store.publish("pub.a", "1.0.0", b"pkg", None).is_ok());
        assert!(store.get("pub.a").unwrap().pinned_key.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }
}
