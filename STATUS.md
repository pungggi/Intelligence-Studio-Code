# CoreCode — Project Status

**Last updated:** 2026-08-23

---

## Milestone Overview

| Milestone | Description | Status |
|:----------|:------------|:-------|
| **M0: Technology Spike** | wgpu rendering, IPC latency, Extension Host PoC, Tree-sitter | **Done** |
| **M1: Hello World** | Tauri shell, Rope text buffer, Tree-sitter highlighting, basic editing | **Done** |
| **M2: First Extension** | IPC bridge, Extension Host, diagnostics, command palette, notifications | **Done** |
| **M3: Real Extension Integration** | VS Code API shim, simple linter, QuickPick/InputBox, extension config | **Done** |
| **M4: MVP Beta** | Undo/redo, selection, clipboard, find/replace, more grammars, status bar, output channels | **Done** |
| **M5: Multi-file Editor** | Tabs, file explorer, TreeView API, workspace-tagged IPC, HTML/CSS/MD grammars, minimap | **Done** |
| **M6: Language Intelligence** | LSP client, completions, hover, go-to-definition, code actions, formatting | **Done** |
| **M7: Native Rendering** | Canvas2D text rendering, virtualized content, virtual scroll, large file support | **Done** |
| **M8: Full Platform** | Marketplace, settings UI, WebView, terminal, multi-workspace, themes, ARIA | **Done** (2026-08-24) |
| **M9: Debug Adapter Protocol** | DAP sessions, debug sidebar, breakpoints, debug toolbar/console | **Done** |
| **M10: Extension Compatibility Expansion** | `workspace.applyEdit`, `createTerminal`, inlay hints, TreeView panel | **Done** |
| **M11: Multi-cursor + API Trio** | Multi-cursor editing, rename (F2), `showTextDocument`, document highlights | **Done** |
| **M12: Security + Tasks + SCM + Diff** | IPC auth token, path traversal fixes, `vscode.tasks`, git SCM panel, diff viewer | **Done** |

**Parallel track — WASM Extension Host** (branch `feature/wasm-extension-host-impl`, see [docs/plans/impl/00-index.md](docs/plans/impl/00-index.md)):

| Phase | Scope | Status |
|:------|:------|:-------|
| **Phase 1** | In-process wasmtime host, WIT bindings, fuel + epoch sandboxing | **Done** (2026-03-28) |
| **Phase 2** | Language provider APIs, `simple-lsp` example | **Done** (2026-03-29) |
| **Phase 2.5** | Grammar registry, manifest hardening, `cargo-corecode` CLI, manual test suite | **Done** (2026-04-02) |
| **Phase 3** | Unified `lang_*` dispatch (format/range-format, rename, code actions, workspace symbols, folding) | **Done** (2026-05-25) |
| **Phase 4** | Tier-1 LSP providers: typeDefinition, implementation, selectionRange, documentLinks, semanticTokens (+ frontend wiring, delta refresh) | **Done** (2026-05-26) |
| **Phase 5** | Cross-editor toolchain (`.ccext` / Zed `.zip` / `.vsix`) | **Done** (2026-08-23) — `new`/`build`/`check`/`publish` |
| **Phase 6** | Marketplace & discovery (registry server, `.ccext` install, Native badge) | **Mostly done** (2026-08-24) — ed25519 signature verification pending, see [phase-6-marketplace.md](docs/plans/impl/phase-6-marketplace.md) |

---

## M0: Technology Spike — COMPLETE

All 4 spikes passed validation:

- **Spike 1 — wgpu Text Rendering:** < 16ms frame time for 1,000 lines
- **Spike 2 — IPC Latency:** 45us binary / 60us JSON round-trip (well under 1ms budget)
- **Spike 3 — Extension Host:** Extensions load, activate, commands callable (avg 131us RTT)
- **Spike 4 — Tree-sitter:** 37ms initial parse (10k lines), 1.4ms incremental

**Decision:** Hybrid architecture — Tauri shell + wgpu for text canvas

---

## M1: Hello World — COMPLETE

- Tauri v2 application shell with window management
- Rope text buffer (`ropey 1.6`) with O(log n) insert/delete
- Tree-sitter incremental parsing (JavaScript + Rust grammars)
- Syntax highlighting (keywords, strings, numbers, comments, types, operators)
- Basic text editing (insert, delete, backspace, newline, navigation)
- Cursor rendering with blink animation
- Gutter line numbers
- Catppuccin Mocha color theme
- CSP security headers

---

## M2: IPC Bridge + Extension Loading — COMPLETE

- TCP IPC bridge (`127.0.0.1:17532`) with length-prefixed JSON frames
- 4-byte LE header + JSON payload protocol
- Frame size validation (10MB max)
- Exponential backoff reconnection (500ms to 10s, max 60 retries)
- Extension Host process management with auto-restart (max 5 attempts)
- Extension discovery and activation from local directories
- Diagnostics pipeline: Extension -> IPC -> Rust -> Frontend
- Command palette (Ctrl+Shift+P) with extension commands
- Notification toasts with auto-dismiss
- Per-URI diagnostic storage and filtering
- Path validation with `fs::canonicalize()`
- Cross-platform file:// URI construction

