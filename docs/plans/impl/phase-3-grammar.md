# Phase 3 — Grammar Provider

**Goal:** A WASM extension can supply a tree-sitter grammar and syntax highlighting
for any language, loaded at runtime without recompiling CoreCode.

**Depends on:** Phase 1 (WASM Host Foundation)

---

## 1. WIT additions

Add to `wit/corecode.wit`:

```wit
interface grammar-provider {
  // Return the compiled tree-sitter grammar as native shared library bytes
  // (.so on Linux, .dylib on macOS, .dll on Windows).
  // The host writes these bytes to a temp file and loads via libloading.
  grammar-wasm: func() -> result<list<u8>, string>;

  // Return the highlights.scm query string.
  highlights-query: func() -> string;

  // Return the injections.scm query string, or none if not needed.
  injections-query: func() -> option<string>;

  // Return bracket pair definitions as JSON: [["{","}"],["(",")"],...]
  bracket-pairs: func() -> string;
}

// Add to the world:
world corecode-extension {
  // ... existing ...
  export grammar-provider;   // optional
}
```

---

## 2. `corecode.toml` grammar claim

An extension can claim a language *either* through `[languages]` (language-provider)
or `[grammar]` (grammar-provider), or both. They are independent.

```toml
[grammar]
language-id   = "zig"           # language identifier used by the editor
file-types    = ["zig", "zir"]  # file extensions that activate this grammar
```

---

## 3. Dynamic grammar loading in `highlighting.rs`

The current `highlighting.rs` uses statically compiled tree-sitter grammars
(`tree_sitter_javascript::language()`, etc.). This needs a parallel path for runtime grammars.

### Current structure

`lib.rs` currently calls `highlighting::highlight_line(tree, rope, line_idx)` after
parsing with a statically selected `tree_sitter::Language`.

### Required change

Add a `DynamicGrammar` type and a registry:

```rust
// New file: src/app/src-tauri/src/grammar_registry.rs

use std::collections::HashMap;
use std::sync::Mutex;

/// A tree-sitter grammar loaded at runtime from a WASM binary.
pub struct DynamicGrammar {
    pub language_id: String,
    pub file_types: Vec<String>,
    /// The parsed tree-sitter Language, wrapped in Arc for safe sharing.
    pub language: Arc<tree_sitter::Language>,
    pub highlights_query: String,
    pub injections_query: Option<String>,
    pub bracket_pairs: Vec<[String; 2]>,
    /// Keeps the loaded shared library alive for the lifetime of the language.
    pub _library: Option<libloading::Library>,
}

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
        // Acquire both locks sequentially — not atomic, but ordered consistently
        // (ext_map before dynamic) to prevent deadlocks.
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

    /// Look up a grammar by file extension. Returns None if not registered dynamically.
    pub fn by_extension(&self, ext: &str) -> Option<Arc<tree_sitter::Language>> {
        let lang_id = self.ext_map.lock().unwrap().get(ext)?.clone();
        let map = self.dynamic.lock().unwrap();
        Some(Arc::clone(&map.get(&lang_id)?.language))
    }

    pub fn highlights_query(&self, lang_id: &str) -> Option<String> {
        let map = self.dynamic.lock().unwrap();
        Some(map.get(lang_id)?.highlights_query.clone())
    }
}
```

Add `grammar_registry: grammar_registry::GrammarRegistry` to `AppState`.

### Loading a tree-sitter grammar from WASM bytes

Tree-sitter supports loading grammars from WASM via its own WASM runtime. The Rust bindings
expose this via `tree_sitter::Language::from_wasm_bytes()` (or equivalent).

> **Implementation note:** `tree-sitter`'s `Language::from_wasm` requires a WASM engine
> (currently `wasmtime` or the browser WASM API). In the Rust CLI context, use the
> `tree-sitter` crate's `load_language_in_directory` or the `tree_sitter_loader` helper
> if available for the pinned version. Alternatively, call `unsafe { Language::from_raw(ptr) }`
> after loading the grammar with `libloading` if the grammar is a native `.so`/`.dll`.
>
> The cleanest path for cross-platform: **compile the extension's tree-sitter grammar to
> a native dylib at build time, ship it alongside `extension.wasm`, and load it via
> `libloading`**. This avoids the WASM-in-WASM complexity.

For the initial Phase 3, use the dylib approach:

```toml
# In corecode.toml for a grammar extension:
[grammar]
language-id   = "zig"
file-types    = ["zig"]
dylib         = "zig-grammar.so"   # or .dll / .dylib per platform
```

