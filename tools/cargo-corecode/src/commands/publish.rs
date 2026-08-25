//! `cargo corecode publish` — build a release `.ccext` and upload it to a
//! CoreCode marketplace registry.
//!
//! The registry API is intentionally minimal (a single binary POST, see
//! `docs/plans/05-roadmap.md` Phase 6):
//!
//! ```text
//! POST {registry}/api/v1/publish
//! Authorization: Bearer <token>
//! Content-Type: application/octet-stream
//! X-CoreCode-Extension: <publisher.name>
//! X-CoreCode-Version: <semver>
//!
//! <.ccext bytes>
//! ```
//!
//! Success: 200/201. Failures: 401/403 bad token, 409 version already
//! published, anything else is an error with the response body surfaced.
//!
//! Optional authenticated publishing (ed25519): when a signing key is
//! available (`--signing-key`, or `$CORECODE_SIGNING_KEY`), the package bytes
//! are signed and sent with `X-CoreCode-Signature` + `X-CoreCode-Pubkey`.
//! Registries pin the first key per extension id and reject mismatches.

use crate::manifest::{self, CoreCodeManifest};
use std::path::PathBuf;
use std::time::Duration;

/// Default public registry (Phase 6 — may not be live yet).
const DEFAULT_REGISTRY: &str = "https://marketplace.corecode.dev";

