# CoreCode — Milestone Details

---

## M0: Technology Spike (2 weeks) — COMPLETE

**Goal:** Validate core architectural decisions through minimal prototypes.

### Spike Results

| Spike | Goal | Result | Key Files |
|:------|:-----|:-------|:----------|
| 1. wgpu Rendering | < 16ms frame time, 1k lines | **PASS** | `src/frontend/src/bin/spike_renderer.rs` |
| 2. IPC Latency | < 1ms round-trip | **PASS** (45µs binary, 60µs JSON) | `src/frontend/src/bin/spike_ipc.rs` |
| 3. Extension Host | Extensions load + activate | **PASS** (131µs RTT) | `src/frontend/src/bin/spike_ext_host.rs` |
| 4. Tree-sitter | < 50ms initial, < 1ms incremental | **PASS** (37ms / 1.4ms) | `src/frontend/src/bin/spike_treesitter.rs` |

### Decision
**Hybrid architecture (Option C):** Tauri shell for window management + wgpu for text canvas. JSON-RPC for MVP IPC (FlatBuffers deferred — syscall overhead dominates at small payloads).

---

## M1: Hello World (6 weeks) — COMPLETE

**Goal:** Rust editor renders text, Node.js Extension Host starts, IPC functions.

### Deliverables

| Feature | Implementation | File |
|:--------|:---------------|:-----|
| Tauri v2 app shell | Window management, file dialogs, CSP | `src/app/src-tauri/tauri.conf.json` |
| Rope text buffer | ropey 1.6, O(log n) operations | `src/app/src-tauri/src/editor.rs` |
| Tree-sitter highlighting | JS + Rust grammars, token mapping | `src/app/src-tauri/src/highlighting.rs` |
| Basic editing | Insert, delete, backspace, newline | `src/app/src-tauri/src/editor.rs` |
| Cursor + navigation | Arrow keys, Home/End, click-to-place | `src/app/src/editor.js` |
| Gutter line numbers | Scroll-synced, diagnostic markers | `src/app/src/editor.js` |
| Catppuccin Mocha theme | 15 CSS custom properties | `src/app/src/style.css` |

---

## M2: First Extension (4 weeks) — COMPLETE

**Goal:** IPC bridge working, extensions load and produce diagnostics.

### Deliverables

| Feature | Implementation | Files |
|:--------|:---------------|:------|
| TCP IPC bridge | Length-prefixed JSON, 10MB frame limit | `src/app/src-tauri/src/ipc_bridge.rs` |
| Extension Host management | Auto-restart (max 5), exponential backoff | `src/app/src-tauri/src/ext_host.rs` |
| Extension loader | Directory scan, package.json parsing, path validation | `src/extension-host/src/extension-loader.ts` |
| VS Code API shim (basic) | textDocuments, commands, diagnostics, messages | `src/extension-host/src/vscode-api-shim.ts` |
| Diagnostics display | Wavy underlines, gutter markers, severity count | `src/app/src/editor.js`, `style.css` |
| Command palette | Ctrl+Shift+P, fuzzy filter, extension commands | `src/app/src/editor.js` |
| Notification toasts | Auto-dismiss, stacking, info/warn/error types | `src/app/src/editor.js` |
| Cross-platform IPC | TCP on localhost (replaces Unix sockets) | `src/app/src-tauri/src/ipc_bridge.rs` |

### IPC Protocol

```
[4 bytes LE length][JSON payload]
```

Messages: `textDocument/didOpen`, `textDocument/didChange`, `textDocument/didClose`, `executeCommand`, `publishDiagnostics`, `showMessage`, `registeredCommands`

---

## M3: MVP Alpha — Real Extension Integration (8 weeks) — COMPLETE

**Goal:** Top 5 extensions functional, Tree-sitter highlighting, command palette.

### Deliverables

| Feature | Implementation | Files |
|:--------|:---------------|:------|
| Full VS Code API shim | workspace, commands, languages, window namespaces | `src/extension-host/src/vscode-api-shim.ts` |
| Extension configuration | `contributes.configuration` from package.json | `src/extension-host/src/extension-loader.ts` |
| DiagnosticCollection | Per-URI storage, set/delete/clear/dispose | `src/extension-host/src/vscode-api-shim.ts` |
| QuickPick / InputBox | Palette overlay reuse, IPC round-trip, 60s timeout | `src/app/src/editor.js` |
| Simple Linter extension | 8 rules, configurable, debounced, JS/TS support | `src/test-extensions/simple-linter/` |
| Hello World extension | 3 commands (helloWorld, greet, add) | `src/test-extensions/hello-world/` |
| `textDocument/didClose` | Sent on file switch, clears diagnostics | `src/app/src-tauri/src/lib.rs` |

### VS Code API Coverage (M3)

```
vscode.workspace
  ├── textDocuments
  ├── onDidOpenTextDocument
  ├── onDidChangeTextDocument
  ├── onDidCloseTextDocument
  └── getConfiguration

vscode.commands
  ├── registerCommand
  └── executeCommand

vscode.languages
  └── createDiagnosticCollection

vscode.window
  ├── showInformationMessage
  ├── showWarningMessage
  ├── showErrorMessage
  ├── showQuickPick
  └── showInputBox

vscode.DiagnosticSeverity (Error, Warning, Information, Hint)
```

