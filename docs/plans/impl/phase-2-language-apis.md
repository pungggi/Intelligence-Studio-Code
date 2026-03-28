# Phase 2 — Language Provider APIs

**Goal:** A WASM extension can provide completions, hover, diagnostics, formatting,
go-to-definition, references, rename, code actions, workspace symbols, and folding ranges.

**Depends on:** Phase 1 (WASM Host Foundation)

---

## 1. Extend the WIT file

File: `src/app/src-tauri/wit/corecode.wit`

Add the full `language-provider` interface and extend `workspace` with `get-config`:

```wit
// Add to existing wit/corecode.wit

interface types {
  record position   { line: u32, character: u32 }
  record range      { start: position, end: position }
  record location   { uri: string, range: range }

  record diagnostic {
    range: range,
    severity: severity,
    message: string,
    source: option<string>,
    code: option<string>,
  }
  enum severity { error, warning, information, hint }

  record completion-item {
    label: string,
    kind: option<completion-kind>,
    detail: option<string>,
    documentation: option<string>,
    insert-text: string,
    filter-text: option<string>,
  }
  enum completion-kind {
    text, method, function, constructor, field, variable,
    class, interface, module, property, unit, value, enum-member,
    keyword, snippet, color, file, reference, folder,
  }

  record hover-result { contents: string, range: option<range> }
  record text-edit    { range: range, new-text: string }
  record code-action  { title: string, kind: option<string>, edits: list<text-edit> }

  record symbol {
    name: string,
    kind: symbol-kind,
    location: location,
    container-name: option<string>,
  }
  enum symbol-kind {
    file, module, namespace, package, class, method, property,
    field, constructor, enum, interface, function, variable,
    constant, string, number, boolean, array, object, key, null,
    enum-member, struct, event, operator, type-parameter,
  }

  record folding-range {
    start-line: u32,
    end-line: u32,
    kind: option<string>,
  }
}

interface language-provider {
  use types.{
    position, range, completion-item, hover-result,
    diagnostic, text-edit, code-action, location,
    symbol, folding-range,
  };

  completions:       func(uri: string, pos: position, trigger: option<string>)
                       -> result<list<completion-item>, string>;
  hover:             func(uri: string, pos: position)
                       -> result<option<hover-result>, string>;
  diagnostics:       func(uri: string, content: string)
                       -> result<list<diagnostic>, string>;
  format-document:   func(uri: string, content: string)
                       -> result<list<text-edit>, string>;
  format-range:      func(uri: string, content: string, range: range)
                       -> result<list<text-edit>, string>;
  definition:        func(uri: string, pos: position)
                       -> result<option<location>, string>;
  references:        func(uri: string, pos: position, include-decl: bool)
                       -> result<list<location>, string>;
  rename:            func(uri: string, pos: position, new-name: string)
                       -> result<list<text-edit>, string>;
  code-actions:      func(uri: string, range: range, diagnostics: list<diagnostic>)
                       -> result<list<code-action>, string>;
  workspace-symbols: func(query: string)
                       -> result<list<symbol>, string>;
  folding-ranges:    func(uri: string, content: string)
                       -> result<list<folding-range>, string>;
}

// Update world to include language-provider as optional export:
world corecode-extension {
  import ui;
  import workspace;
  export lifecycle;
  export language-provider;   // optional
}
```

---

## 2. Language claim in `corecode.toml`

Extensions claim which language IDs they handle. The WASM host uses this to route
editor events to the correct extension. Multiple extensions can claim the same language;
the host calls all of them and merges results (completions, code actions) or uses the
first non-null response (hover, definition).

```toml
# In corecode.toml:
[languages]
rust       = true
toml       = true
```

---

## 3. Language registry in `manager.rs`

Add to `WasmHostManager`:

```rust
use std::collections::HashMap;

/// Map from language-id (e.g. "rust") to the extension ids that claim it.
language_registry: Mutex<HashMap<String, Vec<String>>>,
```

Populate during `activate_one()`:

```rust
let langs: Vec<String> = manifest.languages
    .iter()
    .filter(|(_, &v)| v)
    .map(|(k, _)| k.clone())
    .collect();

for lang in &langs {
    self.language_registry
        .lock().unwrap()
        .entry(lang.clone())
        .or_default()
        .push(id.clone());
}
```

---

## 4. Language provider dispatch methods on `WasmInstance`

Add to `instance.rs` (all follow the same pattern; shown for `completions` and `diagnostics`):

