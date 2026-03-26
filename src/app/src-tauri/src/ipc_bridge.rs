//! IPC Bridge — Async communication with the Node.js Extension Host.
//!
//! Uses Unix Domain Sockets with length-prefixed JSON messages.
//! Runs on a dedicated Tokio runtime in a background thread.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::sync::mpsc;

const SOCKET_PATH: &str = "/tmp/corecode-ext-host.sock";

/// A diagnostic from the Extension Host (e.g., ESLint error).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
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
}

/// Messages received from the Extension Host.
#[derive(Debug, Deserialize)]
pub struct IncomingMessage {
    pub method: String,
    pub params: Option<serde_json::Value>,
}

/// Handle to the IPC bridge for sending messages.
#[derive(Clone)]
pub struct IpcHandle {
    sender: mpsc::Sender<OutgoingMessage>,
    diagnostics: Arc<Mutex<Vec<Diagnostic>>>,
    connected: Arc<Mutex<bool>>,
    commands: Arc<Mutex<Vec<String>>>,
}

impl IpcHandle {
    pub fn send(&self, msg: OutgoingMessage) {
        let _ = self.sender.try_send(msg);
    }

    pub fn get_diagnostics(&self) -> Vec<Diagnostic> {
        self.diagnostics.lock().unwrap().clone()
    }

    pub fn clear_diagnostics(&self) {
        self.diagnostics.lock().unwrap().clear();
    }

    pub fn is_connected(&self) -> bool {
        *self.connected.lock().unwrap()
    }

    pub fn get_commands(&self) -> Vec<String> {
        self.commands.lock().unwrap().clone()
    }
}

/// Start the IPC bridge. Returns a handle for sending messages.
/// The bridge runs in a background thread with its own Tokio runtime.
pub fn start_ipc_bridge() -> IpcHandle {
    let (tx, rx) = mpsc::channel::<OutgoingMessage>(256);
    let diagnostics = Arc::new(Mutex::new(Vec::new()));
    let connected = Arc::new(Mutex::new(false));
    let commands = Arc::new(Mutex::new(Vec::new()));

    let handle = IpcHandle {
        sender: tx,
        diagnostics: diagnostics.clone(),
        connected: connected.clone(),
        commands: commands.clone(),
    };

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("Failed to create Tokio runtime");

        rt.block_on(async move {
            ipc_loop(rx, diagnostics, connected, commands).await;
        });
    });

    handle
}

async fn ipc_loop(
    mut rx: mpsc::Receiver<OutgoingMessage>,
    diagnostics: Arc<Mutex<Vec<Diagnostic>>>,
    connected: Arc<Mutex<bool>>,
    commands: Arc<Mutex<Vec<String>>>,
) {
    loop {
        log::info!("[IPC] Connecting to Extension Host at {}...", SOCKET_PATH);

        match UnixStream::connect(SOCKET_PATH).await {
            Ok(stream) => {
                *connected.lock().unwrap() = true;
                log::info!("[IPC] Connected to Extension Host");

                if let Err(e) = handle_connection(stream, &mut rx, &diagnostics, &commands).await {
                    log::warn!("[IPC] Connection lost: {}", e);
                }

                *connected.lock().unwrap() = false;
            }
            Err(_) => {
                // Extension Host not ready yet, retry
            }
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
    }
}

async fn handle_connection(
    stream: UnixStream,
    rx: &mut mpsc::Receiver<OutgoingMessage>,
    diagnostics: &Arc<Mutex<Vec<Diagnostic>>>,
    commands: &Arc<Mutex<Vec<String>>>,
) -> Result<()> {
    let (mut reader, mut writer) = stream.into_split();

    // Spawn reader task
    let diag_clone = diagnostics.clone();
    let cmd_clone = commands.clone();
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
                            accumulated[..4].try_into().unwrap(),
                        ) as usize;

                        if accumulated.len() < 4 + frame_len {
                            break;
                        }

                        let payload = &accumulated[4..4 + frame_len];
                        if let Ok(msg) = serde_json::from_slice::<IncomingMessage>(payload) {
                            handle_incoming(&msg, &diag_clone, &cmd_clone);
                        }

                        accumulated = accumulated[4 + frame_len..].to_vec();
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
                        let json = serde_json::to_vec(&msg)?;
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
) {
    match msg.method.as_str() {
        "publishDiagnostics" => {
            if let Some(params) = &msg.params {
                if let Ok(diags) = serde_json::from_value::<Vec<Diagnostic>>(
                    params.get("diagnostics").cloned().unwrap_or_default(),
                ) {
                    *diagnostics.lock().unwrap() = diags;
                    log::info!("[IPC] Received {} diagnostics", diagnostics.lock().unwrap().len());
                }
            }
        }
        "registeredCommands" => {
            if let Some(params) = &msg.params {
                if let Ok(cmds) = serde_json::from_value::<Vec<String>>(
                    params.get("commands").cloned().unwrap_or_default(),
                ) {
                    *commands.lock().unwrap() = cmds;
                }
            }
        }
        _ => {
            log::debug!("[IPC] Unknown message: {}", msg.method);
        }
    }
}