pub fn run(
    token: Option<&str>,
    registry: Option<&str>,
    signing_key: Option<&str>,
    dry_run: bool,
) -> anyhow::Result<()> {
    let m = manifest::load()?;
    validate(&m)?;

    // Always publish a fresh release build — same rule as `cargo publish`.
    crate::commands::build::run("corecode", true)?;

    let package: PathBuf = format!("{}-{}.ccext", m.extension.id, m.extension.version).into();
    anyhow::ensure!(
        package.exists(),
        "package not found at {}",
        package.display()
    );
    let bytes = std::fs::read(&package)?;
    let size_kb = (bytes.len() as f64 / 1024.0).ceil() as u64;

    println!();
    println!("  extension : {}", m.extension.id);
    println!("  version   : {}", m.extension.version);
    println!("  package   : {} ({size_kb} KB)", package.display());

    // Signing key: flag, then env. May be a path or a literal base64 seed.
    let signing_key = signing_key
        .map(|s| s.to_string())
        .or_else(|| std::env::var("CORECODE_SIGNING_KEY").ok())
        .filter(|s| !s.is_empty());
    let (signing, pubkey_b64, signature_b64) = match &signing_key {
        Some(spec) => {
            let key = crate::signing::load_signing_key(spec)?;
            let sig = crate::signing::sign(&key, &bytes);
            let pubkey = crate::signing::encode(key.verifying_key().as_bytes());
            println!("  signed by : {pubkey}");
            (true, pubkey, sig)
        }
        None => (false, String::new(), String::new()),
    };

    if dry_run {
        println!("  dry run   : package built and validated, upload skipped");
        return Ok(());
    }

    let token = token
        .map(|s| s.to_string())
        .or_else(|| std::env::var("CORECODE_TOKEN").ok())
        .filter(|s| !s.is_empty());
    anyhow::ensure!(
        token.is_some(),
        "no API token — pass --token or set CORECODE_TOKEN"
    );
    let token = token.unwrap();

    let registry = registry
        .map(|s| s.trim_end_matches('/').to_string())
        .or_else(|| std::env::var("CORECODE_REGISTRY").ok().map(|s| s.trim_end_matches('/').to_string()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_REGISTRY.to_string());

    let url = format!("{registry}/api/v1/publish");
    println!("  registry  : {url}");

    // No redirects: following one would forward the Bearer token and the
    // signature headers to an arbitrary host. Operators should point
    // --registry at the final URL.
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(Duration::from_secs(300))
        .build();
    let mut request = agent
        .post(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/octet-stream")
        .set("X-CoreCode-Extension", &m.extension.id)
        .set("X-CoreCode-Version", &m.extension.version);
    if signing {
        request = request
            .set("X-CoreCode-Signature", &signature_b64)
            .set("X-CoreCode-Pubkey", &pubkey_b64);
    }
    let response = request.send_bytes(&bytes);

    match response {
        Ok(resp) => {
            let status = resp.status();
            let body = resp.into_string().unwrap_or_default();
            println!("  published : HTTP {status}");
            if !body.trim().is_empty() {
                println!("  {body}");
            }
            Ok(())
        }
        Err(ureq::Error::Status(401, _)) => {
            anyhow::bail!("authentication failed — check your token (HTTP 401)")
        }
        Err(ureq::Error::Status(403, resp)) => {
            // 403 is either a bad token or a signing-key rejection — surface
            // the registry's explanation (e.g. key pinning mismatch).
            let body = resp.into_string().unwrap_or_default();
            let detail = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(|s| s.to_string()))
                .unwrap_or(body);
            anyhow::bail!("forbidden: {detail}")
        }
        Err(ureq::Error::Status(409, _)) => anyhow::bail!(
            "version {} of {} is already published — bump the version in corecode.toml",
            m.extension.version,
            m.extension.id
        ),
        Err(ureq::Error::Status(status, resp)) if (300..400).contains(&status) => {
            let location = resp.header("location").unwrap_or("(no location)");
            anyhow::bail!(
                "registry redirected (HTTP {status} → {location}) — redirects are disabled to \
                 protect the token and signature headers; set --registry to the final URL"
            )
        }
        Err(ureq::Error::Status(status, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            anyhow::bail!("registry rejected the package: HTTP {status}\n  {body}")
        }
        Err(ureq::Error::Transport(t)) => anyhow::bail!(
            "could not reach registry {registry}: {t}\n  \
             Is the marketplace running? Set --registry or CORECODE_REGISTRY, \
             or use --dry-run to validate the package without uploading."
        ),
    }
}

/// Validate manifest fields that the registry requires.
///
/// - `extension.id` must be exactly `publisher.name` — non-empty segments,
///   alphanumeric plus `-`/`_`, no path characters, no leading/trailing `-`.
/// - `extension.version` must be semantic (`x.y.z` with optional pre-release).
pub fn validate(m: &CoreCodeManifest) -> anyhow::Result<()> {
    let id = m.extension.id.as_str();
    let (publisher, name) = id
        .split_once('.')
        .ok_or_else(|| anyhow::anyhow!("extension id must be 'publisher.name', got '{id}'"))?;
    for (label, part) in [("publisher", publisher), ("name", name)] {
        anyhow::ensure!(
            is_valid_segment(part),
            "invalid {label} '{part}' in extension id '{id}': \
             use alphanumeric characters, '-' and '_', no path separators"
        );
    }
    anyhow::ensure!(
        is_valid_version(&m.extension.version),
        "invalid version '{}' — expected semantic version like 1.2.3 (pre-release suffix allowed)",
        m.extension.version
    );
    Ok(())
}

fn is_valid_segment(part: &str) -> bool {
    !part.is_empty()
        && !part.starts_with('-')
        && !part.ends_with('-')
        && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn is_valid_version(v: &str) -> bool {
    // Mirrors the registry's rules exactly (server `valid_version`):
    // x.y.z numeric core without leading zeros + optional pre-release suffix
    // whose numeric identifiers also carry no leading zeros (semver §9).
    let valid_core_part = |p: &str| {
        !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) && (p.len() == 1 || !p.starts_with('0'))
    };
    let valid_pre_part = |p: &str| {
        let chars_ok = !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        let numeric = !p.is_empty() && p.chars().all(|c| c.is_ascii_digit());
        chars_ok && (!numeric || p.len() == 1 || !p.starts_with('0'))
    };
    let Some((core, pre)) = v.split_once('-') else {
        return v.split('.').count() == 3 && v.split('.').all(valid_core_part);
    };
    if core.split('.').count() != 3 || !core.split('.').all(valid_core_part) {
        return false;
    }
    !pre.is_empty() && pre.split('.').all(valid_pre_part)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{Capabilities, Entry, ExtensionMeta};

    fn manifest_with(id: &str, version: &str) -> CoreCodeManifest {
        CoreCodeManifest {
            extension: ExtensionMeta {
                id: id.to_string(),
                name: "Test".to_string(),
                version: version.to_string(),
            },
            entry: Entry::default(),
            capabilities: Capabilities::default(),
            languages: Default::default(),
            grammar: None,
        }
    }

    #[test]
    fn valid_manifest_passes() {
        assert!(validate(&manifest_with("corecode.hello-wasm", "0.1.0")).is_ok());
        assert!(validate(&manifest_with("my-pub.my_ext", "1.2.3-beta.1")).is_ok());
    }

    #[test]
    fn rejects_ids_without_publisher() {
        assert!(validate(&manifest_with("hello-wasm", "0.1.0")).is_err());
        assert!(validate(&manifest_with("a.b.c", "0.1.0")).is_err());
        assert!(validate(&manifest_with(".name", "0.1.0")).is_err());
        assert!(validate(&manifest_with("pub.", "0.1.0")).is_err());
    }

    #[test]
    fn rejects_path_characters_in_id() {
        assert!(validate(&manifest_with("../evil", "0.1.0")).is_err());
        assert!(validate(&manifest_with("a/b.c", "0.1.0")).is_err());
        assert!(validate(&manifest_with("-bad-.name", "0.1.0")).is_err());
    }

    #[test]
    fn rejects_bad_versions() {
        assert!(validate(&manifest_with("pub.name", "1.2")).is_err());
        assert!(validate(&manifest_with("pub.name", "latest")).is_err());
        assert!(validate(&manifest_with("pub.name", "1.2.x")).is_err());
        assert!(validate(&manifest_with("pub.name", "1.2.3-")).is_err());
        // v-prefix, leading zeros (core and pre-release), and 4-part cores all
        // diverge from the registry's rules — reject locally instead of
        // failing at upload.
        assert!(validate(&manifest_with("pub.name", "v1.2.3")).is_err());
        assert!(validate(&manifest_with("pub.name", "01.2.3")).is_err());
        assert!(validate(&manifest_with("pub.name", "1.2.3.4")).is_err());
        assert!(validate(&manifest_with("pub.name", "1.2.3-01")).is_err());
        assert!(validate(&manifest_with("pub.name", "1.2.3-beta.02")).is_err());
        // single-zero pre-release identifier is valid semver
        assert!(validate(&manifest_with("pub.name", "1.2.3-0")).is_ok());
        assert!(validate(&manifest_with("pub.name", "1.2.3-0.1")).is_ok());
    }
}
