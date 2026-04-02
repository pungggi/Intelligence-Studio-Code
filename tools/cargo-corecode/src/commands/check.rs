//! `cargo corecode check` — validates the WASM binary's exports against each
//! target's supported API subset without producing a package.

use crate::manifest;
use std::path::PathBuf;

pub fn run(target: &str) -> anyhow::Result<()> {
    let m = manifest::load()?;
    let wasm_path = find_wasm_binary()?;
    let exports = inspect_wasm_exports(&wasm_path)?;

    let targets = targets_from_arg(target);
    anyhow::ensure!(!targets.is_empty(), "Unknown target: {target}. Use corecode, zed, vscode, or all");

    for t in &targets {
        let (supported, warnings) = check_compat(&exports, &m, t);
        let icon = if supported { "ok" } else { "INCOMPATIBLE" };
        println!("  {t}: {icon}");
        for w in &warnings {
            println!("    warning: {w}");
        }
    }
    Ok(())
}

/// Search target/wasm32-wasip2/ for the compiled .wasm binary.
fn find_wasm_binary() -> anyhow::Result<PathBuf> {
    let cargo_manifest: toml::Value =
        toml::from_str(&std::fs::read_to_string("Cargo.toml")?)?;
    let pkg_name = cargo_manifest["package"]["name"]
        .as_str()
        .unwrap_or("extension")
        .replace('-', "_");

    for profile in &["release", "debug"] {
        let path = PathBuf::from(format!(
            "target/wasm32-wasip2/{profile}/{pkg_name}.wasm"
        ));
        if path.exists() {
            return Ok(path);
        }
    }
    anyhow::bail!(
        "No WASM binary found. Run `cargo build --target wasm32-wasip2` first."
    )
}

/// Parse export names from a WASM binary using wasmparser.
///
/// Handles both core WASM modules (`ExportSection`) and WASM Component Model
/// binaries (`ComponentExportSection`). CoreCode extensions are components, so
/// both variants are checked — whichever yields exports is used.
fn inspect_wasm_exports(wasm_path: &std::path::Path) -> anyhow::Result<Vec<String>> {
    use wasmparser::{Parser, Payload};
    let bytes = std::fs::read(wasm_path)?;
    let mut exports = Vec::new();
    for payload in Parser::new(0).parse_all(&bytes) {
        match payload? {
            // Core WASM module exports
            Payload::ExportSection(reader) => {
                for export in reader {
                    exports.push(export?.name.to_string());
                }
            }
            // WASM Component Model exports — this is what wit-bindgen produces
            Payload::ComponentExportSection(reader) => {
                for export in reader {
                    exports.push(export?.name.0.to_string());
                }
            }
            _ => {}
        }
    }
    Ok(exports)
}

fn targets_from_arg(target: &str) -> Vec<&'static str> {
    match target {
        "all" => vec!["corecode", "zed", "vscode"],
        "corecode" => vec!["corecode"],
        "zed" => vec!["zed"],
        "vscode" => vec!["vscode"],
        _ => vec![],
    }
}

/// Check whether the WASM exports are compatible with the given target editor.
fn check_compat(
    exports: &[String],
    manifest: &manifest::CoreCodeManifest,
    target: &str,
) -> (bool, Vec<String>) {
    let mut warnings = Vec::new();

    let has_lifecycle = exports.iter().any(|e| e.contains("lifecycle"));
    if !has_lifecycle {
        warnings.push("Missing lifecycle exports (activate/deactivate)".to_string());
        return (false, warnings);
    }

    match target {
        "zed" => {
            let has_webview = exports.iter().any(|e| e.contains("webview-provider"));
            if has_webview || manifest.capabilities.webview_panels {
                warnings.push(
                    "webview-provider not supported in Zed (will be excluded)".to_string(),
                );
            }
            (true, warnings)
        }
        "vscode" => {
            // VS Code adapter supports all current interfaces
            (true, warnings)
        }
        "corecode" => {
            // CoreCode is the native host — all interfaces supported
            (true, warnings)
        }
        _ => {
            warnings.push(format!("Unknown target: {target}"));
            (false, warnings)
        }
    }
}
