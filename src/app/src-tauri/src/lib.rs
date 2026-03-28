mod debug;
mod editor;
mod ext_host;
mod extension_mgr;
mod highlighting;
mod ipc_bridge;
mod marketplace;
mod settings;
mod terminal;

use editor::WorkspaceState;
use ipc_bridge::{IpcHandle, OutgoingMessage};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

/// Maximum text insertion size (1 MB).
const MAX_INSERT_SIZE: usize = 1024 * 1024;

/// Shared app state accessible from Tauri commands.
struct AppState {
    /// Per-window workspace state, keyed by window label.
    workspaces: Arc<Mutex<HashMap<String, WorkspaceState>>>,
    ipc: IpcHandle,
    marketplace: marketplace::MarketplaceClient,
    extension_mgr: Mutex<extension_mgr::ExtensionManager>,
    settings: Mutex<settings::SettingsStore>,
    terminal_mgr: Mutex<terminal::TerminalManager>,
    debug_mgr: Arc<debug::DebugManager>,
}


// --- Path validation ---

/// Validate that `path` is a real, non-directory file within the user home directory.
///
/// Restrictions:
/// - Must be an existing, canonicalisable path (symlinks are resolved).
/// - Must not point to a directory.
/// - Must be within the current user's home directory to prevent extensions
///   from reading arbitrary system files (e.g. `/etc/passwd`).
///   If the home directory cannot be determined the restriction is skipped.
fn validate_path(path: &str) -> Result<String, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("Invalid path '{}': {}", path, e))?;

    if canonical.is_dir() {
        return Err(format!("Path is a directory: {}", path));
    }

    // Restrict to the user home directory — blocks access to /etc, /proc,
    // C:\Windows\System32, etc. while allowing all normal developer workflows.
    if let Some(home) = dirs::home_dir() {
        let home_canonical = std::fs::canonicalize(&home).unwrap_or(home);
        if !canonical.starts_with(&home_canonical) {
            return Err(format!(
                "Access denied: '{}' is outside the user home directory",
                canonical.display()
            ));
        }
    }

    Ok(canonical.to_string_lossy().to_string())
}

/// Convert a filesystem path to a `file://` URI, correctly percent-encoding
/// all characters that are not allowed unencoded in a URI path.
pub(crate) fn path_to_uri(path: &str) -> String {
    match url::Url::from_file_path(path) {
        Ok(u) => u.to_string(),
        Err(_) => {
            // Fallback: manual encode for the characters most likely to appear
            // in filenames (spaces, hashes, non-ASCII).  This path should only
            // be reached if the provided path is not absolute.
            let norm = path.replace('\\', "/");
            let encoded: String = norm.bytes().flat_map(|b| {
                // Unreserved characters (RFC 3986 §2.3) + '/' and ':' (path/drive)
                if b.is_ascii_alphanumeric()
                    || matches!(b, b'-' | b'.' | b'_' | b'~' | b'/' | b':')
                {
                    vec![b as char]
                } else {
                    format!("%{:02X}", b).chars().collect::<Vec<_>>()
                }
            }).collect();
            #[cfg(target_os = "windows")]
            { format!("file:///{}", encoded) }
            #[cfg(not(target_os = "windows"))]
            { format!("file://{}", encoded) }
        }
    }
}

fn ext_to_language_id(ext: &str) -> String {
    match ext {
        "js" | "mjs" | "cjs" => "javascript".to_string(),
        "jsx" => "javascriptreact".to_string(),
        "ts" => "typescript".to_string(),
        "tsx" => "typescriptreact".to_string(),
        "rs" => "rust".to_string(),
        "py" | "pyw" => "python".to_string(),
        "json" | "jsonc" => "json".to_string(),
        "html" | "htm" => "html".to_string(),
        "css" => "css".to_string(),
        "scss" => "scss".to_string(),
        "md" | "markdown" => "markdown".to_string(),
        other => other.to_string(),
    }
}

// --- Tauri Commands ---

/// Open a file into a buffer (multi-document: doesn't close previous files).
#[tauri::command]
fn open_file(path: String, state: tauri::State<AppState>, window: tauri::WebviewWindow) -> Result<EditorContent, String> {
    let canonical = validate_path(&path)?;
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = guard.entry(wid.clone()).or_insert_with(WorkspaceState::new);

    let is_new = ws.open_file(&canonical).map_err(|e| e.to_string())?;

    if is_new {
        // Reparse since open_file parsed initially but buffer needs tree
        ws.reparse_active();

        // Notify Extension Host of the new document
        if let Some(buf) = ws.active() {
            let ext = PathBuf::from(&canonical)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_string();
            let language_id = ext_to_language_id(&ext);
            let uri = path_to_uri(&canonical);
            state.ipc.send(OutgoingMessage::DidOpen {
                uri,
                language_id,
                version: buf.version(),
                text: buf.get_full_text(),
                workspace_id: Some(wid.clone()),
            });
        }
    }

    match ws.active() {
        Some(buf) => Ok(buf.get_content(&state.ipc)),
        None => Err("No active buffer".to_string()),
    }
}

/// Close a buffer. Returns the content of the next active buffer (if any).
#[tauri::command]
fn close_buffer(path: String, state: tauri::State<AppState>, window: tauri::WebviewWindow) -> Result<Option<EditorContent>, String> {
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = guard.entry(wid.clone()).or_insert_with(WorkspaceState::new);
    let path_buf = std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));

    // Send didClose for this buffer
    let uri = path_to_uri(&path);
    state.ipc.send(OutgoingMessage::DidClose { uri: uri.clone(), workspace_id: Some(wid) });
    state.ipc.clear_diagnostics_for_uri(&uri);

    ws.close_buffer(&path_buf);

    match ws.active() {
        Some(buf) => Ok(Some(buf.get_content(&state.ipc))),
        None => Ok(None),
    }
}

/// Switch to a different open buffer.
#[tauri::command]
fn switch_buffer(path: String, state: tauri::State<AppState>, window: tauri::WebviewWindow) -> Result<EditorContent, String> {
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = guard.entry(wid).or_insert_with(WorkspaceState::new);
    let path_buf = std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));

    if !ws.switch_buffer(&path_buf) {
        return Err(format!("Buffer not open: {}", path));
    }

    ws.reparse_active();

    match ws.active() {
        Some(buf) => Ok(buf.get_content(&state.ipc)),
        None => Err("No active buffer".to_string()),
    }
}

