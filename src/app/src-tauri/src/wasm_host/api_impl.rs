//! Host-side implementations of the WIT import functions.
//!
//! These functions are called from inside the WASM sandbox via the wasmtime linker.
//! All state that the WASM extension can observe is mediated through `HostContext`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Context threaded through every host import call for a single extension instance.
///
/// Cloned cheaply — the `output_lines` and `status_items` vecs are behind `Arc<Mutex<>>`.
#[derive(Clone)]
pub struct HostContext {
    pub workspace_root: Option<PathBuf>,
    pub workspace_read_allowed: bool,
    /// Buffered output lines: (channel, message). Read by the `get_output_lines` Tauri command.
    pub output_lines: Arc<Mutex<Vec<(String, String)>>>,
    /// Status bar items: id → (text, tooltip). Read by `get_status_bar_items`.
    pub status_items: Arc<Mutex<std::collections::HashMap<String, (String, Option<String>)>>>,
}

impl HostContext {
    pub fn new(workspace_root: Option<PathBuf>, workspace_read: bool) -> Self {
        Self {
            workspace_root,
            workspace_read_allowed: workspace_read,
            output_lines: Arc::new(Mutex::new(Vec::new())),
            status_items: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }
}

// ── ui::log ──────────────────────────────────────────────────────────────────

pub fn host_log(ctx: &mut HostContext, channel: String, message: String) {
    log::info!("[wasm-ext:{}] {}", channel, message);
    if let Ok(mut lines) = ctx.output_lines.lock() {
        lines.push((channel, message));
    }
}

// ── ui::show_message ─────────────────────────────────────────────────────────

pub fn host_show_message(_ctx: &mut HostContext, level: String, message: String) {
    match level.as_str() {
        "error"   => log::error!("[wasm-ext] {}", message),
        "warning" => log::warn!("[wasm-ext] {}", message),
        _         => log::info!("[wasm-ext] {}", message),
    }
    // TODO Phase 1 follow-up: emit a Tauri event so the frontend shows a notification toast.
}

// ── ui::set_status ────────────────────────────────────────────────────────────

pub fn host_set_status(
    ctx: &mut HostContext,
    id: String,
    text: String,
    tooltip: Option<String>,
) {
    if let Ok(mut items) = ctx.status_items.lock() {
        if text.is_empty() {
            items.remove(&id);
        } else {
            items.insert(id, (text, tooltip));
        }
    }
    // TODO Phase 1 follow-up: emit a Tauri event so the frontend refreshes the status bar.
}

// ── workspace::root_uri ───────────────────────────────────────────────────────

pub fn host_root_uri(ctx: &mut HostContext) -> String {
    ctx.workspace_root
        .as_ref()
        .and_then(|p| url::Url::from_file_path(p).ok())
        .map(|u| u.to_string())
        .unwrap_or_default()
}

// ── workspace::read_file ──────────────────────────────────────────────────────

pub fn host_read_file(ctx: &mut HostContext, path: String) -> Result<String, String> {
    if !ctx.workspace_read_allowed {
        return Err("capability 'workspace_read' not declared in corecode.toml".to_string());
    }
    let root = ctx
        .workspace_root
        .as_ref()
        .ok_or_else(|| "no workspace open".to_string())?;

    let rel = std::path::Path::new(&path);
    if rel.is_absolute() {
        return Err(format!("read_file: path must be relative, got '{path}'"));
    }

    // Lexical dotdot guard before canonicalisation
    let joined = root.join(rel);
    for component in joined.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err(format!("read_file: '{path}' traverses outside workspace"));
        }
    }

    // Canonical guard — resolves symlinks
    let canonical = std::fs::canonicalize(&joined)
        .map_err(|e| format!("read_file: cannot resolve '{path}': {e}"))?;
    let root_canonical = std::fs::canonicalize(root)
        .map_err(|e| format!("read_file: cannot resolve workspace root: {e}"))?;
    if !canonical.starts_with(&root_canonical) {
        return Err(format!("read_file: '{path}' is outside the workspace"));
    }

    std::fs::read_to_string(&canonical)
        .map_err(|e| format!("read_file: '{path}': {e}"))
}