### Code Review Fixes (2 rounds, 30+ findings)

| Category | Fixes |
|:---------|:------|
| Security | File size limit (50MB), zero-length frame rejection, realpathSync on extension mainPath |
| Correctness | Off-by-one in linter ranges, isInsideComment/isInsideString accuracy, config type validation |
| Robustness | Mutex poison recovery, tree-sitter parse failure logging, unknown language handling |
| UX | Toast stacking, linter debounce (300ms), addEventListener/removeEventListener pattern |

---

## M4: MVP Beta (8 weeks) — IN PROGRESS

**Goal:** Top 20 extensions supported, performance optimization, macOS + Linux polish.

### Completed (Backend + Extension Host)

| Feature | Description | Files |
|:--------|:------------|:------|
| Undo/Redo | Operation stack (Insert/Delete/Group), max 10k history | `editor.rs` |
| Selection operations | `get_text_range`, `replace_range` with any direction | `editor.rs`, `lib.rs` |
| Find/Replace | `find_all` (case toggle), `replace_in_file` (single/all) | `editor.rs`, `lib.rs` |
| TypeScript grammar | `.ts` and `.tsx` via tree-sitter-typescript | `editor.rs`, `Cargo.toml` |
| Python grammar | `.py`, `.pyw` via tree-sitter-python | `editor.rs`, `Cargo.toml` |
| JSON grammar | `.json`, `.jsonc` via tree-sitter-json | `editor.rs`, `Cargo.toml` |
| Expanded highlighting | Python/TS keywords, operators, string types | `highlighting.rs` |
| Status bar items | `createStatusBarItem` with show/hide/dispose, IPC | `vscode-api-shim.ts`, `ipc_bridge.rs` |
| Output channels | `createOutputChannel` with append/appendLine/clear | `vscode-api-shim.ts`, `ipc_bridge.rs` |
| Text decorations | `createTextEditorDecorationType` stub + IPC | `vscode-api-shim.ts`, `ipc_bridge.rs` |
| Uri/Position/Range | VS Code compatible classes | `vscode-api-shim.ts` |
| StatusBarAlignment | Left/Right enum | `vscode-api-shim.ts` |
| Find/Replace UI | HTML/CSS for find bar with case toggle, replace row | `index.html`, `style.css` |
| Output panel UI | HTML/CSS for collapsible panel with channel selector | `index.html`, `style.css` |

### Pending (Frontend JS)

| Feature | Keybinding | Description |
|:--------|:-----------|:------------|
| Selection rendering | Shift+Arrow, Ctrl+A | Visual selection overlays |
| Clipboard | Ctrl+C/X/V | Copy, cut, paste with selection |
| Undo/Redo keybindings | Ctrl+Z, Ctrl+Shift+Z | Wire to `edit_undo`/`edit_redo` |
| Find/Replace interaction | Ctrl+F, Ctrl+H | Open find bar, navigate matches, replace |
| Status bar polling | — | Poll `get_status_bar_items`, render items |
| Output panel toggle | Ctrl+\` | Toggle output panel, poll lines, channel switching |

### New Tauri Commands (M4)

```
edit_undo()                → EditorContent
edit_redo()                → EditorContent
edit_replace_range(...)    → EditorContent
get_text_range(...)        → String
find_in_file(query, case)  → Vec<FindMatch>
replace_in_file(...)       → ReplaceResult
get_status_bar_items()     → Vec<StatusBarItem>
get_output_lines()         → Vec<OutputLine>
```

---

## Supported Languages

| Language | Extensions | Grammar Version | Since |
|:---------|:-----------|:----------------|:------|
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | tree-sitter-javascript 0.23 | M1 |
| Rust | `.rs` | tree-sitter-rust 0.23 | M1 |
| TypeScript | `.ts` | tree-sitter-typescript 0.23 | M4 |
| TSX | `.tsx` | tree-sitter-typescript 0.23 | M4 |
| Python | `.py`, `.pyw` | tree-sitter-python 0.23 | M4 |
| JSON | `.json`, `.jsonc` | tree-sitter-json 0.24 | M4 |

---

## Roadmap (Post-M4)

| Feature | Priority | Notes |
|:--------|:---------|:------|
| HTML/CSS grammars | P1 | tree-sitter-html, tree-sitter-css |
| LSP integration | P0 | Language servers as Extension Host child processes |
| Multi-file tabs | P1 | Tab bar, tab switching |
| File explorer sidebar | P1 | TreeView API for extensions |
| wgpu text canvas | P1 | Replace HTML canvas with GPU-accelerated rendering |
| WebView support | P2 | Required for Copilot, markdown preview |
| Integrated terminal | P2 | PTY process management |
| Settings UI | P2 | JSON settings editor |
| Open VSX integration | P2 | Extension marketplace (not VS Code Marketplace) |
| Windows support | P1 | Named Pipes, DirectWrite |
| Accessibility | P2 | AT-SPI (Linux), NSAccessibility (macOS) |
