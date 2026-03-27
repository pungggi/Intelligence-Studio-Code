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
        let url = format!("{OPEN_VSX_API}/{namespace}/{name}");

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
