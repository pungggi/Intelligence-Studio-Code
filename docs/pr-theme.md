# CoreCode — PR Theme: M1-M4 Full Editor Implementation

## What This PR Delivers

This pull request represents the complete implementation of CoreCode milestones M1 through M4, transforming the project from initial scaffolding (PRD + spike prototypes) into a functional hybrid code editor.

---

## The Architecture

CoreCode uses a **"Frankenstein" hybrid architecture** — native Rust performance with VS Code extension compatibility:

```
┌─────────────────────────────────────────────────────────┐
│                    Tauri v2 Shell                        │
│  ┌─────────────────┐    TCP IPC     ┌────────────────┐  │
│  │  Rust Backend    │◄════════════►│  Node.js Ext    │  │
│  │                  │ 127.0.0.1    │  Host           │  │
│  │  • Rope buffer   │ :17532       │                 │  │
│  │  • Tree-sitter   │ Length-      │  • VS Code API  │  │
│  │  • Undo stack    │ prefixed     │    shim          │  │
│  │  • Find engine   │ JSON frames  │  • Extension    │  │
│  │  • IPC bridge    │              │    loader       │  │
│  └────────┬─────────┘              │  • LSP proxy    │  │
│           │                        └────────────────┘  │
│           ▼                                             │
│  ┌──────────────────────────────────────────────────┐  │
│  │  HTML/CSS/JS Frontend                             │  │
│  │  • Editor canvas with syntax highlighting         │  │
│  │  • Command palette (Ctrl+Shift+P)                 │  │
│  │  • Find/Replace bar (Ctrl+F/H)                    │  │
│  │  • Diagnostics (underlines + gutter markers)      │  │
│  │  • Output panel                                   │  │
│  │  • Notification toasts                            │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘

### IPC Port Management

The IPC connection uses an **ephemeral port** selected at startup via `TcpListener::bind(("127.0.0.1", 0))` (see `find_free_port()` in `ipc_bridge.rs`). The assigned port is passed to the Extension Host process through the `CORECODE_IPC_PORT` environment variable. This eliminates hardcoded-port conflicts entirely:
- **No bind failures**: The OS assigns a guaranteed-free port.
- **No configuration needed**: Port selection is automatic on every launch.
- **Multi-instance safe**: Each CoreCode instance gets its own ephemeral port — no coordination or lockfiles required.

## Key Design Decisions

### Why Tauri + Rope + Tree-sitter?
- **Tauri v2** over Electron: No bundled Chromium, < 150MB RAM baseline
- **Rope** (ropey): O(log n) insert/delete, proven in Zed and Lapce
- **Tree-sitter**: Incremental parsing — only re-parses changed regions

### Why TCP over Unix Sockets?
- Cross-platform (Windows + macOS + Linux) with zero conditional compilation
- `127.0.0.1:17532` with length-prefixed JSON frames (4-byte LE header)
- Measured at 60µs round-trip in spike testing

### Why a VS Code API Shim?
- Run unmodified VS Code extensions without forking extHost
- Tiered implementation: critical APIs manually, rest KI-assisted
- Conformance testing against real VS Code behavior

## Commit History

| Commit | Milestone | Description |
|:-------|:----------|:------------|
| `3d49ccd` | Setup | Initial scaffold: PRD, architecture review, project structure |
| `61f7cfc` | M0 | Spike 1: wgpu text rendering prototype |
| `89edf4b` | M0 | Spike 2: IPC latency benchmark |
| `e0e1a4f` | M0 | Spike 3: Extension Host PoC |
| `f8d7d3d` | M0 | Spike 4: Tree-sitter integration |
| `c6ee8a5` | M1 | Integrated editor (Tauri + Rope + Tree-sitter) |
| `cef30bc` | M2 | IPC bridge, diagnostics, command palette, extension loading |
| `0fd8774` | M2 | Cross-platform TCP IPC |
| `c766fb2` | Review | First code review — all findings fixed |
| `d2b7a68` | M3 | Real extension integration + simple linter + full API shim |
| `6f56cd7` | Review | Second code review — all findings fixed |
| `a9fa720` | M4 | Undo/redo, selection, find/replace, more grammars, status bar, output |
| `6bb9f0e` | M4 | STATUS.md milestone tracking |

## Security Measures

- CSP headers: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`
- Path validation with `fs::canonicalize()` — prevents path traversal
- `realpathSync()` on extension mainPath before loading
- File size limit (50MB) prevents memory exhaustion
- IPC frame size limit (10MB) + zero-length frame rejection
- MAX_INSERT_SIZE (1MB) for text operations
- Mutex poison recovery via `lock_or_default()` helper

## Performance Characteristics (from M0 spikes)

| Metric | Measured | Target |
|:-------|:---------|:-------|
| wgpu frame time (1k lines) | < 16ms | < 16ms |
| IPC round-trip | 60µs (JSON) | < 1ms |
| Extension command RTT | 131µs avg | < 5ms |
| Tree-sitter initial parse (10k lines) | 37ms | < 50ms |
| Tree-sitter incremental re-parse | 1.4ms | < 1ms _(1.4ms measured; ~40% above target; async thread optimization planned)_ |
