//! CoreCode marketplace server — the registry `cargo corecode publish`
//! uploads to and the marketplace client downloads `.ccext` packages from.
//!
//! Configuration (environment variables):
//!
//! | Variable            | Default              | Meaning                                |
//! |---------------------|----------------------|----------------------------------------|
//! | `MARKETPLACE_DATA`  | `./marketplace-data` | Package + index storage directory      |
//! | `MARKETPLACE_TOKEN` | *(unset)*            | Bearer token for `/publish` (required) |
//! | `MARKETPLACE_BIND`  | `127.0.0.1:8987`     | Listen address                         |
//!
//! Run locally:
//!
//! ```text
//! MARKETPLACE_TOKEN=dev-token cargo run -p marketplace-server
//! cargo corecode publish --registry http://127.0.0.1:8987 --token dev-token
//! ```

mod api;
mod store;

use std::path::PathBuf;

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).ok().filter(|s| !s.is_empty()).unwrap_or_else(|| default.to_string())
}

fn main() {
    let data_dir = PathBuf::from(env_or("MARKETPLACE_DATA", "./marketplace-data"));
    let token = std::env::var("MARKETPLACE_TOKEN").ok().filter(|s| !s.is_empty());
    let bind = env_or("MARKETPLACE_BIND", "127.0.0.1:8987");

    if token.is_none() {
        eprintln!("warning: MARKETPLACE_TOKEN is not set — publish is disabled (downloads still work)");
    }

    let has_token = token.is_some();
    let app = api::router(data_dir.clone(), token);

    println!("CoreCode marketplace");
    println!("  data dir : {}", data_dir.display());
    println!("  publish  : {}", if has_token { "token required" } else { "disabled" });

    tokio::runtime::Runtime::new()
        .expect("start tokio runtime")
        .block_on(async {
            let listener = tokio::net::TcpListener::bind(&bind)
                .await
                .unwrap_or_else(|e| panic!("cannot bind {bind}: {e}"));
            println!("  listening on http://{bind}");
            axum::serve(listener, app).await.expect("server error");
        });
}
