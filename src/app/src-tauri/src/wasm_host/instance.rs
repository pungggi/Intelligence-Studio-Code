//! Per-extension WASM component instance.
//!
//! Each `WasmInstance` holds a `wasmtime::Store` and the typed function handles
//! for the lifecycle exports. Linker setup links the host import implementations
//! from `api_impl.rs` into the WASM component's import namespace.

use super::api_impl::HostContext;
use super::manifest::CoreCodeManifest;
use std::path::Path;
use wasmtime::component::{Component, Linker};
use wasmtime::{Engine, Store};
use wasmtime_wasi::{ResourceTable, WasiCtx, WasiCtxBuilder, WasiView};

/// State stored inside each `wasmtime::Store`.
pub(super) struct InstanceState {
    wasi: WasiCtx,
    table: ResourceTable,
    pub host_ctx: HostContext,
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
    activate_fn: wasmtime::component::Func,
    deactivate_fn: wasmtime::component::Func,
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

        Ok(WasmInstance {
            id: manifest.extension.id.clone(),
            store,
            activate_fn,
            deactivate_fn,
        })
    }

    /// Call the extension's `lifecycle::activate` export.
    pub fn activate(&mut self) -> Result<(), String> {
        let mut results = vec![wasmtime::component::Val::Bool(false)];
        self.activate_fn
            .call(&mut self.store, &[], &mut results)
            .map_err(|e| format!("activate trap: {e}"))?;
        self.activate_fn
            .post_return(&mut self.store)
            .map_err(|e| format!("activate post-return: {e}"))?;

        // Unwrap the result<_, string> return value.
        // Val::Result carries Option<Box<Val>> for each arm.
        match results.into_iter().next() {
            Some(wasmtime::component::Val::Result(r)) => match r {
                Ok(_) => Ok(()),
                Err(Some(boxed)) => match *boxed {
                    wasmtime::component::Val::String(msg) => Err(msg.to_string()),
                    other => Err(format!("activate returned error: {other:?}")),
                },
                Err(None) => Err("activate returned error (no message)".to_string()),
            },
            other => Err(format!("activate: unexpected return value: {other:?}")),
        }
    }

    /// Call the extension's `lifecycle::deactivate` export.
    pub fn deactivate(&mut self) {
        if let Err(e) = self.deactivate_fn.call(&mut self.store, &[], &mut []) {
            log::warn!("[wasm-ext:{}] deactivate trap: {e}", self.id);
        }
        let _ = self.deactivate_fn.post_return(&mut self.store);
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
}
