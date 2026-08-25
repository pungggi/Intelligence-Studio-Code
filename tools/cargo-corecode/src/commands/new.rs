//! `cargo corecode new` — scaffolds a new WASM extension project from a template.
//!
//! The scaffold is self-contained: the current `corecode.wit` is embedded into
//! the binary at compile time and written to `{name}/wit/corecode.wit`, so the
//! generated project builds anywhere (the real published workflow is the
//! `corecode-extension-api` crate — Phase 6+).

/// WIT definitions copied into every scaffolded project.
/// Path relative to this file: tools/cargo-corecode/src/commands → repo root.
const CORECODE_WIT: &str = include_str!("../../../../src/app/src-tauri/wit/corecode.wit");

pub fn run(name: &str, template: &str) -> anyhow::Result<()> {
    use std::fs;
    let dir = std::path::Path::new(name);
    anyhow::ensure!(!dir.exists(), "Directory '{}' already exists", name);

    let template = match template {
        "language-provider" | "format-provider" | "grammar" | "webview" => template,
        other => {
            anyhow::bail!(
                "Unknown template '{other}'. Use language-provider, format-provider, grammar, or webview"
            );
        }
    };

    fs::create_dir_all(dir.join("src"))?;
    fs::create_dir_all(dir.join("wit"))?;

    // Cargo.toml
    fs::write(
        dir.join("Cargo.toml"),
        format!(
            r#"[package]
name    = "{name}"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
wit-bindgen = "0.43"

[profile.release]
opt-level = "s"
lto = true
strip = true
"#
        ),
    )?;

    // build.rs — WIT reachability check + rebuild on WIT change
    fs::write(
        dir.join("build.rs"),
        r#"fn main() {
    let wit = std::path::Path::new("wit/corecode.wit");
    if !wit.exists() {
        panic!("wit/corecode.wit not found — expected next to Cargo.toml");
    }
    println!("cargo:rerun-if-changed={}", wit.display());
}
"#,
    )?;

    // corecode.toml
    let (capabilities, grammar_section) = match template {
        "grammar" => (
            "workspace_read = false\nnetwork_fetch  = false\nwebview_panels = false",
            format!("\n[grammar]\nlanguage-id = \"{name}\"\nfile-types = [\"{name}\"]\n"),
        ),
        "webview" => (
            "workspace_read = false\nnetwork_fetch  = false\nwebview_panels = true",
            String::new(),
        ),
        _ => (
            "workspace_read = false\nnetwork_fetch  = false\nwebview_panels = false",
            String::new(),
        ),
    };

    fs::write(
        dir.join("corecode.toml"),
        format!(
            r#"[extension]
id      = "my-publisher.{name}"
name    = "{name}"
version = "0.1.0"

[entry]
wasm = "{name}.wasm"

[capabilities]
{capabilities}{grammar_section}"#
        ),
    )?;

    // wit/corecode.wit — embedded copy of the current definitions
    fs::write(dir.join("wit/corecode.wit"), CORECODE_WIT)?;

    // src/lib.rs based on template
    let lib_rs = match template {
        "language-provider" => TEMPLATE_LANGUAGE_PROVIDER,
        "format-provider" => TEMPLATE_FORMAT_PROVIDER,
        "grammar" => TEMPLATE_GRAMMAR,
        "webview" => TEMPLATE_WEBVIEW,
        _ => unreachable!(),
    };
    fs::write(dir.join("src/lib.rs"), lib_rs)?;

    println!("  Created extension '{name}' with template '{template}'");
    println!("  Build:   cd {name} && cargo build --target wasm32-wasip2 --release");
    println!("  Package: cargo corecode build --target all --release");
    println!("  Publish: cargo corecode publish --dry-run");
    Ok(())
}

const TEMPLATE_LANGUAGE_PROVIDER: &str = r#"//! Language provider extension — completions, hover, diagnostics, formatting.
//!
//! Implements every function of the `language-provider` interface. Delete the
//! ones you do not need — all of them are required by the interface, so keep a
//! stub returning an empty result if you do not want a feature.

wit_bindgen::generate!({
    world: "corecode-language-extension",
    path: "wit",
});

