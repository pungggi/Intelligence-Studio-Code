mod debug;
mod dispatch;
mod editor;
mod ext_host;
mod extension_mgr;
mod grammar_registry;
mod highlighting;
mod ipc_bridge;
mod marketplace;
mod settings;
mod terminal;
mod wasm_host;

use editor::WorkspaceState;
use ipc_bridge::{IpcHandle, OutgoingMessage};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri::AppHandle;

/// Maximum text insertion size (1 MB).
const MAX_INSERT_SIZE: usize = 1024 * 1024;
/// Maximum buffer size (50 MB) — matches MAX_FILE_SIZE in editor.rs.
const MAX_BUFFER_SIZE: usize = 50 * 1024 * 1024;

/// Shared app state accessible from Tauri commands.
struct AppState {
    /// Per-window workspace state, keyed by window label.
    workspaces: Arc<Mutex<HashMap<String, WorkspaceState>>>,
    ipc: IpcHandle,
    marketplace: marketplace::MarketplaceClient,
    extension_mgr: Mutex<extension_mgr::ExtensionManager>,
    settings: Arc<Mutex<settings::SettingsStore>>,
    terminal_mgr: Mutex<terminal::TerminalManager>,
    debug_mgr: Arc<debug::DebugManager>,
    /// Count of open windows; extension host is killed when this reaches zero.
    window_count: Arc<Mutex<usize>>,
    /// WASM extension host — runs extensions compiled to wasm32-wasi in-process.
    wasm_host: wasm_host::WasmHostManager,
    /// Dynamic grammar registry — tree-sitter grammars loaded from WASM extensions.
    grammar_registry: Arc<grammar_registry::GrammarRegistry>,
}


// --- Path validation ---

/// Validate that `path` is a real, non-directory file within the user home directory.
///
/// Restrictions:
/// - Must be an existing, canonicalisable path (symlinks are resolved).
/// - Must not point to a directory.
/// - Must be within the current user's home directory to prevent extensions
///   from reading arbitrary system files (e.g. `/etc/passwd`).
///   If the home directory cannot be determined, access is denied (fail-closed).
fn validate_path(path: &str) -> Result<String, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("Invalid path '{}': {}", path, e))?;

    if canonical.is_dir() {
        return Err(format!("Path is a directory: {}", path));
    }

    // Restrict to the user home directory — blocks access to /etc, /proc,
    // C:\Windows\System32, etc. while allowing all normal developer workflows.
    // Fail closed: if home directory cannot be determined, deny access.
    let home = dirs::home_dir().ok_or_else(|| {
        "Access denied: could not determine user home directory".to_string()
    })?;
    let home_canonical = std::fs::canonicalize(&home).unwrap_or(home);
    if !canonical.starts_with(&home_canonical) {
        return Err(format!(
            "Access denied: '{}' is outside the user home directory",
            canonical.display()
        ));
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

/// Get (or create) the `WorkspaceState` for a window, attaching the shared grammar
/// registry to newly-created instances so dynamic grammars work automatically.
fn get_or_create_ws<'a>(
    workspaces: &'a mut HashMap<String, WorkspaceState>,
    wid: String,
    grammar_registry: &Arc<grammar_registry::GrammarRegistry>,
) -> &'a mut WorkspaceState {
    workspaces.entry(wid).or_insert_with(|| {
        let mut ws = WorkspaceState::new();
        ws.set_grammar_registry(grammar_registry.clone());
        ws
    })
}

// --- Tauri Commands ---

/// Open a file into a buffer (multi-document: doesn't close previous files).
#[tauri::command]
fn open_file(path: String, state: tauri::State<AppState>, window: tauri::WebviewWindow) -> Result<EditorContent, String> {
    let canonical = validate_path(&path)?;
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = get_or_create_ws(&mut guard, wid.clone(), &state.grammar_registry);

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
    let ws = get_or_create_ws(&mut guard, wid.clone(), &state.grammar_registry);
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
    let ws = get_or_create_ws(&mut guard, wid, &state.grammar_registry);
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
    let ws = get_or_create_ws(&mut guard, wid, &state.grammar_registry);
    Ok(ws.list_open_buffers())
}

