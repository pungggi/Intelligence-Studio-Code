//! Shared `corecode.toml` manifest types used across all commands and packagers.

use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize)]
pub struct CoreCodeManifest {
    pub extension: ExtensionMeta,
    #[serde(default)]
    pub entry: Entry,
    #[serde(default)]
    pub capabilities: Capabilities,
    #[serde(default)]
    pub languages: HashMap<String, bool>,
    pub grammar: Option<Grammar>,
}

#[derive(Deserialize)]
pub struct ExtensionMeta {
    pub id: String,
    pub name: String,
    pub version: String,
}

#[derive(Deserialize, Default)]
pub struct Entry {
    #[serde(default = "default_wasm")]
    pub wasm: String,
}

fn default_wasm() -> String {
    "extension.wasm".to_string()
}

#[derive(Deserialize, Default)]
pub struct Capabilities {
    #[serde(default)]
    pub workspace_read: bool,
    #[serde(default)]
    pub network_fetch: bool,
    #[serde(default)]
    pub webview_panels: bool,
}

#[derive(Deserialize)]
pub struct Grammar {
    #[serde(rename = "language-id")]
    pub language_id: String,
    #[serde(rename = "file-types", default)]
    pub file_types: Vec<String>,
    #[serde(rename = "grammar-dylib")]
    pub grammar_dylib: Option<String>,
}

/// Load and parse the `corecode.toml` in the current directory.
pub fn load() -> anyhow::Result<CoreCodeManifest> {
    let text = std::fs::read_to_string("corecode.toml")
        .map_err(|_| anyhow::anyhow!(
            "Cannot read corecode.toml — run this command from your extension's root directory"
        ))?;
    toml::from_str::<CoreCodeManifest>(&text)
        .map_err(|e| anyhow::anyhow!("Failed to parse corecode.toml: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Grammar keys are kebab-case in real manifests (as parsed by the host's
    /// manifest.rs) — the toolchain must read the same shape.
    #[test]
    fn parses_grammar_section_kebab_case() {
        let m: CoreCodeManifest = toml::from_str(
            r#"
[extension]
id = "corecode.grammar-toml"
name = "TOML"
version = "0.1.0"

[grammar]
language-id = "toml"
file-types = ["toml"]
"#,
        )
        .unwrap();
        let g = m.grammar.expect("grammar section dropped");
        assert_eq!(g.language_id, "toml");
        assert_eq!(g.file_types, vec!["toml"]);
        assert!(g.grammar_dylib.is_none());
    }
}
