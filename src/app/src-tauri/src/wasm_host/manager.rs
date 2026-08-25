//! WASM extension host manager.
//!
//! `WasmHostManager` owns the shared `wasmtime::Engine` and all loaded extension
//! instances. It is stored in `AppState` and is therefore `Send + Sync`.

use crate::ipc_bridge::WebviewPanelEvent;
use crate::wasm_host::api_impl::{HostContext, PendingWebviewOp};
use crate::wasm_host::instance::WasmInstance;
use crate::wasm_host::manifest::CoreCodeManifest;
use crate::wasm_host::wit_types::*;
use crate::extension_mgr::{detect_kind, ExtensionKind};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use wasmtime::{Config, Engine};

pub struct WasmHostManager {
    engine: Engine,
    /// Loaded and active extension instances, keyed by extension id.
    instances: Mutex<HashMap<String, WasmInstance>>,
    /// Map from language-id (e.g. "rust") to the extension ids that claim it.
    language_registry: Mutex<HashMap<String, Vec<String>>>,
    /// IDs currently being loaded — prevents TOCTOU double-activation.
    loading: Mutex<HashSet<String>>,
    /// Shared settings store — threaded to each extension's HostContext.
    settings: Option<std::sync::Arc<Mutex<crate::settings::SettingsStore>>>,
    /// Shared grammar registry for dynamic tree-sitter grammars.
    grammar_registry: Option<std::sync::Arc<crate::grammar_registry::GrammarRegistry>>,
    /// Webview panel ownership: panel_id → extension_id.
    panel_owners: Mutex<HashMap<String, String>>,
    /// Buffered webview events ready for the frontend to consume.
    wasm_webview_events: Mutex<Vec<WebviewPanelEvent>>,
    /// Extension IDs explicitly allowed to load native grammar dylibs.
    ///
    /// Loading a native shared library executes arbitrary code outside the WASM
    /// sandbox (DLL constructors run on load). Only extensions on this allowlist
    /// may use the `grammar-dylib` feature. All others have their dylib silently
    /// skipped with a warning — the WASM extension still activates, just without
    /// the native grammar.
    native_grammar_allowlist: Mutex<HashSet<String>>,
    /// Shutdown flag for the epoch ticker thread.
    epoch_ticker_shutdown: Arc<AtomicBool>,
}

// `WasmHostManager` is `Send + Sync` because all its fields are:
// • `Engine` — explicitly `Send + Sync` per wasmtime docs.
// • `Mutex<HashMap<String, WasmInstance>>` — `Mutex<T>: Send + Sync` when `T: Send`.
// • `WasmInstance` is `Send` because `Store<InstanceState>` is `Send` when `InstanceState`
//   is `Send` (all its fields are `Arc<Mutex<_>>`, `WasiCtx`, and `ResourceTable`, all Send)
//   and `wasmtime::component::Func` is `Send` (holds only store-internal indices).
// No `unsafe impl` is required — the compiler derives these automatically.