```rust
use crate::ipc_bridge::{Diagnostic as IpcDiagnostic, DiagnosticSeverity};

/// Call language-provider#completions if the export is present.
pub fn completions(
    &mut self,
    uri: &str,
    line: u32,
    character: u32,
    trigger: Option<&str>,
) -> Result<Vec<CompletionItemWit>, String> {
    let f = match self.completions_fn.as_ref() {
        Some(f) => f.clone(),
        None => return Ok(vec![]),
    };
    let pos = PositionWit { line, character };
    let trig = trigger.map(|s| s.to_string());
    let (result,) = f.call(&mut self.store, (uri.to_string(), pos, trig))
        .map_err(|e| format!("completions trap: {e}"))?;
    f.post_return(&mut self.store)
        .map_err(|e| format!("completions post-return: {e}"))?;
    result
}

pub fn diagnostics(
    &mut self,
    uri: &str,
    content: &str,
) -> Result<Vec<DiagnosticWit>, String> {
    let f = match self.diagnostics_fn.as_ref() {
        Some(f) => f.clone(),
        None => return Ok(vec![]),
    };
    let (result,) = f.call(&mut self.store, (uri.to_string(), content.to_string()))
        .map_err(|e| format!("diagnostics trap: {e}"))?;
    f.post_return(&mut self.store)
        .map_err(|e| format!("diagnostics post-return: {e}"))?;
    result
}
```

Store optional typed function handles on `WasmInstance`:

```rust
pub struct WasmInstance {
    // ... existing fields ...

    // Optional language-provider exports — None if not exported
    completions_fn:       Option<wasmtime::component::TypedFunc<...>>,
    hover_fn:             Option<wasmtime::component::TypedFunc<...>>,
    diagnostics_fn:       Option<wasmtime::component::TypedFunc<...>>,
    format_document_fn:   Option<wasmtime::component::TypedFunc<...>>,
    format_range_fn:      Option<wasmtime::component::TypedFunc<...>>,
    definition_fn:        Option<wasmtime::component::TypedFunc<...>>,
    references_fn:        Option<wasmtime::component::TypedFunc<...>>,
    rename_fn:            Option<wasmtime::component::TypedFunc<...>>,
    code_actions_fn:      Option<wasmtime::component::TypedFunc<...>>,
    workspace_symbols_fn: Option<wasmtime::component::TypedFunc<...>>,
    folding_ranges_fn:    Option<wasmtime::component::TypedFunc<...>>,
}
```

Populate with `instance.get_typed_func(...).ok()` — returns `None` if the export is absent.

---

## 5. Public dispatch API on `WasmHostManager`

Add methods that the Tauri command handlers call:

```rust
impl WasmHostManager {
    pub fn completions_for_lang(
        &self,
        lang_id: &str,
        uri: &str,
        line: u32,
        character: u32,
        trigger: Option<&str>,
    ) -> Vec<CompletionItemWit> {
        let ext_ids = {
            let registry = self.language_registry.lock().unwrap();
            registry.get(lang_id).cloned().unwrap_or_default()
        };
        let mut results = Vec::new();
        let mut instances = self.instances.lock().unwrap();
        for id in &ext_ids {
            if let Some(inst) = instances.get_mut(id) {
                match inst.completions(uri, line, character, trigger) {
                    Ok(items) => results.extend(items),
                    Err(e) => log::warn!("completions error from {id}: {e}"),
                }
            }
        }
        results
    }

    pub fn diagnostics_for_lang(
        &self,
        lang_id: &str,
        uri: &str,
        content: &str,
    ) -> Vec<DiagnosticWit> {
        // Same pattern as completions_for_lang
    }

    pub fn hover_for_lang(
        &self,
        lang_id: &str,
        uri: &str,
        line: u32,
        character: u32,
    ) -> Option<HoverResultWit> {
        // Returns first non-None response
    }

    // ... format_document, definition, references, rename,
    //     code_actions, workspace_symbols, folding_ranges ...
}
```

---

## 6. Tauri command handlers in `lib.rs`

Add these Tauri commands (pattern follows existing `lsp_request` command):

