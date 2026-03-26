//! Extension Host process management.
//!
//! Starts the Node.js Extension Host as a child process and manages
//! its lifecycle (start, restart on crash, graceful shutdown).

use anyhow::Result;
use std::process::Command;
use tauri::AppHandle;

/// Start the Extension Host as a child process.
/// For M1, this is a basic implementation that spawns the process
/// and monitors it. Full IPC integration comes in M2.
pub fn start_extension_host(_app: &AppHandle) -> Result<()> {
    // Find the extension host script relative to the app
    let host_script = find_ext_host_script();

    match host_script {
        Some(script) => {
            log::info!("Starting Extension Host: {}", script);

            let child = Command::new("node")
                .arg(&script)
                .env("CORECODE_MODE", "embedded")
                .spawn();

            match child {
                Ok(mut process) => {
                    log::info!("Extension Host started (PID: {})", process.id());

                    // Wait for the process in the background
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

fn find_ext_host_script() -> Option<String> {
    let candidates = [
        "../../../extension-host/src/spike-ext-host.js",
        "../../extension-host/src/spike-ext-host.js",
        "../extension-host/src/spike-ext-host.js",
    ];

    for candidate in &candidates {
        let path = std::path::Path::new(candidate);
        if path.exists() {
            return Some(path.to_string_lossy().to_string());
        }
    }

    None
}
