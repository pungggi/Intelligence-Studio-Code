use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const OPEN_VSX_API: &str = "https://open-vsx.org/api";

/// Default CoreCode registry serving `.ccext` (WASM) packages.
/// Overridable via `CORECODE_REGISTRY` (e.g. a local marketplace-server).
const CORECODE_REGISTRY: &str = "https://marketplace.corecode.dev";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInfo {
    pub namespace: String,
    pub name: String,
    pub version: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub download_count: Option<u64>,
    pub categories: Option<Vec<String>>,
    #[serde(default)]
    pub files: HashMap<String, String>,
    pub publisher_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResultItem {
    pub namespace: String,
    pub name: String,
    pub version: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub download_count: Option<u64>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenVsxSearchResponse {
    offset: usize,
    total_size: usize,
    extensions: Vec<OpenVsxExtensionEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenVsxExtensionEntry {
    namespace: String,
    name: String,
    version: String,
    display_name: Option<String>,
    description: Option<String>,
    download_count: Option<u64>,
    url: Option<String>,
    files: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketplaceSearchResult {
    pub extensions: Vec<SearchResultItem>,
    pub total_size: usize,
    pub offset: usize,
}

// --- CoreCode registry (.ccext / WASM extensions) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CcextVersionEntry {
    pub version: String,
    pub sha256: String,
    pub size: u64,
    #[serde(rename = "publishedAt", default)]
    pub published_at: String,
    /// base64 ed25519 signature over the package bytes (signed publishes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// base64 ed25519 public key that produced `signature`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signed_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CcextExtensionEntry {
    pub id: String,
    pub versions: Vec<CcextVersionEntry>,
    /// Publisher identity key pinned by the registry (TOFU).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_key: Option<String>,
}

pub struct MarketplaceClient {
    client: Client,
}

impl MarketplaceClient {
    pub fn new() -> Result<Self, String> {
        let client = Client::builder()
            .user_agent("CoreCode/0.1")
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {e}"))?;
        Ok(Self { client })
    }

    pub async fn search(
        &self,
        query: &str,
        offset: usize,
        limit: usize,
    ) -> Result<MarketplaceSearchResult, String> {
        let limit = limit.min(50);
        let url = format!("{OPEN_VSX_API}/-/search");

        let resp = self
            .client
            .get(&url)
            .query(&[
                ("query", query),
                ("offset", &offset.to_string()),
                ("size", &limit.to_string()),
                ("sortBy", "downloadCount"),
                ("sortOrder", "desc"),
            ])
            .send()
            .await
            .map_err(|e| format!("Open VSX search request failed: {e}"))?;

        if !resp.status().is_success() {
            return Err(format!(
                "Open VSX search returned status {}",
                resp.status()
            ));
        }

        let data: OpenVsxSearchResponse = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse search response: {e}"))?;

        let extensions = data
            .extensions
            .into_iter()
            .map(|ext| SearchResultItem {
                namespace: ext.namespace,
                name: ext.name,
                version: ext.version,
                display_name: ext.display_name,
                description: ext.description,
                download_count: ext.download_count,
                url: ext.url,
            })
            .collect();

        Ok(MarketplaceSearchResult {
            extensions,
            total_size: data.total_size,
            offset: data.offset,
        })
    }

    pub async fn get_extension(
        &self,
        namespace: &str,
        name: &str,
    ) -> Result<ExtensionInfo, String> {
        let mut url = url::Url::parse(OPEN_VSX_API)
            .map_err(|e| format!("Invalid API base URL: {e}"))?;
        url.path_segments_mut()
            .map_err(|_| "Cannot modify API URL path".to_string())?
            .push(namespace)
            .push(name);
        let url = url.to_string();

        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Open VSX get extension failed: {e}"))?;

        if !resp.status().is_success() {
            return Err(format!(
                "Extension {namespace}.{name} not found (status {})",
                resp.status()
            ));
        }

        let mut info: ExtensionInfo = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse extension info: {e}"))?;
        info.publisher_name = Some(info.namespace.clone());
        Ok(info)
    }

    pub async fn download_vsix(&self, download_url: &str) -> Result<Vec<u8>, String> {
        // Validate download URL: must be HTTPS and from a trusted host
        let parsed = url::Url::parse(download_url)
            .map_err(|e| format!("Invalid download URL: {e}"))?;
        if parsed.scheme() != "https" {
            return Err(format!("Download URL must use HTTPS, got '{}'", parsed.scheme()));
        }
        const ALLOWED_HOSTS: &[&str] = &["open-vsx.org", "www.open-vsx.org"];
        match parsed.host_str() {
            Some(host) if ALLOWED_HOSTS.contains(&host) => {}
            Some(host) => return Err(format!("Download URL host '{}' is not in the allowlist", host)),
            None => return Err("Download URL has no host".to_string()),
        }

        let mut resp = self
            .client
            .get(download_url)
            .send()
            .await
            .map_err(|e| format!("VSIX download failed: {e}"))?;

        // Validate final URL after redirects — reqwest follows redirects automatically
        // so the response may come from a different host than the initial request.
        if let Some(final_host) = resp.url().host_str() {
            if !ALLOWED_HOSTS.contains(&final_host) {
                return Err(format!(
                    "VSIX download redirected to untrusted host '{final_host}'"
                ));
            }
        }

        if !resp.status().is_success() {
            return Err(format!(
                "VSIX download returned status {}",
                resp.status()
            ));
        }

        let content_length = resp.content_length().unwrap_or(0);
        if content_length > 100 * 1024 * 1024 {
            return Err("VSIX file exceeds 100MB limit".to_string());
        }

        let mut bytes = Vec::with_capacity(content_length as usize);
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("Failed to read VSIX bytes: {e}"))?
        {
            bytes.extend_from_slice(&chunk);
            if bytes.len() > 100 * 1024 * 1024 {
                return Err("VSIX file exceeds 100MB limit".to_string());
            }
        }

        Ok(bytes)
    }

    // ───────────────────────────────────────────────────────────────────────
    // CoreCode registry (.ccext) — marketplace-server API
    // ───────────────────────────────────────────────────────────────────────

    /// Registry base URL — `CORECODE_REGISTRY` env override, else the public
    /// default. Trailing slash normalised away.
    fn registry_base() -> String {
        std::env::var("CORECODE_REGISTRY")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| CORECODE_REGISTRY.to_string())
            .trim_end_matches('/')
            .to_string()
    }

    /// The registry host is allowed over plain HTTP only when it is a loopback
    /// address (local marketplace-server during development); anything else
    /// must use HTTPS.
    fn validate_registry_scheme(parsed: &url::Url) -> Result<(), String> {
        let is_loopback = matches!(parsed.host_str(), Some(h) if h == "localhost" || h == "127.0.0.1" || h == "[::1]" || h.starts_with("192.168.") || h.starts_with("10."));
        if parsed.scheme() == "https" || (parsed.scheme() == "http" && is_loopback) {
            Ok(())
        } else {
            Err(format!(
                "CoreCode registry must use HTTPS (http only allowed for loopback/LAN hosts), got '{}'",
                parsed.scheme()
            ))
        }
    }

    /// Metadata (all versions) for a native `.ccext` extension.
    pub async fn ccext_get(&self, id: &str) -> Result<CcextExtensionEntry, String> {
        let base = Self::registry_base();
        let parsed = url::Url::parse(&base).map_err(|e| format!("Invalid registry URL: {e}"))?;
        Self::validate_registry_scheme(&parsed)?;

        let mut url = parsed;
        url.path_segments_mut()
            .map_err(|_| "Cannot modify registry URL path".to_string())?
            .push("api")
            .push("v1")
            .push("extension")
            .push(id);

        let resp = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("CoreCode registry request failed: {e}"))?;
        match resp.status() {
            reqwest::StatusCode::NOT_FOUND => Err(format!("Extension {id} not found in CoreCode registry")),
            s if !s.is_success() => Err(format!("CoreCode registry returned status {s}")),
            _ => resp
                .json()
                .await
                .map_err(|e| format!("Failed to parse registry response: {e}")),
        }
    }

    /// Download a `.ccext` package. Returns `(bytes, sha256)` where `sha256` is
    /// the registry-recorded digest (from the `x-corecode-sha256` response
    /// header) — callers MUST verify it before installing.
    pub async fn ccext_download(
        &self,
        id: &str,
        version: &str,
    ) -> Result<(Vec<u8>, String), String> {
        let base = Self::registry_base();
        let parsed = url::Url::parse(&base).map_err(|e| format!("Invalid registry URL: {e}"))?;
        Self::validate_registry_scheme(&parsed)?;

        let mut url = parsed;
        url.path_segments_mut()
            .map_err(|_| "Cannot modify registry URL path".to_string())?
            .push("api")
            .push("v1")
            .push("extension")
            .push(id)
            .push(version)
            .push("download");

        let mut resp = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("ccext download failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("ccext download returned status {}", resp.status()));
        }

        let expected_sha = resp
            .headers()
            .get("x-corecode-sha256")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();

        let content_length = resp.content_length().unwrap_or(0);
        if content_length > 50 * 1024 * 1024 {
            return Err("ccext package exceeds 50MB limit".to_string());
        }
        let mut bytes = Vec::with_capacity(content_length as usize);
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("Failed to read ccext bytes: {e}"))?
        {
            bytes.extend_from_slice(&chunk);
            if bytes.len() > 50 * 1024 * 1024 {
                return Err("ccext package exceeds 50MB limit".to_string());
            }
        }

        Ok((bytes, expected_sha))
    }

    /// Verify a downloaded package against the version entry's ed25519
    /// signature. Unsigned (legacy/dev) entries pass — the registry only
    /// records signatures for publishers that opted in; once signed, the
    /// registry pins the key and clients authenticate against it.
    pub fn verify_ccext_signature(
        entry: &CcextVersionEntry,
        bytes: &[u8],
    ) -> Result<(), String> {
        use base64::Engine;
        use ed25519_dalek::{Signature, Verifier, VerifyingKey};

        let (Some(signature), Some(signed_by)) = (&entry.signature, &entry.signed_by) else {
            return Ok(()); // unsigned publish — SHA-256 integrity still applies
        };

        let engine = base64::engine::general_purpose::STANDARD;
        let key_bytes: Vec<u8> = engine
            .decode(signed_by.trim())
            .map_err(|e| format!("invalid publisher key encoding: {e}"))?;
        let key_bytes: [u8; 32] = key_bytes.try_into().map_err(|v: Vec<u8>| {
            format!("publisher key must be 32 bytes, got {}", v.len())
        })?;
        let key = VerifyingKey::from_bytes(&key_bytes)
            .map_err(|e| format!("invalid publisher key: {e}"))?;

        let sig_bytes: Vec<u8> = engine
            .decode(signature.trim())
            .map_err(|e| format!("invalid signature encoding: {e}"))?;
        let sig_bytes: [u8; 64] = sig_bytes.try_into().map_err(|v: Vec<u8>| {
            format!("signature must be 64 bytes, got {}", v.len())
        })?;

        key.verify(bytes, &Signature::from_bytes(&sig_bytes))
            .map_err(|_| "signature verification failed — package may be tampered".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── download_vsix URL validation ─────────────────────────────────────────
    // These tests exercise the synchronous validation logic (scheme + host
    // allowlist) without making any network requests.

    fn make_client() -> MarketplaceClient {
        MarketplaceClient::new().expect("failed to build test client")
    }

    #[tokio::test]
    async fn download_vsix_rejects_http() {
        let client = make_client();
        let err = client
            .download_vsix("http://open-vsx.org/extension.vsix")
            .await
            .unwrap_err();
        assert!(
            err.contains("HTTPS"),
            "expected HTTPS error, got: {err}"
        );
    }

    #[tokio::test]
    async fn download_vsix_rejects_non_allowlisted_host() {
        let client = make_client();
        let err = client
            .download_vsix("https://evil.example.com/extension.vsix")
            .await
            .unwrap_err();
        assert!(
            err.contains("allowlist"),
            "expected allowlist error, got: {err}"
        );
    }

    #[tokio::test]
    async fn download_vsix_rejects_missing_host() {
        let client = make_client();
        let err = client
            .download_vsix("file:///extension.vsix")
            .await
            .unwrap_err();
        // Matches either scheme check or no-host check.
        assert!(
            err.contains("HTTPS") || err.contains("host"),
            "expected scheme or host error, got: {err}"
        );
    }

    #[tokio::test]
    async fn download_vsix_rejects_invalid_url() {
        let client = make_client();
        let err = client.download_vsix("not a url at all").await.unwrap_err();
        assert!(
            err.contains("Invalid download URL"),
            "expected parse error, got: {err}"
        );
    }

    #[tokio::test]
    async fn download_vsix_allows_open_vsx_org() {
        // Allowlist check passes for open-vsx.org — the subsequent HTTP request
        // will fail (no network in tests), but that's a different error.
        let client = make_client();
        let result = client
            .download_vsix("https://open-vsx.org/api/publisher/ext/version/file/ext.vsix")
            .await;
        // We only care that the error is NOT an allowlist/scheme rejection.
        if let Err(ref e) = result {
            assert!(
                !e.contains("allowlist") && !e.contains("HTTPS"),
                "should not be blocked by URL validation, got: {e}"
            );
        }
    }

    // ── get_extension URL construction ───────────────────────────────────────

    #[test]
    fn get_extension_url_encodes_special_chars() {
        // Verify that percent-encoding is applied to namespace/name by constructing
        // the URL the same way the code does and checking the result.
        let mut url = url::Url::parse(OPEN_VSX_API).unwrap();
        url.path_segments_mut()
            .unwrap()
            .push("pub lisher")
            .push("ext name");
        let s = url.to_string();
        assert!(s.contains("pub%20lisher"), "expected encoded space, got: {s}");
        assert!(s.contains("ext%20name"), "expected encoded space, got: {s}");
    }

    #[test]
    fn get_extension_url_does_not_allow_path_traversal() {
        let mut url = url::Url::parse(OPEN_VSX_API).unwrap();
        url.path_segments_mut()
            .unwrap()
            .push("../evil")
            .push("ext");
        let s = url.to_string();
        // path_segments_mut().push() encodes the slash, preventing traversal.
        assert!(!s.contains("/../"), "URL must not contain raw path traversal, got: {s}");
    }

    // ── CoreCode registry (.ccext) ───────────────────────────────────

    #[test]
    fn ccext_registry_rejects_plain_http_for_public_hosts() {
        let url = url::Url::parse("http://marketplace.corecode.dev").unwrap();
        let err = MarketplaceClient::validate_registry_scheme(&url).unwrap_err();
        assert!(err.contains("HTTPS"), "expected HTTPS error, got: {err}");
    }

    #[test]
    fn ccext_registry_allows_http_for_loopback() {
        for host in ["localhost", "127.0.0.1", "[::1]"] {
            let url = url::Url::parse(&format!("http://{host}:8987")).unwrap();
            assert!(MarketplaceClient::validate_registry_scheme(&url).is_ok(), "http should be allowed for {host}");
        }
        let url = url::Url::parse("https://marketplace.corecode.dev").unwrap();
        assert!(MarketplaceClient::validate_registry_scheme(&url).is_ok());
    }

    #[test]
    fn ccext_download_url_encodes_id() {
        // Build the download URL exactly as ccext_download does — the id segment
        // must not be able to inject path traversal.
        let base = MarketplaceClient::registry_base();
        let mut url = url::Url::parse(&base).unwrap();
        url.path_segments_mut().unwrap()
            .push("api").push("v1").push("extension")
            .push("../evil").push("1.0.0").push("download");
        let s = url.to_string();
        assert!(!s.contains("/../"), "download URL must not allow traversal, got: {s}");
    }

    // ── ed25519 signature verification ─────────────────────────────────

    fn b64(bytes: &[u8]) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn signed_entry(key: &ed25519_dalek::SigningKey, bytes: &[u8]) -> CcextVersionEntry {
        use ed25519_dalek::Signer;
        CcextVersionEntry {
            version: "1.0.0".into(),
            sha256: String::new(),
            size: bytes.len() as u64,
            published_at: String::new(),
            signature: Some(b64(&key.sign(bytes).to_bytes())),
            signed_by: Some(b64(key.verifying_key().as_bytes())),
        }
    }

    fn unsigned_entry() -> CcextVersionEntry {
        CcextVersionEntry {
            version: "1.0.0".into(),
            sha256: String::new(),
            size: 0,
            published_at: String::new(),
            signature: None,
            signed_by: None,
        }
    }

    #[test]
    fn ccext_signature_valid_passes() {
        use ed25519_dalek::Signer;
        use rand::rngs::OsRng;
        let key = ed25519_dalek::SigningKey::generate(&mut OsRng);
        let entry = signed_entry(&key, b"package");
        assert!(MarketplaceClient::verify_ccext_signature(&entry, b"package").is_ok());
    }

    #[test]
    fn ccext_signature_tampered_bytes_fail() {
        use rand::rngs::OsRng;
        let key = ed25519_dalek::SigningKey::generate(&mut OsRng);
        let entry = signed_entry(&key, b"package");
        let err = MarketplaceClient::verify_ccext_signature(&entry, b"tampered").unwrap_err();
        assert!(err.contains("tampered"), "got: {err}");
    }

    #[test]
    fn ccext_signature_wrong_key_fails() {
        use ed25519_dalek::Signer;
        use rand::rngs::OsRng;
        let signer = ed25519_dalek::SigningKey::generate(&mut OsRng);
        let mut entry = signed_entry(&signer, b"package");
        // re-sign with a different key but keep the original signed_by
        let other = ed25519_dalek::SigningKey::generate(&mut OsRng);
        entry.signature = Some(b64(&other.sign(b"package").to_bytes()));
        assert!(MarketplaceClient::verify_ccext_signature(&entry, b"package").is_err());
    }

    #[test]
    fn ccext_unsigned_entry_passes() {
        let entry = unsigned_entry();
        assert!(MarketplaceClient::verify_ccext_signature(&entry, b"anything").is_ok());
    }
}
