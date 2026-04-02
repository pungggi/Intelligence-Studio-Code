# CoreCode Native Extension System — Implementation Roadmap

> **Status**: Planning
> **Created**: 2026-03-28

---

## Phases

Each phase is a shippable increment. Earlier phases do not depend on later ones.

---

## Phase 1 — WASM Host Foundation

**Goal:** A WASM extension can activate and deactivate. No language APIs yet.

### Deliverables

| Item | Detail |
|:-----|:-------|
| `wasmtime` dependency in `Cargo.toml` | Pin to a stable release; enable WASI preview2 |
| `src/app/src-tauri/src/wasm_host/manager.rs` | Shared `Engine`; load/unload extension directories |
| `src/app/src-tauri/src/wasm_host/instance.rs` | Per-extension `Store`; WIT linker setup |
| `wit/corecode.wit` | `lifecycle`, `workspace`, `ui` interfaces only |
| `crates/corecode-extension-api/` | Published crate: WIT bindings + `#[corecode::main]` macro |
| `extension_mgr.rs` routing | `detect_kind()` + hand-off to WASM manager |
| Example extension | `examples/hello-wasm/` — activates, logs "hello" to output channel |
| Tauri command `wasm_activate_all` | Called on startup; activates all WASM extensions |
| Capability enforcement | `workspace_read`, `network_fetch` denied if not in `corecode.toml` |
| Unit tests | `wasm_host` module: load invalid WASM, capability denied paths |

### Acceptance criteria
- `examples/hello-wasm` installs and "hello" appears in CoreCode output panel
- A WASM extension calling a denied capability returns `Err`, does not crash the host

---

## Phase 2 — Language Provider APIs

**Goal:** A WASM extension can provide completions, hover, diagnostics, and formatting.

### Deliverables

| Item | Detail |
|:-----|:-------|
| `language-provider` WIT interface | All 10 functions from `02-wit-api.md` |
| Host dispatcher in `api_impl.rs` | Route LSP-like calls to the correct extension instance |
| `router.rs` | Map language ID + URI → which extension handles it |
| Language ID claim in `corecode.toml` | `[languages] rust = true` claims Rust files |
| Example extension | `examples/simple-lsp/` — provides hard-coded completions and TODO diagnostics (subprocess spawning deferred until security model is validated; requires `subprocess_spawn = true` capability) |
| Tauri commands | `wasm_completions`, `wasm_hover`, `wasm_diagnostics`, `wasm_format` |
| Integration with editor gutter | Diagnostics from WASM extensions appear as inline markers |
| Debounce + async calls | Diagnostics called on save; completions called on trigger character |

### Acceptance criteria
- `examples/simple-lsp` provides completions that appear in the editor dropdown
- Diagnostics from a WASM extension render in the gutter with the same appearance
  as Node.js extension diagnostics

---

## Phase 3 — Grammar Provider

**Goal:** A WASM extension can supply a tree-sitter grammar and syntax highlighting.

### Deliverables

| Item | Detail |
|:-----|:-------|
| `grammar-provider` WIT interface | `grammar-wasm`, `highlights-query`, `injections-query` |
| Grammar registry in `wasm_host` | Receive grammar bytes; validate size/signature before passing to `highlighting.rs` |
| Dynamic grammar loading | `highlighting.rs` accepts runtime-loaded grammar bytes with compile-time timeout and memory limits |
| Grammar security | Enforce maximum grammar size, compile timeout, and capability check (`grammar_provider = true`) before loading |
| Example extension | `examples/grammar-toml/` — tree-sitter TOML grammar for `.toml` files |

### Acceptance criteria
- `.toml` files are highlighted using the grammar shipped in `examples/grammar-toml`
- Built-in grammars (JS, Rust) continue to work unchanged

---

## Phase 4 — Webview Panels

**Goal:** A WASM extension can open a custom HTML panel and exchange messages with it.

### Deliverables

| Item | Detail |
|:-----|:-------|
| `webview-provider` WIT interface | `get-html`, `on-message`, `on-close` |
| `webview-host` WIT import | `open-panel`, `post-to-webview`, `close-panel` |
| `wasm_host/webview.rs` | Panel registry; Tauri WebviewWindow lifecycle |
| `corecode-bridge.js` | Injected bridge; CoreCode variant |
| Tauri invoke handler `webview_message` | Routes postMessage to correct WASM extension; validates required fields, rejects oversized payloads, and rate-limits per panel |
| Capability guard | `webview_panels = true` required in `corecode.toml` |
| Example extension | `examples/webview-counter/` — HTML panel with a counter button |
| CSP policy | Strict CSP on webview windows; `script-src 'self'` only |
| Asset sidecar support | Host serves `webview/` directory with path traversal guard |

