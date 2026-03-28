use reqwest::Client;
use serde::{Deserialize, Serialize};

const OPEN_VSX_API: &str = "https://open-vsx.org/api";

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
    pub files: std::collections::HashMap<String, String>,
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
    files: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketplaceSearchResult {
    pub extensions: Vec<SearchResultItem>,
    pub total_size: usize,
    pub offset: usize,
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
                ("sortBy", &"downloadCount".to_string()),
                ("sortOrder", &"desc".to_string()),
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

        let resp = self
            .client
            .get(download_url)
            .send()
            .await
            .map_err(|e| format!("VSIX download failed: {e}"))?;

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

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("Failed to read VSIX bytes: {e}"))?;

        if bytes.len() > 100 * 1024 * 1024 {
            return Err("VSIX file exceeds 100MB limit".to_string());
        }

        Ok(bytes.to_vec())
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
}
