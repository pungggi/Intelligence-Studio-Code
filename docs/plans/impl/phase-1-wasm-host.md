# Phase 1 — WASM Host Foundation

**Goal:** A WASM extension can activate and deactivate. No language APIs yet.

---

## 1. Cargo.toml changes

File: `src/app/src-tauri/Cargo.toml`

Add to `[dependencies]`:

```toml
# WASM extension host
wasmtime        = { version = "25", features = ["component-model"] }
wasmtime-wasi   = { version = "25", features = ["preview2"] }
wit-bindgen-rt  = { version = "0.26", features = ["bitflags"] }

# corecode.toml manifest parsing
toml = "0.8"
```

Add to `[build-dependencies]`:

```toml
wit-bindgen-generate = "0.26"   # not strictly needed at build time; see note below
```

> **Note on code generation:** `wit-bindgen` can generate Rust bindings at build time via
> a `build.rs` script, or the bindings can be committed as generated source. For the initial
> implementation, generate once and commit; add the build-time step in Phase 2 when the WIT
> file stabilises.

---

## 2. WIT file

Create: `src/app/src-tauri/wit/corecode.wit`

Start with only lifecycle and the two host imports needed for the hello-world example:

```wit
package corecode:extension@0.1.0;

interface lifecycle {
  activate:   func() -> result<_, string>;
  deactivate: func();
}

interface ui {
  log:          func(channel: string, message: string);
  show-message: func(level: string, message: string);
  set-status:   func(id: string, text: string, tooltip: option<string>);
}

interface workspace {
  read-file:  func(path: string) -> result<string, string>;
  find-files: func(glob: string) -> result<list<string>, string>;
  root-uri:   func() -> string;
  get-config: func(key: string) -> option<string>;
}

world corecode-extension {
  import ui;
  import workspace;
  export lifecycle;
}
```

---

## 3. New module tree

Create the following files under `src/app/src-tauri/src/wasm_host/`:

```
src/app/src-tauri/src/wasm_host/
  mod.rs          ← public API + re-exports
  manager.rs      ← WasmHostManager: Engine, load/unload
  instance.rs     ← WasmInstance: per-extension Store + linker
  api_impl.rs     ← Host-side implementations of ui + workspace imports
  manifest.rs     ← CoreCodeManifest: parse corecode.toml
```

Add to `src/app/src-tauri/src/lib.rs`:

```rust
mod wasm_host;
```

---

## 4. `manifest.rs`

```rust
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
pub struct CoreCodeManifest {
    pub extension: ExtensionMeta,
    pub entry: EntryConfig,
    #[serde(default)]
    pub capabilities: Capabilities,
    #[serde(default)]
    pub languages: std::collections::HashMap<String, bool>,
}

#[derive(Debug, Deserialize)]
pub struct ExtensionMeta {
    pub id: String,
    pub name: String,
    pub version: String,
}

#[derive(Debug, Deserialize)]
pub struct EntryConfig {
    pub wasm: String,   // relative path to the .wasm file
}

#[derive(Debug, Default, Deserialize)]
pub struct Capabilities {
    #[serde(default)]
    pub workspace_read: bool,
    #[serde(default)]
    pub network_fetch: bool,
    #[serde(default)]
    pub webview_panels: bool,
}

impl CoreCodeManifest {
    pub fn load(ext_dir: &Path) -> Result<Self, String> {
        let path = ext_dir.join("corecode.toml");
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("Cannot read corecode.toml: {e}"))?;
        let manifest: CoreCodeManifest = toml::from_str(&text)
            .map_err(|e| format!("Invalid corecode.toml: {e}"))?;
        manifest.validate(ext_dir)?;
        Ok(manifest)
    }

    fn validate(&self, ext_dir: &Path) -> Result<(), String> {
        // Extension id: publisher.name, no path characters
        if self.extension.id.is_empty()
            || self.extension.id.contains('/')
            || self.extension.id.contains('\\')
            || self.extension.id.contains("..")
        {
            return Err(format!(
                "Invalid extension id '{}'", self.extension.id
            ));
        }
        // WASM entry must be relative and inside ext_dir
        let wasm_rel = Path::new(&self.entry.wasm);
        if wasm_rel.is_absolute() {
            return Err("entry.wasm must be a relative path".to_string());
        }
        let wasm_path = ext_dir.join(wasm_rel);
        let canonical = std::fs::canonicalize(&wasm_path)
            .map_err(|e| format!("Cannot resolve wasm path: {e}"))?;
        let ext_canonical = std::fs::canonicalize(ext_dir)
            .map_err(|e| format!("Cannot resolve ext dir: {e}"))?;
        if !canonical.starts_with(&ext_canonical) {
            return Err("entry.wasm path traverses outside extension directory".to_string());
        }
        Ok(())
    }

    pub fn wasm_path(&self, ext_dir: &Path) -> PathBuf {
        ext_dir.join(&self.entry.wasm)
    }
}
```

