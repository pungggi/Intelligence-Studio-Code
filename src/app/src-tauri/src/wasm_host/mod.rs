//! WASM Extension Host.
//!
//! Runs WASM extensions (compiled to `wasm32-wasi` with the component model)
//! in-process alongside the existing Node.js extension host.
//!
//! # Public surface
//! - `WasmHostManager` — the single entry point stored in `AppState`.
//!
//! # Module layout
//! - `manager`  — shared engine, load/unload orchestration
//! - `instance` — per-extension Store + lifecycle calls
//! - `api_impl` — host import implementations (ui, workspace)
//! - `manifest` — corecode.toml parser and validator

pub mod api_impl;
pub mod instance;
pub mod manager;
pub mod manifest;

pub use manager::WasmHostManager;