The grammar provider's `grammar-wasm` function returns the bytes of the native shared
library rather than a WASM grammar. The host loads it with `libloading`:

```rust
// In grammar_registry.rs

pub fn load_from_dylib(
    language_id: &str,
    dylib_path: &std::path::Path,
) -> Result<(tree_sitter::Language, libloading::Library), String> {
    // Validate language_id: only ASCII alphanumerics and hyphens are allowed.
    // This prevents unsafe characters from leaking into the constructed symbol name.
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
        .map_err(|e| format!("Cannot load grammar dylib: {e}"))?;

    let fn_name = format!("tree_sitter_{}", language_id.replace('-', "_"));
    let lang = {
        let lang_fn: libloading::Symbol<unsafe extern "C" fn() -> tree_sitter::Language> =
            unsafe { lib.get(fn_name.as_bytes()) }
                .map_err(|e| format!("Symbol '{}' not found: {e}", fn_name))?;
        unsafe { lang_fn() }
    };
    Ok((lang, lib))
}
```

Add `libloading = "0.8"` to `Cargo.toml`.

---

## 4. `wasm_host/manager.rs` — grammar registration

After activating a WASM instance, check for grammar exports and register:

```rust
fn activate_one(&self, ext_dir: &Path, ...) -> Result<(), String> {
    // ... existing activation ...

    // If the extension exports grammar-provider, load and register the grammar
    if let Some(manifest_grammar) = &manifest.grammar {
        match instance.load_grammar(ext_dir, manifest_grammar) {
            Ok(dynamic_grammar) => {
                self.grammar_registry.register(dynamic_grammar);
                log::info!("Registered grammar for '{}'", manifest_grammar.language_id);
            }
            Err(e) => log::warn!("Grammar load failed: {e}"),
        }
    }

    // ... insert instance ...
}
```

Add `load_grammar` to `WasmInstance`:

```rust
pub fn load_grammar(
    &mut self,
    ext_dir: &std::path::Path,
    config: &crate::wasm_host::manifest::GrammarConfig,
) -> Result<crate::grammar_registry::DynamicGrammar, String> {
    let highlights = self.highlights_query_fn.as_ref()
        .map(|f| f.call(&mut self.store, ()))
        .transpose()?
        .unwrap_or_default();

    let injections = self.injections_query_fn.as_ref()
        .map(|f| f.call(&mut self.store, ()))
        .transpose()?;

    let bracket_pairs_json = self.bracket_pairs_fn.as_ref()
        .map(|f| f.call(&mut self.store, ()))
        .transpose()?
        .unwrap_or_else(|| "[]".to_string());

    let bracket_pairs: Vec<[String; 2]> = serde_json::from_str(&bracket_pairs_json)
        .unwrap_or_default();

    // Verify and load the dylib
    let dylib_path = ext_dir.join(&config.dylib);
    let canonical_dylib = std::fs::canonicalize(&dylib_path)
        .map_err(|e| format!("Cannot resolve dylib: {e}"))?;
    let canonical_ext = std::fs::canonicalize(ext_dir)
        .map_err(|e| format!("Cannot resolve ext dir: {e}"))?;
    if !canonical_dylib.starts_with(&canonical_ext) {
        return Err("grammar dylib is outside extension directory".to_string());
    }

    let (language, library) = crate::grammar_registry::load_from_dylib(
        &config.language_id,
        &canonical_dylib,
    )?;

    let grammar = crate::grammar_registry::DynamicGrammar {
        language_id: config.language_id.clone(),
        file_types: config.file_types.clone(),
        language: std::sync::Arc::new(language),
        highlights_query: highlights,
        injections_query: injections,
        bracket_pairs,
        _library: Some(library),
    };

    Ok(grammar)
}
```

---

## 5. `editor.rs` / `lib.rs` — use dynamic grammar for unknown file types

In the existing language detection logic (`lib.rs` or `editor.rs`), after failing to
match a static grammar, fall through to the registry:

