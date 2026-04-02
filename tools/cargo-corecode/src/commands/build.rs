//! `cargo corecode build` — compile WASM and produce extension packages.

use crate::manifest;
use std::path::PathBuf;

pub fn run(target: &str, release: bool) -> anyhow::Result<()> {
    let m = manifest::load()?;

    let cargo_manifest: toml::Value = toml::from_str(
        &std::fs::read_to_string("Cargo.toml")
            .map_err(|_| anyhow::anyhow!("Cannot read Cargo.toml in current directory"))?,
    )?;
    let pkg_name = cargo_manifest["package"]["name"]
        .as_str()
        .unwrap_or("extension")
        .replace('-', "_");

    let wasm_path = compile_wasm(release, &pkg_name)?;

    match target {
        "corecode" => crate::packagers::corecode::pack(&m, &wasm_path)?,
        "zed" => crate::packagers::zed::pack(&m, &wasm_path)?,
        "vscode" => crate::packagers::vscode::pack(&m, &wasm_path)?,
        "all" => {
            crate::packagers::corecode::pack(&m, &wasm_path)?;
            crate::packagers::zed::pack(&m, &wasm_path)?;
            crate::packagers::vscode::pack(&m, &wasm_path)?;
        }
        _ => anyhow::bail!("Unknown target: {target}. Use corecode, zed, vscode, or all"),
    }
    Ok(())
}

fn compile_wasm(release: bool, pkg_name: &str) -> anyhow::Result<PathBuf> {
    let mut cmd = std::process::Command::new("cargo");
    cmd.args(["build", "--target", "wasm32-wasip2"]);
    if release {
        cmd.arg("--release");
    }

    let status = cmd.status()?;
    if !status.success() {
        anyhow::bail!("cargo build --target wasm32-wasip2 failed");
    }

    let profile = if release { "release" } else { "debug" };
    let path = PathBuf::from(format!(
        "target/wasm32-wasip2/{profile}/{pkg_name}.wasm"
    ));

    anyhow::ensure!(
        path.exists(),
        "Expected WASM binary at {} but it was not found",
        path.display()
    );

    Ok(path)
}
