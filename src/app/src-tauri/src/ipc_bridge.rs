//! IPC Bridge — Async communication with the Node.js Extension Host.
//!
//! Uses TCP on localhost with length-prefixed JSON messages.
//! Cross-platform (Linux, macOS, Windows).
//! Runs on a dedicated Tokio runtime in a background thread.
//!
//! M6: Adds request/response pattern with correlation IDs for LSP features.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::mpsc;

const IPC_HOST: &str = "127.0.0.1";

/// Maximum IPC frame size (10 MB). Frames larger than this are rejected.
const MAX_FRAME_SIZE: usize = 10 * 1024 * 1024;

/// Maximum number of connection retries before giving up.
const MAX_CONNECT_RETRIES: u32 = 60;

/// Initial retry delay in milliseconds, doubles each attempt (capped at 10s).
const INITIAL_RETRY_DELAY_MS: u64 = 500;
const MAX_RETRY_DELAY_MS: u64 = 10_000;

/// A diagnostic from the Extension Host (e.g., ESLint error).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    pub uri: Option<String>,
    pub line: usize,
    pub col_start: usize,
    #[serde(default)]
    pub end_line: Option<usize>,
    pub col_end: usize,
    pub severity: DiagnosticSeverity,
    pub message: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Info,
    Hint,
}

/// Messages sent from the editor to the Extension Host.
/// M5: All document-related messages include an optional `workspace_id` field
/// for future multi-workspace routing. Defaults to "default" for single workspace.
/// M6: Adds LSP request messages with request_id for request/response correlation.
#[derive(Debug, Serialize)]
#[serde(tag = "method", content = "params")]
#[allow(dead_code)]
pub enum OutgoingMessage {
    #[serde(rename = "textDocument/didOpen")]
    DidOpen {
        uri: String,
        language_id: String,
        version: u32,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_id: Option<String>,
    },
    #[serde(rename = "textDocument/didChange")]
    DidChange {
        uri: String,
        version: u32,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_id: Option<String>,
    },
    #[serde(rename = "textDocument/didClose")]
    DidClose {
        uri: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_id: Option<String>,
    },
    #[serde(rename = "textDocument/didSave")]
    DidSave {
        uri: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_id: Option<String>,
    },
    #[serde(rename = "executeCommand")]
    ExecuteCommand { command: String, args: Vec<serde_json::Value> },
    #[serde(rename = "listCommands")]
    ListCommands,
    #[serde(rename = "quickPickResponse")]
    UiResponse {
        request_id: String,
        value: Option<serde_json::Value>,
    },
    /// M6: Generic LSP request with correlation ID.
    #[serde(rename = "lsp/request")]
    LspRequest {
        request_id: String,
        method: String,
        params: serde_json::Value,
    },
    /// M8: Notify Extension Host that an extension was installed.
    #[serde(rename = "extension/installed")]
    ExtensionInstalled { path: String },
    /// M8: Notify Extension Host that an extension was uninstalled.
    #[serde(rename = "extension/uninstalled")]
    ExtensionUninstalled { id: String },
    /// M8: Notify Extension Host that a setting changed.
    #[serde(rename = "settings/changed")]
    SettingsChanged {
        key: String,
        value: serde_json::Value,
    },
    /// M8b: Forward a message from a webview iframe to the Extension Host.
    #[serde(rename = "webview/messageFromWebview")]
    WebviewMessageFromWebview {
        panel_id: String,
        message: serde_json::Value,
    },
    /// M8b: Notify Extension Host that the user closed a webview panel.
    #[serde(rename = "webview/closedByUser")]
    WebviewClosedByUser { panel_id: String },
    /// Notify Extension Host that a terminal was successfully created.
    #[serde(rename = "terminal/created")]
    TerminalCreated {
        request_id: String,
        terminal_id: String,
    },
    /// IPC authentication handshake — must be the first message sent on connection.
    #[serde(rename = "ipc/auth")]
    IpcAuth { token: String },
    /// Register a workspace window with the Extension Host.
    #[serde(rename = "workspace/register")]
    WorkspaceRegister {
        workspace_id: String,
        root_path: String,
    },
    /// Unregister a workspace window from the Extension Host.
    #[serde(rename = "workspace/unregister")]
    WorkspaceUnregister {
        workspace_id: String,
    },
}


/// Messages received from the Extension Host.
#[derive(Debug, Deserialize)]
pub struct IncomingMessage {
    pub method: String,
    pub params: Option<serde_json::Value>,
}