---

## 5. `api_impl.rs`

Host-side implementations of all WIT imports. These are called from inside the WASM sandbox:

```rust
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Context passed to every host import function.
/// Holds enough state to answer workspace and UI calls.
#[derive(Clone)]
pub struct HostContext {
    pub workspace_root: Option<PathBuf>,
    pub workspace_read_allowed: bool,
    pub output_lines: Arc<Mutex<Vec<(String, String)>>>,  // (channel, message)
}

impl HostContext {
    pub fn new(workspace_root: Option<PathBuf>, workspace_read: bool) -> Self {
        Self {
            workspace_root,
            workspace_read_allowed: workspace_read,
            output_lines: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

// ui::log
pub fn host_log(ctx: &mut HostContext, channel: String, message: String) {
    log::info!("[ext:{}] {}", channel, message);
    ctx.output_lines.lock().unwrap().push((channel, message));
}

// ui::show_message
pub fn host_show_message(_ctx: &mut HostContext, level: String, message: String) {
    match level.as_str() {
        "error"   => log::error!("[ext] {}", message),
        "warning" => log::warn!("[ext] {}", message),
        _         => log::info!("[ext] {}", message),
    }
    // TODO Phase 1: emit Tauri event so frontend can display notification
}

// ui::set_status
pub fn host_set_status(_ctx: &mut HostContext, _id: String, _text: String, _tooltip: Option<String>) {
    // TODO Phase 1: emit Tauri event "ext://status" with id+text+tooltip
}

// workspace::root_uri
pub fn host_root_uri(ctx: &mut HostContext) -> String {
    ctx.workspace_root
        .as_ref()
        .and_then(|p| url::Url::from_file_path(p).ok())
        .map(|u| u.to_string())
        .unwrap_or_default()
}

// workspace::read_file
pub fn host_read_file(ctx: &mut HostContext, path: String) -> Result<String, String> {
    if !ctx.workspace_read_allowed {
        return Err("capability 'workspace_read' not declared".to_string());
    }
    let root = ctx.workspace_root.as_ref()
        .ok_or_else(|| "no workspace open".to_string())?;

    // Reject absolute paths and dotdot
    let rel = std::path::Path::new(&path);
    if rel.is_absolute() {
        return Err(format!("read_file: path must be relative, got '{path}'"));
    }
    let joined = root.join(rel);
    let canonical = std::fs::canonicalize(&joined)
        .map_err(|e| format!("read_file: cannot resolve '{path}': {e}"))?;
    let root_canonical = std::fs::canonicalize(root)
        .map_err(|e| format!("read_file: cannot resolve workspace root: {e}"))?;
    if !canonical.starts_with(&root_canonical) {
        return Err(format!("read_file: '{path}' is outside workspace"));
    }

    std::fs::read_to_string(&canonical)
        .map_err(|e| format!("read_file: '{path}': {e}"))
}

// workspace::find_files  (glob via simple prefix/suffix matching for Phase 1;
//                          replace with the `glob` crate in Phase 2)
pub fn host_find_files(ctx: &mut HostContext, pattern: String) -> Result<Vec<String>, String> {
    if !ctx.workspace_read_allowed {
        return Err("capability 'workspace_read' not declared".to_string());
    }
    let root = ctx.workspace_root.as_ref()
        .ok_or_else(|| "no workspace open".to_string())?;
    // Placeholder: return empty list until glob crate is added in Phase 2
    let _ = (root, pattern);
    Ok(vec![])
}

// workspace::get_config
pub fn host_get_config(_ctx: &mut HostContext, _key: String) -> Option<String> {
    // TODO Phase 2: read from SettingsStore
    None
}
```

---

## 6. `instance.rs`

One `WasmInstance` per loaded extension:

