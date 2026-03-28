# Phase 3 — Grammar Provider

**Goal:** A WASM extension can supply a tree-sitter grammar and syntax highlighting
for any language, loaded at runtime without recompiling CoreCode.

**Depends on:** Phase 1 (WASM Host Foundation)

---

## 1. WIT additions

Add to `wit/corecode.wit`:

```wit
interface grammar-provider {
  // Return the compiled tree-sitter grammar as WASM bytes.
  // The grammar itself is a separate .wasm, not the extension .wasm.
  grammar-wasm: func() -> list<u8>;

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
    /// The parsed tree-sitter Language, loaded via tree-sitter's WASM loader.
    pub language: tree_sitter::Language,
    pub highlights_query: String,
    pub injections_query: Option<String>,
    pub bracket_pairs: Vec<[String; 2]>,
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
        let mut ext_map = self.ext_map.lock().unwrap();
        for ft in &grammar.file_types {
            ext_map.insert(ft.clone(), grammar.language_id.clone());
        }
        self.dynamic.lock().unwrap()
            .insert(grammar.language_id.clone(), grammar);
    }

    /// Look up a grammar by file extension. Returns None if not registered dynamically.
    pub fn by_extension(&self, ext: &str) -> Option<tree_sitter::Language> {
        let lang_id = self.ext_map.lock().unwrap().get(ext)?.clone();
        let map = self.dynamic.lock().unwrap();
        Some(map.get(&lang_id)?.language.clone())
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
    grammar: &DynamicGrammar,
    dylib_path: &std::path::Path,
) -> Result<tree_sitter::Language, String> {
    // Security: verify path is inside extension directory before loading
    let lib = unsafe { libloading::Library::new(dylib_path) }
        .map_err(|e| format!("Cannot load grammar dylib: {e}"))?;

    let fn_name = format!("tree_sitter_{}", grammar.language_id.replace('-', "_"));
    let lang_fn: libloading::Symbol<unsafe extern "C" fn() -> tree_sitter::Language> =
        unsafe { lib.get(fn_name.as_bytes()) }
            .map_err(|e| format!("Symbol '{}' not found: {e}", fn_name))?;

    Ok(unsafe { lang_fn() })
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
        .map(|f| { /* call */ })
        .transpose()?
        .unwrap_or_default();

    let injections = self.injections_query_fn.as_ref()
        .map(|f| { /* call */ })
        .transpose()?;

    let bracket_pairs_json = self.bracket_pairs_fn.as_ref()
        .map(|f| { /* call */ })
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

    let grammar = crate::grammar_registry::DynamicGrammar {
        language_id: config.language_id.clone(),
        file_types: config.file_types.clone(),
        language: crate::grammar_registry::load_from_dylib(
            &crate::grammar_registry::DynamicGrammar {
                language_id: config.language_id.clone(),
                ..Default::default()
            },
            &canonical_dylib
        )?,
        highlights_query: highlights,
        injections_query: injections,
        bracket_pairs,
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
    -> Option<tree_sitter::Language>
{
    // Existing static matches:
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())?;

    match ext {
        "js" | "mjs" | "cjs" => Some(tree_sitter_javascript::language()),
        "rs"                  => Some(tree_sitter_rust::language()),
        "py"                  => Some(tree_sitter_python::language()),
        "json"                => Some(tree_sitter_json::language()),
        "ts" | "tsx"          => Some(tree_sitter_typescript::language_typescript()),
        "html"                => Some(tree_sitter_html::language()),
        "css"                 => Some(tree_sitter_css::language()),
        "md"                  => Some(tree_sitter_md::language()),

        // New: fall through to dynamic registry
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
dylib        = "tree-sitter-toml.so"

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
    fn grammar_wasm() -> Vec<u8> {
        // The dylib is shipped as a sidecar; return empty here.
        // The host reads it via manifest.grammar.dylib, not this function.
        vec![]
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

```rust
// grammar_registry.rs #[cfg(test)]

#[test]
fn by_extension_returns_none_for_unregistered() {
    let registry = GrammarRegistry::new();
    assert!(registry.by_extension("zig").is_none());
}

#[test]
fn ext_map_populated_on_register() {
    // Create a DynamicGrammar with a mock Language (skip dylib for unit test)
    // Register it, then verify by_extension returns Some
}
```

---

## 8. Acceptance criteria

- Opening a `.toml` file with `examples/grammar-toml` installed produces syntax highlighting
- The TOML grammar tokens are colour-coded the same way as the built-in JS/Rust grammars
- Opening a `.rs` file is unchanged — built-in Rust grammar still used
- `grammar_registry.by_extension("toml")` returns the registered language in unit tests
