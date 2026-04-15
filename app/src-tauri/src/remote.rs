// remote.rs — Tiny loopback HTTP server for external controllers (e.g. Stream Deck).
// Binds to 127.0.0.1 only and requires a shared-secret token header
// (X-Wavejack-Token). Each endpoint emits a Tauri event that the frontend
// listens for and acts on.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::post,
    Router,
};
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub const REMOTE_PORT: u16 = 7406;
const TOKEN_HEADER: &str = "x-wavejack-token";

#[derive(Clone)]
struct AppState {
    handle: AppHandle,
    token: Arc<String>,
}

#[derive(Serialize, Clone)]
struct RemoteAction {
    action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    delta: Option<i32>,
}

/// Spawn the remote-control HTTP server.
/// Silently logs and returns on bind failure — the rest of the app keeps working.
pub fn spawn(handle: AppHandle, token: String) {
    let state = AppState {
        handle,
        token: Arc::new(token),
    };

    let app = Router::new()
        .route("/discover/approve", post(discover_approve))
        .route("/discover/skip", post(discover_skip))
        .route("/discover/reject", post(discover_reject))
        .route("/player/volume/up", post(volume_up))
        .route("/player/volume/down", post(volume_down))
        .route("/player/play-pause", post(play_pause))
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], REMOTE_PORT));

    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("Remote: failed to bind {}: {}", addr, e);
                return;
            }
        };
        eprintln!("Remote control listening on http://{}", addr);
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("Remote: server error: {}", e);
        }
    });
}

fn check_token(state: &AppState, headers: &HeaderMap) -> Result<(), StatusCode> {
    let got = headers
        .get(TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if got == state.token.as_str() {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

fn emit(state: &AppState, event: &str, action: &'static str, delta: Option<i32>) {
    let _ = state
        .handle
        .emit(event, RemoteAction { action, delta });
}

async fn discover_approve(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<StatusCode, StatusCode> {
    check_token(&state, &headers)?;
    emit(&state, "discover:remote", "approve", None);
    Ok(StatusCode::NO_CONTENT)
}

async fn discover_skip(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<StatusCode, StatusCode> {
    check_token(&state, &headers)?;
    emit(&state, "discover:remote", "skip", None);
    Ok(StatusCode::NO_CONTENT)
}

async fn discover_reject(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<StatusCode, StatusCode> {
    check_token(&state, &headers)?;
    emit(&state, "discover:remote", "reject", None);
    Ok(StatusCode::NO_CONTENT)
}

async fn volume_up(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<StatusCode, StatusCode> {
    check_token(&state, &headers)?;
    emit(&state, "player:remote", "volume-up", Some(10));
    Ok(StatusCode::NO_CONTENT)
}

async fn volume_down(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<StatusCode, StatusCode> {
    check_token(&state, &headers)?;
    emit(&state, "player:remote", "volume-down", Some(10));
    Ok(StatusCode::NO_CONTENT)
}

async fn play_pause(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<StatusCode, StatusCode> {
    check_token(&state, &headers)?;
    emit(&state, "player:remote", "toggle", None);
    Ok(StatusCode::NO_CONTENT)
}
