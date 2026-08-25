//! CoreCode Frontend - Native GPU-accelerated code editor
//!
//! Entry point for the native frontend. Initializes:
//! 1. Window and GPU renderer (wgpu)
//! 2. Text buffer (Rope)
//! 3. IPC connection to Extension Host
//! 4. Tree-sitter for syntax highlighting

mod buffer;

use anyhow::Result;

fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    tracing::info!("CoreCode starting...");

    let buffer = buffer::TextBuffer::new();
    tracing::info!("Text buffer initialized ({} chars)", buffer.len_chars());

    // TODO M1: Initialize wgpu renderer
    // TODO M1: Connect to Extension Host via IPC
    // TODO M1: Start event loop

    tracing::info!("CoreCode ready (scaffold mode)");
    Ok(())
}
