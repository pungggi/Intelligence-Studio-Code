//! Dynamic grammar registry for tree-sitter grammars loaded at runtime.
//!
//! Extensions ship a pre-built native shared library (referenced by
//! `grammar-dylib` in `corecode.toml`).  The host loads the dylib via
//! `libloading` and registers the grammar here so that `editor.rs` can fall
//! through to dynamic grammars for file types with no built-in support.
//!
//! SECURITY: The dylib is a static file packaged with the extension — it is
//! NOT returned at runtime by WASM code.  This prevents the WASM sandbox
//! from being bypassed by supplying arbitrary native code bytes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// A tree-sitter grammar loaded at runtime from an extension's native dylib.
pub struct DynamicGrammar {
    pub language_id: String,
    pub file_types: Vec<String>,
    /// The parsed tree-sitter Language, wrapped in Arc for safe sharing.
    pub language: Arc<tree_sitter::Language>,
    pub highlights_query: String,
    pub injections_query: Option<String>,
    pub bracket_pairs: Vec<[String; 2]>,
    /// Keeps the loaded shared library alive for the lifetime of the language.
    /// Must not be dropped while the `language` is in use.
    pub(crate) _library: Option<libloading::Library>,
}

// SAFETY: `tree_sitter::Language` is a thin wrapper over a `*const TSLanguage`.
// The underlying data is static (compiled into the dylib) and immutable, so sharing
// it across threads is safe. The `Library` handle keeps the dylib mapped.
unsafe impl Send for DynamicGrammar {}
unsafe impl Sync for DynamicGrammar {}

/// Registry mapping language-ids and file extensions to dynamically loaded grammars.
pub struct GrammarRegistry {
    /// language-id → DynamicGrammar
    dynamic: Mutex<HashMap<String, DynamicGrammar>>,
    /// file-extension → language-id (for lookup by file type)
    ext_map: Mutex<HashMap<String, String>>,
}

impl GrammarRegistry {
    pub fn new() -> Self {
        Self {
            dynamic: Mutex::new(HashMap::new()),
            ext_map: Mutex::new(HashMap::new()),
        }
    }

    /// Register a grammar loaded from a WASM extension.
    pub fn register(&self, grammar: DynamicGrammar) {
        let mut ext_map = self.ext_map.lock().unwrap();
        let mut dynamic = self.dynamic.lock().unwrap();

        for ft in &grammar.file_types {
            if let Some(existing) = ext_map.get(ft) {
                if existing != &grammar.language_id {
                    log::warn!(
                        "Grammar conflict for extension '.{}': '{}' overrides '{}'",
                        ft, grammar.language_id, existing
                    );
                }
            }
            ext_map.insert(ft.clone(), grammar.language_id.clone());
        }
        dynamic.insert(grammar.language_id.clone(), grammar);
    }

    /// Remove all grammars registered by a specific extension language-id.
    pub fn unregister(&self, language_id: &str) {
        let mut ext_map = self.ext_map.lock().unwrap();
        let mut dynamic = self.dynamic.lock().unwrap();

        ext_map.retain(|_, lang| lang != language_id);
        dynamic.remove(language_id);
    }

    /// Look up a grammar's `Language` by file extension.
    /// Returns None if not registered dynamically.
    pub fn language_by_extension(&self, ext: &str) -> Option<Arc<tree_sitter::Language>> {
        let lang_id = self.ext_map.lock().unwrap().get(ext)?.clone();
        let map = self.dynamic.lock().unwrap();
        Some(Arc::clone(&map.get(&lang_id)?.language))
    }

    /// Look up a grammar's highlights query by language-id.
    pub fn highlights_query(&self, lang_id: &str) -> Option<String> {
        let map = self.dynamic.lock().unwrap();
        Some(map.get(lang_id)?.highlights_query.clone())
    }

    /// Look up bracket pairs by language-id.
    pub fn bracket_pairs(&self, lang_id: &str) -> Option<Vec<[String; 2]>> {
        let map = self.dynamic.lock().unwrap();
        Some(map.get(lang_id)?.bracket_pairs.clone())
    }

    /// Check whether a language-id is registered.
    pub fn has_language(&self, lang_id: &str) -> bool {
        self.dynamic.lock().unwrap().contains_key(lang_id)
    }
}

