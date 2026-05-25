//! Unified Language Dispatch Layer
//!
//! Merges language features from two sources:
//! - WASM Extensions (in-process, via WasmHostManager)
//! - LSP Servers (via IPC Bridge, Node.js Extension Host)
//!
//! Architecture invariant:
//! - WASM errors are logged but never propagated (Vec<> not Result<>, internally isolated)
//! - LSP errors are handled gracefully (if let Ok)
//! - Diagnostics are push-based (read from state), not requested

use crate::ipc_bridge::{Diagnostic as LspDiagnostic, DiagnosticSeverity as LspSeverity};
use crate::wasm_host::{self, wit_types::Severity as WasmSeverity};

/// Convert WASM severity to LSP severity.
pub fn convert_severity(wasm: &WasmSeverity) -> LspSeverity {
    match wasm {
        WasmSeverity::Error => LspSeverity::Error,
        WasmSeverity::Warning => LspSeverity::Warning,
        WasmSeverity::Information => LspSeverity::Info,
        WasmSeverity::Hint => LspSeverity::Hint,
    }
}

/// Merge completions from WASM and LSP.
///
/// WASM completions come first (more specific to the project/language).
/// LSP completions are appended as fallback/general knowledge.
pub fn merged_completions(
    wasm_items: Vec<wasm_host::CompletionItem>,
    lsp_result: Result<serde_json::Value, String>,
) -> Vec<serde_json::Value> {
    let wasm_json: Vec<serde_json::Value> = wasm_items
        .into_iter()
        .map(serde_json::to_value)
        .filter_map(Result::ok)
        .collect();

    let mut merged = wasm_json;

    if let Ok(lsp_val) = lsp_result {
        if let Some(items) = lsp_val.get("items").and_then(|v| v.as_array()) {
            for item in items {
                merged.push(item.clone());
            }
        }
    }

    merged
}

/// Merge diagnostics from WASM (pull) and stored LSP (push).
///
/// LSP diagnostics arrive asynchronously via publishDiagnostics.
/// WASM diagnostics are computed on-demand (needs file content).
///
/// Results are sorted by line number.
pub fn merged_diagnostics_for_uri(
    uri: &str,
    wasm_diags: &[wasm_host::wit_types::Diagnostic],
    lsp_diags: &[LspDiagnostic],
) -> Vec<LspDiagnostic> {
    // Filter LSP diagnostics by URI (they're stored globally)
    let lsp_filtered: Vec<LspDiagnostic> = lsp_diags
        .iter()
        .filter(|d| d.uri.as_deref() == Some(uri))
        .cloned()
        .collect();

    // Map WASM diagnostics to LspDiagnostic format
    let wasm_mapped: Vec<LspDiagnostic> = wasm_diags
        .iter()
        .map(|d| LspDiagnostic {
            uri: Some(uri.to_string()),
            line: d.range.start.line as usize,
            col_start: d.range.start.character as usize,
            end_line: Some(d.range.end.line as usize),
            col_end: d.range.end.character as usize,
            severity: convert_severity(&d.severity),
            message: d.message.clone(),
            source: d.source.clone().unwrap_or_else(|| "wasm".to_string()),
        })
        .collect();

    // Merge and sort by line
    let mut combined = lsp_filtered;
    combined.extend(wasm_mapped);
    combined.sort_by_key(|d| d.line);
    combined
}

/// Merge hover from WASM and LSP.
///
/// WASM takes priority (first result wins paradigm).
/// LSP is used as fallback if WASM returns None.
pub fn merged_hover(
    wasm: Option<wasm_host::HoverResult>,
    lsp_result: Result<serde_json::Value, String>,
) -> Option<serde_json::Value> {
    if let Some(h) = wasm {
        if let Ok(json) = serde_json::to_value(&h) {
            return Some(json);
        }
    }

    // LSP fallback
    lsp_result.ok()
}

/// Merge definition from WASM and LSP.
///
/// WASM takes priority (first result wins).
/// LSP is used as fallback.
pub fn merged_definition(
    wasm: Option<wasm_host::Location>,
    lsp_result: Result<serde_json::Value, String>,
) -> Option<serde_json::Value> {
    if let Some(loc) = wasm {
        if let Ok(json) = serde_json::to_value(&loc) {
            return Some(json);
        }
    }

    lsp_result.ok()
}

/// Merge references from WASM and LSP.
///
/// Both are merged (set union semantics) since references are inherently list-like.
pub fn merged_references(
    wasm_locs: Vec<wasm_host::Location>,
    lsp_result: Result<serde_json::Value, String>,
) -> Vec<serde_json::Value> {
    let mut merged: Vec<serde_json::Value> = wasm_locs
        .into_iter()
        .map(serde_json::to_value)
        .filter_map(Result::ok)
        .collect();

    if let Ok(lsp_val) = lsp_result {
        if let Some(locs) = lsp_val.as_array() {
            for loc in locs {
                merged.push(loc.clone());
            }
        }
    }

    merged
}

