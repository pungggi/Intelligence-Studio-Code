# CoreCode — Project Status

**Last updated:** 2026-03-26

---

## Milestone Overview

| Milestone | Description | Status |
|:----------|:------------|:-------|
| **M0: Technology Spike** | wgpu rendering, IPC latency, Extension Host PoC, Tree-sitter | **Done** |
| **M1: Hello World** | Tauri shell, Rope text buffer, Tree-sitter highlighting, basic editing | **Done** |
| **M2: First Extension** | IPC bridge, Extension Host, diagnostics, command palette, notifications | **Done** |
| **M3: Real Extension Integration** | VS Code API shim, simple linter, QuickPick/InputBox, extension config | **Done** |
| **M4: MVP Beta** | Undo/redo, selection, find/replace, more grammars, status bar, output channels | **In Progress** |

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

## M4: MVP Beta — IN PROGRESS

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

### Pending (Frontend JS wiring)

| Feature | Description |
|:--------|:------------|
| **Selection rendering** | Shift+Arrow, Ctrl+A, click-drag, selection highlight overlays |
| **Clipboard** | Ctrl+C (copy), Ctrl+X (cut), Ctrl+V (paste) using selection |
| **Undo/Redo keybindings** | Ctrl+Z / Ctrl+Shift+Z wired to `edit_undo` / `edit_redo` |
| **Find/Replace wiring** | Ctrl+F / Ctrl+H open find bar, navigate matches, replace |
| **Status bar polling** | Poll `get_status_bar_items`, render extension items |
| **Output panel toggle** | Ctrl+\` to toggle, poll `get_output_lines`, channel switching |

---

## Architecture

```
+------------------+     TCP IPC      +--------------------+
|  Tauri v2 Shell  | <=============>  |  Node.js Extension |
|  (Rust backend)  |  127.0.0.1:17532 |  Host              |
|                  |  Length-prefixed  |                    |
|  - Rope buffer   |  JSON frames     |  - VS Code API     |
|  - Tree-sitter   |                  |    shim             |
|  - Undo stack    |                  |  - Extension loader |
|  - Find engine   |                  |  - LSP proxy        |
+------------------+                  +--------------------+
        |
        v
+------------------+
|  HTML/CSS/JS     |
|  Frontend        |
|                  |
|  - Editor canvas |
|  - Command       |
|    palette       |
|  - Find/Replace  |
|  - Output panel  |
+------------------+
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

## VS Code API Coverage

| API | Status | Notes |
|:----|:-------|:------|
| `workspace.textDocuments` | Implemented | |
| `workspace.onDidOpenTextDocument` | Implemented | |
| `workspace.onDidChangeTextDocument` | Implemented | |
| `workspace.onDidCloseTextDocument` | Implemented | |
| `workspace.getConfiguration` | Implemented | Reads contributes.configuration |
| `commands.registerCommand` | Implemented | |
| `commands.executeCommand` | Implemented | |
| `languages.createDiagnosticCollection` | Implemented | Per-URI storage |
| `window.showInformationMessage` | Implemented | Toast notification |
| `window.showWarningMessage` | Implemented | Toast notification |
| `window.showErrorMessage` | Implemented | Toast notification |
| `window.showQuickPick` | Implemented | Palette overlay |
| `window.showInputBox` | Implemented | Palette overlay |
| `window.createStatusBarItem` | Implemented (M4) | IPC plumbing done |
| `window.createOutputChannel` | Implemented (M4) | IPC plumbing done |
| `window.createTextEditorDecorationType` | Stub (M4) | Basic plumbing |
| `Uri` | Implemented (M4) | file/parse/fsPath |
| `Position` / `Range` | Implemented (M4) | |
| `DiagnosticSeverity` | Implemented | Error/Warning/Info/Hint |
| `StatusBarAlignment` | Implemented (M4) | Left/Right |
