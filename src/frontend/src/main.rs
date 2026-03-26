//! CoreCode Frontend - Native GPU-accelerated code editor
//!
//! Entry point for the native frontend. Initializes:
//! 1. Window and GPU renderer (wgpu)
//! 2. Text buffer (Rope)
//! 3. IPC connection to Extension Host
//! 4. Tree-sitter for syntax highlighting

mod buffer;
mod renderer;
mod ipc_client;

use anyhow::Result;
use tracing_subscriber;

fn main() -> Result<()> {
    tracing_subscriber::init();
    tracing::info!("CoreCode starting...");

    let buffer = buffer::TextBuffer::new();
    tracing::info!("Text buffer initialized");

    // TODO M1: Initialize wgpu renderer
    // TODO M1: Connect to Extension Host via IPC
    // TODO M1: Start event loop

    tracing::info!("CoreCode ready (scaffold mode)");
    Ok(())
}
