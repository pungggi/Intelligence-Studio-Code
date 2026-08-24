//! HTTP API — the contract `cargo corecode publish` speaks, plus read
//! endpoints for the marketplace client.
//!
//! ```text
//! POST   /api/v1/publish                              (Bearer token)
//!        headers: X-CoreCode-Extension, X-CoreCode-Version
//!        body:    raw .ccext bytes                → 201 {version entry}
//! GET    /api/v1/extension/{id}                    → extension metadata
//! GET    /api/v1/extension/{id}/latest             → latest version entry
//! GET    /api/v1/extension/{id}/{version}/download → .ccext bytes
//! GET    /api/v1/search?q=&offset=&limit=          → id search
//! GET    /api/v1/health                             → {"status":"ok"}
//! ```

use crate::store::{PublishError, Store};
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

pub struct AppState {
    pub store: Store,
    /// Bearer token required for publish. `None` disables publish entirely.
    pub token: Option<String>,
}

pub fn router(data_dir: PathBuf, token: Option<String>) -> Router {
    let state = Arc::new(AppState {
        store: Store::open(&data_dir).expect("open marketplace store"),
        token,
    });
    Router::new()
        .route("/api/v1/publish", post(publish))
        .route("/api/v1/extension/:id", get(get_extension))
        .route("/api/v1/extension/:id/latest", get(get_latest))
        .route("/api/v1/extension/:id/:version/download", get(download))
        .route("/api/v1/search", get(search))
        .route("/api/v1/health", get(health))
        .layer(DefaultBodyLimit::max(crate::store::MAX_PACKAGE_SIZE))
        .with_state(state)
}

fn bearer_authorized(headers: &HeaderMap, expected: &Option<String>) -> bool {
    let Some(expected) = expected else { return false };
    let Some(value) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    match value.strip_prefix("Bearer ") {
        Some(token) => token.trim() == expected,
        None => false,
    }
}

async fn publish(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !bearer_authorized(&headers, &state.token) {
        return error_json(StatusCode::UNAUTHORIZED, "invalid or missing API token");
    }
    let id = headers
        .get("X-CoreCode-Extension")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let version = headers
        .get("X-CoreCode-Version")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();

    match state.store.publish(id, version, &body) {
        Ok(entry) => (StatusCode::CREATED, Json(json!(entry))).into_response(),
        Err(PublishError::Conflict) => {
            error_json(StatusCode::CONFLICT, &format!("version {version} of {id} is already published"))
        }
        Err(PublishError::Invalid(msg)) => error_json(StatusCode::BAD_REQUEST, &msg),
        Err(PublishError::Io(msg)) => error_json(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    }
}

async fn get_extension(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    match state.store.get(&id) {
        Some(entry) => (StatusCode::OK, Json(json!(entry))).into_response(),
        None => error_json(StatusCode::NOT_FOUND, &format!("extension {id} not found")),
    }
}

async fn get_latest(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    match state.store.latest(&id) {
        Some(entry) => (StatusCode::OK, Json(json!(entry))).into_response(),
        None => error_json(StatusCode::NOT_FOUND, &format!("extension {id} not found")),
    }
}

async fn download(
    State(state): State<Arc<AppState>>,
    Path((id, version)): Path<(String, String)>,
) -> Response {
    // Refuse to even look up malformed ids/versions (defence in depth —
    // the store only serves indexed entries anyway).
    if !Store::valid_id(&id) || !Store::valid_version(&version) {
        return error_json(StatusCode::BAD_REQUEST, "malformed extension id or version");
    }
    match state.store.package(&id, &version) {
        Some((bytes, sha256)) => {
            let mut response = (StatusCode::OK, bytes).into_response();
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                "application/octet-stream".parse().unwrap(),
            );
            if let Ok(value) = sha256.parse() {
                response.headers_mut().insert("x-corecode-sha256", value);
            }
            response
        }
        None => error_json(StatusCode::NOT_FOUND, &format!("extension {id} {version} not found")),
    }
}