/// Read directory contents for the file explorer.
#[tauri::command]
fn read_directory(path: String) -> Result<Vec<editor::DirEntry>, String> {
    let canonical = validate_dir_path(&path)?;
    editor::read_directory(&canonical).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_file(state: tauri::State<AppState>, window: tauri::WebviewWindow) -> Result<(), String> {
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = get_or_create_ws(&mut guard, wid.clone(), &state.grammar_registry);
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
    let ws = get_or_create_ws(&mut guard, wid, &state.grammar_registry);
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
    let ws = get_or_create_ws(&mut guard, wid, &state.grammar_registry);
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
    let ws = get_or_create_ws(&mut guard, wid.clone(), &state.grammar_registry);
    let buf = ws.active_mut().ok_or("No active buffer")?;
    // Check before mutating — once inserted the rope cannot be cheaply undone.
    if buf.len_bytes().saturating_add(text.len()) > MAX_BUFFER_SIZE {
        return Err(format!(
            "Insertion would exceed {} MB buffer limit",
            MAX_BUFFER_SIZE / (1024 * 1024)
        ));
    }
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
    let ws = get_or_create_ws(&mut guard, wid.clone(), &state.grammar_registry);
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
    let ws = get_or_create_ws(&mut guard, wid.clone(), &state.grammar_registry);
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
    let ws = get_or_create_ws(&mut guard, wid.clone(), &state.grammar_registry);
    let buf = ws.active_mut().ok_or("No active buffer")?;
    buf.backspace(line, col).map_err(|e| e.to_string())?;
    do_edit(ws, &state.ipc, &wid)
}

#[tauri::command]
fn edit_undo(state: tauri::State<AppState>, window: tauri::WebviewWindow) -> Result<EditResult, String> {
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = get_or_create_ws(&mut guard, wid.clone(), &state.grammar_registry);
    let buf = ws.active_mut().ok_or("No active buffer")?;
    buf.undo();
    do_edit(ws, &state.ipc, &wid)
}

#[tauri::command]
fn edit_redo(state: tauri::State<AppState>, window: tauri::WebviewWindow) -> Result<EditResult, String> {
    let wid = window.label().to_string();
    let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
    let ws = get_or_create_ws(&mut guard, wid.clone(), &state.grammar_registry);
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
    let ws = get_or_create_ws(&mut guard, wid.clone(), &state.grammar_registry);
    let buf = ws.active_mut().ok_or("No active buffer")?;
    // Conservatively check before mutating — replacement text may be larger than
    // the range it replaces, so use the full addition as an upper bound.
    if buf.len_bytes().saturating_add(text.len()) > MAX_BUFFER_SIZE {
        return Err(format!(
            "Replacement would exceed {} MB buffer limit",
            MAX_BUFFER_SIZE / (1024 * 1024)
        ));
    }
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
    let ws = get_or_create_ws(&mut guard, wid, &state.grammar_registry);
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
    let ws = get_or_create_ws(&mut guard, wid, &state.grammar_registry);
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
    let ws = get_or_create_ws(&mut guard, wid.clone(), &state.grammar_registry);
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

/// Drain buffered log messages from all active WASM extensions.
///
/// Returns `[channel, message]` pairs. The frontend polls this at the same
/// cadence as `get_output_lines` and appends to the Output panel.
#[tauri::command]
fn get_wasm_output_lines(state: tauri::State<AppState>) -> Vec<[String; 2]> {
    state
        .wasm_host
        .drain_all_output_lines()
        .into_iter()
        .map(|(ch, msg)| [ch, msg])
        .collect()
}

/// Drain buffered notification toasts from all active WASM extensions.
///
/// Returns objects with `type` ("info"/"warning"/"error") and `message` fields,
/// matching the same shape as `get_notifications` from the Node.js IPC bridge.
#[tauri::command]
fn get_wasm_notifications(state: tauri::State<AppState>) -> Vec<ipc_bridge::Notification> {
    state
        .wasm_host
        .drain_all_notifications()
        .into_iter()
        .map(|(level, message)| ipc_bridge::Notification {
            msg_type: level,
            message,
        })
        .collect()
}

/// Collect status bar items from all active WASM extensions.
///
/// Returns objects matching the `StatusBarItem` shape used by the IPC bridge.
#[tauri::command]
fn get_wasm_status_bar_items(state: tauri::State<AppState>) -> Vec<ipc_bridge::StatusBarItem> {
    state
        .wasm_host
        .get_all_status_items()
        .into_iter()
        .map(|(id, text, tooltip)| ipc_bridge::StatusBarItem {
            id,
            text,
            tooltip,
            command: None,
            alignment: "left".to_string(),
            priority: 0,
        })
        .collect()
}

// --- WASM Language Provider Commands ---
// Note: wasm_completions, wasm_diagnostics, wasm_hover, wasm_definition, wasm_references
// were removed — the unified lang_* commands in the dispatch layer supersede them.

#[tauri::command]
fn wasm_format_document(
    state: tauri::State<AppState>,
    lang_id: String,
    uri: String,
    content: String,
) -> Result<serde_json::Value, String> {
    let edits = state.wasm_host.format_document_for_lang(&lang_id, &uri, &content);
    serde_json::to_value(&edits).map_err(|e| format!("serialization error: {e}"))
}

#[tauri::command]
fn wasm_format_range(
    state: tauri::State<AppState>,
    lang_id: String,
    uri: String,
    content: String,
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
) -> Result<serde_json::Value, String> {
    let range = crate::wasm_host::wit_types::Range {
        start: crate::wasm_host::wit_types::Position { line: start_line, character: start_character },
        end: crate::wasm_host::wit_types::Position { line: end_line, character: end_character },
    };
    let edits = state.wasm_host.format_range_for_lang(&lang_id, &uri, &content, &range);
    serde_json::to_value(&edits).map_err(|e| format!("serialization error: {e}"))
}

#[tauri::command]
fn wasm_rename(
    state: tauri::State<AppState>,
    lang_id: String,
    uri: String,
    line: u32,
    character: u32,
    new_name: String,
) -> Result<serde_json::Value, String> {
    let edits = state.wasm_host.rename_for_lang(&lang_id, &uri, line, character, &new_name);
    serde_json::to_value(&edits).map_err(|e| format!("serialization error: {e}"))
}

#[tauri::command]
fn wasm_code_actions(
    state: tauri::State<AppState>,
    lang_id: String,
    uri: String,
    range: serde_json::Value,
    diagnostics: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let r: wasm_host::Range = serde_json::from_value(range).map_err(|e| format!("bad range: {e}"))?;
    let diags: Vec<wasm_host::Diagnostic> = serde_json::from_value(diagnostics).map_err(|e| format!("bad diagnostics: {e}"))?;
    let actions = state.wasm_host.code_actions_for_lang(&lang_id, &uri, &r, &diags);
    serde_json::to_value(&actions).map_err(|e| format!("serialization error: {e}"))
}

#[tauri::command]
fn wasm_workspace_symbols(
    state: tauri::State<AppState>,
    lang_id: String,
    query: String,
) -> Result<serde_json::Value, String> {
    let symbols = state.wasm_host.workspace_symbols_for_lang(&lang_id, &query);
    serde_json::to_value(&symbols).map_err(|e| format!("serialization error: {e}"))
}

#[tauri::command]
fn wasm_folding_ranges(
    state: tauri::State<AppState>,
    lang_id: String,
    uri: String,
    content: String,
) -> Result<serde_json::Value, String> {
    let ranges = state.wasm_host.folding_ranges_for_lang(&lang_id, &uri, &content);
    serde_json::to_value(&ranges).map_err(|e| format!("serialization error: {e}"))
}

// ── Unified Language Dispatch ─────────────────────────────────────────────────


/// Unified completions — merges results from WASM extensions and LSP servers.
#[tauri::command]
fn lang_completions(
    uri: String,
    line: u32,
    character: u32,
    trigger: Option<String>,
    state: tauri::State<AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let lang_id = dispatch::lang_id_from_uri(&uri);


    // WASM: Pull — returns Vec, errors logged internally
    let wasm_items = state.wasm_host.completions_for_lang(
        &lang_id, &uri, line, character, trigger.as_deref(),
    );

    // LSP: Pull via request_sync
    let lsp_result = state.ipc.request_sync(
        "textDocument/completion",
        serde_json::json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character },
        }),
    );


    Ok(dispatch::merged_completions(wasm_items, lsp_result))
}