use corecode::extension::types::CompletionKind;
use corecode::extension::ui;
use exports::corecode::extension::language_provider::{
    CodeAction, CompletionItem, Diagnostic, FoldingRange, HoverResult, Location, Position, Range,
    Symbol, TextEdit,
};
use exports::corecode::extension::language_provider::Guest as LanguageProvider;
use exports::corecode::extension::lifecycle::Guest;

struct MyExtension;

impl Guest for MyExtension {
    fn activate() -> Result<(), String> {
        ui::log("my-ext", "Extension activated");
        Ok(())
    }

    fn deactivate() {
        ui::log("my-ext", "Extension deactivated");
    }
}

impl LanguageProvider for MyExtension {
    fn completions(
        _uri: String,
        _pos: Position,
        _trigger: Option<String>,
    ) -> Result<Vec<CompletionItem>, String> {
        Ok(vec![CompletionItem {
            label: "hello".into(),
            kind: Some(CompletionKind::Text),
            detail: Some("Greeting".into()),
            documentation: None,
            insert_text: "hello".into(),
            filter_text: None,
        }])
    }

    fn hover(_uri: String, _pos: Position) -> Result<Option<HoverResult>, String> {
        Ok(Some(HoverResult {
            contents: "Hello from my extension!".into(),
            range: None,
        }))
    }

    fn diagnostics(_uri: String, _content: String) -> Result<Vec<Diagnostic>, String> {
        Ok(vec![])
    }

    fn format_document(_uri: String, _content: String) -> Result<Vec<TextEdit>, String> {
        Ok(vec![])
    }

    fn format_range(
        _uri: String,
        _content: String,
        _range: Range,
    ) -> Result<Vec<TextEdit>, String> {
        Ok(vec![])
    }

    fn definition(_uri: String, _pos: Position) -> Result<Option<Location>, String> {
        Ok(None)
    }

    fn references(
        _uri: String,
        _pos: Position,
        _include_decl: bool,
    ) -> Result<Vec<Location>, String> {
        Ok(vec![])
    }

    fn rename(
        _uri: String,
        _pos: Position,
        _new_name: String,
    ) -> Result<Vec<TextEdit>, String> {
        Ok(vec![])
    }

    fn code_actions(
        _uri: String,
        _range: Range,
        _diagnostics: Vec<Diagnostic>,
    ) -> Result<Vec<CodeAction>, String> {
        Ok(vec![])
    }

    fn workspace_symbols(_query: String) -> Result<Vec<Symbol>, String> {
        Ok(vec![])
    }

    fn folding_ranges(_uri: String, _content: String) -> Result<Vec<FoldingRange>, String> {
        Ok(vec![])
    }
}

export!(MyExtension);
"#;

const TEMPLATE_FORMAT_PROVIDER: &str = r#"//! Format-only extension — document and range formatting.
//!
//! Uses the `corecode-language-extension` world but leaves every provider
//! function as a stub; implement `format_document` / `format_range` and keep
//! the rest empty.

wit_bindgen::generate!({
    world: "corecode-language-extension",
    path: "wit",
});

use corecode::extension::ui;
use exports::corecode::extension::language_provider::{
    CodeAction, CompletionItem, Diagnostic, FoldingRange, HoverResult, Location, Position, Range,
    Symbol, TextEdit,
};
use exports::corecode::extension::language_provider::Guest as LanguageProvider;
use exports::corecode::extension::lifecycle::Guest;

struct MyFormatter;

impl Guest for MyFormatter {
    fn activate() -> Result<(), String> {
        ui::log("my-formatter", "Formatter activated");
        Ok(())
    }

    fn deactivate() {
        ui::log("my-formatter", "Formatter deactivated");
    }
}

impl LanguageProvider for MyFormatter {
    fn completions(
        _uri: String,
        _pos: Position,
        _trigger: Option<String>,
    ) -> Result<Vec<CompletionItem>, String> {
        Ok(vec![])
    }

    fn hover(_uri: String, _pos: Position) -> Result<Option<HoverResult>, String> {
        Ok(None)
    }

    fn diagnostics(_uri: String, _content: String) -> Result<Vec<Diagnostic>, String> {
        Ok(vec![])
    }

    fn format_document(_uri: String, _content: String) -> Result<Vec<TextEdit>, String> {
        // TODO: implement formatting — return edits sorted end-to-start
        Ok(vec![])
    }

