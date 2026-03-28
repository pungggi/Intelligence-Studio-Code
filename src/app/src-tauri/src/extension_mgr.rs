use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Maximum size of a single file extracted from a VSIX archive (50 MB).
const MAX_VSIX_FILE_SIZE: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledExtension {
    pub id: String,
    pub namespace: String,
    pub name: String,
    pub version: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub path: String,
    pub enabled: bool,
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionUpdateInfo {
    pub id: String,
    pub current_version: String,
    pub latest_version: String,
    pub download_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExtensionRegistry {
    extensions: Vec<InstalledExtension>,
    last_update_check: Option<String>,
}

impl ExtensionRegistry {
    fn empty() -> Self {
        Self {
            extensions: Vec::new(),
            last_update_check: None,
        }
    }
}

pub struct ExtensionManager {
    extensions_dir: PathBuf,
    registry_path: PathBuf,
}

/// Which host type an extension directory targets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExtensionKind {
    /// Has `package.json` — routed to the Node.js extension host.
    NodeJs,
    /// Has `corecode.toml` — routed to the in-process WASM host.
    Wasm,
}

/// Detect the host type for an extension directory.
///
/// Returns `None` if neither manifest file is present (not a recognised extension).
/// If both manifests are present, `Wasm` wins and a warning is logged.
pub fn detect_kind(ext_dir: &std::path::Path) -> Option<ExtensionKind> {
    let has_toml = ext_dir.join("corecode.toml").exists();
    let has_pkg  = ext_dir.join("package.json").exists();
    match (has_toml, has_pkg) {
        (true, true) => {
            log::warn!(
                "Extension '{}' has both corecode.toml and package.json; \
                 treating as WASM extension",
                ext_dir.display()
            );
            Some(ExtensionKind::Wasm)
        }
        (true, false) => Some(ExtensionKind::Wasm),
        (false, true) => Some(ExtensionKind::NodeJs),
        (false, false) => None,
    }
}

/// Validate that an extension identifier component contains no path traversal sequences.
/// Rejects `/`, `\`, `..`, and empty strings.
fn validate_extension_id_component(component: &str, label: &str) -> Result<(), String> {
    if component.is_empty() {
        return Err(format!("Invalid {label}: must not be empty"));
    }
    if component.contains('/') || component.contains('\\') || component.contains("..") {
        return Err(format!("Invalid {label}: contains path traversal characters"));
    }
    Ok(())
}

impl ExtensionManager {
    pub fn new() -> Result<Self, String> {
        let data_dir = dirs::data_local_dir()
            .ok_or_else(|| "Could not determine local data directory".to_string())?;
        let extensions_dir = data_dir.join("corecode").join("extensions");
        let registry_path = data_dir.join("corecode").join("extensions.json");

        std::fs::create_dir_all(&extensions_dir)
            .map_err(|e| format!("Failed to create extensions directory: {e}"))?;

        Ok(Self {
            extensions_dir,
            registry_path,
        })
    }

    pub fn extensions_dir(&self) -> &Path {
        &self.extensions_dir
    }

    fn load_registry(&self) -> ExtensionRegistry {
        match std::fs::read_to_string(&self.registry_path) {
            Ok(contents) => {
                serde_json::from_str(&contents).unwrap_or_else(|_| ExtensionRegistry::empty())
            }
            Err(_) => ExtensionRegistry::empty(),
        }
    }

    fn save_registry(&self, registry: &ExtensionRegistry) -> Result<(), String> {
        let json = serde_json::to_string_pretty(registry)
            .map_err(|e| format!("Failed to serialize registry: {e}"))?;
        std::fs::write(&self.registry_path, json)
            .map_err(|e| format!("Failed to write registry: {e}"))?;
        Ok(())
    }

    pub fn list_installed(&self) -> Vec<InstalledExtension> {
        self.load_registry().extensions
    }

    pub fn install_from_vsix(
        &self,
        namespace: &str,
        name: &str,
        version: &str,
        display_name: Option<&str>,
        description: Option<&str>,
        vsix_bytes: &[u8],
    ) -> Result<InstalledExtension, String> {
        // Validate namespace and name to prevent path traversal
        validate_extension_id_component(namespace, "namespace")?;
        validate_extension_id_component(name, "extension name")?;

        let extension_id = format!("{namespace}.{name}");
        let install_dir = self.extensions_dir.join(&extension_id);

        // Remove existing version if any
        if install_dir.exists() {
            std::fs::remove_dir_all(&install_dir)
                .map_err(|e| format!("Failed to remove existing extension: {e}"))?;
        }

        std::fs::create_dir_all(&install_dir)
            .map_err(|e| format!("Failed to create extension directory: {e}"))?;

        // Extract VSIX (ZIP archive)
        let cursor = std::io::Cursor::new(vsix_bytes);
        let mut archive =
            zip::ZipArchive::new(cursor).map_err(|e| format!("Invalid VSIX archive: {e}"))?;

        // VSIX contains extension/ subdirectory with the actual extension files
        let mut found_extension_dir = false;
        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .map_err(|e| format!("Failed to read archive entry: {e}"))?;

            let raw_name = file.name().to_string();

            // Extract files from extension/ subdirectory into the install dir root
            let relative_path = if let Some(stripped) = raw_name.strip_prefix("extension/") {
                found_extension_dir = true;
                stripped.to_string()
            } else {
                // Skip non-extension files (vsixmanifest, content_types, etc.)
                continue;
            };

            if relative_path.is_empty() {
                continue;
            }

            let target = install_dir.join(&relative_path);

            // Security: lexical path traversal check (prevent zip-slip)
            // We must check BEFORE creating directories or writing files.
            // Use lexical normalization: resolve the target relative to install_dir
            // and verify it stays within bounds. This works for paths that don't exist yet.
            {
                use std::path::Component;
                let mut depth: i32 = 0;
                for component in target.strip_prefix(&install_dir).unwrap_or(&target).components() {
                    match component {
                        Component::ParentDir => depth -= 1,
                        Component::Normal(_) => depth += 1,
                        _ => {}
                    }
                    if depth < 0 {
                        log::warn!("Skipping zip entry with path traversal: {raw_name}");
                        break;
                    }
                }
                if depth < 0 {
                    continue;
                }
            }
            if let Some(parent) = target.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    log::warn!("Failed to create directory {}: {}", parent.display(), e);
                }
            }

            if file.is_dir() {
                std::fs::create_dir_all(&target)
                    .map_err(|e| format!("Failed to create directory {relative_path}: {e}"))?;
            } else {
                // Check declared size before allocating memory
                if file.size() > MAX_VSIX_FILE_SIZE {
                    log::warn!("Skipping oversized file in VSIX: {relative_path}");
                    continue;
                }
                let mut contents = Vec::new();
                file.read_to_end(&mut contents)
                    .map_err(|e| format!("Failed to read {relative_path}: {e}"))?;
                // Double-check actual decompressed size
                if contents.len() > MAX_VSIX_FILE_SIZE as usize {
                    log::warn!("Skipping oversized file in VSIX: {relative_path}");
                    continue;
                }
                std::fs::write(&target, &contents)
                    .map_err(|e| format!("Failed to write {relative_path}: {e}"))?;
            }
        }

        if !found_extension_dir {
            // Some VSIX files don't have extension/ prefix — files are at root
            // Re-extract everything except known metadata files
            let cursor = std::io::Cursor::new(vsix_bytes);
            let mut archive = zip::ZipArchive::new(cursor)
                .map_err(|e| format!("Invalid VSIX archive: {e}"))?;

            for i in 0..archive.len() {
                let mut file = archive
                    .by_index(i)
                    .map_err(|e| format!("Failed to read archive entry: {e}"))?;

                let raw_name = file.name().to_string();
                if raw_name.starts_with('[')
                    || raw_name.ends_with(".vsixmanifest")
                    || raw_name == "Content_Types.xml"
                {
                    continue;
                }

                let target = install_dir.join(&raw_name);

                // Security: lexical path traversal check (prevent zip-slip)
                {
                    use std::path::Component;
                    let mut depth: i32 = 0;
                    for component in target.strip_prefix(&install_dir).unwrap_or(&target).components() {
                        match component {
                            Component::ParentDir => depth -= 1,
                            Component::Normal(_) => depth += 1,
                            _ => {}
                        }
                        if depth < 0 {
                            break;
                        }
                    }
                    if depth < 0 {
                        log::warn!("Skipping zip entry with path traversal: {raw_name}");
                        continue;
                    }
                }

                if let Some(parent) = target.parent() {
                    if let Err(e) = std::fs::create_dir_all(parent) {
                        log::warn!("Failed to create directory {}: {}", parent.display(), e);
                    }
                }

                if file.is_dir() {
                    std::fs::create_dir_all(&target).ok();
                } else {
                    if file.size() > MAX_VSIX_FILE_SIZE {
                        log::warn!("Skipping oversized file in VSIX: {raw_name}");
                        continue;
                    }
                    let mut contents = Vec::new();
                    file.read_to_end(&mut contents)
                        .map_err(|e| format!("Failed to read {raw_name}: {e}"))?;
                    if contents.len() <= MAX_VSIX_FILE_SIZE as usize {
                        std::fs::write(&target, &contents)
                            .map_err(|e| format!("Failed to write {raw_name}: {e}"))?;
                    }
                }
            }
        }

        // Validate package.json exists
        let package_json = install_dir.join("package.json");
        if !package_json.exists() {
            std::fs::remove_dir_all(&install_dir).ok();
            return Err("Invalid extension: package.json not found after extraction".to_string());
        }

        let now = chrono_now_iso();
        let installed = InstalledExtension {
            id: extension_id.clone(),
            namespace: namespace.to_string(),
            name: name.to_string(),
            version: version.to_string(),
            display_name: display_name.map(|s| s.to_string()),
            description: description.map(|s| s.to_string()),
            path: install_dir.to_string_lossy().to_string(),
            enabled: true,
            installed_at: now,
        };

        // Update registry
        let mut registry = self.load_registry();
        registry.extensions.retain(|e| e.id != extension_id);
        registry.extensions.push(installed.clone());
        self.save_registry(&registry)?;

        Ok(installed)
    }

    pub fn uninstall(&self, extension_id: &str) -> Result<(), String> {
        // Validate extension_id to prevent path traversal (e.g., "../../important_data")
        if extension_id.contains('/') || extension_id.contains('\\') || extension_id.contains("..") || extension_id.is_empty() {
            return Err(format!("Invalid extension ID: {extension_id}"));
        }

        let install_dir = self.extensions_dir.join(extension_id);
        if install_dir.exists() {
            std::fs::remove_dir_all(&install_dir)
                .map_err(|e| format!("Failed to remove extension directory: {e}"))?;
        }

        let mut registry = self.load_registry();
        registry.extensions.retain(|e| e.id != extension_id);
        self.save_registry(&registry)?;

        Ok(())
    }

    pub fn get_installed_versions(&self) -> HashMap<String, String> {
        self.load_registry()
            .extensions
            .into_iter()
            .map(|e| (e.id, e.version))
            .collect()
    }
}

fn chrono_now_iso() -> String {
    use std::time::SystemTime;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    // Simple ISO-ish timestamp without chrono dependency
    let secs = now.as_secs();
    let days = secs / 86400;
    let remaining = secs % 86400;
    let hours = remaining / 3600;
    let minutes = (remaining % 3600) / 60;
    let seconds = remaining % 60;
    // Approximate date from epoch days (good enough for timestamps)
    let (year, month, day) = epoch_days_to_date(days);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

fn epoch_days_to_date(days: u64) -> (u64, u64, u64) {
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