/// Thread-safe helper: lock a mutex, returning a default on poison.
///
/// Mutex poisoning indicates a previous thread panicked while holding the lock.
/// Logged at ERROR because the data inside may be in a partially-modified state
/// and the root cause (the panic) should always be investigated.
fn lock_or_default<T: Default>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| {
        log::error!("[IPC] Recovering from poisoned mutex — a previous thread panicked while holding this lock; state may be inconsistent");
        poisoned.into_inner()
    })
}

/// Maximum number of webview panel events buffered before events are dropped.
const MAX_WEBVIEW_EVENTS: usize = 100;

/// Push a webview panel event, dropping it (with a warning) if the queue is full.
fn push_webview_event(store: &Mutex<Vec<WebviewPanelEvent>>, event: WebviewPanelEvent) {
    let mut guard = lock_or_default(store);
    if guard.len() < MAX_WEBVIEW_EVENTS {
        guard.push(event);
    } else {
        log::warn!("[IPC] Webview event queue full — dropping '{}' event for panel '{}'", event.kind, event.panel_id);
    }
}

/// A notification message from the Extension Host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notification {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub message: String,
}

/// A QuickPick or InputBox request from the Extension Host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiRequest {
    pub kind: String,
    pub request_id: String,
    pub params: serde_json::Value,
}

/// A status bar item contributed by an extension.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusBarItem {
    pub id: String,
    pub text: String,
    pub tooltip: Option<String>,
    pub command: Option<String>,
    pub alignment: String,
    pub priority: i32,
}

/// An output channel line from an extension.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputLine {
    pub channel: String,
    pub text: String,
}

/// M8b: A webview panel event from the Extension Host (create, setHtml, postMessage, reveal, close).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebviewPanelEvent {
    pub kind: String,
    pub panel_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_scripts: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<serde_json::Value>,
}

/// A terminal event from the Extension Host (create, write, show, close).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalEvent {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
}

const MAX_TERMINAL_EVENTS: usize = 200;

fn push_terminal_event(store: &Mutex<Vec<TerminalEvent>>, event: TerminalEvent) {
    let mut guard = lock_or_default(store);
    if guard.len() < MAX_TERMINAL_EVENTS {
        guard.push(event);
    } else {
        log::warn!("[IPC] Terminal event queue full — dropping '{}' event", event.kind);
    }
}

/// A single text edit within a WorkspaceEdit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceTextEdit {
    pub start_line: usize,
    pub start_col: usize,
    pub end_line: usize,
    pub end_col: usize,
    pub new_text: String,
}

/// A batch of text edits for one file, part of a WorkspaceEdit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceFileEdit {
    pub uri: String,
    pub edits: Vec<WorkspaceTextEdit>,
}

/// A workspace/applyEdit request from the Extension Host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceEditRequest {
    pub request_id: String,
    pub changes: Vec<WorkspaceFileEdit>,
}

const MAX_WORKSPACE_EDIT_REQUESTS: usize = 32;

/// A debug/startSession request from the Extension Host.
/// The Extension Host resolves the adapter executable path and sends this to Rust.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugStartRequest {
    pub session_id: String,
    pub adapter_cmd: String,
    pub adapter_args: Vec<String>,
    pub launch_config: serde_json::Value,
}

const MAX_DEBUG_START_REQUESTS: usize = 16;

fn push_debug_start_request(store: &Mutex<Vec<DebugStartRequest>>, req: DebugStartRequest) {
    let mut guard = lock_or_default(store);
    if guard.len() >= MAX_DEBUG_START_REQUESTS {
        log::warn!("[IPC] Debug start request queue full — dropping session '{}'", req.session_id);
        return;
    }
    guard.push(req);
}

/// Tree view registration/update events from the Extension Host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeViewEvent {
    pub event_type: String, // "register" | "update" | "unregister"
    pub view_id: String,
}

const MAX_TREE_VIEW_EVENTS: usize = 64;

/// A request from an extension to open a file in the editor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShowTextDocumentRequest {
    pub uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<ShowTextDocumentSelection>,
    #[serde(default)]
    pub preserve_focus: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShowTextDocumentSelection {
    pub start_line: usize,
    pub start_character: usize,
    pub end_line: usize,
    pub end_character: usize,
}

const MAX_SHOW_TEXT_DOCUMENT: usize = 32;

/// A single resource state within an SCM resource group.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScmResourceState {
    pub uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decoration_tooltip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decoration_letter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decoration_color: Option<String>,
}

/// A resource group within an SCM source control.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScmResourceGroup {
    pub id: String,
    pub label: String,
    pub resources: Vec<ScmResourceState>,
}

/// The full state of one SCM source control provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScmSourceControlState {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_uri: Option<String>,
    pub resource_groups: Vec<ScmResourceGroup>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_bar_command: Option<String>,
}

