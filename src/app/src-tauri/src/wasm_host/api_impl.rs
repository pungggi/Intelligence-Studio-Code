//! Host-side implementations of the WIT import functions.
//!
//! These functions are called from inside the WASM sandbox via the wasmtime linker.
//! All state that the WASM extension can observe is mediated through `HostContext`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// A pending webview operation buffered during a WASM call.
#[derive(Debug, Clone)]
pub enum PendingWebviewOp {
    Open { panel_id: String, title: String, column: u32 },
    SetHtml { panel_id: String, html: String },
    PostMessage { panel_id: String, message: String },
    Close { panel_id: String },
}

/// Context threaded through every host import call for a single extension instance.
///
/// Cloned cheaply — the `output_lines` and `status_items` vecs are behind `Arc<Mutex<>>`.
#[derive(Clone)]
pub struct HostContext {
    pub(crate) workspace_root: Option<PathBuf>,
    pub(crate) workspace_read_allowed: bool,
    /// Buffered output lines: (channel, message). Drained by `drain_all_output_lines`.
    pub(crate) output_lines: Arc<Mutex<Vec<(String, String)>>>,
    /// Status bar items: id → (text, tooltip).
    pub(crate) status_items: Arc<Mutex<HashMap<String, (String, Option<String>)>>>,
    /// Buffered notification toasts: (level, message). Drained by `drain_all_notifications`.
    pub(crate) notifications: Arc<Mutex<Vec<(String, String)>>>,
    /// Extension id — used to scope config key lookups.
    pub(crate) extension_id: String,
    /// Shared settings store for `get-config` lookups.
    pub(crate) settings: Option<Arc<Mutex<crate::settings::SettingsStore>>>,
    /// Buffered webview panel operations. Processed by manager after WASM calls return.
    pub(crate) webview_ops: Arc<Mutex<Vec<PendingWebviewOp>>>,
    /// Whether this extension declared `webview_panels = true`.
    pub(crate) webview_panels_allowed: bool,
}

impl HostContext {
    pub fn new(
        workspace_root: Option<PathBuf>,
        workspace_read: bool,
        extension_id: String,
        settings: Option<Arc<Mutex<crate::settings::SettingsStore>>>,
        webview_panels: bool,
    ) -> Self {
        Self {
            workspace_root,
            workspace_read_allowed: workspace_read,
            output_lines: Arc::new(Mutex::new(Vec::new())),
            status_items: Arc::new(Mutex::new(HashMap::new())),
            notifications: Arc::new(Mutex::new(Vec::new())),
            extension_id,
            settings,
            webview_ops: Arc::new(Mutex::new(Vec::new())),
            webview_panels_allowed: webview_panels,
        }
    }
}

const MAX_OUTPUT_LINES: usize = 1_000;
const MAX_NOTIFICATIONS: usize = 200;

// ── ui::log ──────────────────────────────────────────────────────────────────

pub fn host_log(ctx: &mut HostContext, channel: String, message: String) {
    log::info!("[wasm-ext:{}] {}", channel, message);
    if let Ok(mut lines) = ctx.output_lines.lock() {
        if lines.len() < MAX_OUTPUT_LINES {
            lines.push((channel, message));
        } else {
            log::warn!("[wasm-ext:{}] output buffer full — dropping message", channel);
        }
    }
}

// ── ui::show_message ─────────────────────────────────────────────────────────

pub fn host_show_message(ctx: &mut HostContext, level: String, message: String) {
    match level.as_str() {
        "error"   => log::error!("[wasm-ext] {}", message),
        "warning" => log::warn!("[wasm-ext] {}", message),
        _         => log::info!("[wasm-ext] {}", message),
    }
    if let Ok(mut notifs) = ctx.notifications.lock() {
        if notifs.len() < MAX_NOTIFICATIONS {
            notifs.push((level, message));
        }
    }
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
}

// ── workspace::root_uri ───────────────────────────────────────────────────────

