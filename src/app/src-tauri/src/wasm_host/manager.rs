//! WASM extension host manager.
//!
//! `WasmHostManager` owns the shared `wasmtime::Engine` and all loaded extension
//! instances. It is stored in `AppState` and is therefore `Send + Sync`.

use super::api_impl::HostContext;
use super::instance::WasmInstance;
use super::manifest::CoreCodeManifest;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use wasmtime::{Config, Engine};

pub struct WasmHostManager {
    engine: Engine,
    /// Loaded and active extension instances, keyed by extension id.
    instances: Mutex<HashMap<String, WasmInstance>>,
}

// `Engine` is `Send + Sync`. `Mutex<HashMap<String, WasmInstance>>` is `Send + Sync`
// because `WasmInstance` is `Send` (Store<InstanceState> is Send when InstanceState is Send).
unsafe impl Send for WasmHostManager {}
unsafe impl Sync for WasmHostManager {}

impl WasmHostManager {
    /// Create the shared WASM engine with component model support.
    pub fn new() -> Result<Self, String> {
        let mut config = Config::new();
        config.wasm_component_model(true);
        // Synchronous execution for Phase 1.
        config.async_support(false);

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
            // Only handle WASM extensions (corecode.toml present).
            if !ext_dir.join("corecode.toml").exists() {
                continue;
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