/// Unified hover — WASM priority, LSP fallback.
#[tauri::command]
fn lang_hover(
    uri: String,
    line: u32,
    character: u32,
    state: tauri::State<AppState>,
) -> Result<Option<serde_json::Value>, String> {
    let lang_id = dispatch::lang_id_from_uri(&uri);

    // WASM: Pull
    let wasm_hover = state.wasm_host.hover_for_lang(&lang_id, &uri, line, character);

    // LSP: Pull
    let lsp_result = state.ipc.request_sync(
        "textDocument/hover",
        serde_json::json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character },
        }),
    );

    Ok(dispatch::merged_hover(wasm_hover, lsp_result))
}

/// Unified diagnostics — merges push-based LSP diagnostics with pull-based WASM diagnostics.
///
/// LSP diagnostics are stored in ipc_bridge state (arrived via publishDiagnostics).
/// WASM diagnostics need file content, which is fetched from the open buffer.
#[tauri::command]
fn lang_diagnostics(
    uri: String,
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
) -> Result<Vec<ipc_bridge::Diagnostic>, String> {
    let lang_id = dispatch::lang_id_from_uri(&uri);


    // LSP: Read from stored state (push-based)
    let lsp_diags = state.ipc.get_diagnostics_for_uri(&uri);

    // WASM: Pull — needs file content from open buffer
    let content = {
        let wid = window.label().to_string();
        let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
        let ws = get_or_create_ws(&mut guard, wid, &state.grammar_registry);
        let path = dispatch::uri_to_path(&uri);
        ws.get_buffer_by_path(std::path::Path::new(&path))
            .map(|buf| buf.get_full_text())
            .unwrap_or_default()
    };

    let wasm_diags = state.wasm_host.diagnostics_for_lang(&lang_id, &uri, &content);

    Ok(dispatch::merged_diagnostics_for_uri(&uri, &wasm_diags, &lsp_diags))
}