pub fn host_root_uri(ctx: &HostContext) -> String {
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

pub fn host_find_files(ctx: &mut HostContext, pattern: String) -> Result<Vec<String>, String> {
    if !ctx.workspace_read_allowed {
        return Err("capability 'workspace_read' not declared in corecode.toml".to_string());
    }
    let root = ctx.workspace_root.as_ref()
        .ok_or_else(|| "no workspace open".to_string())?;

    // Anchor the glob pattern inside the workspace root.
    let full_pattern = root.join(&pattern);
    let full_str = full_pattern.to_string_lossy();

    let paths = glob::glob(&full_str)
        .map_err(|e| format!("find_files: invalid pattern '{pattern}': {e}"))?
        .filter_map(|entry| entry.ok())
        .filter(|p| p.is_file())
        .take(1_000)
        .map(|p| p.to_string_lossy().into_owned())
        .collect();

    Ok(paths)
}

// ── workspace::get_config ─────────────────────────────────────────────────────

pub fn host_get_config(ctx: &mut HostContext, key: String) -> Option<String> {
    // Scope the key to the extension's namespace:
    // e.g. extension "my.ext" requesting "format.tabSize" becomes "my.ext.format.tabSize"
    let scoped_key = format!("{}.{}", ctx.extension_id, key);
    ctx.settings.as_ref()?
        .lock().ok()?
        .get_string(&scoped_key)
}

// ── webview imports ───────────────────────────────────────────────────────────

const MAX_PANEL_ID_LEN: usize = 64;
const MAX_WEBVIEW_OPS: usize = 50;
/// Maximum HTML payload size per set-html call (2 MB).
const MAX_HTML_SIZE: usize = 2 * 1024 * 1024;

fn validate_panel_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > MAX_PANEL_ID_LEN {
        return Err(format!("panel_id must be 1-{MAX_PANEL_ID_LEN} characters"));
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
        return Err("panel_id must contain only alphanumeric, hyphen, or dot".to_string());
    }
    Ok(())
}

fn push_webview_op(ctx: &mut HostContext, op: PendingWebviewOp) {
    if let Ok(mut ops) = ctx.webview_ops.lock() {
        if ops.len() < MAX_WEBVIEW_OPS {
            ops.push(op);
        } else {
            log::warn!("[wasm-ext:{}] webview ops buffer full — dropping", ctx.extension_id);
        }
    }
}

pub fn host_open_panel(ctx: &mut HostContext, panel_id: String, title: String, column: u32) -> Result<(), String> {
    if !ctx.webview_panels_allowed {
        return Err("capability 'webview_panels' not declared in corecode.toml".to_string());
    }
    validate_panel_id(&panel_id)?;
    push_webview_op(ctx, PendingWebviewOp::Open { panel_id, title, column });
    Ok(())
}

pub fn host_set_html(ctx: &mut HostContext, panel_id: String, html: String) -> Result<(), String> {
    if !ctx.webview_panels_allowed {
        return Err("capability 'webview_panels' not declared in corecode.toml".to_string());
    }
    validate_panel_id(&panel_id)?;
    if html.len() > MAX_HTML_SIZE {
        return Err(format!("HTML payload exceeds {} MB limit", MAX_HTML_SIZE / (1024 * 1024)));
    }
    push_webview_op(ctx, PendingWebviewOp::SetHtml { panel_id, html });
    Ok(())
}

pub fn host_post_to_webview(ctx: &mut HostContext, panel_id: String, message: String) -> Result<(), String> {
    if !ctx.webview_panels_allowed {
        return Err("capability 'webview_panels' not declared in corecode.toml".to_string());
    }
    validate_panel_id(&panel_id)?;
    push_webview_op(ctx, PendingWebviewOp::PostMessage { panel_id, message });
    Ok(())
}

