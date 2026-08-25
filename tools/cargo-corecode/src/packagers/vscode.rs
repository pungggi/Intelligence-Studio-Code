//! VS Code `.vsix` packager — generates `package.json`, bundles the WASM binary,
//! and includes the generated Node.js adapter (`dist/extension.js`).

use crate::manifest::CoreCodeManifest;
use std::io::Write;
use std::path::Path;

pub fn pack(manifest: &CoreCodeManifest, wasm_path: &Path) -> anyhow::Result<()> {
    let out_name = format!(
        "{}-{}.vsix",
        manifest.extension.id, manifest.extension.version
    );
    let out = std::fs::File::create(&out_name)?;
    let mut zip = zip::ZipWriter::new(out);
    let opts = zip::write::SimpleFileOptions::default();

    // extension/package.json
    let pkg_json = generate_vscode_package_json(manifest);
    zip.start_file("extension/package.json", opts)?;
    zip.write_all(pkg_json.as_bytes())?;

    // extension/dist/extension.js (the generated adapter)
    let adapter_js = crate::adapter::vscode_js::generate(manifest);
    zip.start_file("extension/dist/extension.js", opts)?;
    zip.write_all(adapter_js.as_bytes())?;

    // extension/dist/extension.wasm
    zip.start_file("extension/dist/extension.wasm", opts)?;
    zip.write_all(&std::fs::read(wasm_path)?)?;

    // extension/webview/ with VS Code bridge variant
    if Path::new("webview").is_dir() {
        for entry in walkdir::WalkDir::new("webview").min_depth(1) {
            let entry = entry?;
            if entry.file_type().is_file() {
                let name = entry.file_name().to_string_lossy();
                // Swap corecode-bridge.js for the VS Code variant
                if name == "corecode-bridge.js" {
                    continue;
                }
                let rel = entry.path().to_string_lossy().replace('\\', "/");
                let path = format!("extension/{}", rel);
                zip.start_file(&path, opts)?;
                zip.write_all(&std::fs::read(entry.path())?)?;
            }
        }
        // Inject the VS Code bridge
        zip.start_file("extension/webview/corecode-bridge.js", opts)?;
        zip.write_all(crate::adapter::bridge_vscode::BRIDGE.as_bytes())?;
    }

    zip.finish()?;
    println!("  VS Code package: {out_name}");
    Ok(())
}

fn generate_vscode_package_json(manifest: &CoreCodeManifest) -> String {
    let lang_ids: Vec<&str> = manifest
        .languages
        .iter()
        .filter(|(_, &v)| v)
        .map(|(k, _)| k.as_str())
        .collect();

    let activation_events: Vec<String> =
        lang_ids.iter().map(|l| format!("onLanguage:{l}")).collect();

    serde_json::to_string_pretty(&serde_json::json!({
        "name": manifest.extension.id.split('.').last().unwrap_or(&manifest.extension.id),
        "displayName": manifest.extension.name,
        "publisher": manifest.extension.id.split('.').next().unwrap_or("unknown"),
        "version": manifest.extension.version,
        "engines": { "vscode": "^1.75.0" },
        "categories": ["Other"],
        "activationEvents": activation_events,
        "contributes": {},
        "main": "./dist/extension.js",
        "extensionKind": ["workspace"]
    }))
    .unwrap_or_default()
}
