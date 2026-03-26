mod editor;
mod ext_host;
mod highlighting;
mod ipc_bridge;

use editor::EditorState;
use ipc_bridge::{IpcHandle, OutgoingMessage};
use std::sync::Mutex;

/// Maximum text insertion size (1 MB).
const MAX_INSERT_SIZE: usize = 1024 * 1024;

/// Shared app state accessible from Tauri commands.
struct AppState {
    editor: Mutex<EditorState>,
    ipc: IpcHandle,
}

// --- Path validation ---

/// Canonicalize and validate a file path. Returns the canonical path string.
/// Rejects paths that don't exist or can't be resolved.
fn validate_path(path: &str) -> Result<String, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("Invalid path '{}': {}", path, e))?;

    // Ensure path is a file, not a directory
    if canonical.is_dir() {
        return Err(format!("Path is a directory: {}", path));
    }

    Ok(canonical.to_string_lossy().to_string())
}

/// Build a file:// URI from a canonical path (cross-platform).
fn path_to_uri(path: &str) -> String {
    // On Windows, paths start with C:\, need file:///C:/
    #[cfg(target_os = "windows")]
    {
        format!("file:///{}", path.replace('\\', "/"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!("file://{}", path)
    }
}

// --- Tauri Commands ---

#[tauri::command]
fn open_file(path: String, state: tauri::State<AppState>) -> Result<EditorContent, String> {
    let canonical = validate_path(&path)?;
    let mut editor = state.editor.lock().map_err(|e| e.to_string())?;

    // Send didClose for the previous file
    if let Some(prev_path) = editor.file_path_str() {
        let prev_uri = path_to_uri(&prev_path);
        state.ipc.send(OutgoingMessage::DidClose { uri: prev_uri.clone() });
        state.ipc.clear_diagnostics_for_uri(&prev_uri);
    }

    editor.open_file(&canonical).map_err(|e| e.to_string())?;

    // Notify Extension Host
    let content = editor.get_full_text();
    let language = editor.language().unwrap_or("plaintext".to_string());
    let uri = path_to_uri(&canonical);
    state.ipc.send(OutgoingMessage::DidOpen {
        uri,
        language_id: language,
        version: 1,
        text: content,
    });

    Ok(editor.get_content(&state.ipc))
}

#[tauri::command]
fn save_file(state: tauri::State<AppState>) -> Result<(), String> {
    let editor = state.editor.lock().map_err(|e| e.to_string())?;
    editor.save_file().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_content(state: tauri::State<AppState>) -> Result<EditorContent, String> {
    let editor = state.editor.lock().map_err(|e| e.to_string())?;
    Ok(editor.get_content(&state.ipc))
}

#[tauri::command]
fn edit_insert(
    line: usize,
    col: usize,
    text: String,
    state: tauri::State<AppState>,
) -> Result<EditorContent, String> {
    if text.len() > MAX_INSERT_SIZE {
        return Err(format!(
            "Insertion too large ({} bytes, max {})",
            text.len(),
            MAX_INSERT_SIZE
        ));
    }
    let mut editor = state.editor.lock().map_err(|e| e.to_string())?;
    editor.insert(line, col, &text).map_err(|e| e.to_string())?;
    notify_change(&editor, &state.ipc);
    Ok(editor.get_content(&state.ipc))
}

#[tauri::command]
fn edit_delete(
    line: usize,
    col: usize,
    len: usize,
    state: tauri::State<AppState>,
) -> Result<EditorContent, String> {
    let mut editor = state.editor.lock().map_err(|e| e.to_string())?;
    editor.delete(line, col, len).map_err(|e| e.to_string())?;
    notify_change(&editor, &state.ipc);
    Ok(editor.get_content(&state.ipc))
}

#[tauri::command]
fn edit_newline(
    line: usize,
    col: usize,
    state: tauri::State<AppState>,
) -> Result<EditorContent, String> {
    let mut editor = state.editor.lock().map_err(|e| e.to_string())?;
    editor.insert(line, col, "\n").map_err(|e| e.to_string())?;
    notify_change(&editor, &state.ipc);
    Ok(editor.get_content(&state.ipc))
}

#[tauri::command]
fn edit_backspace(
    line: usize,
    col: usize,
    state: tauri::State<AppState>,
) -> Result<EditorContent, String> {
    let mut editor = state.editor.lock().map_err(|e| e.to_string())?;
    editor.backspace(line, col).map_err(|e| e.to_string())?;
    notify_change(&editor, &state.ipc);
    Ok(editor.get_content(&state.ipc))
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

/// Notify Extension Host of text changes.
fn notify_change(editor: &EditorState, ipc: &IpcHandle) {
    if let Some(path) = editor.file_path_str() {
        ipc.send(OutgoingMessage::DidChange {
            uri: path_to_uri(&path),
            version: editor.version(),
            text: editor.get_full_text(),
        });
    }
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

// --- App entry ---

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    // Start IPC bridge (connects to Extension Host asynchronously)
    let ipc = ipc_bridge::start_ipc_bridge();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState {
            editor: Mutex::new(EditorState::new()),
            ipc,
        })
        .invoke_handler(tauri::generate_handler![
            open_file,
            save_file,
            get_content,
            edit_insert,
            edit_delete,
            edit_newline,
            edit_backspace,
            get_diagnostics,
            get_ext_host_status,
            execute_command,
            list_commands,
            get_notifications,
            get_ui_requests,
            respond_ui_request,
        ])
        .setup(|app| {
            log::info!("CoreCode M2 starting...");

            // Start Extension Host as child process
            let app_handle = app.handle().clone();
            std::thread::Builder::new()
                .name("ext-host-mgr".to_string())
                .spawn(move || {
                    if let Err(e) = ext_host::start_extension_host(&app_handle) {
                        log::error!("Failed to start Extension Host: {}", e);
                    }
                })
                .expect("Failed to spawn Extension Host manager thread");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