/// Unified definition — WASM priority, LSP fallback.
#[tauri::command]
fn lang_definition(
    uri: String,
    line: u32,
    character: u32,
    state: tauri::State<AppState>,
) -> Result<Option<serde_json::Value>, String> {
    let lang_id = dispatch::lang_id_from_uri(&uri);

    // WASM: Pull
    let wasm_def = state.wasm_host.definition_for_lang(&lang_id, &uri, line, character);

    // LSP: Pull
    let lsp_result = state.ipc.request_sync(
        "textDocument/definition",
        serde_json::json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character },
        }),
    );

    Ok(dispatch::merged_definition(wasm_def, lsp_result))
}

/// Unified references — merged (union semantics).
#[tauri::command]
fn lang_references(
    uri: String,
    line: u32,
    character: u32,
    include_decl: bool,
    state: tauri::State<AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let lang_id = dispatch::lang_id_from_uri(&uri);


    // WASM: Pull
    let wasm_locs = state.wasm_host.references_for_lang(&lang_id, &uri, line, character, include_decl);


    // LSP: Pull
    let lsp_result = state.ipc.request_sync(
        "textDocument/references",
        serde_json::json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character },
            "context": { "includeDeclaration": include_decl },
        }),
    );

    Ok(dispatch::merged_references(wasm_locs, lsp_result))
}
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

fn validate_shell_path(shell: &str) -> Result<(), String> {
    if shell.contains("..") {
        return Err("Invalid shell path: path traversal not allowed".to_string());
    }

    if !shell.contains('/') && !shell.contains('\\') {
        return Ok(());
    }

    let path = std::path::Path::new(shell);

    if path.is_absolute() {
        let safe_shells = [
            "bash", "zsh", "sh", "fish", "pwsh", "powershell", "dash",
            "ksh", "csh", "tcsh", "cmd.exe", "powershell.exe", "pwsh.exe",
        ];
        let basename = path.file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default();

        if safe_shells.iter().any(|s| *s == basename) {
            return Ok(());
        }

        let home = dirs::home_dir().ok_or_else(|| {
            "Invalid shell path: could not determine user home directory".to_string()
        })?;
        let canonical = std::fs::canonicalize(shell)
            .map_err(|e| format!("Invalid shell path '{}': {}", shell, e))?;
        let home_canonical = std::fs::canonicalize(&home).unwrap_or(home);
        if !canonical.starts_with(&home_canonical) {
            return Err(format!(
                "Invalid shell path: '{}' is outside the user home directory and is not a recognized shell",
                shell
            ));
        }
        return Ok(());
    }

    Err(format!(
        "Invalid shell path: relative paths with directory components are not allowed ('{}')",
        shell
    ))
}

