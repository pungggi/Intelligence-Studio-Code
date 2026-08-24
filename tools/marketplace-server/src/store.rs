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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionEntry {
    pub id: String,
    pub versions: Vec<VersionEntry>,
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

    /// Semantic version `x.y.z` with optional pre-release suffix.
    pub fn valid_version(v: &str) -> bool {
        let (core, pre) = match v.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (v, None),
        };
        let parts: Vec<&str> = core.split('.').collect();
        if parts.len() != 3 || !parts.iter().all(|p| p.parse::<u64>().is_ok()) {
            return false;
        }
        pre.map_or(true, |p| {
            !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        })
    }

    /// Store a package. Returns the recorded version entry.
    pub fn publish(&self, id: &str, version: &str, bytes: &[u8]) -> Result<VersionEntry, PublishError> {
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

        let mut index = self.index.lock().unwrap();

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
        };

        let ext = index.entry(id.to_string()).or_insert(ExtensionEntry {
            id: id.to_string(),
            versions: Vec::new(),
        });
        ext.versions.push(entry.clone());
        ext.versions.sort_by(|a, b| version_key(&b.version).cmp(&version_key(&a.version)));

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

/// Sort key so `1.0.0` > `1.0.0-rc.1` > `0.9.0`, newest first.
fn version_key(v: &str) -> (u64, u64, u64, u8) {
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (v, None),
    };
    let mut parts = core.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
    let major = parts.next().unwrap_or(0);
    let minor = parts.next().unwrap_or(0);
    let patch = parts.next().unwrap_or(0);
    let is_release = u8::from(pre.is_none());
    (major, minor, patch, is_release)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store(label: &str) -> (Store, PathBuf) {
        let dir = std::env::temp_dir().join(format!("ccmp-test-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::open(&dir).unwrap();
        (store, dir)
    }

    #[test]
    fn publish_and_fetch_roundtrip() {
        let (store, dir) = tmp_store("roundtrip");
        let entry = store.publish("corecode.hello-wasm", "0.1.0", b"package-bytes").unwrap();
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
        store.publish("pub.a", "1.0.0", b"x").unwrap();
        assert!(matches!(
            store.publish("pub.a", "1.0.0", b"y"),
            Err(PublishError::Conflict)
        ));
        // New version is fine
        assert!(store.publish("pub.a", "1.0.1", b"y").is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_bad_ids_and_versions() {
        let (store, dir) = tmp_store("badids");
        for id in ["no-dot", "../evil", "a.b.c", "-bad.x"] {
            assert!(matches!(
                store.publish(id, "1.0.0", b"x"),
                Err(PublishError::Invalid(_))
            ));
        }
        for v in ["1.2", "latest", "1.2.x", "1.2.3-", "1.2.3.4"] {
            assert!(matches!(
                store.publish("pub.a", v, b"x"),
                Err(PublishError::Invalid(_))
            ));
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn latest_orders_by_semver() {
        let (store, dir) = tmp_store("semver");
        for v in ["1.0.0", "0.9.0", "1.0.0-rc.1", "1.1.0"] {
            store.publish("pub.a", v, b"x").unwrap();
        }
        assert_eq!(store.latest("pub.a").unwrap().version, "1.1.0");
        // 1.0.0 release ranks above 1.0.0-rc.1
        let versions: Vec<String> = store.get("pub.a").unwrap().versions.iter().map(|v| v.version.clone()).collect();
        assert_eq!(versions, ["1.1.0", "1.0.0", "1.0.0-rc.1", "0.9.0"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn index_survives_reopen() {
        let (store, dir) = tmp_store("reopen");
        store.publish("pub.a", "1.0.0", b"persisted").unwrap();
        drop(store);
        let reopened = Store::open(&dir).unwrap();
        assert!(reopened.get("pub.a").is_some());
        let (bytes, _) = reopened.package("pub.a", "1.0.0").unwrap();
        assert_eq!(bytes, b"persisted");
        std::fs::remove_dir_all(&dir).ok();
    }
}
