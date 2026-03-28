//! Parses and validates `corecode.toml` extension manifests.

use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
pub struct CoreCodeManifest {
    pub extension: ExtensionMeta,
    pub entry: EntryConfig,
    #[serde(default)]
    pub capabilities: Capabilities,
    #[serde(default)]
    pub languages: HashMap<String, bool>,
}

#[derive(Debug, Deserialize)]
pub struct ExtensionMeta {
    pub id: String,
    pub name: String,
    pub version: String,
}

#[derive(Debug, Deserialize)]
pub struct EntryConfig {
    /// Relative path to the .wasm file inside the extension directory.
    pub wasm: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct Capabilities {
    #[serde(default)]
    pub workspace_read: bool,
    #[serde(default)]
    pub network_fetch: bool,
    #[serde(default)]
    pub webview_panels: bool,
}

impl CoreCodeManifest {
    /// Load and validate a `corecode.toml` from the given extension directory.
    pub fn load(ext_dir: &Path) -> Result<Self, String> {
        let path = ext_dir.join("corecode.toml");
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("Cannot read corecode.toml: {e}"))?;
        let manifest: CoreCodeManifest =
            toml::from_str(&text).map_err(|e| format!("Invalid corecode.toml: {e}"))?;
        manifest.validate(ext_dir)?;
        Ok(manifest)
    }

    fn validate(&self, ext_dir: &Path) -> Result<(), String> {
        // id must be non-empty and contain no path-traversal characters
        if self.extension.id.is_empty()
            || self.extension.id.contains('/')
            || self.extension.id.contains('\\')
            || self.extension.id.contains("..")
        {
            return Err(format!(
                "Invalid extension id '{}': must not be empty or contain path characters",
                self.extension.id
            ));
        }

        // wasm entry must be a relative path that stays inside ext_dir
        let wasm_rel = Path::new(&self.entry.wasm);
        if wasm_rel.is_absolute() {
            return Err("entry.wasm must be a relative path".to_string());
        }

        // Lexical dotdot check before attempting canonicalisation (file may not exist yet)
        let joined = ext_dir.join(wasm_rel);
        for component in joined.components() {
            use std::path::Component;
            if matches!(component, Component::ParentDir) {
                return Err("entry.wasm path traverses outside extension directory".to_string());
            }
        }

        Ok(())
    }