```rust
use super::api_impl::HostContext;
use super::manifest::CoreCodeManifest;
use std::path::Path;
use wasmtime::component::{Component, Linker};
use wasmtime::{Engine, Store};
use wasmtime_wasi::preview2::{Table, WasiCtx, WasiCtxBuilder, WasiView};

// wit-bindgen generated bindings (committed to repo after first `cargo build`)
// wit_bindgen::generate!({ world: "corecode-extension", path: "wit/" });
// For Phase 1, use manual bindings until the file stabilises:

pub struct WasmInstance {
    pub id: String,
    store: Store<InstanceState>,
    // The component's exported `lifecycle` interface handle
    // (typed handle generated by wit-bindgen; use `wasmtime::component::TypedFunc` for Phase 1)
    activate_fn:   wasmtime::component::TypedFunc<(), (Result<(), String>,)>,
    deactivate_fn: wasmtime::component::TypedFunc<(), ()>,
}

struct InstanceState {
    wasi: WasiCtx,
    table: Table,
    host_ctx: HostContext,
}

impl WasiView for InstanceState {
    fn table(&self) -> &Table { &self.table }
    fn table_mut(&mut self) -> &mut Table { &mut self.table }
    fn ctx(&self) -> &WasiCtx { &self.wasi }
    fn ctx_mut(&mut self) -> &mut WasiCtx { &mut self.wasi }
}

impl WasmInstance {
    pub fn load(
        engine: &Engine,
        ext_dir: &Path,
        manifest: &CoreCodeManifest,
        host_ctx: HostContext,
    ) -> Result<Self, String> {
        let wasm_bytes = std::fs::read(manifest.wasm_path(ext_dir))
            .map_err(|e| format!("Cannot read wasm: {e}"))?;

        let component = Component::new(engine, &wasm_bytes)
            .map_err(|e| format!("Invalid WASM component: {e}"))?;

        // Build WASI context — no filesystem, no network by default
        let wasi = WasiCtxBuilder::new().build();
        let table = Table::new();

        let state = InstanceState { wasi, table, host_ctx };
        let mut store = Store::new(engine, state);

        // Build the component linker
        let mut linker: Linker<InstanceState> = Linker::new(engine);
        wasmtime_wasi::preview2::command::add_to_linker(&mut linker)
            .map_err(|e| format!("Linker setup failed: {e}"))?;

        // Link host imports (ui + workspace)
        // These closures are called from inside the WASM sandbox.
        // Note: In Phase 1, use manual func_wrap with wasmtime's component
        // string ABI (encoded as (ptr, len) pairs in linear memory). In Phase 2,
        // switch to wit-bindgen-generated host bindings to avoid internal types.
        linker.func_wrap(
            "corecode:extension/ui",
            "log",
            |mut caller: wasmtime::Caller<'_, InstanceState>,
             channel: String,
             message: String| {
                let ctx = &mut caller.data_mut().host_ctx;
                super::api_impl::host_log(ctx, channel, message);
                Ok(())
            },
        ).map_err(|e| format!("Cannot link ui::log: {e}"))?;

        // ... link remaining ui and workspace imports similarly ...

        let instance = linker.instantiate(&mut store, &component)
            .map_err(|e| format!("Instantiation failed: {e}"))?;

        let activate_fn = instance
            .get_typed_func::<(), (Result<(), String>,)>(&mut store,
                "corecode:extension/lifecycle#activate")
            .map_err(|e| format!("Missing export 'lifecycle#activate': {e}"))?;

        let deactivate_fn = instance
            .get_typed_func::<(), ()>(&mut store,
                "corecode:extension/lifecycle#deactivate")
            .map_err(|e| format!("Missing export 'lifecycle#deactivate': {e}"))?;

        Ok(WasmInstance {
            id: manifest.extension.id.clone(),
            store,
            activate_fn,
            deactivate_fn,
        })
    }

    pub fn activate(&mut self) -> Result<(), String> {
        let (result,) = self.activate_fn
            .call(&mut self.store, ())
            .map_err(|e| format!("activate trap: {e}"))?;
        self.activate_fn.post_return(&mut self.store)
            .map_err(|e| format!("activate post-return: {e}"))?;
        result
    }

    pub fn deactivate(&mut self) {
        let _ = self.deactivate_fn.call(&mut self.store, ());
        let _ = self.deactivate_fn.post_return(&mut self.store);
    }
}
```

---

## 7. `manager.rs`

