mod editor;
mod ext_host;
mod highlighting;
mod ipc_bridge;

use editor::EditorState;
use ipc_bridge::{IpcHandle, OutgoingMessage};
use std::sync::Mutex;

/// Shared app state accessible from Tauri commands.
struct AppState {
    editor: Mutex<EditorState>,
    ipc: IpcHandle,
}

// --- Tauri Commands ---

#[tauri::command]
fn open_file(path: String, state: tauri::State<AppState>) -> Result<EditorContent, String> {
    let mut editor = state.editor.lock().map_err(|e| e.to_string())?;
    editor.open_file(&path).map_err(|e| e.to_string())?;

    // Notify Extension Host
    let content = editor.get_full_text();
    let language = editor.language().unwrap_or("plaintext".to_string());
    let uri = format!("file://{}", path);
    state.ipc.send(OutgoingMessage::DidOpen {
        uri,
        language_id: language,
        version: 1,
        text: content,
    });

    state.ipc.clear_diagnostics();
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

/// Notify Extension Host of text changes.
fn notify_change(editor: &EditorState, ipc: &IpcHandle) {
    if let Some(path) = editor.file_path_str() {
        ipc.send(OutgoingMessage::DidChange {
            uri: format!("file://{}", path),
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
        ])
        .setup(|app| {
            log::info!("CoreCode M2 starting...");

            // Start Extension Host as child process
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = ext_host::start_extension_host(&app_handle) {
                    log::error!("Failed to start Extension Host: {}", e);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
