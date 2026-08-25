//! Extension Host process management.
//!
//! Starts the Node.js Extension Host as a child process and manages
//! its lifecycle (start, restart on crash, graceful shutdown).
//!
//! # Single-Extension-Host limitation
//!
//! The current implementation stores the Extension Host PID and shutdown flag
//! in module-level statics (`EXT_HOST_PID`, `EXT_HOST_SHUTDOWN_REQUESTED`).
//! This means **at most one** Extension Host process can be tracked at a time.
//! If multiple `AppHandle` instances call `start_extension_host()` concurrently
//! the second call will overwrite the first process's PID, leaving the earlier
//! child process untracked and un-killable via `kill_extension_host()`.
//!
//! TODO: Refactor `EXT_HOST_PID` and `EXT_HOST_SHUTDOWN_REQUESTED` into
//! per-`AppHandle` state (e.g. a `HashMap<AppHandleId, ExtHostState>` or
//! state managed inside Tauri's managed app state) so that each `AppHandle`
//! owns its own PID and shutdown flag independently.

use anyhow::Result;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// PID of the **single** managed Extension Host child process (0 = none).
///
/// Limitation: this is a global — a second concurrent caller to
/// `start_extension_host()` will clobber a previous PID.
/// See the module-level "Single-Extension-Host limitation" docs.
static EXT_HOST_PID: AtomicU32 = AtomicU32::new(0);

/// Flag set by `kill_extension_host()` so the restart loop in
/// `start_extension_host()` knows the exit was intentional.
///
/// Same single-host limitation as `EXT_HOST_PID`.
static EXT_HOST_SHUTDOWN_REQUESTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Kill the Extension Host process if it is running.
pub fn kill_extension_host() {
    // Signal the restart loop that this is an intentional shutdown.
    EXT_HOST_SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
    let pid = EXT_HOST_PID.swap(0, Ordering::SeqCst);
    if pid != 0 {
        log::info!("Killing Extension Host (PID: {})", pid);
        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("taskkill")
                .args(["/F", "/PID", &pid.to_string()])
                .output();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let pid_i32 = pid as i32;
            if pid_i32 > 0 {
                unsafe {
                    libc::kill(pid_i32, libc::SIGTERM);
                }
            } else {
                log::error!(
                    "Refusing to send SIGTERM to PID {} (cast to {})",
                    pid,
                    pid_i32
                );
            }
        }
    }
}

/// Maximum number of restart attempts before giving up.
const MAX_RESTARTS: u32 = 5;

/// Generate a 64-character hex token from OS CSPRNG for IPC authentication.
pub fn generate_ipc_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("Failed to generate random bytes for IPC token");
    hex::encode(bytes)
}