#[tauri::command]
fn terminal_create(
    app: AppHandle,
    cwd: Option<String>,
    shell: Option<String>,
    cols: u32,
    rows: u32,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    if let Some(ref s) = shell {
        validate_shell_path(s)?;
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
///
/// Merges events from both the Node.js extension host (via IPC) and WASM
/// extensions (in-process). The frontend is agnostic to the event source.
#[tauri::command]
fn get_webview_events(state: tauri::State<AppState>) -> Result<Vec<ipc_bridge::WebviewPanelEvent>, String> {
    let mut events = state.ipc.drain_webview_events();
    events.extend(state.wasm_host.drain_webview_events());
    Ok(events)
}

/// Forward a message from a webview iframe to the owning extension.
///
/// Tries the WASM host first; if the panel is not owned by a WASM extension,
/// falls back to forwarding via IPC to the Node.js extension host.
#[tauri::command]
fn webview_post_message(
    panel_id: String,
    message: serde_json::Value,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    // WASM extensions receive the message as a JSON string (WIT uses `string`);
    // Node.js extensions receive the original serde_json::Value via IPC.
    let msg_str = message.to_string();
    match state.wasm_host.route_webview_message(&panel_id, &msg_str) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Not a WASM panel — forward to Node.js extension host
            state.ipc.send(OutgoingMessage::WebviewMessageFromWebview { panel_id, message });
            Ok(())
        }
    }
}

/// Notify the owning extension that the user closed a webview panel.
///
/// Tries the WASM host first; if the panel is not owned by a WASM extension,
/// falls back to notifying the Node.js extension host via IPC.
#[tauri::command]
fn webview_close_by_user(panel_id: String, state: tauri::State<AppState>) -> Result<(), String> {
    match state.wasm_host.route_webview_close(&panel_id) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Not a WASM panel — forward to Node.js extension host
            state.ipc.send(OutgoingMessage::WebviewClosedByUser { panel_id });
            Ok(())
        }
    }
}

// --- workspace.applyEdit ---

