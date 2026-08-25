//! Per-extension WASM component instance.
//!
//! Each `WasmInstance` holds a `wasmtime::Store` and the typed function handles
//! for the lifecycle exports. Linker setup links the host import implementations
//! from `api_impl.rs` into the WASM component's import namespace.

use crate::wasm_host::api_impl::HostContext;
use crate::wasm_host::manifest::CoreCodeManifest;
use crate::wasm_host::wit_types::{self, *};
use std::path::Path;
use wasmtime::component::{Component, Func, Linker, Val};
use wasmtime::{Engine, Store, StoreLimitsBuilder};
use wasmtime_wasi::{ResourceTable, WasiCtx, WasiCtxBuilder, WasiView};

/// Maximum size of a WASM binary that the host will load (50 MB).
const MAX_WASM_SIZE: u64 = 50 * 1024 * 1024;

/// Fuel budget per top-level extension call (~1 billion Wasm instructions).
/// When exhausted, wasmtime traps with "all fuel consumed", preventing infinite loops.
const FUEL_PER_CALL: u64 = 1_000_000_000;

/// Epoch deadline in ticks. The epoch ticker thread increments once per second,
/// so 30 ticks ≈ 30 seconds wall-clock timeout per call as defense-in-depth.
const EPOCH_DEADLINE_TICKS: u64 = 30;

/// Maximum WASM linear memory per extension instance (256 MB).
const MAX_WASM_MEMORY: usize = 256 * 1024 * 1024;

/// State stored inside each `wasmtime::Store`.
pub(super) struct InstanceState {
    wasi: WasiCtx,
    table: ResourceTable,
    pub(super) host_ctx: HostContext,
    /// Memory limiter — enforces MAX_WASM_MEMORY to prevent exhaustion attacks.
    limits: wasmtime::StoreLimits,
}

impl WasiView for InstanceState {
    fn table(&mut self) -> &mut ResourceTable {
        &mut self.table
    }
    fn ctx(&mut self) -> &mut WasiCtx {
        &mut self.wasi
    }
}

/// A loaded and activated WASM extension component.
pub struct WasmInstance {
    pub id: String,
    store: Store<InstanceState>,
    activate_fn: Func,
    deactivate_fn: Func,
    // Optional language-provider exports — None if not exported by the extension.
    completions_fn: Option<Func>,
    hover_fn: Option<Func>,
    diagnostics_fn: Option<Func>,
    format_document_fn: Option<Func>,
    format_range_fn: Option<Func>,
    definition_fn: Option<Func>,
    references_fn: Option<Func>,
    rename_fn: Option<Func>,
    code_actions_fn: Option<Func>,
    workspace_symbols_fn: Option<Func>,
    folding_ranges_fn: Option<Func>,
    // Optional grammar-provider exports — None if not exported by the extension.
    // NOTE: grammar-wasm was intentionally removed — native dylibs are loaded
    // from pre-packaged files referenced in corecode.toml, not from bytes
    // returned by WASM code, to prevent sandbox escapes.
    highlights_query_fn: Option<Func>,
    injections_query_fn: Option<Func>,
    bracket_pairs_fn: Option<Func>,
    // Optional webview-provider exports.
    get_html_fn: Option<Func>,
    on_message_fn: Option<Func>,
    on_close_fn: Option<Func>,
}