/// Start the Extension Host as a child process.
///
/// **Blocking:** This function blocks the calling thread indefinitely.  It enters
/// a restart loop that calls `process.wait()` on the child Node process, so the
/// thread will not return until either the extension host exits cleanly / reaches
/// `MAX_RESTARTS`, or an intentional shutdown is requested.  Callers that cannot
/// tolerate blocking should spawn this on a dedicated thread or async task.
///
/// Automatically restarts on crash with exponential backoff.
pub fn start_extension_host(
    app: &AppHandle,
    ipc_port: u16,
    user_extensions_dir: &str,
    ipc_token: &str,
) -> Result<()> {
    let host_script = match find_ext_host_script(app) {
        Some(script) => script,
        None => {
            log::info!("Extension Host script not found — running without extensions");
            return Ok(());
        }
    };

    let mut restarts = 0u32;
    let mut delay = Duration::from_secs(1);

    loop {
        log::info!("Starting Extension Host: {}", host_script.display());
        let spawn_time = std::time::Instant::now();

        let child = Command::new("node")
            .arg(&host_script)
            .env("CORECODE_MODE", "embedded")
            .env("CORECODE_IPC_HOST", "127.0.0.1")
            .env("CORECODE_IPC_PORT", ipc_port.to_string())
            .env("CORECODE_IPC_TOKEN", ipc_token)
            .env("CORECODE_USER_EXTENSIONS", user_extensions_dir)
            .spawn();

        match child {
            Ok(mut process) => {
                let pid = process.id();
                EXT_HOST_PID.store(pid, Ordering::SeqCst);
                log::info!("Extension Host started (PID: {})", pid);

                match process.wait() {
                    Ok(status) => {
                        EXT_HOST_PID.store(0, Ordering::SeqCst);
                        // If shutdown was requested, this exit is intentional — do not restart.
                        if EXT_HOST_SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
                            log::info!("Extension Host stopped (intentional shutdown)");
                            return Ok(());
                        }
                        if status.success() {
                            log::info!("Extension Host exited normally");
                            return Ok(());
                        }
                        log::warn!("Extension Host crashed ({})", status);
                    }
                    Err(e) => {
                        log::error!("Extension Host wait error: {}", e);
                        // Force kill in case process is still running
                        let _ = process.kill();
                        let _ = process.wait();
                        // Clear the stale PID so kill_extension_host() won't act on a recycled PID
                        EXT_HOST_PID.store(0, Ordering::SeqCst);
                        if EXT_HOST_SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
                            return Ok(());
                        }
                    }
                }
            }
            Err(e) => {
                log::error!(
                    "Could not start Extension Host (Node.js may not be installed): {}",
                    e
                );
                return Err(anyhow::anyhow!(
                    "Failed to spawn Extension Host process: {}. \
                     Ensure Node.js is installed and on PATH.",
                    e
                ));
            }
        }

        // If the process ran for a reasonable time, it was probably a transient
        // issue — reset the crash counter so future restarts get full attempts.
        if spawn_time.elapsed() > Duration::from_secs(5) {
            restarts = 0;
            delay = Duration::from_secs(1);
        }

        restarts += 1;
        if restarts >= MAX_RESTARTS {
            log::error!("Extension Host crashed {} times, giving up", MAX_RESTARTS);
            return Err(anyhow::anyhow!(
                "Extension Host crashed {} consecutive times and will not be restarted",
                MAX_RESTARTS
            ));
        }

        log::info!(
            "Restarting Extension Host in {:?} (attempt {}/{})",
            delay,
            restarts,
            MAX_RESTARTS
        );
        std::thread::sleep(delay);
        delay = (delay * 2).min(Duration::from_secs(30));
    }
}

fn find_ext_host_script(app: &AppHandle) -> Option<PathBuf> {
    // 1. Explicit override — useful in dev/CI when bundled paths don't apply.
    if let Ok(env_path) = std::env::var("CORECODE_EXT_HOST_SCRIPT") {
        let p = PathBuf::from(env_path);
        if p.exists() {
            return Some(p);
        }
    }

    let res_dir = app.path().resource_dir().ok();
    let exe_dir = app.path().executable_dir().ok();

    let suffixes: &[&[&str]] = &[
        &["extension-host", "dist", "host.js"],
        &["extension-host", "src", "spike-ext-host.js"],
    ];

    for base in [res_dir.clone(), exe_dir.clone()].into_iter().flatten() {
        for suffix in suffixes {
            let mut candidate: PathBuf = base.clone();
            for part in *suffix {
                candidate.push(part);
            }
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    // 2. Dev-mode fallback: walk up from the executable directory looking for
    //    `src/extension-host/dist/host.js`. In `cargo tauri dev` the exe lives
    //    at `src/app/src-tauri/target/debug/<name>.exe`, so the repo root sits
    //    four levels up.
    if let Some(start) = exe_dir {
        let mut cur: PathBuf = start;
        for _ in 0..8 {
            let candidate = cur.join("src").join("extension-host").join("dist").join("host.js");
            if candidate.exists() {
                return Some(candidate);
            }
            if !cur.pop() {
                break;
            }
        }
    }

    None
}
