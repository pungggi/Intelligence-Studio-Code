//! `cargo corecode keygen` — generate an ed25519 signing keypair for
//! authenticated `.ccext` publishing.
//!
//! Writes `corecode-signing-key` (base64 seed — **secret**) and
//! `corecode-signing-key.pub` (base64 verifying key) into the current
//! directory, or `--out <dir>`.

use crate::signing;
use anyhow::{Context, Result};
use std::io::Write;

pub fn run(out_dir: Option<&str>, force: bool) -> Result<()> {
    let dir = std::path::Path::new(out_dir.unwrap_or("."));
    std::fs::create_dir_all(dir).context("cannot create output directory")?;

    let secret_path = dir.join("corecode-signing-key");
    let public_path = dir.join("corecode-signing-key.pub");

    for path in [&secret_path, &public_path] {
        if path.exists() && !force {
            anyhow::bail!(
                "{} already exists — pass --force to overwrite (the old key will no longer verify)",
                path.display()
            );
        }
    }

    let (signing, verifying) = signing::generate();
    std::fs::write(&secret_path, signing::encode(&signing.to_bytes()))
        .context("cannot write signing key")?;
    let public_b64 = signing::encode(verifying.as_bytes());
    std::fs::write(&public_path, &public_b64).context("cannot write public key")?;

    // Best-effort permission tightening (POSIX; a no-op hint on Windows).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&secret_path, std::fs::Permissions::from_mode(0o600));
    }

    println!("Generated ed25519 signing keypair:");
    println!("  secret : {}  (keep this private)", secret_path.display());
    println!("  public : {}", public_path.display());
    println!();
    println!("Publish signed packages with:");
    println!("  CORECODE_SIGNING_KEY={} cargo corecode publish", secret_path.display());
    println!();
    println!("Public key (share freely — registries pin it per extension id):");
    let _ = std::io::stdout().flush();
    println!("  {public_b64}");
    Ok(())
}