/// List all open buffers.
#[tauri::command]
fn list_open_buffers(state: tauri::State<AppState>, window: tauri::WebviewWindow) -> Result<Vec<editor::BufferInfo>, String> {
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = guard.entry(wid).or_insert_with(WorkspaceState::new);
    Ok(ws.list_open_buffers())
}

/// Read directory contents for the file explorer.
#[tauri::command]
fn read_directory(path: String) -> Result<Vec<editor::DirEntry>, String> {
    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("Invalid directory path '{}': {}", path, e))?;
    editor::read_directory(&canonical.to_string_lossy()).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_file(state: tauri::State<AppState>, window: tauri::WebviewWindow) -> Result<(), String> {
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = guard.entry(wid.clone()).or_insert_with(WorkspaceState::new);
    ws.save_active().map_err(|e| e.to_string())?;

    // Notify Extension Host that the document was saved
    if let Some(buf) = ws.active() {
        let uri = path_to_uri(&buf.file_path_str());
        state.ipc.send(OutgoingMessage::DidSave {
            uri,
            workspace_id: Some(wid),
        });
    }
    Ok(())
}

#[tauri::command]
fn get_content(state: tauri::State<AppState>, window: tauri::WebviewWindow) -> Result<EditorContent, String> {
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = guard.entry(wid).or_insert_with(WorkspaceState::new);
    match ws.active() {
        Some(buf) => Ok(buf.get_content(&state.ipc)),
        None => Ok(EditorContent {
            lines: vec![
                HighlightedLine { text: "// Welcome to CoreCode".to_string(), tokens: vec![] },
                HighlightedLine { text: "// Open a file to begin editing (Ctrl+O)".to_string(), tokens: vec![] },
                HighlightedLine { text: "// Or use the file explorer sidebar".to_string(), tokens: vec![] },
            ],
            line_count: 3,
            file_path: None,
            language: None,
            modified: false,
            diagnostics: vec![],
        }),
    }
}

/// M7: Get only the visible line range (virtualized rendering).
#[tauri::command]
fn get_visible_content(
    first_line: usize,
    line_count: usize,
    state: tauri::State<AppState>,
    window: tauri::WebviewWindow,
) -> Result<VisibleContent, String> {
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = guard.entry(wid).or_insert_with(WorkspaceState::new);
    match ws.active() {
        Some(buf) => Ok(buf.get_visible_content(first_line, line_count, &state.ipc)),
        None => Ok(VisibleContent {
            lines: vec![
                HighlightedLine { text: "// Welcome to CoreCode".to_string(), tokens: vec![] },
                HighlightedLine { text: "// Open a file to begin editing (Ctrl+O)".to_string(), tokens: vec![] },
            ],
            first_line: 0,
            total_lines: 2,
            file_path: None,
            language: None,
            modified: false,
            diagnostics: vec![],
        }),
    }
}

/// Helper: perform an edit, notify extension host, reparse, return lightweight result.
fn do_edit(ws: &mut WorkspaceState, ipc: &IpcHandle, workspace_id: &str) -> Result<EditResult, String> {
    let buf = ws.active().ok_or("No active buffer")?;
    let path_str = buf.file_path_str();
    let version = buf.version();
    let full_text = buf.get_full_text();
    notify_change(&path_str, version, &full_text, ipc, workspace_id);
    ws.reparse_active();
    let buf = ws.active().ok_or("No active buffer after reparse")?;
    Ok(EditResult {
        total_lines: buf.line_count(),
        modified: buf.modified(),
    })
}

#[tauri::command]
fn edit_insert(
    line: usize,
    col: usize,
    text: String,
    state: tauri::State<AppState>,
    window: tauri::WebviewWindow,
) -> Result<EditResult, String> {
    if text.len() > MAX_INSERT_SIZE {
        return Err(format!(
            "Insertion too large ({} bytes, max {})",
            text.len(),
            MAX_INSERT_SIZE
        ));
    }
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = guard.entry(wid.clone()).or_insert_with(WorkspaceState::new);
    let buf = ws.active_mut().ok_or("No active buffer")?;
    buf.insert(line, col, &text).map_err(|e| e.to_string())?;
    do_edit(ws, &state.ipc, &wid)
}

#[tauri::command]
fn edit_delete(
    line: usize,
    col: usize,
    len: usize,
    state: tauri::State<AppState>,
    window: tauri::WebviewWindow,
) -> Result<EditResult, String> {
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = guard.entry(wid.clone()).or_insert_with(WorkspaceState::new);
    let buf = ws.active_mut().ok_or("No active buffer")?;
    buf.delete(line, col, len).map_err(|e| e.to_string())?;
    do_edit(ws, &state.ipc, &wid)
}

#[tauri::command]
fn edit_newline(
    line: usize,
    col: usize,
    state: tauri::State<AppState>,
    window: tauri::WebviewWindow,
) -> Result<EditResult, String> {
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = guard.entry(wid.clone()).or_insert_with(WorkspaceState::new);
    let buf = ws.active_mut().ok_or("No active buffer")?;
    buf.insert(line, col, "\n").map_err(|e| e.to_string())?;
    do_edit(ws, &state.ipc, &wid)
}

#[tauri::command]
fn edit_backspace(
    line: usize,
    col: usize,
    state: tauri::State<AppState>,
    window: tauri::WebviewWindow,
) -> Result<EditResult, String> {
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = guard.entry(wid.clone()).or_insert_with(WorkspaceState::new);
    let buf = ws.active_mut().ok_or("No active buffer")?;
    buf.backspace(line, col).map_err(|e| e.to_string())?;
    do_edit(ws, &state.ipc, &wid)
}

#[tauri::command]
fn edit_undo(state: tauri::State<AppState>, window: tauri::WebviewWindow) -> Result<EditResult, String> {
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = guard.entry(wid.clone()).or_insert_with(WorkspaceState::new);
    let buf = ws.active_mut().ok_or("No active buffer")?;
    buf.undo();
    do_edit(ws, &state.ipc, &wid)
}