---

## M3: Real Extension Integration — COMPLETE

- Full VS Code API shim:
  - `vscode.workspace` (textDocuments, onDidOpenTextDocument, onDidChangeTextDocument, onDidCloseTextDocument, getConfiguration)
  - `vscode.commands` (registerCommand, executeCommand)
  - `vscode.languages` (createDiagnosticCollection)
  - `vscode.window` (showInformationMessage, showWarningMessage, showErrorMessage, showQuickPick, showInputBox)
  - `vscode.DiagnosticSeverity`
- Extension configuration via `contributes.configuration` in package.json
- QuickPick/InputBox UI via palette overlay with IPC round-trip (60s timeout)
- Working test extensions:
  - `hello-world` — 3 commands
  - `simple-linter` — JS/TS linter with 8 rules, configurable, debounced
- `textDocument/didClose` sent when switching files
- Mutex poison recovery (`lock_or_default()` helper)

### Code Review Fixes Applied (2 rounds):
- File size limit (50MB), tree-sitter parse failure logging
- Zero-length IPC frame rejection
- `realpathSync()` on extension mainPath before traversal check
- Linter: off-by-one fix, isInsideComment/isInsideString accuracy, 300ms debounce, config validation
- QuickPick/InputBox: addEventListener/removeEventListener pattern
- Toast stacking

---

## M4: MVP Beta — COMPLETE

### Completed (Backend + Extension Host + HTML/CSS)

| Feature | Layer | Status |
|:--------|:------|:-------|
| **Undo/Redo** | Rust (editor.rs) | Done — operation stack with grouped ops, max 10k history |
| **Selection operations** | Rust (editor.rs, lib.rs) | Done — `get_text_range`, `replace_range` commands |
| **Find/Replace** | Rust (editor.rs, lib.rs) | Done — `find_all` (case-sensitive toggle), `replace_in_file` (single/all) |
| **More grammars** | Cargo.toml, editor.rs | Done — TypeScript, TSX, Python, JSON (+ existing JS, Rust) |
| **Expanded highlighting** | highlighting.rs | Done — Python, TypeScript keywords/operators |
| **Status bar items** | ipc_bridge.rs, vscode-api-shim.ts | Done — `createStatusBarItem` with show/hide/dispose |
| **Output channels** | ipc_bridge.rs, vscode-api-shim.ts | Done — `createOutputChannel` with append/appendLine/clear/show |
| **Text decorations** | ipc_bridge.rs, vscode-api-shim.ts | Done — `createTextEditorDecorationType` + IPC plumbing |
| **Uri/Position/Range** | vscode-api-shim.ts | Done — VS Code compatible classes |
| **Find/Replace UI** | index.html, style.css | Done — find bar with case toggle, replace row |
| **Output panel UI** | index.html, style.css | Done — collapsible panel with channel selector |
| **Status bar items UI** | index.html, style.css | Done — extension-contributed items in status bar |

### Completed (Frontend JS wiring in editor.js)

