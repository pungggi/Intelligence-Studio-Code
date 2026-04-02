//! Zed `.zip` packager — generates `extension.toml` from `corecode.toml` and
//! bundles the WASM binary. Webview features are excluded (not supported by Zed).

use crate::manifest::CoreCodeManifest;
use std::io::Write;
use std::path::Path;

pub fn pack(manifest: &CoreCodeManifest, wasm_path: &Path) -> anyhow::Result<()> {
    let out_name = format!(
        "{}-{}-zed.zip",
        manifest.extension.id, manifest.extension.version
    );
    let out = std::fs::File::create(&out_name)?;
    let mut zip = zip::ZipWriter::new(out);
    let opts = zip::write::SimpleFileOptions::default();

    // Generate extension.toml (Zed manifest format)
    let ext_toml = generate_zed_manifest(manifest);
    zip.start_file("extension.toml", opts)?;
    zip.write_all(ext_toml.as_bytes())?;

    // WASM binary
    zip.start_file("extension.wasm", opts)?;
    zip.write_all(&std::fs::read(wasm_path)?)?;

    // Grammar query files extracted from WASM custom sections
    if let Some(grammar) = &manifest.grammar {
        if let Some(highlights) = extract_custom_section(
            wasm_path,
            &format!("queries/{}/highlights.scm", grammar.language_id),
        )? {
            let path = format!("languages/{}/highlights.scm", grammar.language_id);
            zip.start_file(&path, opts)?;
            zip.write_all(highlights.as_bytes())?;
        }

        if let Some(injections) = extract_custom_section(
            wasm_path,
            &format!("queries/{}/injections.scm", grammar.language_id),
        )? {
            let path = format!("languages/{}/injections.scm", grammar.language_id);
            zip.start_file(&path, opts)?;
            zip.write_all(injections.as_bytes())?;
        }
    }

    zip.finish()?;
    println!("  Zed package: {out_name}");
    if manifest.capabilities.webview_panels {
        println!("    webview-provider not supported in Zed — panel features excluded");
    }
    Ok(())
}

fn generate_zed_manifest(manifest: &CoreCodeManifest) -> String {
    let mut s = String::new();
    s.push_str("[extension]\n");
    s.push_str(&format!("id = {:?}\n", manifest.extension.id));
    s.push_str(&format!("name = {:?}\n", manifest.extension.name));
    s.push_str(&format!("version = {:?}\n", manifest.extension.version));
    s.push_str("schema_version = 1\n");

    if let Some(grammar) = &manifest.grammar {
        s.push_str(&format!("\n[grammars.{}]\n", grammar.language_id));
        s.push_str("repository = \"\"\n");
    }

    // Register language claims
    let lang_ids: Vec<&str> = manifest
        .languages
        .iter()
        .filter(|(_, &v)| v)
        .map(|(k, _)| k.as_str())
        .collect();
    if !lang_ids.is_empty() {
        for lang in &lang_ids {
            s.push_str(&format!("\n[language_servers.{}]\n", lang));
            s.push_str(&format!("language = {:?}\n", lang));
        }
    }

    s
}

/// Extract a named custom section from a WASM binary as a UTF-8 string.
fn extract_custom_section(wasm_path: &Path, section_name: &str) -> anyhow::Result<Option<String>> {
    use wasmparser::{Parser, Payload};
    let bytes = std::fs::read(wasm_path)?;
    for payload in Parser::new(0).parse_all(&bytes) {
        if let Payload::CustomSection(reader) = payload? {
            if reader.name() == section_name {
                return Ok(Some(std::str::from_utf8(reader.data())?.to_string()));
            }
        }
    }
    Ok(None)
}
