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

/// Normalize a WASM TextEdit into LSP-style JSON: `{ range, newText }`.
fn text_edit_to_lsp_json(e: &wasm_host::wit_types::TextEdit) -> serde_json::Value {
    serde_json::json!({
        "range": {
            "start": { "line": e.range.start.line, "character": e.range.start.character },
            "end":   { "line": e.range.end.line,   "character": e.range.end.character },
        },
        "newText": e.new_text,
    })
}

/// Merge format edits — LSP priority, WASM fallback.
///
/// Matches existing frontend behavior: prefer LSP formatter output (rustfmt,
/// prettier, etc.) when non-empty; otherwise fall back to WASM extension edits.
/// Returns LSP-style `{ range, newText }` objects.
pub fn merged_format_edits(
    wasm_edits: &[wasm_host::wit_types::TextEdit],
    lsp_result: Result<serde_json::Value, String>,
) -> Vec<serde_json::Value> {
    if let Ok(val) = lsp_result {
        if let Some(arr) = val.as_array() {
            if !arr.is_empty() {
                return arr.clone();
            }
        }
    }
    wasm_edits.iter().map(text_edit_to_lsp_json).collect()
}

/// Merge rename edits — LSP priority, WASM fallback.
///
/// Returns a list of `WorkspaceFileEdit`-shaped JSON objects ready for
/// `apply_workspace_edit`. Accepts both LSP `WorkspaceEdit.changes` (already
/// pre-normalized by the Node host) and `WorkspaceEdit.documentChanges`
/// (an array of `{ textDocument: { uri }, edits: [{ range, newText }] }`),
/// which is converted to the snake_case `WorkspaceFileEdit` shape. Falls back
/// to WASM edits wrapped into a single change targeting `uri`.
pub fn merged_rename_changes(
    wasm_edits: &[wasm_host::wit_types::TextEdit],
    uri: &str,
    lsp_result: Result<serde_json::Value, String>,
) -> Vec<serde_json::Value> {
    if let Ok(val) = lsp_result {
        if let Some(changes) = val.get("changes").and_then(|v| v.as_array()) {
            if !changes.is_empty() {
                return changes.clone();
            }
        }
        if let Some(doc_changes) = val.get("documentChanges").and_then(|v| v.as_array()) {
            let converted: Vec<serde_json::Value> = doc_changes
                .iter()
                .filter_map(lsp_document_change_to_file_edit)
                .collect();
            if !converted.is_empty() {
                return converted;
            }
        }
    }
    if wasm_edits.is_empty() {
        return vec![];
    }
    let edits: Vec<serde_json::Value> = wasm_edits
        .iter()
        .map(|e| {
            serde_json::json!({
                "start_line": e.range.start.line as usize,
                "start_col":  e.range.start.character as usize,
                "end_line":   e.range.end.line as usize,
                "end_col":    e.range.end.character as usize,
                "new_text":   e.new_text,
            })
        })
        .collect();
    vec![serde_json::json!({ "uri": uri, "edits": edits })]
}

/// Convert a single LSP `documentChanges[i]` (a `TextDocumentEdit`) to the
/// snake_case `WorkspaceFileEdit` shape expected by `apply_workspace_edit`.
/// Returns `None` if the entry is a resource op (create/rename/delete file)
/// rather than a `TextDocumentEdit`.
fn lsp_document_change_to_file_edit(item: &serde_json::Value) -> Option<serde_json::Value> {
    let uri = item.get("textDocument")?.get("uri")?.as_str()?;
    let lsp_edits = item.get("edits")?.as_array()?;
    let edits: Vec<serde_json::Value> = lsp_edits
        .iter()
        .filter_map(|e| {
            let range = e.get("range")?;
            let start = range.get("start")?;
            let end = range.get("end")?;
            let new_text = e
                .get("newText")
                .or_else(|| e.get("new_text"))
                .and_then(|v| v.as_str())?;
            Some(serde_json::json!({
                "start_line": start.get("line")?.as_u64()? as usize,
                "start_col":  start.get("character")?.as_u64()? as usize,
                "end_line":   end.get("line")?.as_u64()? as usize,
                "end_col":    end.get("character")?.as_u64()? as usize,
                "new_text":   new_text,
            }))
        })
        .collect();
    if edits.is_empty() {
        return None;
    }
    Some(serde_json::json!({ "uri": uri, "edits": edits }))
}