| # | Feature | Description |
|:--|:--------|:------------|
| 1 | **Undo/Redo keybindings** | Done — Ctrl+Z → `edit_undo`, Ctrl+Shift+Z / Ctrl+Y → `edit_redo` |
| 2 | **Selection rendering** | Done — anchor/head tracking, Shift+Arrow, Ctrl+A, click-drag, Shift+click, highlight overlays |
| 3 | **Clipboard** | Done — Ctrl+C (copy), Ctrl+X (cut), Ctrl+V (paste), selection-aware with multi-line support |
| 4 | **Find/Replace wiring** | Done — Ctrl+F/H opens find bar, live search, match highlighting, prev/next navigation, replace single/all |
| 5 | **Status bar polling** | Done — polls `get_status_bar_items` every 2s, renders extension items, click → command |
| 6 | **Output panel toggle** | Done — Ctrl+\` toggles panel, polls `get_output_lines`, channel selector, clear/close |

### PRD scope redistribution

The original PRD defined M4 broadly as "Top 20 Extensions, Performance, macOS+Linux". Those items have been redistributed:

| Original PRD M4 item | Now in |
|:---------------------|:-------|
| Top 20 extension compatibility | M6 (top 10), M8 (top 20) |
| Performance optimization | M7 |
| macOS + Linux validation | M7 |
| Multi-project / workspace support | M5 (IPC groundwork), M8 (full multi-workspace) |

---

## M5: Multi-file Editor — COMPLETE

### Architecture Changes

- **`EditorState` → `WorkspaceState`**: Core refactor from single-file to multi-document. `WorkspaceState` holds `HashMap<PathBuf, DocumentBuffer>` with per-buffer rope, syntax tree, undo stack, and modification state.
- **Shared parser**: Single `tree_sitter::Parser` instance shared across all buffers, language set per-buffer on switch.
- **Frontend buffer state**: `Map<string, BufferState>` tracks per-buffer cursor position, selection, and scroll offset across tab switches.
- **No close-on-switch**: Opening a new file no longer closes the previous one. Extension Host keeps all documents open simultaneously.

### Completed (Backend)

| Feature | Description | Files |
|:--------|:------------|:------|
| **Multi-document state** | `WorkspaceState` with `HashMap<PathBuf, DocumentBuffer>` | `editor.rs` |
| **Per-buffer undo stacks** | Each `DocumentBuffer` has its own `UndoManager` (max 10k history) | `editor.rs` |
| **`open_file`** | Opens into multi-buffer (doesn't close previous), sends `DidOpen` | `lib.rs` |
| **`close_buffer`** | Closes a specific buffer, sends `DidClose`, switches to next | `lib.rs` |
| **`switch_buffer`** | Switches active buffer without IPC (docs stay open in ext host) | `lib.rs` |
| **`list_open_buffers`** | Returns all open buffers with path, modified, language, active | `lib.rs` |
| **`read_directory`** | Reads directory contents for file explorer (sorted, filtered) | `editor.rs` |
| **HTML grammar** | tree-sitter-html 0.23 for `.html`, `.htm` | `Cargo.toml`, `editor.rs` |
| **CSS grammar** | tree-sitter-css 0.25 for `.css`, `.scss` | `Cargo.toml`, `editor.rs` |
| **Markdown grammar** | tree-sitter-md 0.5 for `.md` | `Cargo.toml`, `editor.rs` |
| **Expanded highlighting** | HTML tags/attributes, CSS selectors/properties, Markdown headings/links | `highlighting.rs` |
| **Workspace-tagged IPC** | Optional `workspace_id` field on `DidOpen`/`DidChange`/`DidClose` (defaults to "default") | `ipc_bridge.rs`, `lib.rs` |

### Completed (Frontend)

| Feature | Keybinding | Description |
|:--------|:-----------|:------------|
| **Tab bar** | Click / Ctrl+Tab / Ctrl+W | Multi-file tab strip with open/close/switch, modified indicator (●), Ctrl+Tab cycling |
| **File explorer sidebar** | Ctrl+B | Directory tree with expand/collapse, file/folder icons, click-to-open, Open Folder dialog |
| **Multi-buffer state** | — | Per-buffer cursor, selection, scroll position preserved across tab switches |
| **Minimap** | — | Scrollbar-side overview for files > 50 lines, viewport indicator, scroll-synced |

### Completed (Extension Host)

| Feature | Description | Files |
|:--------|:------------|:------|
| **TreeView API** | `vscode.window.createTreeView` / `registerTreeDataProvider` with `TreeItem`, `TreeItemCollapsibleState` | `vscode-api-shim.ts` |
| **TreeDataProvider** | `getTreeItem`, `getChildren`, `onDidChangeTreeData` interface | `vscode-api-shim.ts` |

---

## M6: Language Intelligence — LSP — COMPLETE

### Architecture Changes

- **Request/response IPC**: `lsp/request` / `lsp/response` message pair with correlation IDs. Rust uses `oneshot` channels for blocking request/response from Tauri commands. Extension Host dispatches to registered providers asynchronously.
- **LanguageClient**: `language-client.ts` — spawns LSP servers via stdio, JSON-RPC 2.0 protocol with `Content-Length` headers. Auto-registers VS Code providers based on server capabilities.
- **vscode-languageclient shim**: Extensions can `require("vscode-languageclient")` or `require("vscode-languageclient/node")` — module resolution injects the built-in LanguageClient with vscodeApi pre-attached.
- **Provider registry**: 8 provider types in `vscode.languages.*` with document selector matching and serialization for IPC transport.

### Key Features

- Autocomplete popup (Ctrl+Space / `.`), hover tooltip, go-to-definition (F12 / Ctrl+Click), find references (Shift+F12), code actions (Ctrl+.), signature help, document symbols (Ctrl+Shift+O), formatting (Ctrl+Shift+F)

### Code Review Fixes Applied (M1-M5 review, 21 findings)

| Category | Fix | Files |
|:---------|:----|:------|
| **Security (Critical)** | Replaced `innerHTML` with DOM methods in command palette to prevent XSS | `editor.js` |
| **Security (Critical)** | Moved IPC buffer accumulation guard before processing loop; use `drain()` | `ipc_bridge.rs` |
| **Security (Critical)** | `Module._resolveFilename` monkeypatch restored via `try/finally` | `extension-loader.ts` |
| **Performance (High)** | UndoManager: `Vec::remove(0)` → `VecDeque::pop_front()` (O(1)) | `editor.rs` |
| **Performance (High)** | `find_all()`: incremental char offset tracking (O(n) instead of O(n×m)) | `editor.rs` |
| **Performance (High)** | DOM rendering: `DocumentFragment` batching instead of per-line reflow | `editor.js` |
| **Correctness (High)** | `replace_in_file()`: iterative find-replace-first loop for correct positions | `lib.rs` |
| **Correctness (High)** | Extension Host: `process.kill()` in error path before restart | `ext_host.rs` |
| **Correctness (High)** | Linter: per-document debounce timers, cleared on document close | `simple-linter/extension.js` |
| **Robustness (High)** | IPC `send()`: log warning on channel-full instead of silent drop | `ipc_bridge.rs` |
| **Robustness (High)** | IPC write: check backpressure return value, log warning | `ipc-server.ts` |
| **Robustness (High)** | Palette listeners: `AbortController` prevents listener accumulation | `editor.js` |
| **Robustness (High)** | Polling intervals: tracked and cleared on hot-reload | `editor.js` |
| **Correctness (Medium)** | Undo/redo: explicit `modified = true` after operations | `editor.rs` |
| **Correctness (Medium)** | Group EditOp: `debug_assert!` preventing nested groups | `editor.rs` |
| **Robustness (Medium)** | Minimap: `lineHeight` NaN fallback when computed value is `"normal"` | `editor.js` |
| **Robustness (Medium)** | Clipboard paste: 1MB size limit with status bar feedback | `editor.js` |
| **Robustness (Medium)** | `list_commands`: added `.catch()` error handler | `editor.js` |
| **Robustness (Medium)** | `Uri.parse()`: log warning on fallback instead of silent | `vscode-api-shim.ts` |
| **Robustness (Medium)** | Extension activation errors sent to frontend via `showErrorMessage` | `extension-loader.ts` |
| **Cleanup (Medium)** | Removed unused `flatbuffers` dependency | `extension-host/package.json` |

---

## M7: Native Rendering & Performance — COMPLETE

### Architectural Decision: Canvas2D over wgpu

Chromium's Canvas2D is already GPU-accelerated (Skia + D3D11). Embedding a native wgpu surface inside Tauri has unsolved z-ordering issues with popups. The real bottleneck was O(n) serialization per keystroke, not DOM vs GPU rendering. Spike code retained in `src/frontend/src/spike/` as reference.

### Completed

| Area | Features |
|:-----|:---------|
| **Backend** | `VisibleContent` virtualized response, `get_visible_content` command, all 7 edit commands return O(1) `EditResult` via shared `do_edit()` helper, visible-range diagnostic filtering |
| **Frontend** | Canvas2D text + gutter rendering (`paintEditorCanvas`, `paintGutterCanvas`), virtual scrolling with sticky canvas, 30-line content cache with buffer zone, O(1) mouse mapping (`posFromMouse`), canvas overlays (selection, find highlights, cursor, diagnostic underlines), arithmetic popup positioning, `requestAnimationFrame` render coalescing, token-density minimap |

### Performance Impact

| Metric | Before (M6) | After (M7) |
|:-------|:------------|:-----------|
| Edit response | O(n) all lines serialized | O(1) `EditResult` |
| Scroll fetch | N/A (all in DOM) | O(visible) viewport + buffer |
| Mouse hit test | O(n) DOM traversal | O(1) arithmetic |
| Render per edit | Full DOM rebuild | Canvas repaint (visible only) |

---

## M8: Full Platform — COMPLETE

### M8a: Extension Ecosystem — COMPLETE

| Feature | Description | Files |
|:--------|:------------|:------|
| **Open VSX client** | HTTP client for Open VSX REST API (search, details, VSIX download) | `marketplace.rs` |
| **Extension manager** | VSIX extract, install/uninstall/update, registry JSON | `extension_mgr.rs` |
| **Settings store** | JSON settings file with dotted key navigation | `settings.rs` |
| **Activity bar** | Panel switcher UI: Explorer, Extensions, Settings | `index.html`, `style.css`, `editor.js` |
| **Marketplace UI** | Search extensions, install/uninstall, download counts | `editor.js` |
| **Settings UI** | Live settings editor, type-aware controls (checkbox, text, number) | `editor.js` |
| **Multi-directory ext loading** | Extension Host scans bundled + user-installed directories | `host.ts`, `extension-loader.ts` |
| **Hot-install** | `extension/installed` IPC triggers live extension loading | `host.ts`, `extension-loader.ts` |
| **Settings sync** | `settings/changed` IPC pushes config to Extension Host | `vscode-api-shim.ts` |

New Tauri commands: `marketplace_search`, `marketplace_get_extension`, `marketplace_list_installed`, `install_extension`, `uninstall_extension`, `check_extension_updates`, `get_extensions_dir`, `get_settings`, `update_setting`, `reset_setting`, `get_setting_definitions`

New IPC messages: `extension/installed`, `extension/uninstalled`, `settings/changed`

New keyboard shortcuts: Ctrl+Shift+X (Extensions), Ctrl+, (Settings)

New dependencies: `reqwest 0.12`, `zip 2`, `dirs 5`

### M8b: WebView, Terminal, Themes, ARIA — COMPLETE

| Feature | Description | Files |
|:--------|:------------|:------|
| **Integrated terminal** | PTY-based terminal panel via `portable-pty` (ConPTY/Unix), xterm.js frontend, multi-session tabs | `terminal.rs`, `editor.js`, `index.html` |
| **WebView support** | `vscode.window.createWebviewPanel` — iframe panels with `acquireVsCodeApi`, bidirectional postMessage | `ipc_bridge.rs`, `lib.rs`, `vscode-api-shim.ts`, `editor.js` |
| **High-contrast themes** | `hc-dark` and `hc-light` CSS classes with full token color overrides | `style.css` |
| **Keyboard navigation / ARIA** | `role=tablist/tab/main/textbox/dialog/search/toolbar`, `aria-label`, focus rings, `.sr-only` | `index.html`, `style.css` |
| **Multi-workspace** | Shared Extension Host serving multiple project windows with `workspace_id` routing | `ipc_bridge.rs`, `lib.rs` |

New Tauri commands (M8b): `terminal_create`, `terminal_write`, `terminal_resize`, `terminal_close`, `terminal_list`, `get_terminal_events`, `respond_terminal_created`, `get_webview_events`, `webview_post_message`, `webview_close_by_user`

New IPC messages (M8b): `webview/create`, `webview/setHtml`, `webview/postMessage`, `webview/reveal`, `webview/close`, `webview/messageFromWebview`, `webview/closedByUser`

New Tauri events (M8b): `terminal-data`, `terminal-exit`

### M8 Remaining — CLOSED (2026-08-24)

| Feature | Outcome |
|:--------|:--------|
| **Accessibility / screen reader** | **Done** — hidden textarea proxy (`#a11y-editor-proxy`, mirrors current line + selection) and ARIA live announcer (`#a11y-announcer`, polite/atomic) implemented and wired to every cursor/status update (editor.js); `aria-expanded` on command-palette input. Further polish (panel roles, focus management) tracked as backlog, non-blocking |
| **Top 20 extension testing** | **Done** — 58 extensions tested: 53 ✅ / 4 ⚠️ / 1 ❌; all non-green entries triaged with dispositions, see [extension-compatibility.md](docs/extension-compatibility.md). Jupyter notebook UI is a P3 backlog item (not an M8 blocker); remote-SSH/-WSL deferred (P4); Live Share and IntelliCode are won't-fix |