#[tauri::command]
fn edit_redo(state: tauri::State<AppState>, window: tauri::WebviewWindow) -> Result<EditResult, String> {
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = guard.entry(wid.clone()).or_insert_with(WorkspaceState::new);
    let buf = ws.active_mut().ok_or("No active buffer")?;
    buf.redo();
    do_edit(ws, &state.ipc, &wid)
}

#[tauri::command]
fn edit_replace_range(
    start_line: usize,
    start_col: usize,
    end_line: usize,
    end_col: usize,
    text: String,
    state: tauri::State<AppState>,
    window: tauri::WebviewWindow,
) -> Result<EditResult, String> {
    if text.len() > MAX_INSERT_SIZE {
        return Err(format!(
            "Replacement too large ({} bytes, max {})",
            text.len(),
            MAX_INSERT_SIZE
        ));
    }
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = guard.entry(wid.clone()).or_insert_with(WorkspaceState::new);
    let buf = ws.active_mut().ok_or("No active buffer")?;
    buf.replace_range(start_line, start_col, end_line, end_col, &text)
        .map_err(|e| e.to_string())?;
    do_edit(ws, &state.ipc, &wid)
}

#[tauri::command]
fn get_text_range(
    start_line: usize,
    start_col: usize,
    end_line: usize,
    end_col: usize,
    state: tauri::State<AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, String> {
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = guard.entry(wid).or_insert_with(WorkspaceState::new);
    let buf = ws.active().ok_or("No active buffer")?;
    Ok(buf.get_text_range(start_line, start_col, end_line, end_col))
}

#[tauri::command]
fn find_in_file(
    query: String,
    case_sensitive: bool,
    state: tauri::State<AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<editor::FindMatch>, String> {
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = guard.entry(wid).or_insert_with(WorkspaceState::new);
    let buf = ws.active().ok_or("No active buffer")?;
    Ok(buf.find_all(&query, case_sensitive))
}

#[tauri::command]
fn replace_in_file(
    query: String,
    replacement: String,
    case_sensitive: bool,
    replace_all: bool,
    state: tauri::State<AppState>,
    window: tauri::WebviewWindow,
) -> Result<ReplaceResult, String> {
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = guard.entry(wid.clone()).or_insert_with(WorkspaceState::new);
    let buf = ws.active_mut().ok_or("No active buffer")?;
    let matches = buf.find_all(&query, case_sensitive);

    if matches.is_empty() {
        return Ok(ReplaceResult { count: 0, content: buf.get_content(&state.ipc) });
    }

    let count;
    if replace_all {
        // Single-pass: collect all matches, then apply in reverse order
        // so earlier positions are not shifted by later replacements.
        let all_matches: Vec<_> = matches.iter().rev().cloned().collect();
        for m in &all_matches {
            buf.replace_range(m.line, m.col, m.line, m.col + m.length, &replacement)
                .map_err(|e| e.to_string())?;
        }
        count = all_matches.len();
    } else {
        let m = &matches[0];
        buf.replace_range(m.line, m.col, m.line, m.col + m.length, &replacement)
            .map_err(|e| e.to_string())?;
        count = 1;
    }

    let path_str = buf.file_path_str();
    let version = buf.version();
    let full_text = buf.get_full_text();
    let _ = buf;
    notify_change(&path_str, version, &full_text, &state.ipc, &wid);
    ws.reparse_active();
    let buf = ws.active().ok_or("No active buffer after replace")?;
    Ok(ReplaceResult {
        count,
        content: buf.get_content(&state.ipc),
    })
}

#[tauri::command]
fn get_diagnostics(state: tauri::State<AppState>) -> Result<Vec<ipc_bridge::Diagnostic>, String> {
    Ok(state.ipc.get_diagnostics())
}

#[tauri::command]
fn get_ext_host_status(state: tauri::State<AppState>) -> Result<ExtHostStatus, String> {
    Ok(ExtHostStatus {
        running: state.ipc.is_connected(),
        commands: state.ipc.get_commands(),
    })
}

#[tauri::command]
fn execute_command(command: String, state: tauri::State<AppState>) -> Result<(), String> {
    state.ipc.send(OutgoingMessage::ExecuteCommand {
        command,
        args: vec![],
    });
    Ok(())
}

#[tauri::command]
fn list_commands(state: tauri::State<AppState>) -> Result<Vec<String>, String> {
    Ok(state.ipc.get_commands())
}

#[tauri::command]
fn get_notifications(state: tauri::State<AppState>) -> Result<Vec<ipc_bridge::Notification>, String> {
    Ok(state.ipc.drain_notifications())
}

#[tauri::command]
fn get_ui_requests(state: tauri::State<AppState>) -> Result<Vec<ipc_bridge::UiRequest>, String> {
    Ok(state.ipc.drain_ui_requests())
}

#[tauri::command]
fn respond_ui_request(
    request_id: String,
    value: Option<serde_json::Value>,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    state.ipc.send(OutgoingMessage::UiResponse {
        request_id,
        value,
    });
    Ok(())
}

#[tauri::command]
fn get_status_bar_items(state: tauri::State<AppState>) -> Result<Vec<ipc_bridge::StatusBarItem>, String> {
    Ok(state.ipc.get_status_bar_items())
}

#[tauri::command]
fn get_output_lines(state: tauri::State<AppState>) -> Result<Vec<ipc_bridge::OutputLine>, String> {
    Ok(state.ipc.drain_output_lines())
}

/// Notify Extension Host of text changes.
fn notify_change(path_str: &str, version: u32, text: &str, ipc: &IpcHandle, workspace_id: &str) {
    ipc.send(OutgoingMessage::DidChange {
        uri: path_to_uri(path_str),
        version,
        text: text.to_string(),
        workspace_id: Some(workspace_id.to_string()),
    });
}

// --- M6: LSP Tauri Commands ---

/// Request hover information at a position.
#[tauri::command]
fn lsp_hover(
    uri: String,
    line: usize,
    character: usize,
    state: tauri::State<AppState>,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({ "uri": uri, "line": line, "character": character });
    state.ipc.request_sync("textDocument/hover", params)
}

/// Request completions at a position.
#[tauri::command]
fn lsp_completion(
    uri: String,
    line: usize,
    character: usize,
    trigger_kind: Option<u32>,
    trigger_character: Option<String>,
    state: tauri::State<AppState>,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({
        "uri": uri,
        "line": line,
        "character": character,
        "triggerKind": trigger_kind.unwrap_or(1),
        "triggerCharacter": trigger_character,
    });
    state.ipc.request_sync("textDocument/completion", params)
}

/// Request go-to-definition at a position.
#[tauri::command]
fn lsp_definition(
    uri: String,
    line: usize,
    character: usize,
    state: tauri::State<AppState>,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({ "uri": uri, "line": line, "character": character });
    state.ipc.request_sync("textDocument/definition", params)
}

/// Request find references at a position.
#[tauri::command]
fn lsp_references(
    uri: String,
    line: usize,
    character: usize,
    state: tauri::State<AppState>,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({ "uri": uri, "line": line, "character": character });
    state.ipc.request_sync("textDocument/references", params)
}

/// Request code actions for a range.
#[tauri::command]
fn lsp_code_action(
    uri: String,
    start_line: usize,
    start_character: usize,
    end_line: usize,
    end_character: usize,
    state: tauri::State<AppState>,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({
        "uri": uri,
        "startLine": start_line,
        "startCharacter": start_character,
        "endLine": end_line,
        "endCharacter": end_character,
    });
    state.ipc.request_sync("textDocument/codeAction", params)
}

/// Request signature help at a position.
#[tauri::command]
fn lsp_signature_help(
    uri: String,
    line: usize,
    character: usize,
    trigger_character: Option<String>,
    state: tauri::State<AppState>,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({
        "uri": uri,
        "line": line,
        "character": character,
        "triggerCharacter": trigger_character,
    });
    state.ipc.request_sync("textDocument/signatureHelp", params)
}

/// Request document symbols (outline).
#[tauri::command]
fn lsp_document_symbols(
    uri: String,
    state: tauri::State<AppState>,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({ "uri": uri });
    state.ipc.request_sync("textDocument/documentSymbol", params)
}

/// Request document formatting.
#[tauri::command]
fn lsp_format(
    uri: String,
    tab_size: Option<u32>,
    insert_spaces: Option<bool>,
    state: tauri::State<AppState>,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({
        "uri": uri,
        "tabSize": tab_size.unwrap_or(2),
        "insertSpaces": insert_spaces.unwrap_or(true),
    });
    state.ipc.request_sync("textDocument/formatting", params)
}

/// Request inline completions (ghost text) at a position.
#[tauri::command]
fn lsp_inline_completion(
    uri: String,
    line: usize,
    character: usize,
    state: tauri::State<AppState>,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({ "uri": uri, "line": line, "character": character, "triggerKind": 0 });
    state.ipc.request_sync("textDocument/inlineCompletion", params)
}

/// Drain tree view registration/update events from the Extension Host.
#[tauri::command]
fn get_tree_view_events(
    state: tauri::State<AppState>,
) -> Vec<ipc_bridge::TreeViewEvent> {
    state.ipc.drain_tree_view_events()
}

/// Fetch children for a tree view node (synchronous IPC request to Extension Host).
#[tauri::command]
fn tree_view_get_children(
    view_id: String,
    item_id: Option<String>,
    state: tauri::State<AppState>,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({ "view_id": view_id, "item_id": item_id });
    state.ipc.request_sync("treeView/getChildren", params)
}

/// Request inlay hints for a visible range.
#[tauri::command]
fn lsp_inlay_hints(
    uri: String,
    start_line: usize,
    end_line: usize,
    state: tauri::State<AppState>,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({ "uri": uri, "startLine": start_line, "endLine": end_line });
    state.ipc.request_sync("textDocument/inlayHint", params)
}

/// Request rename edits for the symbol at the given position.
#[tauri::command]
fn lsp_rename(
    uri: String,
    line: usize,
    character: usize,
    new_name: String,
    state: tauri::State<AppState>,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({ "uri": uri, "line": line, "character": character, "newName": new_name });
    state.ipc.request_sync("textDocument/rename", params)
}

/// Check if rename is available at the given position.
#[tauri::command]
fn lsp_prepare_rename(
    uri: String,
    line: usize,
    character: usize,
    state: tauri::State<AppState>,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({ "uri": uri, "line": line, "character": character });
    state.ipc.request_sync("textDocument/prepareRename", params)
}

/// Request document highlights for the symbol at the given position.
#[tauri::command]
fn lsp_document_highlights(
    uri: String,
    line: usize,
    character: usize,
    state: tauri::State<AppState>,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({ "uri": uri, "line": line, "character": character });
    state.ipc.request_sync("textDocument/documentHighlight", params)
}

/// Drain showTextDocument requests from the Extension Host.
#[tauri::command]
fn get_show_text_document_requests(
    state: tauri::State<AppState>,
) -> Vec<ipc_bridge::ShowTextDocumentRequest> {
    state.ipc.drain_show_text_document_requests()
}

// --- M8: Marketplace Commands ---

#[tauri::command]
async fn marketplace_search(
    query: String,
    offset: usize,
    limit: usize,
    state: tauri::State<'_, AppState>,
) -> Result<marketplace::MarketplaceSearchResult, String> {
    state.marketplace.search(&query, offset, limit).await
}

#[tauri::command]
async fn marketplace_get_extension(
    namespace: String,
    name: String,
    state: tauri::State<'_, AppState>,
) -> Result<marketplace::ExtensionInfo, String> {
    state.marketplace.get_extension(&namespace, &name).await
}

#[tauri::command]
fn marketplace_list_installed(
    state: tauri::State<AppState>,
) -> Result<Vec<extension_mgr::InstalledExtension>, String> {
    let mgr = state.extension_mgr.lock().map_err(|e| e.to_string())?;
    Ok(mgr.list_installed())
}

#[tauri::command]
async fn install_extension(
    namespace: String,
    name: String,
    state: tauri::State<'_, AppState>,
) -> Result<extension_mgr::InstalledExtension, String> {
    // Get extension details from Open VSX (derive download URL server-side to prevent SSRF)
    let info = state.marketplace.get_extension(&namespace, &name).await
        .map_err(|e| format!("Failed to get extension info: {e}"))?;

    // Derive download URL from the trusted API response
    let download_url = info.files.get("download")
        .ok_or_else(|| format!("No download URL found for {namespace}.{name}"))?;

    // Validate the download URL points to Open VSX
    if !download_url.starts_with("https://open-vsx.org/") {
        return Err(format!("Untrusted download URL: {download_url}"));
    }

    // Download the VSIX
    let vsix_bytes = state.marketplace.download_vsix(download_url).await?;
    let info = Some(info);

    let version = info.as_ref().map(|i| i.version.as_str()).unwrap_or("0.0.0");
    let display_name = info.as_ref().and_then(|i| i.display_name.as_deref());
    let description = info.as_ref().and_then(|i| i.description.as_deref());

    let installed = {
        let mgr = state.extension_mgr.lock().map_err(|e| e.to_string())?;
        mgr.install_from_vsix(&namespace, &name, version, display_name, description, &vsix_bytes)?
    };

    // Notify Extension Host about the new extension
    state.ipc.send(OutgoingMessage::ExtensionInstalled {
        path: installed.path.clone(),
    });

    Ok(installed)
}

#[tauri::command]
fn uninstall_extension(
    extension_id: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mgr = state.extension_mgr.lock().map_err(|e| e.to_string())?;
    mgr.uninstall(&extension_id)?;

    state.ipc.send(OutgoingMessage::ExtensionUninstalled {
        id: extension_id,
    });

    Ok(())
}

#[tauri::command]
async fn check_extension_updates(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<extension_mgr::ExtensionUpdateInfo>, String> {
    let installed_versions = {
        let mgr = state.extension_mgr.lock().map_err(|e| e.to_string())?;
        mgr.get_installed_versions()
    };

    let mut updates = Vec::new();
    for (id, current_version) in &installed_versions {
        let parts: Vec<&str> = id.splitn(2, '.').collect();
        if parts.len() != 2 {
            continue;
        }
        let (namespace, name) = (parts[0], parts[1]);

        match state.marketplace.get_extension(namespace, name).await {
            Ok(info) => {
                if info.version != *current_version {
                    let download_url = info
                        .files
                        .get("download")
                        .cloned()
                        .unwrap_or_default();
                    updates.push(extension_mgr::ExtensionUpdateInfo {
                        id: id.clone(),
                        current_version: current_version.clone(),
                        latest_version: info.version,
                        download_url,
                    });
                }
            }
            Err(e) => {
                log::warn!("Failed to check updates for {id}: {e}");
            }
        }
    }

    Ok(updates)
}

#[tauri::command]
fn get_extensions_dir(state: tauri::State<AppState>) -> Result<String, String> {
    let mgr = state.extension_mgr.lock().map_err(|e| e.to_string())?;
    Ok(mgr.extensions_dir().to_string_lossy().to_string())
}

// --- M8: Settings Commands ---

#[tauri::command]
fn get_settings(state: tauri::State<AppState>) -> Result<serde_json::Value, String> {
    let store = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(store.read_all())
}

#[tauri::command]
fn update_setting(
    key: String,
    value: serde_json::Value,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let store = state.settings.lock().map_err(|e| e.to_string())?;
    store.update(&key, value.clone())?;

    // Notify Extension Host about the setting change
    state.ipc.send(OutgoingMessage::SettingsChanged {
        key,
        value,
    });

    Ok(())
}

#[tauri::command]
fn reset_setting(key: String, state: tauri::State<AppState>) -> Result<(), String> {
    let store = state.settings.lock().map_err(|e| e.to_string())?;
    store.reset(&key)?;

    state.ipc.send(OutgoingMessage::SettingsChanged {
        key,
        value: serde_json::Value::Null,
    });

    Ok(())
}

#[tauri::command]
fn get_setting_definitions(
    state: tauri::State<AppState>,
) -> Result<serde_json::Value, String> {
    state.ipc.request_sync("settings/getDefinitions", serde_json::json!({}))
}

// --- M8b: Terminal Commands ---

#[tauri::command]
fn terminal_create(
    app: AppHandle,
    cwd: Option<String>,
    shell: Option<String>,
    cols: u32,
    rows: u32,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    // Reject shell paths that contain traversal sequences.
    if let Some(ref s) = shell {
        if s.contains("..") {
            return Err("Invalid shell path: path traversal not allowed".to_string());
        }
    }
    let mut mgr = state.terminal_mgr.lock().map_err(|e| e.to_string())?;
    mgr.create(
        &app,
        cwd.as_deref(),
        shell.as_deref(),
        cols as u16,
        rows as u16,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn terminal_write(
    terminal_id: String,
    data: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut mgr = state.terminal_mgr.lock().map_err(|e| e.to_string())?;
    mgr.write(&terminal_id, data.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn terminal_resize(
    terminal_id: String,
    cols: u32,
    rows: u32,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut mgr = state.terminal_mgr.lock().map_err(|e| e.to_string())?;
    mgr.resize(&terminal_id, cols as u16, rows as u16)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn terminal_close(
    terminal_id: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut mgr = state.terminal_mgr.lock().map_err(|e| e.to_string())?;
    mgr.close(&terminal_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn terminal_list(state: tauri::State<AppState>) -> Result<Vec<terminal::TerminalInfo>, String> {
    let mgr = state.terminal_mgr.lock().map_err(|e| e.to_string())?;
    Ok(mgr.list())
}

// --- M8b: Terminal extension API commands ---

/// Drain pending terminal events from Extension Host (create, write, show, close).
#[tauri::command]
fn get_terminal_events(
    state: tauri::State<AppState>,
) -> Result<Vec<ipc_bridge::TerminalEvent>, String> {
    Ok(state.ipc.drain_terminal_events())
}

/// Notify Extension Host that its terminal/create request was fulfilled.
#[tauri::command]
fn respond_terminal_created(
    request_id: String,
    terminal_id: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    state.ipc.send(OutgoingMessage::TerminalCreated { request_id, terminal_id });
    Ok(())
}

// --- Decorations ---

/// Get all decorations for a given URI (used by canvas renderer).
#[tauri::command]
fn get_decorations(uri: String, state: tauri::State<AppState>) -> Result<Vec<ipc_bridge::TextDecoration>, String> {
    Ok(state.ipc.get_decorations_for_uri(&uri))
}

// --- M8b: WebView Commands ---

/// Drain all pending webview panel events (create, setHtml, postMessage, reveal, close).
#[tauri::command]
fn get_webview_events(state: tauri::State<AppState>) -> Result<Vec<ipc_bridge::WebviewPanelEvent>, String> {
    Ok(state.ipc.drain_webview_events())
}

/// Forward a message from a webview iframe to the Extension Host.
#[tauri::command]
fn webview_post_message(
    panel_id: String,
    message: serde_json::Value,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    state.ipc.send(OutgoingMessage::WebviewMessageFromWebview { panel_id, message });
    Ok(())
}

/// Notify Extension Host that the user closed a webview panel.
#[tauri::command]
fn webview_close_by_user(panel_id: String, state: tauri::State<AppState>) -> Result<(), String> {
    state.ipc.send(OutgoingMessage::WebviewClosedByUser { panel_id });
    Ok(())
}

// --- workspace.applyEdit ---

/// Convert a file:// URI to a filesystem path string.
fn uri_to_path(uri: &str) -> String {
    let path_str = if let Some(rest) = uri.strip_prefix("file:///") {
        rest
    } else if let Some(rest) = uri.strip_prefix("file://") {
        rest
    } else {
        uri
    };
    path_str.replace("%20", " ").replace("%23", "#")
}

/// Apply a list of text edits (in descending position order) to a plain string.
/// Each edit replaces [start_line:start_col, end_line:end_col) with `new_text`.
fn apply_text_edits_to_str(text: &str, edits: &[ipc_bridge::WorkspaceTextEdit]) -> String {
    // Collect lines, preserving original line endings.
    let mut lines: Vec<String> = text.split('\n').map(|l| l.trim_end_matches('\r').to_string()).collect();
    let has_trailing_newline = text.ends_with('\n') || text.ends_with("\r\n");

    for edit in edits {
        let sl = edit.start_line.min(lines.len().saturating_sub(1));
        let el = edit.end_line.min(lines.len().saturating_sub(1));

        let start_line_text = lines.get(sl).cloned().unwrap_or_default();
        let end_line_text = lines.get(el).cloned().unwrap_or_default();

        let sc = edit.start_col.min(start_line_text.len());
        let ec = edit.end_col.min(end_line_text.len());

        let prefix = start_line_text[..sc].to_string();
        let suffix = end_line_text[ec..].to_string();
        let combined = prefix + &edit.new_text + &suffix;

        let new_lines: Vec<String> = combined.split('\n').map(|l| l.trim_end_matches('\r').to_string()).collect();
        let new_len = new_lines.len();
        lines.splice(sl..=el, new_lines);
        let _ = new_len; // suppress warning
    }

    let mut result = lines.join("\n");
    if has_trailing_newline && !result.ends_with('\n') {
        result.push('\n');
    }
    result
}

/// Drain pending workspace edit requests and return them to the frontend.
#[tauri::command]
fn get_workspace_edit_requests(
    state: tauri::State<AppState>,
) -> Result<Vec<ipc_bridge::WorkspaceEditRequest>, String> {
    Ok(state.ipc.drain_workspace_edit_requests())
}

/// Apply a WorkspaceEdit: a batch of text edits across potentially multiple files.
/// For open buffers the edit is applied in-memory; for other files it is applied
/// directly on disk.  Edits within each file are applied in reverse position order
/// to avoid offset shifts.
#[tauri::command]
fn apply_workspace_edit(
    changes: Vec<ipc_bridge::WorkspaceFileEdit>,
    state: tauri::State<AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = guard.entry(wid.clone()).or_insert_with(WorkspaceState::new);
    let original_active = ws.active_path().cloned();

    for file_edit in &changes {
        if file_edit.edits.is_empty() {
            continue;
        }
        // Canonicalize and enforce home-dir confinement before any file I/O.
        // Without this check a malicious extension could write to arbitrary paths
        // (e.g. ~/.ssh/authorized_keys) by supplying a crafted file:// URI.
        let path_str = validate_path(&uri_to_path(&file_edit.uri))?;
        let path = std::path::PathBuf::from(&path_str);

        // Sort edits in reverse position order so that applying each one does not
        // shift the positions of later edits.
        let mut edits = file_edit.edits.clone();
        edits.sort_by(|a, b| {
            (b.start_line, b.start_col).cmp(&(a.start_line, a.start_col))
        });

        if ws.has_buffer(&path) {
            // Apply to the in-memory buffer.
            let buf = ws.get_buffer_mut_by_path(&path)
                .ok_or_else(|| format!("Buffer not found: {}", path_str))?;
            for edit in &edits {
                buf.replace_range(
                    edit.start_line, edit.start_col,
                    edit.end_line,   edit.end_col,
                    &edit.new_text,
                ).map_err(|e| e.to_string())?;
            }
            // Persist to disk so the on-disk copy matches.
            let full_text = buf.get_full_text();
            let version = buf.version();
            let _ = version;
            std::fs::write(&path, &full_text)
                .map_err(|e| format!("Failed to save {}: {}", path_str, e))?;
            // Notify Extension Host of the change.
            let uri = path_to_uri(&path_str);
            state.ipc.send(OutgoingMessage::DidChange {
                uri,
                version: buf.version(),
                text: full_text,
                workspace_id: Some(wid.clone()),
            });
        } else {
            // Apply to a file not currently open in the editor.
            let text = std::fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read {}: {}", path_str, e))?;
            let modified = apply_text_edits_to_str(&text, &edits);
            std::fs::write(&path, &modified)
                .map_err(|e| format!("Failed to write {}: {}", path_str, e))?;
        }
    }

    // Restore original active buffer (switch may have occurred if we needed it).
    if let Some(orig) = &original_active {
        ws.switch_buffer(orig);
    }

    Ok(())
}

// --- Git / SCM Commands ---

/// Validate that `path` is a real directory within the user home directory.
fn validate_dir_path(path: &str) -> Result<String, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("Invalid directory '{}': {}", path, e))?;
    if let Some(home) = dirs::home_dir() {
        let home_canonical = std::fs::canonicalize(&home).unwrap_or(home);
        if !canonical.starts_with(&home_canonical) {
            return Err(format!(
                "Access denied: '{}' is outside the user home directory",
                canonical.display()
            ));
        }
    }
    Ok(canonical.to_string_lossy().to_string())
}

#[derive(serde::Serialize)]
pub struct GitStatusEntry {
    pub path: String,
    pub index_status: String,
    pub worktree_status: String,
}

#[tauri::command]
fn git_status(workspace_path: String) -> Result<Vec<GitStatusEntry>, String> {
    let dir = validate_dir_path(&workspace_path)?;
    let output = std::process::Command::new("git")
        .args(["-C", &dir, "status", "--porcelain", "-u"])
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    // Not a git repository — return empty list rather than an error
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("not a git repository") {
            return Ok(Vec::new());
        }
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    for line in stdout.lines() {
        if line.len() < 3 {
            continue;
        }
        let index_status = line[0..1].to_string();
        let worktree_status = line[1..2].to_string();
        // Handle renamed files: "R old -> new" — take the new name only
        let path_part = &line[3..];
        let path = if let Some(arrow) = path_part.find(" -> ") {
            path_part[arrow + 4..].to_string()
        } else {
            path_part.to_string()
        };
        entries.push(GitStatusEntry { path, index_status, worktree_status });
    }
    Ok(entries)
}

#[tauri::command]
fn git_diff_file(
    workspace_path: String,
    file_path: String,
    staged: bool,
) -> Result<String, String> {
    let dir = validate_dir_path(&workspace_path)?;
    if file_path.contains("..") {
        return Err("Invalid file path: path traversal not allowed".to_string());
    }

    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(&dir);
    if staged {
        // Staged: index vs HEAD (or index vs empty tree if no commits yet)
        cmd.args(["diff", "--cached", "--"]);
    } else {
        // Unstaged: working tree vs index
        cmd.args(["diff", "--"]);
    }
    cmd.arg(&file_path);

    let output = cmd.output().map_err(|e| format!("Failed to run git: {}", e))?;
    let diff = String::from_utf8_lossy(&output.stdout).to_string();

    if diff.is_empty() {
        // Untracked file — format content as a new-file diff
        let full_path = std::path::Path::new(&dir).join(&file_path);
        if let Ok(content) = std::fs::read_to_string(&full_path) {
            let line_count = content.lines().count();
            let lines: String = content.lines()
                .map(|l| format!("+{}", l))
                .collect::<Vec<_>>()
                .join("\n");
            return Ok(format!(
                "--- /dev/null\n+++ b/{fp}\n@@ -0,0 +1,{lc} @@\n{lines}\n",
                fp = file_path,
                lc = line_count,
                lines = lines
            ));
        }
    }
    Ok(diff)
}

#[tauri::command]
fn git_stage(workspace_path: String, file_path: String) -> Result<(), String> {
    let dir = validate_dir_path(&workspace_path)?;
    if file_path.contains("..") {
        return Err("Invalid file path".to_string());
    }
    let output = std::process::Command::new("git")
        .args(["-C", &dir, "add", "--", &file_path])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn git_unstage(workspace_path: String, file_path: String) -> Result<(), String> {
    let dir = validate_dir_path(&workspace_path)?;
    if file_path.contains("..") {
        return Err("Invalid file path".to_string());
    }
    let output = std::process::Command::new("git")
        .args(["-C", &dir, "restore", "--staged", "--", &file_path])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn git_discard(workspace_path: String, file_path: String) -> Result<(), String> {
    let dir = validate_dir_path(&workspace_path)?;
    if file_path.contains("..") {
        return Err("Invalid file path".to_string());
    }
    let output = std::process::Command::new("git")
        .args(["-C", &dir, "restore", "--", &file_path])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn git_commit(workspace_path: String, message: String) -> Result<(), String> {
    let dir = validate_dir_path(&workspace_path)?;
    if message.trim().is_empty() {
        return Err("Commit message cannot be empty".to_string());
    }
    let output = std::process::Command::new("git")
        .args(["-C", &dir, "commit", "-m", &message])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// Return current SCM state pushed by extensions via vscode.scm API.
#[tauri::command]
fn get_scm_state(
    state: tauri::State<AppState>,
) -> Result<std::collections::HashMap<String, ipc_bridge::ScmSourceControlState>, String> {
    Ok(state.ipc.get_scm_states())
}

/// Return all comment threads anchored to the given URI.
#[tauri::command]
fn get_comment_threads(
    uri: String,
    state: tauri::State<AppState>,
) -> Result<Vec<ipc_bridge::CommentThread>, String> {
    Ok(state.ipc.get_comment_threads_for_uri(&uri))
}

// --- DAP Debug Commands ---

/// Drain pending debug session start requests from the Extension Host.
#[tauri::command]
fn get_debug_start_requests(
    state: tauri::State<AppState>,
) -> Result<Vec<ipc_bridge::DebugStartRequest>, String> {
    Ok(state.ipc.drain_debug_start_requests())
}

/// Start a DAP debug session by spawning the adapter process.
#[tauri::command]
fn debug_start(
    session_id: String,
    adapter_cmd: String,
    adapter_args: Vec<String>,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    state.debug_mgr.start_session(session_id, adapter_cmd, adapter_args)
}

/// Send a DAP request to the adapter. Returns the request seq number.
#[tauri::command]
fn debug_send(
    session_id: String,
    command: String,
    args: serde_json::Value,
    state: tauri::State<AppState>,
) -> Result<u64, String> {
    state.debug_mgr.send_request(&session_id, &command, args)
}

/// Drain all pending events from a debug session.
#[tauri::command]
fn debug_poll_events(
    session_id: String,
    state: tauri::State<AppState>,
) -> Result<Vec<debug::DebugEvent>, String> {
    Ok(state.debug_mgr.drain_events(&session_id))
}

/// Stop a debug session and kill the adapter process.
#[tauri::command]
fn debug_stop(session_id: String, state: tauri::State<AppState>) -> Result<(), String> {
    state.debug_mgr.stop_session(&session_id)
}

/// List all active debug session IDs.
#[tauri::command]
fn debug_list_sessions(state: tauri::State<AppState>) -> Result<Vec<String>, String> {
    Ok(state.debug_mgr.list_sessions())
}

// --- Multi-workspace Commands ---

/// Register a workspace window with the Extension Host so it receives the
/// correct workspace root path.  Called by the frontend after the user opens a folder.
#[tauri::command]
fn register_workspace(
    root_path: String,
    state: tauri::State<AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let wid = window.label().to_string();
    let dir = validate_dir_path(&root_path)?;
    // Ensure workspace state entry exists for this window
    {
        let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
        guard.entry(wid.clone()).or_insert_with(WorkspaceState::new);
    }
    state.ipc.send(OutgoingMessage::WorkspaceRegister {
        workspace_id: wid,
        root_path: dir,
    });
    Ok(())
}

/// Open a new editor window.
#[tauri::command]
fn new_window(app: AppHandle) -> Result<(), String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    tauri::WebviewWindowBuilder::new(
        &app,
        format!("window-{ts}"),
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("CoreCode")
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

// --- Response types ---

#[derive(serde::Serialize, Clone)]
pub struct EditorContent {
    pub lines: Vec<HighlightedLine>,
    pub line_count: usize,
    pub file_path: Option<String>,
    pub language: Option<String>,
    pub modified: bool,
    pub diagnostics: Vec<ipc_bridge::Diagnostic>,
}

#[derive(serde::Serialize, Clone)]
pub struct HighlightedLine {
    pub text: String,
    pub tokens: Vec<Token>,
}

#[derive(serde::Serialize, Clone)]
pub struct Token {
    pub start: usize,
    pub end: usize,
    pub kind: String,
}

#[derive(serde::Serialize)]
pub struct ExtHostStatus {
    pub running: bool,
    pub commands: Vec<String>,
}

#[derive(serde::Serialize)]
pub struct ReplaceResult {
    pub count: usize,
    pub content: EditorContent,
}

/// Lightweight result returned by edit commands (no line data).
#[derive(serde::Serialize)]
pub struct EditResult {
    pub total_lines: usize,
    pub modified: bool,
}

/// Virtualized content: only the requested visible line range.
#[derive(serde::Serialize, Clone)]
pub struct VisibleContent {
    pub lines: Vec<HighlightedLine>,
    pub first_line: usize,
    pub total_lines: usize,
    pub file_path: Option<String>,
    pub language: Option<String>,
    pub modified: bool,
    pub diagnostics: Vec<ipc_bridge::Diagnostic>,
}

// --- App entry ---

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    let ipc_port = ipc_bridge::find_free_port();
    let ipc_token = ext_host::generate_ipc_token();
    log::info!("CoreCode IPC port: {}", ipc_port);
    let ipc = ipc_bridge::start_ipc_bridge(ipc_port, &ipc_token);

    let marketplace_client = marketplace::MarketplaceClient::new()
        .expect("Failed to create marketplace client");
    let ext_mgr = extension_mgr::ExtensionManager::new()
        .expect("Failed to create extension manager");
    let settings_store = settings::SettingsStore::new()
        .expect("Failed to create settings store");
    let debug_manager = Arc::new(debug::DebugManager::new());

    // Get user extensions directory path for Extension Host
    let user_extensions_dir = ext_mgr.extensions_dir().to_string_lossy().to_string();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState {
            workspaces: Arc::new(Mutex::new(HashMap::new())),
            ipc,
            marketplace: marketplace_client,
            extension_mgr: Mutex::new(ext_mgr),
            settings: Mutex::new(settings_store),
            terminal_mgr: Mutex::new(terminal::TerminalManager::new()),
            debug_mgr: debug_manager,
        })
        .invoke_handler(tauri::generate_handler![
            open_file,
            close_buffer,
            switch_buffer,
            list_open_buffers,
            read_directory,
            save_file,
            get_content,
            get_visible_content,
            edit_insert,
            edit_delete,
            edit_newline,
            edit_backspace,
            edit_undo,
            edit_redo,
            edit_replace_range,
            get_text_range,
            find_in_file,
            replace_in_file,
            get_diagnostics,
            get_ext_host_status,
            execute_command,
            list_commands,
            get_notifications,
            get_ui_requests,
            respond_ui_request,
            get_status_bar_items,
            get_output_lines,
            // M6: LSP commands
            lsp_inline_completion,
            lsp_inlay_hints,
            get_tree_view_events,
            tree_view_get_children,
            lsp_hover,
            lsp_completion,
            lsp_definition,
            lsp_references,
            lsp_code_action,
            lsp_signature_help,
            lsp_document_symbols,
            lsp_format,
            lsp_rename,
            lsp_prepare_rename,
            lsp_document_highlights,
            get_show_text_document_requests,
            // M8: Marketplace commands
            marketplace_search,
            marketplace_get_extension,
            marketplace_list_installed,
            install_extension,
            uninstall_extension,
            check_extension_updates,
            get_extensions_dir,
            // M8: Settings commands
            get_settings,
            update_setting,
            reset_setting,
            get_setting_definitions,
            // M8b: Terminal commands
            terminal_create,
            terminal_write,
            terminal_resize,
            terminal_close,
            terminal_list,
            // M8b: Terminal extension API
            get_terminal_events,
            respond_terminal_created,
            // Decorations
            get_decorations,
            // M8b: WebView commands
            get_webview_events,
            webview_post_message,
            webview_close_by_user,
            // workspace.applyEdit
            get_workspace_edit_requests,
            apply_workspace_edit,
            // Git / SCM commands
            git_status,
            git_diff_file,
            git_stage,
            git_unstage,
            git_discard,
            git_commit,
            get_scm_state,
            get_comment_threads,
            // DAP debug commands
            get_debug_start_requests,
            debug_start,
            debug_send,
            debug_poll_events,
            debug_stop,
            debug_list_sessions,
            // Multi-workspace commands
            register_workspace,
            new_window,
        ])
        .setup(move |app| {
            log::info!("CoreCode M8 starting...");

            let app_handle = app.handle().clone();
            let ext_dir = user_extensions_dir.clone();
            let token = ipc_token.clone();
            std::thread::Builder::new()
                .name("ext-host-mgr".to_string())
                .spawn(move || {
                    if let Err(e) = ext_host::start_extension_host(&app_handle, ipc_port, &ext_dir, &token) {
                        log::error!("Failed to start Extension Host: {}", e);
                    }
                })
                .expect("Failed to spawn Extension Host manager thread");

            Ok(())
        })
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                ext_host::kill_extension_host();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
