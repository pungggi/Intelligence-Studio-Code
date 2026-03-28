//! DAP (Debug Adapter Protocol) session manager.
//!
//! Each debug session is backed by a child process (the debug adapter).
//! DAP uses Content-Length framing over stdin/stdout of the adapter.
//! Framing: "Content-Length: N\r\n\r\n{json}"

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

/// An event or response received from a Debug Adapter, forwarded to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugEvent {
    pub session_id: String,
    /// DAP message type: "event", "response", or "error".
    #[serde(rename = "type")]
    pub msg_type: String,
    pub seq: u64,
    /// Event name (e.g. "stopped", "output", "terminated") — only for type="event".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    /// Command name — only for type="response".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// The seq of the request this response corresponds to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_seq: Option<u64>,
    /// Whether the request succeeded — only for type="response".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub success: Option<bool>,
    /// Payload body (varies by event/command).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<Value>,
}

struct DebugSessionData {
    stdin_tx: std::sync::mpsc::SyncSender<Vec<u8>>,
    events: Arc<Mutex<Vec<DebugEvent>>>,
    seq_counter: u64,
    /// Held so the process is not reaped until stop_session.
    child: Child,
}

pub struct DebugManager {
    sessions: Mutex<HashMap<String, DebugSessionData>>,
}

impl DebugManager {
    pub fn new() -> Self {
        Self { sessions: Mutex::new(HashMap::new()) }
    }

