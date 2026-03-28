//! WASM extension host manager.
//!
//! `WasmHostManager` owns the shared `wasmtime::Engine` and all loaded extension
//! instances. It is stored in `AppState` and is therefore `Send + Sync`.

use super::api_impl::HostContext;
use super::instance::WasmInstance;
use super::manifest::CoreCodeManifest;
use crate::extension_mgr::{detect_kind, ExtensionKind};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use wasmtime::{Config, Engine};

pub struct WasmHostManager {
    engine: Engine,
    /// Loaded and active extension instances, keyed by extension id.
    instances: Mutex<HashMap<String, WasmInstance>>,
}

// `WasmHostManager` is `Send + Sync` because all its fields are:
// • `Engine` — explicitly `Send + Sync` per wasmtime docs.
// • `Mutex<HashMap<String, WasmInstance>>` — `Mutex<T>: Send + Sync` when `T: Send`.
// • `WasmInstance` is `Send` because `Store<InstanceState>` is `Send` when `InstanceState`
//   is `Send` (all its fields are `Arc<Mutex<_>>`, `WasiCtx`, and `ResourceTable`, all Send)
//   and `wasmtime::component::Func` is `Send` (holds only store-internal indices).
// No `unsafe impl` is required — the compiler derives these automatically.

impl WasmHostManager {
    /// Create the shared WASM engine with component model support.
    pub fn new() -> Result<Self, String> {
        let mut config = Config::new();
        config.wasm_component_model(true);
        // Synchronous execution for Phase 1.
        config.async_support(false);
        // Enable fuel-based execution limiting so extensions cannot loop forever.
        // Each call gets a fresh budget; the engine traps when fuel is exhausted.
        config.consume_fuel(true);

        let engine =
            Engine::new(&config).map_err(|e| format!("wasmtime Engine::new failed: {e}"))?;

        Ok(Self {
            engine,
            instances: Mutex::new(HashMap::new()),
        })
    }

    /// Scan `extensions_dir` and activate all WASM extensions found there.
    ///
    /// A directory is treated as a WASM extension if it contains `corecode.toml`.
    /// Errors for individual extensions are collected and returned; other extensions
    /// continue loading.
    pub fn activate_all(
        &self,
        extensions_dir: &Path,
        workspace_root: Option<PathBuf>,
    ) -> Vec<String> {
        let mut errors = Vec::new();

        let entries = match std::fs::read_dir(extensions_dir) {
            Ok(e) => e,
            Err(e) => {
                log::warn!(
                    "WASM host: cannot read extensions dir '{}': {e}",
                    extensions_dir.display()
                );
                return errors;
            }
        };

        for entry in entries.flatten() {
            let ext_dir = entry.path();
            if !ext_dir.is_dir() {
                continue;
            }
            // Route by extension kind — only WASM extensions are handled here.
            // Node.js extensions are started by the separate ext-host process.
            match detect_kind(&ext_dir) {
                Some(ExtensionKind::Wasm) => {}
                Some(ExtensionKind::NodeJs) => {
                    log::debug!(
                        "Skipping Node.js extension '{}' (handled by ext-host)",
                        ext_dir.display()
                    );
                    continue;
                }
                None => continue,
            }

            match self.activate_one(&ext_dir, workspace_root.clone()) {
                Ok(id) => log::info!("WASM extension '{}' activated", id),
                Err(e) => {
                    let msg = format!("{}: {e}", ext_dir.display());
                    log::error!("WASM extension activation failed — {msg}");
                    errors.push(msg);
                }
            }
        }

        errors
    }

    fn activate_one(
        &self,
        ext_dir: &Path,
        workspace_root: Option<PathBuf>,
    ) -> Result<String, String> {
        let manifest = CoreCodeManifest::load(ext_dir)?;
        let id = manifest.extension.id.clone();

        // Prevent double-activation.
        {
            let instances = self.instances.lock().unwrap();
            if instances.contains_key(&id) {
                return Err(format!("Extension '{}' is already loaded", id));
            }
        }

        let host_ctx = HostContext::new(
            workspace_root,
            manifest.capabilities.workspace_read,
        );

        let mut instance =
            WasmInstance::load(&self.engine, ext_dir, &manifest, host_ctx)?;

        instance.activate()?;

        self.instances.lock().unwrap().insert(id.clone(), instance);
        Ok(id)
    }

