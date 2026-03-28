# CoreCode Native Extension System — Architecture

> **Status**: Planning
> **Created**: 2026-03-28

---

## Overview: two hosts, one router

```
┌─────────────────────────────────────────────────────────┐
│                     CoreCode (Tauri)                     │
│                                                         │
│  Extension Loader (Rust)                                │
│       │                                                 │
│       ├── package.json detected ──► Node.js Host        │
│       │                              (existing, M1–M12) │
│       │                              VS Code API shim   │
│       │                                                 │
│       └── corecode.toml detected ──► WASM Host (new)   │
│                                       wasmtime          │
│                                       WIT API           │
│                                       webview bridge    │
└─────────────────────────────────────────────────────────┘
```

The extension loader in `extension_mgr.rs` already iterates installed extension directories.
The routing change is: if a directory contains `corecode.toml`, it is handed to the WASM host;
if it contains `package.json`, it is handed to the Node.js host as today.

---

## Extension package formats

### Node.js extension (unchanged)

```
my-ext/
  package.json          ← activates Node.js host
  dist/
    extension.js
```

### CoreCode native extension (new)

```
my-ext/
  corecode.toml         ← activates WASM host
  extension.wasm        ← compiled from Rust (wasm32-wasi)
  webview/              ← optional; bundled HTML/CSS/JS panels
    panel.html
    panel.js
    panel.css
```

`corecode.toml` minimal schema:

```toml
[extension]
id       = "my-publisher.my-ext"
name     = "My Extension"
version  = "0.1.0"
host     = "wasm"                  # always "wasm" for this host

[entry]
wasm     = "extension.wasm"

[capabilities]                      # declare-only; host enforces
workspace_read  = true
network_fetch   = false             # extension cannot open sockets
webview_panels  = true
```

---

## WASM host components

### Rust side (`src/app/src-tauri/src/wasm_host/`)

| Module | Responsibility |
|:-------|:--------------|
| `manager.rs` | Load/unload WASM extensions; owns `wasmtime::Engine` (one, shared) |
| `instance.rs` | Per-extension `wasmtime::Store` + WIT linker bindings |
| `api_impl.rs` | Host-side implementations of all WIT `import` functions |
| `webview.rs` | Webview panel lifecycle; bridges WASM ↔ Tauri webview |
| `router.rs` | Routes Tauri commands (`wasm_*`) to the correct extension instance |

### WIT interface layer (`wit/`)

All interfaces live in `wit/corecode.wit` and are compiled into Rust bindings via `wit-bindgen`
at build time. Extensions depend on the published `corecode-extension-api` crate which exposes
the same WIT definitions as a Rust library.

### Extension SDK (`crates/corecode-extension-api/`)

A small Rust crate published to crates.io (Apache 2.0). Extension authors add it as a dependency:

```toml
[dependencies]
corecode-extension-api = "0.1"
```

It provides:
- All WIT-generated types (`CompletionItem`, `Diagnostic`, `WebviewPanel`, …)
- The `#[corecode::main]` proc-macro that generates the WASM export boilerplate
- Helper types (`Position`, `Range`, `Uri`)

---

## Capability enforcement

Capabilities declared in `corecode.toml` are checked at activation time:

- `workspace_read = false` → host denies any file-read WIT call, returns `Err`
- `network_fetch = false` → `http_fetch` import is not linked; calling it traps
- `webview_panels = false` → `webview_create` returns `Err("not declared")`

This is implemented via conditional `wasmtime::Linker` binding at instance creation.
Extensions that call a function they did not declare in capabilities are hard-trapped
(WASM trap, not a soft error) so the failure is loud and auditable.

---

## Interaction with the existing Node.js host

The two hosts are completely independent processes:

```
Tauri main process
  ├── Node.js host subprocess   (TCP port, IPC token auth — existing)
  └── WASM host                 (in-process, same Rust binary — new)
```

WASM extensions run **in-process** inside the Tauri binary via `wasmtime`. They are sandboxed
by the WASM runtime; they cannot access host memory outside their linear memory allocation.

This means:
- WASM extensions have lower IPC overhead than Node.js extensions (no TCP round-trip)
- A crash in a WASM extension is caught by `wasmtime` and reported as an extension error,
  not a process crash
- The Node.js host subprocess is unaffected by WASM extension failures

---

## Extension discovery and routing

Changes to `extension_mgr.rs`:

```rust
pub enum ExtensionKind {
    NodeJs,   // has package.json
    Wasm,     // has corecode.toml
}

fn detect_kind(ext_dir: &Path) -> Option<ExtensionKind> {
    if ext_dir.join("corecode.toml").exists() {
        Some(ExtensionKind::Wasm)
    } else if ext_dir.join("package.json").exists() {
        Some(ExtensionKind::NodeJs)
    } else {
        None
    }
}
```

An extension directory containing both files is an error (logged and skipped).