// ── workspace::find_files ─────────────────────────────────────────────────────

pub fn host_find_files(ctx: &mut HostContext, _glob: String) -> Result<Vec<String>, String> {
    if !ctx.workspace_read_allowed {
        return Err("capability 'workspace_read' not declared in corecode.toml".to_string());
    }
    if ctx.workspace_root.is_none() {
        return Err("no workspace open".to_string());
    }
    // Phase 1 stub — full glob support added in Phase 2 with the `glob` crate.
    Ok(vec![])
}

// ── workspace::get_config ─────────────────────────────────────────────────────

pub fn host_get_config(_ctx: &mut HostContext, _key: String) -> Option<String> {
    // Phase 1 stub — wired to SettingsStore in Phase 2.
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn ctx_no_workspace() -> HostContext {
        HostContext::new(None, false)
    }

    fn ctx_with_workspace(root: &std::path::Path, read: bool) -> HostContext {
        HostContext::new(Some(root.to_path_buf()), read)
    }

    #[test]
    fn log_appends_to_output_lines() {
        let mut ctx = ctx_no_workspace();
        host_log(&mut ctx, "MyExt".to_string(), "hello".to_string());
        let lines = ctx.output_lines.lock().unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], ("MyExt".to_string(), "hello".to_string()));
    }

    #[test]
    fn set_status_stores_item() {
        let mut ctx = ctx_no_workspace();
        host_set_status(&mut ctx, "s1".to_string(), "ready".to_string(), None);
        let items = ctx.status_items.lock().unwrap();
        assert!(items.contains_key("s1"));
    }

    #[test]
    fn set_status_empty_text_removes_item() {
        let mut ctx = ctx_no_workspace();
        host_set_status(&mut ctx, "s1".to_string(), "ready".to_string(), None);
        host_set_status(&mut ctx, "s1".to_string(), "".to_string(), None);
        let items = ctx.status_items.lock().unwrap();
        assert!(!items.contains_key("s1"));
    }

    #[test]
    fn read_file_denied_without_capability() {
        let mut ctx = ctx_no_workspace();
        let err = host_read_file(&mut ctx, "README.md".to_string()).unwrap_err();
        assert!(err.contains("capability"), "{err}");
    }

    #[test]
    fn read_file_denied_absolute_path() {
        let dir = TempDir::new().unwrap();
        let mut ctx = ctx_with_workspace(dir.path(), true);
        // Use a platform-appropriate absolute path.
        // Forward slashes work for is_absolute() on Windows too.
        #[cfg(windows)]
        let abs_path = "C:/Windows/System32/ntoskrnl.exe".to_string();
        #[cfg(not(windows))]
        let abs_path = "/etc/passwd".to_string();
        let err = host_read_file(&mut ctx, abs_path).unwrap_err();
        assert!(err.contains("relative"), "{err}");
    }

    #[test]
    fn read_file_denied_dotdot_traversal() {
        let dir = TempDir::new().unwrap();
        let mut ctx = ctx_with_workspace(dir.path(), true);
        let err = host_read_file(&mut ctx, "../other/file.txt".to_string()).unwrap_err();
        assert!(err.contains("traverses"), "{err}");
    }

    #[test]
    fn read_file_succeeds_for_workspace_file() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("hello.txt"), b"world").unwrap();
        let mut ctx = ctx_with_workspace(dir.path(), true);
        let content = host_read_file(&mut ctx, "hello.txt".to_string()).unwrap();
        assert_eq!(content, "world");
    }

    #[test]
    fn find_files_denied_without_capability() {
        let mut ctx = ctx_no_workspace();
        let err = host_find_files(&mut ctx, "**/*.rs".to_string()).unwrap_err();
        assert!(err.contains("capability"), "{err}");
    }

    #[test]
    fn root_uri_empty_when_no_workspace() {
        let mut ctx = ctx_no_workspace();
        assert_eq!(host_root_uri(&mut ctx), "");
    }
}