impl WasmInstance {
    /// Load the WASM component from disk and link all host imports.
    pub fn load(
        engine: &Engine,
        ext_dir: &Path,
        manifest: &CoreCodeManifest,
        host_ctx: HostContext,
    ) -> Result<Self, String> {
        let wasm_path = manifest.wasm_path(ext_dir);

        // Reject oversized files before allocating memory.
        let wasm_size = std::fs::metadata(&wasm_path)
            .map_err(|e| format!("Cannot stat '{}': {e}", wasm_path.display()))?
            .len();
        if wasm_size > MAX_WASM_SIZE {
            return Err(format!(
                "'{}' is {wasm_size} bytes — exceeds the 50 MB WASM size limit",
                wasm_path.display()
            ));
        }

        let wasm_bytes = std::fs::read(&wasm_path)
            .map_err(|e| format!("Cannot read '{}': {e}", wasm_path.display()))?;

        let component = Component::new(engine, &wasm_bytes)
            .map_err(|e| format!("Invalid WASM component: {e}"))?;

        // Minimal WASI context — no filesystem, no networking, no env vars.
        let wasi = WasiCtxBuilder::new().build();
        let table = ResourceTable::new();
        let limits = StoreLimitsBuilder::new()
            .memory_size(MAX_WASM_MEMORY)
            .build();
        let state = InstanceState {
            wasi,
            table,
            host_ctx,
            limits,
        };
        let mut store = Store::new(engine, state);
        // Set epoch deadline so the store traps after ~30 seconds wall-clock time.
        store.set_epoch_deadline(EPOCH_DEADLINE_TICKS);
        // Enforce memory limit — traps if the WASM module tries to grow past MAX_WASM_MEMORY.
        store.limiter(|s| &mut s.limits);

        // Build the component linker.
        let mut linker: Linker<InstanceState> = Linker::new(engine);

        // Add standard WASI imports.
        wasmtime_wasi::add_to_linker_sync(&mut linker)
            .map_err(|e| format!("Failed to add WASI to linker: {e}"))?;

        // Link corecode:extension/ui imports.
        {
            let mut ui = linker
                .instance("corecode:extension/ui")
                .map_err(|e| format!("Failed to define ui instance: {e}"))?;

            ui.func_wrap(
                "log",
                |mut cx: wasmtime::StoreContextMut<'_, InstanceState>,
                 (channel, message): (String, String)| {
                    super::api_impl::host_log(&mut cx.data_mut().host_ctx, channel, message);
                    Ok(())
                },
            )
            .map_err(|e| format!("Failed to link ui::log: {e}"))?;

            ui.func_wrap(
                "show-message",
                |mut cx: wasmtime::StoreContextMut<'_, InstanceState>,
                 (level, message): (String, String)| {
                    super::api_impl::host_show_message(&mut cx.data_mut().host_ctx, level, message);
                    Ok(())
                },
            )
            .map_err(|e| format!("Failed to link ui::show-message: {e}"))?;

            ui.func_wrap(
                "set-status",
                |mut cx: wasmtime::StoreContextMut<'_, InstanceState>,
                 (id, text, tooltip): (String, String, Option<String>)| {
                    super::api_impl::host_set_status(
                        &mut cx.data_mut().host_ctx,
                        id,
                        text,
                        tooltip,
                    );
                    Ok(())
                },
            )
            .map_err(|e| format!("Failed to link ui::set-status: {e}"))?;
        }

        // Link corecode:extension/workspace imports.
        {
            let mut ws = linker
                .instance("corecode:extension/workspace")
                .map_err(|e| format!("Failed to define workspace instance: {e}"))?;

            ws.func_wrap(
                "root-uri",
                |mut cx: wasmtime::StoreContextMut<'_, InstanceState>, (): ()| {
                    let uri = super::api_impl::host_root_uri(&mut cx.data_mut().host_ctx);
                    Ok((uri,))
                },
            )
            .map_err(|e| format!("Failed to link workspace::root-uri: {e}"))?;

            ws.func_wrap(
                "read-file",
                |mut cx: wasmtime::StoreContextMut<'_, InstanceState>, (path,): (String,)| {
                    let result = super::api_impl::host_read_file(&mut cx.data_mut().host_ctx, path);
                    Ok((result,))
                },
            )
            .map_err(|e| format!("Failed to link workspace::read-file: {e}"))?;