/// A comment author within a review thread.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentAuthor {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
}

/// A single comment within a review thread.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentThreadComment {
    pub author: CommentAuthor,
    pub body: String,
    pub mode: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
}

/// A comment review thread anchored to a URI + line range.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentThread {
    pub id: String,
    pub controller_id: String,
    pub uri: String,
    pub start_line: u32,
    pub end_line: u32,
    pub comments: Vec<CommentThreadComment>,
    pub collapsible_state: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_value: Option<String>,
}

/// A text decoration from an extension.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextDecoration {
    pub uri: String,
    pub decoration_type: String,
    pub ranges: Vec<DecorationRange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecorationRange {
    pub start_line: usize,
    pub start_col: usize,
    pub end_line: usize,
    pub end_col: usize,
    pub hover_message: Option<String>,
}


/// M6: Default timeout for LSP requests (10 seconds).
const LSP_REQUEST_TIMEOUT_MS: u64 = 10_000;
/// Maximum number of concurrent pending LSP requests to prevent unbounded memory growth.
const MAX_PENDING_REQUESTS: usize = 200;

/// Shared state for the IPC bridge, bundling all synchronized fields so they
/// can be passed as a single `Arc<IpcState>` instead of 18 separate Arcs.
pub(crate) struct IpcState {
    pub diagnostics: Mutex<Vec<Diagnostic>>,
    pub connected: Mutex<bool>,
    pub commands: Mutex<Vec<String>>,
    pub notifications: Mutex<Vec<Notification>>,
    pub ui_requests: Mutex<Vec<UiRequest>>,
    pub status_bar_items: Mutex<Vec<StatusBarItem>>,
    pub output_lines: Mutex<Vec<OutputLine>>,
    pub decorations: Mutex<Vec<TextDecoration>>,
    pub pending_requests: Mutex<HashMap<String, std::sync::mpsc::Sender<serde_json::Value>>>,
    pub request_counter: Mutex<u64>,
    pub webview_events: Mutex<Vec<WebviewPanelEvent>>,
    pub terminal_events: Mutex<Vec<TerminalEvent>>,
    pub debug_start_requests: Mutex<Vec<DebugStartRequest>>,
    pub workspace_edit_requests: Mutex<Vec<WorkspaceEditRequest>>,
    pub tree_view_events: Mutex<Vec<TreeViewEvent>>,
    pub show_text_document_requests: Mutex<Vec<ShowTextDocumentRequest>>,
    pub scm_states: Mutex<HashMap<String, ScmSourceControlState>>,
    pub comment_threads: Mutex<HashMap<String, CommentThread>>,
}

impl IpcState {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            diagnostics: Mutex::new(Vec::new()),
            connected: Mutex::new(false),
            commands: Mutex::new(Vec::new()),
            notifications: Mutex::new(Vec::new()),
            ui_requests: Mutex::new(Vec::new()),
            status_bar_items: Mutex::new(Vec::new()),
            output_lines: Mutex::new(Vec::new()),
            decorations: Mutex::new(Vec::new()),
            pending_requests: Mutex::new(HashMap::new()),
            request_counter: Mutex::new(0u64),
            webview_events: Mutex::new(Vec::new()),
            terminal_events: Mutex::new(Vec::new()),
            debug_start_requests: Mutex::new(Vec::new()),
            workspace_edit_requests: Mutex::new(Vec::new()),
            tree_view_events: Mutex::new(Vec::new()),
            show_text_document_requests: Mutex::new(Vec::new()),
            scm_states: Mutex::new(HashMap::new()),
            comment_threads: Mutex::new(HashMap::new()),
        })
    }
}

/// Handle to the IPC bridge for sending messages.
#[derive(Clone)]
pub struct IpcHandle {
    sender: mpsc::Sender<OutgoingMessage>,
    state: Arc<IpcState>,
}

impl IpcHandle {
    pub fn send(&self, msg: OutgoingMessage) {
        if let Err(e) = self.sender.try_send(msg) {
            log::warn!("[IPC] Outgoing message dropped (channel full or closed): {}", e);
        }
    }

    pub fn get_diagnostics(&self) -> Vec<Diagnostic> {
        lock_or_default(&self.state.diagnostics).clone()
    }

    pub fn get_diagnostics_for_uri(&self, uri: &str) -> Vec<Diagnostic> {
        lock_or_default(&self.state.diagnostics)
            .iter()
            .filter(|d| d.uri.as_deref() == Some(uri))
            .cloned()
            .collect()
    }

    pub fn clear_diagnostics_for_uri(&self, uri: &str) {
        lock_or_default(&self.state.diagnostics).retain(|d| d.uri.as_deref() != Some(uri));
    }

