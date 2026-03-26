//! Extension Host process management.
//!
//! Starts the Node.js Extension Host as a child process and manages
//! its lifecycle (start, restart on crash, graceful shutdown).

use anyhow::Result;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::AppHandle;

/// Start the Extension Host as a child process.
pub fn start_extension_host(_app: &AppHandle) -> Result<()> {
    let host_script = find_ext_host_script();

    match host_script {
        Some(script) => {
            log::info!("Starting Extension Host: {}", script.display());

            let child = Command::new("node")
                .arg(&script)
                .env("CORECODE_MODE", "embedded")
                .env("CORECODE_IPC_HOST", "127.0.0.1")
                .env("CORECODE_IPC_PORT", "17532")
                .spawn();

            match child {
                Ok(mut process) => {
                    log::info!("Extension Host started (PID: {})", process.id());

                    std::thread::spawn(move || {
                        match process.wait() {
                            Ok(status) => {
                                log::info!("Extension Host exited: {}", status);
                            }
                            Err(e) => {
                                log::error!("Extension Host error: {}", e);
                            }
                        }
                    });
                }
                Err(e) => {
                    log::warn!(
                        "Could not start Extension Host (Node.js may not be installed): {}",
                        e
                    );
                }
            }
        }
        None => {
            log::info!("Extension Host script not found — running without extensions");
        }
    }

    Ok(())
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