            ws.func_wrap(
                "find-files",
                |mut cx: wasmtime::StoreContextMut<'_, InstanceState>, (glob,): (String,)| {
                    let result =
                        super::api_impl::host_find_files(&mut cx.data_mut().host_ctx, glob);
                    Ok((result,))
                },
            )
            .map_err(|e| format!("Failed to link workspace::find-files: {e}"))?;

            ws.func_wrap(
                "get-config",
                |mut cx: wasmtime::StoreContextMut<'_, InstanceState>, (key,): (String,)| {
                    let val = super::api_impl::host_get_config(&mut cx.data_mut().host_ctx, key);
                    Ok((val,))
                },
            )
            .map_err(|e| format!("Failed to link workspace::get-config: {e}"))?;
        }

        // Link corecode:extension/webview imports.
        {
            let mut wv = linker
                .instance("corecode:extension/webview")
                .map_err(|e| format!("Failed to define webview instance: {e}"))?;

            wv.func_wrap(
                "open-panel",
                |mut cx: wasmtime::StoreContextMut<'_, InstanceState>,
                 (panel_id, title, column): (String, String, u32)| {
                    let result = super::api_impl::host_open_panel(
                        &mut cx.data_mut().host_ctx,
                        panel_id,
                        title,
                        column,
                    );
                    Ok((result,))
                },
            )
            .map_err(|e| format!("Failed to link webview::open-panel: {e}"))?;

            wv.func_wrap(
                "set-html",
                |mut cx: wasmtime::StoreContextMut<'_, InstanceState>,
                 (panel_id, html): (String, String)| {
                    let result =
                        super::api_impl::host_set_html(&mut cx.data_mut().host_ctx, panel_id, html);
                    Ok((result,))
                },
            )
            .map_err(|e| format!("Failed to link webview::set-html: {e}"))?;

            wv.func_wrap(
                "post-message",
                |mut cx: wasmtime::StoreContextMut<'_, InstanceState>,
                 (panel_id, message): (String, String)| {
                    let result = super::api_impl::host_post_to_webview(
                        &mut cx.data_mut().host_ctx,
                        panel_id,
                        message,
                    );
                    Ok((result,))
                },
            )
            .map_err(|e| format!("Failed to link webview::post-message: {e}"))?;

            wv.func_wrap(
                "close-panel",
                |mut cx: wasmtime::StoreContextMut<'_, InstanceState>, (panel_id,): (String,)| {
                    let result =
                        super::api_impl::host_close_panel(&mut cx.data_mut().host_ctx, panel_id);
                    Ok((result,))
                },
            )
            .map_err(|e| format!("Failed to link webview::close-panel: {e}"))?;
        }

        // Instantiate the component.
        let instance = linker
            .instantiate(&mut store, &component)
            .map_err(|e| format!("Instantiation failed: {e}"))?;

        // Retrieve the lifecycle exports by their fully-qualified WIT name.
        let activate_fn = instance
            .get_func(&mut store, "corecode:extension/lifecycle#activate")
            .ok_or_else(|| {
                "WASM component is missing export 'corecode:extension/lifecycle#activate'"
                    .to_string()
            })?;

        let deactivate_fn = instance
            .get_func(&mut store, "corecode:extension/lifecycle#deactivate")
            .ok_or_else(|| {
                "WASM component is missing export 'corecode:extension/lifecycle#deactivate'"
                    .to_string()
            })?;

        // Retrieve optional language-provider exports.
        let mut lp = |name: &str| -> Option<Func> {
            instance.get_func(
                &mut store,
                &format!("corecode:extension/language-provider#{name}"),
            )
        };

        let completions_fn = lp("completions");
        let hover_fn = lp("hover");
        let diagnostics_fn = lp("diagnostics");
        let format_document_fn = lp("format-document");
        let format_range_fn = lp("format-range");
        let definition_fn = lp("definition");
        let references_fn = lp("references");
        let rename_fn = lp("rename");
        let code_actions_fn = lp("code-actions");
        let workspace_symbols_fn = lp("workspace-symbols");
        let folding_ranges_fn = lp("folding-ranges");

        if completions_fn.is_some()
            || hover_fn.is_some()
            || diagnostics_fn.is_some()
            || format_document_fn.is_some()
            || format_range_fn.is_some()
            || definition_fn.is_some()
            || references_fn.is_some()
            || rename_fn.is_some()
            || code_actions_fn.is_some()
            || workspace_symbols_fn.is_some()
            || folding_ranges_fn.is_some()
        {
            log::info!(
                "WASM ext '{}': language-provider exports detected",
                manifest.extension.id,
            );
        }

        // Retrieve optional grammar-provider exports.
        let mut gp = |name: &str| -> Option<Func> {
            instance.get_func(
                &mut store,
                &format!("corecode:extension/grammar-provider#{name}"),
            )
        };

        let highlights_query_fn = gp("highlights-query");
        let injections_query_fn = gp("injections-query");
        let bracket_pairs_fn = gp("bracket-pairs");

        if highlights_query_fn.is_some() {
            log::info!(
                "WASM ext '{}': grammar-provider exports detected",
                manifest.extension.id,
            );
        }

        // Retrieve optional webview-provider exports.
        let mut wp = |name: &str| -> Option<Func> {
            instance.get_func(
                &mut store,
                &format!("corecode:extension/webview-provider#{name}"),
            )
        };

        let get_html_fn = wp("get-html");
        let on_message_fn = wp("on-message");
        let on_close_fn = wp("on-close");

        if get_html_fn.is_some() {
            log::info!(
                "WASM ext '{}': webview-provider exports detected",
                manifest.extension.id,
            );
        }

        Ok(WasmInstance {
            id: manifest.extension.id.clone(),
            store,
            activate_fn,
            deactivate_fn,
            completions_fn,
            hover_fn,
            diagnostics_fn,
            format_document_fn,
            format_range_fn,
            definition_fn,
            references_fn,
            rename_fn,
            code_actions_fn,
            workspace_symbols_fn,
            folding_ranges_fn,
            highlights_query_fn,
            injections_query_fn,
            bracket_pairs_fn,
            get_html_fn,
            on_message_fn,
            on_close_fn,
        })
    }

    /// Call the extension's `lifecycle::activate` export.
    pub fn activate(&mut self) -> Result<(), String> {
        self.store
            .set_fuel(FUEL_PER_CALL)
            .map_err(|e| format!("activate: set_fuel failed: {e}"))?;
        self.store.set_epoch_deadline(EPOCH_DEADLINE_TICKS);

        let mut results = vec![Val::Bool(false)];
        self.activate_fn
            .call(&mut self.store, &[], &mut results)
            .map_err(|e| format!("activate trap: {e}"))?;

        // Inspect the result BEFORE calling post_return, which may deallocate return values.
        let outcome = match results.into_iter().next() {
            Some(Val::Result(Ok(_))) => Ok(()),
            Some(Val::Result(Err(Some(boxed)))) => match *boxed {
                Val::String(msg) => Err(msg.to_string()),
                other => Err(format!("activate returned error: {other:?}")),
            },
            Some(Val::Result(Err(None))) => Err("activate returned error (no message)".to_string()),
            other => Err(format!("activate: unexpected return value: {other:?}")),
        };

        self.activate_fn
            .post_return(&mut self.store)
            .map_err(|e| format!("activate post-return: {e}"))?;

        outcome
    }

    /// Call the extension's `lifecycle::deactivate` export.
    pub fn deactivate(&mut self) {
        if let Err(e) = self.store.set_fuel(FUEL_PER_CALL) {
            log::warn!("[wasm-ext:{}] deactivate: set_fuel failed: {e}", self.id);
        }
        self.store.set_epoch_deadline(EPOCH_DEADLINE_TICKS);
        if let Err(e) = self.deactivate_fn.call(&mut self.store, &[], &mut []) {
            log::warn!("[wasm-ext:{}] deactivate trap: {e}", self.id);
        }
        let _ = self.deactivate_fn.post_return(&mut self.store);
    }

    /// Update the workspace root pushed to this extension's host context.
    ///
    /// Called when the user opens a folder after the extension was already activated.
    pub fn set_workspace_root(&mut self, root: Option<std::path::PathBuf>) {
        self.store.data_mut().host_ctx.workspace_root = root;
    }

    /// Read and drain the buffered output lines from this extension's context.
    pub fn drain_output_lines(&mut self) -> Vec<(String, String)> {
        match self.store.data_mut().host_ctx.output_lines.lock() {
            Ok(mut v) => std::mem::take(&mut *v),
            Err(e) => {
                log::error!(
                    "drain_output_lines: mutex poisoned for ext '{}', recovering: {e}",
                    self.id,
                );
                std::mem::take(&mut *e.into_inner())
            }
        }
    }

    /// Read and drain buffered notification toasts from this extension.
    pub fn drain_notifications(&mut self) -> Vec<(String, String)> {
        match self.store.data_mut().host_ctx.notifications.lock() {
            Ok(mut v) => std::mem::take(&mut *v),
            Err(e) => {
                log::error!(
                    "drain_notifications: mutex poisoned for ext '{}', recovering: {e}",
                    self.id,
                );
                std::mem::take(&mut *e.into_inner())
            }
        }
    }

    /// Read the current status bar items (not drained — items persist until removed).
    pub fn get_status_items(&self) -> Vec<(String, String, Option<String>)> {
        self.store
            .data()
            .host_ctx
            .status_items
            .lock()
            .map(|items| {
                items
                    .iter()
                    .map(|(id, (text, tooltip))| (id.clone(), text.clone(), tooltip.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    // ── Language provider dispatch methods ────────────────────────────────────

    /// Helper: call an export function with fuel and error handling.
    /// The caller must inspect `results` before calling `post_return_export`.
    fn call_export(
        &mut self,
        func: &Func,
        args: &[Val],
        results: &mut [Val],
        name: &str,
    ) -> Result<(), String> {
        self.store
            .set_fuel(FUEL_PER_CALL)
            .map_err(|e| format!("{name}: set_fuel failed: {e}"))?;
        // Reset wall-clock deadline for this call.
        self.store.set_epoch_deadline(EPOCH_DEADLINE_TICKS);
        func.call(&mut self.store, args, results)
            .map_err(|e| format!("{name} trap: {e}"))?;
        Ok(())
    }

    /// Call post_return after results have been inspected.
    fn post_return_export(&mut self, func: &Func, name: &str) -> Result<(), String> {
        func.post_return(&mut self.store)
            .map_err(|e| format!("{name} post-return: {e}"))
    }

    /// Call language-provider#completions if exported.
    pub fn completions(
        &mut self,
        uri: &str,
        line: u32,
        character: u32,
        trigger: Option<&str>,
    ) -> Result<Vec<CompletionItem>, String> {
        let func = match &self.completions_fn {
            Some(f) => f.clone(),
            None => return Ok(vec![]),
        };
        let pos = Position { line, character };
        let trigger_val = match trigger {
            Some(s) => Val::Option(Some(Box::new(Val::String(s.to_string())))),
            None => Val::Option(None),
        };
        let mut results = vec![Val::Bool(false)]; // placeholder
        self.call_export(
            &func,
            &[Val::String(uri.to_string()), pos.to_val(), trigger_val],
            &mut results,
            "completions",
        )?;
        let outcome = wit_types::unwrap_result_list(&results[0], CompletionItem::from_val);
        self.post_return_export(&func, "completions")?;
        outcome
    }

    /// Call language-provider#hover if exported.
    pub fn hover(
        &mut self,
        uri: &str,
        line: u32,
        character: u32,
    ) -> Result<Option<HoverResult>, String> {
        let func = match &self.hover_fn {
            Some(f) => f.clone(),
            None => return Ok(None),
        };
        let pos = Position { line, character };
        let mut results = vec![Val::Bool(false)];
        self.call_export(
            &func,
            &[Val::String(uri.to_string()), pos.to_val()],
            &mut results,
            "hover",
        )?;
        let outcome = wit_types::unwrap_result_option(&results[0], HoverResult::from_val);
        self.post_return_export(&func, "hover")?;
        outcome
    }

    /// Call language-provider#diagnostics if exported.
    pub fn diagnostics(&mut self, uri: &str, content: &str) -> Result<Vec<Diagnostic>, String> {
        let func = match &self.diagnostics_fn {
            Some(f) => f.clone(),
            None => return Ok(vec![]),
        };
        let mut results = vec![Val::Bool(false)];
        self.call_export(
            &func,
            &[
                Val::String(uri.to_string()),
                Val::String(content.to_string()),
            ],
            &mut results,
            "diagnostics",
        )?;
        let outcome = wit_types::unwrap_result_list(&results[0], Diagnostic::from_val);
        self.post_return_export(&func, "diagnostics")?;
        outcome
    }

    /// Call language-provider#format-document if exported.
    pub fn format_document(&mut self, uri: &str, content: &str) -> Result<Vec<TextEdit>, String> {
        let func = match &self.format_document_fn {
            Some(f) => f.clone(),
            None => return Ok(vec![]),
        };
        let mut results = vec![Val::Bool(false)];
        self.call_export(
            &func,
            &[
                Val::String(uri.to_string()),
                Val::String(content.to_string()),
            ],
            &mut results,
            "format-document",
        )?;
        let outcome = wit_types::unwrap_result_list(&results[0], TextEdit::from_val);
        self.post_return_export(&func, "format-document")?;
        outcome
    }

    /// Call language-provider#format-range if exported.
    pub fn format_range(
        &mut self,
        uri: &str,
        content: &str,
        range: &Range,
    ) -> Result<Vec<TextEdit>, String> {
        let func = match &self.format_range_fn {
            Some(f) => f.clone(),
            None => return Ok(vec![]),
        };
        let mut results = vec![Val::Bool(false)];
        self.call_export(
            &func,
            &[
                Val::String(uri.to_string()),
                Val::String(content.to_string()),
                range.to_val(),
            ],
            &mut results,
            "format-range",
        )?;
        let outcome = wit_types::unwrap_result_list(&results[0], TextEdit::from_val);
        self.post_return_export(&func, "format-range")?;
        outcome
    }

    /// Call language-provider#definition if exported.
    pub fn definition(
        &mut self,
        uri: &str,
        line: u32,
        character: u32,
    ) -> Result<Option<Location>, String> {
        let func = match &self.definition_fn {
            Some(f) => f.clone(),
            None => return Ok(None),
        };
        let pos = Position { line, character };
        let mut results = vec![Val::Bool(false)];
        self.call_export(
            &func,
            &[Val::String(uri.to_string()), pos.to_val()],
            &mut results,
            "definition",
        )?;
        let outcome = wit_types::unwrap_result_option(&results[0], Location::from_val);
        self.post_return_export(&func, "definition")?;
        outcome
    }

    /// Call language-provider#references if exported.
    pub fn references(
        &mut self,
        uri: &str,
        line: u32,
        character: u32,
        include_decl: bool,
    ) -> Result<Vec<Location>, String> {
        let func = match &self.references_fn {
            Some(f) => f.clone(),
            None => return Ok(vec![]),
        };
        let pos = Position { line, character };
        let mut results = vec![Val::Bool(false)];
        self.call_export(
            &func,
            &[
                Val::String(uri.to_string()),
                pos.to_val(),
                Val::Bool(include_decl),
            ],
            &mut results,
            "references",
        )?;
        let outcome = wit_types::unwrap_result_list(&results[0], Location::from_val);
        self.post_return_export(&func, "references")?;
        outcome
    }

    /// Call language-provider#rename if exported.
    pub fn rename(
        &mut self,
        uri: &str,
        line: u32,
        character: u32,
        new_name: &str,
    ) -> Result<Vec<TextEdit>, String> {
        let func = match &self.rename_fn {
            Some(f) => f.clone(),
            None => return Ok(vec![]),
        };
        let pos = Position { line, character };
        let mut results = vec![Val::Bool(false)];
        self.call_export(
            &func,
            &[
                Val::String(uri.to_string()),
                pos.to_val(),
                Val::String(new_name.to_string()),
            ],
            &mut results,
            "rename",
        )?;
        let outcome = wit_types::unwrap_result_list(&results[0], TextEdit::from_val);
        self.post_return_export(&func, "rename")?;
        outcome
    }

    /// Call language-provider#code-actions if exported.
    pub fn code_actions(
        &mut self,
        uri: &str,
        range: &Range,
        diagnostics: &[Diagnostic],
    ) -> Result<Vec<CodeAction>, String> {
        let func = match &self.code_actions_fn {
            Some(f) => f.clone(),
            None => return Ok(vec![]),
        };
        let diag_vals: Vec<Val> = diagnostics.iter().map(|d| d.to_val()).collect();
        let mut results = vec![Val::Bool(false)];
        self.call_export(
            &func,
            &[
                Val::String(uri.to_string()),
                range.to_val(),
                Val::List(diag_vals),
            ],
            &mut results,
            "code-actions",
        )?;
        let outcome = wit_types::unwrap_result_list(&results[0], CodeAction::from_val);
        self.post_return_export(&func, "code-actions")?;
        outcome
    }

    /// Call language-provider#workspace-symbols if exported.
    pub fn workspace_symbols(&mut self, query: &str) -> Result<Vec<Symbol>, String> {
        let func = match &self.workspace_symbols_fn {
            Some(f) => f.clone(),
            None => return Ok(vec![]),
        };
        let mut results = vec![Val::Bool(false)];
        self.call_export(
            &func,
            &[Val::String(query.to_string())],
            &mut results,
            "workspace-symbols",
        )?;
        let outcome = wit_types::unwrap_result_list(&results[0], Symbol::from_val);
        self.post_return_export(&func, "workspace-symbols")?;
        outcome
    }

    /// Call language-provider#folding-ranges if exported.
    pub fn folding_ranges(
        &mut self,
        uri: &str,
        content: &str,
    ) -> Result<Vec<FoldingRange>, String> {
        let func = match &self.folding_ranges_fn {
            Some(f) => f.clone(),
            None => return Ok(vec![]),
        };
        let mut results = vec![Val::Bool(false)];
        self.call_export(
            &func,
            &[
                Val::String(uri.to_string()),
                Val::String(content.to_string()),
            ],
            &mut results,
            "folding-ranges",
        )?;
        let outcome = wit_types::unwrap_result_list(&results[0], FoldingRange::from_val);
        self.post_return_export(&func, "folding-ranges")?;
        outcome
    }

    // ── Grammar provider dispatch methods ──────────────────────────────────

    /// Call grammar-provider#highlights-query if exported.
    pub fn highlights_query(&mut self) -> Result<String, String> {
        let func = match &self.highlights_query_fn {
            Some(f) => f.clone(),
            None => return Ok(String::new()),
        };
        let mut results = vec![Val::Bool(false)];
        self.call_export(&func, &[], &mut results, "highlights-query")?;
        let outcome = match &results[0] {
            Val::String(s) => Ok(s.to_string()),
            other => Err(format!("highlights-query: unexpected return: {other:?}")),
        };
        self.post_return_export(&func, "highlights-query")?;
        outcome
    }

    /// Call grammar-provider#injections-query if exported.
    pub fn injections_query(&mut self) -> Result<Option<String>, String> {
        let func = match &self.injections_query_fn {
            Some(f) => f.clone(),
            None => return Ok(None),
        };
        let mut results = vec![Val::Bool(false)];
        self.call_export(&func, &[], &mut results, "injections-query")?;
        let outcome = match &results[0] {
            Val::Option(Some(boxed)) => match boxed.as_ref() {
                Val::String(s) => Ok(Some(s.to_string())),
                other => Err(format!("injections-query: unexpected inner: {other:?}")),
            },
            Val::Option(None) => Ok(None),
            other => Err(format!("injections-query: unexpected return: {other:?}")),
        };
        self.post_return_export(&func, "injections-query")?;
        outcome
    }

    /// Call grammar-provider#bracket-pairs if exported.
    pub fn bracket_pairs(&mut self) -> Result<String, String> {
        let func = match &self.bracket_pairs_fn {
            Some(f) => f.clone(),
            None => return Ok("[]".to_string()),
        };
        let mut results = vec![Val::Bool(false)];
        self.call_export(&func, &[], &mut results, "bracket-pairs")?;
        let outcome = match &results[0] {
            Val::String(s) => Ok(s.to_string()),
            other => Err(format!("bracket-pairs: unexpected return: {other:?}")),
        };
        self.post_return_export(&func, "bracket-pairs")?;
        outcome
    }

    // ── Webview provider dispatch methods ──────────────────────────────────────

    pub fn has_webview_provider(&self) -> bool {
        self.get_html_fn.is_some()
    }

    /// Call webview-provider#get-html if exported.
    pub fn get_html(&mut self, panel_id: &str, state: &str) -> Result<String, String> {
        let func = match &self.get_html_fn {
            Some(f) => f.clone(),
            None => return Ok(String::new()),
        };
        let mut results = vec![Val::Bool(false)];
        self.call_export(
            &func,
            &[Val::String(panel_id.into()), Val::String(state.into())],
            &mut results,
            "get-html",
        )?;
        let outcome = match &results[0] {
            Val::String(s) => Ok(s.to_string()),
            other => Err(format!("get-html: unexpected return: {other:?}")),
        };
        self.post_return_export(&func, "get-html")?;
        outcome
    }

    /// Call webview-provider#on-message if exported.
    pub fn webview_on_message(&mut self, panel_id: &str, message: &str) -> Result<(), String> {
        let func = match &self.on_message_fn {
            Some(f) => f.clone(),
            None => return Ok(()),
        };
        self.call_export(
            &func,
            &[Val::String(panel_id.into()), Val::String(message.into())],
            &mut [],
            "on-message",
        )?;
        self.post_return_export(&func, "on-message")
    }

    /// Call webview-provider#on-close if exported.
    pub fn webview_on_close(&mut self, panel_id: &str) -> Result<(), String> {
        let func = match &self.on_close_fn {
            Some(f) => f.clone(),
            None => return Ok(()),
        };
        self.call_export(&func, &[Val::String(panel_id.into())], &mut [], "on-close")?;
        self.post_return_export(&func, "on-close")
    }

    /// Drain any buffered webview operations from this instance's HostContext.
    pub fn drain_webview_ops(&mut self) -> Vec<super::api_impl::PendingWebviewOp> {
        self.store
            .data_mut()
            .host_ctx
            .webview_ops
            .lock()
            .map(|mut v| std::mem::take(&mut *v))
            .unwrap_or_default()
    }
}
