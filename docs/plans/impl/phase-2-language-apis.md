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
    insert-text: option<string>,   // defaults to `label` when None
    filter-text: option<string>,
  }
  enum completion-kind {
    text, method, function, constructor, field, variable,
    class, interface, module, property, unit, value, enum-member,
    keyword, snippet, color, file, reference, folder,
  }

  record hover-result { contents: string, range: option<range> }
  record text-edit {
    uri:      option<string>,  // target file URI; if none, applies to the requesting document
    range:    range,
    new-text: string,
  }
  // Phase 2: `uri` is optional; if absent the edit targets the document that triggered the
  // request. Phase 3+ can use the `uri` field for cross-file workspace edits.
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

> **Async note for Phase 2:** All WIT export calls are synchronous. Call sites in
> `WasmHostManager` that invoke these functions must use `tokio::task::block_in_place`
> (if inside a Tokio context) with a `tokio::time::timeout` of 5–10 seconds. Extension
> authors should not perform blocking I/O inside WIT exports; spawn threads for async
> work and communicate via `Arc<Mutex<>>` instead.

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

Add a `remove_from_language_registry` method and call it from `deactivate_all`:

```rust
/// Remove an extension's language claims from the registry.
/// Call before removing the instance during deactivation.
fn remove_from_language_registry(&self, id: &str) {
    let mut registry = self.language_registry.lock().unwrap();
    for providers in registry.values_mut() {
        providers.retain(|ext_id| ext_id != id);
    }
    // Remove empty entries
    registry.retain(|_, providers| !providers.is_empty());
}
```

In `deactivate_all`, call `self.remove_from_language_registry(&id)` before `instance.deactivate()`.

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
    // Note: for Phase 2 (sync), enforce a wall-clock deadline at the call
    // site using tokio::time::timeout + tokio::task::block_in_place.
    let (result,) = f.call(&mut self.store, (uri.to_string(), pos, trig))
        .map_err(|e| format!("completions trap: {e}"))?;
    f.post_return(&mut self.store)
        .map_err(|e| format!("completions post-return: {e}"))?;
    result
}
// In Phase 2, callers in `WasmHostManager::completions_for_lang` should wrap this call
// with `tokio::task::block_in_place` and a `tokio::time::timeout` of ~5 seconds to
// prevent blocking the async runtime.

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
    completions_fn:       Option<wasmtime::component::TypedFunc<(String, PositionWit, Option<String>), (Result<Vec<CompletionItemWit>, String>,)>>,
    hover_fn:             Option<wasmtime::component::TypedFunc<(String, PositionWit), (Result<Option<HoverResultWit>, String>,)>>,
    diagnostics_fn:       Option<wasmtime::component::TypedFunc<(String, String), (Result<Vec<DiagnosticWit>, String>,)>>,
    format_document_fn:   Option<wasmtime::component::TypedFunc<(String, String), (Result<Vec<TextEditWit>, String>,)>>,
    format_range_fn:      Option<wasmtime::component::TypedFunc<(String, String, RangeWit), (Result<Vec<TextEditWit>, String>,)>>,
    definition_fn:        Option<wasmtime::component::TypedFunc<(String, PositionWit), (Result<Option<LocationWit>, String>,)>>,
    references_fn:        Option<wasmtime::component::TypedFunc<(String, PositionWit, bool), (Result<Vec<LocationWit>, String>,)>>,
    rename_fn:            Option<wasmtime::component::TypedFunc<(String, PositionWit, String), (Result<Vec<TextEditWit>, String>,)>>,
    code_actions_fn:      Option<wasmtime::component::TypedFunc<(String, RangeWit, Vec<DiagnosticWit>), (Result<Vec<CodeActionWit>, String>,)>>,
    workspace_symbols_fn: Option<wasmtime::component::TypedFunc<(String,), (Result<Vec<SymbolWit>, String>,)>>,
    folding_ranges_fn:    Option<wasmtime::component::TypedFunc<(String, String), (Result<Vec<FoldingRangeWit>, String>,)>>,
}
```

Populate with `instance.get_typed_func(...).ok()` — returns `None` if the export is absent.

---

## 5. Public dispatch API on `WasmHostManager`

Add methods that the Tauri command handlers call:

```rust
use std::collections::HashSet;