/// Merge code actions — union of LSP and WASM results.
///
/// LSP items appear first (preserving their already-normalized shape).
/// WASM `CodeAction { title, kind, edits }` is normalized into a workspace-edit
/// envelope: `{ title, kind, isPreferred: false, edit: { changes: [...] } }`.
pub fn merged_code_actions(
    wasm_actions: Vec<wasm_host::wit_types::CodeAction>,
    lsp_result: Result<serde_json::Value, String>,
    fallback_uri: &str,
) -> Vec<serde_json::Value> {
    let mut merged: Vec<serde_json::Value> = Vec::new();
    if let Ok(val) = lsp_result {
        if let Some(arr) = val.as_array() {
            merged.extend(arr.iter().cloned());
        }
    }
    for a in wasm_actions {
        let changes: Vec<serde_json::Value> = a
            .edits
            .iter()
            .map(|e| {
                serde_json::json!({
                    "uri": fallback_uri,
                    "range": {
                        "start": { "line": e.range.start.line, "character": e.range.start.character },
                        "end":   { "line": e.range.end.line,   "character": e.range.end.character },
                    },
                    "newText": e.new_text,
                })
            })
            .collect();
        let edit = if changes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::json!({ "changes": changes })
        };
        merged.push(serde_json::json!({
            "title": a.title,
            "kind": a.kind,
            "isPreferred": false,
            "edit": edit,
        }));
    }
    merged
}

/// Merge workspace symbols — union of LSP and WASM results.
pub fn merged_workspace_symbols(
    wasm_symbols: Vec<wasm_host::wit_types::Symbol>,
    lsp_result: Result<serde_json::Value, String>,
) -> Vec<serde_json::Value> {
    let mut merged: Vec<serde_json::Value> = wasm_symbols
        .into_iter()
        .map(serde_json::to_value)
        .filter_map(Result::ok)
        .collect();
    if let Ok(val) = lsp_result {
        if let Some(arr) = val.as_array() {
            merged.extend(arr.iter().cloned());
        }
    }
    merged
}