/// Load a tree-sitter grammar from a native shared library (.so/.dylib/.dll).
///
/// The function looks up the symbol `tree_sitter_{language_id}` (with hyphens
/// replaced by underscores) and calls it to obtain the `Language`.
///
/// # Safety
/// Loading a shared library is inherently unsafe — the dylib must be a valid
/// tree-sitter grammar compiled for the current platform/architecture.
/// Path traversal is validated by the caller before reaching this function.
pub fn load_from_dylib(
    language_id: &str,
    dylib_path: &std::path::Path,
) -> Result<(tree_sitter::Language, libloading::Library), String> {
    // Validate language_id: only ASCII alphanumerics and hyphens.
    if language_id.is_empty()
        || !language_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(format!(
            "Invalid language_id '{}': must be non-empty ASCII alphanumerics and hyphens only",
            language_id,
        ));
    }

    let lib = unsafe { libloading::Library::new(dylib_path) }
        .map_err(|e| format!("Cannot load grammar dylib '{}': {e}", dylib_path.display()))?;

    let fn_name = format!("tree_sitter_{}", language_id.replace('-', "_"));
    let lang = {
        let lang_fn: libloading::Symbol<unsafe extern "C" fn() -> tree_sitter::Language> =
            unsafe { lib.get(fn_name.as_bytes()) }
                .map_err(|e| format!("Symbol '{}' not found in '{}': {e}", fn_name, dylib_path.display()))?;
        unsafe { lang_fn() }
    };
    Ok((lang, lib))
}

impl DynamicGrammar {
    /// Test-only constructor: accepts a statically linked Language so tests
    /// can exercise the registry without loading a dylib.
    #[cfg(test)]
    pub fn for_test(
        language_id: &str,
        file_types: &[&str],
        language: tree_sitter::Language,
    ) -> Self {
        Self {
            language_id: language_id.to_string(),
            file_types: file_types.iter().map(|s| s.to_string()).collect(),
            language: Arc::new(language),
            highlights_query: String::new(),
            injections_query: None,
            bracket_pairs: Vec::new(),
            _library: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn by_extension_returns_none_for_unregistered() {
        let registry = GrammarRegistry::new();
        assert!(registry.language_by_extension("zig").is_none());
    }

    #[test]
    fn ext_map_populated_on_register() {
        let registry = GrammarRegistry::new();
        let grammar = DynamicGrammar::for_test(
            "json",
            &["json", "jsonc"],
            tree_sitter_json::LANGUAGE.into(),
        );
        registry.register(grammar);

        assert!(registry.language_by_extension("json").is_some());
        assert!(registry.language_by_extension("jsonc").is_some());
        assert!(registry.language_by_extension("toml").is_none());
    }

    #[test]
    fn unregister_removes_grammar() {
        let registry = GrammarRegistry::new();
        let grammar = DynamicGrammar::for_test(
            "json",
            &["json"],
            tree_sitter_json::LANGUAGE.into(),
        );
        registry.register(grammar);
        assert!(registry.has_language("json"));

        registry.unregister("json");
        assert!(!registry.has_language("json"));
        assert!(registry.language_by_extension("json").is_none());
    }

    #[test]
    fn highlights_query_returns_stored_value() {
        let registry = GrammarRegistry::new();
        let mut grammar = DynamicGrammar::for_test(
            "rust",
            &["rs"],
            tree_sitter_rust::LANGUAGE.into(),
        );
        grammar.highlights_query = "(comment) @comment".to_string();
        registry.register(grammar);

        assert_eq!(
            registry.highlights_query("rust"),
            Some("(comment) @comment".to_string()),
        );
        assert_eq!(registry.highlights_query("python"), None);
    }

    #[test]
    fn load_from_dylib_rejects_invalid_language_id() {
        let path = std::path::Path::new("/tmp/fake.so");
        assert!(load_from_dylib("", path).is_err());
        assert!(load_from_dylib("foo bar", path).is_err());
        assert!(load_from_dylib("../escape", path).is_err());
    }

    #[test]
    fn load_from_dylib_rejects_nonexistent_file() {
        let path = std::path::Path::new("/tmp/this-does-not-exist-12345.so");
        let result = load_from_dylib("zig", path);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Cannot load"));
    }

    #[test]
    fn has_language_works() {
        let registry = GrammarRegistry::new();
        assert!(!registry.has_language("toml"));

        let grammar = DynamicGrammar::for_test(
            "toml",
            &["toml"],
            tree_sitter_json::LANGUAGE.into(), // stand-in
        );
        registry.register(grammar);
        assert!(registry.has_language("toml"));
    }

    #[test]
    fn second_register_overrides_first() {
        let registry = GrammarRegistry::new();

        let g1 = DynamicGrammar::for_test(
            "lang-a",
            &["x"],
            tree_sitter_json::LANGUAGE.into(),
        );
        registry.register(g1);

        let g2 = DynamicGrammar::for_test(
            "lang-b",
            &["x"],
            tree_sitter_rust::LANGUAGE.into(),
        );
        registry.register(g2);

        // File extension "x" should now point to lang-b
        let ext_map = registry.ext_map.lock().unwrap();
        assert_eq!(ext_map.get("x"), Some(&"lang-b".to_string()));
    }
}
