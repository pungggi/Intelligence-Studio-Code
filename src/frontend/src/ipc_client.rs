//! IPC client for communication with the Node.js Extension Host.
//!
//! Uses Unix Domain Sockets (Linux/macOS) or Named Pipes (Windows)
//! with FlatBuffers serialization for zero-copy message passing.

use anyhow::Result;
use tokio::net::UnixStream;

pub struct IpcClient {
    // TODO M1: Unix socket connection
    // TODO M1: Message send/receive loop
    // TODO M1: FlatBuffers serialization
}

impl IpcClient {
    /// Connect to the Extension Host process.
    pub async fn connect(socket_path: &str) -> Result<Self> {
        let _stream = UnixStream::connect(socket_path).await?;
        tracing::info!("Connected to Extension Host at {}", socket_path);
        Ok(Self {})
    }

    /// Send a text document change delta to the Extension Host.
    pub async fn send_text_change(&self, _uri: &str, _version: u32, _changes: &[u8]) -> Result<()> {
        // TODO M1: Serialize with FlatBuffers and send
        Ok(())
    }

    /// Request diagnostics for a document.
    pub async fn request_diagnostics(&self, _uri: &str) -> Result<Vec<u8>> {
        // TODO M2: Request and deserialize diagnostics
        Ok(vec![])
    }
}
