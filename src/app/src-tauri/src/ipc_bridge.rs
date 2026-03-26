//! IPC Bridge — Async communication with the Node.js Extension Host.
//!
//! Uses TCP on localhost with length-prefixed JSON messages.
//! Cross-platform (Linux, macOS, Windows).
//! Runs on a dedicated Tokio runtime in a background thread.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::mpsc;

const IPC_HOST: &str = "127.0.0.1";
const IPC_PORT: u16 = 17532;

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
    },
    #[serde(rename = "textDocument/didChange")]
    DidChange {
        uri: String,
        version: u32,
        text: String,
    },
    #[serde(rename = "textDocument/didClose")]
    DidClose { uri: String },
    #[serde(rename = "executeCommand")]
    ExecuteCommand { command: String, args: Vec<serde_json::Value> },
    #[serde(rename = "listCommands")]
    ListCommands,
    #[serde(rename = "quickPickResponse")]
    UiResponse {
        request_id: String,
        value: Option<serde_json::Value>,
    },
}

/// Messages received from the Extension Host.
#[derive(Debug, Deserialize)]
pub struct IncomingMessage {
    pub method: String,
    pub params: Option<serde_json::Value>,
}

/// Thread-safe helper: lock a mutex, returning a default on poison.
fn lock_or_default<T: Default>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| {
        log::debug!("[IPC] Recovering from poisoned mutex");
        poisoned.into_inner()
    })
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

/// Handle to the IPC bridge for sending messages.
#[derive(Clone)]
pub struct IpcHandle {
    sender: mpsc::Sender<OutgoingMessage>,
    diagnostics: Arc<Mutex<Vec<Diagnostic>>>,
    connected: Arc<Mutex<bool>>,
    commands: Arc<Mutex<Vec<String>>>,
    notifications: Arc<Mutex<Vec<Notification>>>,
    ui_requests: Arc<Mutex<Vec<UiRequest>>>,
}

impl IpcHandle {
    pub fn send(&self, msg: OutgoingMessage) {
        let _ = self.sender.try_send(msg);
    }

    pub fn get_diagnostics(&self) -> Vec<Diagnostic> {
        lock_or_default(&self.diagnostics).clone()
    }

    pub fn get_diagnostics_for_uri(&self, uri: &str) -> Vec<Diagnostic> {
        lock_or_default(&self.diagnostics)
            .iter()
            .filter(|d| d.uri.as_deref() == Some(uri))
            .cloned()
            .collect()
    }

    pub fn clear_diagnostics_for_uri(&self, uri: &str) {
        lock_or_default(&self.diagnostics).retain(|d| d.uri.as_deref() != Some(uri));
    }

    pub fn is_connected(&self) -> bool {
        *lock_or_default(&self.connected)
    }

    pub fn get_commands(&self) -> Vec<String> {
        lock_or_default(&self.commands).clone()
    }

    /// Drain all pending notifications (returns and clears them).
    pub fn drain_notifications(&self) -> Vec<Notification> {
        let mut store = lock_or_default(&self.notifications);
        std::mem::take(&mut *store)
    }

    /// Drain all pending UI requests (QuickPick/InputBox).
    pub fn drain_ui_requests(&self) -> Vec<UiRequest> {
        let mut store = lock_or_default(&self.ui_requests);
        std::mem::take(&mut *store)
    }
}

/// Start the IPC bridge. Returns a handle for sending messages.
/// The bridge runs in a background thread with its own Tokio runtime.
pub fn start_ipc_bridge() -> IpcHandle {
    let (tx, rx) = mpsc::channel::<OutgoingMessage>(256);
    let diagnostics = Arc::new(Mutex::new(Vec::new()));
    let connected = Arc::new(Mutex::new(false));
    let commands = Arc::new(Mutex::new(Vec::new()));
    let notifications = Arc::new(Mutex::new(Vec::new()));
    let ui_requests = Arc::new(Mutex::new(Vec::new()));

    let handle = IpcHandle {
        sender: tx,
        diagnostics: diagnostics.clone(),
        connected: connected.clone(),
        commands: commands.clone(),
        notifications: notifications.clone(),
        ui_requests: ui_requests.clone(),
    };

    std::thread::Builder::new()
        .name("ipc-bridge".to_string())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("Failed to create Tokio runtime");

            rt.block_on(async move {
                ipc_loop(rx, diagnostics, connected, commands, notifications, ui_requests).await;
            });
        })
        .expect("Failed to spawn IPC bridge thread");

    handle
}

