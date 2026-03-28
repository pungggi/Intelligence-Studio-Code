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
use wasmtime::{Engine, Store};
use wasmtime_wasi::{ResourceTable, WasiCtx, WasiCtxBuilder, WasiView};

/// Maximum size of a WASM binary that the host will load (50 MB).
const MAX_WASM_SIZE: u64 = 50 * 1024 * 1024;

/// Fuel budget per top-level extension call (~1 billion Wasm instructions).
/// When exhausted, wasmtime traps with "all fuel consumed", preventing infinite loops.
const FUEL_PER_CALL: u64 = 1_000_000_000;

/// State stored inside each `wasmtime::Store`.
pub(super) struct InstanceState {
    wasi: WasiCtx,
    table: ResourceTable,
    pub(super) host_ctx: HostContext,
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
        let state = InstanceState { wasi, table, host_ctx };
        let mut store = Store::new(engine, state);

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
                    super::api_impl::host_show_message(
                        &mut cx.data_mut().host_ctx,
                        level,
                        message,
                    );
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
                    let result =
                        super::api_impl::host_read_file(&mut cx.data_mut().host_ctx, path);
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
                    let val =
                        super::api_impl::host_get_config(&mut cx.data_mut().host_ctx, key);
                    Ok((val,))
                },
            )
            .map_err(|e| format!("Failed to link workspace::get-config: {e}"))?;
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

        if completions_fn.is_some() || diagnostics_fn.is_some() || hover_fn.is_some() {
            log::info!(
                "WASM ext '{}': language-provider exports detected",
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
        })
    }

    /// Call the extension's `lifecycle::activate` export.
    pub fn activate(&mut self) -> Result<(), String> {
        self.store
            .set_fuel(FUEL_PER_CALL)
            .map_err(|e| format!("activate: set_fuel failed: {e}"))?;

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
        self.store
            .data_mut()
            .host_ctx
            .output_lines
            .lock()
            .map(|mut v| std::mem::take(&mut *v))
            .unwrap_or_default()
    }

    /// Read and drain buffered notification toasts from this extension.
    pub fn drain_notifications(&mut self) -> Vec<(String, String)> {
        self.store
            .data_mut()
            .host_ctx
            .notifications
            .lock()
            .map(|mut v| std::mem::take(&mut *v))
            .unwrap_or_default()
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

    /// Whether this extension exports any language-provider functions.
    pub fn has_language_provider(&self) -> bool {
        self.completions_fn.is_some()
            || self.hover_fn.is_some()
            || self.diagnostics_fn.is_some()
            || self.format_document_fn.is_some()
            || self.format_range_fn.is_some()
            || self.definition_fn.is_some()
            || self.references_fn.is_some()
            || self.rename_fn.is_some()
            || self.code_actions_fn.is_some()
            || self.workspace_symbols_fn.is_some()
            || self.folding_ranges_fn.is_some()
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
    pub fn diagnostics(
        &mut self,
        uri: &str,
        content: &str,
    ) -> Result<Vec<Diagnostic>, String> {
        let func = match &self.diagnostics_fn {
            Some(f) => f.clone(),
            None => return Ok(vec![]),
        };
        let mut results = vec![Val::Bool(false)];
        self.call_export(
            &func,
            &[Val::String(uri.to_string()), Val::String(content.to_string())],
            &mut results,
            "diagnostics",
        )?;
        let outcome = wit_types::unwrap_result_list(&results[0], Diagnostic::from_val);
        self.post_return_export(&func, "diagnostics")?;
        outcome
    }

    /// Call language-provider#format-document if exported.
    pub fn format_document(
        &mut self,
        uri: &str,
        content: &str,
    ) -> Result<Vec<TextEdit>, String> {
        let func = match &self.format_document_fn {
            Some(f) => f.clone(),
            None => return Ok(vec![]),
        };
        let mut results = vec![Val::Bool(false)];
        self.call_export(
            &func,
            &[Val::String(uri.to_string()), Val::String(content.to_string())],
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
            &[Val::String(uri.to_string()), pos.to_val(), Val::Bool(include_decl)],
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
    pub fn workspace_symbols(
        &mut self,
        query: &str,
    ) -> Result<Vec<Symbol>, String> {
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
            &[Val::String(uri.to_string()), Val::String(content.to_string())],
            &mut results,
            "folding-ranges",
        )?;
        let outcome = wit_types::unwrap_result_list(&results[0], FoldingRange::from_val);
        self.post_return_export(&func, "folding-ranges")?;
        outcome
    }
}
