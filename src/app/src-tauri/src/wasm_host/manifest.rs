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
    /// Optional grammar provider configuration.
    pub grammar: Option<GrammarConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GrammarConfig {
    /// Language identifier used by the editor (e.g. "zig", "toml").
    #[serde(rename = "language-id")]
    pub language_id: String,
    /// File extensions that activate this grammar (e.g. ["zig", "zir"]).
    #[serde(rename = "file-types")]
    pub file_types: Vec<String>,
    /// Relative path to the pre-built native grammar shared library
    /// (.so on Linux, .dylib on macOS, .dll on Windows).
    /// The host loads this file directly — it is NOT supplied at runtime
    /// by WASM code, preventing sandbox escapes.
    #[serde(rename = "grammar-dylib")]
    pub grammar_dylib: Option<String>,
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

        // Validate grammar-dylib path if present (same rules as entry.wasm)
        if let Some(ref grammar) = self.grammar {
            if let Some(ref dylib_path) = grammar.grammar_dylib {
                let dylib_rel = Path::new(dylib_path);
                if dylib_rel.is_absolute() {
                    return Err("grammar.grammar-dylib must be a relative path".to_string());
                }
                let joined = ext_dir.join(dylib_rel);
                for component in joined.components() {
                    use std::path::Component;
                    if matches!(component, Component::ParentDir) {
                        return Err(
                            "grammar.grammar-dylib path traverses outside extension directory"
                                .to_string(),
                        );
                    }
                }
            }
        }

        // Validate grammar config if present
        if let Some(ref grammar) = self.grammar {
            if grammar.language_id.is_empty()
                || !grammar
                    .language_id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-')
            {
                return Err(format!(
                    "Invalid grammar language-id '{}': must be non-empty ASCII alphanumerics and hyphens only",
                    grammar.language_id,
                ));
            }
            if grammar.file_types.is_empty() {
                return Err("grammar.file-types must not be empty".to_string());
            }
            for ft in &grammar.file_types {
                if ft.is_empty()
                    || !ft.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                {
                    return Err(format!(
                        "Invalid grammar file-type '{}': must be non-empty ASCII alphanumerics, hyphens, and underscores",
                        ft,
                    ));
                }
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

    // ── Grammar config tests ──────────────────────────────────────────

    #[test]
    fn accepts_valid_grammar_config() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("ext.wasm"), b"").unwrap();
        write_manifest(
            dir.path(),
            r#"
            [extension]
            id = "test.grammar"
            name = "Grammar Test"
            version = "0.1.0"
            [entry]
            wasm = "ext.wasm"
            [grammar]
            language-id = "toml"
            file-types  = ["toml"]
            "#,
        );
        let m = CoreCodeManifest::load(dir.path()).unwrap();
        let g = m.grammar.unwrap();
        assert_eq!(g.language_id, "toml");
        assert_eq!(g.file_types, vec!["toml"]);
    }

    #[test]
    fn grammar_config_is_optional() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("ext.wasm"), b"").unwrap();
        write_manifest(
            dir.path(),
            r#"
            [extension]
            id = "test.no-grammar"
            name = "No Grammar"
            version = "0.1.0"
            [entry]
            wasm = "ext.wasm"
            "#,
        );
        let m = CoreCodeManifest::load(dir.path()).unwrap();
        assert!(m.grammar.is_none());
    }

    #[test]
    fn rejects_grammar_with_empty_language_id() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("ext.wasm"), b"").unwrap();
        write_manifest(
            dir.path(),
            r#"
            [extension]
            id = "test.bad-grammar"
            name = "Bad Grammar"
            version = "0.1.0"
            [entry]
            wasm = "ext.wasm"
            [grammar]
            language-id = ""
            file-types  = ["toml"]
            "#,
        );
        let err = CoreCodeManifest::load(dir.path()).unwrap_err();
        assert!(err.contains("language-id"), "expected 'language-id' in: {err}");
    }

    #[test]
    fn rejects_grammar_with_invalid_language_id_chars() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("ext.wasm"), b"").unwrap();
        write_manifest(
            dir.path(),
            r#"
            [extension]
            id = "test.bad-grammar"
            name = "Bad Grammar"
            version = "0.1.0"
            [entry]
            wasm = "ext.wasm"
            [grammar]
            language-id = "my language"
            file-types  = ["ml"]
            "#,
        );
        let err = CoreCodeManifest::load(dir.path()).unwrap_err();
        assert!(err.contains("language-id"), "expected 'language-id' in: {err}");
    }

    #[test]
    fn rejects_grammar_with_path_traversal_in_language_id() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("ext.wasm"), b"").unwrap();
        write_manifest(
            dir.path(),
            r#"
            [extension]
            id = "test.bad-grammar"
            name = "Bad Grammar"
            version = "0.1.0"
            [entry]
            wasm = "ext.wasm"
            [grammar]
            language-id = "../escape"
            file-types  = ["esc"]
            "#,
        );
        let err = CoreCodeManifest::load(dir.path()).unwrap_err();
        assert!(err.contains("language-id"), "expected 'language-id' in: {err}");
    }

    #[test]
    fn rejects_grammar_with_empty_file_types() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("ext.wasm"), b"").unwrap();
        write_manifest(
            dir.path(),
            r#"
            [extension]
            id = "test.bad-grammar"
            name = "Bad Grammar"
            version = "0.1.0"
            [entry]
            wasm = "ext.wasm"
            [grammar]
            language-id = "toml"
            file-types  = []
            "#,
        );
        let err = CoreCodeManifest::load(dir.path()).unwrap_err();
        assert!(err.contains("file-types"), "expected 'file-types' in: {err}");
    }

    #[test]
    fn accepts_grammar_with_multiple_file_types() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("ext.wasm"), b"").unwrap();
        write_manifest(
            dir.path(),
            r#"
            [extension]
            id = "test.multi-ft"
            name = "Multi"
            version = "0.1.0"
            [entry]
            wasm = "ext.wasm"
            [grammar]
            language-id = "zig"
            file-types  = ["zig", "zir"]
            "#,
        );
        let m = CoreCodeManifest::load(dir.path()).unwrap();
        let g = m.grammar.unwrap();
        assert_eq!(g.file_types, vec!["zig", "zir"]);
    }

    #[test]
    fn accepts_grammar_with_hyphens_and_underscores_in_file_types() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("ext.wasm"), b"").unwrap();
        write_manifest(
            dir.path(),
            r#"
            [extension]
            id = "test.ft"
            name = "FT"
            version = "0.1.0"
            [entry]
            wasm = "ext.wasm"
            [grammar]
            language-id = "my-lang"
            file-types  = ["my-ext", "my_ext"]
            "#,
        );
        assert!(CoreCodeManifest::load(dir.path()).is_ok());
    }

    // ── grammar-dylib path validation tests ────────────────────────────

    #[test]
    fn accepts_valid_grammar_dylib_path() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("ext.wasm"), b"").unwrap();
        write_manifest(
            dir.path(),
            r#"
            [extension]
            id = "test.dylib"
            name = "Dylib"
            version = "0.1.0"
            [entry]
            wasm = "ext.wasm"
            [grammar]
            language-id = "toml"
            file-types  = ["toml"]
            grammar-dylib = "grammars/tree-sitter-toml.so"
            "#,
        );
        assert!(CoreCodeManifest::load(dir.path()).is_ok());
    }

    #[test]
    fn grammar_dylib_is_optional() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("ext.wasm"), b"").unwrap();
        write_manifest(
            dir.path(),
            r#"
            [extension]
            id = "test.no-dylib"
            name = "No Dylib"
            version = "0.1.0"
            [entry]
            wasm = "ext.wasm"
            [grammar]
            language-id = "toml"
            file-types  = ["toml"]
            "#,
        );
        let m = CoreCodeManifest::load(dir.path()).unwrap();
        assert!(m.grammar.unwrap().grammar_dylib.is_none());
    }

    #[test]
    fn rejects_absolute_grammar_dylib_path() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("ext.wasm"), b"").unwrap();

        #[cfg(windows)]
        let abs = "C:/Windows/System32/evil.dll";
        #[cfg(not(windows))]
        let abs = "/etc/evil.so";

        write_manifest(
            dir.path(),
            &format!(
                r#"
                [extension]
                id = "test.abs-dylib"
                name = "Abs"
                version = "0.1.0"
                [entry]
                wasm = "ext.wasm"
                [grammar]
                language-id = "toml"
                file-types  = ["toml"]
                grammar-dylib = "{abs}"
                "#
            ),
        );
        let err = CoreCodeManifest::load(dir.path()).unwrap_err();
        assert!(err.contains("grammar-dylib"), "expected 'grammar-dylib' in: {err}");
    }

    #[test]
    fn rejects_dotdot_grammar_dylib_path() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("ext.wasm"), b"").unwrap();
        write_manifest(
            dir.path(),
            r#"
            [extension]
            id = "test.traverse"
            name = "Traverse"
            version = "0.1.0"
            [entry]
            wasm = "ext.wasm"
            [grammar]
            language-id = "toml"
            file-types  = ["toml"]
            grammar-dylib = "../evil.so"
            "#,
        );
        let err = CoreCodeManifest::load(dir.path()).unwrap_err();
        assert!(err.contains("traverses"), "expected 'traverses' in: {err}");
    }
}