---

## M9: Debug Adapter Protocol (DAP) — COMPLETE

Full DAP session lifecycle: adapter process spawn, Content-Length DAP framing, event queue.

| Feature | Description | Files |
|:--------|:------------|:------|
| **DAP session manager** | Spawn adapter, frame parser, event queue | `debug.rs` |
| **Debug sidebar** | Run & Debug panel: Call Stack, Variables, Breakpoints | `index.html`, `style.css`, `editor.js` |
| **Breakpoints** | Gutter click to toggle, red dots, F9 hotkey | `editor.js` |
| **Stopped marker** | Yellow gutter arrow at current frame | `editor.js` |
| **Debug toolbar** | Start/Continue, Step Over/Into/Out, Restart, Stop | `editor.js` |
| **Debug Console** | Bottom-panel tab with adapter output events | `editor.js` |
| **Extension API** | `registerDebugAdapterDescriptorFactory`, `debug.startDebugging`, `DebugAdapterExecutable`, `DebugAdapterServer` | `vscode-api-shim.ts` |

Tauri commands: `get_debug_start_requests`, `debug_start`, `debug_send`, `debug_poll_events`, `debug_stop`, `debug_list_sessions`

Keyboard shortcuts: F5 (start/continue), Shift+F5 (stop), F9 (breakpoint), F10 (step over), F11 (step into), Shift+F11 (step out), Ctrl+Shift+D (Run & Debug panel)