pub fn host_close_panel(ctx: &mut HostContext, panel_id: String) -> Result<(), String> {
    if !ctx.webview_panels_allowed {
        return Err("capability 'webview_panels' not declared in corecode.toml".to_string());
    }
    validate_panel_id(&panel_id)?;
    push_webview_op(ctx, PendingWebviewOp::Close { panel_id });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn ctx_no_workspace() -> HostContext {
        HostContext::new(None, false, "test.ext".to_string(), None, false)
    }

    fn ctx_with_workspace(root: &std::path::Path, read: bool) -> HostContext {
        HostContext::new(Some(root.to_path_buf()), read, "test.ext".to_string(), None, false)
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
    fn show_message_buffers_notification() {
        let mut ctx = ctx_no_workspace();
        host_show_message(&mut ctx, "warning".to_string(), "test warning".to_string());
        let notifs = ctx.notifications.lock().unwrap();
        assert_eq!(notifs.len(), 1);
        assert_eq!(notifs[0], ("warning".to_string(), "test warning".to_string()));
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
        // On Windows, a path is absolute only if it includes a drive letter or UNC root
        // (e.g., "C:/..."). A leading forward slash alone is drive-relative and not
        // considered absolute by is_absolute(). We use #[cfg(windows)] to supply a true
        // absolute path versus a POSIX absolute path ("/etc/passwd") for non-Windows.
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
        let ctx = ctx_no_workspace();
        assert_eq!(host_root_uri(&ctx), "");
    }

    #[test]
    fn root_uri_returns_file_url_when_workspace_set() {
        let dir = TempDir::new().unwrap();
        let ctx = ctx_with_workspace(dir.path(), false);
        let uri = host_root_uri(&ctx);
        assert!(uri.starts_with("file://"), "{}", uri);
    }

    // ── panel ID validation ───────────────────────────────────────────────────

    fn ctx_webview() -> HostContext {
        HostContext::new(None, false, "test.ext".to_string(), None, true)
    }

    #[test]
    fn validate_panel_id_rejects_empty() {
        assert!(validate_panel_id("").is_err());
    }

    #[test]
    fn validate_panel_id_accepts_exactly_64_chars() {
        let id = "a".repeat(MAX_PANEL_ID_LEN);
        assert!(validate_panel_id(&id).is_ok(), "64-char id should be valid");
    }

    #[test]
    fn validate_panel_id_rejects_65_chars() {
        let id = "a".repeat(MAX_PANEL_ID_LEN + 1);
        assert!(validate_panel_id(&id).is_err());
    }

    #[test]
    fn validate_panel_id_rejects_invalid_chars() {
        assert!(validate_panel_id("bad/slash").is_err());
        assert!(validate_panel_id("bad space").is_err());
        assert!(validate_panel_id("bad@at").is_err());
    }

    #[test]
    fn validate_panel_id_accepts_hyphen_and_dot() {
        assert!(validate_panel_id("my-panel.1").is_ok());
    }

    // ── webview ops buffer cap ────────────────────────────────────────────────

    #[test]
    fn open_panel_drops_when_buffer_full() {
        let mut ctx = ctx_webview();
        // Fill the buffer to MAX_WEBVIEW_OPS
        for i in 0..MAX_WEBVIEW_OPS {
            host_open_panel(&mut ctx, format!("p{i}"), "T".to_string(), 1).unwrap();
        }
        // The next op should silently succeed from the caller's view (no error),
        // but the op must be dropped (buffer stays at MAX_WEBVIEW_OPS).
        host_open_panel(&mut ctx, "overflow".to_string(), "T".to_string(), 1).unwrap();
        let ops = ctx.webview_ops.lock().unwrap();
        assert_eq!(ops.len(), MAX_WEBVIEW_OPS, "buffer must not exceed MAX_WEBVIEW_OPS");
    }

    // ── HTML size limit ───────────────────────────────────────────────────────

    #[test]
    fn set_html_accepts_payload_at_limit() {
        let mut ctx = ctx_webview();
        host_open_panel(&mut ctx, "p1".to_string(), "T".to_string(), 1).unwrap();
        let html = "x".repeat(MAX_HTML_SIZE);
        assert!(host_set_html(&mut ctx, "p1".to_string(), html).is_ok());
    }

    #[test]
    fn set_html_rejects_payload_over_limit() {
        let mut ctx = ctx_webview();
        host_open_panel(&mut ctx, "p1".to_string(), "T".to_string(), 1).unwrap();
        let html = "x".repeat(MAX_HTML_SIZE + 1);
        let err = host_set_html(&mut ctx, "p1".to_string(), html).unwrap_err();
        assert!(err.contains("MB limit"), "{err}");
    }

    // ── notification buffer cap ───────────────────────────────────────────────

    #[test]
    fn show_message_drops_when_buffer_full() {
        let mut ctx = ctx_no_workspace();
        for _ in 0..MAX_NOTIFICATIONS {
            host_show_message(&mut ctx, "info".to_string(), "msg".to_string());
        }
        // Additional notification must be silently dropped.
        host_show_message(&mut ctx, "info".to_string(), "overflow".to_string());
        let notifs = ctx.notifications.lock().unwrap();
        assert_eq!(notifs.len(), MAX_NOTIFICATIONS);
    }

    // ── find_files result cap ─────────────────────────────────────────────────

    #[test]
    fn find_files_caps_results_at_1000() {
        let dir = TempDir::new().unwrap();
        // Create 1 001 files.
        for i in 0..=1_000usize {
            std::fs::write(dir.path().join(format!("f{i:04}.txt")), b"").unwrap();
        }
        let mut ctx = ctx_with_workspace(dir.path(), true);
        let results = host_find_files(&mut ctx, "*.txt".to_string()).unwrap();
        assert_eq!(results.len(), 1_000, "result must be capped at 1 000");
    }
}
