//! ed25519 signing for `.ccext` packages (Phase 6 signature verification).
//!
//! Workflow:
//!
//! ```text
//! cargo corecode keygen                    # writes corecode-signing-key{,.pub}
//! CORECODE_SIGNING_KEY=./corecode-signing-key cargo corecode publish ...
//!   → sends X-CoreCode-Signature + X-CoreCode-Pubkey headers
//! ```
//!
//! The registry pins the first public key seen for an extension id
//! (trust-on-first-use); later publishes must be signed with the same key.
//! Clients verify the downloaded bytes against the pinned key before install.
//!
//! Wire format: base64 (standard alphabet, padded) of the raw 32-byte
//! seed/public key and 64-byte signature.

use anyhow::{Context, Result};
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// Generate a fresh signing keypair. Returns `(signing, verifying)`.
pub fn generate() -> (SigningKey, VerifyingKey) {
    let mut csprng = rand::rngs::OsRng;
    let signing = SigningKey::generate(&mut csprng);
    let verifying = signing.verifying_key();
    (signing, verifying)
}

/// base64-encode bytes (keys, signatures).
pub fn encode(bytes: &[u8]) -> String {
    b64().encode(bytes)
}

/// Decode a base64 string produced by [`encode`].
pub fn decode(s: &str) -> Result<Vec<u8>> {
    b64()
        .decode(s.trim())
        .with_context(|| "invalid base64 (expected standard-alphabet, padded)".to_string())
}

/// Load a signing key from a spec that is either a path to a file containing
/// the base64 seed, or the base64 seed itself.
pub fn load_signing_key(spec: &str) -> Result<SigningKey> {
    let seed_b64 = if std::path::Path::new(spec).exists() {
        std::fs::read_to_string(spec)
            .with_context(|| format!("cannot read signing key file {spec}"))?
    } else {
        spec.to_string()
    };
    let seed = decode(&seed_b64)?;
    let seed: [u8; 32] = seed
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("signing key must be 32 bytes (base64 of the ed25519 seed), got {} bytes", seed.len()))?;
    Ok(SigningKey::from_bytes(&seed))
}

/// Sign `bytes`, returning the base64 signature.
pub fn sign(key: &SigningKey, bytes: &[u8]) -> String {
    encode(&key.sign(bytes).to_bytes())
}

/// Verify a base64 signature over `bytes` against a base64 public key.
#[allow(dead_code)] // exercised by tests; kept for a future `verify` command
pub fn verify(pubkey_b64: &str, signature_b64: &str, bytes: &[u8]) -> Result<()> {
    let pubkey_bytes = decode(pubkey_b64)?;
    let pubkey_bytes: [u8; 32] = pubkey_bytes.as_slice().try_into().map_err(|_| {
        anyhow::anyhow!("public key must be 32 bytes, got {}", pubkey_bytes.len())
    })?;
    let verifying =
        VerifyingKey::from_bytes(&pubkey_bytes).context("invalid ed25519 public key")?;

    let sig_bytes = decode(signature_b64)?;
    let sig_bytes: [u8; 64] = sig_bytes.as_slice().try_into().map_err(|_| {
        anyhow::anyhow!("signature must be 64 bytes, got {}", sig_bytes.len())
    })?;
    let signature = Signature::from_bytes(&sig_bytes);

    verifying
        .verify(bytes, &signature)
        .map_err(|e| anyhow::anyhow!("signature verification failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_and_verify_roundtrip() {
        let (signing, verifying) = generate();
        let msg = b"package-bytes";
        let sig = sign(&signing, msg);
        assert!(verify(&encode(verifying.as_bytes()), &sig, msg).is_ok());
    }

    #[test]
    fn tampered_message_fails() {
        let (signing, verifying) = generate();
        let sig = sign(&signing, b"original");
        assert!(verify(&encode(verifying.as_bytes()), &sig, b"tampered").is_err());
    }

    #[test]
    fn wrong_key_fails() {
        let (signing, _) = generate();
        let (_, other) = generate();
        let sig = sign(&signing, b"msg");
        assert!(verify(&encode(other.as_bytes()), &sig, b"msg").is_err());
    }

    #[test]
    fn load_signing_key_accepts_literal_and_file() {
        let (signing, verifying) = generate();
        // literal base64
        let loaded = load_signing_key(&encode(signing.as_bytes())).unwrap();
        let msg = b"x";
        let sig = sign(&loaded, msg);
        assert!(verify(&encode(verifying.as_bytes()), &sig, msg).is_ok());
        // file containing base64
        let dir = std::env::temp_dir().join(format!("ccsig-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("key");
        std::fs::write(&path, encode(signing.as_bytes())).unwrap();
        let loaded2 = load_signing_key(path.to_str().unwrap()).unwrap();
        assert_eq!(loaded2.verifying_key().as_bytes(), verifying.as_bytes());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_bad_key_specs() {
        assert!(load_signing_key("!!!not-base64!!!").is_err());
        assert!(load_signing_key(&encode(b"too-short")).is_err());
    }
}