    pub fn is_connected(&self) -> bool {
        *lock_or_default(&self.state.connected)
    }

    pub fn get_commands(&self) -> Vec<String> {
        lock_or_default(&self.state.commands).clone()
    }

    /// Drain all pending notifications (returns and clears them).
    pub fn drain_notifications(&self) -> Vec<Notification> {
        let mut store = lock_or_default(&self.state.notifications);
        std::mem::take(&mut *store)
    }

    /// Drain all pending UI requests (QuickPick/InputBox).
    pub fn drain_ui_requests(&self) -> Vec<UiRequest> {
        let mut store = lock_or_default(&self.state.ui_requests);
        std::mem::take(&mut *store)
    }

    /// Get current status bar items.
    pub fn get_status_bar_items(&self) -> Vec<StatusBarItem> {
        lock_or_default(&self.state.status_bar_items).clone()
    }

    /// Drain pending output lines.
    pub fn drain_output_lines(&self) -> Vec<OutputLine> {
        let mut store = lock_or_default(&self.state.output_lines);
        std::mem::take(&mut *store)
    }

    /// Get decorations for a specific URI.
    pub fn get_decorations_for_uri(&self, uri: &str) -> Vec<TextDecoration> {
        lock_or_default(&self.state.decorations)
            .iter()
            .filter(|d| d.uri == uri)
            .cloned()
            .collect()
    }

    /// M8b: Drain all pending webview panel events.
    pub fn drain_webview_events(&self) -> Vec<WebviewPanelEvent> {
        let mut store = lock_or_default(&self.state.webview_events);
        std::mem::take(&mut *store)
    }

    /// Drain all pending terminal events from the Extension Host.
    pub fn drain_terminal_events(&self) -> Vec<TerminalEvent> {
        let mut store = lock_or_default(&self.state.terminal_events);
        std::mem::take(&mut *store)
    }

    /// Drain all pending debug session start requests from the Extension Host.
    pub fn drain_debug_start_requests(&self) -> Vec<DebugStartRequest> {
        let mut store = lock_or_default(&self.state.debug_start_requests);
        std::mem::take(&mut *store)
    }

    /// Drain all pending workspace edit requests from the Extension Host.
    pub fn drain_workspace_edit_requests(&self) -> Vec<WorkspaceEditRequest> {
        let mut store = lock_or_default(&self.state.workspace_edit_requests);
        std::mem::take(&mut *store)
    }

    /// Drain all pending tree view events from the Extension Host.
    pub fn drain_tree_view_events(&self) -> Vec<TreeViewEvent> {
        let mut store = lock_or_default(&self.state.tree_view_events);
        std::mem::take(&mut *store)
    }

    /// Drain all pending showTextDocument requests from the Extension Host.
    pub fn drain_show_text_document_requests(&self) -> Vec<ShowTextDocumentRequest> {
        let mut store = lock_or_default(&self.state.show_text_document_requests);
        std::mem::take(&mut *store)
    }

    /// Get current SCM source control states (keyed by id) from Extension Host.
    pub fn get_scm_states(&self) -> HashMap<String, ScmSourceControlState> {
        lock_or_default(&self.state.scm_states).clone()
    }

    /// Get all comment threads for the given URI.
    pub fn get_comment_threads_for_uri(&self, uri: &str) -> Vec<CommentThread> {
        lock_or_default(&self.state.comment_threads)
            .values()
            .filter(|t| t.uri == uri)
            .cloned()
            .collect()
    }

    /// M6: Generate a unique request ID.
    fn next_request_id(&self) -> String {
        let mut counter = lock_or_default(&self.state.request_counter);
        *counter += 1;
        format!("req-{}", *counter)
    }

    /// M6: Send an LSP request and wait for a response (blocking, for Tauri commands).
    /// Returns the response JSON value or an error on timeout/failure.
    /// Uses std::sync::mpsc with recv_timeout for reliable timeout behavior
    /// regardless of which thread calls this method.
    pub fn request_sync(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> std::result::Result<serde_json::Value, String> {
        let request_id = self.next_request_id();
        let (tx, rx) = std::sync::mpsc::channel();

        // Register pending request (cap to prevent unbounded memory growth).
        {
            let mut pending = lock_or_default(&self.state.pending_requests);
            if pending.len() >= MAX_PENDING_REQUESTS {
                return Err("Too many pending LSP requests".to_string());
            }
            pending.insert(request_id.clone(), tx);
        }

        // Send the request — use try_send directly so we can detect failure
        // and clean up the pending entry instead of leaving it orphaned.
        if let Err(e) = self.sender.try_send(OutgoingMessage::LspRequest {
            request_id: request_id.clone(),
            method: method.to_string(),
            params,
        }) {
            lock_or_default(&self.state.pending_requests).remove(&request_id);
            return Err(format!("Failed to send LSP request: {e}"));
        }

        // Block on the response with timeout (works from any thread)
        match rx.recv_timeout(std::time::Duration::from_millis(LSP_REQUEST_TIMEOUT_MS)) {
            Ok(value) => Ok(value),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // Timeout — remove from pending
                lock_or_default(&self.state.pending_requests).remove(&request_id);
                Err("LSP request timed out".to_string())
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                // Channel was dropped (e.g., disconnect) — clean up pending entry
                lock_or_default(&self.state.pending_requests).remove(&request_id);
                Err("LSP request cancelled".to_string())
            }
        }
    }
}

