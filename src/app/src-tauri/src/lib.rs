mod editor;
mod ext_host;
mod highlighting;

use editor::EditorState;
use std::sync::Mutex;

/// Shared editor state accessible from Tauri commands.
struct AppState {
    editor: Mutex<EditorState>,
}

// --- Tauri Commands ---

#[tauri::command]
fn open_file(path: String, state: tauri::State<AppState>) -> Result<EditorContent, String> {
    let mut editor = state.editor.lock().map_err(|e| e.to_string())?;
    editor.open_file(&path).map_err(|e| e.to_string())?;
    Ok(editor.get_content())
}

#[tauri::command]
fn save_file(state: tauri::State<AppState>) -> Result<(), String> {
    let editor = state.editor.lock().map_err(|e| e.to_string())?;
    editor.save_file().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_content(state: tauri::State<AppState>) -> Result<EditorContent, String> {
    let editor = state.editor.lock().map_err(|e| e.to_string())?;
    Ok(editor.get_content())
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
    Ok(editor.get_content())
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
    Ok(editor.get_content())
}

#[tauri::command]
fn edit_newline(
    line: usize,
    col: usize,
    state: tauri::State<AppState>,
) -> Result<EditorContent, String> {
    let mut editor = state.editor.lock().map_err(|e| e.to_string())?;
    editor.insert(line, col, "\n").map_err(|e| e.to_string())?;
    Ok(editor.get_content())
}

#[tauri::command]
fn edit_backspace(
    line: usize,
    col: usize,
    state: tauri::State<AppState>,
) -> Result<EditorContent, String> {
    let mut editor = state.editor.lock().map_err(|e| e.to_string())?;
    editor.backspace(line, col).map_err(|e| e.to_string())?;
    Ok(editor.get_content())
}

#[tauri::command]
fn get_ext_host_status(state: tauri::State<AppState>) -> Result<ExtHostStatus, String> {
    let editor = state.editor.lock().map_err(|e| e.to_string())?;
    Ok(editor.ext_host_status())
}

// --- Response types ---

#[derive(serde::Serialize, Clone)]
pub struct EditorContent {
    pub lines: Vec<HighlightedLine>,
    pub line_count: usize,
    pub file_path: Option<String>,
    pub language: Option<String>,
    pub modified: bool,
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

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState {
            editor: Mutex::new(EditorState::new()),
        })
        .invoke_handler(tauri::generate_handler![
            open_file,
            save_file,
            get_content,
            edit_insert,
            edit_delete,
            edit_newline,
            edit_backspace,
            get_ext_host_status,
        ])
        .setup(|app| {
            log::info!("CoreCode M1 starting...");

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