Debug adapter path validation: absolute path → canonicalize → is-file → home-dir confinement (M12).

---

## M10: Extension Compatibility Expansion — COMPLETE

| Feature | Description |
|:--------|:------------|
| **A. `workspace.applyEdit` + `WorkspaceEdit`** | Multi-file edits; open buffers updated in-memory, others on disk. Frontend polls `get_workspace_edit_requests` and confirms via `apply_workspace_edit`. Supports `changes` (LSP 3.x) and `documentChanges` formats. |
| **B. `window.createTerminal`** | Already complete from M8/M9 |
| **C. Inlay hints** | `lsp_inlay_hints` command, canvas overlay at character positions, 600ms debounce on cursor/scroll |
| **D. TreeView panel** | Collapsible tree panel with `onDidChangeTreeData` push and command execution; `get_tree_view_events`, `tree_view_get_children` commands |

Also: code-action `applyEdit` fixed to route edits per-file URI via `apply_workspace_edit` instead of applying all edits to the active buffer.

---

## M11: Multi-cursor + Extension API Trio — COMPLETE

### Multi-cursor Editing

| Shortcut | Behaviour |
|:---------|:----------|
| Ctrl+Alt+Up / Down | Add cursor above / below |
| Alt+Click | Add cursor at click position |
| Ctrl+D | Select next occurrence of word/selection |
| Escape | Collapse to primary cursor |