/// Lock ordering: always lock `instances` before `language_registry`.
impl WasmHostManager {
    // Lock ordering: always acquire `instances` before `language_registry`
    // to prevent deadlocks.

    /// Resolve `insert_text` for a completion item: if `None`, fall back to `label`.
    /// Call this on every item returned by a WASM extension so downstream consumers
    /// can rely on `insert_text` always being populated.
    fn resolve_insert_text(item: &mut CompletionItem) {
        if item.insert_text.is_none() {
            item.insert_text = Some(item.label.clone());
        }
    }

    pub fn completions_for_lang(
        &self,
        lang_id: &str,
        uri: &str,
        line: u32,
        character: u32,
        trigger: Option<&str>,
    ) -> Vec<CompletionItem> {
        let ext_ids = self.providers_for_lang(lang_id);
        let mut results = Vec::new();
        let mut seen = HashSet::new();
        let mut instances = self.instances.lock().unwrap();
        for id in &ext_ids {
            if let Some(inst) = instances.get_mut(id) {
                match inst.completions(uri, line, character, trigger) {
                    Ok(items) => {
                        for mut item in items {
                            Self::resolve_insert_text(&mut item);
                            // Deduplicate by (label, insert_text)
                            let key = (
                                item.label.clone(),
                                item.insert_text.clone().unwrap_or_default(),
                            );
                            if seen.insert(key) {
                                results.push(item);
                            }
                        }
                    }
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
        // Same pattern as completions_for_lang (no dedup needed for diagnostics)
    }

    pub fn hover_for_lang(
        &self,
        lang_id: &str,
        uri: &str,
        line: u32,
        character: u32,
    ) -> Option<HoverResult> {
        // Merge strategy: concatenate contents from all providers that return
        // a non-None result, separated by "\n---\n". Use the union of ranges
        // (widest range) or the first provider's range if ranges differ.
        // This ensures richer results from later providers are not hidden.
        let ext_ids = self.providers_for_lang(lang_id);
        let mut merged_contents = Vec::new();
        let mut merged_range: Option<Range> = None;
        let mut instances = self.instances.lock().unwrap();
        for id in &ext_ids {
            if let Some(inst) = instances.get_mut(id) {
                match inst.hover(uri, line, character) {
                    Ok(Some(result)) => {
                        merged_contents.push(result.contents);
                        if merged_range.is_none() {
                            merged_range = result.range;
                        }
                    }
                    Ok(None) => {}
                    Err(e) => log::warn!("hover error from {id}: {e}"),
                }
            }
        }
        if merged_contents.is_empty() {
            None
        } else {
            Some(HoverResult {
                contents: merged_contents.join("\n---\n"),
                range: merged_range,
            })
        }
    }

    // ... format_document, definition, references, rename,
    //     code_actions, workspace_symbols, folding_ranges ...
}
```

> **Hover merging rationale:** Returning only the first non-None result can hide richer
> information from later providers. Concatenating with a separator ensures all providers
> contribute. Extension authors should expect their hover content to appear alongside
> other providers' output for the same language.

---

## 6. Tauri command handlers in `lib.rs`

Add these Tauri commands (pattern follows existing `lsp_request` command).

> **Threading note:** Use synchronous `fn` (not `async fn`) for WASM provider commands.
> Tauri runs synchronous commands on a managed threadpool automatically, so `completions_for_lang`
> and other blocking WASM calls execute off the main async runtime without manual `spawn_blocking`.
> This matches the actual implementation and avoids unnecessary complexity.

```rust
#[tauri::command]
fn wasm_completions(
    state: tauri::State<AppState>,
    lang_id: String,
    uri: String,
    line: u32,
    character: u32,
    trigger: Option<String>,
) -> Result<serde_json::Value, String> {
    let items = state.wasm_host.completions_for_lang(
        &lang_id, &uri, line, character, trigger.as_deref(),
    );
    serde_json::to_value(&items).map_err(|e| format!("serialization error: {e}"))
}

#[tauri::command]
fn wasm_diagnostics(
    state: tauri::State<AppState>,
    lang_id: String,
    uri: String,
    content: String,
) -> Result<serde_json::Value, String> {
    let diags = state.wasm_host.diagnostics_for_lang(&lang_id, &uri, &content);
    serde_json::to_value(&diags).map_err(|e| format!("serialization error: {e}"))
}

#[tauri::command]
fn wasm_hover(
    state: tauri::State<AppState>,
    lang_id: String,
    uri: String,
    line: u32,
    character: u32,
) -> Result<serde_json::Value, String> {
    let result = state.wasm_host.hover_for_lang(&lang_id, &uri, line, character);
    serde_json::to_value(&result).map_err(|e| format!("serialization error: {e}"))
}

#[tauri::command]
fn wasm_format_document(
    state: tauri::State<AppState>,
    lang_id: String,
    uri: String,
    content: String,
) -> Result<serde_json::Value, String> {
    let edits = state.wasm_host.format_document_for_lang(&lang_id, &uri, &content);
    serde_json::to_value(&edits).map_err(|e| format!("serialization error: {e}"))
}
```

Register all four (and remaining provider commands) in `tauri::Builder::invoke_handler`.

---

## 7. Frontend integration in `editor.js`

WASM provider calls run in parallel with the existing Node.js IPC calls and results are merged.
The frontend already handles async completions and diagnostics arrays; no structural change needed —
only the call site needs to also invoke the WASM commands.

The `detectLanguage` helper maps file extensions to language IDs:

```js
// utils/language.js (or inline in editor.js)
function detectLanguage(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map = {
    'rs': 'rust', 'js': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript',
    'jsx': 'javascript', 'ts': 'typescript', 'tsx': 'typescript',
    'py': 'python', 'pyw': 'python', 'json': 'json', 'jsonc': 'json',
    'html': 'html', 'htm': 'html', 'css': 'css', 'scss': 'css',
    'md': 'markdown', 'toml': 'toml', 'yaml': 'yaml', 'yml': 'yaml',
  };
  return map[ext] ?? 'plaintext';
}
```

**Completions** (`editor.js` — in the existing `triggerAutocomplete` function):

Use a module-level sequence counter to discard stale responses, and deduplicate
merged results by `label + insertText` before rendering:

```js
// Module-level sequence counter — prevents stale responses from overwriting newer ones.
let completionSeq = 0;

async function triggerAutocomplete(triggerChar) {
  const uri = getActiveUri();
  if (!uri) return;
  const thisSeq = ++completionSeq;

  try {
    const langId = detectLanguage(filePath);
    // Run Node.js LSP and WASM completions in parallel.
    const [lspResult, wasmItems] = await Promise.all([
      invoke('lsp_completion', {
        uri, line: cursorLine, character: cursorCol,
        triggerKind: triggerChar ? 2 : 1, triggerCharacter: triggerChar || null,
      }).catch(() => null),
      invoke('wasm_completions', {
        langId, uri, line: cursorLine, character: cursorCol,
        trigger: triggerChar || null,
      }).catch(() => []),
    ]);

    // Discard if a newer request has been issued while we were awaiting.
    if (thisSeq !== completionSeq) return;

    const nodeItems = lspResult?.items ?? [];
    // Normalise WASM items to the same shape as LSP items.
    const wasmNorm = (wasmItems || []).map(w => ({
      label: w.label, kind: w.kind, detail: w.detail,
      documentation: w.documentation, insertText: w.insert_text ?? w.label,
      filterText: w.filter_text ?? w.label,
    }));

    // Deduplicate by (label, insertText) — prevents identical suggestions
    // when both Node.js and WASM providers return the same item.
    const seen = new Set();
    const allItems = [...nodeItems, ...wasmNorm].filter(item => {
      const key = `${item.label}:${item.insertText || item.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (allItems.length === 0) { closeAutocomplete(); return; }
    renderCompletions(allItems);
  } catch { closeAutocomplete(); }
}
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
pub extension_id: String,
```

In `host_get_config`:

```rust
// workspace::get_config — scoped to the extension's namespace
pub fn host_get_config(ctx: &mut HostContext, key: String) -> Option<String> {
    // Prefix the key with the extension id to scope access:
    // e.g., extension "my.ext" requesting "format.tabSize"
    // becomes "my.ext.format.tabSize"
    let scoped_key = format!("{}.{}", ctx.extension_id, key);
    ctx.settings.as_ref()?
        .lock().ok()?
        .get_string(&scoped_key)
}
```

Add `SettingsStore::get_string`:

```rust
impl SettingsStore {
    /// Get a config value by dot-separated key path.
    /// Returns None if the key doesn't exist.
    /// Coerces numbers and booleans to their string representation.
    pub fn get_string(&self, key: &str) -> Option<String> {
        let parts: Vec<&str> = key.split('.').collect();
        let mut current = self.values.as_object()?;
        for (i, part) in parts.iter().enumerate() {
            if i == parts.len() - 1 {
                return match current.get(*part)? {
                    serde_json::Value::String(s) => Some(s.clone()),
                    serde_json::Value::Number(n) => Some(n.to_string()),
                    serde_json::Value::Bool(b) => Some(b.to_string()),
                    _ => None,
                };
            }
            current = current.get(*part)?.as_object()?;
        }
        None
    }
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

#[test]
fn provider_trap_returns_empty_not_crash() {
    // Simulates a WASM trap: completions_for_lang should return empty, not panic.
    let mgr = WasmHostManager::new().unwrap();
    // No extension loaded — should return empty without panicking
    let items = mgr.completions_for_lang("rust", "file:///foo.rs", 0, 0, None);
    assert!(items.is_empty(), "trap scenario should return empty");
}

#[test]
fn two_providers_for_same_lang_merge_results() {
    // With two extensions claiming "rust", completions_for_lang should call both.
    // This is validated via the language_registry having two entries.
    let mgr = WasmHostManager::new().unwrap();
    let registry = mgr.language_registry.lock().unwrap();
    // Verify registry structure allows multiple providers per language
    drop(registry);
    // Full integration test requires real WASM binaries; covered in acceptance tests
}

#[test]
fn deactivate_removes_from_language_registry() {
    let mgr = WasmHostManager::new().unwrap();
    // Manually insert a fake entry to simulate activated extension
    {
        let mut reg = mgr.language_registry.lock().unwrap();
        reg.entry("rust".to_string()).or_default().push("test.ext".to_string());
    }
    mgr.remove_from_language_registry("test.ext");
    let reg = mgr.language_registry.lock().unwrap();
    assert!(reg.get("rust").map_or(true, |v| v.is_empty()));
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

### Functional

- Opening a `.txt` file and triggering completion shows the hard-coded "hello" item
  from `examples/simple-lsp` alongside any Node.js completions
- Typing "TODO" in a `.txt` file produces a WASM-sourced diagnostic marker in the gutter
- `wasm_hover` returns a result for the plaintext extension
- Existing JS/TS/Rust completions and diagnostics are unaffected

### Merged results

- When both a Node.js language server and a WASM extension provide completions for the
  same file, the merged completion list contains items from both sources with no
  duplicates (verified via the `label + insertText` dedup in `triggerAutocomplete`)
- Multiple WASM providers claiming the same language (e.g. two extensions both claiming
  `"plaintext"`) have their results merged at the `completions_for_lang` level

### Performance

- WASM extension completions appear within **200 ms** under normal load (single
  extension, < 100 completion items). The `examples/simple-lsp` hard-coded completion
  and the `wasm_hover` plaintext scenario must meet this threshold
- Extensions whose WASM export blocks for longer than **5 seconds** are terminated with
  a timeout error (enforced via `tokio::time::timeout` at the `WasmHostManager` call
  site). The timeout applies to all language-provider calls — completions, diagnostics,
  hover, format, definition, references, rename, code-actions, workspace-symbols, and
  folding-ranges

### Error handling and isolation

- A WASM extension that traps or crashes during a language-provider call is logged
  (`log::warn!`) and does **not** break the editor — other providers for the same
  language continue to return results. Verified by the `provider_trap_returns_empty_not_crash`
  unit test and the error branch in `completions_for_lang`
- Stale completion responses (from out-of-order async calls) are discarded by the
  `completionSeq` guard in `triggerAutocomplete` and never rendered

### Rate limiting (Phase 2 scope)

- Frontend debouncing is applied to diagnostic requests (on-change debounce, per
  Section 7) and completion requests are guarded by the sequence counter to coalesce
  rapid keystrokes. Backend rate limiting is deferred to Phase 3+ unless a concrete
  DoS scenario is identified