/// Find a free TCP port by binding to port 0 and reading the assigned port.
/// The socket is closed immediately, so there is a small race window.
pub fn find_free_port() -> u16 {
    let listener = std::net::TcpListener::bind((IPC_HOST, 0u16))
        .expect("Failed to bind to ephemeral port");
    listener.local_addr().unwrap().port()
}

/// Start the IPC bridge. Returns a handle for sending messages.
/// The bridge runs in a background thread with its own Tokio runtime.
pub fn start_ipc_bridge(port: u16, auth_token: &str) -> IpcHandle {
    let (tx, rx) = mpsc::channel::<OutgoingMessage>(256);
    let state = IpcState::new();

    let handle = IpcHandle {
        sender: tx,
        state: state.clone(),
    };

    let token_for_thread = auth_token.to_string();
    std::thread::Builder::new()
        .name("ipc-bridge".to_string())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("Failed to create Tokio runtime");

            rt.block_on(async move {
                ipc_loop(port, &token_for_thread, rx, state).await;
            });
        })
        .expect("Failed to spawn IPC bridge thread");

    handle
}

async fn ipc_loop(
    port: u16,
    auth_token: &str,
    mut rx: mpsc::Receiver<OutgoingMessage>,
    state: Arc<IpcState>,
) {
    let addr = format!("{}:{}", IPC_HOST, port);
    let mut retry_count: u32 = 0;
    let mut delay_ms = INITIAL_RETRY_DELAY_MS;

    loop {
        if retry_count >= MAX_CONNECT_RETRIES {
            log::error!(
                "[IPC] Giving up after {} connection attempts to {}",
                MAX_CONNECT_RETRIES,
                addr
            );
            return;
        }

        match TcpStream::connect(&addr).await {
            Ok(stream) => {
                *lock_or_default(&state.connected) = true;
                log::info!("[IPC] Connected to Extension Host at {}", addr);

                // Reset backoff on successful connection
                retry_count = 0;
                delay_ms = INITIAL_RETRY_DELAY_MS;

                if let Err(e) = handle_connection(stream, auth_token, &mut rx, &state).await {
                    log::warn!("[IPC] Connection lost: {}", e);
                }

                *lock_or_default(&state.connected) = false;
            }
            Err(e) => {
                if retry_count % 10 == 0 {
                    log::info!(
                        "[IPC] Waiting for Extension Host at {} (attempt {}/{}): {}",
                        addr,
                        retry_count + 1,
                        MAX_CONNECT_RETRIES,
                        e
                    );
                }
                retry_count += 1;
            }
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms)).await;
        delay_ms = (delay_ms * 2).min(MAX_RETRY_DELAY_MS);
    }
}

