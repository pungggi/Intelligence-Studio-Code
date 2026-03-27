# CoreCode — Project Status

**Last updated:** 2026-03-27

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
| **M8: Full Platform** | WebViews, terminal, settings UI, Open VSX marketplace, accessibility, multi-workspace | **In Progress** (M8a done) |

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

The original PRD defined M4 broadly as "Top 20 Extensions, Performance, macOS+Linux". Those items have been redistributed to future milestones:

| Original PRD M4 item | Now in |
|:----------------------|:-------|
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

### New Tauri Commands (M5)

```
open_file(path)           → EditorContent  (multi-buffer: doesn't close previous)
close_buffer(path)        → Option<EditorContent>
switch_buffer(path)       → EditorContent
list_open_buffers()       → Vec<BufferInfo>
read_directory(path)      → Vec<DirEntry>
```

### New Keyboard Shortcuts (M5)

| Shortcut | Action |
|:---------|:-------|
| Ctrl+B | Toggle file explorer sidebar |
| Ctrl+Tab | Next tab |
| Ctrl+Shift+Tab | Previous tab |
| Ctrl+W | Close current tab |

See [milestones.md](docs/milestones.md) for full M8 details.

---

## M6: Language Intelligence — LSP — COMPLETE

### Architecture Changes

- **Request/response IPC**: New `lsp/request` / `lsp/response` message pair with correlation IDs. Rust uses `oneshot` channels for blocking request/response from Tauri commands. Extension Host dispatches to registered providers asynchronously.
- **LanguageClient**: New `language-client.ts` — spawns LSP servers via stdio, JSON-RPC 2.0 protocol with `Content-Length` headers. Auto-registers VS Code providers based on server capabilities.
- **vscode-languageclient shim**: Extensions can `require("vscode-languageclient")` or `require("vscode-languageclient/node")` — module resolution injects the built-in LanguageClient with vscodeApi pre-attached.
- **Provider registry**: 8 new provider types in `vscode.languages.*` with document selector matching and serialization for IPC transport.

### Completed (Backend — ipc_bridge.rs, lib.rs)

| Feature | Description | Files |
|:--------|:------------|:------|
| **Request/response IPC** | `lsp/request` with `request_id`, `oneshot` channels, 10s timeout | `ipc_bridge.rs` |
| **`lsp_hover`** | Tauri command for hover at position | `lib.rs` |
| **`lsp_completion`** | Tauri command for completions with trigger kind/character | `lib.rs` |
| **`lsp_definition`** | Tauri command for go-to-definition | `lib.rs` |
| **`lsp_references`** | Tauri command for find references | `lib.rs` |
| **`lsp_code_action`** | Tauri command for code actions on range | `lib.rs` |
| **`lsp_signature_help`** | Tauri command for signature help | `lib.rs` |
| **`lsp_document_symbols`** | Tauri command for document symbols | `lib.rs` |
| **`lsp_format`** | Tauri command for document formatting | `lib.rs` |

### Completed (Extension Host — vscode-api-shim.ts, language-client.ts)

| Feature | Description | Files |
|:--------|:------------|:------|
| **Provider registration** | 8 `register*Provider` methods with document selector matching | `vscode-api-shim.ts` |
| **LSP request dispatch** | `handleLspRequest` → `dispatchLspRequest` with provider lookup | `vscode-api-shim.ts` |
| **Result serialization** | CompletionItem, Hover, Location, CodeAction, Symbol, TextEdit | `vscode-api-shim.ts` |
| **LanguageClient** | JSON-RPC 2.0 stdio, initialize/shutdown, auto provider registration | `language-client.ts` |
| **vscode-languageclient** | Module shim injected into require cache | `extension-loader.ts` |
| **New VS Code types** | CompletionItemKind, SymbolKind, CompletionTriggerKind, CancellationTokenSource | `vscode-api-shim.ts` |

### Completed (Frontend — editor.js, index.html, style.css)

| Feature | Keybinding | Description |
|:--------|:-----------|:------------|
| **Autocomplete popup** | Ctrl+Space / `.` trigger | Multi-column with icons, detail panel, Enter/Tab accept |
| **Hover tooltip** | Mouse hover (500ms) | Floating tooltip positioned above line, auto-dismiss |
| **Go-to-definition** | F12 / Ctrl+Click | Cross-file navigation, opens target file at position |
| **Find references** | Shift+F12 | Floating panel listing all references, click to navigate |
| **Code actions** | Ctrl+. | Quick fix menu with arrow key nav, workspace edit support |
| **Signature help** | Auto on `(` and `,` | Active parameter highlighting, documentation display |
| **Document symbols** | Ctrl+Shift+O | Filterable outline palette with kind icons |
| **Formatting** | Ctrl+Shift+F | Apply text edits from formatter, sorted end-to-start |

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

