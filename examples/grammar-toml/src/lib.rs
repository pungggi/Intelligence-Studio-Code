//! TOML Grammar — CoreCode WASM extension demonstrating the grammar-provider API.
//!
//! This extension provides:
//! - A highlights.scm query for syntax highlighting
//! - Bracket pair definitions
//!
//! The native tree-sitter grammar dylib is shipped as a pre-built file alongside
//! the extension (referenced by `grammar-dylib` in `corecode.toml`), NOT returned
//! at runtime by WASM code. This prevents sandbox escapes.
//!
//! Build:
//!   cargo build --target wasm32-wasip2 --release
//!   cp target/wasm32-wasip2/release/grammar_toml.wasm grammar-toml.wasm
//!
//! To produce the grammar dylib, compile tree-sitter-toml as a cdylib for your
//! host platform and place the resulting .so/.dylib/.dll in the extension directory.

wit_bindgen::generate!({
    world: "corecode-grammar-extension",
    path: "../../src/app/src-tauri/wit/corecode.wit",
});

struct TomlGrammar;

impl Guest for TomlGrammar {
    fn activate() -> Result<(), String> {
        ui::log("TOML Grammar", "Grammar provider activated for TOML files.");
        Ok(())
    }

    fn deactivate() {
        ui::log("TOML Grammar", "Grammar provider deactivated.");
    }
}

impl exports::corecode::extension::grammar_provider::Guest for TomlGrammar {
    fn highlights_query() -> String {
        include_str!("../queries/highlights.scm").to_string()
    }

    fn injections_query() -> Option<String> {
        None
    }

    fn bracket_pairs() -> String {
        r#"[["[","]"],["{","}"],["\"","\""]]"#.to_string()
    }
}

export!(TomlGrammar);
