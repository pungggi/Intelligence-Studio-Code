//! Terminal PTY management.
//!
//! Spawns pseudo-terminal sessions using `portable-pty` (ConPTY on Windows,
//! Unix PTY on macOS/Linux). Each terminal session runs a shell process and
//! streams output back to the frontend via Tauri events.

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;
use tauri::{AppHandle, Emitter};

/// Counter for generating unique terminal IDs.
static NEXT_TERMINAL_ID: AtomicU32 = AtomicU32::new(1);

/// Payload emitted to the frontend when a terminal produces output.
#[derive(Clone, serde::Serialize)]
pub struct TerminalDataEvent {
    pub terminal_id: String,
    pub data: String,
}

/// Payload emitted to the frontend when a terminal process exits.
#[derive(Clone, serde::Serialize)]
pub struct TerminalExitEvent {
    pub terminal_id: String,
    pub exit_code: Option<i32>,
}

/// Info about an active terminal session.
#[derive(Clone, serde::Serialize)]
pub struct TerminalInfo {
    pub id: String,
    pub title: String,
}

/// Wrapper that makes `Box<dyn MasterPty>` safe to send across threads.
///
/// # Safety
/// All concrete portable-pty master implementations (`UnixMasterPty`,
/// `ConPtyMaster`, `WinPtyMaster`) hold only file-descriptor / OS-handle
/// types that are inherently Send.  The trait itself lacks a `Send` supertrait
/// only to preserve object-safety across crate versions; no implementation is
/// thread-hostile.
struct SendableMaster(Box<dyn portable_pty::MasterPty>);
// SAFETY: see struct doc above.
unsafe impl Send for SendableMaster {}

/// A live PTY session.
struct PtySession {
    /// Writer half of the PTY master — used to send keystrokes to the shell.
    writer: Box<dyn Write + Send>,
    /// Handle to the child process.
    child: Box<dyn portable_pty::Child + Send>,
    /// Master PTY — kept alive for resize support.
    master: SendableMaster,
    /// Human-readable title (shell name).
    title: String,
}

/// Manages multiple terminal sessions.
pub struct TerminalManager {
    sessions: HashMap<String, PtySession>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    /// Create a new terminal session, spawning a shell in the given directory.
    /// Returns the terminal ID. Output is pushed to the frontend via Tauri events.
    pub fn create(
        &mut self,
        app_handle: &AppHandle,
        cwd: Option<&str>,
        shell: Option<&str>,
        cols: u16,
        rows: u16,
    ) -> Result<String> {
        let id = format!("term-{}", NEXT_TERMINAL_ID.fetch_add(1, Ordering::SeqCst));

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("Failed to open PTY")?;

        let shell_prog = shell
            .map(|s| s.to_string())
            .unwrap_or_else(default_shell);
        let title = shell_prog.clone();

        let mut cmd = CommandBuilder::new(&shell_prog);
        if let Some(dir) = cwd {
            cmd.cwd(dir);
        }

        let child = pair.slave.spawn_command(cmd).context("Failed to spawn shell")?;
        // Drop the slave — we only need the master side.
        drop(pair.slave);

        let writer = pair.master.take_writer().context("Failed to get PTY writer")?;

        // Spawn a reader thread that streams PTY output to the frontend.
        let reader = pair.master.try_clone_reader().context("Failed to clone PTY reader")?;
        let term_id = id.clone();
        let handle = app_handle.clone();
        thread::Builder::new()
            .name(format!("pty-reader-{term_id}"))
            .spawn(move || {
                pty_reader_thread(reader, term_id, handle);
            })
            .context("Failed to spawn PTY reader thread")?;

        self.sessions.insert(
            id.clone(),
            PtySession {
                writer,
                child,
                master: SendableMaster(pair.master),
                title,
            },
        );

        Ok(id)
    }

    /// Write data (keystrokes) to a terminal's stdin.
    pub fn write(&mut self, terminal_id: &str, data: &[u8]) -> Result<()> {
        let session = self
            .sessions
            .get_mut(terminal_id)
            .context("Terminal not found")?;
        session.writer.write_all(data)?;
        session.writer.flush()?;
        Ok(())
    }

    /// Resize a terminal's PTY.
    pub fn resize(&mut self, terminal_id: &str, cols: u16, rows: u16) -> Result<()> {
        let session = self
            .sessions
            .get_mut(terminal_id)
            .context("Terminal not found")?;
        session.master.0.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    /// Close a terminal, killing the child process.
    pub fn close(&mut self, terminal_id: &str) -> Result<()> {
        if let Some(mut session) = self.sessions.remove(terminal_id) {
            // Drop writer to close stdin — this usually causes the shell to exit.
            drop(session.writer);
            // Kill the child process if still running.
            let _ = session.child.kill();
            let _ = session.child.wait();
            log::info!("[Terminal] Closed terminal {}", terminal_id);
        } else {
            log::warn!("[Terminal] close called for unknown terminal: {}", terminal_id);
        }
        Ok(())
    }

    /// List active terminals.
    pub fn list(&self) -> Vec<TerminalInfo> {
        self.sessions
            .iter()
            .map(|(id, s)| TerminalInfo {
                id: id.clone(),
                title: s.title.clone(),
            })
            .collect()
    }

    /// Close all terminals (used during shutdown).
    pub fn close_all(&mut self) {
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        for id in ids {
            let _ = self.close(&id);
        }
    }
}

/// Background thread that reads PTY output and emits it to the frontend.
fn pty_reader_thread(mut reader: Box<dyn Read + Send>, terminal_id: String, app: AppHandle) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => {
                // EOF — shell exited.
                let _ = app.emit(
                    "terminal-exit",
                    TerminalExitEvent {
                        terminal_id: terminal_id.clone(),
                        exit_code: None,
                    },
                );
                break;
            }
            Ok(n) => {
                // Convert to String (terminal output is mostly UTF-8, lossy is fine).
                let text = String::from_utf8_lossy(&buf[..n]).to_string();
                let _ = app.emit(
                    "terminal-data",
                    TerminalDataEvent {
                        terminal_id: terminal_id.clone(),
                        data: text,
                    },
                );
            }
            Err(e) => {
                log::error!("[Terminal] Read error on {}: {}", terminal_id, e);
                let _ = app.emit(
                    "terminal-exit",
                    TerminalExitEvent {
                        terminal_id: terminal_id.clone(),
                        exit_code: None,
                    },
                );
                break;
            }
        }
    }
}

/// Get the default shell for the current platform.
fn default_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}