/// Derive lang_id from a file URI.
///
/// "file:///path/foo.rs" → "rs" → ext_to_language_id("rs") → "rust"
pub fn lang_id_from_uri(uri: &str) -> String {
    // URL -> Path
    let path = if uri.starts_with("file://") {
        if let Ok(u) = url::Url::parse(uri) {
            if let Ok(p) = u.to_file_path() {
                p
            } else {
                return "plaintext".to_string();
            }
        } else {
            return "plaintext".to_string();
        }
    } else {
        std::path::Path::new(uri).to_path_buf()
    };

    path.extension()
        .and_then(|e| e.to_str())
        .map(crate::ext_to_language_id)
        .unwrap_or_else(|| "plaintext".to_string())
}

/// Convert a file:// URI to a filesystem path string.
pub fn uri_to_path(uri: &str) -> String {
    if let Ok(u) = url::Url::parse(uri) {
        if u.scheme() == "file" {
            if let Ok(path) = u.to_file_path() {
                return path.to_string_lossy().to_string();
            }
        }
    }
    // Fallback: strip prefix and percent-decode
    let raw = uri.strip_prefix("file:///")
        .or_else(|| uri.strip_prefix("file://"))
        .unwrap_or(uri);
    percent_decode(raw)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h = (bytes[i + 1] as char).to_digit(16);
            let l = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (h, l) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wasm_host::wit_types::{CompletionItem, HoverResult, Location, Position, Range, Severity, Diagnostic as WasmDiag};

    fn zero_range() -> Range {
        Range {
            start: Position { line: 0, character: 0 },
            end: Position { line: 0, character: 0 },
        }
    }

    fn lsp_diag(uri: &str, line: usize, msg: &str) -> LspDiagnostic {
        LspDiagnostic {
            uri: Some(uri.to_string()),
            line,
            col_start: 0,
            end_line: None,
            col_end: 0,
            severity: LspSeverity::Warning,
            message: msg.to_string(),
            source: "test".to_string(),
        }
    }

    fn wasm_diag(line: u32, msg: &str) -> WasmDiag {
        WasmDiag {
            range: Range {
                start: Position { line, character: 0 },
                end: Position { line, character: 0 },
            },
            severity: Severity::Warning,
            message: msg.to_string(),
            source: None,
            code: None,
        }
    }

    // ── merged_completions ────────────────────────────────────────────────────

    #[test]
    fn merged_completions_wasm_first() {
        let wasm = vec![CompletionItem {
            label: "wasm_item".to_string(),
            kind: None,
            detail: None,
            documentation: None,
            insert_text: "wasm_item".to_string(),
            filter_text: None,
        }];
        let lsp = Ok(serde_json::json!({ "items": [{ "label": "lsp_item" }] }));
        let merged = merged_completions(wasm, lsp);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0]["label"], "wasm_item");
        assert_eq!(merged[1]["label"], "lsp_item");
    }

    #[test]
    fn merged_completions_lsp_error_ignored() {
        let wasm = vec![];
        let result = merged_completions(wasm, Err("lsp down".to_string()));
        assert!(result.is_empty());
    }

    #[test]
    fn merged_completions_no_items_key_in_lsp() {
        let wasm = vec![];
        let lsp = Ok(serde_json::json!({ "other": [] }));
        let result = merged_completions(wasm, lsp);
        assert!(result.is_empty());
    }

    // ── merged_diagnostics_for_uri ────────────────────────────────────────────

    #[test]
    fn merged_diagnostics_sorted_by_line() {
        let uri = "file:///foo.rs";
        let wasm = vec![wasm_diag(5, "wasm at 5")];
        let lsp = vec![lsp_diag(uri, 2, "lsp at 2")];
        let merged = merged_diagnostics_for_uri(uri, &wasm, &lsp);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].line, 2);
        assert_eq!(merged[1].line, 5);
    }

    #[test]
    fn merged_diagnostics_filters_by_uri() {
        let uri = "file:///foo.rs";
        let other = "file:///bar.rs";
        let lsp = vec![
            lsp_diag(uri, 1, "for foo"),
            lsp_diag(other, 1, "for bar"),
        ];
        let merged = merged_diagnostics_for_uri(uri, &[], &lsp);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].message, "for foo");
    }

    #[test]
    fn merged_diagnostics_wasm_source_defaults_to_wasm() {
        let uri = "file:///foo.rs";
        let wasm = vec![wasm_diag(0, "err")];
        let merged = merged_diagnostics_for_uri(uri, &wasm, &[]);
        assert_eq!(merged[0].source, "wasm");
    }

    // ── merged_hover ──────────────────────────────────────────────────────────

    #[test]
    fn merged_hover_wasm_takes_priority() {
        let wasm_result = Some(HoverResult { contents: "wasm".to_string(), range: None });
        let lsp_result = Ok(serde_json::json!({ "contents": "lsp" }));
        let out = merged_hover(wasm_result, lsp_result);
        assert!(out.is_some());
        assert_eq!(out.unwrap()["contents"], "wasm");
    }

    #[test]
    fn merged_hover_falls_back_to_lsp_when_wasm_none() {
        let out = merged_hover(None, Ok(serde_json::json!({ "contents": "lsp" })));
        assert!(out.is_some());
        assert_eq!(out.unwrap()["contents"], "lsp");
    }

    #[test]
    fn merged_hover_returns_none_when_both_empty() {
        let out = merged_hover(None, Err("".to_string()));
        assert!(out.is_none());
    }

    // ── merged_definition ────────────────────────────────────────────────────

    #[test]
    fn merged_definition_wasm_takes_priority() {
        let loc = Location { uri: "file:///a.rs".to_string(), range: zero_range() };
        let out = merged_definition(Some(loc), Ok(serde_json::json!({ "uri": "file:///b.rs" })));
        assert_eq!(out.unwrap()["uri"], "file:///a.rs");
    }

    #[test]
    fn merged_definition_falls_back_to_lsp() {
        let out = merged_definition(None, Ok(serde_json::json!({ "uri": "file:///b.rs" })));
        assert_eq!(out.unwrap()["uri"], "file:///b.rs");
    }

    // ── merged_references ────────────────────────────────────────────────────

    #[test]
    fn merged_references_union_of_both() {
        let wasm = vec![Location { uri: "file:///a.rs".to_string(), range: zero_range() }];
        let lsp = Ok(serde_json::json!([{ "uri": "file:///b.rs" }]));
        let out = merged_references(wasm, lsp);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn merged_references_lsp_error_still_returns_wasm() {
        let wasm = vec![Location { uri: "file:///a.rs".to_string(), range: zero_range() }];
        let out = merged_references(wasm, Err("down".to_string()));
        assert_eq!(out.len(), 1);
    }

    // ── lang_id_from_uri ──────────────────────────────────────────────────────

    #[cfg(not(windows))]
    #[test]
    fn lang_id_from_uri_rust() {
        assert_eq!(lang_id_from_uri("file:///path/foo.rs"), "rust");
    }

    #[cfg(windows)]
    #[test]
    fn lang_id_from_uri_rust_windows() {
        assert_eq!(lang_id_from_uri("file:///C:/path/foo.rs"), "rust");
    }

    #[cfg(not(windows))]
    #[test]
    fn lang_id_from_uri_typescript() {
        assert_eq!(lang_id_from_uri("file:///path/foo.ts"), "typescript");
    }

    #[cfg(windows)]
    #[test]
    fn lang_id_from_uri_typescript_windows() {
        assert_eq!(lang_id_from_uri("file:///C:/path/foo.ts"), "typescript");
    }

    #[cfg(not(windows))]
    #[test]
    fn lang_id_from_uri_no_extension_is_plaintext() {
        assert_eq!(lang_id_from_uri("file:///path/Makefile"), "plaintext");
    }

    #[cfg(windows)]
    #[test]
    fn lang_id_from_uri_no_extension_is_plaintext_windows() {
        assert_eq!(lang_id_from_uri("file:///C:/path/Makefile"), "plaintext");
    }

    #[test]
    fn lang_id_from_uri_bare_path_fallback() {
        // Bare paths (non file://) use the fallback path extraction.
        assert_eq!(lang_id_from_uri("foo.py"), "python");
    }

    // ── uri_to_path ───────────────────────────────────────────────────────────

    #[cfg(not(windows))]
    #[test]
    fn uri_to_path_unix() {
        let path = uri_to_path("file:///home/user/file.rs");
        assert_eq!(path, "/home/user/file.rs");
    }

    #[cfg(windows)]
    #[test]
    fn uri_to_path_windows() {
        let path = uri_to_path("file:///C:/Users/file.rs");
        assert!(path.contains("file.rs"), "got: {path}");
    }

    #[test]
    fn uri_to_path_percent_decoded() {
        // Fallback branch handles percent-decoding when to_file_path() fails.
        let raw = "my%20file.rs";
        let path = uri_to_path(raw);
        assert_eq!(path, "my file.rs");
    }

    #[test]
    fn uri_to_path_non_file_uri_passthrough() {
        let raw = "not-a-uri";
        let path = uri_to_path(raw);
        assert_eq!(path, raw);
    }
}