async fn ipc_loop(
    mut rx: mpsc::Receiver<OutgoingMessage>,
    diagnostics: Arc<Mutex<Vec<Diagnostic>>>,
    connected: Arc<Mutex<bool>>,
    commands: Arc<Mutex<Vec<String>>>,
    notifications: Arc<Mutex<Vec<Notification>>>,
    ui_requests: Arc<Mutex<Vec<UiRequest>>>,
) {
    let addr = format!("{}:{}", IPC_HOST, IPC_PORT);
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
                *lock_or_default(&connected) = true;
                log::info!("[IPC] Connected to Extension Host at {}", addr);

                // Reset backoff on successful connection
                retry_count = 0;
                delay_ms = INITIAL_RETRY_DELAY_MS;

                if let Err(e) = handle_connection(stream, &mut rx, &diagnostics, &commands, &notifications, &ui_requests).await {
                    log::warn!("[IPC] Connection lost: {}", e);
                }

                *lock_or_default(&connected) = false;
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
    rx: &mut mpsc::Receiver<OutgoingMessage>,
    diagnostics: &Arc<Mutex<Vec<Diagnostic>>>,
    commands: &Arc<Mutex<Vec<String>>>,
    notifications: &Arc<Mutex<Vec<Notification>>>,
    ui_requests: &Arc<Mutex<Vec<UiRequest>>>,
) -> Result<()> {
    let (mut reader, mut writer) = stream.into_split();

    // Spawn reader task
    let diag_clone = diagnostics.clone();
    let cmd_clone = commands.clone();
    let notif_clone = notifications.clone();
    let ui_clone = ui_requests.clone();
    let mut read_task = tokio::spawn(async move {
        let mut buf = vec![0u8; 65536];
        let mut accumulated = Vec::new();

        loop {
            match reader.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
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
                            Ok(msg) => handle_incoming(&msg, &diag_clone, &cmd_clone, &notif_clone, &ui_clone),
                            Err(e) => log::warn!("[IPC] Malformed message: {}", e),
                        }

                        accumulated = accumulated[4 + frame_len..].to_vec();
                    }

                    // Guard against unbounded accumulation from incomplete frames
                    if accumulated.len() > MAX_FRAME_SIZE + 4 {
                        log::error!("[IPC] Accumulated buffer too large, dropping connection");
                        return;
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
                    }
                    None => break,
                }
            }
            _ = &mut read_task => {
                break;
            }
        }
    }

    Ok(())
}

fn handle_incoming(
    msg: &IncomingMessage,
    diagnostics: &Arc<Mutex<Vec<Diagnostic>>>,
    commands: &Arc<Mutex<Vec<String>>>,
    notifications: &Arc<Mutex<Vec<Notification>>>,
    ui_requests: &Arc<Mutex<Vec<UiRequest>>>,
) {
    match msg.method.as_str() {
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

                    let mut store = lock_or_default(diagnostics);
                    if let Some(ref u) = uri {
                        store.retain(|d| d.uri.as_deref() != Some(u));
                    }
                    let count = diags.len();
                    store.extend(diags);
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
                lock_or_default(notifications).push(Notification { msg_type, message });
            }
        }
        "showQuickPick" | "showInputBox" => {
            if let Some(params) = &msg.params {
                let request_id = params.get("requestId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                lock_or_default(ui_requests).push(UiRequest {
                    kind: msg.method.clone(),
                    request_id,
                    params: params.clone(),
                });
            }
        }
        _ => {
            log::debug!("[IPC] Unknown message: {}", msg.method);
        }
    }
}