/// Convert a file:// URI to a filesystem path string.
fn uri_to_path(uri: &str) -> String {
    // Use the url crate for proper percent-decoding
    if let Ok(u) = url::Url::parse(uri) {
        if u.scheme() == "file" {
            if let Ok(path) = u.to_file_path() {
                return path.to_string_lossy().to_string();
            }
        }
    }
    // Fallback: strip prefix and do basic decode for non-standard URIs
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
fn apply_text_edits_to_str(text: &str, edits: &[ipc_bridge::WorkspaceTextEdit]) -> Result<String, String> {
    let mut lines: Vec<String> = text.split('\n').map(|l| l.trim_end_matches('\r').to_string()).collect();
    let has_trailing_newline = text.ends_with('\n') || text.ends_with("\r\n");

    for (i, edit) in edits.iter().enumerate() {
        if edit.start_line >= lines.len() || edit.end_line >= lines.len() {
            return Err(format!(
                "Edit #{} references line {}-{} but file only has {} line(s)",
                i, edit.start_line, edit.end_line, lines.len()
            ));
        }

        let start_line_text = lines.get(edit.start_line).cloned().unwrap_or_default();
        let end_line_text = lines.get(edit.end_line).cloned().unwrap_or_default();

        if edit.start_col > start_line_text.len() {
            return Err(format!(
                "Edit #{} start_col {} exceeds line {} length {}",
                i, edit.start_col, edit.start_line, start_line_text.len()
            ));
        }
        if edit.end_col > end_line_text.len() {
            return Err(format!(
                "Edit #{} end_col {} exceeds line {} length {}",
                i, edit.end_col, edit.end_line, end_line_text.len()
            ));
        }

        let prefix = start_line_text[..edit.start_col].to_string();
        let suffix = end_line_text[edit.end_col..].to_string();
        let combined = prefix + &edit.new_text + &suffix;

        let new_lines: Vec<String> = combined.split('\n').map(|l| l.trim_end_matches('\r').to_string()).collect();
        lines.splice(edit.start_line..=edit.end_line, new_lines);
    }

    let mut result = lines.join("\n");
    if has_trailing_newline && !result.ends_with('\n') {
        result.push('\n');
    }
    Ok(result)
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
    let ws = get_or_create_ws(&mut guard, wid.clone(), &state.grammar_registry);
    let original_active = ws.active_path().cloned();

    for file_edit in &changes {
        if file_edit.edits.is_empty() {
            continue;
        }
        // Layer 1: canonicalize and enforce home-dir confinement.
        let path_str = validate_path(&uri_to_path(&file_edit.uri))?;
        let path = std::path::PathBuf::from(&path_str);

        // Layer 2: restrict workspace edits to the workspace root.
        // Exception: files already open in a buffer are allowed even without a
        // workspace root, because the user has explicitly opened them for editing.
        // This supports the common "open single file, let extension format it"
        // workflow where no folder is registered.
        let in_buffer = ws.has_buffer(&path);
        match ws.workspace_root() {
            Some(root) if path.starts_with(root) => {}
            Some(root) => {
                return Err(format!(
                    "Access denied: '{}' is outside the workspace root '{}'. \
                     Workspace edits must target files within the workspace folder.",
                    path_str,
                    root.display()
                ));
            }
            None if in_buffer => {
                // No workspace root but file is open — allow; already home-dir
                // restricted by Layer 1.
            }
            None => {
                return Err(format!(
                    "Access denied: '{}' — no workspace root is registered and \
                     the file is not open in the editor. Open a workspace folder \
                     before applying edits to files outside the editor.",
                    path_str
                ));
            }
        }

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
            let modified = apply_text_edits_to_str(&text, &edits)?;
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
    // Fail closed: if home directory cannot be determined, deny access.
    let home = dirs::home_dir().ok_or_else(|| {
        "Access denied: user home directory unavailable".to_string()
    })?;
    let home_canonical = std::fs::canonicalize(&home).unwrap_or(home);
    if !canonical.starts_with(&home_canonical) {
        return Err(format!(
            "Access denied: '{}' is outside the user home directory",
            canonical.display()
        ));
    }
    Ok(canonical.to_string_lossy().to_string())
}

fn validate_relative_file_path(file_path: &str) -> Result<(), String> {
    if file_path.contains("..") {
        return Err("Invalid file path: path traversal not allowed".to_string());
    }
    if std::path::Path::new(file_path).is_absolute() {
        return Err("Invalid file path: absolute paths not allowed".to_string());
    }
    Ok(())
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
    validate_relative_file_path(&file_path)?;

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
    validate_relative_file_path(&file_path)?;
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
    validate_relative_file_path(&file_path)?;
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
    validate_relative_file_path(&file_path)?;
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
    state.debug_mgr.drain_events(&session_id)
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
    // Ensure workspace state entry exists for this window and record the root.
    {
        let mut guard = state.workspaces.lock().map_err(|e| e.to_string())?;
        let ws = get_or_create_ws(&mut guard, wid.clone(), &state.grammar_registry);
        ws.set_workspace_root(std::path::PathBuf::from(&dir));
    }
    // Inform WASM extensions so workspace_read calls resolve against the new root.
    state.wasm_host.notify_workspace_opened(std::path::PathBuf::from(&dir));

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
    // Track new window in the count
    let state = app.state::<AppState>();
    let mut count = state.window_count.lock().unwrap_or_else(|p: std::sync::PoisonError<_>| p.into_inner());
    *count += 1;
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
    pub kind: &'static str,
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
    let settings_store = Arc::new(Mutex::new(
        settings::SettingsStore::new().expect("Failed to create settings store"),
    ));
    let debug_manager = Arc::new(debug::DebugManager::new());
    let mut wasm_host_mgr = wasm_host::WasmHostManager::new()
        .expect("Failed to initialise WASM extension host");
    wasm_host_mgr.set_settings(settings_store.clone());
    let grammar_reg = Arc::new(grammar_registry::GrammarRegistry::new());
    wasm_host_mgr.set_grammar_registry(grammar_reg.clone());

    // Populate the native grammar dylib allowlist from user settings.
    // Native dylibs execute code outside the WASM sandbox, so only
    // explicitly trusted extension IDs may load them.
    {
        let allowlist_val = settings_store.lock().unwrap()
            .get("security.nativeGrammarAllowlist");
        let mut ids = std::collections::HashSet::new();
        if let serde_json::Value::Array(arr) = allowlist_val {
            for v in arr {
                if let serde_json::Value::String(s) = v {
                    ids.insert(s);
                }
            }
        }
        if !ids.is_empty() {
            log::info!("Native grammar allowlist: {:?}", ids);
        }
        wasm_host_mgr.set_native_grammar_allowlist(ids);
    }

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
            settings: settings_store,
            terminal_mgr: Mutex::new(terminal::TerminalManager::new()),
            debug_mgr: debug_manager,
            window_count: Arc::new(Mutex::new(1)), // main window
            wasm_host: wasm_host_mgr,
            grammar_registry: grammar_reg,
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
            get_wasm_output_lines,
            get_wasm_notifications,
            get_wasm_status_bar_items,
            // WASM-only language provider commands (no LSP equivalent yet)
            wasm_format_document,
            wasm_format_range,
            wasm_rename,
            wasm_code_actions,
            wasm_workspace_symbols,
            wasm_folding_ranges,
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
            // Unified Language Dispatch
            lang_completions,
            lang_hover,
            lang_diagnostics,
            lang_definition,
            lang_references,
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

            // Activate WASM extensions in a background thread (in-process but
            // potentially slow on first engine compilation).
            let wasm_ext_dir = user_extensions_dir.clone();
            let app_handle2 = app.handle().clone();
            std::thread::Builder::new()
                .name("wasm-ext-host".to_string())
                .spawn(move || {
                    let state = app_handle2.state::<AppState>();
                    let extensions_dir = std::path::PathBuf::from(&wasm_ext_dir);
                    let errors = state.wasm_host.activate_all(&extensions_dir, None);
                    for e in errors {
                        log::error!("WASM extension error: {e}");
                    }
                    log::info!(
                        "WASM extension host ready ({} active)",
                        state.wasm_host.active_count()
                    );
                })
                .expect("Failed to spawn WASM Extension Host thread");

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.app_handle().state::<AppState>();
                let mut count = state.window_count.lock().unwrap_or_else(|p: std::sync::PoisonError<_>| p.into_inner());
                *count = count.saturating_sub(1);
                if *count == 0 {
                    ext_host::kill_extension_host();
                    state.wasm_host.deactivate_all();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── validate_path ────────────────────────────────────────────────────────

    #[test]
    fn validate_path_rejects_nonexistent() {
        let result = validate_path("/this/path/does/not/exist/ever.txt");
        assert!(result.is_err(), "expected Err for nonexistent path");
    }

    #[test]
    fn validate_path_rejects_directory() {
        // The home directory itself is a directory, not a file.
        if let Some(home) = dirs::home_dir() {
            let result = validate_path(&home.to_string_lossy());
            assert!(
                result.is_err(),
                "expected Err when path is a directory, got {:?}",
                result
            );
        }
    }

    #[test]
    fn validate_path_accepts_file_in_home() {
        // Create a temp file inside the home directory and verify it passes.
        if let Some(home) = dirs::home_dir() {
            let tmp = home.join(".corecode_test_validate_path_tmp");
            std::fs::write(&tmp, b"test").unwrap();
            let result = validate_path(&tmp.to_string_lossy());
            std::fs::remove_file(&tmp).ok();
            assert!(result.is_ok(), "expected Ok for file inside home, got {:?}", result);
        }
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn validate_path_rejects_outside_home() {
        // /tmp is outside the home directory on Linux/macOS.
        let tmp = std::env::temp_dir().join("corecode_test_outside_home.txt");
        std::fs::write(&tmp, b"test").unwrap();
        let result = validate_path(&tmp.to_string_lossy());
        std::fs::remove_file(&tmp).ok();
        // Only assert rejection if home dir is actually determinable.
        if dirs::home_dir().is_some() {
            assert!(result.is_err(), "expected Err for path outside home dir");
            let msg = result.unwrap_err();
            assert!(msg.contains("outside the user home directory"), "unexpected error: {msg}");
        }
    }

    // ── validate_dir_path ────────────────────────────────────────────────────

    #[test]
    fn validate_dir_path_accepts_home_dir() {
        if let Some(home) = dirs::home_dir() {
            let result = validate_dir_path(&home.to_string_lossy());
            assert!(result.is_ok(), "expected Ok for home dir, got {:?}", result);
        }
    }

    #[test]
    fn validate_dir_path_rejects_nonexistent() {
        let result = validate_dir_path("/no/such/directory/at/all");
        assert!(result.is_err());
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn validate_dir_path_rejects_outside_home() {
        // /tmp is a real directory but outside home on most Unix systems.
        if dirs::home_dir().is_some() {
            let tmp = std::env::temp_dir();
            // Only assert rejection if /tmp is outside home.
            if let Some(home) = dirs::home_dir() {
                if !tmp.starts_with(&home) {
                    let result = validate_dir_path(&tmp.to_string_lossy());
                    assert!(result.is_err(), "expected Err for path outside home dir");
                }
            }
        }
    }

    // ── uri_to_path ──────────────────────────────────────────────────────────

    #[test]
    fn uri_to_path_strips_file_scheme() {
        #[cfg(not(target_os = "windows"))]
        {
            let path = uri_to_path("file:///home/user/project/main.rs");
            assert_eq!(path, "/home/user/project/main.rs");
        }
        #[cfg(target_os = "windows")]
        {
            let path = uri_to_path("file:///C:/Users/user/project/main.rs");
            assert!(path.contains("main.rs"), "unexpected result: {path}");
        }
    }

    #[test]
    fn uri_to_path_decodes_percent_encoding() {
        #[cfg(not(target_os = "windows"))]
        {
            let path = uri_to_path("file:///home/user/my%20project/main%23.rs");
            assert_eq!(path, "/home/user/my project/main#.rs");
        }
    }

    #[test]
    fn uri_to_path_handles_plain_path_fallback() {
        // Non-file URI passes through the fallback branch.
        let result = uri_to_path("/just/a/plain/path");
        assert_eq!(result, "/just/a/plain/path");
    }

    #[test]
    fn uri_to_path_fallback_decodes_percent20() {
        let result = uri_to_path("file:///my%20path/file.txt");
        assert!(result.contains("my path"), "expected decoded space, got: {result}");
    }

    // ── path_to_uri ──────────────────────────────────────────────────────────

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn path_to_uri_produces_file_scheme() {
        let uri = path_to_uri("/home/user/project/main.rs");
        assert!(uri.starts_with("file://"), "expected file:// URI, got: {uri}");
        assert!(uri.contains("main.rs"));
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn path_to_uri_encodes_spaces() {
        let uri = path_to_uri("/home/user/my project/main.rs");
        assert!(uri.contains("%20"), "expected %20 encoding, got: {uri}");
        assert!(!uri.contains(' '), "URI must not contain raw space");
    }

    // ── git path validation ──────────────────────────────────────────────────

    #[test]
    fn validate_relative_file_path_rejects_dotdot() {
        assert!(validate_relative_file_path("../../../etc/passwd").is_err());
        assert!(validate_relative_file_path("foo/../bar").is_err());
    }

    #[test]
    fn validate_relative_file_path_rejects_absolute() {
        #[cfg(not(target_os = "windows"))]
        let path = "/etc/passwd";
        #[cfg(target_os = "windows")]
        let path = "C:\\Windows\\System32\\hosts";
        assert!(validate_relative_file_path(path).is_err());
    }

    #[test]
    fn validate_relative_file_path_accepts_relative() {
        assert!(validate_relative_file_path("src/main.rs").is_ok());
        assert!(validate_relative_file_path("foo/bar.txt").is_ok());
    }

    #[test]
    fn git_commands_reject_absolute_paths() {
        #[cfg(not(target_os = "windows"))]
        let file_path = "/etc/passwd";
        #[cfg(target_os = "windows")]
        let file_path = "C:\\Windows\\System32\\drivers\\etc\\hosts";
        assert!(validate_relative_file_path(file_path).is_err());
    }

    // ── shell validation ─────────────────────────────────────────────────────

    #[test]
    fn validate_shell_accepts_bare_names() {
        assert!(validate_shell_path("bash").is_ok());
        assert!(validate_shell_path("zsh").is_ok());
        assert!(validate_shell_path("sh").is_ok());
    }

    #[test]
    fn validate_shell_rejects_dotdot() {
        assert!(validate_shell_path("../evil").is_err());
    }

    #[test]
    fn validate_shell_rejects_relative_with_dir() {
        assert!(validate_shell_path("./evil").is_err());
        assert!(validate_shell_path("bin/shell").is_err());
    }

    // ── apply_text_edits_to_str bounds checking ──────────────────────────────

    #[test]
    fn apply_text_edits_to_str_rejects_out_of_bounds_line() {
        let text = "line0\nline1\n";
        let edit = ipc_bridge::WorkspaceTextEdit {
            start_line: 5, start_col: 0, end_line: 6, end_col: 0,
            new_text: "x".to_string(),
        };
        assert!(apply_text_edits_to_str(text, &[edit]).is_err());
    }

    #[test]
    fn apply_text_edits_to_str_rejects_out_of_bounds_col() {
        let text = "hi\n";
        let edit = ipc_bridge::WorkspaceTextEdit {
            start_line: 0, start_col: 0, end_line: 0, end_col: 99,
            new_text: "x".to_string(),
        };
        assert!(apply_text_edits_to_str(text, &[edit]).is_err());
    }
}