### Acceptance criteria
- `examples/webview-counter` opens a panel; clicking the button increments a counter
  maintained in Rust (WASM extension state), response reflected in the HTML
- Closing the panel calls `on-close`; re-opening calls `get-html` with saved state

---

## Phase 5 — Cross-Editor Build Toolchain

**Goal:** `cargo corecode build --target all` produces CoreCode + Zed + VS Code packages.

### Deliverables

| Item | Detail |
|:-----|:-------|
| `cargo-corecode` binary | Cargo subcommand; published separately |
| CoreCode packager | ZIP → `.ccext`; reads `corecode.toml` |
| Zed packager | Generates `extension.toml`, language dirs from grammar-provider output |
| VS Code adapter generator | Generates `package.json` + `dist/extension.js` adapter |
| `corecode-bridge.js` — VS Code variant | `acquireVsCodeApi()` implementation |
| `corecode-bridge.js` — Zed variant | Zed postMessage shim — **conditional on Zed adding webview support** (pending Zed roadmap confirmation; omit from Phase 5 if not available) |
| `cargo corecode check` | Compatibility matrix output for each target |
| Documentation | Developer guide: "Write once, publish everywhere" |
| Example | `examples/simple-lsp/` built for all three targets; manual test in each editor |

### Acceptance criteria
- The same `examples/simple-lsp` source produces a working extension in CoreCode, Zed, and VS Code
- `cargo corecode check` correctly reports that `webview-provider` is not supported in Zed

---

## Phase 6 — Marketplace and Discovery

**Goal:** Users can discover and install WASM extensions from the CoreCode marketplace.

### Deliverables

| Item | Detail |
|:-----|:-------|
| Marketplace schema extension | `corecode.toml` metadata indexed alongside VS Code extensions |
| `marketplace.rs` WASM support | Download and install `.ccext` packages |
| Extension type badge in UI | "Native" badge distinguishes WASM from Node.js extensions |
| Signature verification | `.ccext` packages signed; host verifies before installation |

---

## Dependencies between phases

```
Phase 1 (WASM Host)
  ├── Phase 2 (Language APIs)
  │     └── Phase 4 (Webview)
  │           └── Phase 5 (Toolchain) ← also depends on Phase 2
  │                 └── Phase 6 (Marketplace)
  └── Phase 3 (Grammar)
```

Phases 2 and 3 are independent of each other; both depend on Phase 1.
Phase 5 can begin in parallel with Phase 4 for the non-webview targets.

---

## What is explicitly out of scope

These will not be added to the WIT API in v0.x:

| Feature | Reason |
|:--------|:-------|
| Custom tree views / sidebar panels | Too UI-framework-specific; no Zed equivalent |
| Debugger (DAP) integration | DAP is complex; only VS Code has it; not in Zed |
| SCM provider | Tight VS Code coupling; no Zed equivalent |
| Terminal integration | PTY access from WASM is a large security surface |
| Extension-to-extension API | Adds host complexity; defer until adoption warrants it |
| Notebook support | VS Code-specific; out of Zed scope |

Extensions requiring these features continue to use the Node.js host.

---

## WIT API versioning and compatibility

The WIT interfaces (`wit/corecode.wit`) follow semantic versioning:

- **Major** version: breaking changes (removed/renamed functions, changed signatures)
- **Minor** version: additive changes (new optional exports, new imports)
- **Patch** version: documentation-only or comment changes

**Version declaration:** Extensions declare the WIT version they were built against in
`corecode.toml` under `[extension] wit_version = "0.2"`. The host (`wasm_host/manager.rs`)
checks this at activation and rejects extensions built against unsupported major versions.

**Migration path:** When a new major WIT version is released, the previous version is
supported for at least two release cycles. `cargo corecode check` reports compatibility
warnings for deprecated interfaces and errors for removed ones.

**Host-side enforcement:** `api_impl.rs` selects the appropriate linker bindings based on
the extension's declared WIT version. Extensions built against older minor versions receive
stub implementations for newly added imports (returning `Err("not available in this WIT version")`).
