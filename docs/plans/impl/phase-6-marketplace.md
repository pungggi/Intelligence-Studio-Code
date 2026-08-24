# Phase 6 — Marketplace and Discovery

> **Status**: Mostly complete (2026-08-24)
> **Depends on**: Phase 5 (toolchain `publish`)
> **Deliverables**: registry server · `.ccext` install · Native badge · signature verification (pending)

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
  digest**, then unpacks via `install_from_vsix` (`.ccext` archives carry
  `corecode.toml` at the root; the manager validates it and routes the
  extension to the WASM host via `detect_kind`)

### 4. Native badge — `extension_mgr.rs` + `editor.js` + `style.css`

`InstalledExtension` now carries `kind` ("Native" | "Node.js"), recomputed
from disk on every `list_installed` (survives registry upgrades). The
extensions panel renders a badge with the host type and a tooltip.

## What remains

| Item | Detail |
|:-----|:-------|
| **ed25519 signature verification** | Roadmap deliverable. SHA-256 integrity is enforced end-to-end today; package *signatures* still need: `cargo corecode keygen`, signing at publish (`CORECODE_SIGNING_KEY`), signature column in the index, host-side verification against trusted keys. Protocol reserves `X-CoreCode-Signature` for this. |
| Public deployment | `marketplace.corecode.dev` DNS + TLS + a long-lived token; server runs anywhere cargo does. |
| Marketplace UI for native extensions | The extensions panel currently searches Open VSX only; add a "Native" tab querying `/api/v1/search`. |
| Unpublish / deprecate | Not in the protocol; decide policy (immutable registry vs admin unpublish). |

## Security notes

- Publish requires a bearer token; downloads are unauthenticated (public packages)
- Server never executes or parses package contents — bytes in, bytes out
- Path traversal is blocked at three layers (id validation, index-only lookups,
  router-normalised paths)
- Client refuses non-HTTPS registries outside loopback/LAN and verifies
  SHA-256 before touching the extensions dir
