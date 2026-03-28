# WASM Extension Host — Implementation Index

> **Branch**: `feature/wasm-extension-host-impl`
> **Created**: 2026-03-28

Each document is a self-contained implementation guide for one phase.
Start with Phase 1; later phases reference the structures introduced earlier.

| Document | Phase | Depends on |
|:---------|:------|:-----------|
| [phase-1-wasm-host.md](phase-1-wasm-host.md) | WASM Host Foundation | — |
| [phase-2-language-apis.md](phase-2-language-apis.md) | Language Provider APIs | Phase 1 |
| [phase-3-grammar.md](phase-3-grammar.md) | Grammar Provider | Phase 1 |
| [phase-4-webview.md](phase-4-webview.md) | Webview Panels | Phase 1 |
| [phase-5-toolchain.md](phase-5-toolchain.md) | Cross-Editor Toolchain | Phase 1–4 |

## Quick orientation

The WASM host lives entirely inside the existing Tauri binary (`corecode-app`).
It does **not** start a subprocess; `wasmtime` runs in-process.

Key insertion points in the current codebase:

| Current file | What changes |
|:-------------|:-------------|
| `Cargo.toml` | Add `wasmtime`, `wit-bindgen`, `toml` |
| `lib.rs` → `AppState` | Add `wasm_host: wasm_host::WasmHostManager` field |
| `extension_mgr.rs` | Add `detect_kind()`, route WASM extensions to new manager |
| `highlighting.rs` | Add `load_dynamic_grammar()` (Phase 3 only) |
| `lib.rs` (Tauri commands) | Add `wasm_completions`, `wasm_hover`, `wasm_diagnostics`, `webview_message` |