async fn handle_connection(
    stream: TcpStream,
    auth_token: &str,
    rx: &mut mpsc::Receiver<OutgoingMessage>,
    state: &Arc<IpcState>,
) -> Result<()> {
    let (mut reader, mut writer) = stream.into_split();

    // Send auth token as the first message immediately on connection
    {
        let auth_msg = OutgoingMessage::IpcAuth { token: auth_token.to_string() };
        let json = serde_json::to_vec(&auth_msg)
            .context("Failed to serialize auth message")?;
        let len = (json.len() as u32).to_le_bytes();
        writer.write_all(&len).await?;
        writer.write_all(&json).await?;
        writer.flush().await?;
        log::info!("[IPC] Auth token sent");
    }

    // Spawn reader task
    let state_clone = state.clone();
    let mut read_task = tokio::spawn(async move {
        let mut buf = vec![0u8; 65536];
        let mut accumulated = Vec::new();

        loop {
            match reader.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    // Guard against unbounded accumulation BEFORE extending the buffer.
                    // Checking after extend would allow a slow sender to allocate up to
                    // MAX_FRAME_SIZE + one extra read-chunk before the check fires.
                    if accumulated.len() + n > MAX_FRAME_SIZE + 4 {
                        log::error!(
                            "[IPC] Accumulated buffer would exceed limit ({} + {} bytes), dropping connection",
                            accumulated.len(), n
                        );
                        return;
                    }
                    accumulated.extend_from_slice(&buf[..n]);

                    // Process complete frames
                    while accumulated.len() >= 4 {
                        let frame_len = u32::from_le_bytes(
                            accumulated[..4].try_into().expect("slice is exactly 4 bytes"),
                        ) as usize;

                        // Reject empty or oversized frames
                        if frame_len == 0 || frame_len > MAX_FRAME_SIZE {
                            log::error!(
                                "[IPC] Frame too large ({} bytes, max {}), dropping connection",
                                frame_len,
                                MAX_FRAME_SIZE
                            );
                            return;
                        }

                        if accumulated.len() < 4 + frame_len {
                            break;
                        }

                        let payload = &accumulated[4..4 + frame_len];
                        match serde_json::from_slice::<IncomingMessage>(payload) {
                            Ok(msg) => handle_incoming(&msg, &state_clone),
                            Err(e) => log::warn!("[IPC] Malformed message: {}", e),
                        }

                        accumulated.drain(..4 + frame_len);
                    }
                }
                Err(e) => {
                    log::warn!("[IPC] Read error: {}", e);
                    break;
                }
            }
        }
    });

    // Writer loop — send outgoing messages
    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    Some(msg) => {
                        let json = serde_json::to_vec(&msg)
                            .context("Failed to serialize outgoing message")?;
                        let len = (json.len() as u32).to_le_bytes();
                        writer.write_all(&len).await?;
                        writer.write_all(&json).await?;
                        writer.flush().await?;
                    }
                    None => break,
                }
            }
            _ = &mut read_task => {
                break;
            }
        }
    }

    // Drain pending LSP requests so callers unblock immediately on disconnect
    // instead of waiting for the 10-second timeout.
    {
        let mut pending = lock_or_default(&state.pending_requests);
        if !pending.is_empty() {
            log::info!("[IPC] Draining {} pending requests on disconnect", pending.len());
            pending.clear();
        }
    }

    Ok(())
}

