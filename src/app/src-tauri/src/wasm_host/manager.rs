//! WASM extension host manager.
//!
//! `WasmHostManager` owns the shared `wasmtime::Engine` and all loaded extension
//! instances. It is stored in `AppState` and is therefore `Send + Sync`.

use crate::wasm_host::api_impl::HostContext;
use crate::wasm_host::instance::WasmInstance;
use crate::wasm_host::manifest::CoreCodeManifest;
use crate::wasm_host::wit_types::*;
use crate::extension_mgr::{detect_kind, ExtensionKind};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use wasmtime::{Config, Engine};

pub struct WasmHostManager {
    engine: Engine,
    /// Loaded and active extension instances, keyed by extension id.
    instances: Mutex<HashMap<String, WasmInstance>>,
    /// Map from language-id (e.g. "rust") to the extension ids that claim it.
    language_registry: Mutex<HashMap<String, Vec<String>>>,
    /// Shared settings store — threaded to each extension's HostContext.
    settings: Option<std::sync::Arc<Mutex<crate::settings::SettingsStore>>>,
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
            language_registry: Mutex::new(HashMap::new()),
            settings: None,
        })
    }

    /// Attach the shared settings store so extensions can use `get-config`.
    pub fn set_settings(&mut self, settings: std::sync::Arc<Mutex<crate::settings::SettingsStore>>) {
        self.settings = Some(settings);
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
            id.clone(),
            self.settings.clone(),
        );

        let mut instance =
            WasmInstance::load(&self.engine, ext_dir, &manifest, host_ctx)?;

        instance.activate()?;

        // Register language claims from corecode.toml [languages] section.
        let langs: Vec<String> = manifest.languages
            .iter()
            .filter(|(_, &v)| v)
            .map(|(k, _)| k.clone())
            .collect();
        if !langs.is_empty() {
            let mut registry = self.language_registry.lock().unwrap();
            for lang in &langs {
                registry.entry(lang.clone()).or_default().push(id.clone());
            }
            log::info!(
                "WASM ext '{}' claims languages: {:?}",
                id,
                langs,
            );
        }

        self.instances.lock().unwrap().insert(id.clone(), instance);
        Ok(id)
    }

    /// Remove an extension's language claims from the registry.
    pub fn remove_from_language_registry(&self, id: &str) {
        let mut registry = self.language_registry.lock().unwrap();
        for providers in registry.values_mut() {
            providers.retain(|ext_id| ext_id != id);
        }
        registry.retain(|_, providers| !providers.is_empty());
    }

    /// Deactivate all extensions, e.g. on application shutdown.
    ///
    /// Clears the language registry before touching instances to avoid
    /// holding both mutexes simultaneously (dispatch methods lock them
    /// in the opposite order).
    pub fn deactivate_all(&self) {
        self.language_registry.lock().unwrap().clear();

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

    /// Drain buffered notification toasts from all active extensions.
    ///
    /// Returns `(level, message)` pairs (level is "info", "warning", or "error").
    pub fn drain_all_notifications(&self) -> Vec<(String, String)> {
        let mut all = Vec::new();
        let mut map = self.instances.lock().unwrap();
        for (_, instance) in map.iter_mut() {
            all.extend(instance.drain_notifications());
        }
        all
    }

    /// Collect status bar items from all active extensions.
    ///
    /// Returns `(id, text, tooltip)` tuples. Items persist until the extension
    /// removes them by calling `set-status` with empty text.
    pub fn get_all_status_items(&self) -> Vec<(String, String, Option<String>)> {
        let mut all = Vec::new();
        let map = self.instances.lock().unwrap();
        for (_, instance) in map.iter() {
            all.extend(instance.get_status_items());
        }
        all
    }

    /// Return the number of currently active extensions.
    pub fn active_count(&self) -> usize {
        self.instances.lock().unwrap().len()
    }

    // ── Language provider dispatch ────────────────────────────────────────────
    //
    // Lock ordering: always read `language_registry` first (clone + drop),
    // then acquire `instances`. Never hold both locks simultaneously.

    /// Get the extension IDs that claim a given language.
    fn providers_for_lang(&self, lang_id: &str) -> Vec<String> {
        let registry = self.language_registry.lock().unwrap();
        registry.get(lang_id).cloned().unwrap_or_default()
    }

    /// Completions from all WASM extensions claiming `lang_id`.  Results are merged.
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

    /// Hover from the first WASM extension that returns a non-None result.
    pub fn hover_for_lang(
        &self,
        lang_id: &str,
        uri: &str,
        line: u32,
        character: u32,
    ) -> Option<HoverResult> {
        let ext_ids = self.providers_for_lang(lang_id);
        let mut instances = self.instances.lock().unwrap();
        for id in &ext_ids {
            if let Some(inst) = instances.get_mut(id) {
                match inst.hover(uri, line, character) {
                    Ok(Some(result)) => return Some(result),
                    Ok(None) => {}
                    Err(e) => log::warn!("hover error from {id}: {e}"),
                }
            }
        }
        None
    }

    /// Diagnostics from all WASM extensions claiming `lang_id`.  Results are merged.
    pub fn diagnostics_for_lang(
        &self,
        lang_id: &str,
        uri: &str,
        content: &str,
    ) -> Vec<Diagnostic> {
        let ext_ids = self.providers_for_lang(lang_id);
        let mut results = Vec::new();
        let mut instances = self.instances.lock().unwrap();
        for id in &ext_ids {
            if let Some(inst) = instances.get_mut(id) {
                match inst.diagnostics(uri, content) {
                    Ok(items) => results.extend(items),
                    Err(e) => log::warn!("diagnostics error from {id}: {e}"),
                }
            }
        }
        results
    }

    /// Format the full document. Uses the first extension that returns a non-empty list.
    pub fn format_document_for_lang(
        &self,
        lang_id: &str,
        uri: &str,
        content: &str,
    ) -> Vec<TextEdit> {
        let ext_ids = self.providers_for_lang(lang_id);
        let mut instances = self.instances.lock().unwrap();
        for id in &ext_ids {
            if let Some(inst) = instances.get_mut(id) {
                match inst.format_document(uri, content) {
                    Ok(edits) if !edits.is_empty() => return edits,
                    Ok(_) => {}
                    Err(e) => log::warn!("format-document error from {id}: {e}"),
                }
            }
        }
        vec![]
    }

    /// Format a range. Uses the first extension that returns a non-empty list.
    pub fn format_range_for_lang(
        &self,
        lang_id: &str,
        uri: &str,
        content: &str,
        range: &Range,
    ) -> Vec<TextEdit> {
        let ext_ids = self.providers_for_lang(lang_id);
        let mut instances = self.instances.lock().unwrap();
        for id in &ext_ids {
            if let Some(inst) = instances.get_mut(id) {
                match inst.format_range(uri, content, range) {
                    Ok(edits) if !edits.is_empty() => return edits,
                    Ok(_) => {}
                    Err(e) => log::warn!("format-range error from {id}: {e}"),
                }
            }
        }
        vec![]
    }

    /// Go-to-definition from the first extension that returns a non-None result.
    pub fn definition_for_lang(
        &self,
        lang_id: &str,
        uri: &str,
        line: u32,
        character: u32,
    ) -> Option<Location> {
        let ext_ids = self.providers_for_lang(lang_id);
        let mut instances = self.instances.lock().unwrap();
        for id in &ext_ids {
            if let Some(inst) = instances.get_mut(id) {
                match inst.definition(uri, line, character) {
                    Ok(Some(loc)) => return Some(loc),
                    Ok(None) => {}
                    Err(e) => log::warn!("definition error from {id}: {e}"),
                }
            }
        }
        None
    }

    /// Find references from all extensions claiming `lang_id`.  Results are merged.
    pub fn references_for_lang(
        &self,
        lang_id: &str,
        uri: &str,
        line: u32,
        character: u32,
        include_decl: bool,
    ) -> Vec<Location> {
        let ext_ids = self.providers_for_lang(lang_id);
        let mut results = Vec::new();
        let mut instances = self.instances.lock().unwrap();
        for id in &ext_ids {
            if let Some(inst) = instances.get_mut(id) {
                match inst.references(uri, line, character, include_decl) {
                    Ok(locs) => results.extend(locs),
                    Err(e) => log::warn!("references error from {id}: {e}"),
                }
            }
        }
        results
    }

    /// Rename symbol. Uses the first extension that returns a non-empty list.
    pub fn rename_for_lang(
        &self,
        lang_id: &str,
        uri: &str,
        line: u32,
        character: u32,
        new_name: &str,
    ) -> Vec<TextEdit> {
        let ext_ids = self.providers_for_lang(lang_id);
        let mut instances = self.instances.lock().unwrap();
        for id in &ext_ids {
            if let Some(inst) = instances.get_mut(id) {
                match inst.rename(uri, line, character, new_name) {
                    Ok(edits) if !edits.is_empty() => return edits,
                    Ok(_) => {}
                    Err(e) => log::warn!("rename error from {id}: {e}"),
                }
            }
        }
        vec![]
    }

    /// Code actions from all extensions claiming `lang_id`.  Results are merged.
    pub fn code_actions_for_lang(
        &self,
        lang_id: &str,
        uri: &str,
        range: &Range,
        diagnostics: &[Diagnostic],
    ) -> Vec<CodeAction> {
        let ext_ids = self.providers_for_lang(lang_id);
        let mut results = Vec::new();
        let mut instances = self.instances.lock().unwrap();
        for id in &ext_ids {
            if let Some(inst) = instances.get_mut(id) {
                match inst.code_actions(uri, range, diagnostics) {
                    Ok(items) => results.extend(items),
                    Err(e) => log::warn!("code-actions error from {id}: {e}"),
                }
            }
        }
        results
    }

    /// Workspace symbols from all extensions claiming `lang_id`.  Results are merged.
    pub fn workspace_symbols_for_lang(
        &self,
        lang_id: &str,
        query: &str,
    ) -> Vec<Symbol> {
        let ext_ids = self.providers_for_lang(lang_id);
        let mut results = Vec::new();
        let mut instances = self.instances.lock().unwrap();
        for id in &ext_ids {
            if let Some(inst) = instances.get_mut(id) {
                match inst.workspace_symbols(query) {
                    Ok(items) => results.extend(items),
                    Err(e) => log::warn!("workspace-symbols error from {id}: {e}"),
                }
            }
        }
        results
    }

    /// Folding ranges from the first extension that returns a non-empty list.
    pub fn folding_ranges_for_lang(
        &self,
        lang_id: &str,
        uri: &str,
        content: &str,
    ) -> Vec<FoldingRange> {
        let ext_ids = self.providers_for_lang(lang_id);
        let mut instances = self.instances.lock().unwrap();
        for id in &ext_ids {
            if let Some(inst) = instances.get_mut(id) {
                match inst.folding_ranges(uri, content) {
                    Ok(ranges) if !ranges.is_empty() => return ranges,
                    Ok(_) => {}
                    Err(e) => log::warn!("folding-ranges error from {id}: {e}"),
                }
            }
        }
        vec![]
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

    // ── Phase 2: Language registry tests ─────────────────────────────────────

    #[test]
    fn language_registry_starts_empty() {
        let mgr = make_manager();
        let registry = mgr.language_registry.lock().unwrap();
        assert!(registry.is_empty());
    }

    #[test]
    fn completions_returns_empty_for_unknown_lang() {
        let mgr = make_manager();
        let items = mgr.completions_for_lang("cobol", "file:///x.cbl", 0, 0, None);
        assert!(items.is_empty());
    }

    #[test]
    fn diagnostics_returns_empty_for_unknown_lang() {
        let mgr = make_manager();
        let diags = mgr.diagnostics_for_lang("cobol", "file:///x.cbl", "");
        assert!(diags.is_empty());
    }

    #[test]
    fn hover_returns_none_for_unknown_lang() {
        let mgr = make_manager();
        let result = mgr.hover_for_lang("cobol", "file:///x.cbl", 0, 0);
        assert!(result.is_none());
    }

    #[test]
    fn definition_returns_none_for_unknown_lang() {
        let mgr = make_manager();
        let result = mgr.definition_for_lang("cobol", "file:///x.cbl", 0, 0);
        assert!(result.is_none());
    }

    #[test]
    fn references_returns_empty_for_unknown_lang() {
        let mgr = make_manager();
        let locs = mgr.references_for_lang("cobol", "file:///x.cbl", 0, 0, true);
        assert!(locs.is_empty());
    }

    #[test]
    fn format_returns_empty_for_unknown_lang() {
        let mgr = make_manager();
        let edits = mgr.format_document_for_lang("cobol", "file:///x.cbl", "hello");
        assert!(edits.is_empty());
    }

    #[test]
    fn workspace_symbols_returns_empty_for_unknown_lang() {
        let mgr = make_manager();
        let syms = mgr.workspace_symbols_for_lang("cobol", "test");
        assert!(syms.is_empty());
    }

    #[test]
    fn folding_ranges_returns_empty_for_unknown_lang() {
        let mgr = make_manager();
        let ranges = mgr.folding_ranges_for_lang("cobol", "file:///x.cbl", "");
        assert!(ranges.is_empty());
    }

    #[test]
    fn provider_trap_returns_empty_not_crash() {
        let mgr = make_manager();
        // No extension loaded — should return empty without panicking
        let items = mgr.completions_for_lang("rust", "file:///foo.rs", 0, 0, None);
        assert!(items.is_empty(), "trap scenario should return empty");
    }

    #[test]
    fn two_providers_for_same_lang_allowed_in_registry() {
        let mgr = make_manager();
        {
            let mut reg = mgr.language_registry.lock().unwrap();
            reg.entry("rust".to_string()).or_default().push("ext.a".to_string());
            reg.entry("rust".to_string()).or_default().push("ext.b".to_string());
        }
        let providers = mgr.providers_for_lang("rust");
        assert_eq!(providers.len(), 2);
        assert!(providers.contains(&"ext.a".to_string()));
        assert!(providers.contains(&"ext.b".to_string()));
    }

    #[test]
    fn deactivate_clears_language_registry() {
        let mgr = make_manager();
        {
            let mut reg = mgr.language_registry.lock().unwrap();
            reg.entry("rust".to_string()).or_default().push("test.ext".to_string());
        }
        mgr.deactivate_all();
        let reg = mgr.language_registry.lock().unwrap();
        assert!(reg.is_empty(), "registry should be empty after deactivate_all");
    }

    #[test]
    fn remove_from_language_registry_removes_specific_ext() {
        let mgr = make_manager();
        {
            let mut reg = mgr.language_registry.lock().unwrap();
            reg.entry("rust".to_string()).or_default().push("keep.ext".to_string());
            reg.entry("rust".to_string()).or_default().push("remove.ext".to_string());
            reg.entry("toml".to_string()).or_default().push("remove.ext".to_string());
        }
        mgr.remove_from_language_registry("remove.ext");
        let reg = mgr.language_registry.lock().unwrap();
        // "rust" should still have "keep.ext"
        assert_eq!(reg.get("rust").map(|v| v.len()), Some(1));
        assert_eq!(reg.get("rust").unwrap()[0], "keep.ext");
        // "toml" had only "remove.ext", so it should be gone entirely
        assert!(reg.get("toml").is_none());
    }
}
