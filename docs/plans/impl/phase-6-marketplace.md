# Phase 6 — Marketplace and Discovery

> **Status**: Complete (2026-08-25) — server, `.ccext` install, Native badge, and ed25519 signatures all landed
> **Depends on**: Phase 5 (toolchain `publish`)
> **Backlog**: public deployment, Native tab in the marketplace UI

## What exists

### 1. Registry server — `tools/marketplace-server/`

A standalone axum binary; the registry that `cargo corecode publish` uploads
to and the app downloads `.ccext` packages from.

```text
POST   /api/v1/publish                              (Bearer MARKETPLACE_TOKEN)
       X-CoreCode-Extension: publisher.name · X-CoreCode-Version: semver
       body: raw .ccext bytes                        → 201 {version entry}
GET    /api/v1/extension/{id}                        → all versions
GET    /api/v1/extension/{id}/latest                 → newest version entry
GET    /api/v1/extension/{id}/{version}/download     → .ccext (+ x-corecode-sha256)
GET    /api/v1/search?q=&offset=&limit=              → id search
GET    /api/v1/health                                → {"status":"ok"}
```

Storage is a plain directory — `index.json` (metadata, atomic tmp+rename
writes) plus immutable `packages/<id>/<version>.ccext` blobs. Integrity:
SHA-256 recorded at publish, returned on every download, verified by the
client before install. Versions are immutable (`409` on re-publish);
ids/versions are validated with the same rules as the CLI.

Config (env): `MARKETPLACE_DATA` (default `./marketplace-data`),
`MARKETPLACE_TOKEN` (publish disabled when unset), `MARKETPLACE_BIND`
(default `127.0.0.1:8987`).

Run + publish locally:

```text
MARKETPLACE_TOKEN=dev cargo run --manifest-path tools/marketplace-server/Cargo.toml
cargo corecode publish --registry http://127.0.0.1:8987 --token dev
```

Tests: 10 unit/integration (store roundtrip, conflict, validation, semver
ordering, reopen persistence; API auth/roundtrip/malformed paths/search).

### 2. Marketplace client (`.ccext`) — `src/app/src-tauri/src/marketplace.rs`

`MarketplaceClient::ccext_get(id)` and `ccext_download(id, version)`:
- Registry base from `CORECODE_REGISTRY` env (default `https://marketplace.corecode.dev`)
- HTTPS enforced; plain HTTP allowed only for loopback/LAN hosts (local dev servers)
- Download URLs are built from validated id/version segments — never from
  response-supplied URLs
- 50 MB cap, streaming size enforcement

### 3. Install path — `src/app/src-tauri/src/lib.rs`

- `marketplace_get_native(id)` — version listing for the install UI
- `install_native_extension(id, version?)` — resolves latest when version is
  omitted, downloads, **verifies SHA-256 against the registry-recorded
  digest** (from `ccext_get` metadata — never from response headers, which a
  hostile endpoint could forge; registry traffic also refuses redirects),
  then unpacks via `install_from_vsix` (`.ccext` archives carry
  `corecode.toml` at the root; the manager validates it and routes the
  extension to the WASM host via `detect_kind`) with aggregate extraction
  limits (500MB total, 20k entries) against zip bombs

### 4. Native badge — `extension_mgr.rs` + `editor.js` + `style.css`

`InstalledExtension` now carries `kind` ("Native" | "Node.js"), recomputed
from disk on every `list_installed` (survives registry upgrades). The
extensions panel renders a badge with the host type and a tooltip.

### 5. ed25519 signature verification (2026-08-25)

Authenticated publishing with trust-on-first-use key pinning:

```text
cargo corecode keygen [--out <dir>] [--force]
  → corecode-signing-key (base64 seed, SECRET) + corecode-signing-key.pub

cargo corecode publish [--signing-key <path|base64>]
  (or CORECODE_SIGNING_KEY; unsigned when unset)
  → X-CoreCode-Signature: <base64 64-byte sig over the .ccext bytes>
    X-CoreCode-Pubkey:    <base64 32-byte verifying key>
```

Server rules (`store.rs`):

- Signatures are verified over the body **before** anything is stored
- The first signed publish for an extension id **pins** its key
  (`ExtensionEntry.pinned_key`); later publishes must use the same key
- Unsigned publishes are rejected once a key is pinned (HTTP 403)
- `VersionEntry` records `signature` + `signed_by`; downloads expose them
  as `x-corecode-signature` / `x-corecode-signed-by` headers

Client (`marketplace.rs::verify_ccext_signature`): `install_native_extension`
verifies the downloaded bytes against the entry's signature and pinned key
**after** the SHA-256 integrity check. Unsigned (legacy/dev) entries still
install — SHA-256 integrity always applies; signatures are additive
authentication.

Trust model: the bearer token authenticates the *publisher connection*;
the pinned key authenticates the *package lineage*. TOFU means the first
publish of a new id trusts the presented key — acceptable while the token
gates who can publish at all. Key rotation would require registry-side
admin tooling (deliberately not built yet).

E2E verified: keygen → signed publish (201, signature recorded) →
re-publish with a different key → 403 → download headers carry signature
+ pinned key; tampered-bytes and wrong-key cases covered by unit tests in
all three crates (CLI 10, server 15, app 167 total).

## What remains (backlog — not part of the Phase 6 deliverables)

| Item | Detail |
|:-----|:-------|
| Public deployment | `marketplace.corecode.dev` DNS + TLS + a long-lived token; server runs anywhere cargo does. |
| Marketplace UI for native extensions | The extensions panel currently searches Open VSX only; add a "Native" tab querying `/api/v1/search`. |
| Key rotation / revocation | TOFU pinning has no admin override yet; needs registry-side tooling and a policy decision. |
| Unpublish / deprecate | Not in the protocol; decide policy (immutable registry vs admin unpublish). |

## Security notes

- Publish requires a bearer token; downloads are unauthenticated (public packages)
- Signed packages are verified against a per-extension pinned ed25519 key
  (server at publish time, client again at install time)
- Server never executes or parses package contents — bytes in, bytes out
- Path traversal is blocked at three layers (id validation, index-only lookups,
  router-normalised paths)
- Client refuses non-HTTPS registries outside loopback/LAN and verifies
  SHA-256 (+ signature when present) before touching the extensions dir
