//! `cargo corecode new` — scaffolds a new WASM extension project from a template.

pub fn run(name: &str, template: &str) -> anyhow::Result<()> {
    use std::fs;
    let dir = std::path::Path::new(name);
    anyhow::ensure!(!dir.exists(), "Directory '{}' already exists", name);

    fs::create_dir_all(dir.join("src"))?;

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
wit-bindgen = "0.36"

[profile.release]
opt-level = "s"
lto = true
strip = true
"#
        ),
    )?;

    // build.rs — WIT file location check
    fs::write(
        dir.join("build.rs"),
        r#"fn main() {
    println!("cargo:rerun-if-changed=corecode.toml");
}
"#,
    )?;

    // corecode.toml
    let (capabilities, grammar_section) = match template {
        "grammar" => (
            "workspace_read = false\nnetwork_fetch  = false\nwebview_panels = false",
            format!(
                "\n[grammar]\nlanguage_id = \"{name}\"\nfile_types = [\".{name}\"]\n"
            ),
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
{capabilities}
{grammar_section}"#
        ),
    )?;

    // src/lib.rs based on template
    let lib_rs = match template {
        "language-provider" => TEMPLATE_LANGUAGE_PROVIDER,
        "format-provider" => TEMPLATE_FORMAT_PROVIDER,
        "grammar" => TEMPLATE_GRAMMAR,
        "webview" => TEMPLATE_WEBVIEW,
        _ => {
            println!("  Unknown template '{template}', using 'language-provider'");
            TEMPLATE_LANGUAGE_PROVIDER
        }
    };
    fs::write(dir.join("src/lib.rs"), lib_rs)?;

    println!("  Created extension '{name}' with template '{template}'");
    println!("  Build: cd {name} && cargo build --target wasm32-wasip2 --release");
    println!("  Package: cargo corecode build --target all --release");
    Ok(())
}

const TEMPLATE_LANGUAGE_PROVIDER: &str = r#"//! Language provider extension — completions, hover, diagnostics, and formatting.

wit_bindgen::generate!({
    world: "corecode-language-extension",
    path: "../../src/app/src-tauri/wit",
});

struct MyExtension;

impl Guest for MyExtension {
    fn activate() -> Result<(), String> {
        log("my-ext", "Extension activated");
        Ok(())
    }
    fn deactivate() {}
}

impl GuestLanguageProvider for MyExtension {
    fn completions(_uri: String, _position: Position, _trigger: Option<String>) -> Result<Vec<CompletionItem>, String> {
        Ok(vec![
            CompletionItem {
                label: "hello".into(),
                insert_text: "hello".into(),
                detail: Some("Greeting".into()),
                documentation: None,
            },
        ])
    }

    fn hover(_uri: String, _position: Position) -> Result<Option<HoverResult>, String> {
        Ok(Some(HoverResult {
            contents: "Hello from my extension!".into(),
        }))
    }

    fn diagnostics(_uri: String) -> Result<Vec<Diagnostic>, String> {
        Ok(vec![])
    }

    fn format_document(_uri: String, _options: Option<String>) -> Result<Vec<TextEdit>, String> {
        Ok(vec![])
    }

    fn format_range(_uri: String, _range: Range, _options: Option<String>) -> Result<Vec<TextEdit>, String> {
        Ok(vec![])
    }

    fn definition(_uri: String, _position: Position) -> Result<Option<Location>, String> {
        Ok(None)
    }

    fn references(_uri: String, _position: Position) -> Result<Vec<Location>, String> {
        Ok(vec![])
    }

    fn rename(_uri: String, _position: Position, _new_name: String) -> Result<Vec<WorkspaceEdit>, String> {
        Ok(vec![])
    }

    fn code_actions(_uri: String, _range: Range) -> Result<Vec<CodeAction>, String> {
        Ok(vec![])
    }

    fn workspace_symbols(_query: String) -> Result<Vec<SymbolInfo>, String> {
        Ok(vec![])
    }