```rust
fn get_language_for_file(path: &str, grammar_registry: &GrammarRegistry)
    -> Option<Arc<tree_sitter::Language>>
{
    // Existing static matches (wrapped in Arc for uniform return type):
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())?;

    match ext {
        "js" | "mjs" | "cjs" => Some(Arc::new(tree_sitter_javascript::language())),
        "rs"                  => Some(Arc::new(tree_sitter_rust::language())),
        "py"                  => Some(Arc::new(tree_sitter_python::language())),
        "json"                => Some(Arc::new(tree_sitter_json::language())),
        "ts" | "tsx"          => Some(Arc::new(tree_sitter_typescript::language_typescript())),
        "html"                => Some(Arc::new(tree_sitter_html::language())),
        "css"                 => Some(Arc::new(tree_sitter_css::language())),
        "md"                  => Some(Arc::new(tree_sitter_md::language())),

        // Fall through to dynamic registry (already returns Arc<Language>)
        _ => grammar_registry.by_extension(ext),
    }
}
```

---

## 6. Example extension

Create `examples/grammar-toml/`:

```
examples/grammar-toml/
  Cargo.toml
  corecode.toml
  build.rs          ← compiles tree-sitter-toml to a dylib
  src/
    lib.rs
  queries/
    highlights.scm
```

`corecode.toml`:
```toml
[extension]
id      = "corecode.grammar-toml"
name    = "TOML Grammar"
version = "0.1.0"

[entry]
wasm = "grammar_toml.wasm"

[grammar]
language-id  = "toml"
file-types   = ["toml"]
dylib        = "tree-sitter-toml"   # base name; host appends platform suffix (.so/.dylib/.dll)

[capabilities]
workspace_read = false
```

`src/lib.rs`:
```rust
wit_bindgen::generate!({ world: "corecode-extension", path: "../../src/app/src-tauri/wit/" });

struct TomlGrammar;

impl Guest for TomlGrammar {
    fn activate() -> Result<(), String> { Ok(()) }
    fn deactivate() {}
}

impl GrammarProvider for TomlGrammar {
    fn grammar_wasm() -> Result<Vec<u8>, String> {
        // Return the grammar dylib bytes embedded at build time.
        // The host writes these to a temp file and loads via libloading.
        // Primary source: embedded bytes. Fallback: dylib path in corecode.toml.
        #[cfg(target_os = "linux")]
        const GRAMMAR_BYTES: &[u8] = include_bytes!("../tree-sitter-toml.so");
        #[cfg(target_os = "macos")]
        const GRAMMAR_BYTES: &[u8] = include_bytes!("../tree-sitter-toml.dylib");
        #[cfg(target_os = "windows")]
        const GRAMMAR_BYTES: &[u8] = include_bytes!("../tree-sitter-toml.dll");

        Ok(GRAMMAR_BYTES.to_vec())
    }

    fn highlights_query() -> String {
        include_str!("../queries/highlights.scm").to_string()
    }

    fn injections_query() -> Option<String> { None }

    fn bracket_pairs() -> String {
        r#"[["[","]"],["(",")"],["\"","\""]]"#.to_string()
    }
}

export!(TomlGrammar);
```

---

## 7. Tests

Add a `#[cfg(test)]` constructor to `DynamicGrammar` that accepts a raw
`tree_sitter::Language` so unit tests can inject any statically linked grammar
(e.g. `tree_sitter_json`) without loading a dylib at runtime:

```rust
// grammar_registry.rs

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
            language: std::sync::Arc::new(language),
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
        assert!(registry.by_extension("zig").is_none());
    }

    #[test]
    fn ext_map_populated_on_register() {
        let registry = GrammarRegistry::new();
        // Use any statically linked grammar as a stand-in
        let grammar = DynamicGrammar::for_test(
            "json",
            &["json", "jsonc"],
            tree_sitter_json::language(),
        );
        registry.register(grammar);

        assert!(registry.by_extension("json").is_some());
        assert!(registry.by_extension("jsonc").is_some());
        // Unrelated extensions remain unregistered
        assert!(registry.by_extension("toml").is_none());
    }

    #[test]
    fn load_from_dylib_rejects_invalid_language_id() {
        let path = std::path::Path::new("/tmp/fake.so");
        assert!(load_from_dylib("", path).is_err());
        assert!(load_from_dylib("foo bar", path).is_err());
        assert!(load_from_dylib("../escape", path).is_err());
        assert!(load_from_dylib("zig", path).is_err()); // file doesn't exist, but id is valid
    }
}
```

---

## 8. Acceptance criteria

- Opening a `.toml` file with `examples/grammar-toml` installed produces syntax highlighting
- The TOML grammar tokens are colour-coded the same way as the built-in JS/Rust grammars
- Opening a `.rs` file is unchanged — built-in Rust grammar still used
- `grammar_registry.by_extension("toml")` returns the registered language in unit tests
