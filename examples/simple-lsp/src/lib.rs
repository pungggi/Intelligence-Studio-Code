//! Simple LSP — minimal CoreCode WASM extension demonstrating the language-provider API.
//!
//! Claims the "plaintext" language and returns:
//! - One hard-coded completion item ("hello")
//! - One diagnostic for any line containing "TODO"
//! - A hover result showing "Plain text file"
//!
//! Build:
//!   cargo build --target wasm32-wasip2 --release
//!   cp target/wasm32-wasip2/release/simple_lsp.wasm simple-lsp.wasm

wit_bindgen::generate!({
    world: "corecode-language-extension",
    path: "../../src/app/src-tauri/wit/corecode.wit",
});

struct SimpleLsp;

impl Guest for SimpleLsp {
    fn activate() -> Result<(), String> {
        ui::log("Simple LSP", "Language provider activated for plaintext.");
        ui::set_status("simple-lsp-status", "Simple LSP", Some("Provides basic plaintext intelligence"));
        Ok(())
    }

    fn deactivate() {
        ui::log("Simple LSP", "Language provider deactivated.");
    }
}

impl exports::corecode::extension::language_provider::Guest for SimpleLsp {
    fn completions(
        _uri: String,
        _pos: exports::corecode::extension::language_provider::Position,
        _trigger: Option<String>,
    ) -> Result<Vec<exports::corecode::extension::language_provider::CompletionItem>, String> {
        use exports::corecode::extension::language_provider::{CompletionItem, CompletionKind};
        Ok(vec![
            CompletionItem {
                label: "hello".to_string(),
                kind: Some(CompletionKind::Text),
                detail: Some("Insert greeting".to_string()),
                documentation: Some("Inserts the word 'hello' — provided by simple-lsp WASM extension.".to_string()),
                insert_text: "hello".to_string(),
                filter_text: Some("hello".to_string()),
            },
            CompletionItem {
                label: "world".to_string(),
                kind: Some(CompletionKind::Text),
                detail: Some("Insert world".to_string()),
                documentation: None,
                insert_text: "world".to_string(),
                filter_text: Some("world".to_string()),
            },
        ])
    }

    fn hover(
        _uri: String,
        _pos: exports::corecode::extension::language_provider::Position,
    ) -> Result<Option<exports::corecode::extension::language_provider::HoverResult>, String> {
        use exports::corecode::extension::language_provider::HoverResult;
        Ok(Some(HoverResult {
            contents: "**Plain text file**\n\nProvided by `simple-lsp` WASM extension.".to_string(),
            range: None,
        }))
    }

    fn diagnostics(
        _uri: String,
        content: String,
    ) -> Result<Vec<exports::corecode::extension::language_provider::Diagnostic>, String> {
        use exports::corecode::extension::language_provider::{Diagnostic, Position, Range, Severity};
        let mut diags = Vec::new();
        for (line_idx, line) in content.lines().enumerate() {
            if let Some(col) = line.find("TODO") {
                diags.push(Diagnostic {
                    range: Range {
                        start: Position { line: line_idx as u32, character: col as u32 },
                        end: Position { line: line_idx as u32, character: (col + 4) as u32 },
                    },
                    severity: Severity::Warning,
                    message: "TODO found — consider resolving this item.".to_string(),
                    source: Some("simple-lsp".to_string()),
                    code: Some("todo-found".to_string()),
                });
            }
        }
        Ok(diags)
    }

    fn format_document(
        _uri: String,
        _content: String,
    ) -> Result<Vec<exports::corecode::extension::language_provider::TextEdit>, String> {
        Ok(vec![])
    }

    fn format_range(
        _uri: String,
        _content: String,
        _range: exports::corecode::extension::language_provider::Range,
    ) -> Result<Vec<exports::corecode::extension::language_provider::TextEdit>, String> {
        Ok(vec![])
    }

    fn definition(
        _uri: String,
        _pos: exports::corecode::extension::language_provider::Position,
    ) -> Result<Option<exports::corecode::extension::language_provider::Location>, String> {
        Ok(None)
    }

    fn references(
        _uri: String,
        _pos: exports::corecode::extension::language_provider::Position,
        _include_decl: bool,
    ) -> Result<Vec<exports::corecode::extension::language_provider::Location>, String> {
        Ok(vec![])
    }

    fn rename(
        _uri: String,
        _pos: exports::corecode::extension::language_provider::Position,
        _new_name: String,
    ) -> Result<Vec<exports::corecode::extension::language_provider::TextEdit>, String> {
        Ok(vec![])
    }

    fn code_actions(
        _uri: String,
        _range: exports::corecode::extension::language_provider::Range,
        _diagnostics: Vec<exports::corecode::extension::language_provider::Diagnostic>,
    ) -> Result<Vec<exports::corecode::extension::language_provider::CodeAction>, String> {
        Ok(vec![])
    }

    fn workspace_symbols(
        _query: String,
    ) -> Result<Vec<exports::corecode::extension::language_provider::Symbol>, String> {
        Ok(vec![])
    }

    fn folding_ranges(
        _uri: String,
        _content: String,
    ) -> Result<Vec<exports::corecode::extension::language_provider::FoldingRange>, String> {
        Ok(vec![])
    }
}

export!(SimpleLsp);