    fn folding_ranges(_uri: String) -> Result<Vec<FoldingRange>, String> {
        Ok(vec![])
    }
}

export!(MyExtension);
"#;

const TEMPLATE_FORMAT_PROVIDER: &str = r#"//! Format-only extension — provides document and range formatting.

wit_bindgen::generate!({
    world: "corecode-language-extension",
    path: "../../src/app/src-tauri/wit",
});

struct MyFormatter;

impl Guest for MyFormatter {
    fn activate() -> Result<(), String> {
        log("my-formatter", "Formatter activated");
        Ok(())
    }
    fn deactivate() {}
}

impl GuestLanguageProvider for MyFormatter {
    fn completions(_uri: String, _position: Position, _trigger: Option<String>) -> Result<Vec<CompletionItem>, String> {
        Ok(vec![])
    }

    fn hover(_uri: String, _position: Position) -> Result<Option<HoverResult>, String> {
        Ok(None)
    }

    fn diagnostics(_uri: String) -> Result<Vec<Diagnostic>, String> {
        Ok(vec![])
    }

    fn format_document(_uri: String, _options: Option<String>) -> Result<Vec<TextEdit>, String> {
        // TODO: Implement your formatting logic here
        Ok(vec![])
    }

    fn format_range(_uri: String, _range: Range, _options: Option<String>) -> Result<Vec<TextEdit>, String> {
        Ok(vec![])
    }

    fn definition(_uri: String, _position: Position) -> Result<Option<Location>, String> {
        Ok(None)
    }

    fn references(_uri: String, _position: Position) -> Result<Vec<Location>, String> {
        Ok(vec![])
    }

    fn rename(_uri: String, _position: Position, _new_name: String) -> Result<Vec<WorkspaceEdit>, String> {
        Ok(vec![])
    }

    fn code_actions(_uri: String, _range: Range) -> Result<Vec<CodeAction>, String> {
        Ok(vec![])
    }

    fn workspace_symbols(_query: String) -> Result<Vec<SymbolInfo>, String> {
        Ok(vec![])
    }

    fn folding_ranges(_uri: String) -> Result<Vec<FoldingRange>, String> {
        Ok(vec![])
    }
}

export!(MyFormatter);
"#;

const TEMPLATE_GRAMMAR: &str = r#"//! Grammar extension — provides Tree-sitter grammar and highlights.

wit_bindgen::generate!({
    world: "corecode-extension",
    path: "../../src/app/src-tauri/wit",
});

struct MyGrammar;

impl Guest for MyGrammar {
    fn activate() -> Result<(), String> {
        log("my-grammar", "Grammar extension activated");
        Ok(())
    }
    fn deactivate() {}
}

export!(MyGrammar);
"#;

const TEMPLATE_WEBVIEW: &str = r##"//! Webview extension — provides a webview panel.

wit_bindgen::generate!({
    world: "corecode-webview-extension",
    path: "../../src/app/src-tauri/wit",
});

struct MyWebview;

impl Guest for MyWebview {
    fn activate() -> Result<(), String> {
        open_panel("main-panel", "My Panel", "one");
        Ok(())
    }
    fn deactivate() {}
}

impl GuestWebviewProvider for MyWebview {
    fn get_html(_panel_id: String, _state: Option<String>) -> String {
        r#"<!DOCTYPE html>
<html>
<head><title>My Panel</title></head>
<body>
  <h1>Hello from WASM!</h1>
  <button onclick="coreCode.postMessage({type: 'clicked'})">Click me</button>
  <script src="corecode-bridge.js"></script>
</body>
</html>"#.into()
    }

    fn on_message(_panel_id: String, json: String) -> Option<String> {
        log("my-webview", &format!("Received: {json}"));
        None
    }

    fn on_close(_panel_id: String) {
        log("my-webview", "Panel closed");
    }
}

export!(MyWebview);
"##;