```rust
use super::instance::WasmInstance;
use super::manifest::CoreCodeManifest;
use super::api_impl::HostContext;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use wasmtime::{Engine, Config};

pub struct WasmHostManager {
    engine: Engine,
    instances: Mutex<HashMap<String, WasmInstance>>,
}

impl WasmHostManager {
    pub fn new() -> Result<Self, String> {
        let mut config = Config::new();
        config.wasm_component_model(true);
        config.async_support(false);  // sync for Phase 1; async in Phase 2

        let engine = Engine::new(&config)
            .map_err(|e| format!("wasmtime Engine::new failed: {e}"))?;

        Ok(Self {
            engine,
            instances: Mutex::new(HashMap::new()),
        })
    }

    /// Load and activate all WASM extensions in a directory.
    /// Called once from lib.rs on startup, after Node.js extensions.
    pub fn activate_all(
        &self,
        extensions_dir: &Path,
        workspace_root: Option<PathBuf>,
    ) -> Vec<String> {
        let mut errors = Vec::new();
        let entries = match std::fs::read_dir(extensions_dir) {
            Ok(e) => e,
            Err(_) => return errors,
        };

        for entry in entries.flatten() {
            let ext_dir = entry.path();
            if !ext_dir.is_dir() { continue; }
            if !ext_dir.join("corecode.toml").exists() { continue; }

            if let Err(e) = self.activate_one(&ext_dir, workspace_root.clone()) {
                errors.push(format!("{}: {e}", ext_dir.display()));
            }
        }
        errors
    }

    fn activate_one(
        &self,
        ext_dir: &Path,
        workspace_root: Option<PathBuf>,
    ) -> Result<(), String> {
        let manifest = CoreCodeManifest::load(ext_dir)?;
        let id = manifest.extension.id.clone();

        // Prevent double-activation: check instances and reserve in loading set
        // under the same lock to close the TOCTOU window.
        {
            let instances = self.instances.lock().unwrap();
            if instances.contains_key(&id) {
                return Err(format!("Extension '{}' already loaded", id));
            }
            let mut loading = self.loading.lock().unwrap();
            if !loading.insert(id.clone()) {
                return Err(format!("Extension '{}' is already being loaded", id));
            }
        }

        let host_ctx = HostContext::new(
            workspace_root,
            manifest.capabilities.workspace_read,
        );

        let mut instance = match WasmInstance::load(&self.engine, ext_dir, &manifest, host_ctx) {
            Ok(i) => i,
            Err(e) => {
                self.loading.lock().unwrap().remove(&id);
                return Err(e);
            }
        };
        if let Err(e) = instance.activate() {
            self.loading.lock().unwrap().remove(&id);
            return Err(e);
        }

        self.instances.lock().unwrap().insert(id.clone(), instance);
        self.loading.lock().unwrap().remove(&id);
        Ok(())
    }

    pub fn deactivate_all(&self) {
        let mut map = self.instances.lock().unwrap();
        for (_id, instance) in map.iter_mut() {
            instance.deactivate();
        }
        map.clear();
    }
}
```

---

## 8. `mod.rs`

```rust
mod api_impl;
mod instance;
pub mod manager;
pub mod manifest;

pub use manager::WasmHostManager;
```

---

## 9. `AppState` changes in `lib.rs`

Add the manager field:

```rust
// In the AppState struct:
wasm_host: wasm_host::WasmHostManager,
```

Initialise in `run()` (the Tauri builder setup function):

```rust
let wasm_host = wasm_host::WasmHostManager::new()
    .expect("Failed to initialise WASM extension host");
```

Add to the `manage()` call:

```rust
.manage(AppState {
    // ... existing fields ...
    wasm_host,
})
```

Activate WASM extensions on the `setup` hook, after the Node.js host starts:

```rust
app.listen("ext-host-ready", move |_event| {
    // existing Node.js activation ...

    // New: activate WASM extensions
    let state = app_handle.state::<AppState>();
    let workspace_root = /* get from first workspace if any */;
    let errors = state.wasm_host.activate_all(&extensions_dir, workspace_root);
    for e in errors {
        log::error!("WASM extension error: {e}");
    }
});
```

---

## 10. `extension_mgr.rs` routing change

Add after the existing `pub struct ExtensionManager`:

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum ExtensionKind {
    NodeJs,
    Wasm,
}

/// Detect the host type for an extension directory.
/// Returns None if neither manifest is present (not an extension directory).
pub fn detect_kind(ext_dir: &std::path::Path) -> Option<ExtensionKind> {
    if ext_dir.join("corecode.toml").exists() {
        Some(ExtensionKind::Wasm)
    } else if ext_dir.join("package.json").exists() {
        Some(ExtensionKind::NodeJs)
    } else {
        None
    }
}
```

The existing activation path for Node.js extensions is unchanged; it simply gains a guard:

```rust
// Before sending to Node.js host:
if detect_kind(&ext_dir) != Some(ExtensionKind::NodeJs) {
    continue;  // WASM extension; handled by WasmHostManager
}
```

---

## 11. Example extension scaffold

Create: `examples/hello-wasm/`

```
examples/hello-wasm/
  Cargo.toml
  corecode.toml
  src/
    lib.rs
```

`Cargo.toml`:
```toml
[package]
name    = "hello-wasm"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
# wit-bindgen generates the boilerplate from our WIT file
wit-bindgen = "0.26"
```

`corecode.toml`:
```toml
[extension]
id      = "corecode.hello-wasm"
name    = "Hello WASM"
version = "0.1.0"