All edit operations apply to all cursors simultaneously, processed bottom-to-top to avoid offset drift. Status bar shows `[N cursors]`.

### Extension APIs

| API | Flow |
|:----|:-----|
| **`registerRenameProvider` (F2)** | F2 → `lsp_prepare_rename` → input box pre-filled with symbol → `lang_rename` → `apply_workspace_edit` |
| **`window.showTextDocument`** | Extensions open files programmatically (optional `selection`); polled via `get_show_text_document_requests` |
| **`registerDocumentHighlightProvider`** | Symbol-under-cursor occurrences highlighted, kind-tinted (text grey / read blue / write orange), 300ms debounce |

> Note: rename moved from `lsp_rename` to the unified `lang_rename` dispatch (WASM-host Phase 3, 2026-05-25).

---

## M12: Security Hardening + Tasks + SCM + Diff Viewer — COMPLETE

### A. Security Hardening

| Fix | Description |
|:----|:------------|
| **IPC auth token** | Shared-secret authentication before message processing | `ipc_bridge.rs`, `ext_host.rs`, `ipc-server.ts` |
| **Path traversal prevention** | `validate_path` / `validate_dir_path` — canonicalize + home-dir confinement for all file I/O | `lib.rs` |
| **`apply_workspace_edit` hardening** | `validate_path` on every URI before read/write | `lib.rs` |
| **Shell path traversal** | Terminal `shell` param rejected if it contains `..` | `lib.rs` |
| **Buffer overflow fix** | Accumulated-buffer check fires **before** `extend_from_slice` | `ipc_bridge.rs` |
| **`iframe` sandbox** | Removed `allow-same-origin` from webview sandbox | `lib.rs` |
| **Webview event queue cap** | `MAX_WEBVIEW_EVENTS = 100` with drop-and-warn | `ipc_bridge.rs` |
| **Extension manifest validation** | `version`, `activationEvents`, `contributes.commands` checked | `extension-loader.ts` |
| **URI encoding** | `url::Url::from_file_path()` for percent-encoding | `lib.rs` |

### B. `vscode.tasks`

Full task API wired to the integrated terminal: `TaskScope`, `TaskRevealKind`, `TaskPanelKind`, `TaskGroup`, `ShellExecution`, `ProcessExecution`, `Task`, `registerTaskProvider`, `fetchTasks`, `executeTask`, `onDidStartTask` / `onDidEndTask`.

### C. `vscode.scm` + Git SCM Panel

- **Rust:** `ScmResourceState` / `ScmResourceGroup` / `ScmSourceControlState` buffered per-id; `scm/update`, `scm/remove` IPC messages
- **Extension Host:** real `vscode.scm.createSourceControl` with live `SourceControl` objects; `Proxy`-based resource groups push state on assignment
- **Git commands:** `git_status`, `git_diff_file`, `git_stage`, `git_unstage`, `git_discard`, `git_commit`, `get_scm_state`
- **SCM sidebar:** Ctrl+Shift+G, commit box (Ctrl+Enter), Staged/Changes/Untracked groups, status letters with colors, inline Stage/Unstage/Discard, extension SCM state merged, 5s polling
- **Diff viewer:** full-screen overlay on SCM file click, line numbers, colored diff (added/removed/hunk/file headers), context-sensitive Stage/Unstage/Discard buttons, Escape closes

---

## WASM Extension Host (parallel track) — PHASES 1–5 COMPLETE, PHASE 6 MOSTLY COMPLETE

Branch: `feature/wasm-extension-host-impl`. In-process `wasmtime` (component model) alongside the Node.js Extension Host — no subprocess. Plans: [docs/plans/impl/00-index.md](docs/plans/impl/00-index.md), architecture: [docs/plans/01-architecture.md](docs/plans/01-architecture.md).

| Component | Description |
|:----------|:------------|
| `wasm_host/manager.rs` | Shared engine; fuel + epoch interruption sandboxing (~30s deadline) |
| `wasm_host/instance.rs` | Per-extension `Store`, lifecycle + optional provider exports |
| `wasm_host/api_impl.rs` | Host imports (ui, workspace) |
| `wasm_host/manifest.rs` | `corecode.toml` parser/validator |
| `grammar_registry.rs` | Dynamic native grammar loading (Phase 2.5) |
| `dispatch.rs` | Unified `lang_*` dispatch layer (Phase 3) |

### Unified `lang_*` dispatch (Phase 3)

`lang_completions`, `lang_hover`, `lang_diagnostics`, `lang_definition`, `lang_references`, `lang_format_document`, `lang_format_range`, `lang_rename`, `lang_code_actions`, `lang_workspace_symbols`, `lang_folding_ranges` — single command surface serving both WASM and Node.js providers.