fn handle_incoming(
    msg: &IncomingMessage,
    state: &Arc<IpcState>,
) {
    let diagnostics = &state.diagnostics;
    let commands = &state.commands;
    let notifications = &state.notifications;
    let ui_requests = &state.ui_requests;
    let status_bar_items = &state.status_bar_items;
    let output_lines = &state.output_lines;
    let decorations = &state.decorations;
    let pending_requests = &state.pending_requests;
    let webview_events = &state.webview_events;
    let terminal_events = &state.terminal_events;
    let debug_start_requests = &state.debug_start_requests;
    let workspace_edit_requests = &state.workspace_edit_requests;
    let tree_view_events = &state.tree_view_events;
    let show_text_document_requests = &state.show_text_document_requests;
    let scm_states = &state.scm_states;
    let comment_threads = &state.comment_threads;

    match msg.method.as_str() {
        // M6: LSP response correlation
        "lsp/response" => {
            if let Some(params) = &msg.params {
                let request_id = params.get("request_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let result = params.get("result").cloned().unwrap_or(serde_json::Value::Null);
                let mut store = lock_or_default(pending_requests);
                if let Some(sender) = store.remove(&request_id) {
                    let _ = sender.send(result);
                } else {
                    log::warn!("[IPC] No pending request for response id: {}", request_id);
                }
            }
        }
        "publishDiagnostics" => {
            if let Some(params) = &msg.params {
                let uri = params
                    .get("uri")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                if let Ok(mut diags) = serde_json::from_value::<Vec<Diagnostic>>(
                    params.get("diagnostics").cloned().unwrap_or_default(),
                ) {
                    for d in &mut diags {
                        if d.uri.is_none() {
                            d.uri = uri.clone();
                        }
                    }

                    const MAX_DIAGNOSTICS: usize = 1000;
                    let mut store = lock_or_default(diagnostics);
                    if let Some(ref u) = uri {
                        store.retain(|d| d.uri.as_deref() != Some(u));
                    }
                    let count = diags.len();
                    store.extend(diags);
                    if store.len() > MAX_DIAGNOSTICS {
                        let drain_count = store.len() - MAX_DIAGNOSTICS;
                        store.drain(..drain_count);
                    }
                    log::info!("[IPC] Received {} diagnostics for {:?}", count, uri);
                }
            }
        }
        "registeredCommands" => {
            if let Some(params) = &msg.params {
                if let Ok(cmds) = serde_json::from_value::<Vec<String>>(
                    params.get("commands").cloned().unwrap_or_default(),
                ) {
                    *lock_or_default(commands) = cmds;
                }
            }
        }
        "showMessage" => {
            if let Some(params) = &msg.params {
                let msg_type = params.get("type").and_then(|v| v.as_str()).unwrap_or("info").to_string();
                let message = params.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let mut store = lock_or_default(notifications);
                if store.len() >= 1000 { store.drain(..500); }
                store.push(Notification { msg_type, message });
            }
        }
        "showQuickPick" | "showInputBox" => {
            if let Some(params) = &msg.params {
                let request_id = params.get("requestId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let mut uir = lock_or_default(ui_requests);
                if uir.len() >= 100 { uir.drain(..50); }
                uir.push(UiRequest {
                    kind: msg.method.clone(),
                    request_id,
                    params: params.clone(),
                });
            }
        }
        "setStatusBarItem" => {
            if let Some(params) = &msg.params {
                if let Ok(item) = serde_json::from_value::<StatusBarItem>(params.clone()) {
                    let mut store = lock_or_default(status_bar_items);
                    store.retain(|i| i.id != item.id);
                    store.push(item);
                }
            }
        }
        "removeStatusBarItem" => {
            if let Some(params) = &msg.params {
                let id = params.get("id").and_then(|v| v.as_str()).unwrap_or("");
                lock_or_default(status_bar_items).retain(|i| i.id != id);
            }
        }
        "appendOutput" => {
            if let Some(params) = &msg.params {
                let channel = params.get("channel").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let text = params.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let mut store = lock_or_default(output_lines);
                store.push(OutputLine { channel, text });
                // Cap at 10k lines
                if store.len() > 10_000 {
                    let drain_count = store.len() - 10_000;
                    store.drain(..drain_count);
                }
            }
        }
        "setDecorations" => {
            if let Some(params) = &msg.params {
                if let Ok(dec) = serde_json::from_value::<TextDecoration>(params.clone()) {
                    const MAX_DECORATIONS: usize = 10_000;
                    let mut store = lock_or_default(decorations);
                    store.retain(|d| !(d.uri == dec.uri && d.decoration_type == dec.decoration_type));
                    store.push(dec);
                    if store.len() > MAX_DECORATIONS {
                        let drain_count = store.len() - MAX_DECORATIONS;
                        store.drain(..drain_count);
                    }
                }
            }
        }
        // Terminal events from Extension Host
        "terminal/create" => {
            if let Some(params) = &msg.params {
                let request_id = params.get("request_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let name = params.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());
                let cwd = params.get("cwd").and_then(|v| v.as_str()).map(|s| s.to_string());
                let shell = params.get("shell").and_then(|v| v.as_str()).map(|s| s.to_string());
                push_terminal_event(terminal_events, TerminalEvent { kind: "create".to_string(), request_id: Some(request_id), terminal_id: None, name, cwd, shell, data: None });
            }
        }
        "terminal/write" => {
            if let Some(params) = &msg.params {
                let terminal_id = params.get("terminal_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let data = params.get("data").and_then(|v| v.as_str()).unwrap_or("").to_string();
                push_terminal_event(terminal_events, TerminalEvent { kind: "write".to_string(), request_id: None, terminal_id: Some(terminal_id), name: None, cwd: None, shell: None, data: Some(data) });
            }
        }
        "terminal/show" => {
            if let Some(params) = &msg.params {
                let terminal_id = params.get("terminal_id").and_then(|v| v.as_str()).map(|s| s.to_string());
                push_terminal_event(terminal_events, TerminalEvent { kind: "show".to_string(), request_id: None, terminal_id, name: None, cwd: None, shell: None, data: None });
            }
        }
        "terminal/close" => {
            if let Some(params) = &msg.params {
                let terminal_id = params.get("terminal_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                push_terminal_event(terminal_events, TerminalEvent { kind: "close".to_string(), request_id: None, terminal_id: Some(terminal_id), name: None, cwd: None, shell: None, data: None });
            }
        }
        // M8b: WebView panel events from Extension Host
        "webview/create" => {
            if let Some(params) = &msg.params {
                let panel_id = params.get("panel_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let view_type = params.get("view_type").and_then(|v| v.as_str()).map(|s| s.to_string());
                let title = params.get("title").and_then(|v| v.as_str()).map(|s| s.to_string());
                let column = params.get("column").and_then(|v| v.as_u64()).and_then(|n| u32::try_from(n).ok());
                let enable_scripts = params.get("enable_scripts").and_then(|v| v.as_bool());
                push_webview_event(webview_events, WebviewPanelEvent { kind: "create".to_string(), panel_id, title, view_type, column, enable_scripts, html: None, message: None });
            }
        }
        "webview/setHtml" => {
            if let Some(params) = &msg.params {
                let panel_id = params.get("panel_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let html = params.get("html").and_then(|v| v.as_str()).map(|s| s.to_string());
                push_webview_event(webview_events, WebviewPanelEvent { kind: "setHtml".to_string(), panel_id, title: None, view_type: None, column: None, enable_scripts: None, html, message: None });
            }
        }
        "webview/postMessage" => {
            if let Some(params) = &msg.params {
                let panel_id = params.get("panel_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let message = params.get("message").cloned();
                push_webview_event(webview_events, WebviewPanelEvent { kind: "postMessage".to_string(), panel_id, title: None, view_type: None, column: None, enable_scripts: None, html: None, message });
            }
        }
        "webview/reveal" => {
            if let Some(params) = &msg.params {
                let panel_id = params.get("panel_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let column = params.get("column").and_then(|v| v.as_u64()).and_then(|n| u32::try_from(n).ok());
                push_webview_event(webview_events, WebviewPanelEvent { kind: "reveal".to_string(), panel_id, title: None, view_type: None, column, enable_scripts: None, html: None, message: None });
            }
        }
        "webview/close" => {
            if let Some(params) = &msg.params {
                let panel_id = params.get("panel_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                push_webview_event(webview_events, WebviewPanelEvent { kind: "close".to_string(), panel_id, title: None, view_type: None, column: None, enable_scripts: None, html: None, message: None });
            }
        }
        // WorkspaceEdit: Extension Host requests applying text edits across files.
        "workspace/applyEdit" => {
            if let Some(params) = &msg.params {
                let request_id = params.get("request_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let changes: Vec<WorkspaceFileEdit> = params
                    .get("changes")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .unwrap_or_default();
                let mut store = lock_or_default(workspace_edit_requests);
                if store.len() < MAX_WORKSPACE_EDIT_REQUESTS {
                    store.push(WorkspaceEditRequest { request_id, changes });
                }
            }
        }
        // DAP: Extension Host resolved the adapter executable and requests a session start.
        "debug/startSession" => {
            if let Some(params) = &msg.params {
                let session_id = params.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let adapter_cmd = params.get("adapter_cmd").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let adapter_args = params.get("adapter_args")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|s| s.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();
                let launch_config = params.get("launch_config").cloned().unwrap_or(serde_json::Value::Null);
                if !session_id.is_empty() && !adapter_cmd.is_empty() {
                    push_debug_start_request(debug_start_requests, DebugStartRequest { session_id, adapter_cmd, adapter_args, launch_config });
                }
            }
        }
        "treeView/register" | "treeView/update" | "treeView/unregister" | "treeView/reveal" => {
            if let Some(params) = &msg.params {
                let view_id = params.get("view_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if !view_id.is_empty() {
                    let event_type = msg.method.trim_start_matches("treeView/").to_string();
                    let mut guard = lock_or_default(tree_view_events);
                    if guard.len() < MAX_TREE_VIEW_EVENTS {
                        guard.push(TreeViewEvent { event_type, view_id });
                    }
                }
            }
        }
        "showTextDocument" => {
            if let Some(params) = &msg.params {
                if let Ok(req) = serde_json::from_value::<ShowTextDocumentRequest>(params.clone()) {
                    let mut store = lock_or_default(show_text_document_requests);
                    if store.len() < MAX_SHOW_TEXT_DOCUMENT {
                        store.push(req);
                    }
                }
            }
        }
        // SCM: Extension Host pushes updated source control state.
        "scm/update" => {
            if let Some(params) = &msg.params {
                if let Ok(sc) = serde_json::from_value::<ScmSourceControlState>(params.clone()) {
                    lock_or_default(scm_states).insert(sc.id.clone(), sc);
                }
            }
        }
        "scm/remove" => {
            if let Some(params) = &msg.params {
                let id = params.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if !id.is_empty() {
                    lock_or_default(scm_states).remove(id);
                }
            }
        }
        // Comments: Extension Host pushes comment thread state.
        "comments/threadUpdate" => {
            if let Some(params) = &msg.params {
                if let Ok(thread) = serde_json::from_value::<CommentThread>(params.clone()) {
                    lock_or_default(comment_threads).insert(thread.id.clone(), thread);
                }
            }
        }
        "comments/threadDelete" => {
            if let Some(params) = &msg.params {
                let id = params.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if !id.is_empty() {
                    lock_or_default(comment_threads).remove(id);
                }
            }
        }
        _ => {
            log::debug!("[IPC] Unknown message: {}", msg.method);
        }
    }
}