[entry]
wasm = "hello-wasm.wasm"

[capabilities]
workspace_read = false
network_fetch  = false
webview_panels = false
```

`src/lib.rs`:
```rust
wit_bindgen::generate!({
    world: "corecode-extension",
    path: "../../src/app/src-tauri/wit/corecode.wit",
});

struct HelloWasm;

impl Guest for HelloWasm {
    fn activate() -> Result<(), String> {
        ui::log("Hello WASM", "Extension activated successfully!");
        ui::show_message("info", "Hello from a Rust WASM extension!");
        Ok(())
    }

    fn deactivate() {
        ui::log("Hello WASM", "Extension deactivated.");
    }
}

export!(HelloWasm);
```

Build command:
```sh
cargo build --target wasm32-wasi --release
cp target/wasm32-wasi/release/hello_wasm.wasm hello-wasm.wasm
```

---

## 12. Tests

Add to `src/app/src-tauri/src/wasm_host/manager.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    fn make_manager() -> WasmHostManager {
        WasmHostManager::new().expect("manager creation failed")
    }

    #[test]
    fn activate_empty_dir_produces_no_errors() {
        let dir = TempDir::new().unwrap();
        let mgr = make_manager();
        let errors = mgr.activate_all(dir.path(), None);
        assert!(errors.is_empty());
    }

    #[test]
    fn non_wasm_dir_is_skipped() {
        let dir = TempDir::new().unwrap();
        let ext_dir = dir.path().join("node-ext");
        std::fs::create_dir(&ext_dir).unwrap();
        // Has package.json, not corecode.toml — should be skipped
        std::fs::write(ext_dir.join("package.json"), r#"{"name":"x"}"#).unwrap();
        let mgr = make_manager();
        let errors = mgr.activate_all(dir.path(), None);
        assert!(errors.is_empty(), "node extension should not cause errors");
    }
}
```

Add to `manifest.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_manifest(dir: &std::path::Path, content: &str) {
        std::fs::write(dir.join("corecode.toml"), content).unwrap();
    }

    #[test]
    fn valid_manifest_loads() {
        let dir = TempDir::new().unwrap();
        // Need a real wasm file for validate() to canonicalise
        std::fs::write(dir.path().join("ext.wasm"), b"").unwrap();
        write_manifest(dir.path(), r#"
            [extension]
            id = "test.ext"
            name = "Test"
            version = "0.1.0"
            [entry]
            wasm = "ext.wasm"
        "#);
        assert!(CoreCodeManifest::load(dir.path()).is_ok());
    }

    #[test]
    fn rejects_absolute_wasm_path() {
        let dir = TempDir::new().unwrap();
        write_manifest(dir.path(), r#"
            [extension]
            id = "test.ext"
            name = "Test"
            version = "0.1.0"
            [entry]
            wasm = "/etc/passwd"
        "#);
        let err = CoreCodeManifest::load(dir.path()).unwrap_err();
        assert!(err.contains("relative"), "{err}");
    }

    #[test]
    fn rejects_dotdot_wasm_path() {
        let dir = TempDir::new().unwrap();
        write_manifest(dir.path(), r#"
            [extension]
            id = "test.ext"
            name = "Test"
            version = "0.1.0"
            [entry]
            wasm = "../other/evil.wasm"
        "#);
        let err = CoreCodeManifest::load(dir.path()).unwrap_err();
        assert!(err.contains("traverses") || err.contains("resolve"), "{err}");
    }

    #[test]
    fn rejects_empty_id() {
        let dir = TempDir::new().unwrap();
        write_manifest(dir.path(), r#"
            [extension]
            id = ""
            name = "Test"
            version = "0.1.0"
            [entry]
            wasm = "ext.wasm"
        "#);
        let err = CoreCodeManifest::load(dir.path()).unwrap_err();
        assert!(err.contains("id"), "{err}");
    }
}
```

Add `tempfile = "3"` to `[dev-dependencies]` in `Cargo.toml`.

---

## 13. Acceptance test

Manual verification steps after Phase 1 is built:

1. Copy `examples/hello-wasm/` (compiled) into the CoreCode extensions directory
2. Launch CoreCode
3. Open the Output panel
4. Confirm "Hello WASM — Extension activated successfully!" appears
5. Confirm the info notification "Hello from a Rust WASM extension!" appears
6. Close CoreCode; confirm "Extension deactivated." appears in output
7. Confirm no Node.js extension breaks (run M12 compatibility smoke tests)