### Tier-1 LSP additions (Phase 4)

`lsp_type_definition`, `lsp_implementation`, `lsp_selection_ranges`, `lsp_document_links`, `lsp_resolve_document_link`, `lsp_semantic_tokens_full`, `lsp_semantic_tokens_range`, `lsp_semantic_tokens_delta` — frontend wired for type-def/implementation/selection-range navigation, document links, and semantic tokens with delta refresh on edit.

### Toolchain (Phase 5 — complete)

`tools/cargo-corecode`: `cargo corecode new --template <t>`, `cargo corecode build --target corecode|zed|vscode|all`, `cargo corecode check`, and `cargo corecode publish [--token <t>] [--registry <url>] [--dry-run]`. Packagers for `.ccext`, Zed `.zip`, VS Code `.vsix`. `publish` builds a release `.ccext`, validates the manifest (`publisher.name` id + semver version), and uploads via `POST {registry}/api/v1/publish` (Bearer token; 409 = version already published). Registry defaults to `$CORECODE_REGISTRY`, then `https://marketplace.corecode.dev`.

### Marketplace (Phase 6 — mostly complete)

`tools/marketplace-server` — standalone axum registry implementing the publish protocol above plus read endpoints (`/api/v1/extension/{id}`, `/latest`, `/{version}/download` with `x-corecode-sha256`, `/search`, `/health`). Filesystem store (`index.json` + immutable `packages/<id>/<version>.ccext`), atomic index writes, immutable versions (409 on re-publish), SHA-256 recorded at publish and verified by the client before install. 10 unit/integration tests.

App side: `marketplace.rs` gains `ccext_get` / `ccext_download` (HTTPS-only outside loopback/LAN, URLs built from validated segments, 50MB cap); new commands `marketplace_get_native` + `install_native_extension` (resolves latest, downloads, verifies SHA-256, unpacks via the existing installer — `.ccext` carries `corecode.toml` at the root and routes to the WASM host). Extensions panel shows a **Native / Node.js host-type badge** (`InstalledExtension.kind`, recomputed from disk on every listing).

Remaining: ed25519 signature verification (SHA-256 integrity is enforced end-to-end today; signing keys + `X-CoreCode-Signature` reserved), public deployment, native extensions tab in the marketplace UI. Details: [phase-6-marketplace.md](docs/plans/impl/phase-6-marketplace.md).

### Example WASM extensions (`examples/`)

`hello-wasm` (commands), `simple-lsp` (language provider), `grammar-toml` (dynamic grammar + highlights query), `webview-counter` (webview panel).

---

## Architecture

```
+------------------+     TCP IPC      +--------------------+
|  Tauri v2 Shell  | <=============>  |  Node.js Extension |
|  (Rust backend)  |  127.0.0.1:17532 |  Host              |
|                  |  Length-prefixed  |                    |
|  - WorkspaceState|  JSON frames     |  - VS Code API     |
|    └ HashMap<    |  + workspace_id  |    shim             |
|      Path,Buffer>|  + lsp req/resp  |  - Extension loader |
|  - Tree-sitter   |  + auth token    |  - LSP providers    |
|  - Find engine   |                  |  - LanguageClient   |
|  - LSP commands  |                  |  - TreeView API     |
|  - PTY terminal  |                  |  - tasks/scm/debug  |
|  - DAP sessions  |                  +--------------------+
|  - Git commands  |                          |
|  - WASM host     |                          v
|    (wasmtime,   |                  +--------------------+
|     in-process)  |                  |  LSP Servers       |
+------------------+                  |  (child processes) |
        |                             +--------------------+
        v
+--------------------+          +---------------------------+
|  HTML/CSS/JS       |          |  WASM extensions          |
|  Frontend          |          |  (.ccext, wasmtime)       |
|                    |          |  hello-wasm, simple-lsp,  |
|  - Tab bar         |          |  grammar-toml,            |
|  - File explorer   |          |  webview-counter          |
|  - Editor canvas   |          +---------------------------+
|  - Command palette |
|  - Find/Replace    |
|  - Output panel    |
|  - Minimap         |
|  - Autocomplete    |
|  - Hover tooltip   |
|  - Signature help  |
|  - References      |
|  - Code actions    |
|  - Symbol outline  |
|  - Inlay hints     |
|  - Multi-cursor    |
|  - Terminal (xterm)|
|  - Debug sidebar   |
|  - SCM panel + diff|
+--------------------+
```

## Supported Languages (Syntax Highlighting)

| Language | Grammar | Status |
|:---------|:--------|:-------|
| JavaScript (.js, .jsx, .mjs, .cjs) | tree-sitter-javascript 0.23 | Working |
| TypeScript (.ts) | tree-sitter-typescript 0.23 | Working |
| TSX (.tsx) | tree-sitter-typescript 0.23 | Working |
| Rust (.rs) | tree-sitter-rust 0.23 | Working |
| Python (.py) | tree-sitter-python 0.23 | Working |
| JSON (.json) | tree-sitter-json 0.24 | Working |
| HTML (.html, .htm) | tree-sitter-html 0.23 | Working (M5) |
| CSS (.css, .scss) | tree-sitter-css 0.25 | Working (M5) |
| Markdown (.md) | tree-sitter-md 0.5 | Working (M5) |
| Any via extension | Dynamic native grammars (grammar provider) | Working (WASM Phase 2.5, e.g. `grammar-toml`) |

