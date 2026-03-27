mod editor;
mod ext_host;
mod highlighting;
mod ipc_bridge;

use editor::WorkspaceState;
use ipc_bridge::{IpcHandle, OutgoingMessage};
use std::path::PathBuf;
use std::sync::Mutex;

/// Maximum text insertion size (1 MB).
const MAX_INSERT_SIZE: usize = 1024 * 1024;

/// Shared app state accessible from Tauri commands.
struct AppState {
    workspace: Mutex<WorkspaceState>,
    ipc: IpcHandle,
}

// --- Path validation ---

fn validate_path(path: &str) -> Result<String, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("Invalid path '{}': {}", path, e))?;

    if canonical.is_dir() {
        return Err(format!("Path is a directory: {}", path));
    }

    Ok(canonical.to_string_lossy().to_string())
}

pub(crate) fn path_to_uri(path: &str) -> String {
    let encoded = path
        .replace('\\', "/")
        .replace(' ', "%20")
        .replace('#', "%23");
    #[cfg(target_os = "windows")]
    {
        format!("file:///{}", encoded)
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!("file://{}", encoded)
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
fn open_file(path: String, state: tauri::State<AppState>) -> Result<EditorContent, String> {
    let canonical = validate_path(&path)?;
    let mut ws = state.workspace.lock().map_err(|e| e.to_string())?;

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
                workspace_id: Some("default".to_string()),
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
fn close_buffer(path: String, state: tauri::State<AppState>) -> Result<Option<EditorContent>, String> {
    let mut ws = state.workspace.lock().map_err(|e| e.to_string())?;
    let path_buf = std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));

    // Send didClose for this buffer
    let uri = path_to_uri(&path);
    state.ipc.send(OutgoingMessage::DidClose { uri: uri.clone(), workspace_id: Some("default".to_string()) });
    state.ipc.clear_diagnostics_for_uri(&uri);

    ws.close_buffer(&path_buf);

    match ws.active() {
        Some(buf) => Ok(Some(buf.get_content(&state.ipc))),
        None => Ok(None),
    }
}

/// Switch to a different open buffer.
#[tauri::command]
fn switch_buffer(path: String, state: tauri::State<AppState>) -> Result<EditorContent, String> {
    let mut ws = state.workspace.lock().map_err(|e| e.to_string())?;
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
fn list_open_buffers(state: tauri::State<AppState>) -> Result<Vec<editor::BufferInfo>, String> {
    let ws = state.workspace.lock().map_err(|e| e.to_string())?;
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
fn save_file(state: tauri::State<AppState>) -> Result<(), String> {
    let mut ws = state.workspace.lock().map_err(|e| e.to_string())?;
    ws.save_active().map_err(|e| e.to_string())?;

    // Notify Extension Host that the document was saved
    if let Some(buf) = ws.active() {
        let uri = path_to_uri(&buf.file_path_str());
        state.ipc.send(OutgoingMessage::DidSave {
            uri,
            workspace_id: Some("default".to_string()),
        });
    }
    Ok(())
}

#[tauri::command]
fn get_content(state: tauri::State<AppState>) -> Result<EditorContent, String> {
    let ws = state.workspace.lock().map_err(|e| e.to_string())?;
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
) -> Result<VisibleContent, String> {
    let ws = state.workspace.lock().map_err(|e| e.to_string())?;
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
fn do_edit(ws: &mut WorkspaceState, ipc: &IpcHandle) -> Result<EditResult, String> {
    let buf = ws.active().ok_or("No active buffer")?;
    let path_str = buf.file_path_str();
    let version = buf.version();
    let full_text = buf.get_full_text();
    notify_change(&path_str, version, &full_text, ipc);
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
) -> Result<EditResult, String> {
    if text.len() > MAX_INSERT_SIZE {
        return Err(format!(
            "Insertion too large ({} bytes, max {})",
            text.len(),
            MAX_INSERT_SIZE
        ));
    }
    let mut ws = state.workspace.lock().map_err(|e| e.to_string())?;
    let buf = ws.active_mut().ok_or("No active buffer")?;
    buf.insert(line, col, &text).map_err(|e| e.to_string())?;
    do_edit(&mut ws, &state.ipc)
}

#[tauri::command]
fn edit_delete(
    line: usize,
    col: usize,
    len: usize,
    state: tauri::State<AppState>,
) -> Result<EditResult, String> {
    let mut ws = state.workspace.lock().map_err(|e| e.to_string())?;
    let buf = ws.active_mut().ok_or("No active buffer")?;
    buf.delete(line, col, len).map_err(|e| e.to_string())?;
    do_edit(&mut ws, &state.ipc)
}

#[tauri::command]
fn edit_newline(
    line: usize,
    col: usize,
    state: tauri::State<AppState>,
) -> Result<EditResult, String> {
    let mut ws = state.workspace.lock().map_err(|e| e.to_string())?;
    let buf = ws.active_mut().ok_or("No active buffer")?;
    buf.insert(line, col, "\n").map_err(|e| e.to_string())?;
    do_edit(&mut ws, &state.ipc)
}

#[tauri::command]
fn edit_backspace(
    line: usize,
    col: usize,
    state: tauri::State<AppState>,
) -> Result<EditResult, String> {
    let mut ws = state.workspace.lock().map_err(|e| e.to_string())?;
    let buf = ws.active_mut().ok_or("No active buffer")?;
    buf.backspace(line, col).map_err(|e| e.to_string())?;
    do_edit(&mut ws, &state.ipc)
}

#[tauri::command]
fn edit_undo(state: tauri::State<AppState>) -> Result<EditResult, String> {
    let mut ws = state.workspace.lock().map_err(|e| e.to_string())?;
    let buf = ws.active_mut().ok_or("No active buffer")?;
    buf.undo();
    do_edit(&mut ws, &state.ipc)
}

#[tauri::command]
fn edit_redo(state: tauri::State<AppState>) -> Result<EditResult, String> {
    let mut ws = state.workspace.lock().map_err(|e| e.to_string())?;
    let buf = ws.active_mut().ok_or("No active buffer")?;
    buf.redo();
    do_edit(&mut ws, &state.ipc)
}

#[tauri::command]
fn edit_replace_range(
    start_line: usize,
    start_col: usize,
    end_line: usize,
    end_col: usize,
    text: String,
    state: tauri::State<AppState>,
) -> Result<EditResult, String> {
    if text.len() > MAX_INSERT_SIZE {
        return Err(format!(
            "Replacement too large ({} bytes, max {})",
            text.len(),
            MAX_INSERT_SIZE
        ));
    }
    let mut ws = state.workspace.lock().map_err(|e| e.to_string())?;
    let buf = ws.active_mut().ok_or("No active buffer")?;
    buf.replace_range(start_line, start_col, end_line, end_col, &text)
        .map_err(|e| e.to_string())?;
    do_edit(&mut ws, &state.ipc)
}

#[tauri::command]
fn get_text_range(
    start_line: usize,
    start_col: usize,
    end_line: usize,
    end_col: usize,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    let ws = state.workspace.lock().map_err(|e| e.to_string())?;
    let buf = ws.active().ok_or("No active buffer")?;
    Ok(buf.get_text_range(start_line, start_col, end_line, end_col))
}

#[tauri::command]
fn find_in_file(
    query: String,
    case_sensitive: bool,
    state: tauri::State<AppState>,
) -> Result<Vec<editor::FindMatch>, String> {
    let ws = state.workspace.lock().map_err(|e| e.to_string())?;
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
) -> Result<ReplaceResult, String> {
    let mut ws = state.workspace.lock().map_err(|e| e.to_string())?;
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
    notify_change(&path_str, version, &full_text, &state.ipc);
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
fn notify_change(path_str: &str, version: u32, text: &str, ipc: &IpcHandle) {
    ipc.send(OutgoingMessage::DidChange {
        uri: path_to_uri(path_str),
        version,
        text: text.to_string(),
        workspace_id: Some("default".to_string()),
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
    log::info!("CoreCode IPC port: {}", ipc_port);
    let ipc = ipc_bridge::start_ipc_bridge(ipc_port);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState {
            workspace: Mutex::new(WorkspaceState::new()),
            ipc,
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
            lsp_hover,
            lsp_completion,
            lsp_definition,
            lsp_references,
            lsp_code_action,
            lsp_signature_help,
            lsp_document_symbols,
            lsp_format,
        ])
        .setup(move |app| {
            log::info!("CoreCode M7 starting...");

            let app_handle = app.handle().clone();
            std::thread::Builder::new()
                .name("ext-host-mgr".to_string())
                .spawn(move || {
                    if let Err(e) = ext_host::start_extension_host(&app_handle, ipc_port) {
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