/// Merge folding ranges — WASM priority, LSP fallback.
///
/// Returns `{ startLine, endLine, kind }` objects (frontend already normalizes
/// either casing, but emitting camelCase keeps parity with LSP shape).
pub fn merged_folding_ranges(
    wasm_ranges: &[wasm_host::wit_types::FoldingRange],
    lsp_result: Result<serde_json::Value, String>,
) -> Vec<serde_json::Value> {
    if !wasm_ranges.is_empty() {
        return wasm_ranges
            .iter()
            .map(|r| {
                serde_json::json!({
                    "startLine": r.start_line,
                    "endLine":   r.end_line,
                    "kind":      r.kind,
                })
            })
            .collect();
    }
    if let Ok(val) = lsp_result {
        if let Some(arr) = val.as_array() {
            return arr.clone();
        }
    }
    vec![]
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
    use crate::wasm_host::wit_types::{
        CodeAction, CompletionItem, Diagnostic as WasmDiag, FoldingRange, HoverResult, Location,
        Position, Range, Severity, Symbol, SymbolKind, TextEdit,
    };

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

    // ── merged_format_edits ───────────────────────────────────────────────────

    fn text_edit(line: u32, ch: u32, new_text: &str) -> TextEdit {
        TextEdit {
            range: Range {
                start: Position { line, character: ch },
                end: Position { line, character: ch },
            },
            new_text: new_text.to_string(),
        }
    }

    #[test]
    fn merged_format_lsp_priority_when_non_empty() {
        let wasm = vec![text_edit(0, 0, "wasm")];
        let lsp = Ok(serde_json::json!([{ "range": {}, "newText": "lsp" }]));
        let out = merged_format_edits(&wasm, lsp);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["newText"], "lsp");
    }

    #[test]
    fn merged_format_falls_back_to_wasm_when_lsp_empty() {
        let wasm = vec![text_edit(3, 2, "hello")];
        let lsp = Ok(serde_json::json!([]));
        let out = merged_format_edits(&wasm, lsp);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["newText"], "hello");
        assert_eq!(out[0]["range"]["start"]["line"], 3);
        assert_eq!(out[0]["range"]["start"]["character"], 2);
    }

    #[test]
    fn merged_format_falls_back_to_wasm_when_lsp_error() {
        let wasm = vec![text_edit(0, 0, "wasm")];
        let out = merged_format_edits(&wasm, Err("lsp down".to_string()));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["newText"], "wasm");
    }

    #[test]
    fn merged_format_empty_when_both_empty() {
        let out = merged_format_edits(&[], Ok(serde_json::json!([])));
        assert!(out.is_empty());
    }

    // ── merged_rename_changes ─────────────────────────────────────────────────

    #[test]
    fn merged_rename_lsp_priority() {
        let wasm = vec![text_edit(0, 0, "wasm")];
        let lsp = Ok(serde_json::json!({
            "changes": [{ "uri": "file:///a.rs", "edits": [] }]
        }));
        let out = merged_rename_changes(&wasm, "file:///x.rs", lsp);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["uri"], "file:///a.rs");
    }

    #[test]
    fn merged_rename_wraps_wasm_into_workspace_edit_when_lsp_empty() {
        let wasm = vec![text_edit(2, 4, "newName")];
        let lsp = Ok(serde_json::json!({ "changes": [] }));
        let out = merged_rename_changes(&wasm, "file:///x.rs", lsp);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["uri"], "file:///x.rs");
        let edits = out[0]["edits"].as_array().unwrap();
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0]["new_text"], "newName");
        assert_eq!(edits[0]["start_line"], 2);
        assert_eq!(edits[0]["start_col"], 4);
    }

    #[test]
    fn merged_rename_empty_when_both_empty() {
        let out = merged_rename_changes(&[], "file:///x.rs", Ok(serde_json::json!({ "changes": [] })));
        assert!(out.is_empty());
    }

    #[test]
    fn merged_rename_converts_lsp_document_changes() {
        let lsp = Ok(serde_json::json!({
            "documentChanges": [{
                "textDocument": { "uri": "file:///a.rs", "version": 1 },
                "edits": [{
                    "range": {
                        "start": { "line": 5, "character": 2 },
                        "end":   { "line": 5, "character": 10 },
                    },
                    "newText": "renamed",
                }],
            }],
        }));
        let out = merged_rename_changes(&[], "file:///x.rs", lsp);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["uri"], "file:///a.rs");
        let edits = out[0]["edits"].as_array().unwrap();
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0]["start_line"], 5);
        assert_eq!(edits[0]["start_col"], 2);
        assert_eq!(edits[0]["end_line"], 5);
        assert_eq!(edits[0]["end_col"], 10);
        assert_eq!(edits[0]["new_text"], "renamed");
    }

    #[test]
    fn merged_rename_skips_resource_ops_in_document_changes() {
        let wasm = vec![text_edit(0, 0, "wasmFallback")];
        let lsp = Ok(serde_json::json!({
            "documentChanges": [
                { "kind": "create", "uri": "file:///new.rs" },
                { "kind": "rename", "oldUri": "a", "newUri": "b" },
            ],
        }));
        let out = merged_rename_changes(&wasm, "file:///x.rs", lsp);
        // No TextDocumentEdit entries -> fall through to WASM wrap
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["uri"], "file:///x.rs");
        assert_eq!(out[0]["edits"][0]["new_text"], "wasmFallback");
    }

    // ── merged_code_actions ───────────────────────────────────────────────────

    #[test]
    fn merged_code_actions_union_lsp_first() {
        let wasm = vec![CodeAction {
            title: "wasm action".to_string(),
            kind: Some("quickfix".to_string()),
            edits: vec![text_edit(0, 0, "fix")],
        }];
        let lsp = Ok(serde_json::json!([{ "title": "lsp action" }]));
        let out = merged_code_actions(wasm, lsp, "file:///x.rs");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["title"], "lsp action");
        assert_eq!(out[1]["title"], "wasm action");
        assert_eq!(out[1]["kind"], "quickfix");
        assert_eq!(out[1]["edit"]["changes"][0]["uri"], "file:///x.rs");
        assert_eq!(out[1]["edit"]["changes"][0]["newText"], "fix");
    }

    #[test]
    fn merged_code_actions_wasm_with_no_edits_has_null_edit() {
        let wasm = vec![CodeAction {
            title: "info".to_string(),
            kind: None,
            edits: vec![],
        }];
        let out = merged_code_actions(wasm, Err("down".to_string()), "file:///x.rs");
        assert_eq!(out.len(), 1);
        assert!(out[0]["edit"].is_null());
    }

    // ── merged_workspace_symbols ──────────────────────────────────────────────

    #[test]
    fn merged_workspace_symbols_union_wasm_first() {
        let wasm = vec![Symbol {
            name: "wasm_sym".to_string(),
            kind: SymbolKind::Function,
            location: Location { uri: "file:///a.rs".to_string(), range: zero_range() },
            container_name: None,
        }];
        let lsp = Ok(serde_json::json!([{ "name": "lsp_sym" }]));
        let out = merged_workspace_symbols(wasm, lsp);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["name"], "wasm_sym");
        assert_eq!(out[1]["name"], "lsp_sym");
    }

    #[test]
    fn merged_workspace_symbols_lsp_error_returns_wasm_only() {
        let wasm = vec![Symbol {
            name: "wasm_sym".to_string(),
            kind: SymbolKind::Function,
            location: Location { uri: "file:///a.rs".to_string(), range: zero_range() },
            container_name: None,
        }];
        let out = merged_workspace_symbols(wasm, Err("down".to_string()));
        assert_eq!(out.len(), 1);
    }

    // ── merged_folding_ranges ─────────────────────────────────────────────────

    #[test]
    fn merged_folding_wasm_priority() {
        let wasm = vec![FoldingRange { start_line: 1, end_line: 5, kind: Some("region".to_string()) }];
        let lsp = Ok(serde_json::json!([{ "startLine": 10, "endLine": 20 }]));
        let out = merged_folding_ranges(&wasm, lsp);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["startLine"], 1);
        assert_eq!(out[0]["endLine"], 5);
        assert_eq!(out[0]["kind"], "region");
    }

    #[test]
    fn merged_folding_falls_back_to_lsp_when_wasm_empty() {
        let out = merged_folding_ranges(
            &[],
            Ok(serde_json::json!([{ "startLine": 10, "endLine": 20 }])),
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["startLine"], 10);
    }

    #[test]
    fn merged_folding_empty_when_both_empty() {
        let out = merged_folding_ranges(&[], Err("down".to_string()));
        assert!(out.is_empty());
    }
}