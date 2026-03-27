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

## M4: MVP Beta (8 weeks) — COMPLETE

**Goal:** Full single-file editing experience with undo/redo, selection, clipboard, find/replace, more grammars, extension status bar items, and output channels.

### Deliverables (Backend + Extension Host)

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

### Deliverables (Frontend JS wiring)

| Feature | Keybinding | Description |
|:--------|:-----------|:------------|
| Undo/Redo keybindings | Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y | Wired to `edit_undo` / `edit_redo` |
| Selection rendering | Shift+Arrow, Ctrl+A, click-drag, Shift+click | Anchor/head tracking, highlight overlays per line |
| Clipboard | Ctrl+C/X/V | Copy, cut, paste — selection-aware with multi-line support |
| Find/Replace interaction | Ctrl+F, Ctrl+H | Live search, match highlighting, prev/next, replace single/all |
| Status bar polling | — | Polls `get_status_bar_items` every 2s, renders items, click → command |
| Output panel toggle | Ctrl+\` | Toggle panel, poll lines, channel selector, clear/close |

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

## M5: Multi-file Editor (8 weeks) — COMPLETE

**Goal:** Multi-file editing with tabs, file explorer, and workspace-aware IPC protocol.

### Deliverables

| Feature | Description | Status |
|:--------|:------------|:-------|
| **Tab bar** | Multi-file tab strip with open/close/switch, modified indicator (●), Ctrl+Tab / Ctrl+W | Done |
| **Multi-document state** | `WorkspaceState` with `HashMap<PathBuf, DocumentBuffer>`, per-buffer undo stacks | Done |
| **File explorer sidebar** | Directory tree (Ctrl+B), expand/collapse, file/folder icons, click-to-open, Open Folder | Done |
| **TreeView API** | `vscode.window.createTreeView` / `registerTreeDataProvider` in API shim | Done |
| **Workspace-tagged IPC** | Optional `workspace_id` on `DidOpen`/`DidChange`/`DidClose` (defaults "default") | Done |
| **HTML grammar** | tree-sitter-html 0.23 for `.html`, `.htm` | Done |
| **CSS grammar** | tree-sitter-css 0.25 for `.css`, `.scss` | Done |
| **Markdown grammar** | tree-sitter-md 0.5 for `.md` | Done |
| **Minimap** | Scrollbar-side overview with viewport indicator (files > 50 lines) | Done |

### Architecture Changes

- `EditorState` refactored to `WorkspaceState` holding a `HashMap<PathBuf, DocumentBuffer>`
- Active document tracked separately from buffer collection
- Per-buffer cursor, selection, and scroll state managed in frontend JS `Map`
- Tab state managed in frontend JS with Tauri command round-trips
- IPC messages gain optional `workspace_id` field (backward-compatible)
- Opening files no longer closes previous documents — Extension Host sees all open documents

### New Tauri Commands (M5)

```
open_file(path)           → EditorContent  (multi-buffer: doesn't close previous)
close_buffer(path)        → Option<EditorContent>
switch_buffer(path)       → EditorContent
list_open_buffers()       → Vec<BufferInfo>
read_directory(path)      → Vec<DirEntry>
```

---

## M6: Language Intelligence — LSP (8 weeks) — COMPLETE

**Goal:** Full LSP client integration enabling autocomplete, hover, go-to-definition, and code actions.

### Deliverables

| Feature | Description | Status |
|:--------|:------------|:-------|
| **LSP client** | `LanguageClient` class, JSON-RPC 2.0 over stdio, child process management | Done |
| **Request/response IPC** | Correlation IDs with oneshot channels (Rust), async dispatch (Node.js) | Done |
| **CompletionItemProvider** | `registerCompletionItemProvider` → autocomplete popup with icons, detail panel | Done |
| **HoverProvider** | `registerHoverProvider` → hover tooltip on mouse hover (5090ms delay) | Done |
| **Go-to-definition** | `registerDefinitionProvider` → Ctrl+Click / F12, cross-file navigation | Done |
| **Find references** | `registerReferenceProvider` → Shift+F12, floating references panel | Done |
| **Code actions** | `registerCodeActionProvider` → Ctrl+., quick fix menu with workspace edits | Done |
| **Signature help** | `registerSignatureHelpProvider` → parameter hints on `(` and `,` | Done |
| **Document symbols** | `registerDocumentSymbolProvider` → Ctrl+Shift+O outline with filter | Done |
| **Formatting** | `registerDocumentFormattingEditProvider` → Ctrl+Shift+F format | Done |
| **vscode-languageclient shim** | Extensions can `require("vscode-languageclient")` to spawn LSP servers | Done |

### Architecture

```
Frontend ←→ Rust Backend ←→ IPC (req/resp) ←→ Extension Host ←→ LSP Server (child process)
                                                      │
                                                 vscode.languages.*
                                                 registers providers
                                                 that proxy to LSP
```

- **Request/response IPC**: Rust sends `lsp/request` with correlation ID, Extension Host dispatches to providers, returns `lsp/response`
- **LanguageClient**: Spawns LSP servers via stdio, JSON-RPC 2.0 protocol, auto-registers providers based on server capabilities
- **Provider dispatch**: Extension Host matches document selector, invokes provider, serializes result back to Rust
- **Frontend UI**: Autocomplete popup, hover tooltip, signature help, code actions menu, references panel, symbol outline

### New IPC Messages (M6)

```
lsp/request   → {request_id, method, params}   (Rust → Extension Host)
lsp/response  → {request_id, result}            (Extension Host → Rust)
```

### New Tauri Commands (M6)

```
lsp_hover(uri, line, character)                    → HoverResult
lsp_completion(uri, line, character, ...)           → CompletionList
lsp_definition(uri, line, character)                → Location[]
lsp_references(uri, line, character)                → Location[]
lsp_code_action(uri, startLine, ..., endChar)       → CodeAction[]
lsp_signature_help(uri, line, character, ...)       → SignatureHelp
lsp_document_symbols(uri)                           → DocumentSymbol[]
lsp_format(uri, tabSize, insertSpaces)              → TextEdit[]
```

### New Keyboard Shortcuts (M6)

| Shortcut | Action |
|:---------|:-------|
| Ctrl+Space | Trigger autocomplete |
| Enter/Tab | Accept autocomplete item |
| F12 | Go to definition |
| Shift+F12 | Find all references |
| Ctrl+. | Code actions / quick fix |
| Ctrl+Shift+O | Document symbols outline |
| Ctrl+Shift+F | Format document |
| Ctrl+Click | Go to definition (mouse) |

### VS Code API Coverage (M6 additions)

```
vscode.languages
  ├── createDiagnosticCollection         (M2)
  ├── registerCompletionItemProvider     (M6)
  ├── registerHoverProvider              (M6)
  ├── registerDefinitionProvider         (M6)
  ├── registerReferenceProvider          (M6)
  ├── registerCodeActionProvider         (M6)
  ├── registerSignatureHelpProvider      (M6)
  ├── registerDocumentSymbolProvider     (M6)
  └── registerDocumentFormattingEditProvider (M6)

New types: CompletionItemKind, CompletionTriggerKind, SymbolKind,
  CompletionItem, Hover, Location, CodeAction, SignatureHelp,
  DocumentSymbol, TextEdit, WorkspaceEdit, FormattingOptions,
  CancellationTokenSource
```

---

## M7: Native Rendering & Performance (8 weeks) — COMPLETE

**Goal:** Replace HTML DOM-based rendering with GPU-accelerated Canvas2D text rendering. Virtualized content serving for large files.

### Architectural Decision

**Canvas2D chosen over embedded wgpu surface:**
- Chromium's Canvas2D is already GPU-accelerated (Skia + D3D11/Metal/Vulkan)
- Embedding a native wgpu surface inside a Tauri webview has unsolved z-ordering issues with popups/overlays
- The real bottleneck was O(n) line serialization per keystroke, not DOM vs GPU rendering
- All existing features (LSP popups, find/replace, command palette) continue working without platform-specific window management
- Spike code retained in `src/frontend/src/spike/` as benchmark reference

### Deliverables

| Feature | Description | Status |
|:--------|:------------|:-------|
| **Canvas2D text rendering** | DOM `<div class="line">` replaced with `<canvas>` + `fillText()` with per-token coloring | Done |
| **Virtualized backend** | `get_visible_content(first_line, line_count)` — only requested lines highlighted and serialized | Done |
| **Lightweight edit responses** | Edit commands return `EditResult { total_lines, modified }` instead of full content (O(1) vs O(n)) | Done |
| **Virtual scrolling** | Sticky canvas over scroll-sizer div, O(1) scroll position → line range mapping | Done |
| **Content caching** | 30-line buffer zone above/below viewport, fetch on cache miss | Done |
| **O(1) mouse mapping** | Arithmetic `floor(y / lineHeight)` replaces DOM `.line` element iteration | Done |
| **Canvas overlays** | Selection rectangles, find highlights, cursor blink, diagnostic wavy underlines — all on canvas | Done |
| **Gutter canvas** | Line numbers drawn on separate canvas, synced to editor scroll position | Done |
| **Minimap** | Token-density minimap using cached visible lines | Done |
| **Large file support** | Only visible lines fetched/rendered — 100k+ line files load without serializing all content | Done |
| **requestAnimationFrame coalescing** | Multiple render requests batched into single frame via `requestRender()` | Done |
| **Popup positioning** | `getLineBoundsOnScreen()` arithmetic replaces DOM queries for LSP popup placement | Done |

### New Tauri Commands

```
get_visible_content(first_line, line_count) → VisibleContent
```

### Changed Tauri Commands

All edit commands now return `EditResult` instead of `EditorContent`:
```
edit_insert, edit_delete, edit_newline, edit_backspace, edit_undo, edit_redo, edit_replace_range
```

### New Types

```rust
EditResult { total_lines: usize, modified: bool }
VisibleContent { lines: Vec<HighlightedLine>, first_line, total_lines, file_path, language, modified, diagnostics }
```

### Performance Impact

| Metric | Before (M6) | After (M7) |
|:-------|:------------|:-----------|
| Edit response payload | O(n) — all lines serialized | O(1) — just `{ total_lines, modified }` |
| Scroll content fetch | Not applicable (all lines in DOM) | O(visible) — only viewport + 30 buffer lines |
| Mouse hit testing | O(n) DOM traversal | O(1) arithmetic |
| Render per keystroke | Full DOM rebuild (n elements) | Canvas repaint (visible lines only) |

### Remaining (deferred to M8)

| Item | Notes |
|:-----|:------|
| Font ligatures | Requires shaping via HarfBuzz or platform APIs |
| macOS/Linux validation | Build + test on those platforms |
| Profiling baseline | Formal frame-time / startup benchmarks |
| Startup/memory optimization | Measure and optimize further |

---

## M8: Full Platform (8 weeks) — IN PROGRESS

**Goal:** WebView support, integrated terminal, settings UI, extension marketplace, and accessibility.

### Deliverables

| Feature | Description | Priority | Status |
|:--------|:------------|:---------|:-------|
| **Open VSX integration** | Extension marketplace via Open VSX Registry, search, browse | P1 | Done |
| **Extension install/update** | `.vsix` install from marketplace, auto-update checking | P1 | Done |
| **Settings editor UI** | Visual settings editor reading/writing JSON config | P2 | Done |
| **WebView support** | `vscode.window.createWebviewPanel` — embedded HTML views for extensions | P1 | Done |
| **Integrated terminal** | PTY-based terminal emulator panel (xterm.js or custom) | P1 | Done |
| **Accessibility** | Screen reader support: AT-SPI (Linux), NSAccessibility (macOS), UIA (Windows) | P1 | Planned |
| **Keyboard navigation** | Full keyboard-only navigation, focus management, ARIA | P1 | Done |
| **High-contrast themes** | Built-in high-contrast light and dark themes | P2 | Done |
| **Top 20 extension testing** | Full compatibility matrix validation for target extensions | P0 | Planned |
| **Multi-workspace** | Shared Extension Host serving multiple project windows (workspace-scoped routing) | P1 | Planned |

### M8a: Extension Ecosystem (Complete)

| Feature | Description | Files |
|:--------|:------------|:------|
| **Open VSX client** | HTTP client for Open VSX REST API (search, details, download) | `marketplace.rs` |
| **Extension manager** | VSIX download/extract/registry, install/uninstall/update | `extension_mgr.rs` |
| **Settings store** | JSON settings file I/O with dotted key support | `settings.rs` |
| **Activity bar** | Panel switcher: Explorer, Extensions, Settings | `index.html`, `style.css`, `editor.js` |
| **Marketplace UI** | Search, install/uninstall buttons, download counts | `editor.js`, `style.css` |
| **Settings UI** | Live settings editor with type-aware controls | `editor.js`, `style.css` |
| **Multi-directory ext loading** | Extension Host loads bundled + user-installed extensions | `host.ts`, `extension-loader.ts` |
| **Hot-install** | Install extensions without restarting via `extension/installed` IPC | `host.ts`, `extension-loader.ts` |
| **Settings sync** | Setting changes pushed to Extension Host via `settings/changed` IPC | `vscode-api-shim.ts` |

### New Tauri Commands (M8a)

```
marketplace_search(query, offset, limit)         → SearchResult
marketplace_get_extension(namespace, name)        → ExtensionInfo
marketplace_list_installed()                       → Vec<InstalledExtension>
install_extension(namespace, name, download_url)   → InstalledExtension
uninstall_extension(extension_id)                  → ()
check_extension_updates()                          → Vec<ExtensionUpdateInfo>
get_extensions_dir()                               → String
get_settings()                                     → Value
update_setting(key, value)                         → ()
reset_setting(key)                                 → ()
get_setting_definitions()                          → Value
```

### New IPC Messages (M8a)

```
extension/installed    (Rust → Extension Host)  { path: string }
extension/uninstalled  (Rust → Extension Host)  { id: string }
settings/changed       (Rust → Extension Host)  { key: string, value: any }
```

### New Keyboard Shortcuts (M8a)

| Shortcut | Action |
|:---------|:-------|
| Ctrl+Shift+X | Open Extensions panel |
| Ctrl+, | Open Settings panel |

### M8b: WebView, Terminal, Themes, ARIA (Complete)

| Feature | Description | Files |
|:--------|:------------|:------|
| **Integrated terminal** | PTY-based terminal panel via `portable-pty` (ConPTY/Unix), xterm.js frontend, multi-session tabs | `terminal.rs`, `editor.js`, `index.html` |
| **WebView support** | `vscode.window.createWebviewPanel` — iframe panels with `acquireVsCodeApi`, bidirectional postMessage | `ipc_bridge.rs`, `lib.rs`, `vscode-api-shim.ts`, `editor.js` |
| **High-contrast themes** | `hc-dark` and `hc-light` CSS classes with full token color overrides | `style.css` |
| **Keyboard navigation / ARIA** | `role=tablist/tab/main/textbox/dialog/search/toolbar`, `aria-label`, focus rings, `.sr-only` | `index.html`, `style.css` |

### New Tauri Commands (M8b)

```
terminal_create(cwd, shell, cols, rows)     → String  (terminal ID)
terminal_write(terminal_id, data)           → ()
terminal_resize(terminal_id, cols, rows)    → ()
terminal_close(terminal_id)                 → ()
terminal_list()                             → Vec<TerminalInfo>
get_webview_events()                        → Vec<WebviewPanelEvent>
webview_post_message(panel_id, message)     → ()
webview_close_by_user(panel_id)             → ()
```

### New IPC Messages (M8b)

```
webview/create          (Extension Host → Rust)  { panel_id, view_type, title, column, enable_scripts }
webview/setHtml         (Extension Host → Rust)  { panel_id, html }
webview/postMessage     (Extension Host → Rust)  { panel_id, message }
webview/reveal          (Extension Host → Rust)  { panel_id, column? }
webview/close           (Extension Host → Rust)  { panel_id }
webview/messageFromWebview (Rust → Extension Host) { panel_id, message }
webview/closedByUser    (Rust → Extension Host)  { panel_id }
```

### New Tauri Events (M8b)

```
terminal-data   → { terminal_id, data }    (PTY output → xterm.js write)
terminal-exit   → { terminal_id, exit_code? }
```

### VS Code API Coverage (M8b additions)

```
vscode.window
  ├── createWebviewPanel(viewType, title, showOptions, options)
  │     → WebviewPanel.webview.html (setter)
  │     → WebviewPanel.webview.postMessage(message)
  │     → WebviewPanel.webview.onDidReceiveMessage
  │     → WebviewPanel.reveal(column?)
  │     → WebviewPanel.dispose()
  │     → WebviewPanel.onDidDispose
  ├── (terminal omitted — exposed via integrated terminal UI, not vscode.window.createTerminal yet)
  └── ...

vscode.ViewColumn  (Active, Beside, One, Two, Three)
```

### Multi-workspace Architecture (from M5 IPC groundwork)

```
Window 1 (Project A) ──┐
Window 2 (Project B) ──┼── Shared Extension Host ──┬── LSP Server (shared, multi-root)
Window 3 (Project C) ──┘        │                   └── LSP Server (per-workspace)
                          workspaceId routing
                          per-workspace config
                          per-workspace diagnostics
```

Memory: O(extensions + N × LSP-servers) instead of O(N × extensions).

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
| HTML | `.html`, `.htm` | tree-sitter-html 0.23 | M5 |
| CSS | `.css`, `.scss` | tree-sitter-css 0.25 | M5 |
| Markdown | `.md` | tree-sitter-md 0.5 | M5 |
