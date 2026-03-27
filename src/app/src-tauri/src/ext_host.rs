//! Extension Host process management.
//!
//! Starts the Node.js Extension Host as a child process and manages
//! its lifecycle (start, restart on crash, graceful shutdown).

use anyhow::Result;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;
use tauri::AppHandle;

/// Shared child process PID so it can be killed on app exit.
static EXT_HOST_PID: AtomicU32 = AtomicU32::new(0);

/// Kill the Extension Host process if it is running.
pub fn kill_extension_host() {
    let pid = EXT_HOST_PID.swap(0, Ordering::SeqCst);
    if pid != 0 {
        log::info!("Killing Extension Host (PID: {})", pid);
        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).output();
        }
        #[cfg(not(target_os = "windows"))]
        {
            unsafe { libc::kill(pid as i32, libc::SIGTERM); }
        }
    }
}

/// Maximum number of restart attempts before giving up.
const MAX_RESTARTS: u32 = 5;

/// Start the Extension Host as a child process.
/// Automatically restarts on crash with exponential backoff.
pub fn start_extension_host(_app: &AppHandle, ipc_port: u16) -> Result<()> {
    let host_script = match find_ext_host_script() {
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

        let child = Command::new("node")
            .arg(&host_script)
            .env("CORECODE_MODE", "embedded")
            .env("CORECODE_IPC_HOST", "127.0.0.1")
            .env("CORECODE_IPC_PORT", ipc_port.to_string())
            .spawn();

        match child {
            Ok(mut process) => {
                let pid = process.id();
                EXT_HOST_PID.store(pid, Ordering::SeqCst);
                log::info!("Extension Host started (PID: {})", pid);

                match process.wait() {
                    Ok(status) => {
                        EXT_HOST_PID.store(0, Ordering::SeqCst);
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
                    }
                }
            }
            Err(e) => {
                log::warn!(
                    "Could not start Extension Host (Node.js may not be installed): {}",
                    e
                );
                return Ok(());
            }
        }

        restarts += 1;
        if restarts >= MAX_RESTARTS {
            log::error!(
                "Extension Host crashed {} times, giving up",
                MAX_RESTARTS
            );
            return Ok(());
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

fn find_ext_host_script() -> Option<PathBuf> {
    // Build candidate paths using std::path for cross-platform separators
    let candidates: Vec<PathBuf> = [
        // Compiled output
        ["extension-host", "dist", "host.js"],
        // Spike fallback
        ["extension-host", "src", "spike-ext-host.js"],
    ]
    .iter()
    .flat_map(|parts| {
        // Try multiple parent traversals
        (1..=3).map(move |depth| {
            let mut path = PathBuf::new();
            for _ in 0..depth {
                path.push("..");
            }
            for part in parts {
                path.push(part);
            }
            path
        })
    })
    .collect();

    for candidate in &candidates {
        if candidate.exists() {
            return Some(candidate.clone());
        }
    }

    None
}