    fn format_range(
        _uri: String,
        _content: String,
        _range: Range,
    ) -> Result<Vec<TextEdit>, String> {
        // TODO: implement range formatting
        Ok(vec![])
    }

    fn definition(_uri: String, _pos: Position) -> Result<Option<Location>, String> {
        Ok(None)
    }

    fn references(
        _uri: String,
        _pos: Position,
        _include_decl: bool,
    ) -> Result<Vec<Location>, String> {
        Ok(vec![])
    }

    fn rename(
        _uri: String,
        _pos: Position,
        _new_name: String,
    ) -> Result<Vec<TextEdit>, String> {
        Ok(vec![])
    }

    fn code_actions(
        _uri: String,
        _range: Range,
        _diagnostics: Vec<Diagnostic>,
    ) -> Result<Vec<CodeAction>, String> {
        Ok(vec![])
    }

    fn workspace_symbols(_query: String) -> Result<Vec<Symbol>, String> {
        Ok(vec![])
    }

    fn folding_ranges(_uri: String, _content: String) -> Result<Vec<FoldingRange>, String> {
        Ok(vec![])
    }
}

export!(MyFormatter);
"#;

const TEMPLATE_GRAMMAR: &str = r##"//! Grammar extension — provides a highlights query and bracket pairs.
//!
//! The tree-sitter grammar itself is a pre-built native dylib shipped next to
//! the extension (see `grammar-dylib` in corecode.toml), never returned from
//! WASM code.

wit_bindgen::generate!({
    world: "corecode-grammar-extension",
    path: "wit",
});

use corecode::extension::ui;
use exports::corecode::extension::grammar_provider::Guest as GrammarProvider;
use exports::corecode::extension::lifecycle::Guest;

struct MyGrammar;

impl Guest for MyGrammar {
    fn activate() -> Result<(), String> {
        ui::log("my-grammar", "Grammar extension activated");
        Ok(())
    }

    fn deactivate() {
        ui::log("my-grammar", "Grammar extension deactivated");
    }
}

impl GrammarProvider for MyGrammar {
    fn highlights_query() -> String {
        // Tree-sitter S-expression query mapping captures to highlighting groups.
        // See examples/grammar-toml/queries/highlights.scm for a real example.
        r#"(comment) @comment
(string) @string
(number) @number"#.into()
    }

    fn injections_query() -> Option<String> {
        None
    }

    fn bracket_pairs() -> String {
        r#"[["{","}"],["(",")"],["[","]"],["<",">"]]"#.into()
    }
}

export!(MyGrammar);
"##;

const TEMPLATE_WEBVIEW: &str = r##"//! Webview extension — opens an HTML panel and reacts to its messages.

wit_bindgen::generate!({
    world: "corecode-webview-extension",
    path: "wit",
});

use corecode::extension::ui;
use corecode::extension::webview;
use exports::corecode::extension::lifecycle::Guest;
use exports::corecode::extension::webview_provider::Guest as WebviewProvider;

struct MyWebview;

impl Guest for MyWebview {
    fn activate() -> Result<(), String> {
        // column: 1 = active, 2 = beside
        let _ = webview::open_panel("main-panel", "My Panel", 1);
        Ok(())
    }

    fn deactivate() {}
}

impl WebviewProvider for MyWebview {
    /// `state` is the JSON string saved by the last panel instance, or "".
    fn get_html(_panel_id: String, _state: String) -> String {
        r#"<!DOCTYPE html>
<html>
<head><title>My Panel</title></head>
<body>
  <h1>Hello from WASM!</h1>
  <button id="btn">Click me</button>
  <script src="corecode-bridge.js"></script>
  <script>
    document.getElementById('btn').addEventListener('click', () => {
      coreCode.postMessage({ type: 'clicked' });
    });
  </script>
</body>
</html>"#.into()
    }

    fn on_message(_panel_id: String, message: String) {
        ui::log("my-webview", &format!("Received: {message}"));
        let _ = webview::post_message("main-panel", &format!("{{\"echo\":{message}}}"));
    }

    fn on_close(_panel_id: String) {
        ui::log("my-webview", "Panel closed");
    }
}

export!(MyWebview);
"##;