```rust
#[tauri::command]
async fn wasm_completions(
    state: tauri::State<'_, AppState>,
    lang_id: String,
    uri: String,
    line: u32,
    character: u32,
    trigger: Option<String>,
) -> Result<serde_json::Value, String> {
    let items = state.wasm_host.completions_for_lang(
        &lang_id, &uri, line, character, trigger.as_deref()
    );
    Ok(serde_json::to_value(items).unwrap())
}

#[tauri::command]
async fn wasm_diagnostics(
    state: tauri::State<'_, AppState>,
    lang_id: String,
    uri: String,
    content: String,
) -> Result<serde_json::Value, String> {
    let diags = state.wasm_host.diagnostics_for_lang(&lang_id, &uri, &content);
    Ok(serde_json::to_value(diags).unwrap())
}

#[tauri::command]
async fn wasm_hover(
    state: tauri::State<'_, AppState>,
    lang_id: String,
    uri: String,
    line: u32,
    character: u32,
) -> Result<serde_json::Value, String> {
    let result = state.wasm_host.hover_for_lang(&lang_id, &uri, line, character);
    Ok(serde_json::to_value(result).unwrap())
}

#[tauri::command]
async fn wasm_format_document(
    state: tauri::State<'_, AppState>,
    lang_id: String,
    uri: String,
    content: String,
) -> Result<serde_json::Value, String> {
    let edits = state.wasm_host.format_document_for_lang(&lang_id, &uri, &content);
    Ok(serde_json::to_value(edits).unwrap())
}
```

Register all four (and remaining provider commands) in `tauri::Builder::invoke_handler`.

---

## 7. Frontend integration in `editor.js`

WASM provider calls run in parallel with the existing Node.js IPC calls and results are merged.
The frontend already handles async completions and diagnostics arrays; no structural change needed —
only the call site needs to also invoke the WASM commands.

**Completions** (`editor.js` — in the existing `requestCompletions` function):

```js
// Existing Node.js call:
const nodeItems = await invoke('lsp_request', { method: 'textDocument/completion', ... });

// New: WASM call (non-blocking; merge results)
const wasmItems = await invoke('wasm_completions', {
  langId: detectLanguage(currentFile),
  uri: currentUri,
  line: cursor.line,
  character: cursor.character,
  trigger: triggerChar ?? null,
}).catch(() => []);

const allItems = [...(nodeItems?.items ?? []), ...wasmItems];
```

**Diagnostics** (`editor.js` — on save / on change debounce):

```js
const wasmDiags = await invoke('wasm_diagnostics', {
  langId: detectLanguage(currentFile),
  uri: currentUri,
  content: getCurrentContent(),
}).catch(() => []);

// Merge with existing Node.js diagnostics before rendering
mergeAndRenderDiagnostics([...nodeDiags, ...wasmDiags]);
```

---

## 8. Async note

Phase 2 uses synchronous `wasmtime` calls (no `async_support`). WASM extensions that
need to do async work (e.g. LSP subprocess calls) must maintain internal state across
synchronous calls using standard Rust patterns (channels, `Arc<Mutex<>>`).

Enabling `async_support` in Phase 2 is optional; it would allow WASM functions to yield
to the Tokio runtime, but adds complexity. Defer unless a concrete extension requires it.

---

## 9. `workspace::get_config` implementation

Complete the stub from Phase 1 by wiring to `SettingsStore`:

In `api_impl.rs`, update `HostContext`:

```rust
pub settings: Option<Arc<Mutex<crate::settings::SettingsStore>>>,
```

In `host_get_config`:

```rust
pub fn host_get_config(ctx: &mut HostContext, key: String) -> Option<String> {
    ctx.settings.as_ref()?
        .lock().ok()?
        .get_string(&key)  // add this method to SettingsStore
}
```

---

## 10. Tests

### Unit tests in `manager.rs`

```rust
#[test]
fn language_registry_populated_from_manifest() {
    // Create a manager; manually insert a mock instance with language claims
    // Verify language_registry maps "rust" -> ["test.ext"]
}

#[test]
fn completions_returns_empty_for_unknown_lang() {
    let mgr = WasmHostManager::new().unwrap();
    let items = mgr.completions_for_lang("cobol", "file:///x.cbl", 0, 0, None);
    assert!(items.is_empty());
}

#[test]
fn diagnostics_returns_empty_for_unknown_lang() {
    let mgr = WasmHostManager::new().unwrap();
    let diags = mgr.diagnostics_for_lang("cobol", "file:///x.cbl", "");
    assert!(diags.is_empty());
}
```

### Integration example extension

Create `examples/simple-lsp/` — a WASM extension that:
1. Claims the `"plaintext"` language (easy to test without a real LSP)
2. Returns one hard-coded completion item: `{ label: "hello", insert_text: "hello" }`
3. Returns one hard-coded diagnostic for any file containing the word "TODO"

This can be manually tested in CoreCode without any language server process.

---

## 11. Acceptance criteria

- Opening a `.txt` file and triggering completion shows the hard-coded "hello" item
  from `examples/simple-lsp` alongside any Node.js completions
- Typing "TODO" in a `.txt` file produces a WASM-sourced diagnostic marker in the gutter
- `wasm_hover` returns a result for the plaintext extension
- Existing JS/TS/Rust completions and diagnostics are unaffected
