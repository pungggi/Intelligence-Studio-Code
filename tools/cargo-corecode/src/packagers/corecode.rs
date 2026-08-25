//! CoreCode `.ccext` packager — a zip containing `corecode.toml`, the WASM binary,
//! and optional `webview/` assets.

use crate::manifest::CoreCodeManifest;
use std::io::Write;
use std::path::Path;

pub fn pack(manifest: &CoreCodeManifest, wasm_path: &Path) -> anyhow::Result<()> {
    let out_name = format!(
        "{}-{}.ccext",
        manifest.extension.id, manifest.extension.version
    );
    let out = std::fs::File::create(&out_name)?;
    let mut zip = zip::ZipWriter::new(out);
    let opts = zip::write::SimpleFileOptions::default();

    // corecode.toml
    zip.start_file("corecode.toml", opts)?;
    zip.write_all(&std::fs::read("corecode.toml")?)?;

    // extension.wasm
    zip.start_file("extension.wasm", opts)?;
    zip.write_all(&std::fs::read(wasm_path)?)?;

    // webview/ directory (if present)
    if Path::new("webview").is_dir() {
        for entry in walkdir::WalkDir::new("webview").min_depth(1) {
            let entry = entry?;
            if entry.file_type().is_file() {
                let rel = entry.path().to_string_lossy().replace('\\', "/");
                zip.start_file(&rel, opts)?;
                zip.write_all(&std::fs::read(entry.path())?)?;
            }
        }
    }

    zip.finish()?;
    println!("  CoreCode package: {out_name}");
    Ok(())
}