    /// Spawn a debug adapter process and start a DAP session.
    ///
    /// # Security
    /// `adapter_cmd` must be an absolute path.  Bare command names (no path
    /// separator) are rejected to prevent `$PATH`-based command injection from
    /// a malicious extension.  The path is resolved with `canonicalize` before
    /// spawning, which eliminates `..` components and follows symlinks.
    pub fn start_session(
        &self,
        session_id: String,
        adapter_cmd: String,
        adapter_args: Vec<String>,
    ) -> Result<(), String> {
        // 0. Check session uniqueness before spawning anything.
        {
            let sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
            if sessions.contains_key(&session_id) {
                return Err(format!("Debug session '{}' already exists", session_id));
            }
        }

        // 1. Reject bare names — require an absolute path.
        let cmd_path = std::path::Path::new(&adapter_cmd);
        if !cmd_path.is_absolute() {
            return Err(format!(
                "Debug adapter command must be an absolute path (got '{}').  \
                 Bare command names are not allowed to prevent PATH-based injection.",
                adapter_cmd
            ));
        }

        // 2. Resolve symlinks / normalise the path.
        let canonical = std::fs::canonicalize(cmd_path)
            .map_err(|e| format!("Cannot resolve debug adapter path '{}': {}", adapter_cmd, e))?;

        // 3. Must be a regular file — not a directory or device node.
        if !canonical.is_file() {
            return Err(format!(
                "Debug adapter '{}' is not a regular file",
                canonical.display()
            ));
        }

        // 4. Restrict to the user home directory so extensions cannot invoke
        //    arbitrary system binaries (e.g. /bin/sh, C:\Windows\cmd.exe).
        //    Debug adapters installed by extensions always live under the user
        //    home directory on all supported platforms.
        let home = dirs::home_dir().ok_or_else(|| {
            "could not determine user home directory — debug adapter restricted".to_string()
        })?;
        let home_canonical = std::fs::canonicalize(&home).unwrap_or(home);
        if !canonical.starts_with(&home_canonical) {
            return Err(format!(
                "Debug adapter '{}' is not within the user home directory",
                canonical.display()
            ));
        }

        let canonical_str = canonical.to_string_lossy().to_string();
        let mut child = Command::new(&canonical_str)
            .args(&adapter_args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to spawn debug adapter '{}': {}", canonical_str, e))?;

        let stdin = child.stdin.take().ok_or("No stdin on debug adapter")?;
        let stdout = child.stdout.take().ok_or("No stdout on debug adapter")?;

        let events: Arc<Mutex<Vec<DebugEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_reader = events.clone();
        let sid_reader = session_id.clone();

        // Background stdin writer thread — receives pre-framed bytes and writes to adapter.
        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(64);
        thread::Builder::new()
            .name(format!("dap-writer-{}", session_id))
            .spawn(move || {
                let mut stdin = stdin;
                while let Ok(bytes) = rx.recv() {
                    if stdin.write_all(&bytes).is_err() {
                        break;
                    }
                    if stdin.flush().is_err() {
                        break;
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        // Background stdout reader thread — parses Content-Length frames from the adapter.
        thread::Builder::new()
            .name(format!("dap-reader-{}", session_id))
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                loop {
                    // Parse DAP headers until blank line.
                    let mut content_length: Option<usize> = None;
                    loop {
                        let mut line = String::new();
                        match reader.read_line(&mut line) {
                            Ok(0) | Err(_) => return,
                            Ok(_) => {}
                        }
                        let trimmed = line.trim_end_matches(|c: char| c == '\r' || c == '\n').trim();
                        if trimmed.is_empty() {
                            break;
                        }
                        if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
                            content_length = rest.trim().parse::<usize>().ok();
                        }
                    }

                    let len = match content_length {
                        Some(n) if n > 0 && n <= 10_000_000 => n,
                        _ => {
                            log::warn!("[DAP:{}] Bad or missing Content-Length, skipping", sid_reader);
                            continue;
                        }
                    };

                    let mut body = vec![0u8; len];
                    if reader.read_exact(&mut body).is_err() {
                        return;
                    }

                    match serde_json::from_slice::<Value>(&body) {
                        Ok(v) => {
                            let evt = DebugEvent {
                                session_id: sid_reader.clone(),
                                msg_type: v.get("type").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                                seq: v.get("seq").and_then(|s| s.as_u64()).unwrap_or(0),
                                event: v.get("event").and_then(|e| e.as_str()).map(|s| s.to_string()),
                                command: v.get("command").and_then(|c| c.as_str()).map(|s| s.to_string()),
                                request_seq: v.get("request_seq").and_then(|s| s.as_u64()),
                                success: v.get("success").and_then(|s| s.as_bool()),
                                body: v.get("body").cloned(),
                            };
                            let mut store = events_reader.lock().unwrap_or_else(|p| p.into_inner());
                            if store.len() < 1000 {
                                store.push(evt);
                            } else {
                                log::warn!(
                                    "[DAP:{}] Event buffer full (1000 events), dropping event type '{}'",
                                    sid_reader,
                                    evt.msg_type
                                );
                            }
                        }
                        Err(e) => log::warn!("[DAP:{}] Malformed message: {}", sid_reader, e),
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        let mut sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        sessions.insert(session_id, DebugSessionData { stdin_tx: tx, events, seq_counter: 0, child });
        Ok(())
    }

    /// Send a DAP request to the adapter. Returns the request seq number.
    pub fn send_request(
        &self,
        session_id: &str,
        command: &str,
        arguments: Value,
    ) -> Result<u64, String> {
        let mut sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        let sess = sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Unknown debug session: {}", session_id))?;

        sess.seq_counter += 1;
        let seq = sess.seq_counter;

        let msg = serde_json::json!({
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": arguments,
        });
        let json = serde_json::to_string(&msg).map_err(|e| e.to_string())?;
        let frame = format!("Content-Length: {}\r\n\r\n{}", json.len(), json);

        sess.stdin_tx
            .try_send(frame.into_bytes())
            .map_err(|e| format!("Failed to send DAP request: {}", e))?;

        Ok(seq)
    }

    /// Drain all pending events for a session (returns and clears them).
    pub fn drain_events(&self, session_id: &str) -> Vec<DebugEvent> {
        let sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(sess) = sessions.get(session_id) {
            let mut store = sess.events.lock().unwrap_or_else(|p| p.into_inner());
            std::mem::take(&mut *store)
        } else {
            vec![]
        }
    }

    /// Stop a debug session and kill the adapter process.
    pub fn stop_session(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(mut sess) = sessions.remove(session_id) {
            let _ = sess.child.kill();
            let _ = sess.child.wait();
            log::info!("[DAP] Session '{}' stopped", session_id);
            Ok(())
        } else {
            Err(format!("Unknown debug session: {}", session_id))
        }
    }

    pub fn has_session(&self, session_id: &str) -> bool {
        self.sessions.lock().unwrap_or_else(|p| p.into_inner()).contains_key(session_id)
    }

    pub fn list_sessions(&self) -> Vec<String> {
        self.sessions.lock().unwrap_or_else(|p| p.into_inner()).keys().cloned().collect()
    }
}