/// True iff `panel_id` is currently owned by `ext_id`. Panel IDs are a
/// global namespace shared across extensions, so every non-open operation
/// must verify ownership — otherwise one extension could post to, rewrite,
/// or close another extension's panel by reusing its ID.
fn panel_owned_by(owners: &std::collections::HashMap<String, String>, panel_id: &str, ext_id: &str) -> bool {
    match owners.get(panel_id) {
        Some(o) if o == ext_id => true,
        Some(o) => {
            log::warn!("[wasm-ext:{ext_id}] panel '{panel_id}' is owned by {o} — operation dropped");
            false
        }
        None => {
            log::warn!("[wasm-ext:{ext_id}] panel '{panel_id}' is not open — operation dropped");
            false
        }
    }
}

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
        // Enable epoch-based interruption as a wall-clock timeout defense-in-depth.
        // Fuel limits CPU instructions, but memory-intensive loops with low instruction
        // counts could still stall. The epoch ticker runs every second; stores get a
        // deadline of EPOCH_DEADLINE_TICKS ticks (~30 s).
        config.epoch_interruption(true);

        let engine =
            Engine::new(&config).map_err(|e| format!("wasmtime Engine::new failed: {e}"))?;

        // Spawn a background thread that increments the epoch every second.
        // The thread checks `shutdown` each iteration and exits cleanly when set.
        let shutdown = Arc::new(AtomicBool::new(false));
        {
            let engine_clone = engine.clone();
            let shutdown_clone = shutdown.clone();
            // The JoinHandle is intentionally dropped: the thread exits via the
            // `epoch_ticker_shutdown` flag set in `deactivate_all`, not via join.
            std::thread::Builder::new()
                .name("wasm-epoch-ticker".into())
                .spawn(move || {
                    while !shutdown_clone.load(Ordering::Relaxed) {
                        std::thread::sleep(std::time::Duration::from_secs(1));
                        engine_clone.increment_epoch();
                    }
                })
                .map_err(|e| format!("Failed to spawn epoch ticker thread: {e}"))?;
        }

        Ok(Self {
            engine,
            instances: Mutex::new(HashMap::new()),
            language_registry: Mutex::new(HashMap::new()),
            loading: Mutex::new(HashSet::new()),
            settings: None,
            grammar_registry: None,
            panel_owners: Mutex::new(HashMap::new()),
            wasm_webview_events: Mutex::new(Vec::new()),
            native_grammar_allowlist: Mutex::new(HashSet::new()),
            epoch_ticker_shutdown: shutdown,
        })
    }

    /// Attach the shared settings store so extensions can use `get-config`.
    pub fn set_settings(&mut self, settings: std::sync::Arc<Mutex<crate::settings::SettingsStore>>) {
        self.settings = Some(settings);
    }

    /// Attach the shared grammar registry for dynamic tree-sitter grammar loading.
    pub fn set_grammar_registry(&mut self, registry: std::sync::Arc<crate::grammar_registry::GrammarRegistry>) {
        self.grammar_registry = Some(registry);
    }

    /// Set the list of extension IDs allowed to load native grammar dylibs.
    ///
    /// Native dylibs execute arbitrary code outside the WASM sandbox, so only
    /// explicitly trusted extensions should be permitted to use this feature.
    /// Extensions not on this list that declare `grammar-dylib` will still
    /// activate — their dylib is simply skipped with a warning log.
    pub fn set_native_grammar_allowlist(&self, ids: HashSet<String>) {
        match self.native_grammar_allowlist.lock() {
            Ok(mut g) => *g = ids,
            Err(e) => log::error!("set_native_grammar_allowlist: mutex poisoned, ignoring update: {e}"),
        }
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

        // Prevent double-activation: check both loaded instances and in-flight loads
        // to close the TOCTOU window between the check and the final insert.
        {
            let instances = self.instances.lock().unwrap();
            if instances.contains_key(&id) {
                return Err(format!("Extension '{}' is already loaded", id));
            }
            let mut loading = self.loading.lock().unwrap();
            if !loading.insert(id.clone()) {
                return Err(format!("Extension '{}' is already being loaded", id));
            }
        }

        // RAII guard: always removes `id` from `loading` on drop — whether activation
        // succeeds or fails (including panics). This allows retry after any failure.
        struct LoadingGuard<'a> {
            loading: &'a Mutex<HashSet<String>>,
            id: String,
        }
        impl Drop for LoadingGuard<'_> {
            fn drop(&mut self) {
                if let Ok(mut set) = self.loading.lock() {
                    set.remove(&self.id);
                }
            }
        }
        let _guard = LoadingGuard {
            loading: &self.loading,
            id: id.clone(),
        };

        let host_ctx = HostContext::new(
            workspace_root,
            manifest.capabilities.workspace_read,
            id.clone(),
            self.settings.clone(),
            manifest.capabilities.webview_panels,
        );

        let mut instance = WasmInstance::load(&self.engine, ext_dir, &manifest, host_ctx)?;

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

        // If the manifest declares [grammar] with a grammar-dylib, load the
        // pre-packaged native grammar and register it in the shared registry.
        // Query strings (highlights, injections, bracket-pairs) come from the
        // WASM extension's grammar-provider exports (safe — text only).
        //
        // SECURITY: Native dylibs execute arbitrary code outside the WASM sandbox
        // (DLL constructors run on load). Only extensions on the allowlist may
        // load native dylibs. Others are skipped with a warning.
        if let Some(ref grammar_config) = manifest.grammar {
            if grammar_config.grammar_dylib.is_some() {
                let allowed = self.native_grammar_allowlist.lock().unwrap().contains(&id);
                if !allowed {
                    log::warn!(
                        "WASM ext '{}': grammar-dylib declared but extension is NOT on the \
                         native_grammar_allowlist — skipping native dylib load. \
                         Native dylibs execute code outside the WASM sandbox. \
                         Add '{}' to the allowlist in settings if you trust this extension.",
                        id, id,
                    );
                } else {
                    match self.load_grammar_from_manifest(&mut instance, ext_dir, grammar_config) {
                        Ok(()) => log::info!(
                            "WASM ext '{}': grammar registered for '{}'",
                            id, grammar_config.language_id,
                        ),
                        Err(e) => log::warn!(
                            "WASM ext '{}': grammar load failed: {e}",
                            id,
                        ),
                    }
                }
            }
        }

        // Process any webview ops the activate() call may have buffered.
        self.process_webview_ops(&id, &mut instance);

        self.instances.lock().unwrap().insert(id.clone(), instance);
        // _guard drops here, removing id from `loading`.
        Ok(id)
    }

    /// Load a tree-sitter grammar from a pre-packaged native dylib referenced in
    /// the extension manifest, then register it in the shared grammar registry.
    ///
    /// SECURITY: Loading a native shared library executes code outside the WASM
    /// sandbox (DLL constructors / `__attribute__((constructor))` run on load).
    /// Callers MUST gate access behind `native_grammar_allowlist` — only
    /// extensions explicitly trusted by the user should reach this function.
    /// The dylib path is validated to stay within the extension directory
    /// (defense-in-depth against path traversal), but the extension author
    /// controls the dylib contents, so the allowlist is the primary defense.
    fn load_grammar_from_manifest(
        &self,
        instance: &mut WasmInstance,
        ext_dir: &Path,
        config: &crate::wasm_host::manifest::GrammarConfig,
    ) -> Result<(), String> {
        let registry = self.grammar_registry.as_ref()
            .ok_or_else(|| "Grammar registry not attached".to_string())?;

        let dylib_rel = config.grammar_dylib.as_deref()
            .ok_or_else(|| "grammar.grammar-dylib not set in corecode.toml".to_string())?;

        let dylib_path = ext_dir.join(dylib_rel);

        // Validate the resolved path stays inside ext_dir (defense in depth).
        let canonical_dylib = std::fs::canonicalize(&dylib_path)
            .map_err(|e| format!("Cannot resolve grammar dylib '{}': {e}", dylib_path.display()))?;
        let canonical_ext = std::fs::canonicalize(ext_dir)
            .map_err(|e| format!("Cannot resolve ext dir: {e}"))?;
        if !canonical_dylib.starts_with(&canonical_ext) {
            return Err("Grammar dylib path escapes extension directory".to_string());
        }

        // Load the pre-packaged dylib.
        let (language, library) = crate::grammar_registry::load_from_dylib(
            &config.language_id,
            &canonical_dylib,
        )?;

        // Get highlights/injections/bracket-pairs from the WASM extension (safe — strings only).
        let highlights_query = instance.highlights_query().unwrap_or_else(|e| {
            log::warn!("[wasm-ext:{}] highlights-query failed, using empty: {e}", instance.id);
            String::new()
        });
        let injections_query = instance.injections_query().unwrap_or_else(|e| {
            log::warn!("[wasm-ext:{}] injections-query failed: {e}", instance.id);
            None
        });
        let bracket_pairs_json = instance.bracket_pairs().unwrap_or_else(|e| {
            log::warn!("[wasm-ext:{}] bracket-pairs failed, using empty: {e}", instance.id);
            "[]".to_string()
        });
        let bracket_pairs: Vec<[String; 2]> = serde_json::from_str(&bracket_pairs_json)
            .unwrap_or_else(|e| {
                log::warn!(
                    "[wasm-ext:{}] bracket-pairs JSON invalid, using empty: {e}",
                    instance.id
                );
                Vec::new()
            });

        let grammar = crate::grammar_registry::DynamicGrammar {
            language_id: config.language_id.clone(),
            file_types: config.file_types.clone(),
            language: std::sync::Arc::new(language),
            highlights_query,
            injections_query,
            bracket_pairs,
            _library: Some(library),
        };

        registry.register(grammar);
        Ok(())
    }

    /// Remove an extension's language claims from the registry.
    #[allow(dead_code)]
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
        self.panel_owners.lock().unwrap().clear();

        let mut map = self.instances.lock().unwrap();
        for (id, instance) in map.iter_mut() {
            log::info!("Deactivating WASM extension '{id}'");
            instance.deactivate();
        }
        map.clear();

        // Signal the epoch ticker thread to exit.
        self.epoch_ticker_shutdown.store(true, Ordering::Relaxed);
    }

    // ── Webview panel management ───────────────────────────────────────────
    //
    // Lock ordering: callers hold `instances` (or have a &mut WasmInstance),
    // then this code acquires `wasm_webview_events`, then `panel_owners`.
    // Never acquire `instances` while holding either webview lock.

    /// Process buffered webview operations from a single extension instance.
    ///
    /// For `Open` ops, calls the extension's `get-html` export to obtain initial
    /// HTML, then emits a "create" + "setHtml" event pair. Other ops map 1:1
    /// to `WebviewPanelEvent`s.
    ///
    /// Called with a live `&mut WasmInstance` — does NOT require `instances` to be locked.
    fn process_webview_ops(&self, ext_id: &str, instance: &mut WasmInstance) {
        let ops = instance.drain_webview_ops();
        if ops.is_empty() {
            return;
        }

        let mut events = self.wasm_webview_events.lock().unwrap();
        let mut owners = self.panel_owners.lock().unwrap();

        for op in ops {
            match op {
                PendingWebviewOp::Open { panel_id, title, column } => {
                    // Panel IDs are a shared namespace: opening an ID owned by
                    // another extension would silently steal it (and all its
                    // webview messages) — refuse instead.
                    if let Some(existing) = owners.get(&panel_id) {
                        if existing != ext_id {
                            log::warn!(
                                "[wasm-ext:{ext_id}] refusing to open panel '{panel_id}' — already owned by {existing}"
                            );
                            continue;
                        }
                    }

                    // Get initial HTML from the extension's webview-provider export.
                    // If the call traps (fuel/epoch), skip the panel entirely —
                    // emitting a "create" with no content would show a blank panel.
                    let html = if instance.has_webview_provider() {
                        match instance.get_html(&panel_id, "") {
                            Ok(h) => Some(h),
                            Err(e) => {
                                log::warn!(
                                    "[wasm-ext:{ext_id}] get-html for panel '{panel_id}' \
                                     failed — skipping panel creation: {e}"
                                );
                                continue;
                            }
                        }
                    } else {
                        None
                    };

                    // Register ownership only after successful get-html
                    owners.insert(panel_id.clone(), ext_id.to_string());

                    // Emit "create" event
                    events.push(WebviewPanelEvent {
                        kind: "create".to_string(),
                        panel_id: panel_id.clone(),
                        title: Some(title),
                        view_type: Some(format!("wasm.{ext_id}")),
                        column: Some(column),
                        enable_scripts: Some(true),
                        html: None,
                        message: None,
                    });

                    // Emit "setHtml" if we got initial content
                    if let Some(h) = html {
                        events.push(WebviewPanelEvent {
                            kind: "setHtml".to_string(),
                            panel_id,
                            title: None,
                            view_type: None,
                            column: None,
                            enable_scripts: None,
                            html: Some(h),
                            message: None,
                        });
                    }
                }
                PendingWebviewOp::SetHtml { panel_id, html } => {
                    if !panel_owned_by(&owners, &panel_id, ext_id) {
                        continue;
                    }
                    events.push(WebviewPanelEvent {
                        kind: "setHtml".to_string(),
                        panel_id,
                        title: None,
                        view_type: None,
                        column: None,
                        enable_scripts: None,
                        html: Some(html),
                        message: None,
                    });
                }
                PendingWebviewOp::PostMessage { panel_id, message } => {
                    if !panel_owned_by(&owners, &panel_id, ext_id) {
                        continue;
                    }
                    events.push(WebviewPanelEvent {
                        kind: "postMessage".to_string(),
                        panel_id,
                        title: None,
                        view_type: None,
                        column: None,
                        enable_scripts: None,
                        html: None,
                        message: Some(serde_json::Value::String(message)),
                    });
                }
                PendingWebviewOp::Close { panel_id } => {
                    if !panel_owned_by(&owners, &panel_id, ext_id) {
                        continue;
                    }
                    owners.remove(&panel_id);
                    events.push(WebviewPanelEvent {
                        kind: "close".to_string(),
                        panel_id,
                        title: None,
                        view_type: None,
                        column: None,
                        enable_scripts: None,
                        html: None,
                        message: None,
                    });
                }
            }
        }
    }

    /// Drain buffered webview events from WASM extensions.
    ///
    /// The frontend polls this alongside `ipc_bridge::drain_webview_events` and
    /// merges both sources — it is agnostic to whether events came from Node.js
    /// or WASM extensions.
    pub fn drain_webview_events(&self) -> Vec<WebviewPanelEvent> {
        let mut events = self.wasm_webview_events.lock().unwrap();
        std::mem::take(&mut *events)
    }

    /// Route a message from the frontend webview back to the owning WASM extension.
    ///
    /// Returns `Err` if the panel is not owned by any WASM extension.
    ///
    /// Note: `panel_owners` and `instances` are acquired in separate lock scopes. If the
    /// extension is deactivated between the two lock acquisitions, this returns
    /// `Err("Extension … not loaded")` and the message is silently dropped — an acceptable
    /// race given that deactivation also closes its panels on the frontend.
    pub fn route_webview_message(&self, panel_id: &str, message: &str) -> Result<(), String> {
        let ext_id = {
            let owners = self.panel_owners.lock().unwrap();
            owners.get(panel_id).cloned()
                .ok_or_else(|| format!("No WASM extension owns panel '{panel_id}'"))?
        };

        let mut instances = self.instances.lock().unwrap();
        let instance = instances.get_mut(&ext_id)
            .ok_or_else(|| format!("Extension '{ext_id}' not loaded"))?;

        instance.webview_on_message(panel_id, message)?;

        // Process any ops the on-message handler may have buffered
        let ext_id_clone = ext_id.clone();
        self.process_webview_ops(&ext_id_clone, instance);
        Ok(())
    }

    /// Notify the owning WASM extension that a webview panel was closed by the user.
    ///
    /// Removes ownership tracking. Returns `Err` if the panel is not owned by
    /// any WASM extension (the caller can silently ignore this for Node.js panels).
    pub fn route_webview_close(&self, panel_id: &str) -> Result<(), String> {
        let ext_id = {
            let mut owners = self.panel_owners.lock().unwrap();
            owners.remove(panel_id)
                .ok_or_else(|| format!("No WASM extension owns panel '{panel_id}'"))?
        };

        let mut instances = self.instances.lock().unwrap();
        if let Some(instance) = instances.get_mut(&ext_id) {
            if let Err(e) = instance.webview_on_close(panel_id) {
                log::warn!("[wasm-ext:{ext_id}] on-close for panel '{panel_id}' failed: {e}");
            }
            self.process_webview_ops(&ext_id, instance);
        }
        Ok(())
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

    /// Workspace symbols across every active extension (language-agnostic).
    /// Used for global symbol search where the originating file's language
    /// should not constrain results.
    pub fn workspace_symbols_all(&self, query: &str) -> Vec<Symbol> {
        let mut results = Vec::new();
        let mut instances = self.instances.lock().unwrap();
        for (id, inst) in instances.iter_mut() {
            match inst.workspace_symbols(query) {
                Ok(items) => results.extend(items),
                Err(e) => log::warn!("workspace-symbols error from {id}: {e}"),
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
    fn workspace_symbols_all_returns_empty_when_no_instances() {
        let mgr = make_manager();
        let syms = mgr.workspace_symbols_all("test");
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
    fn drain_webview_events_empty_initially() {
        let mgr = make_manager();
        assert!(mgr.drain_webview_events().is_empty());
    }

    #[test]
    fn route_message_to_unknown_panel_returns_err() {
        let mgr = make_manager();
        let result = mgr.route_webview_message("nonexistent", "{}");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No WASM extension owns panel"));
    }

    #[test]
    fn route_close_to_unknown_panel_returns_err() {
        let mgr = make_manager();
        let result = mgr.route_webview_close("nonexistent");
        assert!(result.is_err());
    }

    #[test]
    fn panel_ownership_enforced_for_foreign_extension() {
        // panel_owned_by is the guard every non-open webview op passes through:
        // only the owning extension may set HTML, post, or close a panel.
        let mut owners = std::collections::HashMap::new();
        owners.insert("panel-1".to_string(), "a.ext".to_string());

        assert!(panel_owned_by(&owners, "panel-1", "a.ext"), "owner must pass");
        assert!(!panel_owned_by(&owners, "panel-1", "b.ext"), "foreign extension must be rejected");
        assert!(!panel_owned_by(&owners, "unknown-panel", "a.ext"), "unowned panel must be rejected");
    }

    #[test]
    fn panel_owners_cleared_on_deactivate_all() {
        let mgr = make_manager();
        mgr.panel_owners.lock().unwrap().insert("test-panel".to_string(), "test.ext".to_string());
        mgr.deactivate_all();
        assert!(mgr.panel_owners.lock().unwrap().is_empty());
    }

    #[test]
    fn native_grammar_allowlist_empty_by_default() {
        let mgr = make_manager();
        assert!(mgr.native_grammar_allowlist.lock().unwrap().is_empty());
    }

    #[test]
    fn set_native_grammar_allowlist_stores_ids() {
        let mgr = make_manager();
        let mut ids = HashSet::new();
        ids.insert("trusted.grammar-ext".to_string());
        ids.insert("another.grammar-ext".to_string());
        mgr.set_native_grammar_allowlist(ids);
        let stored = mgr.native_grammar_allowlist.lock().unwrap();
        assert_eq!(stored.len(), 2);
        assert!(stored.contains("trusted.grammar-ext"));
        assert!(stored.contains("another.grammar-ext"));
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