## VS Code API Coverage

| API | Status | Notes |
|:----|:-------|:------|
| `workspace.textDocuments` | Implemented | |
| `workspace.onDidOpenTextDocument` | Implemented | |
| `workspace.onDidChangeTextDocument` | Implemented | |
| `workspace.onDidCloseTextDocument` | Implemented | |
| `workspace.getConfiguration` | Implemented | Reads contributes.configuration |
| `workspace.applyEdit` | Implemented (M10) | Multi-file WorkspaceEdit |
| `commands.registerCommand` | Implemented | |
| `commands.executeCommand` | Implemented | |
| `languages.createDiagnosticCollection` | Implemented | Per-URI storage |
| `languages.register*Provider` (8 core) | Implemented (M6) | Completion, hover, definition, references, code actions, signature help, symbols, formatting |
| `languages.registerRenameProvider` | Implemented (M11) | F2 flow |
| `languages.registerDocumentHighlightProvider` | Implemented (M11) | |
| `window.showInformationMessage` | Implemented | Toast notification |
| `window.showWarningMessage` | Implemented | Toast notification |
| `window.showErrorMessage` | Implemented | Toast notification |
| `window.showQuickPick` | Implemented | Palette overlay |
| `window.showInputBox` | Implemented | Palette overlay |
| `window.showTextDocument` | Implemented (M11) | With optional selection |
| `window.createStatusBarItem` | Implemented (M4) | Full: IPC + frontend polling + click → command |
| `window.createOutputChannel` | Implemented (M4) | Full: IPC + frontend panel with channel selector |
| `window.createTextEditorDecorationType` | Implemented (M4) | IPC + frontend polling |
| `window.createTreeView` | Implemented (M5, panel M10) | TreeView with data provider |
| `window.registerTreeDataProvider` | Implemented (M5) | TreeDataProvider interface |
| `window.createWebviewPanel` | Implemented (M8b) | iframe + acquireVsCodeApi + postMessage |
| `window.createTerminal` | Implemented (M8b) | Extension terminal API |
| `debug.startDebugging` | Implemented (M9) | + DebugAdapterDescriptorFactory |
| `tasks.*` | Implemented (M12) | Full task lifecycle |
| `scm.createSourceControl` | Implemented (M12) | Live Proxy resource groups |
| `comments` | Implemented | Comment threads (`get_comment_threads`) |
| `notebooks` | Implemented | Basic shim surface |
| `authentication` | Implemented | Basic shim surface |
| `Uri` | Implemented (M4) | file/parse/fsPath |
| `Position` / `Range` / `Selection` | Implemented (M4) | |
| `DiagnosticSeverity` | Implemented | Error/Warning/Info/Hint |
| `StatusBarAlignment` | Implemented (M4) | Left/Right |
| `TreeItemCollapsibleState` | Implemented (M5) | None/Collapsed/Expanded |
| `ViewColumn` | Implemented (M8b) | Active/Beside/One/Two/Three |

## Testing

| Suite | Scope | Size |
|:------|:------|:-----|
| Extension Host (TS, `*.test.ts`) | extension-loader, ipc-server, language-client, git-api, lsp-dispatch | 144 test cases |
| Frontend (`node --test`) | `src/app/src/lib/editor-helpers.test.js` | Pure helper functions extracted from editor.js |
| Rust | Inline `#[test]` modules (editor, ipc_bridge, wasm_host, …) | No separate `tests/` dir |
| Manual (`docs/testing/manual/`) | 00 prerequisites → 07 security: compile extensions, cargo-corecode CLI, runtime lifecycle, language/grammar providers, webview panels, security | 8 documents |
| Compatibility | Top-20 extension matrix | 58 extensions: 53 ✅ / 4 ⚠️ / 1 ❌ |

## Open Items

- [ ] **Notebook support (P3 backlog)** — Jupyter's only genuine gap: notebook document model + canvas cell UI + execution wiring (see `docs/extension-compatibility.md` #26)
- [ ] **Remote infrastructure (P4 backlog)** — `RemoteAuthorityResolver` + virtual FS for Remote-SSH/-WSL; interim for WSL: UNC `\\wsl.localhost` paths
- [ ] **A11y polish (backlog)** — panel ARIA roles, focus management, high-contrast theme audit
- [ ] **WASM Phase 6 remainder** — ed25519 signature verification (`cargo corecode keygen`, sign at publish, verify on install; `X-CoreCode-Signature` reserved), public deployment of `marketplace.corecode.dev`, Native tab in the marketplace UI. Server + install path + badge are done