    /// Deactivate all extensions, e.g. on application shutdown.
    pub fn deactivate_all(&self) {
        let mut map = self.instances.lock().unwrap();
        for (id, instance) in map.iter_mut() {
            log::info!("Deactivating WASM extension '{id}'");
            instance.deactivate();
        }
        map.clear();
    }

    /// Notify all active WASM extensions that a workspace folder was opened.
    ///
    /// Extensions that declared `workspace_read` can now resolve files against
    /// the new root; extensions without the capability ignore the value.
    pub fn notify_workspace_opened(&self, root: PathBuf) {
        let mut map = self.instances.lock().unwrap();
        for (id, instance) in map.iter_mut() {
            log::debug!("WASM ext '{}': workspace root set to '{}'", id, root.display());
            instance.set_workspace_root(Some(root.clone()));
        }
    }

    /// Drain buffered output lines from all active extensions.
    ///
    /// Returns `(extension_id_or_channel, message)` pairs.
    pub fn drain_all_output_lines(&self) -> Vec<(String, String)> {
        let mut all = Vec::new();
        let mut map = self.instances.lock().unwrap();
        for (_, instance) in map.iter_mut() {
            all.extend(instance.drain_output_lines());
        }
        all
    }

    /// Return the number of currently active extensions.
    pub fn active_count(&self) -> usize {
        self.instances.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_manager() -> WasmHostManager {
        WasmHostManager::new().expect("manager creation failed")
    }

    #[test]
    fn new_manager_has_zero_active() {
        let mgr = make_manager();
        assert_eq!(mgr.active_count(), 0);
    }

    #[test]
    fn activate_all_on_empty_dir_produces_no_errors() {
        let dir = TempDir::new().unwrap();
        let mgr = make_manager();
        let errors = mgr.activate_all(dir.path(), None);
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
        assert_eq!(mgr.active_count(), 0);
    }

    #[test]
    fn node_extension_dir_is_skipped() {
        let dir = TempDir::new().unwrap();
        let ext_dir = dir.path().join("my-node-ext");
        std::fs::create_dir(&ext_dir).unwrap();
        // Has package.json but no corecode.toml — must be skipped silently.
        std::fs::write(ext_dir.join("package.json"), r#"{"name":"x","version":"0.0.1"}"#)
            .unwrap();

        let mgr = make_manager();
        let errors = mgr.activate_all(dir.path(), None);
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
        assert_eq!(mgr.active_count(), 0);
    }

    #[test]
    fn invalid_manifest_produces_error_entry() {
        let dir = TempDir::new().unwrap();
        let ext_dir = dir.path().join("bad-ext");
        std::fs::create_dir(&ext_dir).unwrap();
        // corecode.toml present but malformed.
        std::fs::write(ext_dir.join("corecode.toml"), "not valid toml [[[").unwrap();

        let mgr = make_manager();
        let errors = mgr.activate_all(dir.path(), None);
        assert_eq!(errors.len(), 1, "expected exactly one error");
        assert_eq!(mgr.active_count(), 0);
    }

    #[test]
    fn missing_wasm_file_produces_error_entry() {
        let dir = TempDir::new().unwrap();
        let ext_dir = dir.path().join("no-wasm");
        std::fs::create_dir(&ext_dir).unwrap();
        std::fs::write(
            ext_dir.join("corecode.toml"),
            r#"
            [extension]
            id = "test.no-wasm"
            name = "No WASM"
            version = "0.1.0"
            [entry]
            wasm = "nonexistent.wasm"
            "#,
        )
        .unwrap();

        let mgr = make_manager();
        let errors = mgr.activate_all(dir.path(), None);
        assert_eq!(errors.len(), 1, "expected exactly one error");
    }
}
