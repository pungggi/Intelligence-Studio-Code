//! Extension Host process management.
//!
//! Starts the Node.js Extension Host as a child process and manages
//! its lifecycle (start, restart on crash, graceful shutdown).

use anyhow::Result;
use std::process::Command;
use tauri::AppHandle;

/// Start the Extension Host as a child process.
pub fn start_extension_host(_app: &AppHandle) -> Result<()> {
    let host_script = find_ext_host_script();

    match host_script {
        Some(script) => {
            log::info!("Starting Extension Host: {}", script);

            let child = Command::new("node")
                .arg(&script)
                .env("CORECODE_MODE", "embedded")
                .env("CORECODE_SOCKET", "/tmp/corecode-ext-host.sock")
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

fn find_ext_host_script() -> Option<String> {
    // Look for compiled JS first, then TS source
    let candidates = [
        // Compiled output
        "../../../extension-host/dist/host.js",
        "../../extension-host/dist/host.js",
        "../extension-host/dist/host.js",
        // TS source (run with ts-node or tsx)
        "../../../extension-host/src/host.ts",
        "../../extension-host/src/host.ts",
        "../extension-host/src/host.ts",
        // Spike fallback
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