async fn search(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let query = params.get("q").cloned().unwrap_or_default();
    let offset = params.get("offset").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
    let limit = params.get("limit").and_then(|v| v.parse::<usize>().ok()).unwrap_or(20).min(100);
    let extensions = state.store.search(&query, offset, limit);
    (StatusCode::OK, Json(json!({ "extensions": extensions }))).into_response()
}

async fn health() -> Response {
    (StatusCode::OK, Json(json!({ "status": "ok" }))).into_response()
}

fn error_json(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn test_router(label: &str, token: Option<&str>) -> Router {
        let dir = std::env::temp_dir().join(format!("ccmp-api-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let router = router(dir.clone(), token.map(|s| s.to_string()));
        std::fs::remove_dir_all(&dir).ok();
        router
    }

    async fn body_string(response: Response) -> String {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        String::from_utf8_lossy(&bytes).to_string()
    }

    #[tokio::test]
    async fn publish_requires_token() {
        let app = test_router("auth", Some("secret"));
        let res = app
            .oneshot(
                Request::post("/api/v1/publish")
                    .header("X-CoreCode-Extension", "pub.a")
                    .header("X-CoreCode-Version", "1.0.0")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn publish_and_download_roundtrip() {
        let app = test_router("roundtrip", Some("secret"));
        let pkg: &[u8] = b"fake-ccext-bytes";

        let res = app
            .clone()
            .oneshot(
                Request::post("/api/v1/publish")
                    .header("Authorization", "Bearer secret")
                    .header("X-CoreCode-Extension", "corecode.hello-wasm")
                    .header("X-CoreCode-Version", "0.1.0")
                    .body(Body::from(pkg.to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);

        // Duplicate version → 409
        let res = app
            .clone()
            .oneshot(
                Request::post("/api/v1/publish")
                    .header("Authorization", "Bearer secret")
                    .header("X-CoreCode-Extension", "corecode.hello-wasm")
                    .header("X-CoreCode-Version", "0.1.0")
                    .body(Body::from(pkg.to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CONFLICT);

        // Metadata
        let res = app
            .clone()
            .oneshot(Request::get("/api/v1/extension/corecode.hello-wasm").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        // Latest
        let res = app
            .clone()
            .oneshot(Request::get("/api/v1/extension/corecode.hello-wasm/latest").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        // Download roundtrip with integrity header
        let res = app
            .oneshot(
                Request::get("/api/v1/extension/corecode.hello-wasm/0.1.0/download")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()["x-corecode-sha256"].to_str().unwrap().len(), 64);
        assert_eq!(body_string(res).await, "fake-ccext-bytes");
    }

    #[tokio::test]
    async fn rejects_malformed_download_paths() {
        let app = test_router("malformed", Some("secret"));
        // Note: the router normalises `/../` segments away — the store-level
        // id validation is the real guard; here we assert malformed ids that
        // survive routing still fail validation.
        for path in [
            "/api/v1/extension/no-dot/1.0.0/download",
            "/api/v1/extension/pub.a/latest/download",
            "/api/v1/extension/pub.a/1.2/download",
        ] {
            let res = app
                .clone()
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::BAD_REQUEST, "path: {path}");
        }
    }

    #[tokio::test]
    async fn search_filters_by_id() {
        let app = test_router("search", Some("secret"));
        for (id, v) in [("pub.alpha", "1.0.0"), ("pub.beta", "1.0.0")] {
            let res = app
                .clone()
                .oneshot(
                    Request::post("/api/v1/publish")
                        .header("Authorization", "Bearer secret")
                        .header("X-CoreCode-Extension", id)
                        .header("X-CoreCode-Version", v)
                        .body(Body::from(b"x".to_vec()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::CREATED);
        }
        let res = app
            .oneshot(Request::get("/api/v1/search?q=alpha").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = body_string(res).await;
        assert!(body.contains("pub.alpha"));
        assert!(!body.contains("pub.beta"));
    }

    #[tokio::test]
    async fn health_ok() {
        let app = test_router("health", None);
        let res = app.oneshot(Request::get("/api/v1/health").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }
}
