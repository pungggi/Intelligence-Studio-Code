# IPC Bridge - FlatBuffers Protocol

## Overview

The IPC bridge connects the native Rust frontend with the Node.js Extension Host
using FlatBuffers for zero-copy serialization over Unix Domain Sockets.

## Schema

`schemas/messages.fbs` defines the binary protocol. To regenerate code:

```bash
# Generate Rust code
flatc --rust -o ../frontend/src/generated/ schemas/messages.fbs

# Generate TypeScript code
flatc --ts -o ../extension-host/src/generated/ schemas/messages.fbs
```

## Message Flow

```
Frontend (Rust)                    Extension Host (Node.js)
      │                                    │
      │── TextDocumentDidOpen ────────────►│
      │── TextDocumentDidChange ──────────►│
      │                                    │
      │◄── PublishDiagnostics ─────────────│
      │◄── ShowNotification ───────────────│
      │                                    │
      │── ExecuteCommand ─────────────────►│
      │◄── CompletionResponse ─────────────│
```

## Design Decisions

- **FlatBuffers over JSON-RPC**: Zero-copy deserialization reduces IPC latency from ~2ms to ~0.1ms per message.
- **Message batching**: Text changes are batched in 5ms windows to reduce IPC overhead during rapid typing.
- **Envelope pattern**: Every message is wrapped in a `Message` envelope with an ID for request/response correlation.