### Completed (Backend)

| Feature | Description | Files |
|:--------|:------------|:------|
| **`VisibleContent` struct** | Virtualized response: only requested lines + metadata | `lib.rs` |
| **`get_visible_content`** | Tauri command: fetch lines for visible range + buffer zone | `lib.rs`, `editor.rs` |
| **`EditResult` responses** | All 7 edit commands return `{ total_lines, modified }` instead of full content | `lib.rs` |
| **`do_edit()` helper** | Shared notify + reparse + result logic for edit commands | `lib.rs` |
| **Filtered diagnostics** | `get_visible_content` only returns diagnostics in the visible range | `editor.rs` |

### Completed (Frontend)

| Feature | Description | Files |
|:--------|:------------|:------|
| **Canvas2D text rendering** | `paintEditorCanvas()` with `fillText()`, per-token color from Catppuccin Mocha | `editor.js` |
| **Canvas gutter** | `paintGutterCanvas()` draws line numbers synced to editor scroll | `editor.js` |
| **Virtual scrolling** | Sticky canvas over scroll-sizer div, scroll → line range mapping | `editor.js`, `style.css` |
| **Content caching** | 30-line buffer zone, fetch on cache miss during scroll | `editor.js` |
| **O(1) mouse mapping** | `posFromMouse()` arithmetic replaces DOM `.line` iteration | `editor.js` |
| **Canvas overlays** | Selection, find highlights, cursor blink, diagnostic wavy underlines | `editor.js` |
| **Popup positioning** | `getLineBoundsOnScreen()` arithmetic for LSP popup placement | `editor.js` |
| **requestAnimationFrame** | `requestRender()` coalesces multiple requests into single frame | `editor.js` |
| **Minimap** | Token-density minimap with viewport indicator | `editor.js` |

### Performance Impact

| Metric | Before (M6) | After (M7) |
|:-------|:------------|:-----------|
| Edit response | O(n) all lines serialized | O(1) `EditResult` |
| Scroll fetch | N/A (all in DOM) | O(visible) viewport + buffer |
| Mouse hit test | O(n) DOM traversal | O(1) arithmetic |
| Render per edit | Full DOM rebuild | Canvas repaint (visible only) |

---

## M8: Full Platform — IN PROGRESS

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

### M8b-c: Remaining (Planned)

| Feature | Status |
|:--------|:-------|
| WebView support | Planned |
| Integrated terminal | Planned |
| Multi-workspace | Planned |
| Accessibility / Screen reader | Planned |
| Keyboard navigation | Planned |
| High-contrast themes | Planned |
| Top 20 extension testing | Planned |

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
|  - Tree-sitter   |                  |  - LSP providers    |
|  - Find engine   |                  |  - LanguageClient   |
|  - LSP commands  |                  |  - TreeView API     |
+------------------+                  +--------------------+
        |                                      |
        v                                      v
+--------------------+               +--------------------+
|  HTML/CSS/JS       |               |  LSP Servers       |
|  Frontend          |               |  (child processes) |
|                    |               |                    |
|  - Tab bar         |               |  - JSON-RPC 2.0   |
|  - File explorer   |               |  - stdio transport |
|  - Editor canvas   |               |  - Auto-registered |
|  - Command palette |               |    providers       |
|  - Find/Replace    |               +--------------------+
|  - Output panel    |
|  - Minimap         |
|  - Autocomplete    |
|  - Hover tooltip   |
|  - Signature help  |
|  - References      |
|  - Code actions    |
|  - Symbol outline  |
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
| `window.createStatusBarItem` | Implemented (M4) | Full: IPC + frontend polling + click → command |
| `window.createOutputChannel` | Implemented (M4) | Full: IPC + frontend panel with channel selector |
| `window.createTextEditorDecorationType` | Stub (M4) | Basic plumbing |
| `window.createTreeView` | Implemented (M5) | TreeView with data provider |
| `window.registerTreeDataProvider` | Implemented (M5) | TreeDataProvider interface |
| `Uri` | Implemented (M4) | file/parse/fsPath |
| `Position` / `Range` | Implemented (M4) | |
| `DiagnosticSeverity` | Implemented | Error/Warning/Info/Hint |
| `StatusBarAlignment` | Implemented (M4) | Left/Right |
| `TreeItemCollapsibleState` | Implemented (M5) | None/Collapsed/Expanded |