    /// Resolve the absolute path to the WASM binary.
    pub fn wasm_path(&self, ext_dir: &Path) -> PathBuf {
        ext_dir.join(&self.entry.wasm)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_manifest(dir: &Path, content: &str) {
        std::fs::write(dir.join("corecode.toml"), content).unwrap();
    }

    #[test]
    fn valid_manifest_loads() {
        let dir = TempDir::new().unwrap();
        // Create a placeholder wasm file so the path exists
        std::fs::write(dir.path().join("ext.wasm"), b"").unwrap();
        write_manifest(
            dir.path(),
            r#"
            [extension]
            id = "test.my-ext"
            name = "Test Extension"
            version = "0.1.0"
            [entry]
            wasm = "ext.wasm"
            "#,
        );
        assert!(CoreCodeManifest::load(dir.path()).is_ok());
    }

    #[test]
    fn rejects_absolute_wasm_path() {
        let dir = TempDir::new().unwrap();
        // Use a platform-appropriate absolute path.
        // Forward slashes work for is_absolute() on Windows too.
        #[cfg(windows)]
        let abs_path = "C:/Windows/System32/ntoskrnl.exe";
        #[cfg(not(windows))]
        let abs_path = "/etc/passwd";

        write_manifest(
            dir.path(),
            &format!(
                r#"
                [extension]
                id = "test.my-ext"
                name = "Test"
                version = "0.1.0"
                [entry]
                wasm = "{abs_path}"
                "#
            ),
        );
        let err = CoreCodeManifest::load(dir.path()).unwrap_err();
        assert!(err.contains("relative"), "expected 'relative' in: {err}");
    }

    #[test]
    fn rejects_dotdot_wasm_path() {
        let dir = TempDir::new().unwrap();
        write_manifest(
            dir.path(),
            r#"
            [extension]
            id = "test.my-ext"
            name = "Test"
            version = "0.1.0"
            [entry]
            wasm = "../other/evil.wasm"
            "#,
        );
        let err = CoreCodeManifest::load(dir.path()).unwrap_err();
        assert!(err.contains("traverses"), "expected 'traverses' in: {err}");
    }

    #[test]
    fn rejects_empty_id() {
        let dir = TempDir::new().unwrap();
        write_manifest(
            dir.path(),
            r#"
            [extension]
            id = ""
            name = "Test"
            version = "0.1.0"
            [entry]
            wasm = "ext.wasm"
            "#,
        );
        let err = CoreCodeManifest::load(dir.path()).unwrap_err();
        assert!(err.contains("id"), "expected 'id' in: {err}");
    }

    #[test]
    fn rejects_id_with_path_separator() {
        let dir = TempDir::new().unwrap();
        write_manifest(
            dir.path(),
            r#"
            [extension]
            id = "bad/id"
            name = "Test"
            version = "0.1.0"
            [entry]
            wasm = "ext.wasm"
            "#,
        );
        let err = CoreCodeManifest::load(dir.path()).unwrap_err();
        assert!(err.contains("id"), "expected 'id' in: {err}");
    }

    #[test]
    fn capabilities_default_to_false() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("ext.wasm"), b"").unwrap();
        write_manifest(
            dir.path(),
            r#"
            [extension]
            id = "test.my-ext"
            name = "Test"
            version = "0.1.0"
            [entry]
            wasm = "ext.wasm"
            "#,
        );
        let m = CoreCodeManifest::load(dir.path()).unwrap();
        assert!(!m.capabilities.workspace_read);
        assert!(!m.capabilities.network_fetch);
        assert!(!m.capabilities.webview_panels);
    }

    #[test]
    fn rejects_id_with_backslash() {
        let dir = TempDir::new().unwrap();
        write_manifest(
            dir.path(),
            r#"
            [extension]
            id = "bad\id"
            name = "Test"
            version = "0.1.0"
            [entry]
            wasm = "ext.wasm"
            "#,
        );
        let err = CoreCodeManifest::load(dir.path()).unwrap_err();
        assert!(err.contains("id"), "expected 'id' in: {err}");
    }

    #[test]
    fn rejects_id_with_double_dot_substring() {
        let dir = TempDir::new().unwrap();
        write_manifest(
            dir.path(),
            r#"
            [extension]
            id = "my..ext"
            name = "Test"
            version = "0.1.0"
            [entry]
            wasm = "ext.wasm"
            "#,
        );
        let err = CoreCodeManifest::load(dir.path()).unwrap_err();
        assert!(err.contains("id"), "expected 'id' in: {err}");
    }

    #[test]
    fn accepts_nested_relative_wasm_path() {
        let dir = TempDir::new().unwrap();
        let subdir = dir.path().join("subdir");
        std::fs::create_dir_all(&subdir).unwrap();
        std::fs::write(subdir.join("ext.wasm"), b"").unwrap();
        write_manifest(
            dir.path(),
            r#"
            [extension]
            id = "test.nested"
            name = "Nested Test"
            version = "0.1.0"
            [entry]
            wasm = "subdir/ext.wasm"
            "#,
        );
        assert!(CoreCodeManifest::load(dir.path()).is_ok());
    }

    #[test]
    fn accepts_dot_slash_wasm_path() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("ext.wasm"), b"").unwrap();
        write_manifest(
            dir.path(),
            r#"
            [extension]
            id = "test.dotSlash"
            name = "Dot Slash Test"
            version = "0.1.0"
            [entry]
            wasm = "./ext.wasm"
            "#,
        );
        assert!(CoreCodeManifest::load(dir.path()).is_ok());
    }
}
